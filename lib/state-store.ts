import type { PoolClient } from "pg";
import { pool } from "./db";
import { decryptState, encryptState, type EncryptedState } from "./crypto";
import type { TallySnapshot } from "./snapshot";

type StateRow = {
  revision: string | number;
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  key_version: number;
  last_operation_id: string;
  updated_at: Date;
};

export type CloudState = {
  cloudRevision: number;
  snapshot: TallySnapshot | null;
  updatedAt: string | null;
};

function revisionNumber(value: string | number): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error("Stored cloud revision is invalid.");
  }
  return revision;
}

function encryptedFromRow(row: StateRow): EncryptedState {
  return {
    ciphertext: row.ciphertext,
    nonce: row.nonce,
    authTag: row.auth_tag,
    keyVersion: row.key_version
  };
}

async function selectState(
  client: PoolClient,
  userId: string,
  forUpdate = false
): Promise<StateRow | null> {
  const result = await client.query<StateRow>(
    `SELECT revision, ciphertext, nonce, auth_tag, key_version, last_operation_id, updated_at
       FROM tally_state
      WHERE user_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [userId]
  );
  return result.rows[0] || null;
}

function stateFromRow(userId: string, row: StateRow | null): CloudState {
  if (!row) {
    return { cloudRevision: 0, snapshot: null, updatedAt: null };
  }
  return {
    cloudRevision: revisionNumber(row.revision),
    snapshot: decryptState<TallySnapshot>(userId, encryptedFromRow(row)),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function getCloudState(userId: string): Promise<CloudState> {
  const client = await pool.connect();
  try {
    return stateFromRow(userId, await selectState(client, userId));
  } finally {
    client.release();
  }
}

export type PutStateResult =
  | { status: "written"; cloudRevision: number; updatedAt: string }
  | { status: "conflict"; current: CloudState };

export async function putCloudState(
  userId: string,
  baseRevision: number,
  snapshot: TallySnapshot,
  operationId: string
): Promise<PutStateResult> {
  const encrypted = encryptState(userId, snapshot);
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const current = await selectState(client, userId, true);

    if (!current) {
      if (baseRevision !== 0) {
        await client.query("ROLLBACK");
        return {
          status: "conflict",
          current: { cloudRevision: 0, snapshot: null, updatedAt: null }
        };
      }
      const inserted = await client.query<{ revision: string; updated_at: Date }>(
        `INSERT INTO tally_state
           (user_id, revision, ciphertext, nonce, auth_tag, key_version, last_operation_id, updated_at)
         VALUES ($1, 1, $2, $3, $4, $5, $6, NOW())
         RETURNING revision, updated_at`,
        [
          userId,
          encrypted.ciphertext,
          encrypted.nonce,
          encrypted.authTag,
          encrypted.keyVersion,
          operationId
        ]
      );
      await client.query("COMMIT");
      return {
        status: "written",
        cloudRevision: revisionNumber(inserted.rows[0].revision),
        updatedAt: new Date(inserted.rows[0].updated_at).toISOString()
      };
    }

    const currentRevision = revisionNumber(current.revision);
    if (current.last_operation_id === operationId) {
      await client.query("ROLLBACK");
      return {
        status: "written",
        cloudRevision: currentRevision,
        updatedAt: new Date(current.updated_at).toISOString()
      };
    }
    if (currentRevision !== baseRevision) {
      await client.query("ROLLBACK");
      return { status: "conflict", current: stateFromRow(userId, current) };
    }

    await client.query(
      `INSERT INTO tally_state_history
         (user_id, revision, ciphertext, nonce, auth_tag, key_version, saved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id, revision) DO NOTHING`,
      [
        userId,
        currentRevision,
        current.ciphertext,
        current.nonce,
        current.auth_tag,
        current.key_version,
        current.updated_at
      ]
    );

    const updated = await client.query<{ revision: string; updated_at: Date }>(
      `UPDATE tally_state
          SET revision = revision + 1,
              ciphertext = $2,
              nonce = $3,
              auth_tag = $4,
              key_version = $5,
              last_operation_id = $6,
              updated_at = NOW()
        WHERE user_id = $1
        RETURNING revision, updated_at`,
      [
        userId,
        encrypted.ciphertext,
        encrypted.nonce,
        encrypted.authTag,
        encrypted.keyVersion,
        operationId
      ]
    );

    await client.query(
      `DELETE FROM tally_state_history
        WHERE user_id = $1
          AND id NOT IN (
            SELECT id
              FROM tally_state_history
             WHERE user_id = $1
             ORDER BY revision DESC
             LIMIT 10
          )`,
      [userId]
    );

    await client.query("COMMIT");
    return {
      status: "written",
      cloudRevision: revisionNumber(updated.rows[0].revision),
      updatedAt: new Date(updated.rows[0].updated_at).toISOString()
    };
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error.
    }

    // Two transactions can both observe an empty state. The primary key makes
    // the second insert lose safely; return the winner as a normal conflict.
    if ((error as { code?: string }).code === "23505") {
      return { status: "conflict", current: await getCloudState(userId) };
    }
    throw error;
  } finally {
    client.release();
  }
}

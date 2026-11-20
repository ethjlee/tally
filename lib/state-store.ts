import type { PoolClient } from "pg";
import { getPool } from "./db";
import { decryptState, encryptState, type EncryptedState } from "./crypto";
import { CURRENT_SNAPSHOT_VERSION, type TallySnapshot } from "./snapshot";

type StateRow = {
  revision: string | number;
  ciphertext: Buffer;
  nonce: Buffer;
  auth_tag: Buffer;
  key_version: number;
  last_operation_id: string;
  updated_at: Date;
};
type WriteReceipt = Pick<StateRow, "revision" | "updated_at">;

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
  const client = await getPool().connect();
  try {
    return stateFromRow(userId, await selectState(client, userId));
  } finally {
    client.release();
  }
}

export type PutStateResult =
  | { status: "written"; cloudRevision: number; updatedAt: string }
  | { status: "conflict"; current: CloudState };

function writtenResult(receipt: WriteReceipt): Extract<PutStateResult, { status: "written" }> {
  return {
    status: "written",
    cloudRevision: revisionNumber(receipt.revision),
    updatedAt: new Date(receipt.updated_at).toISOString()
  };
}

async function commitWrite(client: PoolClient, userId: string, operationId: string, receipt: WriteReceipt) {
  await client.query(
    `INSERT INTO tally_state_operations (user_id, operation_id, revision, updated_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, operationId, receipt.revision, receipt.updated_at]
  );
  await client.query("COMMIT");
  return writtenResult(receipt);
}

async function replaceState(
  client: PoolClient,
  userId: string,
  current: StateRow,
  writeValues: (string | number | Buffer)[]
): Promise<WriteReceipt> {
  await client.query(
    `INSERT INTO tally_state_history
       (user_id, revision, ciphertext, nonce, auth_tag, key_version, saved_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (user_id, revision) DO NOTHING`,
    [
      userId,
      current.revision,
      current.ciphertext,
      current.nonce,
      current.auth_tag,
      current.key_version,
      current.updated_at
    ]
  );

  const updated = await client.query<WriteReceipt>(
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
    writeValues
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
  return updated.rows[0];
}

export async function putCloudState(
  userId: string,
  baseRevision: number,
  snapshot: TallySnapshot,
  operationId: string
): Promise<PutStateResult> {
  const encrypted = encryptState(userId, snapshot);
  const writeValues = [
    userId, encrypted.ciphertext, encrypted.nonce,
    encrypted.authTag, encrypted.keyVersion, operationId
  ];
  const client = await getPool().connect();

  try {
    await client.query("BEGIN");
    let current = await selectState(client, userId, true);

    if (!current && baseRevision === 0) {
      const inserted = await client.query<WriteReceipt>(
        `INSERT INTO tally_state
           (user_id, revision, ciphertext, nonce, auth_tag, key_version, last_operation_id, updated_at)
         VALUES ($1, 1, $2, $3, $4, $5, $6, NOW())
         ON CONFLICT (user_id) DO NOTHING
         RETURNING revision, updated_at`,
        writeValues
      );
      if (inserted.rows[0]) return await commitWrite(client, userId, operationId, inserted.rows[0]);
      current = await selectState(client, userId, true);
    }
    if (!current) {
      await client.query("ROLLBACK");
      return { status: "conflict", current: stateFromRow(userId, null) };
    }

    const currentRevision = revisionNumber(current.revision);
    if (current.last_operation_id === operationId) {
      await client.query("ROLLBACK");
      return writtenResult(current);
    }
    // A retry can arrive after newer commits have rotated out its snapshot.
    const receipts = await client.query<WriteReceipt>(
      `SELECT revision, updated_at FROM tally_state_operations WHERE user_id = $1 AND operation_id = $2`,
      [userId, operationId]
    );
    if (receipts.rows[0]) {
      await client.query("ROLLBACK");
      return writtenResult(receipts.rows[0]);
    }
    if (currentRevision !== baseRevision) {
      await client.query("ROLLBACK");
      return { status: "conflict", current: stateFromRow(userId, current) };
    }
    if (snapshot.schemaVersion < CURRENT_SNAPSHOT_VERSION) {
      const cloud = stateFromRow(userId, current);
      if (cloud.snapshot && snapshot.schemaVersion < cloud.snapshot.schemaVersion) {
        await client.query("ROLLBACK");
        return { status: "conflict", current: cloud };
      }
    }

    const receipt = await replaceState(client, userId, current, writeValues);
    return await commitWrite(client, userId, operationId, receipt);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Preserve the original error.
    }

    throw error;
  } finally {
    client.release();
  }
}

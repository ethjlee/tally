import { timingSafeEqual } from "node:crypto";
import { stdin, stdout } from "node:process";
import { config } from "dotenv";
import { hashPassword } from "better-auth/crypto";

config({ path: ".env.local", override: false, quiet: true });

function hiddenPrompt(label: string): Promise<string> {
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
    throw new Error("Password recovery must run in an interactive terminal.");
  }
  stdout.write(label);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");

  return new Promise((resolve, reject) => {
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write("\n");
    };
    const onData = (chunk: string) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Recovery cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (value.length < 512) {
          value += character;
        }
      }
    };
    stdin.on("data", onData);
  });
}

function tokensMatch(candidate: string, expected: string): boolean {
  const left = Buffer.from(candidate, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

async function main() {
  const expectedToken = process.env.TALLY_SETUP_TOKEN?.trim();
  if (!expectedToken || Buffer.byteLength(expectedToken, "utf8") < 32) {
    throw new Error("TALLY_SETUP_TOKEN is missing or too short in .env.local.");
  }

  const token = await hiddenPrompt("Current TALLY_SETUP_TOKEN: ");
  if (!tokensMatch(token, expectedToken)) {
    throw new Error("Setup token did not match.");
  }

  const password = await hiddenPrompt("New owner password (14–128 characters): ");
  const confirmation = await hiddenPrompt("Confirm new owner password: ");
  if (password !== confirmation) throw new Error("Passwords did not match.");
  if (password.length < 14 || password.length > 128) {
    throw new Error("Password must contain 14–128 characters.");
  }

  const { pool } = await import("../lib/db");
  try {
    const users = await pool.query<{ id: string; username: string | null }>(
      `SELECT id, username FROM "user" ORDER BY "createdAt" LIMIT 2`
    );
    if (users.rowCount !== 1) {
      throw new Error("Recovery requires exactly one owner account.");
    }

    const passwordHash = await hashPassword(password);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const update = await client.query(
        `UPDATE "account"
            SET password = $1, "updatedAt" = NOW()
          WHERE "userId" = $2 AND "providerId" = 'credential'`,
        [passwordHash, users.rows[0].id]
      );
      if (update.rowCount !== 1) {
        throw new Error("The owner credential record was not found.");
      }
      await client.query(`DELETE FROM "session" WHERE "userId" = $1`, [
        users.rows[0].id
      ]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    console.log(`Password reset for ${users.rows[0].username || "the owner"}; all sessions were revoked.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Password recovery failed.");
  process.exitCode = 1;
});

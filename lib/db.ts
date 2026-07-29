import { Pool } from "pg";
import { requiredEnv } from "./env";

declare global {
  // eslint-disable-next-line no-var
  var __tallyPool: Pool | undefined;
}

export const pool =
  globalThis.__tallyPool ??
  new Pool({
    connectionString: requiredEnv("DATABASE_URL"),
    max: 4,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 20_000,
    allowExitOnIdle: process.env.NODE_ENV !== "production"
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__tallyPool = pool;
}

export async function ownerExists(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM "user" LIMIT 1) AS exists`
  );
  return result.rows[0]?.exists === true;
}

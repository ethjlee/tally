import { getMigrations } from "better-auth/db/migration";
import { config } from "dotenv";

config({ path: ".env.local", override: false, quiet: true });

const APP_MIGRATION = `
CREATE TABLE IF NOT EXISTS tally_state (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK (revision >= 1),
  ciphertext BYTEA NOT NULL,
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  key_version SMALLINT NOT NULL CHECK (key_version >= 1),
  last_operation_id TEXT NOT NULL CHECK (last_operation_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tally_state_history (
  id BIGSERIAL PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  revision BIGINT NOT NULL CHECK (revision >= 1),
  ciphertext BYTEA NOT NULL,
  nonce BYTEA NOT NULL CHECK (octet_length(nonce) = 12),
  auth_tag BYTEA NOT NULL CHECK (octet_length(auth_tag) = 16),
  key_version SMALLINT NOT NULL CHECK (key_version >= 1),
  saved_at TIMESTAMPTZ NOT NULL,
  UNIQUE (user_id, revision)
);

CREATE INDEX IF NOT EXISTS tally_state_history_user_revision_idx
  ON tally_state_history (user_id, revision DESC);

CREATE OR REPLACE FUNCTION tally_enforce_single_owner()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(1993617691);
  IF EXISTS (SELECT 1 FROM "user") THEN
    RAISE EXCEPTION 'Tally permits exactly one owner account'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tally_single_owner_guard ON "user";
CREATE TRIGGER tally_single_owner_guard
  BEFORE INSERT ON "user"
  FOR EACH ROW
  EXECUTE FUNCTION tally_enforce_single_owner();

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM PUBLIC;
`;

async function main() {
  const [{ auth }, { pool }] = await Promise.all([
    import("../lib/auth"),
    import("../lib/db")
  ]);
  try {
    const { runMigrations } = await getMigrations(auth.options);
    await runMigrations();
    await pool.query(APP_MIGRATION);
    console.log("Tally database migration completed.");
  } finally {
    await pool.end();
  }
}

main()
  .catch((error) => {
    console.error("Database migration failed:", error instanceof Error ? error.message : "unknown error");
    process.exitCode = 1;
  });

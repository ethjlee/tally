import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { parseSnapshot } from "../lib/snapshot";

test("cloud writes commit a receipt and replay it after the ledger advances", async (context) => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/tally_test";
  process.env.TALLY_DATA_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.TALLY_DATA_KEY_VERSION = "1";
  const { getPool } = await import("../lib/db");
  const { putCloudState } = await import("../lib/state-store");
  const uploaded = parseSnapshot({
    app: "Tally",
    schemaVersion: 8,
    revision: 3,
    writerId: "device",
    data: {
      taskSections: [], habits: [], bonusTasks: [], dailyBonuses: [],
      milestones: [], travelPauses: [], completedDays: [], entries: []
    },
    settings: {
      dailyBase: 100, successThreshold: 80, dayStartHour: 7, trackingStartDate: "2026-07-01",
      lastBackupAt: null, historyRangeDays: 14, backupReminderDays: 7,
      taskSortModes: { habit: "manual", bonus: "manual" }
    }
  });

  const owner = "test_owner";
  const operation = "accepted_upload";
  const acceptedAt = new Date("2026-07-02T12:00:00.000Z");
  const log: string[] = [];
  let head: { revision: number; updated_at: Date; last_operation_id: string } | undefined;
  const receipts = new Map<string, { revision: number; updated_at: Date }>();
  const client = {
    async query(sql: string, parameters: unknown[] = []) {
      if (sql.includes("INSERT INTO tally_state_operations")) {
        assert.equal(parameters[0], owner);
        assert.equal(parameters[1], operation);
        assert.equal(parameters[2], 1);
        assert.equal(parameters[3], acceptedAt);
        log.push("receipt");
        receipts.set(operation, { revision: 1, updated_at: acceptedAt });
      } else if (sql.includes("FROM tally_state_operations")) {
        assert.deepEqual(parameters, [owner, operation]);
        log.push("read receipt");
        return { rows: [receipts.get(operation)] };
      } else if (sql.includes("FROM tally_state")) {
        log.push("read head");
        return { rows: [head] };
      } else if (sql.includes("INSERT INTO tally_state")) {
        log.push("write head");
        head = { revision: 1, updated_at: acceptedAt, last_operation_id: operation };
        return { rows: [head] };
      } else {
        assert.ok(["BEGIN", "COMMIT", "ROLLBACK"].includes(sql), sql);
        log.push(sql);
      }
      return { rows: [] };
    },
    release() {}
  };
  context.mock.method(getPool(), "connect", async () => client as unknown as PoolClient);

  const expected = { status: "written", cloudRevision: 1, updatedAt: acceptedAt.toISOString() };
  assert.deepEqual(await putCloudState(owner, 0, uploaded, operation), expected);
  assert.deepEqual(log.splice(0), ["BEGIN", "read head", "write head", "receipt", "COMMIT"]);

  head = { revision: 15, updated_at: new Date("2026-07-03T12:00:00.000Z"), last_operation_id: "other_upload" };
  assert.deepEqual(await putCloudState(owner, 0, uploaded, operation), expected);
  assert.deepEqual(log, ["BEGIN", "read head", "read receipt", "ROLLBACK"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot, syncPutSchema } from "../lib/snapshot";

function validSnapshot() {
  return {
    app: "Tally" as const,
    schemaVersion: 3 as const,
    savedAt: "2026-07-29T12:00:00.000Z",
    revision: 4,
    writerId: "device_1",
    data: {
      habits: [
        {
          id: "habit_1",
          name: "Wear",
          type: "good" as const,
          points: 10,
          streak: 2,
          lastDate: "2026-07-29"
        }
      ],
      bonusTasks: [],
      milestones: [
        {
          id: "milestone_1",
          name: "One week",
          days: 7,
          points: 50,
          description: "Seven successful tracked days"
        }
      ],
      completedDays: [
        { id: "day_20260729", date: "2026-07-29", ts: 1_753_795_200_000 }
      ],
      entries: [
        {
          id: "entry_1",
          date: "2026-07-29",
          name: "Wear",
          type: "good" as const,
          points: 10,
          ts: 1_753_795_200_000,
          habitId: "habit_1"
        }
      ]
    },
    settings: {
      dailyBase: 100,
      successThreshold: 80,
      dayStartHour: 7,
      trackingStartDate: "2026-07-01",
      lastBackupAt: null,
      historyRangeDays: 30 as const,
      backupReminderDays: 14
    }
  };
}

test("server accepts the complete current ledger schema", () => {
  const parsed = parseSnapshot(validSnapshot());
  assert.equal(parsed.settings.backupReminderDays, 14);
  assert.equal(parsed.data.milestones.length, 1);
});

test("server rejects duplicate IDs and duplicate completed dates", () => {
  const duplicateEntry = validSnapshot();
  duplicateEntry.data.entries.push({ ...duplicateEntry.data.entries[0] });
  assert.throws(() => parseSnapshot(duplicateEntry));

  const duplicateDay = validSnapshot();
  duplicateDay.data.completedDays.push({
    id: "different_id",
    date: "2026-07-29",
    ts: 1_753_795_200_001
  });
  assert.throws(() => parseSnapshot(duplicateDay));
});

test("server rejects wrong point signs and unknown fields", () => {
  const wrongSign: any = validSnapshot();
  wrongSign.data.entries[0] = {
    ...wrongSign.data.entries[0],
    type: "bad",
    points: 10
  };
  assert.throws(() => parseSnapshot(wrongSign));

  const withUnknown = { ...validSnapshot(), unexpected: "do not persist this" };
  assert.throws(() => parseSnapshot(withUnknown));
});

test("server validates optimistic revision and operation ID", () => {
  const parsed = syncPutSchema.parse({
    baseRevision: 9,
    operationId: "op_device_123",
    snapshot: validSnapshot()
  });
  assert.equal(parsed.baseRevision, 9);

  assert.throws(() => syncPutSchema.parse({
    baseRevision: -1,
    operationId: "contains spaces",
    snapshot: validSnapshot()
  }));
});

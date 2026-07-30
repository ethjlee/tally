import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSnapshot, syncPutSchema } from "../lib/snapshot";

function validSnapshot() {
  return {
    app: "Tally" as const,
    schemaVersion: 6 as const,
    savedAt: "2026-07-29T12:00:00.000Z",
    revision: 4,
    writerId: "device_1",
    data: {
      taskSections: [
        {
          id: "section_1",
          name: "Daily wear",
          kind: "habit" as const,
          order: 0
        }
      ],
      habits: [
        {
          id: "habit_1",
          name: "Wear",
          type: "good" as const,
          points: 10,
          streak: 2,
          lastDate: "2026-07-29",
          order: 0,
          sectionId: "section_1"
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
      backupReminderDays: 14,
      taskSortModes: {
        habit: "usage-desc" as const,
        bonus: "name-asc" as const
      }
    }
  };
}

test("server accepts the complete current ledger schema", () => {
  const parsed = parseSnapshot(validSnapshot());
  assert.equal(parsed.schemaVersion, 6);
  if (parsed.schemaVersion !== 6) throw new Error("Expected current schema");
  assert.equal(parsed.settings.backupReminderDays, 14);
  assert.equal(parsed.settings.taskSortModes.habit, "usage-desc");
  assert.equal(parsed.data.habits[0].order, 0);
  assert.equal(parsed.data.habits[0].sectionId, "section_1");
  assert.equal(parsed.data.taskSections[0].kind, "habit");
  assert.equal(parsed.data.milestones.length, 1);
});

test("server accepts deployed version-5, version-4, and version-3 snapshots during rolling upgrade", () => {
  const legacyV5: any = structuredClone(validSnapshot());
  legacyV5.schemaVersion = 5;
  legacyV5.data.taskSections[0].kind = "good";
  legacyV5.settings.taskSortModes = {
    good: "manual",
    bad: "usage-desc",
    bonus: "name-asc"
  };
  assert.equal(parseSnapshot(legacyV5).schemaVersion, 5);

  const legacyV4: any = structuredClone(legacyV5);
  legacyV4.schemaVersion = 4;
  delete legacyV4.data.taskSections;
  legacyV4.data.habits.forEach((item: any) => delete item.sectionId);
  legacyV4.data.bonusTasks.forEach((item: any) => delete item.sectionId);
  assert.equal(parseSnapshot(legacyV4).schemaVersion, 4);

  const legacyV3: any = structuredClone(legacyV4);
  legacyV3.schemaVersion = 3;
  delete legacyV3.settings.taskSortModes;
  legacyV3.data.habits.forEach((item: any) => delete item.order);
  legacyV3.data.bonusTasks.forEach((item: any) => delete item.order);
  const parsed = parseSnapshot(legacyV3);
  assert.equal(parsed.schemaVersion, 3);

  const put = syncPutSchema.parse({
    baseRevision: 4,
    operationId: "legacy_device_write",
    snapshot: legacyV3
  });
  assert.equal(put.snapshot.schemaVersion, 3);
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

  const invalidSort: any = validSnapshot();
  invalidSort.settings.taskSortModes.habit = "random";
  assert.throws(() => parseSnapshot(invalidSort));

  const incompatibleSection: any = validSnapshot();
  incompatibleSection.data.taskSections[0].kind = "bonus";
  assert.throws(() => parseSnapshot(incompatibleSection));
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

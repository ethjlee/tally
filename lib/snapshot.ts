import { z } from "zod";
import { isValidDateKey, MAX_MANUAL_ORDER, SCHEMA_VERSION as CURRENT_SNAPSHOT_VERSION, SYNC_COLLECTION_LIMITS } from "../shared/ledger-contract";

export { CURRENT_SNAPSHOT_VERSION };

const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const name = z.string().trim().min(1).max(60);
const description = z.string().trim().max(160);
const dateKey = z.string().refine(isValidDateKey, "Invalid calendar date");
const timestamp = z.number().int().min(0).max(8_640_000_000_000_000);
const isoTimestamp = z.string().max(40).refine(
  (value) => Number.isFinite(new Date(value).getTime()),
  "Invalid timestamp"
);

const habitV4 = z.object({
  id,
  name,
  type: z.enum(["good", "bad"]),
  points: z.number().int().min(1).max(999),
  streak: z.number().int().min(0).max(100_000),
  lastDate: dateKey.nullable(),
  order: z.number().int().min(0).max(MAX_MANUAL_ORDER)
}).strict();
const habit = habitV4.extend({
  sectionId: id.nullable()
}).strict();

const bonusTaskV4 = z.object({
  id,
  name,
  points: z.number().int().min(1).max(999),
  order: z.number().int().min(0).max(MAX_MANUAL_ORDER)
}).strict();
const bonusTask = bonusTaskV4.extend({
  sectionId: id.nullable()
}).strict();

const taskSectionV5 = z.object({
  id,
  name: z.string().trim().min(1).max(40),
  kind: z.enum(["good", "bad", "bonus"]),
  order: z.number().int().min(0).max(MAX_MANUAL_ORDER)
}).strict();
const taskSection = taskSectionV5.extend({
  kind: z.enum(["habit", "bonus"])
}).strict();

const milestone = z.object({
  id,
  name,
  days: z.number().int().min(1).max(100_000),
  points: z.number().int().min(1).max(9_999),
  description
}).strict();
const dailyBonus = milestone.omit({ days: true });

const travelPause = z.object({ id, start: dateKey, end: dateKey.nullable() }).strict()
  .refine(pause => pause.end === null || pause.end >= pause.start, "Travel pause ends before it starts");

const completedDay = z.object({
  id,
  date: dateKey,
  ts: timestamp
}).strict();

const entry = z.object({
  id,
  date: dateKey,
  name,
  type: z.enum(["good", "bad", "bonus"]),
  points: z.number().int().min(-9_999).max(9_999),
  ts: timestamp,
  habitId: id.optional(),
  bonusId: id.optional()
}).strict().superRefine((value, context) => {
  if (value.type === "bad" && value.points > 0) {
    context.addIssue({ code: "custom", message: "Debit points must be zero or negative." });
  }
  if (value.type !== "bad" && value.points < 0) {
    context.addIssue({ code: "custom", message: "Credit and bonus points must be zero or positive." });
  }
});

function uniqueBy<T>(
  values: T[],
  selector: (value: T) => string,
  context: z.RefinementCtx,
  label: string
) {
  const seen = new Set<string>();
  for (const value of values) {
    const key = selector(value);
    if (seen.has(key)) {
      context.addIssue({ code: "custom", message: `${label} contains duplicates.` });
      return;
    }
    seen.add(key);
  }
}

const commonCollections = {
  milestones: z.array(milestone).max(SYNC_COLLECTION_LIMITS.milestones),
  completedDays: z.array(completedDay).max(SYNC_COLLECTION_LIMITS.completedDays),
  entries: z.array(entry).max(SYNC_COLLECTION_LIMITS.entries)
};
const dataShape = {
  taskSections: z.array(taskSection).max(SYNC_COLLECTION_LIMITS.taskSections),
  habits: z.array(habit).max(SYNC_COLLECTION_LIMITS.habits),
  bonusTasks: z.array(bonusTask).max(SYNC_COLLECTION_LIMITS.bonusTasks),
  ...commonCollections
};
const validateCollections = (sectionMode: "topic" | "legacy") => (
  value: {
    taskSections?: Array<{ id: string; kind: "habit" | "good" | "bad" | "bonus" }>;
    habits: Array<{ id: string; type?: "good" | "bad"; sectionId?: string | null }>;
    bonusTasks: Array<{ id: string; sectionId?: string | null }>;
    travelPauses?: Array<{ id: string }>;
    dailyBonuses?: Array<{ id: string }>;
    milestones: Array<{ id: string }>;
    completedDays: Array<{ id: string; date: string }>;
    entries: Array<{ id: string }>;
  },
  context: z.RefinementCtx
) => {
  uniqueBy(value.taskSections || [], (item) => item.id, context, "Task sections");
  uniqueBy(value.habits, (item) => item.id, context, "Habits");
  uniqueBy(value.bonusTasks, (item) => item.id, context, "Bonus entries");
  uniqueBy(value.travelPauses || [], (item) => item.id, context, "Travel pauses");
  uniqueBy(value.dailyBonuses || [], (item) => item.id, context, "Automatic daily bonuses");
  uniqueBy(value.milestones, (item) => item.id, context, "Milestones");
  uniqueBy(value.completedDays, (item) => item.id, context, "Completed days");
  uniqueBy(value.completedDays, (item) => item.date, context, "Completed-day dates");
  uniqueBy(value.entries, (item) => item.id, context, "Entries");
  const sections = new Map((value.taskSections || []).map(section => [section.id, section.kind]));
  value.habits.forEach((habit, index) => {
    const expectedKind = sectionMode === "topic" ? "habit" : habit.type;
    if (habit.sectionId && sections.get(habit.sectionId) !== expectedKind) {
      context.addIssue({ code: "custom", message: `Habit ${index + 1} references an incompatible task section.` });
    }
  });
  value.bonusTasks.forEach((bonus, index) => {
    if (bonus.sectionId && sections.get(bonus.sectionId) !== "bonus") {
      context.addIssue({ code: "custom", message: `Bonus entry ${index + 1} references an incompatible task section.` });
    }
  });
};
const data = z.object(dataShape).strict().superRefine(validateCollections("topic"));
const dataV7 = z.object({
  ...dataShape,
  dailyBonuses: z.array(dailyBonus).max(SYNC_COLLECTION_LIMITS.dailyBonuses)
}).strict().superRefine(validateCollections("topic"));

const settingsBase = z.object({
  dailyBase: z.number().int().min(0).max(9_999),
  successThreshold: z.number().int().min(0).max(9_999),
  dayStartHour: z.number().int().min(0).max(23),
  trackingStartDate: dateKey,
  lastBackupAt: isoTimestamp.nullable(),
  historyRangeDays: z.union([
    z.literal(7),
    z.literal(14),
    z.literal(30),
    z.literal(90),
    z.literal("all")
  ]),
  backupReminderDays: z.number().int().min(0).max(366)
}).strict();
const taskSortMode = z.enum([
  "manual",
  "name-asc",
  "name-desc",
  "usage-desc",
  "usage-asc",
  "points-desc",
  "points-asc"
]);
const settings = settingsBase.extend({
  taskSortModes: z.object({
    habit: taskSortMode,
    bonus: taskSortMode
  }).strict()
}).strict();
const settingsV5 = settingsBase.extend({
  taskSortModes: z.object({
    good: taskSortMode,
    bad: taskSortMode,
    bonus: taskSortMode
  }).strict()
}).strict();

const snapshotEnvelope = z.object({
  app: z.literal("Tally"),
  savedAt: isoTimestamp.optional(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  writerId: id.nullable().optional()
}).strict();
const snapshotV6Schema = snapshotEnvelope.extend({ schemaVersion: z.literal(6), data, settings });
const snapshotV7Schema = snapshotV6Schema.extend({
  schemaVersion: z.literal(7),
  data: dataV7
}).strict();

// Accept deployed snapshots so a new client can load them and write the current schema.
const legacyDataV5 = z.object({
  ...dataShape,
  taskSections: z.array(taskSectionV5).max(SYNC_COLLECTION_LIMITS.taskSections)
}).strict().superRefine(validateCollections("legacy"));
const snapshotV5Schema = snapshotEnvelope.extend({
  schemaVersion: z.literal(5),
  data: legacyDataV5,
  settings: settingsV5
});

const legacyDataV4 = z.object({
  habits: z.array(habitV4).max(SYNC_COLLECTION_LIMITS.habits),
  bonusTasks: z.array(bonusTaskV4).max(SYNC_COLLECTION_LIMITS.bonusTasks),
  ...commonCollections
}).strict().superRefine(validateCollections("legacy"));
const snapshotV4Schema = snapshotEnvelope.extend({
  schemaVersion: z.literal(4),
  data: legacyDataV4,
  settings: settingsV5
});

const legacyHabitV3 = habitV4.omit({ order: true });
const legacyBonusTaskV3 = bonusTaskV4.omit({ order: true });
const legacyDataV3 = z.object({
  habits: z.array(legacyHabitV3).max(SYNC_COLLECTION_LIMITS.habits),
  bonusTasks: z.array(legacyBonusTaskV3).max(SYNC_COLLECTION_LIMITS.bonusTasks),
  ...commonCollections
}).strict().superRefine(validateCollections("legacy"));
const legacySettingsV3 = settingsV5.omit({ taskSortModes: true });
const snapshotV3Schema = snapshotEnvelope.extend({
  schemaVersion: z.literal(3),
  data: legacyDataV3,
  settings: legacySettingsV3
});

const snapshotV8Schema = snapshotV7Schema.extend({
  schemaVersion: z.literal(CURRENT_SNAPSHOT_VERSION),
  data: z.object({ ...dataV7.shape, travelPauses: z.array(travelPause).max(SYNC_COLLECTION_LIMITS.travelPauses) })
    .strict().superRefine(validateCollections("topic"))
});

export const snapshotSchema = z.discriminatedUnion("schemaVersion", [
  snapshotV8Schema, snapshotV7Schema, snapshotV6Schema,
  snapshotV5Schema, snapshotV4Schema, snapshotV3Schema
]);

export const syncPutSchema = z.object({
  baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  operationId: id,
  snapshot: snapshotSchema
}).strict();

export type TallySnapshot = z.infer<typeof snapshotSchema>;

export function parseSnapshot(input: unknown): TallySnapshot {
  return snapshotSchema.parse(input);
}

import { z } from "zod";

const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/);
const name = z.string().trim().min(1).max(60);
const description = z.string().trim().max(160);
const dateKey = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setUTCHours(12, 0, 0, 0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}, "Invalid calendar date");
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
  order: z.number().int().min(0).max(1_000_000)
}).strict();
const habit = habitV4.extend({
  sectionId: id.nullable()
}).strict();

const bonusTaskV4 = z.object({
  id,
  name,
  points: z.number().int().min(1).max(999),
  order: z.number().int().min(0).max(1_000_000)
}).strict();
const bonusTask = bonusTaskV4.extend({
  sectionId: id.nullable()
}).strict();

const taskSection = z.object({
  id,
  name: z.string().trim().min(1).max(40),
  kind: z.enum(["good", "bad", "bonus"]),
  order: z.number().int().min(0).max(1_000_000)
}).strict();

const milestone = z.object({
  id,
  name,
  days: z.number().int().min(1).max(100_000),
  points: z.number().int().min(1).max(9_999),
  description
}).strict();

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

const dataShape = {
  taskSections: z.array(taskSection).max(1_000),
  habits: z.array(habit).max(1_000),
  bonusTasks: z.array(bonusTask).max(1_000),
  milestones: z.array(milestone).max(1_000),
  completedDays: z.array(completedDay).max(100_000),
  entries: z.array(entry).max(100_000)
};
const validateCollections = (
  value: {
    taskSections?: Array<{ id: string; kind: "good" | "bad" | "bonus" }>;
    habits: Array<{ id: string; type?: "good" | "bad"; sectionId?: string | null }>;
    bonusTasks: Array<{ id: string; sectionId?: string | null }>;
    milestones: Array<{ id: string }>;
    completedDays: Array<{ id: string; date: string }>;
    entries: Array<{ id: string }>;
  },
  context: z.RefinementCtx
) => {
  uniqueBy(value.taskSections || [], (item) => item.id, context, "Task sections");
  uniqueBy(value.habits, (item) => item.id, context, "Habits");
  uniqueBy(value.bonusTasks, (item) => item.id, context, "Bonus entries");
  uniqueBy(value.milestones, (item) => item.id, context, "Milestones");
  uniqueBy(value.completedDays, (item) => item.id, context, "Completed days");
  uniqueBy(value.completedDays, (item) => item.date, context, "Completed-day dates");
  uniqueBy(value.entries, (item) => item.id, context, "Entries");
  const sections = new Map((value.taskSections || []).map(section => [section.id, section.kind]));
  value.habits.forEach((habit, index) => {
    if (habit.sectionId && sections.get(habit.sectionId) !== habit.type) {
      context.addIssue({ code: "custom", message: `Habit ${index + 1} references an incompatible task section.` });
    }
  });
  value.bonusTasks.forEach((bonus, index) => {
    if (bonus.sectionId && sections.get(bonus.sectionId) !== "bonus") {
      context.addIssue({ code: "custom", message: `Bonus entry ${index + 1} references an incompatible task section.` });
    }
  });
};
const data = z.object(dataShape).strict().superRefine(validateCollections);

const settings = z.object({
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
  backupReminderDays: z.number().int().min(0).max(366),
  taskSortModes: z.object({
    good: z.enum(["manual", "name-asc", "name-desc", "usage-desc", "usage-asc", "points-desc", "points-asc"]),
    bad: z.enum(["manual", "name-asc", "name-desc", "usage-desc", "usage-asc", "points-desc", "points-asc"]),
    bonus: z.enum(["manual", "name-asc", "name-desc", "usage-desc", "usage-asc", "points-desc", "points-asc"])
  }).strict()
}).strict();

const snapshotV5Schema = z.object({
  app: z.literal("Tally"),
  schemaVersion: z.literal(5),
  savedAt: isoTimestamp.optional(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  writerId: id.nullable().optional(),
  data,
  settings
}).strict();

// Rolling deployment compatibility: accept both earlier encrypted cloud
// snapshots so a new client can load them and write schema 5 without downtime.
const legacyDataV4 = z.object({
  habits: z.array(habitV4).max(1_000),
  bonusTasks: z.array(bonusTaskV4).max(1_000),
  milestones: z.array(milestone).max(1_000),
  completedDays: z.array(completedDay).max(100_000),
  entries: z.array(entry).max(100_000)
}).strict().superRefine(validateCollections);
const snapshotV4Schema = z.object({
  app: z.literal("Tally"),
  schemaVersion: z.literal(4),
  savedAt: isoTimestamp.optional(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  writerId: id.nullable().optional(),
  data: legacyDataV4,
  settings
}).strict();

const legacyHabitV3 = habitV4.omit({ order: true });
const legacyBonusTaskV3 = bonusTaskV4.omit({ order: true });
const legacyDataV3 = z.object({
  habits: z.array(legacyHabitV3).max(1_000),
  bonusTasks: z.array(legacyBonusTaskV3).max(1_000),
  milestones: z.array(milestone).max(1_000),
  completedDays: z.array(completedDay).max(100_000),
  entries: z.array(entry).max(100_000)
}).strict().superRefine(validateCollections);
const legacySettingsV3 = settings.omit({ taskSortModes: true });
const snapshotV3Schema = z.object({
  app: z.literal("Tally"),
  schemaVersion: z.literal(3),
  savedAt: isoTimestamp.optional(),
  revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  writerId: id.nullable().optional(),
  data: legacyDataV3,
  settings: legacySettingsV3
}).strict();

export const snapshotSchema = z.union([snapshotV5Schema, snapshotV4Schema, snapshotV3Schema]);

export const syncPutSchema = z.object({
  baseRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  operationId: id,
  snapshot: snapshotSchema
}).strict();

export type TallySnapshot = z.infer<typeof snapshotSchema>;

export function parseSnapshot(input: unknown): TallySnapshot {
  return snapshotSchema.parse(input);
}

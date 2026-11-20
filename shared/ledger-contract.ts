export const SCHEMA_VERSION = 8;
export const MAX_MANUAL_ORDER = 1_000_000;

// Leave room for the response envelope within Vercel's 4.5 MB payload limit.
export const MAX_SYNC_BYTES = 4_499_000;

export const SYNC_COLLECTION_LIMITS = {
  taskSections: 1_000,
  habits: 1_000,
  bonusTasks: 1_000,
  dailyBonuses: 1_000,
  milestones: 1_000,
  travelPauses: 1_000,
  completedDays: 100_000,
  entries: 100_000
} as const;

export function isValidDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const test = new Date(0);
  test.setUTCHours(12, 0, 0, 0);
  test.setUTCFullYear(year, month - 1, day);
  return test.getUTCFullYear() === year && test.getUTCMonth() === month - 1 && test.getUTCDate() === day;
}

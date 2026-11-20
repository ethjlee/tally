import { MAX_MANUAL_ORDER, SCHEMA_VERSION, SYNC_COLLECTION_LIMITS, isValidDateKey } from "../../shared/ledger-contract.ts";
import { inferredStartDate } from "./days.js";
import { sectionIdValue } from "./tasks.js";
import { CLIENT_ID, DEFAULT_BACKUP_REMINDER_DAYS, ledgerState } from "../state.js";

export const SAFE_ID = /^[a-z0-9_-]{1,80}$/i;
function isPlainObject(value){
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function requireArray(value, label){
  if(!Array.isArray(value)) throw new Error(`${label} must be a list.`);
  return value;
}
function requireString(value, label, maxLength){
  if(typeof value !== 'string' || !value.trim() || value.length > maxLength){
    throw new Error(`${label} is invalid.`);
  }
  return value.trim();
}
function requireOptionalString(value, label, maxLength){
  if(value == null) return '';
  if(typeof value !== 'string' || value.length > maxLength) throw new Error(`${label} is invalid.`);
  return value.trim();
}
function requireId(value, label){
  if(typeof value !== 'string' || !SAFE_ID.test(value)) throw new Error(`${label} is invalid.`);
  return value;
}
function requireInteger(value, label, min, max){
  if(!Number.isInteger(value) || value < min || value > max) throw new Error(`${label} is out of range.`);
  return value;
}
// Accepts any string a hand-editor might reasonably write for a timestamp — including
// ISO strings that omit milliseconds or use a non-UTC offset — and normalizes the
// result to canonical ISO. Normalizing (rather than requiring an exact round-trip)
// keeps the "latest wins" string comparisons on lastBackupAt consistent regardless of
// the exact spelling that came in.
export function validIsoTimestamp(value){
  if(typeof value !== 'string' || !value.trim()) return null;
  const ms = new Date(value).getTime();
  if(!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}
function ensureUniqueIds(items, label){
  const seen = new Set();
  for(const item of items){
    if(seen.has(item.id)) throw new Error(`${label} contains duplicate IDs.`);
    seen.add(item.id);
  }
}
function ensureUniqueDates(items, label){
  const seen = new Set();
  for(const item of items){
    if(seen.has(item.date)) throw new Error(`${label} contains duplicate dates.`);
    seen.add(item.date);
  }
}
function migrateLegacyTaskSections(sections, habits){
  const legacyOrder = kind => sections.filter(section => section.kind === kind).slice().sort((a, b) =>
    (Number(a.order) || 0) - (Number(b.order) || 0) ||
    a.name.localeCompare(b.name, undefined, { sensitivity:'base' }) ||
    a.id.localeCompare(b.id)
  );
  const topics = [];
  const topicByName = new Map();
  const sectionIdMap = new Map();
  for(const section of [...legacyOrder('good'), ...legacyOrder('bad')]){
    const key = section.name.toLowerCase();
    let topic = topicByName.get(key);
    if(!topic){
      topic = { id:section.id, name:section.name, kind:'habit', order:topics.length };
      topicByName.set(key, topic);
      topics.push(topic);
    }
    sectionIdMap.set(section.id, topic.id);
  }
  for(const habit of habits){
    if(habit.sectionId) habit.sectionId = sectionIdMap.get(habit.sectionId) || null;
  }
  for(const sectionId of [null, ...topics.map(topic => topic.id)]){
    habits
      .filter(habit => sectionIdValue(habit.sectionId) === sectionId)
      .sort((a, b) =>
        (a.type === b.type ? 0 : a.type === 'good' ? -1 : 1) ||
        (Number(a.order) || 0) - (Number(b.order) || 0) ||
        a.name.localeCompare(b.name, undefined, { sensitivity:'base' }) ||
        a.id.localeCompare(b.id)
      )
      .forEach((habit, order) => { habit.order = order; });
  }
  const bonusSections = legacyOrder('bonus').map(section => ({ ...section, kind:'bonus' }));
  return { taskSections:[...topics, ...bonusSections], habits };
}

// Accepts the current versioned format and the original single-file backup
// format. It returns a clean copy and drops unknown fields.
export function validateBackupObject(parsed, forSync = true){
  if(!isPlainObject(parsed)) throw new Error('The backup must contain a JSON object.');

  let data;
  let settings;
  let revision = 0;
  const sourceSchemaVersion = Number.isInteger(parsed.schemaVersion) ? parsed.schemaVersion : 1;
  if([SCHEMA_VERSION,7,6,5,4,3,2].includes(parsed.schemaVersion) ||
      (parsed.schemaVersion === 1 && isPlainObject(parsed.data))){
    data = parsed.data;
    settings = parsed.settings;
    revision = Number.isSafeInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
  } else if(Array.isArray(parsed.habits) && Array.isArray(parsed.bonusTasks) && Array.isArray(parsed.entries)){
    data = parsed;
    settings = parsed;
  } else {
    throw new Error('This is not a recognized Tally backup.');
  }
  if(!isPlainObject(data) || !isPlainObject(settings)) throw new Error('The backup is missing ledger data or settings.');
  if(forSync) validateSyncCollections(data);

  const cleanPauses = requireArray(sourceSchemaVersion >= 8 ? data.travelPauses : [], 'Travel pauses').map(pause => {
    if(!isPlainObject(pause) || !isValidDateKey(pause.start) ||
       (pause.end !== null && (!isValidDateKey(pause.end) || pause.end < pause.start))){
      throw new Error('A travel pause has an invalid date range.');
    }
    return { id:requireId(pause.id, 'Travel pause ID'), start:pause.start, end:pause.end };
  });
  ensureUniqueIds(cleanPauses, 'Travel pauses');
  const usesLegacySections = sourceSchemaVersion < 6;
  let cleanTaskSections = requireArray(data.taskSections == null ? [] : data.taskSections, 'Task sections').map((section, i) => {
    if(!isPlainObject(section)) throw new Error(`Task section ${i + 1} is invalid.`);
    const validKinds = usesLegacySections ? ['good','bad','bonus'] : ['habit','bonus'];
    if(!validKinds.includes(section.kind)) throw new Error(`Task section ${i + 1} has an invalid type.`);
    return {
      id:requireId(section.id, `Task section ${i + 1} ID`),
      name:requireString(section.name, `Task section ${i + 1} name`, 40),
      kind:section.kind,
      order:requireInteger(section.order == null ? i : section.order, `Task section ${i + 1} order`, 0, MAX_MANUAL_ORDER)
    };
  });

  let cleanHabits = requireArray(data.habits, 'Habits').map((h, i) => {
    if(!isPlainObject(h)) throw new Error(`Habit ${i + 1} is invalid.`);
    const type = h.type;
    if(type !== 'good' && type !== 'bad') throw new Error(`Habit ${i + 1} has an invalid type.`);
    const lastDate = h.lastDate == null ? null : h.lastDate;
    if(lastDate !== null && !isValidDateKey(lastDate)) throw new Error(`Habit ${i + 1} has an invalid last date.`);
    return {
      id: requireId(h.id, `Habit ${i + 1} ID`),
      name: requireString(h.name, `Habit ${i + 1} name`, 60),
      type,
      points: requireInteger(h.points, `Habit ${i + 1} points`, 1, 999),
      streak: requireInteger(h.streak == null ? 0 : h.streak, `Habit ${i + 1} streak`, 0, 100000),
      lastDate,
      order: requireInteger(h.order == null ? i : h.order, `Habit ${i + 1} order`, 0, MAX_MANUAL_ORDER),
      sectionId: h.sectionId == null ? null : requireId(h.sectionId, `Habit ${i + 1} section ID`)
    };
  });

  const cleanBonuses = requireArray(data.bonusTasks, 'Bonus entries').map((b, i) => {
    if(!isPlainObject(b)) throw new Error(`Bonus entry ${i + 1} is invalid.`);
    return {
      id: requireId(b.id, `Bonus entry ${i + 1} ID`),
      name: requireString(b.name, `Bonus entry ${i + 1} name`, 60),
      points: requireInteger(b.points, `Bonus entry ${i + 1} points`, 1, 999),
      order: requireInteger(b.order == null ? i : b.order, `Bonus entry ${i + 1} order`, 0, MAX_MANUAL_ORDER),
      sectionId: b.sectionId == null ? null : requireId(b.sectionId, `Bonus entry ${i + 1} section ID`)
    };
  });

  const cleanDailyBonuses = requireArray(data.dailyBonuses == null ? [] : data.dailyBonuses, 'Automatic daily bonuses').map((bonus, i) => {
    if(!isPlainObject(bonus)) throw new Error(`Automatic daily bonus ${i + 1} is invalid.`);
    return {
      id:requireId(bonus.id, `Automatic daily bonus ${i + 1} ID`),
      name:requireString(bonus.name, `Automatic daily bonus ${i + 1} name`, 60),
      points:requireInteger(bonus.points, `Automatic daily bonus ${i + 1} points`, 1, 9999),
      description:requireOptionalString(bonus.description, `Automatic daily bonus ${i + 1} description`, 160)
    };
  });

  const cleanMilestones = requireArray(data.milestones == null ? [] : data.milestones, 'Milestones').map((m, i) => {
    if(!isPlainObject(m)) throw new Error(`Milestone ${i + 1} is invalid.`);
    return {
      id: requireId(m.id, `Milestone ${i + 1} ID`),
      name: requireString(m.name, `Milestone ${i + 1} name`, 60),
      days: requireInteger(m.days, `Milestone ${i + 1} successful day`, 1, 100000),
      points: requireInteger(m.points, `Milestone ${i + 1} points`, 1, 9999),
      description: requireOptionalString(m.description, `Milestone ${i + 1} description`, 160)
    };
  });

  const cleanCompletedDays = requireArray(data.completedDays == null ? [] : data.completedDays, 'Completed days').map((day, i) => {
    if(!isPlainObject(day)) throw new Error(`Completed day ${i + 1} is invalid.`);
    if(!isValidDateKey(day.date)) throw new Error(`Completed day ${i + 1} has an invalid date.`);
    return {
      id: requireId(day.id, `Completed day ${i + 1} ID`),
      date: day.date,
      ts: requireInteger(day.ts, `Completed day ${i + 1} timestamp`, 0, 8640000000000000)
    };
  });

  const cleanEntries = requireArray(data.entries, 'Logged entries').map((e, i) => {
    if(!isPlainObject(e)) throw new Error(`Logged entry ${i + 1} is invalid.`);
    if(!['good','bad','bonus'].includes(e.type)) throw new Error(`Logged entry ${i + 1} has an invalid type.`);
    if(!isValidDateKey(e.date)) throw new Error(`Logged entry ${i + 1} has an invalid date.`);
    const points = requireInteger(e.points, `Logged entry ${i + 1} points`, -9999, 9999);
    if(e.type === 'bad' && points > 0) throw new Error(`Logged entry ${i + 1} has the wrong point sign.`);
    if((e.type === 'good' || e.type === 'bonus') && points < 0) throw new Error(`Logged entry ${i + 1} has the wrong point sign.`);
    const clean = {
      id: requireId(e.id, `Logged entry ${i + 1} ID`),
      date: e.date,
      name: requireString(e.name, `Logged entry ${i + 1} name`, 60),
      type: e.type,
      points,
      ts: requireInteger(e.ts, `Logged entry ${i + 1} timestamp`, 0, 8640000000000000)
    };
    if(e.habitId != null) clean.habitId = requireId(e.habitId, `Logged entry ${i + 1} habit ID`);
    if(e.bonusId != null) clean.bonusId = requireId(e.bonusId, `Logged entry ${i + 1} bonus ID`);
    return clean;
  });

  ensureUniqueIds(cleanTaskSections, 'Task sections');
  ensureUniqueIds(cleanHabits, 'Habits');
  ensureUniqueIds(cleanBonuses, 'Bonus entries');
  ensureUniqueIds(cleanDailyBonuses, 'Automatic daily bonuses');
  ensureUniqueIds(cleanMilestones, 'Milestones');
  ensureUniqueIds(cleanCompletedDays, 'Completed days');
  ensureUniqueDates(cleanCompletedDays, 'Completed days');
  ensureUniqueIds(cleanEntries, 'Logged entries');
  let sectionsById = new Map(cleanTaskSections.map(section => [section.id, section]));
  cleanHabits.forEach((habit, index) => {
    const expectedKind = usesLegacySections ? habit.type : 'habit';
    if(habit.sectionId && sectionsById.get(habit.sectionId)?.kind !== expectedKind){
      throw new Error(`Habit ${index + 1} references a missing or incompatible section.`);
    }
  });
  cleanBonuses.forEach((bonus, index) => {
    if(bonus.sectionId && sectionsById.get(bonus.sectionId)?.kind !== 'bonus'){
      throw new Error(`Bonus entry ${index + 1} references a missing or incompatible section.`);
    }
  });
  if(usesLegacySections){
    const migrated = migrateLegacyTaskSections(cleanTaskSections, cleanHabits);
    cleanTaskSections = migrated.taskSections;
    cleanHabits = migrated.habits;
    sectionsById = new Map(cleanTaskSections.map(section => [section.id, section]));
  }

  const cleanDailyBase = requireInteger(settings.dailyBase == null ? 100 : settings.dailyBase, 'Daily base', 0, 9999);
  const cleanThreshold = requireInteger(settings.successThreshold == null ? 80 : settings.successThreshold, 'Success threshold', 0, 9999);
  const cleanDayStart = requireInteger(settings.dayStartHour == null ? 7 : settings.dayStartHour, 'Day start hour', 0, 23);
  const requestedStart = settings.trackingStartDate;
  const cleanStart = requestedStart == null
    ? inferredStartDate([...cleanEntries, ...cleanCompletedDays], cleanDayStart)
    : requestedStart;
  if(!isValidDateKey(cleanStart)) throw new Error('Statistics start date is invalid.');
  const backupDates = [validIsoTimestamp(settings.lastBackupAt), validIsoTimestamp(parsed.exportedAt)].filter(Boolean).sort();
  const validSortModes = new Set(['manual','name-asc','name-desc','usage-desc','usage-asc','points-desc','points-asc']);
  if(settings.taskSortModes != null && !isPlainObject(settings.taskSortModes)){
    throw new Error('Task sorting settings are invalid.');
  }
  const requestedSortModes = isPlainObject(settings.taskSortModes) ? settings.taskSortModes : {};
  const cleanSortModes = {};
  if(sourceSchemaVersion >= 6){
    for(const kind of ['habit','bonus']){
      if(requestedSortModes[kind] != null && !validSortModes.has(requestedSortModes[kind])){
        throw new Error(`The ${kind} task sorting setting is invalid.`);
      }
      cleanSortModes[kind] = validSortModes.has(requestedSortModes[kind]) ? requestedSortModes[kind] : 'manual';
    }
  }else{
    for(const kind of ['good','bad','bonus']){
      if(requestedSortModes[kind] != null && !validSortModes.has(requestedSortModes[kind])){
        throw new Error(`The ${kind} task sorting setting is invalid.`);
      }
    }
    const goodMode = validSortModes.has(requestedSortModes.good) ? requestedSortModes.good : 'manual';
    const badMode = validSortModes.has(requestedSortModes.bad) ? requestedSortModes.bad : 'manual';
    const hasCredits = cleanHabits.some(habit => habit.type === 'good');
    const hasDebits = cleanHabits.some(habit => habit.type === 'bad');
    cleanSortModes.habit = hasCredits && !hasDebits
      ? goodMode
      : (hasDebits && !hasCredits ? badMode : (goodMode === badMode ? goodMode : 'manual'));
    cleanSortModes.bonus = validSortModes.has(requestedSortModes.bonus) ? requestedSortModes.bonus : 'manual';
  }

  return {
    revision,
    writerId: parsed.writerId && SAFE_ID.test(parsed.writerId) ? parsed.writerId : null,
    taskSections: cleanTaskSections,
    habits: cleanHabits,
    bonusTasks: cleanBonuses,
    dailyBonuses: cleanDailyBonuses,
    milestones: cleanMilestones,
    travelPauses: cleanPauses,
    completedDays: cleanCompletedDays,
    entries: cleanEntries,
    dailyBase: cleanDailyBase,
    successThreshold: cleanThreshold,
    dayStartHour: cleanDayStart,
    trackingStartDate: cleanStart,
    lastBackupAt: backupDates.length ? backupDates[backupDates.length - 1] : null,
    historyRangeDays: [7,14,30,90,'all'].includes(settings.historyRangeDays) ? settings.historyRangeDays : 14,
    backupReminderDays: requireInteger(settings.backupReminderDays ?? DEFAULT_BACKUP_REMINDER_DAYS, 'Backup reminder cadence', 0, 366),
    taskSortModes: cleanSortModes
  };
}

export function validateSyncCollections(data){
  for(const [key, limit] of Object.entries(SYNC_COLLECTION_LIMITS)){
    if(Array.isArray(data[key]) && data[key].length > limit){
      const label = key.replace(/[A-Z]/g, c => ' ' + c.toLowerCase());
      const error = new Error(`A synced ledger can contain at most ${limit.toLocaleString()} ${label}.`);
      error.code = 'SYNC_COLLECTION_LIMIT';
      throw error;
    }
  }
}

export function buildSnapshot(){
  const snapshot = snapshotFromClean({ ...ledgerState, revision:ledgerState.stateRevision, writerId:CLIENT_ID });
  return { ...snapshot, savedAt:new Date().toISOString() };
}
export function buildExport(){
  const snapshot = buildSnapshot();
  snapshot.exportedAt = new Date().toISOString();
  return snapshot;
}
export function snapshotFromClean(clean){
  return {
    app:'Tally',
    schemaVersion:SCHEMA_VERSION,
    revision:clean.revision || 0,
    writerId:clean.writerId || null,
    data:{
      taskSections:clean.taskSections.map(item => ({ ...item })),
      habits:clean.habits.map(item => ({ ...item })),
      bonusTasks:clean.bonusTasks.map(item => ({ ...item })),
      dailyBonuses:clean.dailyBonuses.map(item => ({ ...item })),
      milestones:clean.milestones.map(item => ({ ...item })),
      travelPauses:clean.travelPauses.map(p => ({ ...p })),
      completedDays:clean.completedDays.map(item => ({ ...item })),
      entries:clean.entries.map(item => ({ ...item }))
    },
    settings:{
      dailyBase:clean.dailyBase,
      successThreshold:clean.successThreshold,
      dayStartHour:clean.dayStartHour,
      trackingStartDate:clean.trackingStartDate,
      lastBackupAt:clean.lastBackupAt,
      historyRangeDays:clean.historyRangeDays,
      backupReminderDays:clean.backupReminderDays,
      taskSortModes:{ ...clean.taskSortModes }
    }
  };
}

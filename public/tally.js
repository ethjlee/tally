/* ================= state ================= */
let habits = [];      // {id, name, type:'good'|'bad', points, streak, lastDate}
let bonusTasks = [];  // {id, name, points}
let entries = [];     // {id, date, name, type:'good'|'bad'|'bonus', points, ts}
let milestones = [];  // {id, name, days, points, description}
let completedDays = []; // {id, date, ts}; explicit no-entry day confirmations
let dailyBase = 100;  // score you start each day at, before credits/debits/bonuses
let successThreshold = 80; // score at/above this = a "success" day
let dayStartHour = 7; // the hour (0-23, local device time) the ledger day rolls over at
let trackingStartDate = todayKey(); // first calendar day included in every statistic
let historyRangeDays = 14; // 7, 14, 30, 90, or 'all'
let lastBackupAt = null; // ISO timestamp of the last completed restorable JSON or CSV backup
let backupReminderDays = 7; // days between backup nudges; 0 = reminders off. Device-local cadence.

let storageAvailable = true;
let editingHabitId = null;
let editingBonusId = null;
let editingMilestoneId = null;
let editingEntryId = null;
let entryModalMode = 'edit'; // 'edit' | 'create' — drives whether saving updates or inserts
let selectedDayKey = null;
let selectedHistoryDate = null;
let pendingCsvBackupText = null;
let habitTypeDraft = 'good';
let stateRevision = 0;
let storageMode = 'memory';
let tallyDb = null;
let activeView = 'today';
const CLIENT_ID = uid();
let durableRevision = 0;
let durableBaseSnapshot = null;
let cloudEnabled = false;
let cloudRevision = 0;
let cloudBaseSnapshot = null;
let cloudPendingWrite = null;
let cloudSyncInFlight = null;
let cloudSyncTimer = null;
let cloudUsername = '';
let cloudLastSyncedAt = null;
let cloudStatusMode = 'checking';
let cloudStatusMessage = 'Checking your private account…';
let startupBlocked = false;
let lastCloudRefreshAt = 0;
let appReady = false;

/* ================= helpers ================= */
// The "ledger day" starts at whatever hour is set in Settings ("Day starts at"),
// not midnight. Compare local calendar fields directly so the boundary stays at the
// chosen wall-clock hour even when daylight-saving time changes.
function formatLocalDate(d){
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function ledgerDateKeyForHour(hour, d = new Date()){
  const local = new Date(d);
  if(local.getHours() < hour) local.setDate(local.getDate() - 1);
  return formatLocalDate(local);
}
function todayKey(d = new Date()){
  return ledgerDateKeyForHour(dayStartHour, d);
}
function addDaysToKey(key, n){
  const [y,m,dn] = String(key).split('-').map(Number);
  const d = new Date(0);
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCFullYear(y, m - 1, dn);
  d.setUTCDate(d.getUTCDate() + n);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function dateKeyOrdinal(key){
  const [y,m,d] = String(key).split('-').map(Number);
  const utc = new Date(0);
  utc.setUTCHours(0, 0, 0, 0);
  utc.setUTCFullYear(y, m - 1, d);
  return Math.floor(utc.getTime() / 86400000);
}
function calendarDaysInclusive(start, end){
  if(start > end) return 0;
  return dateKeyOrdinal(end) - dateKeyOrdinal(start) + 1;
}
function laterDateKey(a, b){ return a > b ? a : b; }
function statsStartKey(){
  const today = todayKey();
  return isValidDateKey(trackingStartDate) && trackingStartDate <= today ? trackingStartDate : today;
}
function isInStatsWindow(date, end = todayKey()){
  return isValidDateKey(date) && date >= statsStartKey() && date <= end;
}
function inferredStartDate(candidateEntries, hour = dayStartHour){
  const end = ledgerDateKeyForHour(hour);
  const dates = candidateEntries.map(entry => entry.date).filter(date => isValidDateKey(date) && date <= end).sort();
  return dates[0] || end;
}
function uid(){ return Date.now().toString(36) + Math.random().toString(36).slice(2,7); }

function streakMultiplier(streak){
  return 1 + Math.min(0.05 * Math.max(streak - 1, 0), 1);
}

function activeStreakDisplay(habit){
  const today = todayKey();
  const yest = addDaysToKey(today, -1);
  if(habit.lastDate === today || habit.lastDate === yest) return habit.streak || 0;
  return 0;
}

// What tapping this habit RIGHT NOW would set the streak to — must mirror logHabit()'s logic exactly,
// so the pill's displayed points always match what actually gets awarded on tap.
function projectedStreak(habit){
  const today = todayKey();
  const yest = addDaysToKey(today, -1);
  if(habit.lastDate === today) return habit.streak || 1;
  if(habit.lastDate === yest) return (habit.streak || 0) + 1;
  return 1;
}

function completedDayId(date){
  return `day_${String(date).replace(/-/g, '')}`;
}
function explicitCompletionForDate(date){
  return completedDays.find(day => day.date === date) || null;
}
function dayHasManualActivity(date){
  return entries.some(entry => entry.date === date);
}
function isDayTracked(date){
  return dayHasManualActivity(date) || !!explicitCompletionForDate(date);
}
// Dates in `entries`/`completedDays` are already validated on load, so the window
// test is a plain string comparison here. Resolving statsStartKey() once per call
// (instead of once per item, inside isInStatsWindow) removes millions of Date
// allocations from the render path on multi-year ledgers.
function trackedDateKeys(end = todayKey()){
  const start = statsStartKey();
  const dates = new Set();
  for(const entry of entries){
    if(entry.date >= start && entry.date <= end) dates.add(entry.date);
  }
  for(const day of completedDays){
    if(day.date >= start && day.date <= end) dates.add(day.date);
  }
  return [...dates].sort();
}
function manualDailyTotalsByDate(end = todayKey()){
  const start = statsStartKey();
  const byDate = Object.create(null);
  for(const entry of entries){
    if(entry.date < start || entry.date > end) continue;
    byDate[entry.date] = (byDate[entry.date] || 0) + (Number(entry.points) || 0);
  }
  return byDate;
}
function milestoneAwardId(milestone, date){
  return `milestone_${milestone.id}_${String(date).replace(/-/g, '')}`;
}

// Milestone awards are derived instead of stored as mutable entries. That makes
// retroactive definition/threshold edits deterministic and prevents duplicate
// awards when two copies of Tally are open. Success is always decided from manual
// activity first; an automatic reward can never create the success that awards it.
//
// A milestone streak counts consecutive successful TRACKED days. Untracked calendar
// days are unknown and therefore pause the streak: they neither advance it nor reset
// it. Only a tracked day below the success threshold resets the streak.
function deriveMilestoneEntries(end = todayKey()){
  if(milestones.length === 0) return [];
  const manualTotals = manualDailyTotalsByDate(end);
  const trackedDates = trackedDateKeys(end);
  const orderedMilestones = milestones.slice().sort((a, b) =>
    a.days - b.days || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
  const awards = [];
  let successStreak = 0;
  for(const date of trackedDates){
    const scoreBeforeAwards = dailyBase + (manualTotals[date] || 0);
    if(scoreBeforeAwards < successThreshold){
      successStreak = 0;
      continue;
    }
    successStreak++;
    const earned = orderedMilestones.filter(milestone => milestone.days === successStreak);
    earned.forEach((milestone, index) => {
      const noon = new Date(`${date}T12:00:00`).getTime();
      awards.push({
        id:milestoneAwardId(milestone, date),
        date,
        name:milestone.name,
        type:'bonus',
        points:milestone.points,
        ts:Math.max(0, noon + index),
        milestoneId:milestone.id,
        description:milestone.description,
        derived:true
      });
    });
  }
  return awards;
}
function allActivityEntries(end = todayKey()){
  return [...entries, ...deriveMilestoneEntries(end)];
}

/* ================= persistence ================= */
const SCHEMA_VERSION = 3;
const DB_NAME = 'tally-ledger';
const DB_VERSION = 1;
const DB_STORE = 'records';
const STATE_KEY = 'state';
const FALLBACK_STATE_KEY = 'tally-state-v2';
const FALLBACK_PREVIOUS_KEY = 'tally-state-previous-v2';
const EMERGENCY_STATE_KEY = 'tally-emergency-v2';
const RECOVERY_STATE_KEY = 'tally-recovery-v2';
const CLOUD_BASE_KEY = 'cloud-base-v1';
const CLOUD_BASE_FALLBACK_KEY = 'tally-cloud-base-v1';
const TRUSTED_DEVICE_KEY = 'trusted-device-v1';
const TRUSTED_DEVICE_FALLBACK_KEY = 'tally-trusted-device-v1';
const SAFE_ID = /^[a-z0-9_-]{1,80}$/i;
let canUseLocalStorage = false;
let persistInFlight = null;
let persistDirty = false;
let syncChannel = null;
let stickyStorageWarning = false;
let reminderDismissedThisSession = false;

function isPlainObject(value){
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function isValidDateKey(value){
  if(typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y,m,d] = value.split('-').map(Number);
  const test = new Date(0);
  test.setUTCHours(12, 0, 0, 0);
  test.setUTCFullYear(y, m - 1, d);
  return test.getUTCFullYear() === y && test.getUTCMonth() === m - 1 && test.getUTCDate() === d;
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
function validIsoTimestamp(value){
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

// Accepts the current versioned format and the original single-file backup
// format. It returns a clean copy and drops unknown fields.
function validateBackupObject(parsed){
  if(!isPlainObject(parsed)) throw new Error('The backup must contain a JSON object.');

  let data;
  let settings;
  let revision = 0;
  if(parsed.schemaVersion === SCHEMA_VERSION || parsed.schemaVersion === 2){
    data = parsed.data;
    settings = parsed.settings;
    revision = Number.isInteger(parsed.revision) && parsed.revision >= 0 ? parsed.revision : 0;
  } else if(Array.isArray(parsed.habits) && Array.isArray(parsed.bonusTasks) && Array.isArray(parsed.entries)){
    data = parsed;
    settings = parsed;
  } else {
    throw new Error('This is not a recognized Tally backup.');
  }
  if(!isPlainObject(data) || !isPlainObject(settings)) throw new Error('The backup is missing ledger data or settings.');

  const cleanHabits = requireArray(data.habits, 'Habits').map((h, i) => {
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
      lastDate
    };
  });

  const cleanBonuses = requireArray(data.bonusTasks, 'Bonus entries').map((b, i) => {
    if(!isPlainObject(b)) throw new Error(`Bonus entry ${i + 1} is invalid.`);
    return {
      id: requireId(b.id, `Bonus entry ${i + 1} ID`),
      name: requireString(b.name, `Bonus entry ${i + 1} name`, 60),
      points: requireInteger(b.points, `Bonus entry ${i + 1} points`, 1, 999)
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

  ensureUniqueIds(cleanHabits, 'Habits');
  ensureUniqueIds(cleanBonuses, 'Bonus entries');
  ensureUniqueIds(cleanMilestones, 'Milestones');
  ensureUniqueIds(cleanCompletedDays, 'Completed days');
  ensureUniqueDates(cleanCompletedDays, 'Completed days');
  ensureUniqueIds(cleanEntries, 'Logged entries');

  const cleanDailyBase = requireInteger(settings.dailyBase == null ? 100 : settings.dailyBase, 'Daily base', 0, 9999);
  const cleanThreshold = requireInteger(settings.successThreshold == null ? 80 : settings.successThreshold, 'Success threshold', 0, 9999);
  const cleanDayStart = requireInteger(settings.dayStartHour == null ? 7 : settings.dayStartHour, 'Day start hour', 0, 23);
  const ledgerToday = ledgerDateKeyForHour(cleanDayStart);
  const requestedStart = settings.trackingStartDate;
  let cleanStart = requestedStart == null
    ? inferredStartDate([...cleanEntries, ...cleanCompletedDays], cleanDayStart)
    : requestedStart;
  if(!isValidDateKey(cleanStart)) throw new Error('Statistics start date is invalid.');
  // A device clock/time-zone move can make yesterday's valid start date appear
  // briefly "future" relative to the ledger boundary. Clamp instead of rejecting
  // the entire saved ledger.
  if(cleanStart > ledgerToday) cleanStart = ledgerToday;
  const backupDates = [validIsoTimestamp(settings.lastBackupAt), validIsoTimestamp(parsed.exportedAt)].filter(Boolean).sort();

  return {
    revision,
    writerId: parsed.writerId && SAFE_ID.test(parsed.writerId) ? parsed.writerId : null,
    habits: cleanHabits,
    bonusTasks: cleanBonuses,
    milestones: cleanMilestones,
    completedDays: cleanCompletedDays,
    entries: cleanEntries,
    dailyBase: cleanDailyBase,
    successThreshold: cleanThreshold,
    dayStartHour: cleanDayStart,
    trackingStartDate: cleanStart,
    lastBackupAt: backupDates.length ? backupDates[backupDates.length - 1] : null,
    historyRangeDays: [7,14,30,90,'all'].includes(settings.historyRangeDays) ? settings.historyRangeDays : 14,
    backupReminderDays: requireInteger(settings.backupReminderDays == null ? 7 : settings.backupReminderDays, 'Backup reminder cadence', 0, 366)
  };
}

function buildSnapshot(){
  return {
    app: 'Tally',
    schemaVersion: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    revision: stateRevision,
    writerId: CLIENT_ID,
    data: {
      habits: habits.map(h => ({ ...h })),
      bonusTasks: bonusTasks.map(b => ({ ...b })),
      milestones: milestones.map(m => ({ ...m })),
      completedDays: completedDays.map(day => ({ ...day })),
      entries: entries.map(e => ({ ...e }))
    },
    settings: { dailyBase, successThreshold, dayStartHour, trackingStartDate, lastBackupAt, historyRangeDays, backupReminderDays }
  };
}
function buildExport(){
  const snapshot = buildSnapshot();
  snapshot.exportedAt = new Date().toISOString();
  return snapshot;
}
function applyValidatedState(clean){
  habits = clean.habits;
  bonusTasks = clean.bonusTasks;
  milestones = clean.milestones;
  completedDays = clean.completedDays;
  entries = clean.entries;
  dailyBase = clean.dailyBase;
  successThreshold = clean.successThreshold;
  dayStartHour = clean.dayStartHour;
  trackingStartDate = clean.trackingStartDate;
  lastBackupAt = clean.lastBackupAt;
  historyRangeDays = clean.historyRangeDays;
  backupReminderDays = clean.backupReminderDays;
  stateRevision = clean.revision || 0;
  recomputeAllHabitStreaks();
}

function probeLocalStorage(){
  try{
    const key = `tally-probe-${uid()}`;
    window.localStorage.setItem(key, '1');
    const ok = window.localStorage.getItem(key) === '1';
    window.localStorage.removeItem(key);
    return ok;
  }catch(e){
    return false;
  }
}
function safeLocalGet(key){
  if(!canUseLocalStorage) return null;
  try{ return window.localStorage.getItem(key); }catch(e){ return null; }
}
function safeLocalSet(key, value){
  if(!canUseLocalStorage) return false;
  try{ window.localStorage.setItem(key, value); return true; }catch(e){ return false; }
}

function openDatabase(){
  return new Promise((resolve, reject) => {
    if(!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    let req;
    try{ req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch(e){ reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        if(tallyDb === db){
          tallyDb = null;
          storageMode = canUseLocalStorage ? 'localStorage' : 'memory';
          updateStorageStatus();
        }
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('Could not open the database'));
  });
}
function idbGet(key){
  return new Promise((resolve, reject) => {
    const tx = tallyDb.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
function idbPut(key, value){
  return new Promise((resolve, reject) => {
    const tx = tallyDb.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Database write was aborted'));
  });
}
function idbHealthCheck(){
  return new Promise((resolve, reject) => {
    if(!tallyDb) return reject(new Error('Database is not active'));
    let tx;
    try{
      try{
        tx = tallyDb.transaction(DB_STORE, 'readwrite', { durability:'strict' });
      }catch(e){
        tx = tallyDb.transaction(DB_STORE, 'readwrite');
      }
      const store = tx.objectStore(DB_STORE);
      const key = `health-${CLIENT_ID}`;
      const token = { id:uid(), checkedAt:new Date().toISOString() };
      store.put(token, key);
      const read = store.get(key);
      let matched = false;
      read.onsuccess = () => {
        matched = valuesEqual(read.result, token);
      };
      store.delete(key);
      tx.oncomplete = () => matched ? resolve(true) : reject(new Error('Database read-back did not match'));
      tx.onerror = () => reject(tx.error || new Error('Database health transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Database health transaction was aborted'));
    }catch(error){
      reject(error);
    }
  });
}
function idbWriteState(snapshot, expectedRevision = null){
  return new Promise((resolve, reject) => {
    let tx;
    try{
      tx = tallyDb.transaction(DB_STORE, 'readwrite', { durability:'strict' });
    }catch(e){
      tx = tallyDb.transaction(DB_STORE, 'readwrite');
    }
    const store = tx.objectStore(DB_STORE);
    const current = store.get(STATE_KEY);
    let outcome = { status:'written', latest:null };
    current.onsuccess = () => {
      const currentRevision = Number.isInteger(current.result && current.result.revision) ? current.result.revision : 0;
      if(expectedRevision !== null && current.result && currentRevision > expectedRevision){
        outcome = { status:'conflict', latest:current.result };
        return;
      }
      if(current.result){
        try{
          validateBackupObject(current.result);
          store.put(current.result, 'previous');
        }catch(e){}
      }
      store.put(snapshot, STATE_KEY);
    };
    current.onerror = () => reject(current.error || new Error('Could not read current database state'));
    tx.oncomplete = () => resolve(outcome);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Database write was aborted'));
  });
}
async function saveRecoverySnapshot(label, snapshot){
  let saved = false;
  try{
    if(tallyDb){
      await idbPut('recovery', { ...snapshot, recoveryLabel:label, recoveredAt:new Date().toISOString() });
      saved = true;
    }
  }catch(e){
    console.warn('Tally: recovery snapshot could not be saved', e);
  }
  if(safeLocalSet(RECOVERY_STATE_KEY, JSON.stringify(snapshot))) saved = true;
  return saved;
}

function cloneJson(value){
  return JSON.parse(JSON.stringify(value));
}
function valuesEqual(a, b){
  return JSON.stringify(a) === JSON.stringify(b);
}
function snapshotFromClean(clean){
  return {
    app:'Tally',
    schemaVersion:SCHEMA_VERSION,
    revision:clean.revision || 0,
    writerId:clean.writerId || null,
    data:{
      habits:clean.habits.map(item => ({ ...item })),
      bonusTasks:clean.bonusTasks.map(item => ({ ...item })),
      milestones:clean.milestones.map(item => ({ ...item })),
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
      backupReminderDays:clean.backupReminderDays
    }
  };
}
function mergeEntitiesById(baseItems, localItems, remoteItems){
  const base = new Map(baseItems.map(item => [item.id, item]));
  const local = new Map(localItems.map(item => [item.id, item]));
  const remote = new Map(remoteItems.map(item => [item.id, item]));
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  const merged = [];
  let hadDirectConflict = false;

  for(const id of ids){
    const b = base.get(id);
    const l = local.get(id);
    const r = remote.get(id);
    let chosen;
    if(valuesEqual(l, b)) chosen = r;
    else if(valuesEqual(r, b)) chosen = l;
    else if(valuesEqual(l, r)) chosen = l;
    else {
      hadDirectConflict = true;
      // If one copy deleted an item while the other edited it, preserve the edit.
      // If both edited the same item, keep the local edit; the complete remote
      // state remains in IndexedDB's rotating previous snapshot.
      chosen = l == null ? r : l;
    }
    if(chosen != null) merged.push({ ...chosen });
  }
  return { items:merged, hadDirectConflict };
}
function mergeConcurrentSnapshots(baseSnapshot, localSnapshot, remoteSnapshot){
  const base = baseSnapshot || remoteSnapshot;
  const habitsMerge = mergeEntitiesById(base.data.habits, localSnapshot.data.habits, remoteSnapshot.data.habits);
  const bonusMerge = mergeEntitiesById(base.data.bonusTasks, localSnapshot.data.bonusTasks, remoteSnapshot.data.bonusTasks);
  const milestoneMerge = mergeEntitiesById(base.data.milestones, localSnapshot.data.milestones, remoteSnapshot.data.milestones);
  const completedDayMerge = mergeEntitiesById(base.data.completedDays, localSnapshot.data.completedDays, remoteSnapshot.data.completedDays);
  const entryMerge = mergeEntitiesById(base.data.entries, localSnapshot.data.entries, remoteSnapshot.data.entries);
  const settings = {};
  let hadDirectConflict = habitsMerge.hadDirectConflict || bonusMerge.hadDirectConflict ||
    milestoneMerge.hadDirectConflict || completedDayMerge.hadDirectConflict || entryMerge.hadDirectConflict;
  for(const key of ['dailyBase','successThreshold','dayStartHour','trackingStartDate','lastBackupAt','historyRangeDays','backupReminderDays']){
    const b = base.settings[key];
    const l = localSnapshot.settings[key];
    const r = remoteSnapshot.settings[key];
    if(key === 'lastBackupAt'){
      const dates = [validIsoTimestamp(l), validIsoTimestamp(r)].filter(Boolean).sort();
      settings[key] = dates.length ? dates[dates.length - 1] : null;
      continue;
    }
    if(valuesEqual(l, b)) settings[key] = r;
    else if(valuesEqual(r, b) || valuesEqual(l, r)) settings[key] = l;
    else {
      settings[key] = l;
      hadDirectConflict = true;
    }
  }
  return {
    snapshot:{
      app:'Tally',
      schemaVersion:SCHEMA_VERSION,
      revision:Math.max(localSnapshot.revision || 0, remoteSnapshot.revision || 0),
      writerId:CLIENT_ID,
      data:{
        habits:habitsMerge.items,
        bonusTasks:bonusMerge.items,
        milestones:milestoneMerge.items,
        completedDays:completedDayMerge.items,
        entries:entryMerge.items
      },
      settings
    },
    hadDirectConflict
  };
}
function parseStoredSnapshot(raw){
  if(!raw) return null;
  try{
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const clean = validateBackupObject(parsed);
    return { raw:parsed, clean };
  }catch(e){
    return null;
  }
}
function writeEmergencyMirror(snapshot){
  if(!canUseLocalStorage) return false;
  const current = parseStoredSnapshot(safeLocalGet(EMERGENCY_STATE_KEY));
  if(current && current.clean.revision > snapshot.revision) return true;
  return safeLocalSet(EMERGENCY_STATE_KEY, JSON.stringify(snapshot));
}
function writeFallbackState(snapshot, expectedRevision){
  const current = parseStoredSnapshot(safeLocalGet(FALLBACK_STATE_KEY));
  if(current && current.clean.revision > expectedRevision){
    return { status:'conflict', latest:current.raw };
  }
  if(current && !valuesEqual(current.raw, snapshot)){
    safeLocalSet(FALLBACK_PREVIOUS_KEY, JSON.stringify(current.raw));
  }
  if(!safeLocalSet(FALLBACK_STATE_KEY, JSON.stringify(snapshot))){
    throw new Error('Local storage write failed');
  }
  writeEmergencyMirror(snapshot);
  return { status:'written', latest:null };
}
function mirrorDurableSnapshot(snapshot){
  if(!canUseLocalStorage) return;
  const current = parseStoredSnapshot(safeLocalGet(FALLBACK_STATE_KEY));
  if(current && current.clean.revision > snapshot.revision) return;
  if(current && !valuesEqual(current.raw, snapshot)){
    safeLocalSet(FALLBACK_PREVIOUS_KEY, JSON.stringify(current.raw));
  }
  safeLocalSet(FALLBACK_STATE_KEY, JSON.stringify(snapshot));
  writeEmergencyMirror(snapshot);
}
async function withPersistenceLock(callback){
  if(navigator.locks && navigator.locks.request){
    let callbackStarted = false;
    try{
      return await navigator.locks.request('tally-persistence-v2', { mode:'exclusive' }, async () => {
        callbackStarted = true;
        return callback();
      });
    }catch(error){
      if(callbackStarted) throw error;
    }
  }
  return callback();
}
async function writeDurableSnapshot(snapshot){
  if(tallyDb){
    try{
      return await idbWriteState(snapshot, durableRevision);
    }catch(error){
      console.warn('Tally: IndexedDB write failed; trying browser storage fallback', error);
      try{ tallyDb.close(); }catch(e){}
      tallyDb = null;
      storageMode = canUseLocalStorage ? 'localStorage' : 'memory';
    }
  }
  if(canUseLocalStorage) return writeFallbackState(snapshot, durableRevision);
  throw new Error('No durable browser storage is available');
}
async function mergeWriteConflict(latestRaw, localSnapshot){
  const remoteClean = validateBackupObject(latestRaw);
  const remoteSnapshot = snapshotFromClean(remoteClean);
  await saveRecoverySnapshot('concurrent-local-copy', localSnapshot);
  const merged = mergeConcurrentSnapshots(durableBaseSnapshot, localSnapshot, remoteSnapshot);
  const mergedClean = validateBackupObject(merged.snapshot);
  applyValidatedState(mergedClean);
  durableRevision = remoteClean.revision;
  durableBaseSnapshot = cloneJson(remoteSnapshot);
  stateRevision = Math.max(localSnapshot.revision || 0, remoteClean.revision) + 1;
  persistDirty = true;
  writeEmergencyMirror(buildSnapshot());
  renderAll();

  showStorageBanner(
    merged.hadDirectConflict
      ? 'Two open copies changed the same item. Tally kept your local edit, preserved the other state as a recovery copy, and merged everything else. Review recent activity and save a backup.'
      : 'Changes from another open copy were merged safely.',
    merged.hadDirectConflict
  );
}

function persistData(){ return schedulePersist(); }
function persistSettings(){ return schedulePersist(); }
function schedulePersist(){
  stateRevision++;
  persistDirty = true;
  writeEmergencyMirror(buildSnapshot());
  // Start on the next microtask so persistInFlight is assigned before either the
  // asynchronous database path or synchronous local-storage fallback can finish.
  if(!persistInFlight) persistInFlight = Promise.resolve().then(flushPersistLoop);
  return persistInFlight;
}
async function flushPersistLoop(){
  try{
    while(persistDirty){
      persistDirty = false;
      const snapshot = buildSnapshot();
      validateBackupObject(snapshot);
      const result = await withPersistenceLock(() => writeDurableSnapshot(snapshot));
      if(result.status === 'conflict'){
        await mergeWriteConflict(result.latest, snapshot);
        continue;
      }
      durableRevision = snapshot.revision;
      durableBaseSnapshot = cloneJson(snapshot);
      mirrorDurableSnapshot(snapshot);
      if(syncChannel) syncChannel.postMessage({ revision:snapshot.revision, writerId:CLIENT_ID });
      queueCloudSnapshot(snapshot);
      if(!stickyStorageWarning) hideSaveWarning();
    }
  }catch(e){
    console.error('Tally: save failed', e);
    showSaveWarning();
  }finally{
    persistInFlight = null;
    if(persistDirty) persistInFlight = Promise.resolve().then(flushPersistLoop);
    updateStorageStatus();
    renderCloudStatus();
  }
}
// The banner is dismissible, so its message lives in a child span rather than being
// written over the whole element (which would delete the Dismiss button).
function showStorageBanner(message, sticky){
  const el = document.getElementById('storageBanner');
  if(!el) return;
  if(sticky) stickyStorageWarning = true;
  el.querySelector('.banner-text').textContent = message;
  el.classList.add('show');
}
function dismissStorageBanner(){
  const el = document.getElementById('storageBanner');
  if(!el) return;
  stickyStorageWarning = false;
  el.classList.remove('show');
}
function showSaveWarning(){
  showStorageBanner("Couldn't save your last change. Keep the app open and save a backup from Data before closing it.");
}
function hideSaveWarning(){
  const el = document.getElementById('storageBanner');
  if(el.classList.contains('show')) el.classList.remove('show');
}

async function updateStorageStatus(){
  const el = document.getElementById('storageStatusEl');
  if(!el) return;
  let persisted = false;
  let usageText = '';
  try{
    if(navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted();
    if(navigator.storage && navigator.storage.estimate){
      const estimate = await navigator.storage.estimate();
      if(Number.isFinite(estimate.usage)) usageText = ` · ${Math.max(1, Math.round(estimate.usage / 1024))} KB used`;
    }
  }catch(e){}
  const modeLabel = storageMode === 'indexedDB' ? 'On-device database + recovery mirrors' : storageMode === 'localStorage' ? 'Browser storage fallback + rotating recovery' : 'Memory only';
  const persistenceLabel = persisted ? 'persistent storage granted' : 'best-effort storage';
  el.innerHTML = `<strong>${modeLabel}</strong><br>${persistenceLabel}${usageText}. Keep an external backup for protection from device loss or cleared browser data.`;
}
async function runStorageHealthCheck(){
  const button = document.getElementById('storageCheckBtn');
  const status = document.getElementById('storageHealthEl');
  if(button.disabled) return;
  button.disabled = true;
  status.className = 'manage-sub';
  status.textContent = 'Checking snapshot integrity and storage write/read paths…';

  let snapshotOk = false;
  let databaseOk = false;
  let mirrorOk = false;
  try{
    validateBackupObject(buildSnapshot());
    snapshotOk = true;
  }catch(e){}
  if(tallyDb){
    try{
      await idbHealthCheck();
      databaseOk = true;
    }catch(e){}
  }
  try{
    const key = `tally-health-probe-${uid()}`;
    const token = uid();
    window.localStorage.setItem(key, token);
    mirrorOk = window.localStorage.getItem(key) === token;
    window.localStorage.removeItem(key);
  }catch(e){
    mirrorOk = false;
  }

  const checked = new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  const primaryOk = tallyDb ? databaseOk : mirrorOk;
  if(snapshotOk && primaryOk && (!tallyDb || mirrorOk)){
    status.className = 'manage-sub success';
    status.textContent = `${tallyDb ? 'Database and recovery mirror' : 'Browser storage fallback'} verified · ${checked}`;
  }else if(snapshotOk && databaseOk){
    status.className = 'manage-sub error';
    status.textContent = `Database verified, but the recovery mirror is unavailable · ${checked}`;
  }else{
    status.className = 'manage-sub error';
    status.textContent = `Storage check failed. Keep the app open and save a complete backup now · ${checked}`;
  }
  button.disabled = false;
  updateStorageStatus();
}
async function requestPersistentStorage(){
  try{
    if(navigator.storage && navigator.storage.persisted && navigator.storage.persist){
      const already = await navigator.storage.persisted();
      if(!already) await navigator.storage.persist();
    }
  }catch(e){}
  updateStorageStatus();
}

function parseCandidate(raw, source, candidates, problems){
  if(!raw) return;
  try{
    const clean = validateBackupObject(typeof raw === 'string' ? JSON.parse(raw) : raw);
    candidates.push({ clean, source });
  }catch(e){
    problems.push(`${source}: ${e.message}`);
  }
}

async function loadAll(){
  const candidates = [];
  const problems = [];
  try{
    canUseLocalStorage = probeLocalStorage();
    try{
      tallyDb = await openDatabase();
      storageMode = 'indexedDB';
      storageAvailable = true;
    }catch(e){
      tallyDb = null;
      storageMode = canUseLocalStorage ? 'localStorage' : 'memory';
      storageAvailable = canUseLocalStorage;
    }

    if(!await verifyCloudAccess()) return;

    if(tallyDb){
      try{ parseCandidate(await idbGet(STATE_KEY), 'on-device database', candidates, problems); }
      catch(e){ problems.push(`on-device database: ${e.message}`); }
      try{ parseCandidate(await idbGet('previous'), 'previous database copy', candidates, problems); }
      catch(e){ problems.push(`previous database copy: ${e.message}`); }
      try{ parseCandidate(await idbGet('recovery'), 'database recovery copy', candidates, problems); }
      catch(e){ problems.push(`database recovery copy: ${e.message}`); }
    }
    parseCandidate(safeLocalGet(EMERGENCY_STATE_KEY), 'emergency copy', candidates, problems);
    parseCandidate(safeLocalGet(FALLBACK_STATE_KEY), 'browser storage copy', candidates, problems);
    parseCandidate(safeLocalGet(FALLBACK_PREVIOUS_KEY), 'previous browser storage copy', candidates, problems);
    parseCandidate(safeLocalGet(RECOVERY_STATE_KEY), 'browser recovery copy', candidates, problems);

    // One-time migration from the original two-key format.
    const legacyDataRaw = safeLocalGet('tally-data');
    if(legacyDataRaw){
      try{
        const legacyData = JSON.parse(legacyDataRaw);
        const legacySettingsRaw = safeLocalGet('tally-settings');
        const legacySettings = legacySettingsRaw ? JSON.parse(legacySettingsRaw) : legacyData;
        parseCandidate({
          habits: legacyData.habits || [],
          bonusTasks: legacyData.bonusTasks || [],
          entries: legacyData.entries || [],
          dailyBase: legacySettings.dailyBase,
          successThreshold: legacySettings.successThreshold,
          dayStartHour: legacySettings.dayStartHour,
          trackingStartDate: legacySettings.trackingStartDate,
          lastBackupAt: legacySettings.lastBackupAt,
          historyRangeDays: legacySettings.historyRangeDays
        }, 'legacy storage', candidates, problems);
      }catch(e){
        problems.push(`legacy storage: ${e.message}`);
      }
    }

    if(candidates.length){
      candidates.sort((a,b) => b.clean.revision - a.clean.revision);
      applyValidatedState(candidates[0].clean);
      const loadedSnapshot = buildSnapshot();
      if(tallyDb && candidates[0].source !== 'on-device database') await idbWriteState(loadedSnapshot);
      if(!tallyDb && canUseLocalStorage) writeFallbackState(loadedSnapshot, candidates[0].clean.revision);
      durableRevision = stateRevision;
      durableBaseSnapshot = cloneJson(loadedSnapshot);
      mirrorDurableSnapshot(loadedSnapshot);
    } else {
      durableRevision = stateRevision;
      durableBaseSnapshot = cloneJson(buildSnapshot());
    }

    if(problems.length && !candidates.length){
      showStorageBanner('Saved data could not be read. It was left untouched; restore a known-good backup from Data.', true);
    } else if(!storageAvailable){
      showStorageBanner("This browser is blocking durable storage. Save a backup before closing the app.", true);
    }

    setupCrossWindowSync();
    if(cloudEnabled) await initializeCloudSync();
    renderAll();
    requestPersistentStorage();
    appReady = true;
  }catch(e){
    console.error('Tally: startup failed', e);
    showStorageBanner('Tally could not finish loading saved data. Your existing storage was not overwritten.', true);
    renderAll();
  }finally{
    if(!startupBlocked) document.getElementById('loadingScreen').style.display = 'none';
    updateStorageStatus();
    renderCloudStatus();
  }
}

function setupCrossWindowSync(){
  if('BroadcastChannel' in window){
    try{
      syncChannel = new BroadcastChannel('tally-sync-v2');
      syncChannel.onmessage = async event => {
        if(event.data && event.data.type === 'prepare-clear-device'){
          closeDeviceDatabase();
          const loading = document.getElementById('loadingScreen');
          loading.textContent = 'Signing out on this device…';
          loading.style.display = 'flex';
          return;
        }
        if(event.data && event.data.type === 'clear-device'){
          closeDeviceDatabase();
          clearTallyLocalStorage();
          window.location.replace('/login');
          return;
        }
        if(event.data && event.data.type === 'cancel-clear-device'){
          window.location.reload();
          return;
        }
        if(!event.data || event.data.writerId === CLIENT_ID || event.data.revision <= durableRevision || persistInFlight || !tallyDb) return;
        try{
          const latest = await idbGet(STATE_KEY);
          const clean = validateBackupObject(latest);
          if(clean.revision > durableRevision){
            applyValidatedState(clean);
            durableRevision = clean.revision;
            durableBaseSnapshot = cloneJson(buildSnapshot());
            mirrorDurableSnapshot(durableBaseSnapshot);
            renderAll();
          }
        }catch(e){}
      };
    }catch(e){}
  }

  window.addEventListener('storage', event => {
    if(event.key !== FALLBACK_STATE_KEY || !event.newValue || tallyDb || persistInFlight) return;
    const latest = parseStoredSnapshot(event.newValue);
    if(!latest || latest.clean.revision <= durableRevision || latest.clean.writerId === CLIENT_ID) return;
    applyValidatedState(latest.clean);
    durableRevision = latest.clean.revision;
    durableBaseSnapshot = cloneJson(buildSnapshot());
    renderAll();
  });
}

/* ================= private cloud sync ================= */
function setCloudStatus(mode, message){
  cloudStatusMode = mode;
  cloudStatusMessage = message;
  renderCloudStatus();
}

function renderCloudStatus(){
  const el = document.getElementById('cloudStatusEl');
  const button = document.getElementById('cloudSyncBtn');
  if(!el) return;
  const labels = {
    checking:'Checking encrypted sync',
    syncing:'Syncing encrypted ledger',
    synced:'Encrypted cloud is up to date',
    offline:'Offline — device copy is available',
    error:'Cloud sync needs attention'
  };
  const title = labels[cloudStatusMode] || labels.error;
  const identity = cloudUsername ? ` · ${escapeHtml(cloudUsername)}` : '';
  el.innerHTML = `<strong>${title}${identity}</strong><br>${escapeHtml(cloudStatusMessage)}`;
  if(button) button.disabled = cloudStatusMode === 'syncing';
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try{
    return await fetch(url, { ...options, signal:controller.signal });
  }finally{
    clearTimeout(timer);
  }
}

async function trustedDeviceMarker(){
  try{
    if(tallyDb && await idbGet(TRUSTED_DEVICE_KEY)) return true;
  }catch(e){}
  return safeLocalGet(TRUSTED_DEVICE_FALLBACK_KEY) === '1';
}

async function markTrustedDevice(){
  try{
    if(tallyDb) await idbPut(TRUSTED_DEVICE_KEY, { trusted:true, markedAt:new Date().toISOString() });
  }catch(e){}
  safeLocalSet(TRUSTED_DEVICE_FALLBACK_KEY, '1');
}

async function verifyCloudAccess(){
  setCloudStatus('checking', 'Verifying your server-side session. No ledger data has loaded yet.');
  try{
    const response = await fetchWithTimeout('/api/account', {
      credentials:'same-origin',
      cache:'no-store',
      headers:{ 'Accept':'application/json' }
    });
    if(response.status === 401){
      startupBlocked = true;
      window.location.replace('/login');
      return false;
    }
    if(!response.ok) throw new Error('ACCOUNT_UNAVAILABLE');
    const account = await response.json();
    if(!account || account.authenticated !== true) throw new Error('ACCOUNT_INVALID');
    cloudUsername = String(account.username || '');
    cloudEnabled = true;
    await markTrustedDevice();
    return true;
  }catch(e){
    if(await trustedDeviceMarker()){
      cloudEnabled = false;
      setCloudStatus('offline', 'Signed-in device recognized. Changes stay on this device and will sync after reconnection.');
      return true;
    }
    startupBlocked = true;
    const loading = document.getElementById('loadingScreen');
    loading.textContent = 'Connect to the internet to sign in';
    return false;
  }
}

function snapshotContent(snapshot){
  return { data:snapshot.data, settings:snapshot.settings };
}

function snapshotContentEqual(a, b){
  return !!a && !!b && valuesEqual(snapshotContent(a), snapshotContent(b));
}

function cloudMergeBase(reference){
  return {
    app:'Tally',
    schemaVersion:SCHEMA_VERSION,
    revision:0,
    writerId:null,
    data:{ habits:[], bonusTasks:[], milestones:[], completedDays:[], entries:[] },
    settings:cloneJson(reference.settings)
  };
}

async function readCloudBaseRecord(){
  let raw = null;
  try{
    raw = tallyDb ? await idbGet(CLOUD_BASE_KEY) : safeLocalGet(CLOUD_BASE_FALLBACK_KEY);
    if(typeof raw === 'string') raw = JSON.parse(raw);
    if(!raw || !Number.isSafeInteger(raw.cloudRevision) || raw.cloudRevision < 0 || !raw.snapshot) return null;
    const clean = validateBackupObject(raw.snapshot);
    return { cloudRevision:raw.cloudRevision, snapshot:snapshotFromClean(clean) };
  }catch(e){
    return null;
  }
}

async function writeCloudBaseRecord(){
  if(!cloudBaseSnapshot) return;
  const record = { cloudRevision, snapshot:cloudBaseSnapshot, savedAt:new Date().toISOString() };
  try{
    if(tallyDb) await idbPut(CLOUD_BASE_KEY, record);
    else safeLocalSet(CLOUD_BASE_FALLBACK_KEY, JSON.stringify(record));
  }catch(e){}
}

async function fetchCloudState(){
  const response = await fetchWithTimeout('/api/sync', {
    credentials:'same-origin',
    cache:'no-store',
    headers:{ 'Accept':'application/json' }
  }, 15000);
  if(response.status === 401){
    cloudEnabled = false;
    window.location.replace('/login');
    throw new Error('UNAUTHORIZED');
  }
  const payload = await response.json().catch(() => ({}));
  if(!response.ok) throw new Error(payload.error || 'CLOUD_READ_FAILED');
  return payload;
}

async function applyCloudSnapshot(snapshot){
  const previousRevision = stateRevision;
  const clean = validateBackupObject(snapshot);
  applyValidatedState(clean);
  stateRevision = Math.max(previousRevision, clean.revision || 0);
  await schedulePersist();
  renderAll();
}

async function reconcileCloudState(remote){
  const localSnapshot = buildSnapshot();
  const remoteSnapshot = remote.snapshot
    ? snapshotFromClean(validateBackupObject(remote.snapshot))
    : null;
  const storedBase = await readCloudBaseRecord();
  const base = storedBase && storedBase.cloudRevision <= remote.cloudRevision
    ? storedBase.snapshot
    : cloudBaseSnapshot;

  cloudRevision = Number(remote.cloudRevision) || 0;
  cloudBaseSnapshot = remoteSnapshot ? cloneJson(remoteSnapshot) : null;
  cloudLastSyncedAt = remote.updatedAt || null;
  if(cloudBaseSnapshot) await writeCloudBaseRecord();

  if(!remoteSnapshot){
    queueCloudSnapshot(localSnapshot);
    return;
  }

  if(snapshotContentEqual(localSnapshot, remoteSnapshot)) return;

  if(base){
    const localChanged = !snapshotContentEqual(localSnapshot, base);
    const remoteChanged = !snapshotContentEqual(remoteSnapshot, base);
    if(!localChanged && remoteChanged){
      await applyCloudSnapshot(remoteSnapshot);
      return;
    }
    if(localChanged && !remoteChanged){
      queueCloudSnapshot(localSnapshot);
      return;
    }
    if(!localChanged && !remoteChanged) return;
  }else if(!hasAnyLedgerData()){
    await applyCloudSnapshot(remoteSnapshot);
    return;
  }

  await saveRecoverySnapshot('pre-cloud-merge', localSnapshot);
  const merged = mergeConcurrentSnapshots(
    base || cloudMergeBase(remoteSnapshot),
    localSnapshot,
    remoteSnapshot
  );
  const mergedClean = validateBackupObject(merged.snapshot);
  applyValidatedState(mergedClean);
  stateRevision = Math.max(localSnapshot.revision || 0, remoteSnapshot.revision || 0) + 1;
  await schedulePersist();
  renderAll();

  if(merged.hadDirectConflict){
    showStorageBanner('This device and the cloud changed the same item. Tally kept this device’s edit, saved a recovery copy, and merged everything else. Review recent activity and export a backup.', true);
  }
}

async function initializeCloudSync(){
  setCloudStatus('checking', 'Comparing this device with the encrypted cloud ledger…');
  try{
    const remote = await fetchCloudState();
    await reconcileCloudState(remote);
    queueCloudSnapshot(buildSnapshot());
    await flushCloudSync();
    lastCloudRefreshAt = Date.now();
  }catch(e){
    if(e.message !== 'UNAUTHORIZED'){
      cloudEnabled = false;
      setCloudStatus('offline', 'Cloud could not be reached. Your on-device copy remains available and unchanged.');
    }
  }
}

function queueCloudSnapshot(snapshot){
  if(!cloudEnabled) return;
  if(!cloudSyncInFlight && !cloudPendingWrite && cloudBaseSnapshot && snapshotContentEqual(snapshot, cloudBaseSnapshot)){
    const when = cloudLastSyncedAt
      ? new Date(cloudLastSyncedAt).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })
      : 'just now';
    setCloudStatus('synced', `Last confirmed ${when}. Postgres holds encrypted ciphertext; this device keeps the offline copy.`);
    return;
  }
  cloudPendingWrite = {
    snapshot:cloneJson(snapshot),
    operationId:`op_${uid()}_${uid()}`
  };
  clearTimeout(cloudSyncTimer);
  cloudSyncTimer = setTimeout(() => { flushCloudSync(); }, 600);
  setCloudStatus('syncing', 'A validated on-device save is waiting to upload.');
}

async function flushCloudSync(){
  if(cloudSyncInFlight) return cloudSyncInFlight;
  cloudSyncInFlight = runCloudSyncLoop().finally(() => {
    cloudSyncInFlight = null;
    renderCloudStatus();
  });
  return cloudSyncInFlight;
}

async function runCloudSyncLoop(){
  clearTimeout(cloudSyncTimer);
  while(cloudEnabled && cloudPendingWrite){
    if(!navigator.onLine){
      setCloudStatus('offline', 'Changes are saved on this device and queued for encrypted upload.');
      return;
    }
    const pending = cloudPendingWrite;
    cloudPendingWrite = null;
    if(cloudBaseSnapshot && snapshotContentEqual(pending.snapshot, cloudBaseSnapshot)) continue;
    setCloudStatus('syncing', 'Encrypting and saving the newest device state…');

    try{
      const response = await fetchWithTimeout('/api/sync', {
        method:'PUT',
        credentials:'same-origin',
        cache:'no-store',
        headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
        body:JSON.stringify({
          baseRevision:cloudRevision,
          operationId:pending.operationId,
          snapshot:pending.snapshot
        })
      }, 20000);
      const payload = await response.json().catch(() => ({}));
      if(response.status === 401){
        cloudEnabled = false;
        window.location.replace('/login');
        return;
      }
      if(response.status === 409){
        await reconcileCloudState(payload);
        continue;
      }
      if(!response.ok) throw new Error(payload.error || 'CLOUD_WRITE_FAILED');

      cloudRevision = payload.cloudRevision;
      cloudLastSyncedAt = payload.updatedAt;
      cloudBaseSnapshot = cloneJson(pending.snapshot);
      await writeCloudBaseRecord();
    }catch(e){
      if(!cloudPendingWrite) cloudPendingWrite = pending;
      setCloudStatus(
        navigator.onLine ? 'error' : 'offline',
        navigator.onLine
          ? 'Cloud save did not complete. The change remains safely queued on this device.'
          : 'Changes are saved on this device and will upload after reconnection.'
      );
      return;
    }
  }

  if(cloudEnabled && !cloudPendingWrite){
    const when = cloudLastSyncedAt
      ? new Date(cloudLastSyncedAt).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })
      : 'just now';
    setCloudStatus('synced', `Last confirmed ${when}. Postgres holds encrypted ciphertext; this device keeps the offline copy.`);
  }
}

async function syncCloudNow(){
  const button = document.getElementById('cloudSyncBtn');
  if(button) button.disabled = true;
  try{
    if(persistInFlight) await persistInFlight;
    if(!cloudEnabled && !await verifyCloudAccess()) return false;
    setCloudStatus('syncing', 'Checking for newer changes from your other devices…');
    await reconcileCloudState(await fetchCloudState());
    lastCloudRefreshAt = Date.now();
    queueCloudSnapshot(buildSnapshot());
    await flushCloudSync();
    if(cloudPendingWrite) return false;
    return cloudStatusMode === 'synced';
  }catch(e){
    setCloudStatus('error', 'Sync did not complete. Your on-device data was not removed or overwritten.');
    return false;
  }finally{
    if(button) button.disabled = false;
  }
}

function closeDeviceDatabase(){
  try{ if(tallyDb) tallyDb.close(); }catch(e){}
  tallyDb = null;
}

function clearTallyLocalStorage(){
  if(!canUseLocalStorage) return;
  [
    FALLBACK_STATE_KEY, FALLBACK_PREVIOUS_KEY, EMERGENCY_STATE_KEY,
    RECOVERY_STATE_KEY, CLOUD_BASE_FALLBACK_KEY, TRUSTED_DEVICE_FALLBACK_KEY,
    'tally-data', 'tally-settings'
  ].forEach(key => {
    try{ window.localStorage.removeItem(key); }catch(e){}
  });
}

function deleteDeviceDatabase(){
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if(!settled){
        settled = true;
        reject(new Error('DATABASE_DELETE_BLOCKED'));
      }
    }, 2500);
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => {
      if(settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    };
    request.onerror = () => {
      if(settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(request.error || new Error('DATABASE_DELETE_FAILED'));
    };
  });
}

async function signOutAndClearDevice(){
  const confirmed = await showConfirm(
    'Sync the latest ledger, sign out, and remove Tally’s on-device database from this browser? Your encrypted cloud copy and exported backups stay intact.',
    'Sign out'
  );
  if(!confirmed) return;
  if(!await syncCloudNow()){
    showStorageBanner('Sign-out cleanup stopped because cloud sync could not be confirmed. Your device copy is still intact.');
    return;
  }

  try{
    if(syncChannel) syncChannel.postMessage({ type:'prepare-clear-device', writerId:CLIENT_ID });
    const response = await fetch('/api/auth/sign-out', {
      method:'POST',
      credentials:'same-origin',
      headers:{ 'Content-Type':'application/json' },
      body:'{}'
    });
    if(!response.ok) throw new Error('SIGN_OUT_FAILED');

    closeDeviceDatabase();
    await deleteDeviceDatabase();
    clearTallyLocalStorage();
    if('caches' in window){
      const names = await caches.keys();
      await Promise.all(names.filter(name => name.startsWith('tally-')).map(name => caches.delete(name)));
    }
    if(syncChannel) syncChannel.postMessage({ type:'clear-device', writerId:CLIENT_ID });
    window.location.replace('/login');
  }catch(e){
    if(syncChannel) syncChannel.postMessage({ type:'cancel-clear-device', writerId:CLIENT_ID });
    showStorageBanner('Tally signed out, but the browser could not confirm removal of every local cache. Close other Tally tabs, sign in, and try again—or clear this site’s data in browser settings.');
  }
}

/* ================= confirm dialog ================= */
// Stands in for window.confirm(), which is unreliable inside iOS "Add to Home
// Screen" apps (it can silently no-op instead of showing anything). Every
// destructive action in the app routes through this instead.
let confirmResolver = null;
const dialogOpeners = new Map();
function visibleDialogLayers(){
  return [...document.querySelectorAll('.overlay.show')].sort((a, b) => {
    const aZ = Number.parseInt(getComputedStyle(a).zIndex, 10) || 0;
    const bZ = Number.parseInt(getComputedStyle(b).zIndex, 10) || 0;
    return aZ - bZ;
  });
}
function syncModalLayers(){
  const visible = visibleDialogLayers();
  const shell = document.querySelector('.shell');
  const nav = document.querySelector('.bottom-nav');
  const hasModal = visible.length > 0;
  if(shell) shell.inert = hasModal;
  if(nav) nav.inert = hasModal;
  visible.forEach((overlay, index) => { overlay.inert = index !== visible.length - 1; });
}
function openDialog(id, focusId){
  const overlay = document.getElementById(id);
  dialogOpeners.set(id, document.activeElement);
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  syncModalLayers();
  setTimeout(() => {
    const target = focusId ? document.getElementById(focusId) : overlay.querySelector('button,input,select,textarea');
    if(target) target.focus();
  }, 30);
}
function closeDialog(id){
  const overlay = document.getElementById(id);
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.inert = false;
  syncModalLayers();
  const opener = dialogOpeners.get(id);
  dialogOpeners.delete(id);
  if(opener && opener.isConnected) setTimeout(() => opener.focus(), 0);
}
function showConfirm(message, confirmLabel){
  return new Promise(resolve => {
    confirmResolver = resolve;
    document.getElementById('confirmMessage').textContent = message;
    document.getElementById('confirmActionBtn').textContent = confirmLabel || 'Delete';
    openDialog('confirmOverlay', 'confirmActionBtn');
  });
}
function resolveConfirm(result){
  closeDialog('confirmOverlay');
  const resolve = confirmResolver;
  confirmResolver = null;
  if(resolve) resolve(result);
}

/* ================= actions ================= */
function logHabit(id){
  const h = habits.find(x => x.id === id);
  if(!h) return;
  const today = todayKey();
  let pts;

  if(h.type === 'good'){
    h.streak = projectedStreak(h);
    h.lastDate = today;
    const mult = streakMultiplier(h.streak);
    pts = Math.max(1, Math.round(h.points * mult));
  } else {
    pts = -Math.abs(h.points);
  }

  const entry = { id: uid(), date: today, name: h.name, type: h.type, points: pts, ts: Date.now(), habitId: h.id };
  entries.push(entry);
  persistData();
  renderAll(true);
  showUndoToast(entry);
}

function logBonus(id){
  const b = bonusTasks.find(x => x.id === id);
  if(!b) return;
  const entry = { id: uid(), date: todayKey(), name: b.name, type: 'bonus', points: Math.abs(b.points), ts: Date.now(), bonusId: b.id };
  entries.push(entry);
  persistData();
  renderAll(true);
  showUndoToast(entry);
}

function setExplicitCompletion(date, shouldComplete){
  if(!isValidDateKey(date) || date < statsStartKey() || date > todayKey()) return;
  const existing = explicitCompletionForDate(date);
  if(shouldComplete && !existing){
    completedDays.push({ id:completedDayId(date), date, ts:Date.now() });
  }else if(!shouldComplete && existing){
    completedDays = completedDays.filter(day => day.date !== date);
  }else{
    return;
  }
  persistData();
  renderAll();
}
function toggleDayCompletion(date){
  const target = date || todayKey();
  const existing = explicitCompletionForDate(target);
  if(existing){
    const saved = { ...existing };
    setExplicitCompletion(target, false);
    showUndoAction(`Marked ${target} untracked`, () => {
      if(!explicitCompletionForDate(target)){
        completedDays.push(saved);
        persistData();
        renderAll();
      }
    });
  }else{
    setExplicitCompletion(target, true);
    showUndoAction(`Completed · ${target}`, () => setExplicitCompletion(target, false));
  }
}

// Removing a logged entry — used by both the Undo toast and the Today's Activity list.
// For credit entries, the habit's streak has to be recalculated from what's actually left
// in the log, or the habit would keep claiming a streak day that was just undone.
function deleteEntry(entryId, offerUndo){
  const entry = entries.find(e => e.id === entryId);
  if(!entry) return;
  entries = entries.filter(e => e.id !== entryId);

  if(entry.type === 'good'){
    // Only fall back to name-matching for genuinely legacy entries that never had a
    // habitId at all. If habitId IS set but doesn't match anything, that habit was
    // deleted — guessing by name risks silently attributing it to an unrelated habit
    // that happens to share the same name.
    const legacyMatches = entry.habitId
      ? []
      : habits.filter(h => h.type === 'good' && h.name === entry.name);
    const habit = entry.habitId
      ? habits.find(h => h.id === entry.habitId && h.type === 'good')
      : (legacyMatches.length === 1 ? legacyMatches[0] : null);
    if(habit) recomputeHabitStreak(habit);
  }

  persistData();
  renderAll(true);
  if(offerUndo){
    showUndoAction(`Removed · ${entry.name}`, () => {
      entries.push(entry);
      if(entry.type === 'good'){
        const habit = entry.habitId ? habits.find(h => h.id === entry.habitId && h.type === 'good') : null;
        if(habit) recomputeHabitStreak(habit);
      }
      persistData();
      renderAll(true);
    });
  }
}

// Rebuilds a habit's streak/lastDate purely from remaining entries, rather than trying to
// "step backward" from its current state — simpler to reason about and correct however many
// entries get removed at once.
function recomputeHabitStreak(habit){
  const sameNameGoodHabits = habits.filter(h => h.type === 'good' && h.name === habit.name);
  const dates = [...new Set(
    entries
      .filter(e => e.type === 'good' && isInStatsWindow(e.date) && (
        e.habitId
          ? e.habitId === habit.id
          : (sameNameGoodHabits.length === 1 && e.name === habit.name)
      ))
      .map(e => e.date)
  )].sort();

  if(dates.length === 0){
    habit.streak = 0;
    habit.lastDate = null;
    return;
  }

  const lastDate = dates[dates.length - 1];
  let streak = 1;
  let cursor = lastDate;
  for(let i = dates.length - 2; i >= 0; i--){
    const expectedPrev = addDaysToKey(cursor, -1);
    if(dates[i] === expectedPrev){
      streak++;
      cursor = expectedPrev;
    } else {
      break;
    }
  }
  habit.lastDate = lastDate;
  habit.streak = streak;
}

function recomputeAllHabitStreaks(){
  habits.filter(habit => habit.type === 'good').forEach(recomputeHabitStreak);
  habits.filter(habit => habit.type !== 'good').forEach(habit => {
    habit.streak = 0;
    habit.lastDate = null;
  });
}

/* ---- habit modal ---- */
function openHabitModal(type, id){
  editingHabitId = id || null;
  const title = document.getElementById('habitModalTitle');
  const delBtn = document.getElementById('deleteHabitBtn');
  clearFieldError('habitError');

  if(id){
    const h = habits.find(x => x.id === id);
    if(!h) return;
    document.getElementById('habitName').value = h.name;
    document.getElementById('habitPoints').value = h.points;
    setHabitType(h.type);
    title.textContent = 'Edit ' + (h.type === 'good' ? 'credit' : 'debit');
    delBtn.style.display = 'block';
  } else {
    document.getElementById('habitName').value = '';
    document.getElementById('habitPoints').value = '';
    setHabitType(type || 'good');
    title.textContent = 'Add ' + (type === 'bad' ? 'debit' : 'credit');
    delBtn.style.display = 'none';
  }
  openDialog('habitOverlay', 'habitName');
}
function closeHabitModal(){
  closeDialog('habitOverlay');
  editingHabitId = null;
}
function setHabitType(type){
  habitTypeDraft = type;
  document.getElementById('segGood').classList.toggle('active', type === 'good');
  document.getElementById('segGood').classList.toggle('good', true);
  document.getElementById('segBad').classList.toggle('active', type === 'bad');
  document.getElementById('segBad').classList.toggle('bad', true);
  document.getElementById('pointsLabel').textContent = type === 'good' ? 'Points earned' : 'Points lost';
  document.getElementById('habitHint').style.display = type === 'good' ? 'block' : 'none';
}
function showFieldError(id, message, focusId){
  const el = document.getElementById(id);
  el.textContent = message;
  el.classList.add('show');
  if(focusId) document.getElementById(focusId).focus();
}
function clearFieldError(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = '';
  el.classList.remove('show');
}
function saveHabit(){
  const name = document.getElementById('habitName').value.trim();
  const pointsRaw = document.getElementById('habitPoints').value;
  const points = Number(pointsRaw);
  clearFieldError('habitError');
  if(!name) return showFieldError('habitError', 'Enter a habit name.', 'habitName');
  if(!Number.isInteger(points) || points < 1 || points > 999){
    return showFieldError('habitError', 'Points must be a whole number from 1 to 999.', 'habitPoints');
  }
  if(editingHabitId){
    const h = habits.find(x => x.id === editingHabitId);
    if(!h) return showFieldError('habitError', 'This habit no longer exists. Close and try again.');
    const typeChanged = h.type !== habitTypeDraft;
    h.name = name;
    h.points = points;
    h.type = habitTypeDraft;
    if(typeChanged){
      if(h.type === 'good') recomputeHabitStreak(h);
      else { h.streak = 0; h.lastDate = null; }
    }
  } else {
    habits.push({ id: uid(), name, type: habitTypeDraft, points, streak: 0, lastDate: null });
  }
  persistData();
  closeHabitModal();
  renderAll();
}
async function deleteHabitConfirm(){
  if(!editingHabitId) return;
  const ok = await showConfirm('Delete this habit? Past entries stay in your history.');
  if(ok){
    habits = habits.filter(x => x.id !== editingHabitId);
    persistData();
    closeHabitModal();
    renderAll();
  }
}

/* ---- bonus modal ---- */
function openBonusModal(id){
  editingBonusId = id || null;
  const title = document.getElementById('bonusModalTitle');
  const delBtn = document.getElementById('deleteBonusBtn');
  clearFieldError('bonusError');
  if(id){
    const b = bonusTasks.find(x => x.id === id);
    if(!b) return;
    document.getElementById('bonusName').value = b.name;
    document.getElementById('bonusPoints').value = b.points;
    title.textContent = 'Edit bonus entry';
    delBtn.style.display = 'block';
  } else {
    document.getElementById('bonusName').value = '';
    document.getElementById('bonusPoints').value = '';
    title.textContent = 'Add bonus entry';
    delBtn.style.display = 'none';
  }
  openDialog('bonusOverlay', 'bonusName');
}
function closeBonusModal(){
  closeDialog('bonusOverlay');
  editingBonusId = null;
}
function saveBonus(){
  const name = document.getElementById('bonusName').value.trim();
  const points = Number(document.getElementById('bonusPoints').value);
  clearFieldError('bonusError');
  if(!name) return showFieldError('bonusError', 'Enter a bonus name.', 'bonusName');
  if(!Number.isInteger(points) || points < 1 || points > 999){
    return showFieldError('bonusError', 'Points must be a whole number from 1 to 999.', 'bonusPoints');
  }
  if(editingBonusId){
    const b = bonusTasks.find(x => x.id === editingBonusId);
    if(!b) return showFieldError('bonusError', 'This bonus entry no longer exists. Close and try again.');
    b.name = name; b.points = points;
  } else {
    bonusTasks.push({ id: uid(), name, points });
  }
  persistData();
  closeBonusModal();
  renderAll();
}
async function deleteBonusConfirm(){
  if(!editingBonusId) return;
  const ok = await showConfirm('Delete this bonus entry? Past entries stay in your history.');
  if(ok){
    bonusTasks = bonusTasks.filter(x => x.id !== editingBonusId);
    persistData();
    closeBonusModal();
    renderAll();
  }
}

/* ---- automatic success milestones ---- */
function openMilestoneModal(id){
  editingMilestoneId = id || null;
  const title = document.getElementById('milestoneModalTitle');
  const delBtn = document.getElementById('deleteMilestoneBtn');
  clearFieldError('milestoneError');
  if(id){
    const milestone = milestones.find(item => item.id === id);
    if(!milestone) return;
    document.getElementById('milestoneName').value = milestone.name;
    document.getElementById('milestoneDays').value = milestone.days;
    document.getElementById('milestonePoints').value = milestone.points;
    document.getElementById('milestoneDescription').value = milestone.description || '';
    title.textContent = 'Edit success milestone';
    delBtn.style.display = 'block';
  }else{
    document.getElementById('milestoneName').value = '';
    document.getElementById('milestoneDays').value = '';
    document.getElementById('milestonePoints').value = '';
    document.getElementById('milestoneDescription').value = '';
    title.textContent = 'Add success milestone';
    delBtn.style.display = 'none';
  }
  openDialog('milestoneOverlay', 'milestoneName');
}
function closeMilestoneModal(){
  closeDialog('milestoneOverlay');
  editingMilestoneId = null;
}
function saveMilestone(){
  const name = document.getElementById('milestoneName').value.trim();
  const days = Number(document.getElementById('milestoneDays').value);
  const points = Number(document.getElementById('milestonePoints').value);
  const description = document.getElementById('milestoneDescription').value.trim();
  clearFieldError('milestoneError');
  if(!name) return showFieldError('milestoneError', 'Enter a milestone name.', 'milestoneName');
  if(!Number.isInteger(days) || days < 1 || days > 100000){
    return showFieldError('milestoneError', 'Successful day must be a whole number from 1 to 100,000.', 'milestoneDays');
  }
  if(!Number.isInteger(points) || points < 1 || points > 9999){
    return showFieldError('milestoneError', 'Reward points must be a whole number from 1 to 9,999.', 'milestonePoints');
  }
  if(description.length > 160){
    return showFieldError('milestoneError', 'Keep the description to 160 characters or fewer.', 'milestoneDescription');
  }
  if(editingMilestoneId){
    const milestone = milestones.find(item => item.id === editingMilestoneId);
    if(!milestone) return showFieldError('milestoneError', 'This milestone no longer exists. Close and try again.');
    milestone.name = name;
    milestone.days = days;
    milestone.points = points;
    milestone.description = description;
  }else{
    milestones.push({ id:uid(), name, days, points, description });
  }
  persistData();
  closeMilestoneModal();
  renderAll();
}
async function deleteMilestoneConfirm(){
  if(!editingMilestoneId) return;
  const milestone = milestones.find(item => item.id === editingMilestoneId);
  if(!milestone) return;
  const ok = await showConfirm(
    `Delete “${milestone.name}”? Every automatic award generated by it will be removed retroactively.`,
    'Delete milestone'
  );
  if(ok){
    milestones = milestones.filter(item => item.id !== editingMilestoneId);
    persistData();
    closeMilestoneModal();
    renderAll();
  }
}

/* ---- settings ---- */
// Formats an hour (0-23) as a human 12-hour label, e.g. 7 -> "7:00 AM", 0 -> "12:00 AM".
function hourLabel(h){
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = (h % 12) === 0 ? 12 : (h % 12);
  return `${hour12}:00 ${period}`;
}
function initDayStartOptions(){
  const sel = document.getElementById('dayStartInput');
  sel.innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${hourLabel(h)}</option>`).join('');
}

function openSettings(){
  document.getElementById('baseInput').value = dailyBase;
  document.getElementById('thresholdInput').value = successThreshold;
  document.getElementById('dayStartInput').value = String(dayStartHour);
  document.getElementById('startDateInput').max = todayKey();
  document.getElementById('startDateInput').value = statsStartKey();
  const reminderSel = document.getElementById('reminderInput');
  reminderSel.value = [0,1,3,7,14,30].includes(backupReminderDays) ? String(backupReminderDays) : '7';
  clearFieldError('settingsError');
  openDialog('settingsOverlay', 'baseInput');
}
function closeSettings(){
  closeDialog('settingsOverlay');
}
function saveSettings(){
  const base = Number(document.getElementById('baseInput').value);
  const threshold = Number(document.getElementById('thresholdInput').value);
  const dayStart = Number(document.getElementById('dayStartInput').value);
  const startDate = document.getElementById('startDateInput').value;
  const reminder = Number(document.getElementById('reminderInput').value);
  clearFieldError('settingsError');
  if(!Number.isInteger(base) || base < 0 || base > 9999){
    return showFieldError('settingsError', 'Daily base must be a whole number from 0 to 9999.', 'baseInput');
  }
  if(!Number.isInteger(threshold) || threshold < 0 || threshold > 9999){
    return showFieldError('settingsError', 'Success threshold must be a whole number from 0 to 9999.', 'thresholdInput');
  }
  if(!Number.isInteger(dayStart) || dayStart < 0 || dayStart > 23){
    return showFieldError('settingsError', 'Choose a valid day-start hour.', 'dayStartInput');
  }
  if(!isValidDateKey(startDate) || startDate > ledgerDateKeyForHour(dayStart)){
    return showFieldError('settingsError', 'Choose a valid statistics start date no later than the current ledger day.', 'startDateInput');
  }
  dailyBase = base;
  successThreshold = threshold;
  dayStartHour = dayStart;
  trackingStartDate = startDate;
  if([0,1,3,7,14,30].includes(reminder)) backupReminderDays = reminder;
  reminderDismissedThisSession = false; // let a freshly chosen cadence show if already due
  recomputeAllHabitStreaks();
  persistSettings();
  closeSettings();
  renderAll();
}

/* ---- backup ---- */
function formatBackupStatus(){
  if(!lastBackupAt) return 'No backup has ever been made.';
  const date = new Date(lastBackupAt);
  return `Last complete backup: ${date.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })} at ${date.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}`;
}
function renderBackupDate(){
  const text = formatBackupStatus();
  const row = document.getElementById('backupDateEl');
  const modal = document.getElementById('backupLastEl');
  if(row) row.textContent = text;
  if(modal) modal.textContent = text;
}
function markBackupCompleted(exportedAt){
  const clean = validIsoTimestamp(exportedAt);
  if(!clean) return;
  if(!lastBackupAt || clean > lastBackupAt){
    lastBackupAt = clean;
    persistSettings();
  }
  renderBackupDate();
  reminderDismissedThisSession = false; // a fresh backup clears the nudge until it's due again
  updateBackupReminder();
}

function hasAnyLedgerData(){
  return entries.length || habits.length || bonusTasks.length || milestones.length || completedDays.length;
}
function describeDaysSince(iso){
  const ms = new Date(iso).getTime();
  if(!Number.isFinite(ms)) return 'a while ago';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if(days <= 0) return 'earlier today';
  if(days === 1) return 'yesterday';
  return `${days} days ago`;
}
function backupReminderDue(){
  if(!backupReminderDays || backupReminderDays <= 0) return false;
  if(!hasAnyLedgerData()) return false;
  if(!lastBackupAt) return true;
  const last = new Date(lastBackupAt).getTime();
  if(!Number.isFinite(last)) return true;
  return (Date.now() - last) / 86400000 >= backupReminderDays;
}
function updateBackupReminder(){
  const el = document.getElementById('reminderBanner');
  if(!el) return;
  if(reminderDismissedThisSession || !backupReminderDue()){
    el.classList.remove('show');
    return;
  }
  el.querySelector('.reminder-text').textContent = lastBackupAt
    ? `Last backup was ${describeDaysSince(lastBackupAt)}. Save a fresh one to protect your ledger.`
    : `You haven't saved a backup yet. Save one so a cleared browser or lost device can't erase your ledger.`;
  el.classList.add('show');
}
function dismissReminder(){
  reminderDismissedThisSession = true;
  updateBackupReminder();
}

// Shared "what's currently stored" summary, used by the Reset preview and echoed in
// the destructive-action confirmations so nothing is cleared blind.
function ledgerCountsSentence(){
  const parts = [
    `${habits.length} habit${habits.length === 1 ? '' : 's'}`,
    `${bonusTasks.length} bonus entr${bonusTasks.length === 1 ? 'y' : 'ies'}`,
    `${milestones.length} milestone${milestones.length === 1 ? '' : 's'}`,
    `${completedDays.length} completed-day mark${completedDays.length === 1 ? '' : 's'}`,
    `${entries.length} logged entr${entries.length === 1 ? 'y' : 'ies'}`
  ];
  return parts.join(', ');
}
function renderResetPreview(){
  const el = document.getElementById('resetPreviewEl');
  if(!el) return;
  if(!hasAnyLedgerData()){
    el.innerHTML = `<strong>Nothing stored yet</strong><br>There's no ledger data to clear on this device.`;
    return;
  }
  el.innerHTML = `<strong>This device currently holds</strong><br>${ledgerCountsSentence()}. Clearing can't be undone from inside the app — save a backup first if you're unsure.`;
}
function setCsvButtonsDisabled(disabled){
  const restore = document.getElementById('restoreCsvBtn');
  const merge = document.getElementById('mergeCsvBtn');
  if(restore) restore.disabled = disabled;
  if(merge) merge.disabled = disabled;
}
function openBackup(){
  document.getElementById('backupText').value = JSON.stringify(buildExport(), null, 2);
  document.getElementById('restoreText').value = '';
  document.getElementById('restoreFileInput').value = '';
  document.getElementById('csvRestoreFileInput').value = '';
  setCsvButtonsDisabled(true);
  pendingCsvBackupText = null;
  setBackupStatus('');
  renderBackupDate();
  document.getElementById('shareBackupBtn').style.display = navigator.share ? '' : 'none';
  openDialog('backupOverlay', 'backupText');
}
function backupFilename(){
  return `tally-backup-${todayKey()}-${new Date().toTimeString().slice(0,5).replace(':','')}.json`;
}
function backupFile(){
  const data = buildExport();
  const text = JSON.stringify(data, null, 2);
  return {
    file:new File([text], backupFilename(), { type:'application/json' }),
    exportedAt:data.exportedAt
  };
}
function setBackupStatus(message, tone){
  const el = document.getElementById('backupStatus');
  el.textContent = message;
  el.className = `status-message${tone ? ` ${tone}` : ''}`;
}
function backupContentsLabel(clean){
  return `${clean.habits.length} habit${clean.habits.length === 1 ? '' : 's'}, ${clean.bonusTasks.length} bonus entr${clean.bonusTasks.length === 1 ? 'y' : 'ies'}, ${clean.milestones.length} milestone${clean.milestones.length === 1 ? '' : 's'}, ${clean.completedDays.length} completed day${clean.completedDays.length === 1 ? '' : 's'}, and ${clean.entries.length} logged entr${clean.entries.length === 1 ? 'y' : 'ies'}`;
}
function triggerFileDownload(file){
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function downloadBackup(){
  const payload = backupFile();
  triggerFileDownload(payload.file);
  markBackupCompleted(payload.exportedAt);
  const file = payload.file;
  setBackupStatus(`Saved ${file.name}.`, 'success');
}
async function shareBackup(){
  const payload = backupFile();
  const file = payload.file;
  try{
    if(navigator.canShare && navigator.canShare({ files:[file] })){
      await navigator.share({ title:'Tally backup', files:[file] });
    } else if(navigator.share){
      await navigator.share({ title:'Tally backup', text:await file.text() });
    } else {
      downloadBackup();
      return;
    }
    markBackupCompleted(payload.exportedAt);
    setBackupStatus('Backup shared successfully.', 'success');
  }catch(e){
    if(e && e.name === 'AbortError') setBackupStatus('Sharing cancelled.');
    else setBackupStatus('The backup could not be shared. Use Save file instead.', 'error');
  }
}
// One-tap path oriented at iOS "Save to Files". On iPhone the share sheet exposes
// Files/iCloud Drive; on browsers without file sharing it falls back to a download so
// the button always produces a saved backup somewhere.
async function exportToFiles(){
  const payload = backupFile();
  const file = payload.file;
  try{
    if(navigator.canShare && navigator.canShare({ files:[file] })){
      await navigator.share({ title:'Tally backup', files:[file] });
      markBackupCompleted(payload.exportedAt);
      setBackupStatus('Choose "Save to Files" in the share sheet to store this in iCloud Drive.', 'success');
      return;
    }
  }catch(e){
    if(e && e.name === 'AbortError'){ setBackupStatus('Export cancelled.'); return; }
  }
  triggerFileDownload(file);
  markBackupCompleted(payload.exportedAt);
  setBackupStatus(`Saved ${file.name} to your device's downloads.`, 'success');
}
function csvCell(value, protectFormula){
  let text = String(value == null ? '' : value);
  if(protectFormula && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const FULL_CSV_BACKUP_VERSION = '3';
const FULL_CSV_V1_HEADERS = [
  'format_version','record_type','revision','writer_id','id','name_json','type',
  'points','streak','last_date','ledger_date','timestamp_ms','habit_id','bonus_id',
  'daily_base','success_threshold','day_start_hour','tracking_start_date',
  'history_range_days','last_backup_at','exported_at'
];
const FULL_CSV_V2_HEADERS = [...FULL_CSV_V1_HEADERS, 'threshold_days', 'description_json'];
const FULL_CSV_HEADERS = [...FULL_CSV_V2_HEADERS, 'backup_reminder_days'];
function fullCsvRow(values){
  return FULL_CSV_HEADERS.map(header => values[header] == null ? '' : values[header]);
}
function buildFullCsvBackup(){
  const snapshot = buildExport();
  const rows = [
    fullCsvRow({
      format_version:FULL_CSV_BACKUP_VERSION,
      record_type:'meta',
      revision:snapshot.revision,
      writer_id:snapshot.writerId,
      exported_at:snapshot.exportedAt
    }),
    fullCsvRow({
      record_type:'settings',
      daily_base:snapshot.settings.dailyBase,
      success_threshold:snapshot.settings.successThreshold,
      day_start_hour:snapshot.settings.dayStartHour,
      tracking_start_date:snapshot.settings.trackingStartDate,
      history_range_days:snapshot.settings.historyRangeDays,
      last_backup_at:snapshot.settings.lastBackupAt || '',
      backup_reminder_days:snapshot.settings.backupReminderDays
    }),
    ...snapshot.data.habits.map(habit => fullCsvRow({
      record_type:'habit',
      id:habit.id,
      name_json:JSON.stringify(habit.name),
      type:habit.type,
      points:habit.points,
      streak:habit.streak,
      last_date:habit.lastDate || ''
    })),
    ...snapshot.data.bonusTasks.map(bonus => fullCsvRow({
      record_type:'bonus',
      id:bonus.id,
      name_json:JSON.stringify(bonus.name),
      points:bonus.points
    })),
    ...snapshot.data.milestones.map(milestone => fullCsvRow({
      record_type:'milestone',
      id:milestone.id,
      name_json:JSON.stringify(milestone.name),
      points:milestone.points,
      threshold_days:milestone.days,
      description_json:JSON.stringify(milestone.description || '')
    })),
    ...snapshot.data.completedDays.map(day => fullCsvRow({
      record_type:'completed_day',
      id:day.id,
      ledger_date:day.date,
      timestamp_ms:day.ts
    })),
    ...snapshot.data.entries.map(entry => fullCsvRow({
      record_type:'entry',
      id:entry.id,
      name_json:JSON.stringify(entry.name),
      type:entry.type,
      points:entry.points,
      ledger_date:entry.date,
      timestamp_ms:entry.ts,
      habit_id:entry.habitId || '',
      bonus_id:entry.bonusId || ''
    }))
  ];
  const text = '\uFEFF' + [FULL_CSV_HEADERS, ...rows]
    .map(row => row.map(value => csvCell(value, false)).join(','))
    .join('\r\n') + '\r\n';
  return { text, exportedAt:snapshot.exportedAt };
}
function parseCsvRows(raw){
  if(typeof raw !== 'string') throw new Error('The CSV backup must be text.');
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  if(!text) throw new Error('The CSV backup is empty.');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let quoteClosed = false;
  const finishField = () => {
    row.push(field);
    field = '';
    quoteClosed = false;
  };
  const finishRow = () => {
    finishField();
    if(rows.length >= 200000) throw new Error('The CSV backup contains too many rows.');
    rows.push(row);
    row = [];
  };
  for(let i = 0; i < text.length; i++){
    const char = text[i];
    if(inQuotes){
      if(char === '"'){
        if(text[i + 1] === '"'){
          field += '"';
          i++;
        }else{
          inQuotes = false;
          quoteClosed = true;
        }
      }else{
        field += char;
      }
      continue;
    }
    if(quoteClosed){
      if(char === ','){
        finishField();
      }else if(char === '\n'){
        finishRow();
      }else if(char === '\r'){
        if(text[i + 1] === '\n') i++;
        finishRow();
      }else{
        throw new Error('The CSV backup has characters after a closing quote.');
      }
      continue;
    }
    if(char === '"'){
      if(field) throw new Error('The CSV backup has a quote inside an unquoted field.');
      inQuotes = true;
    }else if(char === ','){
      finishField();
    }else if(char === '\n'){
      finishRow();
    }else if(char === '\r'){
      if(text[i + 1] === '\n') i++;
      finishRow();
    }else{
      field += char;
    }
  }
  if(inQuotes) throw new Error('The CSV backup has an unclosed quoted field.');
  if(quoteClosed || field || row.length) finishRow();
  return rows;
}
function csvBackupInteger(value, label, min, max){
  if(!/^-?(0|[1-9]\d*)$/.test(value)) throw new Error(`${label} must be a whole number.`);
  const number = Number(value);
  if(!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} is out of range.`);
  return number;
}
function csvBackupName(value, rowNumber){
  let name;
  try{ name = JSON.parse(value); }
  catch(e){ throw new Error(`Row ${rowNumber} has an invalid encoded name.`); }
  if(typeof name !== 'string') throw new Error(`Row ${rowNumber} has an invalid encoded name.`);
  return name;
}
function assertCsvFields(record, allowed, rowNumber, headers = FULL_CSV_HEADERS){
  for(const header of headers){
    if(!allowed.includes(header) && record[header] !== ''){
      throw new Error(`Row ${rowNumber} has unexpected data in ${header}.`);
    }
  }
}
function parseFullCsvBackup(raw){
  const rows = parseCsvRows(raw);
  if(rows.length < 3) throw new Error('The CSV backup is missing required rows.');
  const matchesHeaders = headers =>
    rows[0].length === headers.length && headers.every((header, index) => rows[0][index] === header);
  const headers = matchesHeaders(FULL_CSV_HEADERS)
    ? FULL_CSV_HEADERS
    : (matchesHeaders(FULL_CSV_V2_HEADERS)
      ? FULL_CSV_V2_HEADERS
      : (matchesHeaders(FULL_CSV_V1_HEADERS) ? FULL_CSV_V1_HEADERS : null));
  if(!headers){
    throw new Error('This is not a recognized Tally CSV backup.');
  }
  const records = rows.slice(1).map((values, index) => {
    const rowNumber = index + 2;
    if(values.length !== headers.length) throw new Error(`Row ${rowNumber} has the wrong number of columns.`);
    if(values.every(value => value === '')) throw new Error(`Row ${rowNumber} is blank.`);
    return {
      rowNumber,
      values:Object.fromEntries(headers.map((header, column) => [header, values[column]]))
    };
  });
  const metaRows = records.filter(record => record.values.record_type === 'meta');
  const settingsRows = records.filter(record => record.values.record_type === 'settings');
  if(metaRows.length !== 1) throw new Error('The CSV backup must contain exactly one meta row.');
  if(settingsRows.length !== 1) throw new Error('The CSV backup must contain exactly one settings row.');

  const meta = metaRows[0];
  assertCsvFields(meta.values, ['format_version','record_type','revision','writer_id','exported_at'], meta.rowNumber, headers);
  const expectedVersion = headers === FULL_CSV_HEADERS
    ? FULL_CSV_BACKUP_VERSION
    : (headers === FULL_CSV_V2_HEADERS ? '2' : '1');
  if(meta.values.format_version !== expectedVersion){
    throw new Error(`CSV backup version ${meta.values.format_version || '(missing)'} is not supported.`);
  }
  const exportedAt = validIsoTimestamp(meta.values.exported_at);
  if(!exportedAt) throw new Error('The CSV backup has an invalid export date.');
  if(meta.values.writer_id && !SAFE_ID.test(meta.values.writer_id)) throw new Error('The CSV backup has an invalid writer ID.');
  const revision = csvBackupInteger(meta.values.revision, 'CSV revision', 0, Number.MAX_SAFE_INTEGER);

  const settingsRow = settingsRows[0];
  const settings = settingsRow.values;
  assertCsvFields(settings, [
    'record_type','daily_base','success_threshold','day_start_hour',
    'tracking_start_date','history_range_days','last_backup_at',
    'backup_reminder_days'
  ], settingsRow.rowNumber, headers);
  if(settings.last_backup_at && !validIsoTimestamp(settings.last_backup_at)){
    throw new Error('The CSV backup has an invalid previous backup date.');
  }
  const historyRange = settings.history_range_days === 'all'
    ? 'all'
    : csvBackupInteger(settings.history_range_days, 'History range', 1, 100000);
  if(![7,14,30,90,'all'].includes(historyRange)) throw new Error('The CSV backup has an unsupported history range.');

  const habits = [];
  const bonusTasks = [];
  const restoredMilestones = [];
  const restoredCompletedDays = [];
  const restoredEntries = [];
  for(const record of records){
    const value = record.values;
    if(value.record_type === 'meta' || value.record_type === 'settings') continue;
    if(value.record_type === 'habit'){
      assertCsvFields(value, ['record_type','id','name_json','type','points','streak','last_date'], record.rowNumber, headers);
      habits.push({
        id:value.id,
        name:csvBackupName(value.name_json, record.rowNumber),
        type:value.type,
        points:csvBackupInteger(value.points, `Row ${record.rowNumber} points`, 1, 999),
        streak:csvBackupInteger(value.streak, `Row ${record.rowNumber} streak`, 0, 100000),
        lastDate:value.last_date || null
      });
    }else if(value.record_type === 'bonus'){
      assertCsvFields(value, ['record_type','id','name_json','points'], record.rowNumber, headers);
      bonusTasks.push({
        id:value.id,
        name:csvBackupName(value.name_json, record.rowNumber),
        points:csvBackupInteger(value.points, `Row ${record.rowNumber} points`, 1, 999)
      });
    }else if(value.record_type === 'entry'){
      assertCsvFields(value, [
        'record_type','id','name_json','type','points','ledger_date',
        'timestamp_ms','habit_id','bonus_id'
      ], record.rowNumber, headers);
      const entry = {
        id:value.id,
        name:csvBackupName(value.name_json, record.rowNumber),
        type:value.type,
        points:csvBackupInteger(value.points, `Row ${record.rowNumber} points`, -9999, 9999),
        date:value.ledger_date,
        ts:csvBackupInteger(value.timestamp_ms, `Row ${record.rowNumber} timestamp`, 0, 8640000000000000)
      };
      if(value.habit_id) entry.habitId = value.habit_id;
      if(value.bonus_id) entry.bonusId = value.bonus_id;
      restoredEntries.push(entry);
    }else if(value.record_type === 'milestone'){
      if(headers === FULL_CSV_V1_HEADERS) throw new Error(`Row ${record.rowNumber} has an unsupported record type.`);
      assertCsvFields(value, [
        'record_type','id','name_json','points','threshold_days','description_json'
      ], record.rowNumber, headers);
      restoredMilestones.push({
        id:value.id,
        name:csvBackupName(value.name_json, record.rowNumber),
        days:csvBackupInteger(value.threshold_days, `Row ${record.rowNumber} successful day`, 1, 100000),
        points:csvBackupInteger(value.points, `Row ${record.rowNumber} points`, 1, 9999),
        description:csvBackupName(value.description_json, record.rowNumber)
      });
    }else if(value.record_type === 'completed_day'){
      if(headers === FULL_CSV_V1_HEADERS) throw new Error(`Row ${record.rowNumber} has an unsupported record type.`);
      assertCsvFields(value, ['record_type','id','ledger_date','timestamp_ms'], record.rowNumber, headers);
      restoredCompletedDays.push({
        id:value.id,
        date:value.ledger_date,
        ts:csvBackupInteger(value.timestamp_ms, `Row ${record.rowNumber} timestamp`, 0, 8640000000000000)
      });
    }else{
      throw new Error(`Row ${record.rowNumber} has an unsupported record type.`);
    }
  }
  return validateBackupObject({
    app:'Tally',
    schemaVersion:SCHEMA_VERSION,
    revision,
    writerId:meta.values.writer_id || null,
    exportedAt,
    data:{
      habits,
      bonusTasks,
      milestones:restoredMilestones,
      completedDays:restoredCompletedDays,
      entries:restoredEntries
    },
    settings:{
      dailyBase:csvBackupInteger(settings.daily_base, 'Daily base', 0, 9999),
      successThreshold:csvBackupInteger(settings.success_threshold, 'Success threshold', 0, 9999),
      dayStartHour:csvBackupInteger(settings.day_start_hour, 'Day start hour', 0, 23),
      trackingStartDate:settings.tracking_start_date,
      historyRangeDays:historyRange,
      lastBackupAt:settings.last_backup_at || null,
      // Version 1/2 CSV files predate this column. Default legacy imports to Off
      // rather than unexpectedly enabling reminders that the file could not express.
      backupReminderDays:headers === FULL_CSV_HEADERS
        ? csvBackupInteger(settings.backup_reminder_days, 'Backup reminder cadence', 0, 366)
        : 0
    }
  });
}
function csvBackupFilename(){
  return `tally-backup-${todayKey()}-${new Date().toTimeString().slice(0,5).replace(':','')}.csv`;
}
function csvBackupFile(){
  const payload = buildFullCsvBackup();
  return {
    file:new File([payload.text], csvBackupFilename(), { type:'text/csv;charset=utf-8' }),
    exportedAt:payload.exportedAt
  };
}
function downloadCsvBackup(){
  const payload = csvBackupFile();
  triggerFileDownload(payload.file);
  markBackupCompleted(payload.exportedAt);
  setBackupStatus(`Saved ${payload.file.name}.`, 'success');
}

function buildActivityCsv(){
  const headers = ['ledger_date','logged_at','name','type','points','included_in_statistics','source','entry_id','habit_id','bonus_id','milestone_id'];
  const rows = allActivityEntries()
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts || a.id.localeCompare(b.id))
    .map(entry => [
      entry.date,
      new Date(entry.ts).toISOString(),
      entry.name,
      entry.type,
      Number(entry.points) || 0,
      isInStatsWindow(entry.date) ? 'true' : 'false',
      entry.derived ? 'automatic_milestone' : 'manual',
      entry.id,
      entry.habitId || '',
      entry.bonusId || '',
      entry.milestoneId || ''
    ]);
  return '\uFEFF' + [headers, ...rows]
    .map(row => row.map((value, index) => csvCell(value, index === 2)).join(','))
    .join('\r\n') + '\r\n';
}
function downloadCsv(){
  const file = new File(
    [buildActivityCsv()],
    `tally-activity-${todayKey()}.csv`,
    { type:'text/csv;charset=utf-8' }
  );
  triggerFileDownload(file);
}
function closeBackup(){
  closeDialog('backupOverlay');
  setBackupStatus('');
  pendingCsvBackupText = null;
  setCsvButtonsDisabled(true);
}
async function restoreValidatedBackup(clean, formatLabel){
  const label = formatLabel || 'backup';
  const ok = await showConfirm(
    `Replace the current ledger with this ${label} (${backupContentsLabel(clean)})? A recovery snapshot will be kept.`,
    'Restore'
  );
  if(!ok) return;
  const priorRevision = stateRevision;
  if(!await saveRecoverySnapshot('before-restore', buildSnapshot())){
    setBackupStatus('Restore cancelled because a recovery copy could not be saved. Save a complete backup file and try again.', 'error');
    return;
  }
  applyValidatedState(clean);
  stateRevision = Math.max(priorRevision, clean.revision);
  durableRevision = priorRevision;
  await schedulePersist();
  closeBackup();
  renderAll();
}
async function doRestore(){
  const raw = document.getElementById('restoreText').value.trim();
  setBackupStatus('');
  if(!raw){
    setBackupStatus('Choose a backup file or paste backup JSON first.', 'error');
    return;
  }
  let clean;
  try{
    clean = validateBackupObject(JSON.parse(raw));
  }catch(e){
    setBackupStatus(`Backup not restored: ${e.message}`, 'error');
    return;
  }
  return restoreValidatedBackup(clean, 'JSON backup');
}
async function doCsvRestore(){
  if(!pendingCsvBackupText){
    setBackupStatus('Choose a complete Tally CSV backup first.', 'error');
    return;
  }
  let clean;
  try{
    clean = parseFullCsvBackup(pendingCsvBackupText);
  }catch(e){
    pendingCsvBackupText = null;
    setCsvButtonsDisabled(true);
    setBackupStatus(`CSV backup not restored: ${e.message}`, 'error');
    return;
  }
  return restoreValidatedBackup(clean, 'CSV backup');
}
// Merge, rather than replace: union every collection by id. On an id collision the
// current copy wins, matching the concurrent-merge policy elsewhere — a merge never
// silently overwrites an item you already have, it only ADDS ones you don't. Because
// completed-day ids are derived from their date, unique ids also keep dates unique.
function unionById(currentItems, importedItems){
  const map = new Map();
  for(const item of importedItems) map.set(item.id, { ...item });
  for(const item of currentItems) map.set(item.id, { ...item });
  return [...map.values()];
}
function countNewById(currentItems, importedItems){
  const ids = new Set(currentItems.map(item => item.id));
  return importedItems.reduce((sum, item) => sum + (ids.has(item.id) ? 0 : 1), 0);
}
function mergeAddCounts(clean){
  return {
    habits: countNewById(habits, clean.habits),
    bonusTasks: countNewById(bonusTasks, clean.bonusTasks),
    milestones: countNewById(milestones, clean.milestones),
    completedDays: countNewById(completedDays, clean.completedDays),
    entries: countNewById(entries, clean.entries)
  };
}
function mergeImportedState(clean){
  const laterBackup = [validIsoTimestamp(lastBackupAt), validIsoTimestamp(clean.lastBackupAt)]
    .filter(Boolean).sort();
  return {
    app:'Tally',
    schemaVersion:SCHEMA_VERSION,
    revision:Math.max(stateRevision, clean.revision || 0),
    writerId:CLIENT_ID,
    data:{
      habits:unionById(habits, clean.habits),
      bonusTasks:unionById(bonusTasks, clean.bonusTasks),
      milestones:unionById(milestones, clean.milestones),
      completedDays:unionById(completedDays, clean.completedDays),
      entries:unionById(entries, clean.entries)
    },
    // Settings are device-local; a merge keeps yours untouched and only takes the
    // newer backup timestamp so the reminder stays honest.
    settings:{
      dailyBase, successThreshold, dayStartHour, trackingStartDate,
      lastBackupAt:laterBackup.length ? laterBackup[laterBackup.length - 1] : null,
      historyRangeDays, backupReminderDays
    }
  };
}
async function mergeValidatedBackup(clean, formatLabel){
  const label = formatLabel || 'backup';
  const adds = mergeAddCounts(clean);
  const total = adds.entries + adds.habits + adds.bonusTasks + adds.milestones + adds.completedDays;
  if(total === 0){
    setBackupStatus(`Nothing to merge — every item in that ${label} is already in your ledger.`, 'success');
    return;
  }
  const parts = [
    `${adds.entries} logged entr${adds.entries === 1 ? 'y' : 'ies'}`,
    `${adds.habits} habit${adds.habits === 1 ? '' : 's'}`,
    `${adds.bonusTasks} bonus entr${adds.bonusTasks === 1 ? 'y' : 'ies'}`,
    `${adds.milestones} milestone${adds.milestones === 1 ? '' : 's'}`,
    `${adds.completedDays} completed day${adds.completedDays === 1 ? '' : 's'}`
  ];
  const ok = await showConfirm(
    `Merge this ${label} into your current ledger? Adds ${parts.join(', ')}. Existing items and your current settings stay as they are, and a recovery snapshot is kept.`,
    'Merge'
  );
  if(!ok) return;
  const priorRevision = stateRevision;
  if(!await saveRecoverySnapshot('before-merge', buildSnapshot())){
    setBackupStatus('Merge cancelled because a recovery copy could not be saved. Save a complete backup file and try again.', 'error');
    return;
  }
  let mergedClean;
  try{
    mergedClean = validateBackupObject(mergeImportedState(clean));
  }catch(e){
    setBackupStatus(`Merge failed during validation: ${e.message}`, 'error');
    return;
  }
  applyValidatedState(mergedClean);
  stateRevision = Math.max(priorRevision, clean.revision || 0) + 1;
  durableRevision = priorRevision;
  await schedulePersist();
  closeBackup();
  renderAll();
  setBackupStatus('Merge complete.', 'success');
}
async function doMergeJson(){
  const raw = document.getElementById('restoreText').value.trim();
  setBackupStatus('');
  if(!raw){
    setBackupStatus('Choose a backup file or paste backup JSON first.', 'error');
    return;
  }
  let clean;
  try{
    clean = validateBackupObject(JSON.parse(raw));
  }catch(e){
    setBackupStatus(`Backup not merged: ${e.message}`, 'error');
    return;
  }
  return mergeValidatedBackup(clean, 'JSON backup');
}
async function doMergeCsv(){
  if(!pendingCsvBackupText){
    setBackupStatus('Choose a complete Tally CSV backup first.', 'error');
    return;
  }
  let clean;
  try{
    clean = parseFullCsvBackup(pendingCsvBackupText);
  }catch(e){
    setBackupStatus(`CSV backup not merged: ${e.message}`, 'error');
    return;
  }
  return mergeValidatedBackup(clean, 'CSV backup');
}
async function clearLedgerData(){
  const ok = await showConfirm(`Clear all habits, bonus entries, milestones, completed-day marks, and logged history? You'll lose ${ledgerCountsSentence()}. Your scoring settings will stay unchanged.`, 'Clear ledger');
  if(ok){
    if(!await saveRecoverySnapshot('before-clear-ledger', buildSnapshot())){
      showSaveWarning();
      return;
    }
    habits = []; bonusTasks = []; milestones = []; completedDays = []; entries = [];
    await persistData();
    renderAll();
  }
}
async function resetSettings(){
  const ok = await showConfirm('Reset scoring, the statistics start date, day boundary, and chart range to their defaults?', 'Reset settings');
  if(ok){
    if(!await saveRecoverySnapshot('before-reset-settings', buildSnapshot())){
      showSaveWarning();
      return;
    }
    dailyBase = 100;
    successThreshold = 80;
    dayStartHour = 7;
    trackingStartDate = inferredStartDate([...entries, ...completedDays], dayStartHour);
    historyRangeDays = 14;
    backupReminderDays = 7;
    recomputeAllHabitStreaks();
    await persistSettings();
    renderAll();
  }
}

/* ================= rendering ================= */
function renderAll(didLog){
  renderHeader(didLog);
  renderCompletionControl(todayKey(), 'todayCompletionControl');
  renderActivityLog();
  renderHabitList('good', 'goodList', 'No credits yet —', 'add your first one to start earning.', 'good');
  renderHabitList('bad', 'badList', 'No debits yet —', 'add one for a habit you want to cut back.', 'bad');
  renderBonusList();
  renderMilestoneList();
  renderHistory();
  renderStats();
  renderTrends();
  renderBackupDate();
  updateBackupReminder();
  renderResetPreview();
  renderCloudStatus();
  if(selectedDayKey && document.getElementById('dayOverlay').classList.contains('show')){
    renderDayActivity();
  }
}

function todayEntries(){
  const t = todayKey();
  return allActivityEntries(t).filter(e => e.date === t);
}

function renderCompletionControl(date, elementId){
  const el = document.getElementById(elementId);
  if(!el) return;
  const explicit = explicitCompletionForDate(date);
  const hasActivity = dayHasManualActivity(date);
  if(explicit){
    el.innerHTML = `<div class="completion-card tracked">
      <span class="completion-copy">
        <span class="completion-title">✓ Day marked complete</span>
        <span class="completion-sub">${hasActivity ? 'Activity also keeps this day tracked.' : `Tracked at the ${dailyBase} baseline with no manual activity.`}</span>
      </span>
      <button type="button" class="completion-button undo" data-action="toggle-day-complete" data-date="${date}">Undo</button>
    </div>`;
  }else if(hasActivity){
    el.innerHTML = `<div class="completion-card tracked">
      <span class="completion-copy">
        <span class="completion-title">✓ Tracked from activity</span>
        <span class="completion-sub">No separate completion tap is needed for this day.</span>
      </span>
    </div>`;
  }else{
    el.innerHTML = `<div class="completion-card">
      <span class="completion-copy">
        <span class="completion-title">Untracked day</span>
        <span class="completion-sub">Unknown days are excluded and pause your success streak.</span>
      </span>
      <button type="button" class="completion-button" data-action="toggle-day-complete" data-date="${date}">Mark complete</button>
    </div>`;
  }
}

function switchView(view){
  if(!['today','insights','manage'].includes(view)) return;
  activeView = view;
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('active', active);
    if(active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  window.scrollTo({ top:0, behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  if(view === 'manage'){
    updateStorageStatus();
    renderCloudStatus();
  }
}

function renderHeader(didLog){
  // Label the ledger day itself (which may still be "yesterday" until 7am), not
  // whatever the calendar says right now — otherwise the header could say Tuesday
  // while the score underneath is still Monday's, until the 7am rollover catches up.
  const ledgerDate = new Date(todayKey() + 'T00:00:00');
  document.getElementById('dateLabel').textContent =
    ledgerDate.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }).toUpperCase();

  const todays = todayEntries();
  const net = todays.reduce((s,e) => s + (Number(e.points) || 0), 0);
  const manualNet = entries.filter(entry => entry.date === todayKey()).reduce((sum, entry) => sum + (Number(entry.points) || 0), 0);
  const score = dailyBase + net;
  const allTime = allActivityEntries()
    .filter(entry => isInStatsWindow(entry.date))
    .reduce((sum, entry) => sum + (Number(entry.points) || 0), 0);

  const scoreEl = document.getElementById('scoreEl');
  const statusEl = document.getElementById('statusEl');
  const tone = net > 0 ? 'gain' : net < 0 ? 'loss' : 'even';

  scoreEl.textContent = score;
  scoreEl.className = 'score tabular mono ' + tone;
  statusEl.textContent = net > 0 ? `▲ +${net} today` : net < 0 ? `▼ ${net} today` : '— even today';
  statusEl.className = 'status-label ' + tone;

  document.getElementById('allTimeEl').textContent = (allTime > 0 ? '+' : '') + allTime;

  const successEl = document.getElementById('successTagEl');
  const todayTracked = isDayTracked(todayKey());
  if(!todayTracked){
    successEl.textContent = 'Untracked · log activity or mark complete';
    successEl.className = 'success-tag';
  }else if(dailyBase + manualNet >= successThreshold){
    successEl.textContent = `✓ Success day (≥${successThreshold})`;
    successEl.className = 'success-tag success';
  } else {
    successEl.textContent = `${successThreshold - (dailyBase + manualNet)} to go for a success day`;
    successEl.className = 'success-tag';
  }
  const progress = successThreshold <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((score / successThreshold) * 100)));
  document.getElementById('thresholdProgressEl').style.width = `${progress}%`;

  if(didLog){
    scoreEl.classList.remove('pulse');
    void scoreEl.offsetWidth;
    scoreEl.classList.add('pulse');
  }
}

function renderHabitList(type, elId, emptyLead, emptyRest, addType){
  const el = document.getElementById(elId);
  const list = habits.filter(h => h.type === type);

  if(list.length === 0){
    el.innerHTML = `<div class="empty">${emptyLead} <button type="button" data-action="open-habit" data-type="${addType}">${emptyRest}</button></div>`;
    return;
  }

  const today = todayKey();
  el.innerHTML = list.map(h => {
    const confirmedStreak = activeStreakDisplay(h);   // streak already locked in, for the badge count
    const upcomingStreak = projectedStreak(h);         // what tapping now would make it — for the payout
    const todaysCount = entries.filter(e => e.date === today && (e.habitId ? e.habitId === h.id : (e.name === h.name && e.type === h.type))).length;
    let sub = '';
    if(type === 'good'){
      if(confirmedStreak >= 2){
        const mult = streakMultiplier(upcomingStreak).toFixed(2);
        sub = `🔥 ${confirmedStreak}-day streak · ×${mult}`;
      }
      if(todaysCount > 0) sub += (sub ? ' · ' : '') + `${todaysCount}× today`;
    } else {
      if(todaysCount > 0) sub = `${todaysCount}× today`;
    }

    const mult = type === 'good' ? streakMultiplier(upcomingStreak) : 1;
    const displayPts = type === 'good' ? Math.max(1, Math.round(h.points * mult)) : h.points;
    const sign = type === 'good' ? '+' : '−';
    const pillClass = type === 'good' ? '' : 'loss';

    return `
      <div class="row">
        <button type="button" class="row-main" style="background:none;border:none;text-align:left;padding:0;color:inherit" data-action="log-habit" data-id="${escapeHtml(h.id)}">
          <div class="row-name">${escapeHtml(h.name)}</div>
          ${sub ? `<div class="row-sub mono">${sub}</div>` : ''}
        </button>
        <button type="button" class="pill ${pillClass} mono" data-action="log-habit" data-id="${escapeHtml(h.id)}">${sign}${displayPts}</button>
        <button type="button" class="edit-btn" data-action="open-habit" data-type="${type}" data-id="${escapeHtml(h.id)}" aria-label="Edit ${escapeHtml(h.name)}">✎</button>
      </div>`;
  }).join('');
}

function renderBonusList(){
  const el = document.getElementById('bonusList');
  if(bonusTasks.length === 0){
    el.innerHTML = `<div class="empty">No bonus entries yet — <button type="button" data-action="open-bonus">add a one-off you want to reward.</button></div>`;
    return;
  }
  const today = todayKey();
  el.innerHTML = bonusTasks.map(b => {
    const todaysCount = entries.filter(e => e.date === today && (e.bonusId ? e.bonusId === b.id : (e.name === b.name && e.type === 'bonus'))).length;
    return `
      <div class="row">
        <button type="button" class="row-main" style="background:none;border:none;text-align:left;padding:0;color:inherit" data-action="log-bonus" data-id="${escapeHtml(b.id)}">
          <div class="row-name">✦ ${escapeHtml(b.name)}</div>
          ${todaysCount > 0 ? `<div class="row-sub mono">${todaysCount}× today</div>` : ''}
        </button>
        <button type="button" class="pill bonus mono" data-action="log-bonus" data-id="${escapeHtml(b.id)}">+${b.points}</button>
        <button type="button" class="edit-btn" data-action="open-bonus" data-id="${escapeHtml(b.id)}" aria-label="Edit ${escapeHtml(b.name)}">✎</button>
      </div>`;
  }).join('');
}

function renderMilestoneList(){
  const el = document.getElementById('milestoneList');
  if(!el) return;
  if(milestones.length === 0){
    el.innerHTML = `<div class="empty">No automatic milestones yet — <button type="button" data-action="open-milestone">add your first streak reward.</button></div>`;
    return;
  }
  const sorted = milestones.slice().sort((a, b) => a.days - b.days || a.name.localeCompare(b.name));
  el.innerHTML = sorted.map(milestone => `
    <div class="row">
      <div class="row-main">
        <div class="row-name">${escapeHtml(milestone.name)}</div>
        <div class="milestone-meta mono">Day ${milestone.days} · +${milestone.points}</div>
        ${milestone.description ? `<div class="row-sub">${escapeHtml(milestone.description)}</div>` : ''}
      </div>
      <button type="button" class="edit-btn" data-action="open-milestone" data-id="${escapeHtml(milestone.id)}" aria-label="Edit ${escapeHtml(milestone.name)}">✎</button>
    </div>`).join('');
}

function renderRangeButtons(){
  const wrap = document.getElementById('rangeSelect');
  const opts = [7, 14, 30, 90, 'all'];
  wrap.innerHTML = opts.map(value =>
    `<button type="button" class="${value === historyRangeDays ? 'active' : ''}" data-action="set-range" data-days="${value}">${value === 'all' ? 'ALL' : `${value}D`}</button>`
  ).join('');
}

function renderDateJump(){
  const input = document.getElementById('historyDateInput');
  if(!input) return;
  input.min = statsStartKey();
  input.max = todayKey();
  if(!isValidDateKey(input.value) || input.value < input.min || input.value > input.max){
    input.value = todayKey();
  }
}
function jumpToExactDate(){
  const input = document.getElementById('historyDateInput');
  const status = document.getElementById('dateJumpStatus');
  const date = input.value;
  status.textContent = '';
  if(!isValidDateKey(date) || date < statsStartKey() || date > todayKey()){
    status.textContent = `Choose a date from ${statsStartKey()} through ${todayKey()}.`;
    input.focus();
    return;
  }
  openDayActivity(date);
}
function setHistoryRange(value){
  const range = value === 'all' ? 'all' : Number(value);
  if(![7,14,30,90,'all'].includes(range)) return;
  historyRangeDays = range;
  persistSettings();
  renderHistory();
}

function historyDaysForRange(){
  const today = todayKey();
  const desiredStart = historyRangeDays === 'all'
    ? statsStartKey()
    : addDaysToKey(today, -(Number(historyRangeDays) - 1));
  const start = laterDateKey(statsStartKey(), desiredStart);
  const rangeDays = calendarDaysInclusive(start, today);
  const days = [];
  for(let i = rangeDays - 1; i >= 0; i--) days.push(addDaysToKey(today, -i));
  return days;
}

function averageScoreWindow(dayCount, byDate, end = todayKey()){
  const start = laterDateKey(statsStartKey(), addDaysToKey(end, -(dayCount - 1)));
  const calendarDays = calendarDaysInclusive(start, end);
  const tracked = trackedDateKeys(end).filter(date => date >= start);
  if(tracked.length === 0) return { average:null, tracked:0, calendarDays };
  const total = tracked.reduce((sum, date) => sum + dailyBase + (byDate[date] || 0), 0);
  return { average:total / tracked.length, tracked:tracked.length, calendarDays };
}
function averageScoreForDays(dayCount, byDate, end = todayKey()){
  return averageScoreWindow(dayCount, byDate, end).average;
}
function averageForLastTrackedDays(dayCount, byDate, end = todayKey()){
  const tracked = trackedDateKeys(end).slice(-dayCount);
  if(tracked.length === 0) return null;
  return tracked.reduce((sum, date) => sum + dailyBase + (byDate[date] || 0), 0) / tracked.length;
}

function renderHistoryAverages(byDate){
  const el = document.getElementById('historyAverages');
  const allDays = calendarDaysInclusive(statsStartKey(), todayKey());
  const values = [
    [averageScoreWindow(7, byDate), '7-day average'],
    [averageScoreWindow(30, byDate), '30-day average'],
    [averageScoreWindow(allDays, byDate), 'Since-start average']
  ];
  el.innerHTML = `<div class="metric-group-label">Current averages</div><div class="average-grid">${values.map(([window,label]) =>
    `<div class="average-tile"><div class="average-value mono">${window.average === null ? '—' : Math.round(window.average)}</div><div class="average-label">${label}</div><div class="average-coverage">${window.tracked}/${window.calendarDays} tracked</div></div>`
  ).join('')}</div><div class="average-note">Unknown days are excluded. Each average uses only tracked days inside its calendar window, starting no earlier than ${new Date(statsStartKey() + 'T12:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })}.</div>`;
}

function chartStepForDeviation(maxDeviation){
  const target = Math.max(5, maxDeviation / 2);
  const magnitude = Math.pow(10, Math.floor(Math.log10(target)));
  const normalized = target / magnitude;
  const factor = [1,2,2.5,3,5,10].find(x => x >= normalized) || 10;
  return factor * magnitude;
}

function renderHistory(){
  renderRangeButtons();
  renderDateJump();
  const el = document.getElementById('historyChart');
  const manualByDate = manualDailyTotalsByDate();
  const byDate = dailyTotalsByDate();
  renderHistoryAverages(byDate);

  const days = historyDaysForRange();
  if(!selectedHistoryDate || !days.includes(selectedHistoryDate)){
    selectedHistoryDate = days[days.length - 1];
  }
  const tracked = days.map(d => isDayTracked(d));
  const scores = days.map((d, index) => tracked[index] ? dailyBase + (byDate[d] || 0) : null);
  // Single sliding-window pass over the tracked sequence. Calling
  // averageForLastTrackedDays() once per rendered day re-scanned every entry each
  // time, which made renderAll() O(days x entries) and froze the UI on wide ranges.
  const trackedSeq = trackedDateKeys();
  const rollingByDate = Object.create(null);
  let rollSum = 0;
  for(let i = 0; i < trackedSeq.length; i++){
    rollSum += dailyBase + (byDate[trackedSeq[i]] || 0);
    if(i >= 7) rollSum -= dailyBase + (byDate[trackedSeq[i - 7]] || 0);
    rollingByDate[trackedSeq[i]] = rollSum / Math.min(i + 1, 7);
  }
  const rolling = days.map((d, index) =>
    tracked[index] && rollingByDate[d] !== undefined ? rollingByDate[d] : null);
  const showAverage = historyRangeDays === 'all' || Number(historyRangeDays) >= 14;
  const deviations = [...scores, ...(showAverage ? rolling : [])]
    .filter(value => value !== null)
    .map(v => Math.abs(v - dailyBase));
  const step = chartStepForDeviation(Math.max(10, ...deviations));
  const yMin = dailyBase - step * 2;
  const yMax = dailyBase + step * 2;

  const W = 360, H = 210, left = 38, right = 8, top = 9, bottom = 25;
  const plotW = W - left - right;
  const plotH = H - top - bottom;
  const xFor = i => days.length === 1 ? left + plotW / 2 : left + (i / (days.length - 1)) * plotW;
  const yFor = value => top + ((yMax - value) / (yMax - yMin)) * plotH;
  const pathForObserved = values => {
    let started = false;
    return values.map((value, i) => {
      if(value === null){
        started = false;
        return '';
      }
      const command = started ? 'L' : 'M';
      started = true;
      return `${command}${xFor(i).toFixed(2)},${yFor(value).toFixed(2)}`;
    }).filter(Boolean).join(' ');
  };
  const pathAcrossUnknownGaps = values => {
    const segments = [];
    let previousObservedIndex = null;
    let crossedUnknown = false;
    values.forEach((value, i) => {
      if(value === null){
        if(previousObservedIndex !== null) crossedUnknown = true;
        return;
      }
      if(previousObservedIndex !== null && crossedUnknown){
        segments.push(
          `M${xFor(previousObservedIndex).toFixed(2)},${yFor(values[previousObservedIndex]).toFixed(2)}` +
          ` L${xFor(i).toFixed(2)},${yFor(value).toFixed(2)}`
        );
      }
      previousObservedIndex = i;
      crossedUnknown = false;
    });
    return segments.join(' ');
  };
  const scoreGapPath = pathAcrossUnknownGaps(scores);
  const averageGapPath = showAverage ? pathAcrossUnknownGaps(rolling) : '';

  const yTicks = [yMin, dailyBase - step, dailyBase, dailyBase + step, yMax];
  const yGrid = yTicks.map(value => {
    const y = yFor(value);
    const baseline = value === dailyBase;
    return `<line class="${baseline ? 'chart-baseline' : 'chart-grid'}" x1="${left}" y1="${y}" x2="${W - right}" y2="${y}"></line>
      <text class="chart-axis-label${baseline ? ' baseline' : ''}" x="${left - 5}" y="${y + 3}" text-anchor="end">${Math.round(value)}</text>`;
  }).join('');

  const xLabelCount = Math.min(5, days.length);
  const labelIndexes = [...new Set(Array.from({ length:xLabelCount }, (_, i) => Math.round(i * (days.length - 1) / Math.max(1, xLabelCount - 1))))];
  const xLabels = labelIndexes.map(i => {
    const date = new Date(days[i] + 'T12:00:00');
    const label = days.length > 180
      ? date.toLocaleDateString('en-US', { month:'short', year:'2-digit' })
      : date.toLocaleDateString('en-US', { month:'numeric', day:'numeric' });
    return `<text class="chart-axis-label" x="${xFor(i)}" y="${H - 7}" text-anchor="${i === 0 ? 'start' : i === days.length - 1 ? 'end' : 'middle'}">${label}</text>`;
  }).join('');

  const markers = days.map((d, i) => {
    if(!tracked[i]) return '';
    const score = scores[i];
    const success = dailyBase + (manualByDate[d] || 0) >= successThreshold;
    const dateLabel = new Date(d + 'T12:00:00').toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' });
    const hitWidth = Math.max(8, plotW / Math.max(1, days.length - 1));
    return `<rect class="chart-hit" x="${xFor(i) - hitWidth / 2}" y="${top}" width="${hitWidth}" height="${plotH}" data-action="open-day" data-date="${d}" role="button" tabindex="0" aria-label="${dateLabel}: score ${Math.round(score)}. Open activity."></rect>
      <circle class="chart-dot${success ? ' success' : ''}" cx="${xFor(i)}" cy="${yFor(score)}" r="${days.length > 90 ? 2.2 : 3.2}" pointer-events="none"></circle>`;
  }).join('');
  const selectedIndex = Math.max(0, days.indexOf(selectedHistoryDate));
  const selectedScore = scores[selectedIndex];
  const selectedTracked = tracked[selectedIndex];
  const selectedDateLabel = new Date(selectedHistoryDate + 'T12:00:00').toLocaleDateString('en-US', {
    weekday:'short', month:'short', day:'numeric', year:'numeric'
  });
  const selection = `<line class="chart-selected-guide" x1="${xFor(selectedIndex)}" y1="${top}" x2="${xFor(selectedIndex)}" y2="${top + plotH}"></line>
    ${selectedTracked ? `<circle class="chart-selected-dot" cx="${xFor(selectedIndex)}" cy="${yFor(selectedScore)}" r="4.2"></circle>` : ''}`;

  el.innerHTML = `<svg class="line-chart" viewBox="0 0 ${W} ${H}" role="group" aria-label="Tracked daily score history since ${statsStartKey()}. Unknown days are omitted.">
    ${yGrid}
    ${xLabels}
    <path class="chart-score-line" d="${pathForObserved(scores)}"></path>
    ${scoreGapPath ? `<path class="chart-score-gap" d="${scoreGapPath}"></path>` : ''}
    ${showAverage ? `<path class="chart-average-line" d="${pathForObserved(rolling)}"></path>` : ''}
    ${averageGapPath ? `<path class="chart-average-gap" d="${averageGapPath}"></path>` : ''}
    ${selection}
    ${markers}
  </svg>
  <div class="chart-selection-readout" role="status" aria-live="polite">
    <span>${selectedDateLabel}${selectedTracked ? '' : ' · Untracked'}</span>
    <strong class="mono">${selectedTracked ? Math.round(selectedScore) : '—'}</strong>
  </div>
  <div class="chart-legend">
    <span class="legend-item"><span class="legend-swatch"></span>Daily score</span>
    ${showAverage ? `<span class="legend-item"><span class="legend-swatch average"></span>7 tracked-day moving average</span>` : ''}
    ${scoreGapPath ? `<span class="legend-item"><span class="legend-swatch gap"></span>Unknown gap</span>` : ''}
    <span class="legend-item"><span class="legend-swatch baseline"></span>Baseline</span>
  </div>`;

  let successCount = 0, trackedCount = 0;
  days.forEach((d, i) => {
    if(!tracked[i]) return;
    trackedCount++;
    if(dailyBase + (manualByDate[d] || 0) >= successThreshold) successCount++;
  });
  document.getElementById('historyRateEl').textContent =
    trackedCount > 0 ? `${successCount}/${trackedCount} success` : '';
}

/* ================= past-day activity ================= */
function openDayActivity(dateKey){
  if(!isValidDateKey(dateKey) || dateKey < statsStartKey() || dateKey > todayKey()) return;
  selectedDayKey = dateKey;
  selectedHistoryDate = dateKey;
  renderHistory();
  renderDayActivity();
  openDialog('dayOverlay');
}

function closeDayActivity(){
  closeDialog('dayOverlay');
  selectedDayKey = null;
}

function trackedDatesInWindow(){
  return trackedDateKeys();
}

function navigateDay(offset){
  if(!selectedDayKey) return;
  const target = addDaysToKey(selectedDayKey, Number(offset));
  if(target < statsStartKey() || target > todayKey()) return;
  selectedDayKey = target;
  selectedHistoryDate = target;
  renderHistory();
  renderDayActivity();
}

function navigateTrackedDay(direction){
  if(!selectedDayKey) return;
  const trackedDates = trackedDatesInWindow();
  const target = Number(direction) < 0
    ? trackedDates.filter(date => date < selectedDayKey).pop()
    : trackedDates.find(date => date > selectedDayKey);
  if(!target) return;
  selectedDayKey = target;
  selectedHistoryDate = target;
  renderHistory();
  renderDayActivity();
}

function renderDayActivity(){
  if(!selectedDayKey) return;
  const date = new Date(selectedDayKey + 'T12:00:00');
  const dayEntries = allActivityEntries(selectedDayKey)
    .filter(e => e.date === selectedDayKey)
    .slice()
    .sort((a, b) => b.ts - a.ts);
  const net = dayEntries.reduce((sum, entry) => sum + (Number(entry.points) || 0), 0);
  const score = dailyBase + net;
  const tracked = isDayTracked(selectedDayKey);
  const dateLabel = date.toLocaleDateString('en-US', {
    weekday:'long', month:'long', day:'numeric', year:'numeric'
  });
  const netLabel = net > 0 ? `+${net}` : String(net);

  document.getElementById('dayModalTitle').textContent = dateLabel;
  document.getElementById('daySummary').innerHTML = tracked
    ? `<strong class="mono">${score}</strong> score &nbsp;·&nbsp; <span class="mono">${netLabel}</span> net &nbsp;·&nbsp; ${dayEntries.length} item${dayEntries.length === 1 ? '' : 's'}`
    : `<strong>Untracked</strong> &nbsp;·&nbsp; no score or statistics recorded`;

  document.getElementById('previousDayBtn').disabled = selectedDayKey <= statsStartKey();
  document.getElementById('nextDayBtn').disabled = selectedDayKey >= todayKey();
  const trackedDates = trackedDatesInWindow();
  document.getElementById('previousTrackedBtn').disabled = !trackedDates.some(day => day < selectedDayKey);
  document.getElementById('nextTrackedBtn').disabled = !trackedDates.some(day => day > selectedDayKey);
  renderCompletionControl(selectedDayKey, 'dayCompletionControl');

  const list = document.getElementById('dayActivityList');
  if(!dayEntries.length){
    list.innerHTML = tracked
      ? `<div class="empty">No activity recorded. This completed day is tracked at baseline ${dailyBase}.</div>`
      : `<div class="empty">No activity recorded. This day is unknown and excluded from averages, trends, and streak progress.</div>`;
    return;
  }

  const typeLabels = { good:'Credit', bad:'Debit', bonus:'Bonus' };
  list.innerHTML = dayEntries.map(entry => {
    const points = Number(entry.points) || 0;
    const sign = points > 0 ? '+' : '';
    const tone = entry.type === 'bonus' ? 'bonus' : (points < 0 ? 'loss' : '');
    const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    const typeLabel = entry.derived ? 'Automatic milestone' : typeLabels[entry.type];
    return `<div class="row">
      <div class="row-main">
        <div class="row-name">${escapeHtml(entry.name)}</div>
        <span class="entry-type-badge">${typeLabel} · ${time}</span>
        ${entry.derived && entry.description ? `<span class="row-sub">${escapeHtml(entry.description)}</span>` : ''}
      </div>
      <span class="pill ${tone} mono" style="pointer-events:none">${sign}${points}</span>
      ${entry.derived ? '' : `<div class="day-actions">
        <button type="button" data-action="open-entry" data-id="${escapeHtml(entry.id)}" aria-label="Edit ${escapeHtml(entry.name)}">✎</button>
        <button type="button" class="danger" data-action="delete-history-entry" data-id="${escapeHtml(entry.id)}" aria-label="Delete ${escapeHtml(entry.name)}">✕</button>
      </div>`}
    </div>`;
  }).join('');
}

// An entry may legitimately already sit before the statistics start date (an older
// backup, or the start date was moved forward later). Its own date is therefore the
// floor if that is earlier than the start date — but it must never be moved further
// back, because days before the start date cannot be opened from the UI at all.
function entryDateFloor(entry){
  const start = statsStartKey();
  return entry && isValidDateKey(entry.date) && entry.date < start ? entry.date : start;
}

function openEntryModal(entryId){
  const entry = entries.find(e => e.id === entryId);
  if(!entry) return;
  editingEntryId = entry.id;
  entryModalMode = 'edit';
  clearFieldError('entryError');
  document.getElementById('entryModalTitle').textContent = 'Edit logged entry';
  const dateInput = document.getElementById('entryDateInput');
  dateInput.min = entryDateFloor(entry);
  dateInput.max = todayKey();
  dateInput.value = entry.date;
  document.getElementById('entryNameInput').value = entry.name;
  document.getElementById('entryTypeInput').value = entry.type;
  document.getElementById('entryPointsInput').value = Math.abs(Number(entry.points) || 0);
  openDialog('entryOverlay', 'entryDateInput');
}

// Retroactive logging: add a brand-new entry to a chosen past (or current) day. Reuses
// the same entry modal in "create" mode. New entries are standalone records; if a good
// entry's name matches exactly one credit habit, recomputeHabitStreak picks it up and
// rebuilds that habit's streak from scratch — so filling a past gap correctly extends
// or restarts the streak with no special-casing.
function openNewEntryModal(dateKey){
  const target = isValidDateKey(dateKey) ? dateKey : todayKey();
  if(target < statsStartKey() || target > todayKey()) return;
  editingEntryId = null;
  entryModalMode = 'create';
  clearFieldError('entryError');
  document.getElementById('entryModalTitle').textContent = 'Add entry';
  const dateInput = document.getElementById('entryDateInput');
  dateInput.min = statsStartKey();
  dateInput.max = todayKey();
  dateInput.value = target;
  document.getElementById('entryNameInput').value = '';
  document.getElementById('entryTypeInput').value = 'good';
  document.getElementById('entryPointsInput').value = '';
  openDialog('entryOverlay', 'entryNameInput');
}

function closeEntryModal(){
  closeDialog('entryOverlay');
  editingEntryId = null;
  entryModalMode = 'edit';
}

function linkedGoodHabit(entry){
  if(!entry || entry.type !== 'good') return null;
  if(entry.habitId) return habits.find(h => h.id === entry.habitId && h.type === 'good') || null;
  const matches = habits.filter(h => h.type === 'good' && h.name === entry.name);
  return matches.length === 1 ? matches[0] : null;
}

function saveEditedEntry(){
  const date = document.getElementById('entryDateInput').value;
  const name = document.getElementById('entryNameInput').value.trim();
  const type = document.getElementById('entryTypeInput').value;
  const pointsRaw = document.getElementById('entryPointsInput').value.trim();
  const pointsMagnitude = Number(pointsRaw);
  clearFieldError('entryError');

  // Shared validation for both modes.
  if(!isValidDateKey(date) || date > todayKey()){
    return showFieldError('entryError', 'Choose a valid ledger date no later than today.', 'entryDateInput');
  }
  if(!name) return showFieldError('entryError', 'Enter a name.', 'entryNameInput');
  if(name.length > 60) return showFieldError('entryError', 'Keep the name to 60 characters or fewer.', 'entryNameInput');
  if(!['good','bad','bonus'].includes(type)){
    return showFieldError('entryError', 'Choose credit, debit, or bonus.', 'entryTypeInput');
  }
  if(!pointsRaw || !Number.isInteger(pointsMagnitude) || pointsMagnitude < 0 || pointsMagnitude > 9999){
    return showFieldError('entryError', 'Points must be a whole number from 0 to 9999.', 'entryPointsInput');
  }
  const signedPoints = type === 'bad' ? -pointsMagnitude : pointsMagnitude;

  if(entryModalMode === 'create'){
    if(date < statsStartKey()){
      return showFieldError('entryError', 'That day is before your statistics start date. Move the start date back first if you want to log it.', 'entryDateInput');
    }
    // Put "now" on entries added to today so they sort naturally with live logs;
    // for a past day, noon keeps them mid-day among any real timestamps.
    const ts = date === todayKey() ? Date.now() : new Date(`${date}T12:00:00`).getTime();
    const entry = { id: uid(), date, name, type, points: signedPoints, ts };
    entries.push(entry);
    // Standalone record, matching type-changed edits. If the name matches exactly one
    // credit habit, recomputeHabitStreak attributes it and rebuilds that streak.
    const habit = linkedGoodHabit(entry);
    if(habit) recomputeHabitStreak(habit);
    persistData();
    selectedDayKey = date;
    selectedHistoryDate = date;
    closeEntryModal();
    renderAll();
    if(document.getElementById('dayOverlay').classList.contains('show')) renderDayActivity();
    return;
  }

  const entry = entries.find(e => e.id === editingEntryId);
  if(!entry) return showFieldError('entryError', 'This entry no longer exists. Close and try again.');
  if(date < entryDateFloor(entry)){
    return showFieldError('entryError', 'That day is before your statistics start date, where the entry could no longer be opened or edited. Move the start date back first if you want it there.', 'entryDateInput');
  }

  const oldEntry = { ...entry };
  const oldHabit = linkedGoodHabit(oldEntry);
  entry.date = date;
  entry.name = name;
  entry.type = type;
  entry.points = signedPoints;

  // Keep a source link only when the edited entry remains the same kind of item.
  // Changing its type makes it a standalone historical record rather than silently
  // assigning it to a habit or bonus task that merely has a matching name.
  if(type === 'good'){
    delete entry.bonusId;
    const linked = entry.habitId && habits.find(h => h.id === entry.habitId && h.type === 'good');
    if(oldEntry.type !== 'good' || !linked) delete entry.habitId;
  } else if(type === 'bonus'){
    delete entry.habitId;
    const linked = entry.bonusId && bonusTasks.find(b => b.id === entry.bonusId);
    if(oldEntry.type !== 'bonus' || !linked) delete entry.bonusId;
  } else {
    delete entry.habitId;
    delete entry.bonusId;
  }

  const newHabit = linkedGoodHabit(entry);
  if(oldHabit) recomputeHabitStreak(oldHabit);
  if(newHabit && newHabit !== oldHabit) recomputeHabitStreak(newHabit);

  persistData();
  selectedDayKey = date;
  closeEntryModal();
  renderAll();
  renderDayActivity();
}

async function deleteHistoricalEntry(entryId){
  const entry = entries.find(e => e.id === entryId);
  if(!entry) return;
  const ok = await showConfirm(`Delete “${entry.name}” from this day?`, 'Delete entry');
  if(!ok) return;
  deleteEntry(entryId, true);
  renderDayActivity();
}

// Groups all entries by date once, since every stat below is derived from daily totals.
// Number(e.points) guards against a hand-edited restore backup with a non-numeric or
// missing points field — without it, "0 + a string" silently string-concatenates
// instead of adding, quietly corrupting every score, streak, and trend derived from it.
function dailyTotalsByDate(end = todayKey()){
  const start = statsStartKey();
  const byDate = Object.create(null);
  for(const e of allActivityEntries(end)){
    if(e.date < start || e.date > end) continue;
    byDate[e.date] = (byDate[e.date] || 0) + (Number(e.points) || 0);
  }
  return byDate;
}

function computeStats(){
  const manualByDate = manualDailyTotalsByDate();
  const byDate = dailyTotalsByDate();
  const dates = trackedDateKeys();
  const daysTracked = dates.length;

  if(daysTracked === 0){
    return { daysTracked: 0 };
  }

  let successCount = 0, run = 0, bestStreak = 0;
  let bestDayScore = -Infinity, bestDayDate = dates[0];
  for(const d of dates){
    // Success streaks count consecutive successful tracked days, matching milestone
    // awards. Unknown calendar days are absent from `dates`, so they pause the run.
    // Only a tracked unsuccessful day resets it.
    const score = dailyBase + (byDate[d] || 0);
    const success = dailyBase + (manualByDate[d] || 0) >= successThreshold;
    if(success){
      successCount++;
      run++;
      bestStreak = Math.max(bestStreak, run);
    }else{
      run = 0;
    }
    if(score > bestDayScore){ bestDayScore = score; bestDayDate = d; }
  }
  const successRate = Math.round((successCount / daysTracked) * 100);
  // Unknown days pause the streak indefinitely until another tracked day either
  // advances it or resets it, so the run through the most recent tracked day remains
  // the current streak.
  const currentStreak = run;

  // Top contributors by total points, in either direction — the direct answer to
  // "what's actually moving the needle." Gains pool credits and bonuses together
  // (both add points); drains are debits only (the only source of negative points).
  // Number(e.points) guards the same malformed-backup case as dailyTotalsByDate().
  function topContributors(types){
    const totals = {};
    for(const e of allActivityEntries()){
      if(!isInStatsWindow(e.date) || !types.includes(e.type)) continue;
      if(!totals[e.name]) totals[e.name] = { name: e.name, points: 0, count: 0 };
      totals[e.name].points += Number(e.points) || 0;
      totals[e.name].count += 1;
    }
    return Object.values(totals);
  }
  const biggestGains = topContributors(['good', 'bonus']).sort((a, b) => b.points - a.points).slice(0, 3);
  const biggestDrains = topContributors(['bad']).sort((a, b) => a.points - b.points).slice(0, 3);

  return {
    daysTracked, successRate, currentStreak, bestStreak,
    bestDay: { date: bestDayDate, score: bestDayScore },
    biggestGains, biggestDrains
  };
}

function renderStats(){
  const el = document.getElementById('statsGrid');
  const s = computeStats();

  if(s.daysTracked === 0){
    el.innerHTML = `<div class="stat-tile wide"><div class="stat-value">—</div><div class="stat-label">Log activity or mark a day complete to start stats</div></div>`;
    document.getElementById('topContributors').innerHTML = '';
    return;
  }

  const bestDayLabel = new Date(s.bestDay.date + 'T00:00:00').toLocaleDateString('en-US', { month:'short', day:'numeric' });

  const singles = [
    [s.daysTracked, 'Days tracked'],
    [s.successRate + '%', 'Success rate since start'],
    [(s.currentStreak > 0 ? '🔥 ' : '') + s.currentStreak, 'Current success streak'],
    [s.bestStreak, 'Best success streak'],
  ];

  let html = singles.map(([value, label]) => `
    <div class="stat-tile">
      <div class="stat-value">${value}</div>
      <div class="stat-label">${label}</div>
    </div>`).join('');

  html += `
    <div class="stat-tile wide">
      <div class="stat-value">${s.bestDay.score}</div>
      <div class="stat-label">Best day · ${bestDayLabel}</div>
    </div>`;

  el.innerHTML = html;

  document.getElementById('topContributors').innerHTML =
    renderRankBlock('Biggest gains', s.biggestGains, 'gain') +
    renderRankBlock('Biggest drains', s.biggestDrains, 'loss');
}

// Renders a top-3 ranked list for either gains or drains. Each row shows the plain
// instance count (no "×") and the total points that habit/bonus is responsible for.
function renderRankBlock(title, list, tone){
  if(!list || list.length === 0) return '';
  const rows = list.map((item, i) => `
    <div class="rank-row">
      <span class="rank-rank">${i + 1}</span>
      <span class="rank-name">${escapeHtml(item.name)}</span>
      <span class="rank-figures mono">
        <span class="rank-count">${item.count}</span>
        <span class="rank-total ${tone}-tone">${item.points > 0 ? '+' : ''}${item.points}</span>
      </span>
    </div>`).join('');
  return `
    <div class="rank-block">
      <div class="rank-head">
        <span class="rank-title ${tone}-tone">${title}</span>
        <span class="rank-collabels">Logged&nbsp;&nbsp;&nbsp;Total</span>
      </div>
      ${rows}
    </div>`;
}

function escapeHtml(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

/* ================= trends ================= */
const TREND_EARLY_DAYS = 7;
const PACE_WINDOW_DAYS = 14; // "current pace" = average net over the latest N tracked days

function computeTrends(){
  const byDate = dailyTotalsByDate();
  const dates = trackedDateKeys();
  const daysTracked = dates.length;
  if(daysTracked === 0) return { ready: false, daysTracked };

  // Weekday averages use only known, tracked days. Unknown dates do not imply
  // baseline performance and therefore neither help nor hurt a weekday.
  const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dowTotals = Array(7).fill(0);
  const dowCounts = Array(7).fill(0);
  const today = todayKey();
  const observationDays = daysTracked;
  const observationSpanDays = calendarDaysInclusive(statsStartKey(), today);
  for(const date of dates){
    const dow = new Date(date + 'T12:00:00').getDay();
    dowTotals[dow] += dailyBase + (byDate[date] || 0);
    dowCounts[dow] += 1;
  }
  const dowAverages = dowTotals.map((t, i) => dowCounts[i] > 0 ? t / dowCounts[i] : null);

  let bestDow = null, worstDow = null;
  for(let i = 0; i < 7; i++){
    if(dowAverages[i] === null) continue;
    if(bestDow === null || dowAverages[i] > dowAverages[bestDow]) bestDow = i;
    if(worstDow === null || dowAverages[i] < dowAverages[worstDow]) worstDow = i;
  }

  // Pace uses the latest tracked observations so forgotten/unknown dates pause it.
  const paceDates = dates.slice(-PACE_WINDOW_DAYS);
  const paceDays = paceDates.length;
  const paceSum = paceDates.reduce((sum, date) => sum + (byDate[date] || 0), 0);
  const avgDailyNet = paceDays > 0 ? paceSum / paceDays : 0;

  const allTimeNet = dates.reduce((sum, date) => sum + (byDate[date] || 0), 0);
  const endOfYearKey = `${today.slice(0, 4)}-12-31`;
  const daysUntilEndOfYear = Math.max(0, calendarDaysInclusive(today, endOfYearKey) - 1);
  const observedScoreTotal = dates.reduce((sum, date) => sum + dailyBase + (byDate[date] || 0), 0);
  const recentPaceScore = dailyBase + avgDailyNet;
  const projectedAverage = futureDays => {
    const projectedDays = Math.max(0, Number(futureDays) || 0);
    return (observedScoreTotal + recentPaceScore * projectedDays) / (observationDays + projectedDays);
  };

  return {
    ready: true, early: daysTracked < TREND_EARLY_DAYS, daysTracked, observationDays, observationSpanDays,
    dowNames, dowAverages, bestDow, worstDow,
    avgDailyNet, recentPaceScore, paceDays,
    projections: {
      d30: projectedAverage(30),
      d90: projectedAverage(90),
      eoy: projectedAverage(daysUntilEndOfYear),
      d30Net: allTimeNet + avgDailyNet * 30,
      d90Net: allTimeNet + avgDailyNet * 90,
      eoyNet: allTimeNet + avgDailyNet * daysUntilEndOfYear,
      daysUntilEndOfYear
    }
  };
}

function renderTrends(){
  const el = document.getElementById('trendsBody');
  const t = computeTrends();

  if(!t.ready){
    el.innerHTML = `<div class="empty">Log activity or mark a day complete and trends will begin immediately.</div>`;
    return;
  }

  const dayNamesFull = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const daysWithData = t.dowAverages.filter(a => a !== null).length;

  let summary = '';
  if(daysWithData === 1){
    const only = t.dowAverages.findIndex(a => a !== null);
    summary = `<div class="dow-summary">Only enough history for ${dayNamesFull[only]} so far — log a few more weeks for a full comparison.</div>`;
  } else if(t.bestDow === t.worstDow){
    // Multiple weekdays tracked, but they all average out the same — a real tie,
    // not a data-sparsity issue, so it gets its own message rather than picking
    // an arbitrary "best."
    summary = `<div class="dow-summary">Every day performs about the same so far (avg ${Math.round(t.dowAverages[t.bestDow])}).</div>`;
  } else {
    summary = `<div class="dow-summary">Best day: <span class="gain-tone">${dayNamesFull[t.bestDow]}</span> (avg ${Math.round(t.dowAverages[t.bestDow])}) &nbsp;·&nbsp; Worst day: <span class="loss-tone">${dayNamesFull[t.worstDow]}</span> (avg ${Math.round(t.dowAverages[t.worstDow])})</div>`;
  }

  const maxAbsNet = Math.max(1, ...t.dowAverages.map(a => a === null ? 0 : Math.abs(a - dailyBase)));
  const rows = [0,1,2,3,4,5,6].map(i => {
    const avg = t.dowAverages[i];
    if(avg === null){
      return `
        <div class="dow-row">
          <div class="dow-label">${t.dowNames[i]}</div>
          <div class="dow-track"></div>
          <div class="dow-empty">—</div>
        </div>`;
    }
    const net = avg - dailyBase;
    const tone = net > 0 ? 'gain' : net < 0 ? 'loss' : 'even';
    const widthPct = Math.min(50, Math.abs(net) / maxAbsNet * 50);
    const rowClass = i === t.bestDow ? 'best' : (i === t.worstDow ? 'worst' : '');
    return `
      <div class="dow-row ${rowClass}">
        <div class="dow-label">${t.dowNames[i]}</div>
        <div class="dow-track"><div class="dow-bar ${tone}" style="width:${widthPct}%"></div></div>
        <div class="dow-value mono">${Math.round(avg)}</div>
      </div>`;
  }).join('');

  const sign = v => v > 0 ? '+' : '';
  const paceTone = t.recentPaceScore > dailyBase ? 'gain-tone' : t.recentPaceScore < dailyBase ? 'loss-tone' : '';
  const projectionTone = value => value > dailyBase ? 'gain-tone' : value < dailyBase ? 'loss-tone' : '';
  const netTone = value => value > 0 ? 'gain-tone' : value < 0 ? 'loss-tone' : '';
  const formatNet = value => `${sign(value)}${Math.round(value)}`;
  const p = t.projections;

  el.innerHTML = `
    ${t.early ? `<div class="trend-note">Early trend · based on ${t.daysTracked} tracked day${t.daysTracked === 1 ? '' : 's'} across a ${t.observationSpanDays}-day calendar span since your start date. Unknown days are excluded. This will settle as more activity is recorded.</div>` : ''}
    ${summary}
    <div class="dow-list">${rows}</div>
    <div class="metric-group-label">Future forecast</div>
    <div class="pace-line">${t.early ? 'Early forecast' : 'Current forecast'} — your recent pace is <span class="mono ${paceTone}">${t.recentPaceScore.toFixed(1)} points/day</span> (${sign(t.avgDailyNet)}${t.avgDailyNet.toFixed(1)} from baseline) over the last ${t.paceDays} tracked day${t.paceDays === 1 ? '' : 's'}. If that continues, your cumulative daily average is projected to be:</div>
    <div class="stats-grid forecast-grid">
      <div class="stat-tile projection-card">
        <div class="forecast-horizon">In 30 days</div>
        <div class="stat-value mono ${projectionTone(p.d30)}">${p.d30.toFixed(1)}</div>
        <div class="stat-label">Projected average</div>
        <div class="projection-total"><span>Net total</span><strong class="mono ${netTone(p.d30Net)}">${formatNet(p.d30Net)}</strong></div>
      </div>
      <div class="stat-tile projection-card">
        <div class="forecast-horizon">In 90 days</div>
        <div class="stat-value mono ${projectionTone(p.d90)}">${p.d90.toFixed(1)}</div>
        <div class="stat-label">Projected average</div>
        <div class="projection-total"><span>Net total</span><strong class="mono ${netTone(p.d90Net)}">${formatNet(p.d90Net)}</strong></div>
      </div>
      <div class="stat-tile wide projection-card">
        <div class="forecast-horizon">By December 31</div>
        <div class="stat-value mono ${projectionTone(p.eoy)}">${p.eoy.toFixed(1)}</div>
        <div class="stat-label">Projected average · ${p.daysUntilEndOfYear === 0 ? 'Today' : `${p.daysUntilEndOfYear} days out`}</div>
        <div class="projection-total"><span>Net total</span><strong class="mono ${netTone(p.eoyNet)}">${formatNet(p.eoyNet)}</strong></div>
      </div>
    </div>
    <div class="projection-note">Forecast combines your actual tracked-day average with your recent tracked-day pace for future days. Unknown historical days stay excluded; automatic milestone rewards already earned are included like bonus entries.</div>`;
}

/* ================= undo toast ================= */
let undoToastTimer = null;
let undoCallback = null;
function showUndoToast(entry){
  const sign = entry.points > 0 ? '+' : '';
  showUndoAction(`${sign}${entry.points} · ${entry.name}`, () => deleteEntry(entry.id, false));
}
function showUndoAction(message, callback){
  document.getElementById('undoToastText').textContent = message;
  const toast = document.getElementById('undoToast');
  undoCallback = callback;
  toast.classList.add('show');
  clearTimeout(undoToastTimer);
  undoToastTimer = setTimeout(() => {
    toast.classList.remove('show');
    undoCallback = null;
  }, 5000);
}
function undoFromToast(){
  const toast = document.getElementById('undoToast');
  toast.classList.remove('show');
  clearTimeout(undoToastTimer);
  const callback = undoCallback;
  undoCallback = null;
  if(callback) callback();
}

/* ================= today's activity ================= */
let activityLogOpen = false;
function toggleActivityLog(){
  activityLogOpen = !activityLogOpen;
  renderActivityLog();
}
function renderActivityLog(){
  const today = todayKey();
  const todays = allActivityEntries(today).filter(e => e.date === today).slice().sort((a, b) => b.ts - a.ts);

  document.getElementById('activityToggleBtn').textContent =
    (activityLogOpen ? 'Hide' : 'Show') + ` (${todays.length})`;

  const el = document.getElementById('activityLog');
  el.style.display = activityLogOpen ? 'block' : 'none';
  if(!activityLogOpen) return;

  if(todays.length === 0){
    el.innerHTML = `<div class="empty">Nothing logged yet today.</div>`;
    return;
  }

  el.innerHTML = todays.map(e => {
    const time = new Date(e.ts).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const points = Number(e.points) || 0;
    const sign = points > 0 ? '+' : '';
    const tone = e.type === 'bonus' ? 'bonus' : (points > 0 ? '' : 'loss');
    return `
      <div class="row">
        <div class="row-main">
          <div class="row-name">${escapeHtml(e.name)}</div>
          <div class="row-sub mono">${e.derived ? `Automatic milestone · ${time}` : time}</div>
        </div>
        <span class="pill ${tone} mono" style="pointer-events:none;">${sign}${points}</span>
        ${e.derived ? '' : `<button type="button" class="edit-btn" data-action="remove-entry" data-id="${escapeHtml(e.id)}" aria-label="Remove ${escapeHtml(e.name)} from today's log">✕</button>`}
      </div>`;
  }).join('');
}

/* ================= interaction wiring ================= */
document.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if(!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  switch(action){
    case 'switch-view': switchView(target.dataset.view); break;
    case 'toggle-activity': toggleActivityLog(); break;
    case 'open-habit': openHabitModal(target.dataset.type || 'good', id); break;
    case 'close-habit': closeHabitModal(); break;
    case 'set-habit-type': setHabitType(target.dataset.type); break;
    case 'save-habit': saveHabit(); break;
    case 'delete-habit': deleteHabitConfirm(); break;
    case 'log-habit': logHabit(id); break;
    case 'open-bonus': openBonusModal(id); break;
    case 'close-bonus': closeBonusModal(); break;
    case 'save-bonus': saveBonus(); break;
    case 'delete-bonus': deleteBonusConfirm(); break;
    case 'log-bonus': logBonus(id); break;
    case 'toggle-day-complete': toggleDayCompletion(target.dataset.date); break;
    case 'open-milestone': openMilestoneModal(id); break;
    case 'close-milestone': closeMilestoneModal(); break;
    case 'save-milestone': saveMilestone(); break;
    case 'delete-milestone': deleteMilestoneConfirm(); break;
    case 'open-settings': openSettings(); break;
    case 'close-settings': closeSettings(); break;
    case 'save-settings': saveSettings(); break;
    case 'open-backup': openBackup(); break;
    case 'close-backup': closeBackup(); break;
    case 'download-backup': downloadBackup(); break;
    case 'share-backup': shareBackup(); break;
    case 'export-files': exportToFiles(); break;
    case 'merge': doMergeJson(); break;
    case 'merge-csv': doMergeCsv(); break;
    case 'reminder-backup': openBackup(); break;
    case 'reminder-dismiss': dismissReminder(); break;
    case 'dismiss-storage-banner': dismissStorageBanner(); break;
    case 'download-csv': downloadCsv(); break;
    case 'download-csv-backup': downloadCsvBackup(); break;
    case 'run-storage-check': runStorageHealthCheck(); break;
    case 'sync-now': syncCloudNow(); break;
    case 'open-account': window.location.assign('/account'); break;
    case 'sign-out-clear': signOutAndClearDevice(); break;
    case 'restore': doRestore(); break;
    case 'restore-csv': doCsvRestore(); break;
    case 'clear-ledger': clearLedgerData(); break;
    case 'reset-settings': resetSettings(); break;
    case 'confirm-no': resolveConfirm(false); break;
    case 'confirm-yes': resolveConfirm(true); break;
    case 'undo': undoFromToast(); break;
    case 'remove-entry': deleteEntry(id, true); break;
    case 'set-range': setHistoryRange(target.dataset.days); break;
    case 'jump-date': jumpToExactDate(); break;
    case 'open-day': openDayActivity(target.dataset.date); break;
    case 'close-day': closeDayActivity(); break;
    case 'navigate-day': navigateDay(target.dataset.offset); break;
    case 'navigate-tracked': navigateTrackedDay(target.dataset.direction); break;
    case 'open-entry': openEntryModal(id); break;
    case 'add-day-entry': openNewEntryModal(selectedDayKey || todayKey()); break;
    case 'close-entry': closeEntryModal(); break;
    case 'save-entry': saveEditedEntry(); break;
    case 'delete-history-entry': deleteHistoricalEntry(id); break;
  }
});

document.getElementById('backupText').addEventListener('click', event => event.currentTarget.select());
document.getElementById('restoreFileInput').addEventListener('change', async event => {
  const file = event.target.files && event.target.files[0];
  if(!file) return;
  if(file.size > 10 * 1024 * 1024){
    setBackupStatus('That file is too large to be a Tally backup.', 'error');
    return;
  }
  try{
    const text = await file.text();
    const clean = validateBackupObject(JSON.parse(text));
    document.getElementById('restoreText').value = text;
    setBackupStatus(`Ready to restore ${backupContentsLabel(clean)}.`, 'success');
  }catch(e){
    document.getElementById('restoreText').value = '';
    setBackupStatus(`Backup not accepted: ${e.message}`, 'error');
  }
});
document.getElementById('csvRestoreFileInput').addEventListener('change', async event => {
  const file = event.target.files && event.target.files[0];
  pendingCsvBackupText = null;
  setCsvButtonsDisabled(true);
  if(!file) return;
  if(file.size > 10 * 1024 * 1024){
    setBackupStatus('That CSV file is too large to be a Tally backup.', 'error');
    event.target.value = '';
    return;
  }
  try{
    const text = await file.text();
    const clean = parseFullCsvBackup(text);
    pendingCsvBackupText = text;
    setCsvButtonsDisabled(false);
    setBackupStatus(`CSV ready to restore ${backupContentsLabel(clean)}.`, 'success');
  }catch(e){
    event.target.value = '';
    setBackupStatus(`CSV backup not accepted: ${e.message}`, 'error');
  }
});
['habitName','habitPoints'].forEach(id => document.getElementById(id).addEventListener('input', () => clearFieldError('habitError')));
['bonusName','bonusPoints'].forEach(id => document.getElementById(id).addEventListener('input', () => clearFieldError('bonusError')));
['milestoneName','milestoneDays','milestonePoints','milestoneDescription'].forEach(id =>
  document.getElementById(id).addEventListener('input', () => clearFieldError('milestoneError'))
);
['baseInput','thresholdInput','dayStartInput','startDateInput'].forEach(id => document.getElementById(id).addEventListener('input', () => clearFieldError('settingsError')));
['entryDateInput','entryNameInput','entryTypeInput','entryPointsInput'].forEach(id =>
  document.getElementById(id).addEventListener('input', () => clearFieldError('entryError'))
);
document.getElementById('historyDateInput').addEventListener('input', () => {
  document.getElementById('dateJumpStatus').textContent = '';
});
document.getElementById('historyDateInput').addEventListener('keydown', event => {
  if(event.key === 'Enter'){
    event.preventDefault();
    jumpToExactDate();
  }
});
document.getElementById('dayOverlay').addEventListener('click', event => {
  if(event.target === event.currentTarget) closeDayActivity();
});

document.addEventListener('keydown', event => {
  const visible = visibleDialogLayers();
  const top = visible[visible.length - 1];
  if(!top && (event.key === 'Enter' || event.key === ' ')){
    const active = document.activeElement;
    if(active && active.dataset && active.dataset.action === 'open-day'){
      event.preventDefault();
      openDayActivity(active.dataset.date);
    }
  }
  if(!top) return;
  if(event.key === 'Escape'){
    event.preventDefault();
    if(top.id === 'confirmOverlay') resolveConfirm(false);
    else if(top.id === 'habitOverlay') closeHabitModal();
    else if(top.id === 'bonusOverlay') closeBonusModal();
    else if(top.id === 'milestoneOverlay') closeMilestoneModal();
    else if(top.id === 'settingsOverlay') closeSettings();
    else if(top.id === 'backupOverlay') closeBackup();
    else if(top.id === 'entryOverlay') closeEntryModal();
    else if(top.id === 'dayOverlay') closeDayActivity();
    return;
  }
  if(event.key === 'Tab'){
    const focusables = [...top.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      .filter(el => el.offsetParent !== null);
    if(!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if(event.shiftKey && document.activeElement === first){ event.preventDefault(); last.focus(); }
    else if(!event.shiftKey && document.activeElement === last){ event.preventDefault(); first.focus(); }
  }
});

/* ================= boot ================= */
initDayStartOptions();
// Computed once immediately (using default settings, since real ones haven't loaded
// yet) and then resynced once loadAll() finishes — otherwise, if your saved
// dayStartHour differs from the default, this could briefly hold a value computed
// against the wrong boundary.
let lastKnownDay = todayKey();
loadAll().then(() => { lastKnownDay = todayKey(); });

// The ledger day is only ever computed at render time (there's no stored "current day").
// These just make sure a render actually happens when it rolls over, covering the case
// where the app is left open and awake across the day-start boundary.
function refreshIfNewDay(){
  const now = todayKey();
  if(now !== lastKnownDay){
    lastKnownDay = now;
    renderAll();
  }
}
function refreshCloudIfStale(){
  if(!appReady || !navigator.onLine || Date.now() - lastCloudRefreshAt < 30000) return;
  syncCloudNow();
}
document.addEventListener('visibilitychange', () => {
  if(!document.hidden){
    refreshIfNewDay();
    refreshCloudIfStale();
  }
});
window.addEventListener('focus', () => {
  refreshIfNewDay();
  refreshCloudIfStale();
});
window.addEventListener('pageshow', () => {
  refreshIfNewDay();
  refreshCloudIfStale();
});
window.addEventListener('online', async () => {
  if(!appReady) return;
  if(!cloudEnabled && !await verifyCloudAccess()) return;
  syncCloudNow();
});
window.addEventListener('offline', () => {
  setCloudStatus('offline', 'Changes stay in the on-device database and are queued until reconnection.');
});
window.addEventListener('pagehide', () => writeEmergencyMirror(buildSnapshot()));
document.addEventListener('visibilitychange', () => {
  if(document.hidden) writeEmergencyMirror(buildSnapshot());
});
setInterval(refreshIfNewDay, 60000);

if('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')){
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

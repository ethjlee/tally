import { addDaysToKey } from "./calendar.js";
import { pauseOn, statsStartKey, todayKey } from "./days.js";
import { ledgerState } from "../state.js";

export function completedDayId(date){
  return `day_${String(date).replace(/-/g, '')}`;
}
export function explicitCompletionForDate(date){
  return ledgerState.completedDays.find(day => day.date === date) || null;
}
export function dayHasManualActivity(date){
  return ledgerState.entries.some(entry => entry.date === date);
}
export function isDayTracked(date){
  return !pauseOn(date) && (dayHasManualActivity(date) || !!explicitCompletionForDate(date) || hasDailyBonusForDate(date));
}
export function hasDailyBonusForDate(date){
  return ledgerState.dailyBonuses.length > 0 && !pauseOn(date) && date >= statsStartKey() && date < todayKey() &&
    !ledgerState.entries.some(entry => entry.date === date && entry.type === 'bad');
}
function dailyBonusDateKeys(end = todayKey()){
  if(!ledgerState.dailyBonuses.length) return [];
  const lastDay = closedDayEnd(end);
  const debitDates = new Set(ledgerState.entries.filter(entry => entry.type === 'bad').map(entry => entry.date));
  const dates = [];
  for(let date = statsStartKey(); date <= lastDay; date = addDaysToKey(date, 1)){
    if(!pauseOn(date) && !debitDates.has(date)) dates.push(date);
  }
  return dates;
}
// Dates in `entries`/`completedDays` are already validated on load, so the window
// test is a plain string comparison here. Resolving statsStartKey() once per call
// (instead of once per item, inside isInStatsWindow) removes millions of Date
// allocations from the render path on multi-year ledgers.
export function trackedDateKeys(end = todayKey(), bonusDates = dailyBonusDateKeys(end), manualDates = null){
  const start = statsStartKey();
  const dates = new Set(bonusDates);
  if(manualDates){
    for(const date of manualDates) dates.add(date);
  }else{
    for(const entry of ledgerState.entries){
      if(entry.date >= start && entry.date <= end) dates.add(entry.date);
    }
  }
  for(const day of ledgerState.completedDays){
    if(day.date >= start && day.date <= end) dates.add(day.date);
  }
  return [...dates].filter(date => !pauseOn(date)).sort();
}
function manualDailyTotalsByDate(end = todayKey()){
  const start = statsStartKey();
  const byDate = Object.create(null);
  for(const entry of ledgerState.entries){
    if(entry.date < start || entry.date > end || pauseOn(entry.date)) continue;
    byDate[entry.date] = (byDate[entry.date] || 0) + (Number(entry.points) || 0);
  }
  return byDate;
}
function milestoneAwardId(milestone, date){
  return `milestone_${milestone.id}_${String(date).replace(/-/g, '')}`;
}
function closedDayEnd(end){
  const yesterday = addDaysToKey(todayKey(), -1);
  return end < yesterday ? end : yesterday;
}
function automaticAwardTimestamp(date){
  const boundary = new Date(`${addDaysToKey(date, 1)}T00:00:00`);
  boundary.setHours(ledgerState.dayStartHour, 0, 0, 0);
  return Math.max(0, boundary.getTime());
}
// Derive awards from source records so reopening, backfilling, and concurrent
// devices produce exactly one award per rule/day, without a background server job.
function dailyBonusEntriesForDate(date){
  const ts = automaticAwardTimestamp(date);
  const dateSuffix = date.replace(/-/g, '');
  return ledgerState.dailyBonuses.map(bonus => ({
    id:`daily_bonus_${bonus.id}_${dateSuffix}`,
    date, name:bonus.name, type:'bonus', points:bonus.points,
    ts, dailyBonusId:bonus.id, description:bonus.description, derived:true
  }));
}
function deriveDailyBonusEntries(end = todayKey()){
  return dailyBonusDateKeys(end).flatMap(dailyBonusEntriesForDate);
}
export function automaticEntryLabel(entry){
  return entry.dailyBonusId ? 'Automatic daily bonus' : 'Automatic milestone';
}

// Milestone awards are derived instead of stored as mutable entries. That makes
// retroactive definition/threshold edits deterministic and prevents duplicate
// awards when two copies of Tally are open. Success uses the baseline and manual
// totals; automatic reward points never contribute to success qualification.
//
// A milestone streak counts consecutive successful TRACKED days. Untracked calendar
// days are unknown and therefore pause the streak: they neither advance it nor reset
// it. Only a tracked day below the success threshold resets the streak.
function milestoneAwardsByDate(trackedDates, manualTotals, end){
  const awards = new Map();
  if(!ledgerState.milestones.length) return awards;
  const lastDay = closedDayEnd(end);
  const orderedMilestones = ledgerState.milestones.slice().sort((a, b) =>
    a.days - b.days || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  );
  const milestonesByTarget = new Map();
  for(const milestone of orderedMilestones){
    if(!milestonesByTarget.has(milestone.days)) milestonesByTarget.set(milestone.days, []);
    milestonesByTarget.get(milestone.days).push(milestone);
  }
  let successStreak = 0;
  for(const date of trackedDates){
    if(date > lastDay) break;
    const scoreBeforeAwards = ledgerState.dailyBase + (manualTotals[date] || 0);
    if(scoreBeforeAwards < ledgerState.successThreshold){
      successStreak = 0;
      continue;
    }
    successStreak++;
    const earned = milestonesByTarget.get(successStreak);
    if(earned) awards.set(date, earned);
  }
  return awards;
}
function milestoneEntriesForDate(date, earned){
  if(!earned) return [];
  const ts = automaticAwardTimestamp(date);
  return earned.map((milestone, index) => ({
    id:milestoneAwardId(milestone, date),
    date, name:milestone.name, type:'bonus', points:milestone.points,
    ts:ts + index, milestoneId:milestone.id, description:milestone.description, derived:true
  }));
}
function deriveMilestoneEntries(end = todayKey()){
  if(!ledgerState.milestones.length) return [];
  const awards = milestoneAwardsByDate(trackedDateKeys(end), manualDailyTotalsByDate(end), end);
  return [...awards].flatMap(([date, earned]) => milestoneEntriesForDate(date, earned));
}
export function allActivityEntries(end = todayKey()){
  return [...ledgerState.entries, ...deriveDailyBonusEntries(end), ...deriveMilestoneEntries(end)];
}

// Keep one set of totals per render. A no-debit day earns every daily rule,
// so adding their combined points once per date gives the same ledger total.
export function summarizeLedger(end = todayKey()){
  const manualByDate = manualDailyTotalsByDate(end);
  const bonusDates = new Set(dailyBonusDateKeys(end));
  const dates = trackedDateKeys(end, bonusDates, Object.keys(manualByDate));
  const milestoneAwards = milestoneAwardsByDate(dates, manualByDate, end);
  const byDate = Object.assign(Object.create(null), manualByDate);
  const dailyBonusPoints = ledgerState.dailyBonuses.reduce((sum, bonus) => sum + bonus.points, 0);
  for(const date of bonusDates) byDate[date] = (byDate[date] || 0) + dailyBonusPoints;
  for(const [date, earned] of milestoneAwards){
    byDate[date] = earned.reduce((sum, milestone) => sum + milestone.points, byDate[date] || 0);
  }
  return { end, manualByDate, byDate, dates, bonusDates, milestoneAwards };
}

export function hasAnyLedgerData(){
  return ledgerState.travelPauses.length || ledgerState.entries.length || ledgerState.habits.length || ledgerState.bonusTasks.length || ledgerState.dailyBonuses.length || ledgerState.taskSections.length || ledgerState.milestones.length || ledgerState.completedDays.length;
}
export function activityEntriesForDate(date, ledger, manualEntries = ledgerState.entries.filter(entry => entry.date === date)){
  return [
    ...manualEntries,
    ...(ledger.bonusDates.has(date) ? dailyBonusEntriesForDate(date) : []),
    ...milestoneEntriesForDate(date, ledger.milestoneAwards.get(date))
  ];
}

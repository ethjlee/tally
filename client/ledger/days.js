import { addDaysToKey, calendarDaysInclusive, laterDateKey, ledgerDateKeyForHour } from "./calendar.js";
import { isValidDateKey } from "../../shared/ledger-contract.ts";
import { ledgerState } from "../state.js";

export let pauseIntervals = [];
export function todayKey(d = new Date()){
  return ledgerDateKeyForHour(ledgerState.dayStartHour, d);
}
export function statsStartKey(){
  const today = todayKey();
  return isValidDateKey(ledgerState.trackingStartDate) && ledgerState.trackingStartDate <= today ? ledgerState.trackingStartDate : today;
}
export function isInStatsWindow(date, end = todayKey()){
  return isValidDateKey(date) && date >= statsStartKey() && date <= end;
}
export function inferredStartDate(candidateEntries, hour = ledgerState.dayStartHour){
  const end = ledgerDateKeyForHour(hour);
  const dates = candidateEntries.map(entry => entry.date).filter(date => isValidDateKey(date) && date <= end).sort();
  return dates[0] || end;
}
// Keep editable trips by ID, and merge their coverage for fast score lookups.
export function setTravelPauses(pauses){
  ledgerState.travelPauses = pauses;
  pauseIntervals = [];
  for(const pause of pauses.slice().sort((a,b) => a.start.localeCompare(b.start))){
    const last = pauseIntervals[pauseIntervals.length - 1];
    const end = pause.end || '9999-12-31';
    if(last && last.end >= pause.start){
      if(last.end < end) last.end = end;
    }else pauseIntervals.push({ start:pause.start, end });
  }
}
export function pauseOn(date){
  let lo = 0, hi = pauseIntervals.length;
  while(lo < hi){
    const mid = (lo + hi) >>> 1;
    const range = pauseIntervals[mid];
    if(date < range.start) hi = mid;
    else if(date > range.end) lo = mid + 1;
    else return range;
  }
  return null;
}
export function countingDaysBetween(start, end){
  let count = calendarDaysInclusive(start, end);
  for(const range of pauseIntervals){
    if(range.start > end) break;
    count -= calendarDaysInclusive(laterDateKey(start, range.start), end < range.end ? end : range.end);
  }
  return count;
}
export function consecutiveHabitDays(dates, lastDate){
  let length = 0;
  let date = lastDate;
  while(date && dates?.size){
    const pause = pauseOn(date);
    if(pause) date = addDaysToKey(pause.start, -1);
    else if(dates.has(date)){
      length++;
      date = addDaysToKey(date, -1);
    }else break;
  }
  return length;
}

export function timestampForLedgerDate(date){
  if(date === todayKey()) return Date.now();
  const noon = new Date(`${date}T12:00:00`).getTime();
  const sameDayCount = ledgerState.entries.filter(entry => entry.date === date).length;
  // The saved timestamp has a zero floor. The ledger date still records the chosen day.
  return Math.max(0, noon) + sameDayCount;
}

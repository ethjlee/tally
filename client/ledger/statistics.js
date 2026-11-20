import { addDaysToKey, calendarDaysInclusive, laterDateKey } from "./calendar.js";
import { countingDaysBetween, pauseOn, statsStartKey, todayKey } from "./days.js";
import { summarizeLedger, trackedDateKeys } from "./scoring.js";
import { ledgerState } from "../state.js";

export function averageScoreWindow(dayCount, byDate, end = todayKey(), dates = trackedDateKeys(end)){
  const start = laterDateKey(statsStartKey(), addDaysToKey(end, -(dayCount - 1)));
  const calendarDays = countingDaysBetween(start, end);
  const tracked = dates.filter(date => date >= start);
  if(tracked.length === 0) return { average:null, tracked:0, calendarDays };
  const total = tracked.reduce((sum, date) => sum + ledgerState.dailyBase + (byDate[date] || 0), 0);
  return { average:total / tracked.length, tracked:tracked.length, calendarDays };
}
function averageScoreForDays(dayCount, byDate, end = todayKey()){
  return averageScoreWindow(dayCount, byDate, end).average;
}
function averageForLastTrackedDays(dayCount, byDate, end = todayKey()){
  const tracked = trackedDateKeys(end).slice(-dayCount);
  if(tracked.length === 0) return null;
  return tracked.reduce((sum, date) => sum + ledgerState.dailyBase + (byDate[date] || 0), 0) / tracked.length;
}

function dailyTotalsByDate(end = todayKey()){
  return summarizeLedger(end).byDate;
}

export function computeStats(ledger = summarizeLedger()){
  const { manualByDate, byDate, dates, end, bonusDates, milestoneAwards } = ledger;
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
    const score = ledgerState.dailyBase + (byDate[d] || 0);
    const success = ledgerState.dailyBase + (manualByDate[d] || 0) >= ledgerState.successThreshold;
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

  const gains = new Map();
  const drains = new Map();
  function addContribution(totals, name, points, count = 1){
    if(!totals.has(name)) totals.set(name, { name, points:0, count:0 });
    const total = totals.get(name);
    total.points += points;
    total.count += count;
  }
  const start = statsStartKey();
  for(const entry of ledgerState.entries){
    if(entry.date < start || entry.date > end || pauseOn(entry.date)) continue;
    addContribution(entry.type === 'bad' ? drains : gains, entry.name, Number(entry.points) || 0);
  }
  if(bonusDates.size){
    for(const bonus of ledgerState.dailyBonuses){
      addContribution(gains, bonus.name, bonus.points * bonusDates.size, bonusDates.size);
    }
  }
  for(const earned of milestoneAwards.values()){
    for(const milestone of earned){
      addContribution(gains, milestone.name, milestone.points);
    }
  }
  const biggestGains = [...gains.values()].sort((a, b) => b.points - a.points).slice(0, 3);
  const biggestDrains = [...drains.values()].sort((a, b) => a.points - b.points).slice(0, 3);

  return {
    daysTracked, successRate, currentStreak, bestStreak,
    bestDay: { date: bestDayDate, score: bestDayScore },
    biggestGains, biggestDrains
  };
}

const TREND_EARLY_DAYS = 7;
const PACE_WINDOW_DAYS = 14; // "current pace" = average net over the latest N tracked days

export function computeTrends(ledger = summarizeLedger()){
  const { byDate, dates, end:today } = ledger;
  const daysTracked = dates.length;
  if(daysTracked === 0) return { ready: false, daysTracked };

  // Weekday averages use only known, tracked days. Unknown dates do not imply
  // baseline performance and therefore neither help nor hurt a weekday.
  const dowNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const dowTotals = Array(7).fill(0);
  const dowCounts = Array(7).fill(0);
  const observationDays = daysTracked;
  const observationSpanDays = calendarDaysInclusive(statsStartKey(), today);
  for(const date of dates){
    const dow = new Date(date + 'T12:00:00').getDay();
    dowTotals[dow] += ledgerState.dailyBase + (byDate[date] || 0);
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
  const observedScoreTotal = dates.reduce((sum, date) => sum + ledgerState.dailyBase + (byDate[date] || 0), 0);
  const recentPaceScore = ledgerState.dailyBase + avgDailyNet;
  const futureCountingDays = days => countingDaysBetween(addDaysToKey(today, 1), addDaysToKey(today, days));
  const monthDays = futureCountingDays(30);
  const quarterDays = futureCountingDays(90);
  const yearDays = futureCountingDays(daysUntilEndOfYear);
  const projectedAverage = futureDays => {
    const projectedDays = Math.max(0, Number(futureDays) || 0);
    return (observedScoreTotal + recentPaceScore * projectedDays) / (observationDays + projectedDays);
  };

  return {
    ready: true, early: daysTracked < TREND_EARLY_DAYS, daysTracked, observationDays, observationSpanDays,
    dowNames, dowAverages, bestDow, worstDow,
    avgDailyNet, recentPaceScore, paceDays,
    projections: {
      d30: projectedAverage(monthDays),
      d90: projectedAverage(quarterDays),
      eoy: projectedAverage(yearDays),
      d30Net: allTimeNet + avgDailyNet * monthDays,
      d90Net: allTimeNet + avgDailyNet * quarterDays,
      eoyNet: allTimeNet + avgDailyNet * yearDays,
      daysUntilEndOfYear
    }
  };
}

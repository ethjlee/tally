import { addDaysToKey } from "../ledger/calendar.js";
import { isValidDateKey } from "../../shared/ledger-contract.ts";
import { pauseOn, statsStartKey, todayKey } from "../ledger/days.js";
import {
  activityEntriesForDate,
  automaticEntryLabel,
  dayHasManualActivity,
  explicitCompletionForDate,
  hasDailyBonusForDate,
  isDayTracked,
  summarizeLedger
} from "../ledger/scoring.js";
import { ledgerState, viewState } from "../state.js";
import { escapeHtml } from "./dom.js";
import { renderAll } from "./render.js";

export function activeLedgerDate(){
  const start = statsStartKey();
  const end = todayKey();
  if(!isValidDateKey(viewState.todayViewDate)) viewState.todayViewDate = end;
  else if(viewState.todayViewDate < start) viewState.todayViewDate = start;
  else if(viewState.todayViewDate > end) viewState.todayViewDate = end;
  return viewState.todayViewDate;
}
function ledgerDateCaption(date){
  if(date === todayKey()) return 'Today';
  if(date === addDaysToKey(todayKey(), -1)) return 'Yesterday';
  return new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
    weekday:'short', month:'short', day:'numeric'
  });
}
export function renderTodayNavigator(){
  const date = activeLedgerDate();
  const input = document.getElementById('todayDateInput');
  input.min = statsStartKey();
  input.max = todayKey();
  input.value = date;
  document.getElementById('todayDateCaption').textContent = ledgerDateCaption(date);
  document.getElementById('todayPrevBtn').disabled = date <= statsStartKey();
  document.getElementById('todayNextBtn').disabled = date >= todayKey();
  document.getElementById('returnTodayBtn').disabled = date === todayKey();
  document.getElementById('activitySectionTitle').textContent =
    date === todayKey()
      ? "Today's activity"
      : (date === addDaysToKey(todayKey(), -1) ? "Yesterday's activity" : `${ledgerDateCaption(date)} activity`);
}
export function navigateToday(rawOffset){
  const target = addDaysToKey(activeLedgerDate(), Number(rawOffset) < 0 ? -1 : 1);
  if(target < statsStartKey() || target > todayKey()) return;
  viewState.todayViewDate = target;
  renderAll();
}
export function setTodayViewDate(date){
  if(!isValidDateKey(date) || date < statsStartKey() || date > todayKey()){
    renderTodayNavigator();
    return;
  }
  viewState.todayViewDate = date;
  renderAll();
}
export function returnToToday(){
  viewState.todayViewDate = todayKey();
  renderAll();
}

export function renderCompletionControl(date, elementId){
  const el = document.getElementById(elementId);
  if(!el) return;
  if(pauseOn(date)){
    const editButton = document.getElementById('travelOverlay')
      ? `<button type="button" class="completion-button" data-action="open-travel" data-date="${date}">Edit pause</button>`
      : '';
    el.innerHTML = `<div class="completion-card"><span class="completion-copy"><span class="completion-title">Paused · Travel mode</span>
      <span class="completion-sub">Entries are saved. Points and streaks skip this day.</span></span>${editButton}</div>`;
    return;
  }
  const explicit = explicitCompletionForDate(date);
  const hasActivity = dayHasManualActivity(date);
  if(explicit){
    el.innerHTML = `<div class="completion-card tracked">
      <span class="completion-copy">
        <span class="completion-title">✓ Day marked complete</span>
        <span class="completion-sub">${hasActivity ? 'Activity also keeps this day tracked.' : (hasDailyBonusForDate(date) ? 'An automatic daily bonus also keeps this day tracked.' : `Tracked at the ${ledgerState.dailyBase} baseline with no manual activity.`)}</span>
      </span>
      <button type="button" class="completion-button undo" data-action="toggle-day-complete" data-date="${date}">Undo</button>
    </div>`;
  }else if(hasActivity || hasDailyBonusForDate(date)){
    el.innerHTML = `<div class="completion-card tracked">
      <span class="completion-copy">
        <span class="completion-title">✓ Tracked from ${hasActivity ? 'activity' : 'automatic daily bonus'}</span>
        <span class="completion-sub">${hasActivity ? 'No separate completion tap is needed for this day.' : 'No debits recorded. Adding a debit removes the daily bonus.'}</span>
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

export function renderHeader(didLog, ledger = summarizeLedger()){
  // Label the ledger day itself (which may still be "yesterday" until 7am), not
  // whatever the calendar says right now — otherwise the header could say Tuesday
  // while the score underneath is still Monday's, until the 7am rollover catches up.
  const shownDate = viewState.activeView === 'today' ? activeLedgerDate() : todayKey();
  const ledgerDate = new Date(shownDate + 'T00:00:00');
  document.getElementById('dateLabel').textContent =
    ledgerDate.toLocaleDateString('en-US', { weekday:'short', month:'short', day:'numeric' }).toUpperCase();

  const net = ledger.byDate[shownDate] || 0;
  const manualNet = ledger.manualByDate[shownDate] || 0;
  const score = ledgerState.dailyBase + net;
  const qualifyingScore = ledgerState.dailyBase + manualNet;
  const allTime = Object.values(ledger.byDate).reduce((sum, points) => sum + points, 0);

  const scoreEl = document.getElementById('scoreEl');
  const statusEl = document.getElementById('statusEl');
  const tone = net > 0 ? 'gain' : net < 0 ? 'loss' : 'even';

  const paused = !!pauseOn(shownDate);
  scoreEl.textContent = paused ? '—' : score;
  scoreEl.className = 'score tabular mono ' + tone;
  const periodLabel = shownDate === todayKey() ? 'today' : 'on this day';
  statusEl.textContent = paused ? 'Travel mode' : net > 0 ? `▲ +${net} ${periodLabel}` : net < 0 ? `▼ ${net} ${periodLabel}` : `— even ${periodLabel}`;
  statusEl.className = 'status-label ' + tone;

  document.getElementById('allTimeEl').textContent = (allTime > 0 ? '+' : '') + allTime;

  const successEl = document.getElementById('successTagEl');
  const dayTracked = isDayTracked(shownDate);
  if(!dayTracked){
    successEl.textContent = paused ? 'Paused · streak held' : 'Untracked · log activity or mark complete';
    successEl.className = 'success-tag';
  }else if(qualifyingScore >= ledgerState.successThreshold){
    successEl.textContent = `✓ Success day (≥${ledgerState.successThreshold})`;
    successEl.className = 'success-tag success';
  } else {
    successEl.textContent = `${ledgerState.successThreshold - qualifyingScore} to go for a success day`;
    successEl.className = 'success-tag';
  }
  const progress = paused ? 0 : ledgerState.successThreshold <= 0 ? 100 : Math.max(0, Math.min(100, Math.round((qualifyingScore / ledgerState.successThreshold) * 100)));
  document.getElementById('thresholdProgressEl').style.width = `${progress}%`;

  if(didLog){
    scoreEl.classList.remove('pulse');
    void scoreEl.offsetWidth;
    scoreEl.classList.add('pulse');
  }
}

let activityLogOpen = false;
export function toggleActivityLog(){
  activityLogOpen = !activityLogOpen;
  renderActivityLog();
}
export function renderActivityLog(ledger = summarizeLedger()){
  const date = activeLedgerDate();
  const manualEntries = ledgerState.entries.filter(entry => entry.date === date);
  const bonusCount = ledger.bonusDates.has(date) ? ledgerState.dailyBonuses.length : 0;
  const milestoneCount = ledger.milestoneAwards.get(date)?.length || 0;

  document.getElementById('activityToggleBtn').textContent =
    (activityLogOpen ? 'Hide' : 'Show') + ` (${manualEntries.length + bonusCount + milestoneCount})`;

  const el = document.getElementById('activityLog');
  el.style.display = activityLogOpen ? 'block' : 'none';
  if(!activityLogOpen) return;

  const todays = activityEntriesForDate(date, ledger, manualEntries).sort((a, b) => b.ts - a.ts);
  if(todays.length === 0){
    el.innerHTML = `<div class="empty">Nothing logged ${date === todayKey() ? 'yet today' : `on ${ledgerDateCaption(date)}`}.</div>`;
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
          <div class="row-sub mono">${e.derived ? `${automaticEntryLabel(e)} · ${time}` : time}${pauseOn(date) ? ' · Excluded' : ''}</div>
        </div>
        <span class="pill ${tone} mono" style="pointer-events:none;">${sign}${points}</span>
        ${e.derived ? '' : `<button type="button" class="edit-btn" data-action="remove-entry" data-id="${escapeHtml(e.id)}" aria-label="Remove ${escapeHtml(e.name)} from ${date}">✕</button>`}
      </div>`;
  }).join('');
}

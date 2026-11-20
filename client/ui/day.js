import { addDaysToKey } from "../ledger/calendar.js";
import { isValidDateKey } from "../../shared/ledger-contract.ts";
import { pauseOn, statsStartKey, todayKey } from "../ledger/days.js";
import {
  activityEntriesForDate,
  automaticEntryLabel,
  isDayTracked,
  summarizeLedger,
  trackedDateKeys
} from "../ledger/scoring.js";
import { ledgerState, viewState } from "../state.js";
import { closeDialog, openDialog } from "./dialog.js";
import { escapeHtml } from "./dom.js";
import { renderHistory } from "./history.js";
import { renderCompletionControl } from "./today.js";

export function openDayActivity(dateKey){
  if(!isValidDateKey(dateKey) || dateKey < statsStartKey() || dateKey > todayKey()) return;
  viewState.selectedDayKey = dateKey;
  viewState.selectedHistoryDate = dateKey;
  renderHistory();
  renderDayActivity();
  openDialog('dayOverlay');
}

export function closeDayActivity(){
  closeDialog('dayOverlay');
  viewState.selectedDayKey = null;
}

function trackedDatesInWindow(){
  return trackedDateKeys();
}

export function navigateDay(offset){
  if(!viewState.selectedDayKey) return;
  const target = addDaysToKey(viewState.selectedDayKey, Number(offset));
  if(target < statsStartKey() || target > todayKey()) return;
  viewState.selectedDayKey = target;
  viewState.selectedHistoryDate = target;
  renderHistory();
  renderDayActivity();
}

export function navigateTrackedDay(direction){
  if(!viewState.selectedDayKey) return;
  const trackedDates = trackedDatesInWindow();
  const target = Number(direction) < 0
    ? trackedDates.filter(date => date < viewState.selectedDayKey).pop()
    : trackedDates.find(date => date > viewState.selectedDayKey);
  if(!target) return;
  viewState.selectedDayKey = target;
  viewState.selectedHistoryDate = target;
  renderHistory();
  renderDayActivity();
}

export function renderDayActivity(ledger = summarizeLedger()){
  if(!viewState.selectedDayKey) return;
  const date = new Date(viewState.selectedDayKey + 'T12:00:00');
  const dayEntries = activityEntriesForDate(viewState.selectedDayKey, ledger)
    .sort((a, b) => b.ts - a.ts);
  const net = dayEntries.reduce((sum, entry) => sum + (Number(entry.points) || 0), 0);
  const score = ledgerState.dailyBase + net;
  const tracked = isDayTracked(viewState.selectedDayKey);
  const dateLabel = date.toLocaleDateString('en-US', {
    weekday:'long', month:'long', day:'numeric', year:'numeric'
  });
  const netLabel = net > 0 ? `+${net}` : String(net);

  document.getElementById('dayModalTitle').textContent = dateLabel;
  document.getElementById('daySummary').innerHTML = tracked
    ? `<strong class="mono">${score}</strong> score &nbsp;·&nbsp; <span class="mono">${netLabel}</span> net &nbsp;·&nbsp; ${dayEntries.length} item${dayEntries.length === 1 ? '' : 's'}`
    : pauseOn(viewState.selectedDayKey) ? '<strong>Paused</strong> · 0 points counted' : `<strong>Untracked</strong> &nbsp;·&nbsp; no score or statistics recorded`;

  document.getElementById('previousDayBtn').disabled = viewState.selectedDayKey <= statsStartKey();
  document.getElementById('nextDayBtn').disabled = viewState.selectedDayKey >= todayKey();
  const trackedDates = ledger.dates;
  document.getElementById('previousTrackedBtn').disabled = !trackedDates.some(day => day < viewState.selectedDayKey);
  document.getElementById('nextTrackedBtn').disabled = !trackedDates.some(day => day > viewState.selectedDayKey);
  renderCompletionControl(viewState.selectedDayKey, 'dayCompletionControl');

  const list = document.getElementById('dayActivityList');
  if(!dayEntries.length){
    list.innerHTML = tracked
      ? `<div class="empty">No activity recorded. This completed day is tracked at baseline ${ledgerState.dailyBase}.</div>`
      : pauseOn(viewState.selectedDayKey) ? '<div class="empty">No activity recorded during this pause.</div>' : `<div class="empty">No activity recorded. This day is unknown and excluded from averages, trends, and streak progress.</div>`;
    return;
  }

  const typeLabels = { good:'Credit', bad:'Debit', bonus:'Bonus' };
  list.innerHTML = dayEntries.map(entry => {
    const points = Number(entry.points) || 0;
    const sign = points > 0 ? '+' : '';
    const tone = entry.type === 'bonus' ? 'bonus' : (points < 0 ? 'loss' : '');
    const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    const typeLabel = entry.derived ? automaticEntryLabel(entry) : typeLabels[entry.type];
    return `<div class="row">
      <div class="row-main">
        <div class="row-name">${escapeHtml(entry.name)}</div>
        <span class="entry-type-badge">${typeLabel} · ${time}${pauseOn(entry.date) ? ' · Excluded' : ''}</span>
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

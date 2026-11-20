import { addDaysToKey } from "../ledger/calendar.js";
import { consecutiveHabitDays, todayKey } from "../ledger/days.js";
import {
  TASK_SORT_OPTIONS,
  sectionsForKind,
  sortedTaskItems,
  taskActivity,
  taskItems
} from "../ledger/tasks.js";
import { ledgerState } from "../state.js";
import { persistSettings } from "../storage/persistence.js";
import { escapeHtml } from "./dom.js";
import { renderAll } from "./render.js";
import { hourLabel } from "./settings.js";
import { activeLedgerDate } from "./today.js";

export function setReorderStatus(message){
  const status = document.getElementById('reorderStatus');
  if(status) status.textContent = message;
}
function taskDragHandle(kind, item){
  const manual = ledgerState.taskSortModes[kind] === 'manual';
  const hint = manual
    ? `Drag ${item.name}. Keyboard: Up or Down reorders; Left or Right changes section.`
    : `Switch ${kind === 'habit' ? 'Habits' : 'Bonus entries'} to Manual sorting to rearrange.`;
  return `<button type="button" class="drag-handle${manual ? '' : ' inactive'}" data-drag-handle data-kind="${kind}" data-id="${escapeHtml(item.id)}" aria-label="${escapeHtml(hint)}" title="${escapeHtml(hint)}">
    <svg viewBox="0 0 18 26" aria-hidden="true" focusable="false">
      <circle cx="5" cy="5" r="2.2"></circle><circle cx="13" cy="5" r="2.2"></circle>
      <circle cx="5" cy="13" r="2.2"></circle><circle cx="13" cy="13" r="2.2"></circle>
      <circle cx="5" cy="21" r="2.2"></circle><circle cx="13" cy="21" r="2.2"></circle>
    </svg>
  </button>`;
}
function taskSectionDragHandle(kind, section){
  const hint = `Drag ${section.name} section. Keyboard: Up or Down reorders; Home or End moves it to an edge.`;
  return `<button type="button" class="drag-handle section-drag-handle" data-section-drag-handle data-kind="${kind}" data-id="${escapeHtml(section.id)}" aria-label="${escapeHtml(hint)}" title="${escapeHtml(hint)}">
    <svg viewBox="0 0 18 26" aria-hidden="true" focusable="false">
      <circle cx="5" cy="5" r="2.2"></circle><circle cx="13" cy="5" r="2.2"></circle>
      <circle cx="5" cy="13" r="2.2"></circle><circle cx="13" cy="13" r="2.2"></circle>
      <circle cx="5" cy="21" r="2.2"></circle><circle cx="13" cy="21" r="2.2"></circle>
    </svg>
  </button>`;
}
export function setTaskSortMode(kind, mode){
  if(!['habit','bonus'].includes(kind) || !TASK_SORT_OPTIONS.some(option => option[0] === mode)) return;
  ledgerState.taskSortModes[kind] = mode;
  persistSettings();
  renderAll();
}
export function renderSortSelect(kind){
  const select = document.getElementById(`${kind}SortSelect`);
  if(!select) return;
  select.innerHTML = TASK_SORT_OPTIONS.map(([value, label]) =>
    `<option value="${value}" ${ledgerState.taskSortModes[kind] === value ? 'selected' : ''}>${label}</option>`
  ).join('');
}
function renderTaskGroups(kind, usage, rowRenderer){
  const customSections = sectionsForKind(kind);
  if(customSections.length === 0){
    return `<div class="task-group-list plain" data-task-drop-zone data-kind="${kind}" data-section-id="">${sortedTaskItems(kind, null, usage).map(rowRenderer).join('')}</div>`;
  }
  const unsectionedItems = sortedTaskItems(kind, null, usage);
  const showUnsectioned = unsectionedItems.length ||
    (ledgerState.taskSortModes[kind] === 'manual' && taskItems(kind).length);
  const groups = [
    ...(showUnsectioned ? [{
      id:null,
      name:kind === 'habit' ? 'Unsorted' : 'Unsectioned',
      editable:false,
      list:unsectionedItems
    }] : []),
    ...customSections.map(section => ({ ...section, editable:true, list:sortedTaskItems(kind, section.id, usage) }))
  ];
  return groups.map(group => {
    const list = group.list;
    const sectionId = group.id || '';
    return `<div class="task-group" data-task-group data-kind="${kind}" data-section-id="${escapeHtml(sectionId)}" data-custom-section="${group.editable ? 'true' : 'false'}">
      <div class="task-group-head">
        <span class="task-group-name">${escapeHtml(group.name)}</span>
        ${group.editable ? `<button type="button" class="task-group-edit" data-action="open-task-section" data-kind="${kind}" data-id="${escapeHtml(group.id)}" aria-label="Edit ${escapeHtml(group.name)} section">✎</button>` : ''}
        ${group.editable ? taskSectionDragHandle(kind, group) : ''}
      </div>
      <div class="task-group-list" data-task-drop-zone data-kind="${kind}" data-section-id="${escapeHtml(sectionId)}">
        ${list.length ? list.map(rowRenderer).join('') : '<div class="task-group-empty">Drag entries here</div>'}
      </div>
    </div>`;
  }).join('');
}

export function renderHabitList(){
  const el = document.getElementById('habitList');
  if(taskItems('habit').length === 0 && sectionsForKind('habit').length === 0){
    el.innerHTML = '<div class="empty">No habits yet — <button type="button" data-action="open-habit" data-type="good">add your first credit</button> or <button type="button" data-action="open-habit" data-type="bad">add a debit.</button></div>';
    return;
  }
  const date = activeLedgerDate();
  const countLabel = date === todayKey() ? 'today' : 'this day';
  const previousDate = addDaysToKey(date, -1);
  const { counts, selectedCounts, creditDates } = taskActivity('habit', date);
  el.innerHTML = renderTaskGroups('habit', counts, h => {
    const type = h.type;
    const dates = creditDates.get(h.id);
    const confirmedStreak = consecutiveHabitDays(dates, dates?.has(date) ? date : previousDate);
    const todaysCount = selectedCounts.get(h.id) || 0;
    let sub = '';
    if(type === 'good'){
      if(confirmedStreak >= 2){
        sub = `🔥 ${confirmedStreak}-day streak`;
      }
      if(todaysCount > 0) sub += (sub ? ' · ' : '') + `${todaysCount}× ${countLabel}`;
    } else {
      if(todaysCount > 0) sub = `${todaysCount}× ${countLabel}`;
    }

    const displayPts = h.points;
    const sign = type === 'good' ? '+' : '−';
    const pillClass = type === 'good' ? '' : 'loss';

    return `
      <div class="row task-row" data-task-row data-kind="habit" data-id="${escapeHtml(h.id)}" data-section-id="${escapeHtml(h.sectionId || '')}">
        <button type="button" class="row-main" style="background:none;border:none;text-align:left;padding:0;color:inherit" data-action="log-habit" data-id="${escapeHtml(h.id)}">
          <div class="row-name">${escapeHtml(h.name)}</div>
          ${sub ? `<div class="row-sub mono">${sub}</div>` : ''}
        </button>
        <button type="button" class="pill ${pillClass} mono" data-action="log-habit" data-id="${escapeHtml(h.id)}">${sign}${displayPts}</button>
        <button type="button" class="edit-btn" data-action="open-habit" data-type="${type}" data-id="${escapeHtml(h.id)}" aria-label="Edit ${escapeHtml(h.name)}">✎</button>
        ${taskDragHandle('habit', h)}
      </div>`;
  });
}

export function renderBonusList(){
  const el = document.getElementById('bonusList');
  if(ledgerState.bonusTasks.length === 0 && sectionsForKind('bonus').length === 0){
    el.innerHTML = `<div class="empty">No bonus entries yet — <button type="button" data-action="open-bonus">add a one-off you want to reward.</button></div>`;
    return;
  }
  const date = activeLedgerDate();
  const countLabel = date === todayKey() ? 'today' : 'this day';
  const { counts, selectedCounts } = taskActivity('bonus', date);
  el.innerHTML = renderTaskGroups('bonus', counts, b => {
    const todaysCount = selectedCounts.get(b.id) || 0;
    return `
      <div class="row task-row" data-task-row data-kind="bonus" data-id="${escapeHtml(b.id)}" data-section-id="${escapeHtml(b.sectionId || '')}">
        <button type="button" class="row-main" style="background:none;border:none;text-align:left;padding:0;color:inherit" data-action="log-bonus" data-id="${escapeHtml(b.id)}">
          <div class="row-name">✦ ${escapeHtml(b.name)}</div>
          ${todaysCount > 0 ? `<div class="row-sub mono">${todaysCount}× ${countLabel}</div>` : ''}
        </button>
        <button type="button" class="pill bonus mono" data-action="log-bonus" data-id="${escapeHtml(b.id)}">+${b.points}</button>
        <button type="button" class="edit-btn" data-action="open-bonus" data-id="${escapeHtml(b.id)}" aria-label="Edit ${escapeHtml(b.name)}">✎</button>
        ${taskDragHandle('bonus', b)}
      </div>`;
  });
}

export function renderDailyBonusList(){
  const el = document.getElementById('dailyBonusList');
  if(!el) return;
  if(!ledgerState.dailyBonuses.length){
    el.innerHTML = `<div class="empty">No automatic daily bonuses yet — <button type="button" data-action="open-daily-bonus">add a no-debits reward.</button></div>`;
    return;
  }
  el.innerHTML = ledgerState.dailyBonuses.map(bonus => `
    <div class="row">
      <div class="row-main">
        <div class="row-name">${escapeHtml(bonus.name)}</div>
        <div class="milestone-meta mono">No debits · +${bonus.points} per day · after ${hourLabel(ledgerState.dayStartHour)}</div>
        ${bonus.description ? `<div class="row-sub">${escapeHtml(bonus.description)}</div>` : ''}
      </div>
      <button type="button" class="edit-btn" data-action="open-daily-bonus" data-id="${escapeHtml(bonus.id)}" aria-label="Edit ${escapeHtml(bonus.name)}">✎</button>
    </div>`).join('');
}

export function renderMilestoneList(){
  const el = document.getElementById('milestoneList');
  if(!el) return;
  if(ledgerState.milestones.length === 0){
    el.innerHTML = `<div class="empty">No automatic milestones yet — <button type="button" data-action="open-milestone">add your first streak reward.</button></div>`;
    return;
  }
  const sorted = ledgerState.milestones.slice().sort((a, b) => a.days - b.days || a.name.localeCompare(b.name));
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

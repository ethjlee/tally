import { addDaysToKey, laterDateKey } from "../ledger/calendar.js";
import { isValidDateKey } from "../../shared/ledger-contract.ts";
import { pauseOn, setTravelPauses, todayKey } from "../ledger/days.js";
import { uid } from "../ledger/id.js";
import { mergeTravelPauseDates } from "../ledger/merge.js";
import { recomputeAllHabitStreaks } from "../ledger/streaks.js";
import { ledgerState, viewState } from "../state.js";
import { persistData } from "../storage/persistence.js";
import { closeDialog, openDialog } from "./dialog.js";
import { escapeHtml } from "./dom.js";
import { renderAll } from "./render.js";
import { canAddRecord, clearFieldError, showFieldError } from "./validation.js";

export function renderTravelList(){
  const list = document.getElementById('travelList');
  if(!list) return;
  const today = todayKey();
  list.innerHTML = ledgerState.travelPauses.slice().sort((a,b) => b.start.localeCompare(a.start)).map(pause => {
    const active = pause.start <= today && (!pause.end || today <= pause.end);
    return `<div class="row"><span class="row-main">${pause.start} – ${pause.end || 'until resumed'}${active ? ' · Active' : ''}</span>
      <button type="button" class="add-link" data-action="edit-travel" data-id="${escapeHtml(pause.id)}">Edit</button></div>`;
  }).join('') + (ledgerState.travelPauses.length ? '<button type="button" class="add-link" data-action="new-travel">New pause</button>' : '') +
    (pauseOn(today) ? ' <button type="button" class="completion-button" data-action="resume-travel">Resume today</button>' : '');
}
export function editTravelPause(id, date = todayKey()){
  const pause = ledgerState.travelPauses.find(p => p.id === id);
  viewState.editingPause = pause ? { ...pause } : null;
  document.getElementById('travelStart').value = pause?.start || date;
  document.getElementById('travelEnd').value = pause?.end || '';
  document.getElementById('removeTravel').hidden = !pause;
  document.getElementById('saveTravel').textContent = pause ? 'Save changes' : 'Add pause';
  clearFieldError('travelError');
}
export function openTravel(date){
  if(!document.getElementById('travelOverlay')) return;
  const pause = ledgerState.travelPauses.find(p => p.start <= date && (!p.end || p.end >= date));
  renderTravelList();
  editTravelPause(pause?.id, date);
  openDialog('travelOverlay', 'travelStart');
}
export function applyTravelEdit(pauses){
  setTravelPauses(pauses);
  recomputeAllHabitStreaks();
  persistData();
  closeDialog('travelOverlay');
  renderAll();
}
export function saveTravelPause(){
  let start = document.getElementById('travelStart').value;
  const endInput = document.getElementById('travelEnd');
  if(endInput.validity.badInput) return showFieldError('travelError','Enter a complete end date or clear the field.','travelEnd');
  let end = endInput.value || null;
  if(!isValidDateKey(start)) return showFieldError('travelError','Choose the first paused day.','travelStart');
  if(end && (!isValidDateKey(end) || end < start)) return showFieldError('travelError','Choose an end date on or after the first paused day.','travelEnd');
  const previous = ledgerState.travelPauses.find(p => p.id === viewState.editingPause?.id);
  if(viewState.editingPause){
    if(!previous) return showFieldError('travelError','This pause was removed. Choose New pause to add it again.');
    const dates = mergeTravelPauseDates(viewState.editingPause, { start, end }, previous);
    if(!dates){
      return showFieldError('travelError','This pause changed elsewhere. Open it again to review the latest dates.');
    }
    ({ start, end } = dates);
  }
  const others = ledgerState.travelPauses.filter(p => p.id !== viewState.editingPause?.id);
  const lastDate = end || '9999-12-31';
  if(others.some(p => {
    const overlapStart = laterDateKey(p.start, start);
    const overlapEnd = p.end && p.end < lastDate ? p.end : lastDate;
    return overlapStart <= overlapEnd &&
      (!previous || overlapStart < previous.start || (previous.end && overlapEnd > previous.end));
  })){
    return showFieldError('travelError','These dates add an overlap with another pause. Choose different dates.');
  }
  if(!viewState.editingPause && !canAddRecord('travelPauses', ledgerState.travelPauses, 'travelError')) return;
  applyTravelEdit([...others, { id:viewState.editingPause?.id || uid(), start, end }]);
}
export function resumeTravelToday(){
  const today = todayKey();
  const yesterday = addDaysToKey(today, -1);
  applyTravelEdit(ledgerState.travelPauses.filter(p => p.start !== today).map(p =>
    p.start < today && (!p.end || p.end >= today) ? { ...p, end:yesterday } : p));
}

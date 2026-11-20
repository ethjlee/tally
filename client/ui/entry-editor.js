import { deleteEntry } from "../ledger/actions.js";
import { isValidDateKey } from "../../shared/ledger-contract.ts";
import { statsStartKey, timestampForLedgerDate, todayKey } from "../ledger/days.js";
import { uid } from "../ledger/id.js";
import { editableEntryFields, mergeChangedFields } from "../ledger/merge.js";
import { recomputeHabitStreak } from "../ledger/streaks.js";
import { ledgerState, viewState } from "../state.js";
import { persistData } from "../storage/persistence.js";
import { renderDayActivity } from "./day.js";
import { closeDialog, openDialog, showConfirm } from "./dialog.js";
import { renderAll } from "./render.js";
import { canAddRecord, clearFieldError, showFieldError } from "./validation.js";

let editingEntry = null;
let entryModalMode = 'edit'; // 'edit' | 'create' — drives whether saving updates or inserts
// An entry may legitimately already sit before the statistics start date (an older
// backup, or the start date was moved forward later). Its own date is therefore the
// floor if that is earlier than the start date — but it must never be moved further
// back, because days before the start date cannot be opened from the UI at all.
function entryDateFloor(entry){
  const start = statsStartKey();
  return entry && isValidDateKey(entry.date) && entry.date < start ? entry.date : start;
}

export function openEntryModal(entryId){
  const entry = ledgerState.entries.find(e => e.id === entryId);
  if(!entry) return;
  editingEntry = { ...entry };
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
export function openNewEntryModal(dateKey){
  const target = isValidDateKey(dateKey) ? dateKey : todayKey();
  if(target < statsStartKey() || target > todayKey()) return;
  editingEntry = null;
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

export function closeEntryModal(){
  closeDialog('entryOverlay');
  editingEntry = null;
  entryModalMode = 'edit';
}

function linkedGoodHabit(entry){
  if(!entry || entry.type !== 'good') return null;
  if(entry.habitId) return ledgerState.habits.find(h => h.id === entry.habitId && h.type === 'good') || null;
  const matches = ledgerState.habits.filter(h => h.type === 'good' && h.name === entry.name);
  return matches.length === 1 ? matches[0] : null;
}

export function saveEditedEntry(){
  let date = document.getElementById('entryDateInput').value;
  let name = document.getElementById('entryNameInput').value.trim();
  let type = document.getElementById('entryTypeInput').value;
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
  if(entryModalMode === 'create'){
    if(!canAddRecord('entries', ledgerState.entries, 'entryError')) return;
    if(date < statsStartKey()){
      return showFieldError('entryError', 'That day is before your statistics start date. Move the start date back first if you want to log it.', 'entryDateInput');
    }
    const ts = timestampForLedgerDate(date);
    const entry = { id: uid(), date, name, type, points: type === 'bad' ? -pointsMagnitude : pointsMagnitude, ts };
    ledgerState.entries.push(entry);
    // Standalone record, matching type-changed edits. If the name matches exactly one
    // credit habit, recomputeHabitStreak attributes it and rebuilds that streak.
    const habit = linkedGoodHabit(entry);
    if(habit) recomputeHabitStreak(habit);
    persistData();
    viewState.selectedDayKey = date;
    viewState.selectedHistoryDate = date;
    closeEntryModal();
    renderAll();
    if(document.getElementById('dayOverlay').classList.contains('show')) renderDayActivity();
    return;
  }

  const entry = ledgerState.entries.find(e => e.id === editingEntry?.id);
  if(!entry) return showFieldError('entryError', 'This entry no longer exists. Close and try again.');
  const draft = { date, name, type, magnitude:pointsMagnitude };
  const merged = mergeChangedFields(editableEntryFields(editingEntry), draft, editableEntryFields(entry));
  if(!merged){
    return showFieldError('entryError', 'This entry changed in another tab or device. Close and reopen it to review the latest values.');
  }
  const { magnitude } = merged;
  ({ date, name, type } = merged);
  if(date > todayKey()){
    return showFieldError('entryError', 'Choose a valid ledger date no later than today.', 'entryDateInput');
  }
  if(date < entryDateFloor(entry)){
    return showFieldError('entryError', 'That day is before your statistics start date, where the entry could no longer be opened or edited. Move the start date back first if you want it there.', 'entryDateInput');
  }

  const oldEntry = { ...entry };
  const oldHabit = linkedGoodHabit(oldEntry);
  entry.date = date;
  entry.name = name;
  entry.type = type;
  entry.points = type === 'bad' ? -magnitude : magnitude;

  // Keep a source link only when the edited entry remains the same kind of item.
  // Changing its type makes it a standalone historical record rather than silently
  // assigning it to a habit or bonus task that merely has a matching name.
  if(type === 'good' || type === 'bad'){
    delete entry.bonusId;
    if(oldEntry.type !== type) delete entry.habitId;
  } else if(type === 'bonus'){
    delete entry.habitId;
    const linked = entry.bonusId && ledgerState.bonusTasks.find(b => b.id === entry.bonusId);
    if(oldEntry.type !== 'bonus' || !linked) delete entry.bonusId;
  }

  const newHabit = linkedGoodHabit(entry);
  if(oldHabit) recomputeHabitStreak(oldHabit);
  if(newHabit && newHabit !== oldHabit) recomputeHabitStreak(newHabit);

  persistData();
  viewState.selectedDayKey = date;
  closeEntryModal();
  renderAll();
  renderDayActivity();
}

export async function deleteHistoricalEntry(entryId){
  const entry = ledgerState.entries.find(e => e.id === entryId);
  if(!entry) return;
  const ok = await showConfirm(`Delete “${entry.name}” from this day?`, 'Delete entry');
  if(!ok) return;
  deleteEntry(entryId, true);
  renderDayActivity();
}

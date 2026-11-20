import { isValidDateKey } from "../../shared/ledger-contract.ts";
import { statsStartKey, timestampForLedgerDate, todayKey } from "./days.js";
import { uid } from "./id.js";
import { completedDayId, explicitCompletionForDate, isDayTracked } from "./scoring.js";
import { recomputeHabitStreak } from "./streaks.js";
import { ledgerState } from "../state.js";
import { persistData } from "../storage/persistence.js";
import { renderAll } from "../ui/render.js";
import { activeLedgerDate } from "../ui/today.js";
import { showUndoAction, showUndoToast } from "../ui/undo.js";
import { canAddRecord } from "../ui/validation.js";

export function logHabit(id){
  const h = ledgerState.habits.find(x => x.id === id);
  if(!h || !canAddRecord('entries', ledgerState.entries)) return;
  const date = activeLedgerDate();
  const pts = h.type === 'good' ? Math.max(1, Math.round(h.points)) : -Math.abs(h.points);
  const entry = { id: uid(), date, name: h.name, type: h.type, points: pts, ts: timestampForLedgerDate(date), habitId: h.id };
  ledgerState.entries.push(entry);
  if(h.type === 'good') recomputeHabitStreak(h);
  persistData();
  renderAll(true);
  showUndoToast(entry);
}

export function logBonus(id){
  const b = ledgerState.bonusTasks.find(x => x.id === id);
  if(!b || !canAddRecord('entries', ledgerState.entries)) return;
  const date = activeLedgerDate();
  const entry = { id: uid(), date, name: b.name, type: 'bonus', points: Math.abs(b.points), ts: timestampForLedgerDate(date), bonusId: b.id };
  ledgerState.entries.push(entry);
  persistData();
  renderAll(true);
  showUndoToast(entry);
}

function setExplicitCompletion(date, shouldComplete){
  if(!isValidDateKey(date) || date < statsStartKey() || date > todayKey()) return;
  const existing = explicitCompletionForDate(date);
  if(shouldComplete && !existing){
    if(!canAddRecord('completedDays', ledgerState.completedDays)) return false;
    ledgerState.completedDays.push({ id:completedDayId(date), date, ts:timestampForLedgerDate(date) });
  }else if(!shouldComplete && existing){
    ledgerState.completedDays = ledgerState.completedDays.filter(day => day.date !== date);
  }else{
    return false;
  }
  persistData();
  renderAll();
  return true;
}
export function toggleDayCompletion(date){
  const target = date || todayKey();
  const existing = explicitCompletionForDate(target);
  if(existing){
    const saved = { ...existing };
    setExplicitCompletion(target, false);
    showUndoAction(isDayTracked(target) ? `Removed completion mark · ${target}` : `Marked ${target} untracked`, () => {
      if(!explicitCompletionForDate(target)){
        ledgerState.completedDays.push(saved);
        persistData();
        renderAll();
      }
    });
  }else{
    if(!setExplicitCompletion(target, true)) return;
    showUndoAction(`Completed · ${target}`, () => setExplicitCompletion(target, false));
  }
}

// Removing a logged entry — used by both the Undo toast and the Today's Activity list.
// For credit entries, the habit's streak has to be recalculated from what's actually left
// in the log, or the habit would keep claiming a streak day that was just undone.
export function deleteEntry(entryId, offerUndo){
  const entry = ledgerState.entries.find(e => e.id === entryId);
  if(!entry) return;
  ledgerState.entries = ledgerState.entries.filter(e => e.id !== entryId);

  if(entry.type === 'good'){
    // Only fall back to name-matching for genuinely legacy entries that never had a
    // habitId at all. If habitId IS set but doesn't match anything, that habit was
    // deleted — guessing by name risks silently attributing it to an unrelated habit
    // that happens to share the same name.
    const legacyMatches = entry.habitId
      ? []
      : ledgerState.habits.filter(h => h.type === 'good' && h.name === entry.name);
    const habit = entry.habitId
      ? ledgerState.habits.find(h => h.id === entry.habitId && h.type === 'good')
      : (legacyMatches.length === 1 ? legacyMatches[0] : null);
    if(habit) recomputeHabitStreak(habit);
  }

  persistData();
  renderAll(true);
  if(offerUndo){
    showUndoAction(`Removed · ${entry.name}`, () => {
      if(ledgerState.entries.some(item => item.id === entry.id)) return;
      ledgerState.entries.push(entry);
      if(entry.type === 'good'){
        const habit = entry.habitId ? ledgerState.habits.find(h => h.id === entry.habitId && h.type === 'good') : null;
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

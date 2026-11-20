import { ledgerCountsSentence } from "../backup/controls.js";
import { isValidDateKey } from "../../shared/ledger-contract.ts";
import { ledgerDateKeyForHour } from "../ledger/calendar.js";
import { inferredStartDate, setTravelPauses, statsStartKey, todayKey } from "../ledger/days.js";
import { buildSnapshot } from "../ledger/snapshot.js";
import { recomputeAllHabitStreaks } from "../ledger/streaks.js";
import { updateLedgerDay } from "../lifecycle.js";
import { DEFAULT_BACKUP_REMINDER_DAYS, deviceState, ledgerState, viewState } from "../state.js";
import { saveRecoverySnapshot } from "../storage/database.js";
import { persistData, persistSettings } from "../storage/persistence.js";
import { closeDialog, openDialog, showConfirm } from "./dialog.js";
import { renderAll } from "./render.js";
import { showSaveWarning } from "./storage.js";
import { clearFieldError, showFieldError } from "./validation.js";

// Formats an hour (0-23) as a human 12-hour label, e.g. 7 -> "7:00 AM", 0 -> "12:00 AM".
export function hourLabel(h){
  const period = h < 12 ? 'AM' : 'PM';
  const hour12 = (h % 12) === 0 ? 12 : (h % 12);
  return `${hour12}:00 ${period}`;
}
export function initDayStartOptions(){
  const sel = document.getElementById('dayStartInput');
  sel.innerHTML = Array.from({ length: 24 }, (_, h) => `<option value="${h}">${hourLabel(h)}</option>`).join('');
}

export function openSettings(){
  document.getElementById('baseInput').value = ledgerState.dailyBase;
  document.getElementById('thresholdInput').value = ledgerState.successThreshold;
  document.getElementById('dayStartInput').value = String(ledgerState.dayStartHour);
  document.getElementById('startDateInput').max = todayKey();
  document.getElementById('startDateInput').value = statsStartKey();
  const reminderSel = document.getElementById('reminderInput');
  reminderSel.querySelector('[data-custom-cadence]')?.remove();
  const cadence = String(ledgerState.backupReminderDays);
  if(!Array.from(reminderSel.options).some(option => option.value === cadence)){
    const option = new Option(`Every ${cadence} days`, cadence);
    option.dataset.customCadence = '';
    reminderSel.add(option);
  }
  reminderSel.value = cadence;
  clearFieldError('settingsError');
  openDialog('settingsOverlay', 'baseInput');
}
export function closeSettings(){
  closeDialog('settingsOverlay');
}
export function saveSettings(){
  const baseInput = document.getElementById('baseInput').value;
  const thresholdInput = document.getElementById('thresholdInput').value;
  const base = Number(baseInput);
  const threshold = Number(thresholdInput);
  const dayStart = Number(document.getElementById('dayStartInput').value);
  const startDate = document.getElementById('startDateInput').value;
  const reminder = document.getElementById('reminderInput').value;
  clearFieldError('settingsError');
  if(!baseInput || !Number.isInteger(base) || base < 0 || base > 9999){
    return showFieldError('settingsError', 'Daily base must be a whole number from 0 to 9999.', 'baseInput');
  }
  if(!thresholdInput || !Number.isInteger(threshold) || threshold < 0 || threshold > 9999){
    return showFieldError('settingsError', 'Success threshold must be a whole number from 0 to 9999.', 'thresholdInput');
  }
  if(!Number.isInteger(dayStart) || dayStart < 0 || dayStart > 23){
    return showFieldError('settingsError', 'Choose a valid day-start hour.', 'dayStartInput');
  }
  if(!isValidDateKey(startDate) || startDate > ledgerDateKeyForHour(dayStart)){
    return showFieldError('settingsError', 'Choose a valid statistics start date no later than the current ledger day.', 'startDateInput');
  }
  ledgerState.dailyBase = base;
  ledgerState.successThreshold = threshold;
  ledgerState.dayStartHour = dayStart;
  ledgerState.trackingStartDate = startDate;
  updateLedgerDay();
  if(reminder !== '') ledgerState.backupReminderDays = Number(reminder);
  viewState.reminderDismissedThisSession = false; // let a freshly chosen cadence show if already due
  recomputeAllHabitStreaks();
  persistSettings();
  closeSettings();
  renderAll();
}

export async function clearLedgerData(){
  if(deviceState.unreadableLocalState) return persistData();
  const ok = await showConfirm(`Clear all habits, bonus entries, automatic daily bonuses, milestones, completed-day marks, and logged history? You'll lose ${ledgerCountsSentence()}. Your scoring settings will stay unchanged.`, 'Clear ledger');
  if(ok){
    if(!await saveRecoverySnapshot('before-clear-ledger', buildSnapshot())){
      showSaveWarning();
      return;
    }
    setTravelPauses([]);
    ledgerState.habits = []; ledgerState.bonusTasks = []; ledgerState.dailyBonuses = []; ledgerState.taskSections = []; ledgerState.milestones = []; ledgerState.completedDays = []; ledgerState.entries = [];
    await persistData();
    renderAll();
  }
}
export async function resetSettings(){
  if(deviceState.unreadableLocalState) return persistSettings();
  const ok = await showConfirm('Reset scoring, the statistics start date, day boundary, and chart range to their defaults?', 'Reset settings');
  if(ok){
    if(!await saveRecoverySnapshot('before-reset-settings', buildSnapshot())){
      showSaveWarning();
      return;
    }
    ledgerState.dailyBase = 100;
    ledgerState.successThreshold = 80;
    ledgerState.dayStartHour = 7;
    ledgerState.trackingStartDate = inferredStartDate([...ledgerState.entries, ...ledgerState.completedDays], ledgerState.dayStartHour);
    ledgerState.historyRangeDays = 14;
    ledgerState.backupReminderDays = DEFAULT_BACKUP_REMINDER_DAYS;
    ledgerState.taskSortModes = { habit:'manual', bonus:'manual' };
    recomputeAllHabitStreaks();
    await persistSettings();
    renderAll();
  }
}

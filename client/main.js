import {
  backupContentsLabel,
  closeBackup,
  dismissReminder,
  downloadBackup,
  downloadCsv,
  downloadCsvBackup,
  exportToFiles,
  openBackup,
  setBackupStatus,
  setCsvButtonsDisabled,
  shareBackup
} from "./backup/controls.js";
import { parseFullCsvBackup } from "./backup/csv.js";
import { doCsvRestore, doMergeCsv, doMergeJson, doRestore } from "./backup/import.js";
import { deleteEntry, logBonus, logHabit, toggleDayCompletion } from "./ledger/actions.js";
import { todayKey } from "./ledger/days.js";
import { buildSnapshot, validateBackupObject } from "./ledger/snapshot.js";
import { moveTaskByKeyboard, moveTaskSectionByKeyboard } from "./ui/task-order.js";
import { refreshCloudIfStale, refreshIfNewDay, startApp } from "./lifecycle.js";
import { cloudState, deviceState, ledgerState, viewState } from "./state.js";
import { MAX_BACKUP_BYTES } from "./storage/keys.js";
import { writeEmergencyMirror } from "./storage/persistence.js";
import { verifyCloudAccess } from "./sync/access.js";
import { resolveCloudRollback, syncCloudNow } from "./sync/cloud.js";
import { signOutAndClearDevice } from "./sync/sign-out.js";
import { setCloudStatus } from "./ui/cloud-status.js";
import { closeDayActivity, navigateDay, navigateTrackedDay, openDayActivity } from "./ui/day.js";
import { closeDialog, resolveConfirm, visibleDialogLayers } from "./ui/dialog.js";
import {
  beginTaskDrag,
  beginTaskSectionDrag,
  cleanupTaskDrag,
  cleanupTaskSectionDrag,
  finishTaskDrag,
  finishTaskSectionDrag,
  updateTaskDrag,
  updateTaskSectionDrag
} from "./ui/drag.js";
import {
  closeEntryModal,
  deleteHistoricalEntry,
  openEntryModal,
  openNewEntryModal,
  saveEditedEntry
} from "./ui/entry-editor.js";
import { jumpToExactDate, setHistoryRange } from "./ui/history.js";
import { switchView } from "./ui/render.js";
import {
  clearLedgerData,
  closeSettings,
  initDayStartOptions,
  openSettings,
  resetSettings,
  saveSettings
} from "./ui/settings.js";
import { dismissStorageBanner, runStorageHealthCheck } from "./ui/storage.js";
import {
  closeBonusModal,
  closeDailyBonusModal,
  closeHabitModal,
  closeMilestoneModal,
  closeTaskSectionModal,
  deleteBonusConfirm,
  deleteDailyBonusConfirm,
  deleteHabitConfirm,
  deleteMilestoneConfirm,
  deleteTaskSectionConfirm,
  openBonusModal,
  openDailyBonusModal,
  openHabitModal,
  openMilestoneModal,
  openTaskSectionModal,
  saveBonus,
  saveDailyBonus,
  saveHabit,
  saveMilestone,
  saveTaskSection,
  setHabitType,
  taskKindLabel
} from "./ui/task-editor.js";
import { setReorderStatus, setTaskSortMode } from "./ui/tasks.js";
import {
  activeLedgerDate,
  navigateToday,
  returnToToday,
  setTodayViewDate,
  toggleActivityLog
} from "./ui/today.js";
import {
  applyTravelEdit,
  editTravelPause,
  openTravel,
  resumeTravelToday,
  saveTravelPause
} from "./ui/travel.js";
import { undoFromToast } from "./ui/undo.js";
import { clearFieldError } from "./ui/validation.js";

document.addEventListener('pointerdown', event => {
  const sectionHandle = event.target.closest('[data-section-drag-handle]');
  if(sectionHandle){
    beginTaskSectionDrag(event, sectionHandle);
    return;
  }
  const handle = event.target.closest('[data-drag-handle]');
  if(handle) beginTaskDrag(event, handle);
});
document.addEventListener('pointermove', updateTaskDrag, { passive:false });
document.addEventListener('pointermove', updateTaskSectionDrag, { passive:false });
document.addEventListener('pointerup', finishTaskDrag);
document.addEventListener('pointerup', finishTaskSectionDrag);
document.addEventListener('pointercancel', () => {
  cleanupTaskDrag();
  cleanupTaskSectionDrag();
});
document.addEventListener('keydown', event => {
  const sectionHandle = event.target.closest?.('[data-section-drag-handle]');
  if(sectionHandle){
    if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    event.preventDefault();
    const kind = sectionHandle.dataset.kind;
    const id = sectionHandle.dataset.id;
    if(moveTaskSectionByKeyboard(kind, id, event.key)){
      setTimeout(() => {
        document.querySelector(`[data-section-drag-handle][data-kind="${kind}"][data-id="${id}"]`)?.focus();
      }, 0);
    }
    return;
  }
  const handle = event.target.closest?.('[data-drag-handle]');
  if(!handle) return;
  const kind = handle.dataset.kind;
  const id = handle.dataset.id;
  if(ledgerState.taskSortModes[kind] !== 'manual' && (event.key === 'Enter' || event.key === ' ')){
    event.preventDefault();
    setTaskSortMode(kind, 'manual');
    setReorderStatus(`${taskKindLabel(kind)} switched to Manual sorting.`);
    return;
  }
  if(!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
  event.preventDefault();
  if(moveTaskByKeyboard(kind, id, event.key)){
    setTimeout(() => {
      document.querySelector(`[data-drag-handle][data-kind="${kind}"][data-id="${id}"]`)?.focus();
    }, 0);
  }
});
document.addEventListener('click', event => {
  if(deviceState.clearingDevice || deviceState.peerClearingDevice) return;
  const target = event.target.closest('[data-action]');
  if(!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;
  switch(action){
    case 'open-travel': openTravel(target.dataset.date || (viewState.activeView === 'today' ? activeLedgerDate() : viewState.selectedHistoryDate || todayKey())); break;
    case 'new-travel': editTravelPause(null); break;
    case 'edit-travel': editTravelPause(id); break;
    case 'save-travel': saveTravelPause(); break;
    case 'resume-travel': resumeTravelToday(); break;
    case 'remove-travel': applyTravelEdit(ledgerState.travelPauses.filter(p => p.id !== viewState.editingPause?.id)); break;
    case 'close-travel': closeDialog('travelOverlay'); break;
    case 'switch-view': switchView(target.dataset.view); break;
    case 'toggle-activity': toggleActivityLog(); break;
    case 'navigate-today': navigateToday(target.dataset.offset); break;
    case 'return-today': returnToToday(); break;
    case 'open-task-section': openTaskSectionModal(target.dataset.kind, id); break;
    case 'close-task-section': closeTaskSectionModal(); break;
    case 'save-task-section': saveTaskSection(); break;
    case 'delete-task-section': deleteTaskSectionConfirm(); break;
    case 'open-habit': openHabitModal(target.dataset.type || 'good', id); break;
    case 'close-habit': closeHabitModal(); break;
    case 'set-habit-type': setHabitType(target.dataset.type); break;
    case 'save-habit': saveHabit(); break;
    case 'delete-habit': deleteHabitConfirm(); break;
    case 'log-habit': logHabit(id); break;
    case 'open-bonus': openBonusModal(id); break;
    case 'close-bonus': closeBonusModal(); break;
    case 'save-bonus': saveBonus(); break;
    case 'delete-bonus': deleteBonusConfirm(); break;
    case 'log-bonus': logBonus(id); break;
    case 'open-daily-bonus': openDailyBonusModal(id); break;
    case 'close-daily-bonus': closeDailyBonusModal(); break;
    case 'save-daily-bonus': saveDailyBonus(); break;
    case 'delete-daily-bonus': deleteDailyBonusConfirm(); break;
    case 'toggle-day-complete': toggleDayCompletion(target.dataset.date); break;
    case 'open-milestone': openMilestoneModal(id); break;
    case 'close-milestone': closeMilestoneModal(); break;
    case 'save-milestone': saveMilestone(); break;
    case 'delete-milestone': deleteMilestoneConfirm(); break;
    case 'open-settings': openSettings(); break;
    case 'close-settings': closeSettings(); break;
    case 'save-settings': saveSettings(); break;
    case 'open-backup': openBackup(); break;
    case 'close-backup': closeBackup(); break;
    case 'download-backup': downloadBackup(); break;
    case 'share-backup': shareBackup(); break;
    case 'export-files': exportToFiles(); break;
    case 'merge': doMergeJson(); break;
    case 'merge-csv': doMergeCsv(); break;
    case 'reminder-backup': openBackup(); break;
    case 'reminder-dismiss': dismissReminder(); break;
    case 'dismiss-storage-banner': dismissStorageBanner(); break;
    case 'download-csv': downloadCsv(); break;
    case 'download-csv-backup': downloadCsvBackup(); break;
    case 'run-storage-check': runStorageHealthCheck(); break;
    case 'sync-now': syncCloudNow(true); break;
    case 'resolve-cloud-rollback': resolveCloudRollback(target.dataset.choice); break;
    case 'open-account': window.location.assign('/account'); break;
    case 'sign-out-clear': signOutAndClearDevice(); break;
    case 'restore': doRestore(); break;
    case 'restore-csv': doCsvRestore(); break;
    case 'clear-ledger': clearLedgerData(); break;
    case 'reset-settings': resetSettings(); break;
    case 'confirm-no': resolveConfirm(false); break;
    case 'confirm-yes': resolveConfirm(true); break;
    case 'undo': undoFromToast(); break;
    case 'remove-entry': deleteEntry(id, true); break;
    case 'set-range': setHistoryRange(target.dataset.days); break;
    case 'jump-date': jumpToExactDate(); break;
    case 'open-day': openDayActivity(target.dataset.date); break;
    case 'close-day': closeDayActivity(); break;
    case 'navigate-day': navigateDay(target.dataset.offset); break;
    case 'navigate-tracked': navigateTrackedDay(target.dataset.direction); break;
    case 'open-entry': openEntryModal(id); break;
    case 'add-day-entry': openNewEntryModal(viewState.selectedDayKey || todayKey()); break;
    case 'close-entry': closeEntryModal(); break;
    case 'save-entry': saveEditedEntry(); break;
    case 'delete-history-entry': deleteHistoricalEntry(id); break;
  }
});

document.getElementById('backupText').addEventListener('click', event => event.currentTarget.select());
document.getElementById('todayDateInput').addEventListener('change', event => {
  setTodayViewDate(event.target.value);
});
document.querySelectorAll('[data-sort-kind]').forEach(select => {
  select.addEventListener('change', event => setTaskSortMode(event.currentTarget.dataset.sortKind, event.currentTarget.value));
});
document.getElementById('restoreFileInput').addEventListener('change', async event => {
  const input = event.target;
  const restoreText = document.getElementById('restoreText');
  const file = input.files?.[0];
  restoreText.value = '';
  if(!file) return;
  if(file.size > MAX_BACKUP_BYTES){
    input.value = '';
    setBackupStatus('That file is too large to be a Tally backup.', 'error');
    return;
  }
  try{
    const text = await file.text();
    if(input.files?.[0] !== file) return;
    const clean = validateBackupObject(JSON.parse(text), false);
    restoreText.value = text;
    setBackupStatus(`Ready to restore ${backupContentsLabel(clean)}.`, 'success');
  }catch(e){
    if(input.files?.[0] !== file) return;
    input.value = '';
    setBackupStatus(`Backup not accepted: ${e.message}`, 'error');
  }
});
document.getElementById('csvRestoreFileInput').addEventListener('change', async event => {
  const input = event.currentTarget;
  const file = input.files?.[0];
  viewState.pendingCsvBackupText = null;
  setCsvButtonsDisabled(true);
  if(!file) return;
  if(file.size > MAX_BACKUP_BYTES){
    setBackupStatus('That CSV file is too large to be a Tally backup.', 'error');
    input.value = '';
    return;
  }
  try{
    const text = await file.text();
    if(input.files?.[0] !== file) return;
    const clean = parseFullCsvBackup(text);
    viewState.pendingCsvBackupText = text;
    setCsvButtonsDisabled(false);
    setBackupStatus(`CSV ready to restore ${backupContentsLabel(clean)}.`, 'success');
  }catch(e){
    if(input.files?.[0] !== file) return;
    input.value = '';
    setBackupStatus(`CSV backup not accepted: ${e.message}`, 'error');
  }
});
['habitName','habitPoints'].forEach(id => document.getElementById(id).addEventListener('input', () => clearFieldError('habitError')));
['bonusName','bonusPoints'].forEach(id => document.getElementById(id).addEventListener('input', () => clearFieldError('bonusError')));
['dailyBonusName','dailyBonusPoints','dailyBonusDescription'].forEach(id =>
  document.getElementById(id)?.addEventListener('input', () => clearFieldError('dailyBonusError'))
);
document.getElementById('taskSectionName').addEventListener('input', () => clearFieldError('taskSectionError'));
['milestoneName','milestoneDays','milestonePoints','milestoneDescription'].forEach(id =>
  document.getElementById(id).addEventListener('input', () => clearFieldError('milestoneError'))
);
['baseInput','thresholdInput','dayStartInput','startDateInput'].forEach(id => document.getElementById(id).addEventListener('input', () => clearFieldError('settingsError')));
['entryDateInput','entryNameInput','entryTypeInput','entryPointsInput'].forEach(id =>
  document.getElementById(id).addEventListener('input', () => clearFieldError('entryError'))
);
document.getElementById('historyDateInput').addEventListener('input', () => {
  document.getElementById('dateJumpStatus').textContent = '';
});
document.getElementById('historyDateInput').addEventListener('keydown', event => {
  if(event.key === 'Enter'){
    event.preventDefault();
    jumpToExactDate();
  }
});
document.getElementById('dayOverlay').addEventListener('click', event => {
  if(event.target === event.currentTarget) closeDayActivity();
});

document.addEventListener('keydown', event => {
  const visible = visibleDialogLayers();
  const top = visible[visible.length - 1];
  if(!top && (event.key === 'Enter' || event.key === ' ')){
    const active = document.activeElement;
    if(active && active.dataset && active.dataset.action === 'open-day'){
      event.preventDefault();
      openDayActivity(active.dataset.date);
    }
  }
  if(!top) return;
  if(event.key === 'Escape'){
    event.preventDefault();
    if(top.id === 'confirmOverlay') resolveConfirm(false);
    else if(top.id === 'travelOverlay') closeDialog('travelOverlay');
    else if(top.id === 'habitOverlay') closeHabitModal();
    else if(top.id === 'bonusOverlay') closeBonusModal();
    else if(top.id === 'dailyBonusOverlay') closeDailyBonusModal();
    else if(top.id === 'taskSectionOverlay') closeTaskSectionModal();
    else if(top.id === 'milestoneOverlay') closeMilestoneModal();
    else if(top.id === 'settingsOverlay') closeSettings();
    else if(top.id === 'backupOverlay') closeBackup();
    else if(top.id === 'entryOverlay') closeEntryModal();
    else if(top.id === 'dayOverlay') closeDayActivity();
    return;
  }
  if(event.key === 'Tab'){
    const focusables = [...top.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])')]
      .filter(el => el.offsetParent !== null);
    if(!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if(event.shiftKey && document.activeElement === first){ event.preventDefault(); last.focus(); }
    else if(!event.shiftKey && document.activeElement === last){ event.preventDefault(); first.focus(); }
  }
});

initDayStartOptions();
startApp();

document.addEventListener('visibilitychange', () => {
  if(!document.hidden){
    refreshIfNewDay();
    refreshCloudIfStale();
  }
});
window.addEventListener('focus', () => {
  refreshIfNewDay();
  refreshCloudIfStale();
});
window.addEventListener('pageshow', () => {
  refreshIfNewDay();
  refreshCloudIfStale();
});
window.addEventListener('online', async () => {
  if(deviceState.clearingDevice || deviceState.peerClearingDevice) return;
  if(deviceState.startupInFlight) await deviceState.startupInFlight;
  if(deviceState.clearingDevice || deviceState.peerClearingDevice) return;
  if(!deviceState.appReady){
    if(deviceState.startupNeedsConnection) await startApp();
    return;
  }
  if(!cloudState.cloudEnabled && !await verifyCloudAccess()) return;
  syncCloudNow();
});
window.addEventListener('offline', () => {
  setCloudStatus('offline', 'Changes stay in the on-device database and are queued until reconnection.');
});
window.addEventListener('pagehide', () => {
  if(deviceState.appReady && !deviceState.clearingDevice && !deviceState.peerClearingDevice) writeEmergencyMirror(buildSnapshot());
});
document.addEventListener('visibilitychange', () => {
  if(deviceState.appReady && !deviceState.clearingDevice && !deviceState.peerClearingDevice && document.hidden) writeEmergencyMirror(buildSnapshot());
});
setInterval(refreshIfNewDay, 60000);

if('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')){
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

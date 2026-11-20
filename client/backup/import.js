import { backupContentsLabel, closeBackup, setBackupStatus, setCsvButtonsDisabled } from "./controls.js";
import { parseFullCsvBackup } from "./csv.js";
import { mergeConcurrentSnapshots } from "../ledger/merge.js";
import {
  buildSnapshot,
  snapshotFromClean,
  validIsoTimestamp,
  validateBackupObject
} from "../ledger/snapshot.js";
import { CLIENT_ID, deviceState, ledgerState, viewState } from "../state.js";
import { applyValidatedState } from "../storage/apply-state.js";
import { saveRecoverySnapshot } from "../storage/database.js";
import { SCHEMA_VERSION } from "../../shared/ledger-contract.ts";
import {
  finishDurableWrite,
  refreshDurableState,
  schedulePersist,
  startPersistence,
  withPersistenceLock,
  writeDurableSnapshot
} from "../storage/persistence.js";
import { showConfirm } from "../ui/dialog.js";
import { renderAll } from "../ui/render.js";

async function commitBackupImport(clean, action){
  while(deviceState.persistInFlight) await deviceState.persistInFlight;
  const changedMessage = 'The ledger changed during the import. Review the latest ledger and try again.';
  const status = await startPersistence(async () => {
    const previous = buildSnapshot();
    const snapshot = action === 'merge' ? mergeImportedState(clean) : snapshotFromClean(clean);
    snapshot.revision = previous.revision + 1;
    snapshot.writerId = CLIENT_ID;
    snapshot.savedAt = new Date().toISOString();
    let validated;
    try{
      validated = validateBackupObject(snapshot, false);
    }catch(error){
      return `Could not ${action} this backup. ${error.message}`;
    }
    if(!await saveRecoverySnapshot(`before-${action}`, previous)){
      return `The ${action} stopped because Tally could not save a recovery copy.`;
    }
    let result;
    try{
      result = await withPersistenceLock(() => {
        if(ledgerState.stateRevision !== previous.revision || deviceState.clearingDevice || deviceState.peerClearingDevice) return null;
        return writeDurableSnapshot(snapshot);
      });
    }catch(error){
      console.warn(`Tally: backup ${action} could not be saved`, error);
      return `Tally could not save the ${action === 'merge' ? 'merged' : 'restored'} ledger on this device. Free some browser storage and try again.`;
    }
    if(result?.status !== 'written') return changedMessage;

    const concurrent = ledgerState.stateRevision === previous.revision ? null : buildSnapshot();
    finishDurableWrite(snapshot);
    if(concurrent){
      const merged = mergeConcurrentSnapshots(previous, concurrent, snapshot);
      applyValidatedState(validateBackupObject(merged.snapshot, false));
      schedulePersist();
    }else applyValidatedState(validated);
    renderAll();
    return '';
  });
  if(status === changedMessage) await refreshDurableState().catch(() => {});
  if(status) setBackupStatus(status, 'error');
  return !status;
}
async function restoreValidatedBackup(clean, formatLabel){
  const label = formatLabel || 'backup';
  const ok = await showConfirm(
    `Replace the current ledger with this ${label} (${backupContentsLabel(clean)})? A recovery snapshot will be kept.`,
    'Restore'
  );
  if(ok && await commitBackupImport(clean, 'restore')) closeBackup();
}
export async function doRestore(){
  const raw = document.getElementById('restoreText').value.trim();
  setBackupStatus('');
  if(!raw){
    setBackupStatus('Choose a backup file or paste backup JSON first.', 'error');
    return;
  }
  let clean;
  try{
    clean = validateBackupObject(JSON.parse(raw), false);
  }catch(e){
    setBackupStatus(`Backup not restored: ${e.message}`, 'error');
    return;
  }
  return restoreValidatedBackup(clean, 'JSON backup');
}
export async function doCsvRestore(){
  if(!viewState.pendingCsvBackupText){
    setBackupStatus('Choose a complete Tally CSV backup first.', 'error');
    return;
  }
  let clean;
  try{
    clean = parseFullCsvBackup(viewState.pendingCsvBackupText);
  }catch(e){
    viewState.pendingCsvBackupText = null;
    setCsvButtonsDisabled(true);
    setBackupStatus(`CSV backup not restored: ${e.message}`, 'error');
    return;
  }
  return restoreValidatedBackup(clean, 'CSV backup');
}
// Merge, rather than replace: union every collection by id. On an id collision the
// current copy wins, matching the concurrent-merge policy elsewhere — a merge never
// silently overwrites an item you already have, it only ADDS ones you don't.
function unionById(currentItems, importedItems){
  const map = new Map();
  for(const item of importedItems) map.set(item.id, { ...item });
  for(const item of currentItems) map.set(item.id, { ...item });
  return [...map.values()];
}
function countNewById(currentItems, importedItems){
  const ids = new Set(currentItems.map(item => item.id));
  return importedItems.reduce((sum, item) => sum + (ids.has(item.id) ? 0 : 1), 0);
}
function newImportedCompletedDays(importedDays){
  const ids = new Set(ledgerState.completedDays.map(day => day.id));
  const dates = new Set(ledgerState.completedDays.map(day => day.date));
  return importedDays.filter(day => !ids.has(day.id) && !dates.has(day.date));
}
function mergeAddCounts(clean){
  return {
    taskSections: countNewById(ledgerState.taskSections, clean.taskSections),
    habits: countNewById(ledgerState.habits, clean.habits),
    bonusTasks: countNewById(ledgerState.bonusTasks, clean.bonusTasks),
    dailyBonuses: countNewById(ledgerState.dailyBonuses, clean.dailyBonuses),
    milestones: countNewById(ledgerState.milestones, clean.milestones),
    travelPauses: countNewById(ledgerState.travelPauses, clean.travelPauses),
    completedDays: newImportedCompletedDays(clean.completedDays).length,
    entries: countNewById(ledgerState.entries, clean.entries)
  };
}
function mergeImportedState(clean){
  const laterBackup = [validIsoTimestamp(ledgerState.lastBackupAt), validIsoTimestamp(clean.lastBackupAt)]
    .filter(Boolean).sort();
  return {
    app:'Tally',
    schemaVersion:SCHEMA_VERSION,
    writerId:CLIENT_ID,
    data:{
      taskSections:unionById(ledgerState.taskSections, clean.taskSections),
      habits:unionById(ledgerState.habits, clean.habits),
      bonusTasks:unionById(ledgerState.bonusTasks, clean.bonusTasks),
      dailyBonuses:unionById(ledgerState.dailyBonuses, clean.dailyBonuses),
      milestones:unionById(ledgerState.milestones, clean.milestones),
      travelPauses:unionById(ledgerState.travelPauses, clean.travelPauses),
      completedDays:[...newImportedCompletedDays(clean.completedDays), ...ledgerState.completedDays],
      entries:unionById(ledgerState.entries, clean.entries)
    },
    // Keep current settings and carry forward the newest backup timestamp.
    settings:{
      dailyBase: ledgerState.dailyBase, successThreshold: ledgerState.successThreshold, dayStartHour: ledgerState.dayStartHour, trackingStartDate: ledgerState.trackingStartDate,
      lastBackupAt:laterBackup.length ? laterBackup[laterBackup.length - 1] : null,
      historyRangeDays: ledgerState.historyRangeDays, backupReminderDays: ledgerState.backupReminderDays, taskSortModes:{ ...ledgerState.taskSortModes }
    }
  };
}
async function mergeValidatedBackup(clean, formatLabel){
  if(deviceState.unreadableLocalState){
    setBackupStatus('The current ledger could not be read. Use Restore to replace it with a known-good backup.', 'error');
    return;
  }
  const label = formatLabel || 'backup';
  const adds = mergeAddCounts(clean);
  const total = adds.travelPauses + adds.entries + adds.habits + adds.bonusTasks + adds.dailyBonuses + adds.taskSections + adds.milestones + adds.completedDays;
  if(total === 0){
    setBackupStatus(`Nothing to merge — every item in that ${label} is already in your ledger.`, 'success');
    return;
  }
  const parts = [
    `${adds.travelPauses} travel pauses`,
    `${adds.entries} logged entr${adds.entries === 1 ? 'y' : 'ies'}`,
    `${adds.taskSections} topic/bonus section${adds.taskSections === 1 ? '' : 's'}`,
    `${adds.habits} habit${adds.habits === 1 ? '' : 's'}`,
    `${adds.bonusTasks} bonus entr${adds.bonusTasks === 1 ? 'y' : 'ies'}`,
    `${adds.dailyBonuses} automatic daily bonus${adds.dailyBonuses === 1 ? '' : 'es'}`,
    `${adds.milestones} milestone${adds.milestones === 1 ? '' : 's'}`,
    `${adds.completedDays} completed day${adds.completedDays === 1 ? '' : 's'}`
  ];
  const ok = await showConfirm(
    `Merge this ${label} into your current ledger? Adds ${parts.join(', ')}. Existing items and your current settings stay as they are, and a recovery snapshot is kept.`,
    'Merge'
  );
  if(ok && await commitBackupImport(clean, 'merge')){
    closeBackup();
    setBackupStatus('Merge complete.', 'success');
  }
}
export async function doMergeJson(){
  const raw = document.getElementById('restoreText').value.trim();
  setBackupStatus('');
  if(!raw){
    setBackupStatus('Choose a backup file or paste backup JSON first.', 'error');
    return;
  }
  let clean;
  try{
    clean = validateBackupObject(JSON.parse(raw), false);
  }catch(e){
    setBackupStatus(`Backup not merged: ${e.message}`, 'error');
    return;
  }
  return mergeValidatedBackup(clean, 'JSON backup');
}
export async function doMergeCsv(){
  if(!viewState.pendingCsvBackupText){
    setBackupStatus('Choose a complete Tally CSV backup first.', 'error');
    return;
  }
  let clean;
  try{
    clean = parseFullCsvBackup(viewState.pendingCsvBackupText);
  }catch(e){
    setBackupStatus(`CSV backup not merged: ${e.message}`, 'error');
    return;
  }
  return mergeValidatedBackup(clean, 'CSV backup');
}

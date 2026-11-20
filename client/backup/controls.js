import { buildActivityCsv, buildFullCsvBackup } from "./csv.js";
import { todayKey } from "../ledger/days.js";
import { hasAnyLedgerData } from "../ledger/scoring.js";
import { buildExport, validIsoTimestamp } from "../ledger/snapshot.js";
import { ledgerState, viewState } from "../state.js";
import { persistSettings } from "../storage/persistence.js";
import { closeDialog, openDialog } from "../ui/dialog.js";

function formatBackupStatus(){
  if(!ledgerState.lastBackupAt) return 'No backup has ever been made.';
  const date = new Date(ledgerState.lastBackupAt);
  return `Last complete backup: ${date.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' })} at ${date.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' })}`;
}
export function renderBackupDate(){
  const text = formatBackupStatus();
  const row = document.getElementById('backupDateEl');
  const modal = document.getElementById('backupLastEl');
  if(row) row.textContent = text;
  if(modal) modal.textContent = text;
}
function markBackupCompleted(exportedAt){
  const clean = validIsoTimestamp(exportedAt);
  if(!clean) return;
  if(!ledgerState.lastBackupAt || clean > ledgerState.lastBackupAt){
    ledgerState.lastBackupAt = clean;
    persistSettings();
  }
  renderBackupDate();
  viewState.reminderDismissedThisSession = false; // a fresh backup clears the nudge until it's due again
  updateBackupReminder();
}

function describeDaysSince(iso){
  const ms = new Date(iso).getTime();
  if(!Number.isFinite(ms)) return 'a while ago';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if(days <= 0) return 'earlier today';
  if(days === 1) return 'yesterday';
  return `${days} days ago`;
}
function backupReminderDue(){
  if(!ledgerState.backupReminderDays || ledgerState.backupReminderDays <= 0) return false;
  if(!hasAnyLedgerData()) return false;
  if(!ledgerState.lastBackupAt) return true;
  const last = new Date(ledgerState.lastBackupAt).getTime();
  if(!Number.isFinite(last)) return true;
  return (Date.now() - last) / 86400000 >= ledgerState.backupReminderDays;
}
export function updateBackupReminder(){
  const el = document.getElementById('reminderBanner');
  if(!el) return;
  if(viewState.reminderDismissedThisSession || !backupReminderDue()){
    el.classList.remove('show');
    return;
  }
  el.querySelector('.reminder-text').textContent = ledgerState.lastBackupAt
    ? `Last backup was ${describeDaysSince(ledgerState.lastBackupAt)}. Save a fresh one to protect your ledger.`
    : `You haven't saved a backup yet. Save one so a cleared browser or lost device can't erase your ledger.`;
  el.classList.add('show');
}
export function dismissReminder(){
  viewState.reminderDismissedThisSession = true;
  updateBackupReminder();
}

// Shared "what's currently stored" summary, used by the Reset preview and echoed in
// the destructive-action confirmations so nothing is cleared blind.
export function ledgerCountsSentence(){
  const parts = [
    `${ledgerState.travelPauses.length} travel pauses`,
    `${ledgerState.taskSections.length} topic/bonus section${ledgerState.taskSections.length === 1 ? '' : 's'}`,
    `${ledgerState.habits.length} habit${ledgerState.habits.length === 1 ? '' : 's'}`,
    `${ledgerState.bonusTasks.length} bonus entr${ledgerState.bonusTasks.length === 1 ? 'y' : 'ies'}`,
    `${ledgerState.dailyBonuses.length} automatic daily bonus${ledgerState.dailyBonuses.length === 1 ? '' : 'es'}`,
    `${ledgerState.milestones.length} milestone${ledgerState.milestones.length === 1 ? '' : 's'}`,
    `${ledgerState.completedDays.length} completed-day mark${ledgerState.completedDays.length === 1 ? '' : 's'}`,
    `${ledgerState.entries.length} logged entr${ledgerState.entries.length === 1 ? 'y' : 'ies'}`
  ];
  return parts.join(', ');
}
export function renderResetPreview(){
  const el = document.getElementById('resetPreviewEl');
  if(!el) return;
  if(!hasAnyLedgerData()){
    el.innerHTML = `<strong>Nothing stored yet</strong><br>There's no ledger data to clear on this device.`;
    return;
  }
  el.innerHTML = `<strong>This device currently holds</strong><br>${ledgerCountsSentence()}. Clearing can't be undone from inside the app — save a backup first if you're unsure.`;
}
export function setCsvButtonsDisabled(disabled){
  const restore = document.getElementById('restoreCsvBtn');
  const merge = document.getElementById('mergeCsvBtn');
  if(restore) restore.disabled = disabled;
  if(merge) merge.disabled = disabled;
}
export function openBackup(){
  document.getElementById('backupText').value = JSON.stringify(buildExport(), null, 2);
  document.getElementById('restoreText').value = '';
  document.getElementById('restoreFileInput').value = '';
  document.getElementById('csvRestoreFileInput').value = '';
  setCsvButtonsDisabled(true);
  viewState.pendingCsvBackupText = null;
  setBackupStatus('');
  renderBackupDate();
  document.getElementById('shareBackupBtn').style.display = navigator.share ? '' : 'none';
  openDialog('backupOverlay', 'backupText');
}
function backupFilename(){
  return `tally-backup-${todayKey()}-${new Date().toTimeString().slice(0,5).replace(':','')}.json`;
}
function backupFile(){
  const data = buildExport();
  const text = JSON.stringify(data, null, 2);
  return {
    file:new File([text], backupFilename(), { type:'application/json' }),
    exportedAt:data.exportedAt
  };
}
export function setBackupStatus(message, tone){
  const el = document.getElementById('backupStatus');
  el.textContent = message;
  el.className = `status-message${tone ? ` ${tone}` : ''}`;
}
export function backupContentsLabel(clean){
  return `${clean.travelPauses.length} travel pauses, ${clean.taskSections.length} topic/bonus section${clean.taskSections.length === 1 ? '' : 's'}, ${clean.habits.length} habit${clean.habits.length === 1 ? '' : 's'}, ${clean.bonusTasks.length} bonus entr${clean.bonusTasks.length === 1 ? 'y' : 'ies'}, ${clean.dailyBonuses.length} automatic daily bonus${clean.dailyBonuses.length === 1 ? '' : 'es'}, ${clean.milestones.length} milestone${clean.milestones.length === 1 ? '' : 's'}, ${clean.completedDays.length} completed day${clean.completedDays.length === 1 ? '' : 's'}, and ${clean.entries.length} logged entr${clean.entries.length === 1 ? 'y' : 'ies'}`;
}
function triggerFileDownload(file){
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function downloadBackup(){
  const payload = backupFile();
  triggerFileDownload(payload.file);
  markBackupCompleted(payload.exportedAt);
  const file = payload.file;
  setBackupStatus(`Saved ${file.name}.`, 'success');
}
export async function shareBackup(){
  const payload = backupFile();
  const file = payload.file;
  try{
    if(navigator.canShare && navigator.canShare({ files:[file] })){
      await navigator.share({ title:'Tally backup', files:[file] });
    } else if(navigator.share){
      await navigator.share({ title:'Tally backup', text:await file.text() });
    } else {
      downloadBackup();
      return;
    }
    markBackupCompleted(payload.exportedAt);
    setBackupStatus('Backup shared successfully.', 'success');
  }catch(e){
    if(e && e.name === 'AbortError') setBackupStatus('Sharing cancelled.');
    else setBackupStatus('The backup could not be shared. Use Save file instead.', 'error');
  }
}
// One-tap path oriented at iOS "Save to Files". On iPhone the share sheet exposes
// Files/iCloud Drive; on browsers without file sharing it falls back to a download so
// the button always produces a saved backup somewhere.
export async function exportToFiles(){
  const payload = backupFile();
  const file = payload.file;
  try{
    if(navigator.canShare && navigator.canShare({ files:[file] })){
      await navigator.share({ title:'Tally backup', files:[file] });
      markBackupCompleted(payload.exportedAt);
      setBackupStatus('Choose "Save to Files" in the share sheet to store this in iCloud Drive.', 'success');
      return;
    }
  }catch(e){
    if(e && e.name === 'AbortError'){ setBackupStatus('Export cancelled.'); return; }
  }
  triggerFileDownload(file);
  markBackupCompleted(payload.exportedAt);
  setBackupStatus(`Saved ${file.name} to your device's downloads.`, 'success');
}
function csvBackupFilename(){
  return `tally-backup-${todayKey()}-${new Date().toTimeString().slice(0,5).replace(':','')}.csv`;
}
function csvBackupFile(){
  const payload = buildFullCsvBackup();
  return {
    file:new File([payload.text], csvBackupFilename(), { type:'text/csv;charset=utf-8' }),
    exportedAt:payload.exportedAt
  };
}
export function downloadCsvBackup(){
  const payload = csvBackupFile();
  triggerFileDownload(payload.file);
  markBackupCompleted(payload.exportedAt);
  setBackupStatus(`Saved ${payload.file.name}.`, 'success');
}

export function downloadCsv(){
  const file = new File(
    [buildActivityCsv()],
    `tally-activity-${todayKey()}.csv`,
    { type:'text/csv;charset=utf-8' }
  );
  triggerFileDownload(file);
}
export function closeBackup(){
  closeDialog('backupOverlay');
  setBackupStatus('');
  document.getElementById('csvRestoreFileInput').value = '';
  viewState.pendingCsvBackupText = null;
  setCsvButtonsDisabled(true);
}

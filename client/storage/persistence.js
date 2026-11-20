import { cloneJson, mergeConcurrentSnapshots, valuesEqual } from "../ledger/merge.js";
import { buildSnapshot, snapshotFromClean, validateBackupObject } from "../ledger/snapshot.js";
import { CLIENT_ID, cloudState, deviceState, ledgerState } from "../state.js";
import { applyValidatedState } from "./apply-state.js";
import { idbGet, idbWriteState, safeLocalGet, safeLocalSet, saveRecoverySnapshot } from "./database.js";
import {
  CLOUD_BASE_FALLBACK_KEY,
  EMERGENCY_STATE_KEY,
  FALLBACK_PREVIOUS_KEY,
  FALLBACK_STATE_KEY,
  STATE_KEY,
  V7_MIGRATION_BASE_FALLBACK_KEY
} from "./keys.js";
import { queueCloudSnapshot } from "../sync/cloud.js";
import { readFallbackCloudRecord } from "../sync/records.js";
import { clearTallyLocalStorage, closeDeviceDatabase, showDeviceClearScreen } from "../sync/sign-out.js";
import { renderCloudStatus } from "../ui/cloud-status.js";
import { renderAll } from "../ui/render.js";
import {
  hideSaveWarning,
  showSaveWarning,
  showStorageBanner,
  updateStorageStatus
} from "../ui/storage.js";

export function parseStoredSnapshot(raw){
  if(!raw) return null;
  try{
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const clean = validateBackupObject(parsed, false);
    return { raw:parsed, clean };
  }catch(e){
    return null;
  }
}
export function storedV7Revision(raw){
  const revision = raw?.migratedV7Revision;
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}
export function snapshotForStorage(snapshot){
  return deviceState.migratedV7Revision === null ? snapshot : { ...snapshot, migratedV7Revision: deviceState.migratedV7Revision };
}
export function writeEmergencyMirror(snapshot){
  if(!deviceState.canUseLocalStorage || deviceState.unreadableLocalState) return false;
  const current = parseStoredSnapshot(safeLocalGet(EMERGENCY_STATE_KEY));
  if(current && current.clean.revision > snapshot.revision) return true;
  return safeLocalSet(EMERGENCY_STATE_KEY, JSON.stringify(snapshotForStorage(snapshot)));
}
function writeFallbackState(snapshot, expectedRevision){
  const current = readFallbackLedger();
  if(current && current.clean.revision > expectedRevision){
    return { status:'conflict', latest:current.raw };
  }
  const stored = snapshotForStorage(snapshot);
  if(current && !valuesEqual(current.raw, stored)){
    safeLocalSet(FALLBACK_PREVIOUS_KEY, JSON.stringify(current.raw));
  }
  if(!safeLocalSet(FALLBACK_STATE_KEY, JSON.stringify(stored))){
    throw new Error('Local storage write failed');
  }
  writeEmergencyMirror(snapshot);
  return { status:'written', latest:null };
}
export function mirrorDurableSnapshot(snapshot){
  if(!deviceState.canUseLocalStorage) return;
  const current = parseStoredSnapshot(safeLocalGet(FALLBACK_STATE_KEY));
  if(current && current.clean.revision > snapshot.revision) return;
  const stored = snapshotForStorage(snapshot);
  if(current && !valuesEqual(current.raw, stored)){
    safeLocalSet(FALLBACK_PREVIOUS_KEY, JSON.stringify(current.raw));
  }
  safeLocalSet(FALLBACK_STATE_KEY, JSON.stringify(stored));
  writeEmergencyMirror(snapshot);
  if(deviceState.pendingV7MigrationBase?.revision === deviceState.migratedV7Revision){
    const checkpoint = parseStoredSnapshot(safeLocalGet(V7_MIGRATION_BASE_FALLBACK_KEY));
    if(!checkpoint || checkpoint.clean.revision < deviceState.migratedV7Revision){
      safeLocalSet(V7_MIGRATION_BASE_FALLBACK_KEY, JSON.stringify(deviceState.pendingV7MigrationBase));
    }
  }
}
export function readFallbackLedger(){
  const mirror = parseStoredSnapshot(safeLocalGet(FALLBACK_STATE_KEY));
  const committed = parseStoredSnapshot(readFallbackCloudRecord()?.ledger);
  return committed && (!mirror || committed.clean.revision > mirror.clean.revision) ? committed : mirror;
}
export async function withPersistenceLock(callback){
  if(navigator.locks && navigator.locks.request){
    let callbackStarted = false;
    try{
      return await navigator.locks.request('tally-persistence-v2', { mode:'exclusive' }, async () => {
        callbackStarted = true;
        return callback();
      });
    }catch(error){
      if(callbackStarted) throw error;
    }
  }
  return callback();
}
export async function writeDurableSnapshot(snapshot, expectedRevision = deviceState.durableRevision, preserveSameRevision = false){
  const fallback = readFallbackLedger();
  if(fallback && fallback.clean.revision > expectedRevision){
    return { status:'conflict', latest:fallback.raw };
  }
  if(deviceState.tallyDb){
    try{
      return await idbWriteState(snapshot, expectedRevision, preserveSameRevision);
    }catch(error){
      console.warn('Tally: IndexedDB write failed; trying browser storage fallback', error);
      try{ deviceState.tallyDb.close(); }catch(e){}
      deviceState.tallyDb = null;
      deviceState.storageMode = deviceState.canUseLocalStorage ? 'localStorage' : 'memory';
      deviceState.storageAvailable = deviceState.canUseLocalStorage;
    }
  }
  if(deviceState.canUseLocalStorage) return writeFallbackState(snapshot, expectedRevision);
  throw new Error('No durable browser storage is available');
}
async function mergeWriteConflict(latestRaw){
  const remoteClean = validateBackupObject(latestRaw, false);
  const remoteSnapshot = snapshotFromClean(remoteClean);
  const migrating = deviceState.pendingV7MigrationBase;
  let localSnapshot, merged;
  do {
    localSnapshot = buildSnapshot();
    merged = migrating
      ? mergeConcurrentSnapshots(deviceState.durableBaseSnapshot, remoteSnapshot, localSnapshot)
      : mergeConcurrentSnapshots(deviceState.durableBaseSnapshot, localSnapshot, remoteSnapshot);
    const recovery = migrating ? localSnapshot : remoteSnapshot;
    if(!await saveRecoverySnapshot('before-concurrent-merge', recovery)) throw new Error('RECOVERY_SAVE_FAILED');
  } while(ledgerState.stateRevision !== localSnapshot.revision);
  const mergedClean = validateBackupObject(merged.snapshot, false);
  const remoteV7Revision = storedV7Revision(latestRaw);
  if(remoteV7Revision !== null && (deviceState.migratedV7Revision === null || remoteV7Revision > deviceState.migratedV7Revision)){
    deviceState.migratedV7Revision = remoteV7Revision;
  }
  applyValidatedState(mergedClean);
  deviceState.durableRevision = remoteClean.revision;
  deviceState.durableBaseSnapshot = cloneJson(remoteSnapshot);
  ledgerState.stateRevision = Math.max(localSnapshot.revision || 0, remoteClean.revision) + 1;
  deviceState.persistDirty = true;
  writeEmergencyMirror(buildSnapshot());
  renderAll();

  showStorageBanner(
    merged.hadDirectConflict
      ? (deviceState.pendingV7MigrationBase
        ? 'Tally recovered changes from the older app and kept newer edits from another open copy where they conflicted.'
        : 'Two open copies changed the same item. Tally kept your local edit, preserved the other state as a recovery copy, and merged everything else. Review recent activity and save a backup.')
      : 'Changes from another open copy were merged safely.',
    merged.hadDirectConflict
  );
}

export function persistData(){ return schedulePersist(); }
export function persistSettings(){ return schedulePersist(); }
export function schedulePersist(){
  if(deviceState.unreadableLocalState){
    showStorageBanner('Saved data could not be read. Restore a known-good backup from Data before making changes.', true);
    return Promise.resolve();
  }
  ledgerState.stateRevision++;
  deviceState.persistDirty = true;
  writeEmergencyMirror(buildSnapshot());
  // Start on the next microtask so persistInFlight is assigned before either the
  // asynchronous database path or synchronous local-storage fallback can finish.
  if(!deviceState.persistInFlight) startPersistence(flushPersistLoop);
  return deviceState.persistInFlight;
}
export function startPersistence(write){
  deviceState.persistInFlight = Promise.resolve().then(write).finally(() => {
    deviceState.persistInFlight = null;
    if(deviceState.persistDirty) startPersistence(flushPersistLoop);
    updateStorageStatus();
    renderCloudStatus();
  });
  return deviceState.persistInFlight;
}
export function finishDurableWrite(snapshot){
  deviceState.durableRevision = snapshot.revision;
  deviceState.durableBaseSnapshot = cloneJson(snapshot);
  deviceState.persistFailed = false;
  deviceState.unreadableLocalState = false;
  mirrorDurableSnapshot(snapshot);
  if(deviceState.syncChannel) deviceState.syncChannel.postMessage({ revision:snapshot.revision, writerId:CLIENT_ID });
  queueCloudSnapshot(snapshot);
  if(!deviceState.stickyStorageWarning) hideSaveWarning();
}
async function flushPersistLoop(){
  try{
    while(deviceState.persistDirty){
      deviceState.persistDirty = false;
      const snapshot = buildSnapshot();
      validateBackupObject(snapshot, false);
      const result = await withPersistenceLock(() => writeDurableSnapshot(snapshot));
      if(result.status === 'conflict'){
        await mergeWriteConflict(result.latest);
        continue;
      }
      finishDurableWrite(snapshot);
    }
  }catch(e){
    deviceState.persistFailed = true;
    console.error('Tally: save failed', e);
    showSaveWarning();
  }
}
// The banner is dismissible, so its message lives in a child span rather than being
// written over the whole element (which would delete the Dismiss button).
export function setupCrossWindowSync(){
  if('BroadcastChannel' in window){
    try{
      deviceState.syncChannel = new BroadcastChannel('tally-sync-v2');
      deviceState.syncChannel.onmessage = async event => {
        if(event.data && event.data.type === 'prepare-clear-device'){
          deviceState.peerClearingDevice = true;
          clearTimeout(cloudState.cloudSyncTimer);
          cloudState.cloudRefreshRequested = false;
          showDeviceClearScreen('Signing out on this device…');
          if(deviceState.persistInFlight) await deviceState.persistInFlight;
          if(deviceState.peerClearingDevice) closeDeviceDatabase();
          return;
        }
        if(event.data && event.data.type === 'clear-device'){
          deviceState.peerClearingDevice = true;
          deviceState.appReady = false;
          closeDeviceDatabase();
          clearTallyLocalStorage();
          window.location.replace('/login');
          return;
        }
        if(event.data && event.data.type === 'cancel-clear-device'){
          window.location.reload();
          return;
        }
        if(!event.data || event.data.writerId === CLIENT_ID || event.data.revision <= deviceState.durableRevision || !deviceState.tallyDb) return;
        try{
          await refreshDurableState();
        }catch(e){}
      };
    }catch(e){}
  }

  window.addEventListener('storage', event => {
    if((event.key === FALLBACK_STATE_KEY || event.key === CLOUD_BASE_FALLBACK_KEY) && event.newValue){
      refreshDurableState().catch(() => {});
    }
  });
}

export async function refreshDurableState(){
  for(;;){
    if(deviceState.peerClearingDevice) throw new Error('DEVICE_CLEAR_IN_PROGRESS');
    if(deviceState.persistInFlight) await deviceState.persistInFlight;
    if(deviceState.persistFailed) throw new Error('LOCAL_SAVE_FAILED');
    const revision = ledgerState.stateRevision;
    const raw = deviceState.tallyDb ? await idbGet(STATE_KEY) : null;
    if(deviceState.persistInFlight || revision !== ledgerState.stateRevision) continue;
    if(deviceState.peerClearingDevice) throw new Error('DEVICE_CLEAR_IN_PROGRESS');
    const databaseCopy = parseStoredSnapshot(raw);
    const fallbackCopy = readFallbackLedger();
    const latest = fallbackCopy && (!databaseCopy || fallbackCopy.clean.revision > databaseCopy.clean.revision)
      ? fallbackCopy : databaseCopy;
    if(latest && (!deviceState.durableBaseSnapshot || latest.clean.revision > deviceState.durableRevision)){
      deviceState.migratedV7Revision = storedV7Revision(latest.raw);
      applyValidatedState(latest.clean);
      deviceState.durableRevision = latest.clean.revision;
      deviceState.durableBaseSnapshot = buildSnapshot();
      renderAll();
    }
    return;
  }
}

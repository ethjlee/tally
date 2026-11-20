import { cloudSnapshotContentEqual, snapshotContentEqual } from "../ledger/merge.js";
import { snapshotFromClean } from "../ledger/snapshot.js";
import { CLIENT_ID, cloudState, deviceState } from "../state.js";
import { openDatabase, safeLocalGet } from "../storage/database.js";
import {
  CLOUD_BASE_FALLBACK_KEY,
  DB_NAME,
  EMERGENCY_STATE_KEY,
  FALLBACK_PREVIOUS_KEY,
  FALLBACK_STATE_KEY,
  LEGACY_CLOUD_BASE_FALLBACK_KEY,
  LEGACY_LOCAL_SNAPSHOTS,
  PENDING_CLOUD_WRITE_FALLBACK_KEY,
  RECOVERY_STATE_KEY,
  TRUSTED_DEVICE_FALLBACK_KEY,
  V7_LOCAL_SNAPSHOTS,
  V7_MIGRATION_BASE_FALLBACK_KEY
} from "../storage/keys.js";
import { SCHEMA_VERSION } from "../../shared/ledger-contract.ts";
import { parseStoredSnapshot, refreshDurableState, withPersistenceLock } from "../storage/persistence.js";
import { readCurrentCopies, readV7Head, recoverV7Changes } from "../storage/recovery.js";
import { fetchWithTimeout, revokeTrustedDevice } from "./access.js";
import { syncCloudNow } from "./cloud.js";
import { showConfirm } from "../ui/dialog.js";
import { showStorageBanner } from "../ui/storage.js";

export function closeDeviceDatabase(){
  try{ if(deviceState.tallyDb) deviceState.tallyDb.close(); }catch(e){}
  deviceState.tallyDb = null;
}

export function clearTallyLocalStorage(){
  const keys = [
    FALLBACK_STATE_KEY, FALLBACK_PREVIOUS_KEY, EMERGENCY_STATE_KEY,
    RECOVERY_STATE_KEY, CLOUD_BASE_FALLBACK_KEY, PENDING_CLOUD_WRITE_FALLBACK_KEY, TRUSTED_DEVICE_FALLBACK_KEY,
    ...V7_LOCAL_SNAPSHOTS.map(([key]) => key), 'tally-cloud-base-v7', V7_MIGRATION_BASE_FALLBACK_KEY,
    ...LEGACY_LOCAL_SNAPSHOTS.map(([key]) => key), LEGACY_CLOUD_BASE_FALLBACK_KEY,
    'tally-data', 'tally-settings'
  ];
  let storage;
  try{
    storage = window.localStorage;
  }catch(error){
    if(!deviceState.canUseLocalStorage && error.name === 'SecurityError') return;
    throw error;
  }
  for(const key of keys) storage.removeItem(key);
}

function checkEmergencyCopy(){
  const raw = safeLocalGet(EMERGENCY_STATE_KEY);
  if(!raw) return;
  const copy = parseStoredSnapshot(raw);
  if(!copy || (copy.clean.revision >= deviceState.durableRevision &&
      !snapshotContentEqual(snapshotFromClean(copy.clean), deviceState.durableBaseSnapshot))){
    throw new Error('UNSYNCED_EMERGENCY_COPY');
  }
}

export function showDeviceClearScreen(message, action){
  const loading = document.getElementById('loadingScreen');
  const status = document.createElement('div');
  status.setAttribute('role', 'status');
  status.textContent = message;
  document.body.classList.add('device-clear-active');
  loading.replaceChildren(status);
  loading.style.display = 'flex';
  if(action){
    loading.appendChild(action);
    action.focus();
  }
}

function deleteDeviceDatabase(){
  if(!window.indexedDB) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onblocked = () => {
      showDeviceClearScreen('Close other Tally tabs to finish removing the device copy.');
    };
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('DATABASE_DELETE_FAILED'));
  });
}

async function finishDeviceClear(hadDatabase){
  showDeviceClearScreen('Removing the device copy…');
  try{
    await withPersistenceLock(async () => {
      if(hadDatabase && !deviceState.tallyDb) deviceState.tallyDb = await openDatabase();
      await refreshDurableState();
      const lateProblems = [];
      const lateV7Head = await readV7Head([], lateProblems, deviceState.migratedV7Revision);
      if(lateV7Head || lateProblems.length || !cloudSnapshotContentEqual(deviceState.durableBaseSnapshot, cloudState.cloudBaseSnapshot)){
        throw new Error('LOCAL_STATE_CHANGED_AFTER_SYNC');
      }
      checkEmergencyCopy();
      closeDeviceDatabase();
      await deleteDeviceDatabase();
      checkEmergencyCopy();
      clearTallyLocalStorage();
    });
    if('caches' in window){
      try{
        const names = await caches.keys();
        await Promise.all(names.filter(name => name.startsWith('tally-')).map(name => caches.delete(name)));
      }catch(e){}
    }
    if(deviceState.syncChannel) deviceState.syncChannel.postMessage({ type:'clear-device', writerId:CLIENT_ID });
    window.location.replace('/login');
  }catch(error){
    if(error.message === 'LOCAL_STATE_CHANGED_AFTER_SYNC' || error.message === 'UNSYNCED_EMERGENCY_COPY'){
      const signIn = document.createElement('a');
      signIn.href = '/login';
      signIn.textContent = 'Sign in';
      showDeviceClearScreen('The device copy changed during sign-out. Sign in to sync the remaining changes.', signIn);
      if(deviceState.syncChannel) deviceState.syncChannel.postMessage({ type:'cancel-clear-device', writerId:CLIENT_ID });
      return;
    }
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry device cleanup';
    retry.addEventListener('click', () => finishDeviceClear(hadDatabase), { once:true });
    showDeviceClearScreen('Signed out. Tally could not remove the device copy.', retry);
  }
}

async function requestDeviceSignOut(hadDatabase){
  showDeviceClearScreen('Signing out…');
  try{
    await revokeTrustedDevice();
    const { response, payload } = await fetchWithTimeout('/api/auth/sign-out', {
      method:'POST',
      credentials:'same-origin',
      headers:{ 'Content-Type':'application/json' },
      body:'{}'
    });
    if(response.status !== 401 && (!response.ok || payload?.success !== true)) throw new Error('SIGN_OUT_FAILED');
  }catch(error){
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = 'Retry sign-out';
    retry.addEventListener('click', () => requestDeviceSignOut(hadDatabase), { once:true });
    showDeviceClearScreen('Tally couldn’t confirm sign-out. Your ledger is locked on this device.', retry);
    return;
  }
  await finishDeviceClear(hadDatabase);
}

export async function signOutAndClearDevice(){
  if(deviceState.clearingDevice || deviceState.peerClearingDevice) return;
  const confirmed = await showConfirm(
    'Sync the latest ledger, sign out, and remove Tally’s on-device database from this browser? Your encrypted cloud copy and exported backups stay intact.',
    'Sign out'
  );
  if(!confirmed) return;

  deviceState.clearingDevice = true;
  showDeviceClearScreen('Syncing before signing out…');
  try{
    if(deviceState.syncChannel) deviceState.syncChannel.postMessage({ type:'prepare-clear-device', writerId:CLIENT_ID });
    if(cloudState.cloudSyncInFlight) await cloudState.cloudSyncInFlight;
    await refreshDurableState();
    checkEmergencyCopy();
    const v7Copies = [];
    const problems = [];
    const head = await readV7Head(v7Copies, problems, deviceState.migratedV7Revision);
    if(problems.length) throw new Error('V7_STATE_UNREADABLE');
    if(head){
      const currentCopies = [];
      await readCurrentCopies(currentCopies, problems);
      await recoverV7Changes(head, v7Copies, currentCopies.filter(copy => copy.schemaVersion === SCHEMA_VERSION), problems, true);
    }
    if(!await syncCloudNow()) throw new Error('SYNC_NOT_CONFIRMED');
    checkEmergencyCopy();
  }catch(error){
    if(deviceState.syncChannel) deviceState.syncChannel.postMessage({ type:'cancel-clear-device', writerId:CLIENT_ID });
    deviceState.clearingDevice = false;
    if(deviceState.startupBlocked) return;
    document.body.classList.remove('device-clear-active');
    document.getElementById('loadingScreen').style.display = 'none';
    showStorageBanner(error.message === 'UNSYNCED_EMERGENCY_COPY'
      ? 'Sign-out stopped because an unsynced emergency copy is still on this device. Reopen Tally to recover it before signing out.'
      : 'Sign-out cleanup stopped. Your device copy is still available. Check sync and try again.');
    return;
  }
  deviceState.appReady = false;
  cloudState.cloudEnabled = false;
  await requestDeviceSignOut(!!deviceState.tallyDb);
}

import { uid } from "../ledger/id.js";
import { buildSnapshot, validateBackupObject } from "../ledger/snapshot.js";
import { deviceState } from "../state.js";
import { idbHealthCheck } from "../storage/database.js";

export function showStorageBanner(message, sticky){
  const el = document.getElementById('storageBanner');
  if(!el) return;
  if(sticky) deviceState.stickyStorageWarning = true;
  el.querySelector('.banner-text').textContent = message;
  el.classList.add('show');
}
export function dismissStorageBanner(){
  const el = document.getElementById('storageBanner');
  if(!el) return;
  deviceState.stickyStorageWarning = false;
  el.classList.remove('show');
}
export function showSaveWarning(){
  showStorageBanner("Couldn't save your last change. Keep the app open and save a backup from Data before closing it.");
}
export function hideSaveWarning(){
  const el = document.getElementById('storageBanner');
  if(el.classList.contains('show')) el.classList.remove('show');
}

export async function updateStorageStatus(){
  const el = document.getElementById('storageStatusEl');
  if(!el) return;
  let persisted = false;
  let usageText = '';
  try{
    if(navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted();
    if(navigator.storage && navigator.storage.estimate){
      const estimate = await navigator.storage.estimate();
      if(Number.isFinite(estimate.usage)) usageText = ` · ${Math.max(1, Math.round(estimate.usage / 1024))} KB used`;
    }
  }catch(e){}
  const modeLabel = deviceState.storageMode === 'indexedDB' ? 'On-device database + recovery mirrors' : deviceState.storageMode === 'localStorage' ? 'Browser storage fallback + rotating recovery' : 'Memory only';
  const persistenceLabel = persisted ? 'persistent storage granted' : 'best-effort storage';
  el.innerHTML = `<strong>${modeLabel}</strong><br>${persistenceLabel}${usageText}. Keep an external backup for protection from device loss or cleared browser data.`;
}
export async function runStorageHealthCheck(){
  const button = document.getElementById('storageCheckBtn');
  const status = document.getElementById('storageHealthEl');
  if(button.disabled) return;
  button.disabled = true;
  status.className = 'manage-sub';
  status.textContent = 'Checking snapshot integrity and storage write/read paths…';

  let snapshotOk = false;
  let databaseOk = false;
  let mirrorOk = false;
  try{
    validateBackupObject(buildSnapshot(), false);
    snapshotOk = true;
  }catch(e){}
  if(deviceState.tallyDb){
    try{
      await idbHealthCheck();
      databaseOk = true;
    }catch(e){}
  }
  try{
    const key = `tally-health-probe-${uid()}`;
    const token = uid();
    window.localStorage.setItem(key, token);
    mirrorOk = window.localStorage.getItem(key) === token;
    window.localStorage.removeItem(key);
  }catch(e){
    mirrorOk = false;
  }

  const checked = new Date().toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
  const primaryOk = deviceState.tallyDb ? databaseOk : mirrorOk;
  if(snapshotOk && primaryOk && (!deviceState.tallyDb || mirrorOk)){
    status.className = 'manage-sub success';
    status.textContent = `${deviceState.tallyDb ? 'Database and recovery mirror' : 'Browser storage fallback'} verified · ${checked}`;
  }else if(snapshotOk && databaseOk){
    status.className = 'manage-sub error';
    status.textContent = `Database verified, but the recovery mirror is unavailable · ${checked}`;
  }else{
    status.className = 'manage-sub error';
    status.textContent = `Storage check failed. Keep the app open and save a complete backup now · ${checked}`;
  }
  button.disabled = false;
  updateStorageStatus();
}
export async function requestPersistentStorage(){
  try{
    if(navigator.storage && navigator.storage.persisted && navigator.storage.persist){
      const already = await navigator.storage.persisted();
      if(!already) await navigator.storage.persist();
    }
  }catch(e){}
  updateStorageStatus();
}

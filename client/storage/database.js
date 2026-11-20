import { uid } from "../ledger/id.js";
import { valuesEqual } from "../ledger/merge.js";
import { CLIENT_ID, deviceState } from "../state.js";
import {
  DB_NAME,
  DB_STORE,
  DB_VERSION,
  PREVIOUS_STATE_KEY,
  RECOVERY_KEY,
  RECOVERY_STATE_KEY,
  STATE_KEY,
  V7_MIGRATION_BASE_KEY
} from "./keys.js";
import { parseStoredSnapshot, snapshotForStorage } from "./persistence.js";
import { updateStorageStatus } from "../ui/storage.js";

export function probeLocalStorage(){
  try{
    const key = `tally-probe-${uid()}`;
    window.localStorage.setItem(key, '1');
    const ok = window.localStorage.getItem(key) === '1';
    window.localStorage.removeItem(key);
    return ok;
  }catch(e){
    return false;
  }
}
export function safeLocalGet(key){
  try{ return window.localStorage.getItem(key); }catch(e){ return null; }
}
export function safeLocalSet(key, value){
  if(!deviceState.canUseLocalStorage) return false;
  try{ window.localStorage.setItem(key, value); return true; }catch(e){ return false; }
}
export function safeLocalRemove(key){
  try{ window.localStorage.removeItem(key); }catch(e){}
}

export function openDatabase(){
  return new Promise((resolve, reject) => {
    if(!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    let req;
    try{ req = indexedDB.open(DB_NAME, DB_VERSION); }
    catch(e){ reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if(!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        if(deviceState.tallyDb === db){
          deviceState.tallyDb = null;
          deviceState.storageMode = deviceState.canUseLocalStorage ? 'localStorage' : 'memory';
          updateStorageStatus();
        }
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error || new Error('Could not open the database'));
  });
}
export function idbGet(key){
  return new Promise((resolve, reject) => {
    const tx = deviceState.tallyDb.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
export function idbWriteTransaction(keys, update){
  return new Promise((resolve, reject) => {
    let tx;
    try{
      tx = deviceState.tallyDb.transaction(DB_STORE, 'readwrite', { durability:'strict' });
    }catch(e){
      tx = deviceState.tallyDb.transaction(DB_STORE, 'readwrite');
    }
    const store = tx.objectStore(DB_STORE);
    const records = {};
    let remaining = keys.length;
    let result;
    for(const key of keys){
      const request = store.get(key);
      request.onsuccess = () => {
        records[key] = request.result;
        if(--remaining === 0) result = update(records, store);
      };
    }
    tx.oncomplete = () => resolve(result);
    tx.onabort = () => reject(tx.error || new Error('Database write was aborted'));
  });
}
export function idbPut(key, value, shouldWrite){
  return new Promise((resolve, reject) => {
    let tx;
    try{
      tx = deviceState.tallyDb.transaction(DB_STORE, 'readwrite', { durability:'strict' });
    }catch(e){
      tx = deviceState.tallyDb.transaction(DB_STORE, 'readwrite');
    }
    const store = tx.objectStore(DB_STORE);
    let written = false;
    const write = () => {
      store.put(value, key);
      written = true;
    };
    if(shouldWrite){
      const current = store.get(key);
      current.onsuccess = () => {
        if(shouldWrite(current.result)) write();
      };
    }else{
      write();
    }
    tx.oncomplete = () => resolve(written);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Database write was aborted'));
  });
}
export function idbHealthCheck(){
  return new Promise((resolve, reject) => {
    if(!deviceState.tallyDb) return reject(new Error('Database is not active'));
    let tx;
    try{
      try{
        tx = deviceState.tallyDb.transaction(DB_STORE, 'readwrite', { durability:'strict' });
      }catch(e){
        tx = deviceState.tallyDb.transaction(DB_STORE, 'readwrite');
      }
      const store = tx.objectStore(DB_STORE);
      const key = `health-${CLIENT_ID}`;
      const token = { id:uid(), checkedAt:new Date().toISOString() };
      store.put(token, key);
      const read = store.get(key);
      let matched = false;
      read.onsuccess = () => {
        matched = valuesEqual(read.result, token);
      };
      store.delete(key);
      tx.oncomplete = () => matched ? resolve(true) : reject(new Error('Database read-back did not match'));
      tx.onerror = () => reject(tx.error || new Error('Database health transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('Database health transaction was aborted'));
    }catch(error){
      reject(error);
    }
  });
}
export function idbWriteState(snapshot, expectedRevision, preserveSameRevision = false){
  const stored = snapshotForStorage(snapshot);
  const migrationBase = deviceState.pendingV7MigrationBase;
  return new Promise((resolve, reject) => {
    let tx;
    try{
      tx = deviceState.tallyDb.transaction(DB_STORE, 'readwrite', { durability:'strict' });
    }catch(e){
      tx = deviceState.tallyDb.transaction(DB_STORE, 'readwrite');
    }
    const store = tx.objectStore(DB_STORE);
    const current = store.get(STATE_KEY);
    let outcome = { status:'written', latest:null };
    current.onsuccess = () => {
      const validCurrent = parseStoredSnapshot(current.result);
      const currentRevision = validCurrent?.clean.revision;
      if(validCurrent && (currentRevision > expectedRevision ||
          (preserveSameRevision && currentRevision === expectedRevision))){
        outcome = { status:'conflict', latest:current.result };
        return;
      }
      if(validCurrent) store.put(current.result, PREVIOUS_STATE_KEY);
      store.put(stored, STATE_KEY);
      if(migrationBase && migrationBase.revision === stored.migratedV7Revision){
        store.put(migrationBase, V7_MIGRATION_BASE_KEY);
      }
    };
    current.onerror = () => reject(current.error || new Error('Could not read current database state'));
    tx.oncomplete = () => resolve(outcome);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Database write was aborted'));
  });
}
export async function saveRecoverySnapshot(label, snapshot){
  const stored = snapshotForStorage(snapshot);
  let saved = false;
  try{
    if(deviceState.tallyDb){
      await idbPut(RECOVERY_KEY, { ...stored, recoveryLabel:label, recoveredAt:new Date().toISOString() });
      saved = true;
    }
  }catch(e){
    console.warn('Tally: recovery snapshot could not be saved', e);
  }
  if(safeLocalSet(RECOVERY_STATE_KEY, JSON.stringify(stored))) saved = true;
  return saved;
}

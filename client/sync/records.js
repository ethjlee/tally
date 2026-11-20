import { snapshotContentEqual } from "../ledger/merge.js";
import { SAFE_ID, snapshotFromClean, validateBackupObject } from "../ledger/snapshot.js";
import { deviceState, ledgerState } from "../state.js";
import { idbGet, idbPut, safeLocalGet, safeLocalRemove, safeLocalSet } from "../storage/database.js";
import {
  CLOUD_BASE_FALLBACK_KEY,
  CLOUD_BASE_KEY,
  LEGACY_CLOUD_BASE_FALLBACK_KEY,
  LEGACY_CLOUD_BASE_KEY,
  PENDING_CLOUD_WRITE_FALLBACK_KEY,
  PENDING_CLOUD_WRITE_KEY
} from "../storage/keys.js";
import { withPersistenceLock } from "../storage/persistence.js";

export function readFallbackCloudRecord(key = CLOUD_BASE_FALLBACK_KEY){
  try{ return JSON.parse(safeLocalGet(key)); }catch(e){ return null; }
}

export function parseCloudBaseRecord(raw){
  try{
    if(!raw || !Number.isSafeInteger(raw.cloudRevision) || raw.cloudRevision < 0 ||
        (raw.cloudRevision === 0 && raw.snapshot !== null)) return null;
    const snapshot = raw.cloudRevision ? snapshotFromClean(validateBackupObject(raw.snapshot, false)) : null;
    const localRevision = Number.isSafeInteger(raw.localRevision) && raw.localRevision >= 0 ? raw.localRevision : null;
    const resetRevision = Number.isSafeInteger(raw.resetRevision) && raw.resetRevision > 0 ? raw.resetRevision : 0;
    return { cloudRevision:raw.cloudRevision, localRevision, resetRevision, snapshot };
  }catch(e){
    return null;
  }
}

export function newerCloudBase(database, fallback){
  if(!database || !fallback) return database || fallback;
  if(database.resetRevision !== fallback.resetRevision){
    return database.resetRevision > fallback.resetRevision ? database : fallback;
  }
  if(database.cloudRevision !== fallback.cloudRevision){
    return database.cloudRevision > fallback.cloudRevision ? database : fallback;
  }
  return (database.localRevision ?? -1) >= (fallback.localRevision ?? -1) ? database : fallback;
}

export function sameCloudBase(a, b){
  return a === b || !!a && !!b && a.resetRevision === b.resetRevision &&
    a.cloudRevision === b.cloudRevision && a.localRevision === b.localRevision &&
    (a.snapshot === b.snapshot || snapshotContentEqual(a.snapshot, b.snapshot));
}

async function newestCloudBaseRecord(databaseKey, fallbackKey){
  let database = null;
  try{
    if(deviceState.tallyDb) database = parseCloudBaseRecord(await idbGet(databaseKey));
  }catch(e){}
  return newerCloudBase(database, parseCloudBaseRecord(readFallbackCloudRecord(fallbackKey)));
}

export function readCloudBaseRecord(){
  return newestCloudBaseRecord(CLOUD_BASE_KEY, CLOUD_BASE_FALLBACK_KEY);
}

export async function migrateLegacyCloudBase(dbKey = LEGACY_CLOUD_BASE_KEY, localKey = LEGACY_CLOUD_BASE_FALLBACK_KEY){
  try{
    const record = await newestCloudBaseRecord(dbKey, localKey);
    if(!record) return;
    if(deviceState.tallyDb){
      await idbPut(CLOUD_BASE_KEY, record, current => current === undefined);
    }else if(!safeLocalGet(CLOUD_BASE_FALLBACK_KEY)){
      safeLocalSet(CLOUD_BASE_FALLBACK_KEY, JSON.stringify(record));
    }
  }catch(e){}
}

export function writeFallbackCloudRecord(record, ledger){
  // One storage write publishes the ledger and its cloud revision together.
  // Keep the committed ledger available even if its separate mirror fails.
  const committed = ledger || readFallbackCloudRecord()?.ledger;
  return safeLocalSet(CLOUD_BASE_FALLBACK_KEY, JSON.stringify({ ...record, ledger:committed }));
}

export function parsePendingCloudWrite(raw){
  try{
    const write = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if(!write || !Number.isSafeInteger(write.baseRevision) || write.baseRevision < 0 ||
        typeof write.operationId !== 'string' || !SAFE_ID.test(write.operationId)) return null;
    if(write.resetRevision !== undefined && (!Number.isSafeInteger(write.resetRevision) || write.resetRevision < 0)) return null;
    validateBackupObject(write.snapshot);
    return write;
  }catch(e){
    return null;
  }
}

export function fallbackPendingCloudWrite(){
  return parsePendingCloudWrite(safeLocalGet(PENDING_CLOUD_WRITE_FALLBACK_KEY));
}

export async function readPendingCloudWrite(){
  try{
    if(deviceState.tallyDb){
      const database = parsePendingCloudWrite(await idbGet(PENDING_CLOUD_WRITE_KEY));
      if(database) return database;
    }
  }catch(e){}
  return fallbackPendingCloudWrite();
}

export async function queuePendingCloudWrite(write, expectedBase){
  await withPersistenceLock(async () => {
    const base = await readCloudBaseRecord();
    if(!sameCloudBase(base, expectedBase) || ledgerState.stateRevision !== write.snapshot.revision) return;
    if(deviceState.peerClearingDevice || fallbackPendingCloudWrite()) return;
    try{
      if(deviceState.tallyDb){
        if(await idbPut(PENDING_CLOUD_WRITE_KEY, write, current => !parsePendingCloudWrite(current))){
          safeLocalSet(PENDING_CLOUD_WRITE_FALLBACK_KEY, JSON.stringify(write));
        }
        return;
      }
    }catch(e){}
    if(!safeLocalSet(PENDING_CLOUD_WRITE_FALLBACK_KEY, JSON.stringify(write))){
      throw new Error('CLOUD_RETRY_STORAGE_FAILED');
    }
  });
}

export async function clearPendingCloudWrite(operationId){
  await withPersistenceLock(async () => {
    const database = deviceState.tallyDb ? await idbGet(PENDING_CLOUD_WRITE_KEY).catch(() => null) : null;
    if(database?.operationId === operationId){
      await idbPut(PENDING_CLOUD_WRITE_KEY, null, current => current?.operationId === operationId);
    }
    const fallback = fallbackPendingCloudWrite();
    if(!fallback || fallback.operationId === operationId){
      safeLocalRemove(PENDING_CLOUD_WRITE_FALLBACK_KEY);
    }
  });
}

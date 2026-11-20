import { uid } from "../ledger/id.js";
import {
  cloudMergeBase,
  cloudSnapshotContentEqual,
  mergeConcurrentSnapshots,
  snapshotContentEqual,
  snapshotWithReminderCadence,
  valuesEqual
} from "../ledger/merge.js";
import { hasAnyLedgerData } from "../ledger/scoring.js";
import {
  buildSnapshot,
  snapshotFromClean,
  validateBackupObject,
  validateSyncCollections
} from "../ledger/snapshot.js";
import {
  CLIENT_ID,
  DEFAULT_BACKUP_REMINDER_DAYS,
  cloudState,
  deviceState,
  ledgerState
} from "../state.js";
import { applyValidatedState } from "../storage/apply-state.js";
import {
  idbPut,
  idbWriteTransaction,
  safeLocalRemove,
  saveRecoverySnapshot
} from "../storage/database.js";
import {
  CLOUD_BASE_KEY,
  PENDING_CLOUD_WRITE_FALLBACK_KEY,
  PENDING_CLOUD_WRITE_KEY,
  PREVIOUS_STATE_KEY,
  STATE_KEY
} from "../storage/keys.js";
import { MAX_SYNC_BYTES } from "../../shared/ledger-contract.ts";
import {
  finishDurableWrite,
  parseStoredSnapshot,
  readFallbackLedger,
  refreshDurableState,
  snapshotForStorage,
  startPersistence,
  withPersistenceLock
} from "../storage/persistence.js";
import { fetchWithTimeout, handleSessionRejection, verifyCloudAccess } from "./access.js";
import {
  clearPendingCloudWrite,
  fallbackPendingCloudWrite,
  newerCloudBase,
  parseCloudBaseRecord,
  parsePendingCloudWrite,
  queuePendingCloudWrite,
  readCloudBaseRecord,
  readFallbackCloudRecord,
  readPendingCloudWrite,
  sameCloudBase,
  writeFallbackCloudRecord
} from "./records.js";
import { renderCloudStatus, setCloudStatus } from "../ui/cloud-status.js";
import { showConfirm } from "../ui/dialog.js";
import { renderAll } from "../ui/render.js";
import { showStorageBanner } from "../ui/storage.js";

async function fetchCloudState(){
  const { response, payload } = await fetchWithTimeout('/api/sync', {
    credentials:'same-origin',
    cache:'no-store',
    headers:{ 'Accept':'application/json' }
  }, 15000);
  if(response.status === 401){
    await handleSessionRejection();
    throw new Error('UNAUTHORIZED');
  }
  if(!response.ok || !payload) throw new Error(payload?.error || 'CLOUD_READ_FAILED');
  return payload;
}

function setConfirmedCloudBase(record, updatedAt){
  cloudState.cloudBaseSnapshot = record.snapshot;
  cloudState.cloudLastSyncedAt = updatedAt || null;
}

function validatedCloudSnapshot({ cloudRevision, snapshot }){
  if(!Number.isSafeInteger(cloudRevision) || cloudRevision < 0 || (cloudRevision === 0) !== (snapshot === null)){
    throw new Error('INVALID_CLOUD_STATE');
  }
  return snapshot === null ? null : snapshotFromClean(validateBackupObject(snapshot));
}

async function captureCloudCheckpoint(){
  await refreshDurableState();
  const localRevision = deviceState.durableRevision;
  return { localRevision, base:await readCloudBaseRecord() };
}

function commitCloudRecords(checkpoint, record, snapshot){
  const ledger = snapshot && snapshotForStorage(snapshot);
  const update = (records, store) => {
    if(deviceState.peerClearingDevice || ledgerState.stateRevision !== checkpoint.localRevision) return false;
    const fallback = readFallbackCloudRecord();
    const base = newerCloudBase(parseCloudBaseRecord(records[CLOUD_BASE_KEY]), parseCloudBaseRecord(fallback));
    const current = parseStoredSnapshot(records[STATE_KEY]);
    if(!sameCloudBase(base, checkpoint.base) ||
        Math.max(current?.clean.revision ?? 0, readFallbackLedger()?.clean.revision ?? 0) > checkpoint.localRevision ||
        parsePendingCloudWrite(records[PENDING_CLOUD_WRITE_KEY]) || fallbackPendingCloudWrite()){
      return false;
    }
    if(store){
      if(ledger){
        if(current) store.put(current.raw, PREVIOUS_STATE_KEY);
        store.put(ledger, STATE_KEY);
      }
      if(!sameCloudBase(base, record) || !records[CLOUD_BASE_KEY]) store.put(record, CLOUD_BASE_KEY);
      if(records[PENDING_CLOUD_WRITE_KEY]) store.delete(PENDING_CLOUD_WRITE_KEY);
    }else if((ledger || !sameCloudBase(base, record)) && !writeFallbackCloudRecord(record, ledger)){
      throw new Error('CLOUD_BASE_STORAGE_FAILED');
    }
    return true;
  };
  return deviceState.tallyDb
    ? idbWriteTransaction([STATE_KEY, CLOUD_BASE_KEY, PENDING_CLOUD_WRITE_KEY], update)
    : update({});
}

function commitCloudReconciliation(checkpoint, remote, remoteSnapshot, candidate, reset = false){
  if(deviceState.persistInFlight || ledgerState.stateRevision !== checkpoint.localRevision) return false;
  return startPersistence(async () => {
    const before = buildSnapshot();
    const snapshot = candidate && {
      ...snapshotWithReminderCadence(candidate, before.settings.backupReminderDays),
      revision:Math.max(before.revision, checkpoint.base?.resetRevision ?? 0) + 1,
      writerId:CLIENT_ID, savedAt:new Date().toISOString()
    };
    const clean = snapshot && validateBackupObject(snapshot, false);
    const record = {
      cloudRevision:remote.cloudRevision, snapshot:remoteSnapshot,
      localRevision:snapshot?.revision ?? before.revision,
      resetRevision:reset ? snapshot.revision : checkpoint.base?.resetRevision ?? 0
    };
    let committed;
    try{
      committed = await withPersistenceLock(() => commitCloudRecords(checkpoint, record, snapshot));
    }catch(error){
      throw new Error('CLOUD_BASE_STORAGE_FAILED', { cause:error });
    }
    if(!committed || deviceState.peerClearingDevice) return false;
    setConfirmedCloudBase(record, remote.updatedAt);
    if(!fallbackPendingCloudWrite()) safeLocalRemove(PENDING_CLOUD_WRITE_FALLBACK_KEY);
    if(snapshot){
      // A queued local save will detect the new durable revision and merge it
      // through the same recovery path used for edits from another tab.
      if(ledgerState.stateRevision !== before.revision) return record;
      finishDurableWrite(snapshot);
      applyValidatedState(clean);
      renderAll();
    }
    return record;
  });
}

async function reconcileCloudState(remote, checkpoint = null){
  const remoteSnapshot = validatedCloudSnapshot(remote);
  if(!checkpoint) checkpoint = await captureCloudCheckpoint();
  await refreshDurableState();
  if(deviceState.persistInFlight || ledgerState.stateRevision !== checkpoint.localRevision ||
      !sameCloudBase(checkpoint.base, await readCloudBaseRecord())) return false;
  if(deviceState.unreadableLocalState) throw new Error('LOCAL_STATE_UNREADABLE');
  const localSnapshot = buildSnapshot();
  // Older releases may have saved a base before its merge was durable.
  const stored = checkpoint.base;
  const confirmed = stored?.localRevision != null && stored.localRevision <= deviceState.durableRevision;
  if(stored?.localRevision != null && (stored.cloudRevision > remote.cloudRevision ||
      (stored.cloudRevision === remote.cloudRevision && remoteSnapshot && !snapshotContentEqual(stored.snapshot, remoteSnapshot)))){
    return 'rollback';
  }
  const cadence = localSnapshot.settings.backupReminderDays;
  const incoming = remoteSnapshot && snapshotWithReminderCadence(remoteSnapshot, cadence);
  const base = confirmed && stored.snapshot ? snapshotWithReminderCadence(stored.snapshot, cadence) : null;
  let candidate = null;
  let hadConflict = false;
  if(!deviceState.durableBaseSnapshot){
    // Establish a durable ledger even when its contents match the cloud or
    // both copies are empty. A later startup can then reuse its settings.
    candidate = incoming || localSnapshot;
  }else if(incoming && !snapshotContentEqual(localSnapshot, incoming) && !snapshotContentEqual(base, incoming)){
    candidate = incoming;
    if(base ? !snapshotContentEqual(base, localSnapshot) : (deviceState.durableRevision > 0 || hasAnyLedgerData())){
      // With no confirmed ancestry, combine independent records and retain the
      // cloud version of shared records. The incoming local copy remains recoverable.
      const merged = base
        ? mergeConcurrentSnapshots(base, localSnapshot, incoming)
        : mergeConcurrentSnapshots(cloudMergeBase(localSnapshot), incoming, localSnapshot);
      candidate = merged.snapshot;
      hadConflict = merged.hadDirectConflict;
      // The recovery copy uses the local revision so startup cannot mistake a
      // higher remote device revision for a newer on-device save.
      const recovery = base && hadConflict
        ? { ...remoteSnapshot, revision:localSnapshot.revision }
        : localSnapshot;
      if(!await saveRecoverySnapshot('pre-cloud-merge', recovery)) throw new Error('RECOVERY_SAVE_FAILED');
    }
  }
  if(deviceState.durableBaseSnapshot && snapshotContentEqual(candidate, localSnapshot)) candidate = null;
  const record = await commitCloudReconciliation(checkpoint, remote, remoteSnapshot, candidate);
  if(record && hadConflict){
    showStorageBanner(
      base
        ? 'Two devices changed the same item. Tally kept the device edit where both copies edited the same record and saved the cloud copy for recovery.'
        : 'These copies have no confirmed common revision. Tally kept cloud versions of shared records and saved the incoming device copy for review.',
      true
    );
  }
  return record;
}

export async function initializeCloudSync(){
  await syncCloudNow();
}

export function queueCloudSnapshot(snapshot){
  if(!cloudState.cloudEnabled || deviceState.clearingDevice || deviceState.peerClearingDevice || cloudState.cloudRollback) return;
  if(cloudSnapshotContentEqual(snapshot, cloudState.cloudBaseSnapshot)) return;
  cloudState.cloudRefreshRequested = true;
  if(cloudState.cloudSyncInFlight) return;
  clearTimeout(cloudState.cloudSyncTimer);
  cloudState.cloudSyncTimer = setTimeout(syncCloudNow, 600);
  setCloudStatus('syncing', 'A validated on-device save is waiting to upload.');
}

export function syncCloudNow(manual = false){
  if(deviceState.startupBlocked || deviceState.peerClearingDevice || (cloudState.cloudRollback && !manual) || cloudState.cloudRollbackResolving) return Promise.resolve(false);
  cloudState.cloudRefreshRequested = true;
  clearTimeout(cloudState.cloudSyncTimer);
  if(!cloudState.cloudSyncInFlight){
    cloudState.cloudSyncInFlight = runCloudSyncLoop().finally(() => {
      cloudState.cloudSyncInFlight = null;
      renderCloudStatus();
    });
  }
  return cloudState.cloudSyncInFlight;
}

async function runCloudSyncLoop(){
  let conflicts = 0;
  let rollbackCandidate = null;
  try{
    if(!navigator.onLine || (!cloudState.cloudEnabled && (!await verifyCloudAccess() || !cloudState.cloudEnabled))){
      setCloudStatus('offline', 'Changes stay on this device until the cloud is reachable.');
      return false;
    }
    while(cloudState.cloudRefreshRequested){
      if(deviceState.peerClearingDevice) return false;
      cloudState.cloudRefreshRequested = false;
      setCloudStatus('syncing', 'Checking for newer changes from your other devices.');
      const checkpoint = await captureCloudCheckpoint();
      const pending = await readPendingCloudWrite();
      if(pending){
        if((pending.resetRevision ?? 0) !== (checkpoint.base?.resetRevision ?? 0)){
          await clearPendingCloudWrite(pending.operationId);
        }else if(await sendPendingCloudWrite(pending)) conflicts = 0;
        else if(++conflicts > 5) throw new Error('REVISION_CONFLICT');
        cloudState.cloudRefreshRequested = true;
        continue;
      }
      const remote = await fetchCloudState();
      // Another tab can start an upload while this request is in flight.
      if(await readPendingCloudWrite()){
        cloudState.cloudRefreshRequested = true;
        continue;
      }
      const base = await reconcileCloudState(remote, checkpoint);
      if(base === 'rollback'){
        if(rollbackCandidate && sameCloudBase(checkpoint.base, rollbackCandidate.base) &&
            sameRemoteCloudState(remote, rollbackCandidate.remote)){
          cloudState.cloudRollback = { remote, base:checkpoint.base };
          cloudState.cloudRefreshRequested = false;
          const previous = checkpoint.base.cloudRevision;
          const detail = previous === remote.cloudRevision
            ? `The cloud has different ledger data at previously synced revision ${previous}.`
            : `This device last synced revision ${previous}. The cloud is now at revision ${remote.cloudRevision}.`;
          setCloudStatus('rollback', `${detail} Choose which ledger to keep.`);
          return false;
        }
        rollbackCandidate = { remote, base:checkpoint.base };
      }else rollbackCandidate = null;
      if(!base || base === 'rollback'){
        if(++conflicts > 5) throw new Error('STALE_CLOUD_STATE');
        cloudState.cloudRefreshRequested = true;
        continue;
      }
      cloudState.cloudRollback = null;
      if(deviceState.peerClearingDevice) return false;
      cloudState.lastCloudRefreshAt = Date.now();
      await refreshDurableState();
      if(deviceState.persistInFlight){
        cloudState.cloudRefreshRequested = true;
        continue;
      }
      // Use the copy covered by the local save, including any concurrent local edits.
      if(cloudSnapshotContentEqual(deviceState.durableBaseSnapshot, cloudState.cloudBaseSnapshot)) continue;
      // Older snapshots require a cadence field, so send the default on uploads.
      const snapshot = snapshotWithReminderCadence(deviceState.durableBaseSnapshot, DEFAULT_BACKUP_REMINDER_DAYS);
      validateSyncCollections(snapshot.data);
      const write = { baseRevision:base.cloudRevision, operationId:'op_' + uid() + '_' + uid(), snapshot };
      if(new TextEncoder().encode(JSON.stringify(write)).length > MAX_SYNC_BYTES) throw new Error('SYNC_SIZE_LIMIT');
      await queuePendingCloudWrite({ ...write, resetRevision:base.resetRevision }, base);
      cloudState.cloudRefreshRequested = true;
    }
    const when = cloudState.cloudLastSyncedAt
      ? new Date(cloudState.cloudLastSyncedAt).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })
      : 'just now';
    setCloudStatus('synced', 'Last confirmed ' + when + '. Postgres holds encrypted ciphertext; this device keeps the offline copy.');
    return true;
  }catch(error){
    const message = error.message === 'SYNC_SIZE_LIMIT' || error.message === 'PAYLOAD_TOO_LARGE'
      ? 'This ledger exceeds the cloud size limit. Export a complete backup to keep a portable copy.'
      : (error.code === 'SYNC_COLLECTION_LIMIT'
        ? error.message + ' Your local ledger is still available for export.'
        : error.message === 'CLOUD_RETRY_STORAGE_FAILED'
          ? 'Tally could not store the sync retry on this device. Free some browser storage and try again.'
          : error.message === 'CLOUD_BASE_STORAGE_FAILED'
            ? 'Tally could not save the cloud revision on this device. Free some browser storage and try again.'
          : 'Sync did not complete. Tally will check both copies again on the next sync.');
    setCloudStatus(navigator.onLine ? 'error' : 'offline', message);
    return false;
  }
}

function sameRemoteCloudState(a, b){
  return a.cloudRevision === b.cloudRevision && a.updatedAt === b.updatedAt && valuesEqual(a.snapshot, b.snapshot);
}

export async function resolveCloudRollback(choice){
  if(!cloudState.cloudRollback || cloudState.cloudRollbackResolving || cloudState.cloudSyncInFlight || deviceState.clearingDevice || deviceState.peerClearingDevice) return;
  const rollback = cloudState.cloudRollback;
  const keepCloud = choice === 'cloud';
  const label = keepCloud ? 'Keep cloud ledger' : 'Keep device ledger';
  const replaced = keepCloud ? 'this device’s ledger' : 'the restored cloud ledger';
  cloudState.cloudRollbackResolving = true;
  renderCloudStatus();
  try{
    const localRevision = ledgerState.stateRevision;
    if(!await showConfirm(`${label}? Tally will save a recovery copy before replacing ${replaced}.`, label)) return;
    setCloudStatus('syncing', 'Verifying the restored cloud ledger.');
    const checkpoint = await captureCloudCheckpoint();
    const local = buildSnapshot();
    const remoteSnapshot = validatedCloudSnapshot(rollback.remote);
    const recovery = keepCloud ? local : (remoteSnapshot || cloudMergeBase(local));
    if(localRevision !== checkpoint.localRevision || !sameCloudBase(checkpoint.base, rollback.base)){
      throw new Error('ROLLBACK_CHANGED');
    }
    if(!await saveRecoverySnapshot('before-cloud-rollback', { ...recovery, revision:local.revision })){
      throw new Error('RECOVERY_SAVE_FAILED');
    }
    const remote = await fetchCloudState();
    if(!sameRemoteCloudState(rollback.remote, remote)) throw new Error('ROLLBACK_CHANGED');
    const candidate = keepCloud ? (remoteSnapshot || cloudMergeBase(local)) : local;
    if(!await commitCloudReconciliation(checkpoint, remote, remoteSnapshot, candidate, true)){
      throw new Error('ROLLBACK_CHANGED');
    }
    cloudState.cloudRollback = null;
    cloudState.cloudRefreshRequested = true;
    cloudState.cloudSyncInFlight = runCloudSyncLoop();
    try{ await cloudState.cloudSyncInFlight; }finally{ cloudState.cloudSyncInFlight = null; }
  }catch(error){
    if(error.message === 'ROLLBACK_CHANGED'){
      cloudState.cloudRollback = null;
      setCloudStatus('error', 'A ledger changed while you were choosing. Select Sync now to check both copies again.');
    }else{
      setCloudStatus('error', 'Recovery stopped before replacing a ledger. Check your connection and browser storage, then try again.');
    }
  }finally{
    cloudState.cloudRollbackResolving = false;
    renderCloudStatus();
  }
}

async function acknowledgeCloudWrite(write, payload){
  await withPersistenceLock(async () => {
    if(deviceState.peerClearingDevice) throw new Error('DEVICE_CLEAR_IN_PROGRESS');
    const record = {
      cloudRevision:payload.cloudRevision, localRevision:write.snapshot.revision,
      snapshot:write.snapshot, resetRevision:write.resetRevision ?? 0
    };
    const fallback = () => parseCloudBaseRecord(readFallbackCloudRecord());
    const confirmed = raw => newerCloudBase(parseCloudBaseRecord(raw), fallback());
    const canAdvance = raw => {
      const current = confirmed(raw);
      return !current || (current.resetRevision === record.resetRevision &&
        (!current.snapshot || current.localRevision === null || newerCloudBase(record, current) === record));
    };
    let saved = false;
    try{
      if(deviceState.tallyDb){
        await idbPut(CLOUD_BASE_KEY, record, canAdvance);
        saved = true;
      }
    }catch(e){}
    if(!saved){
      const current = await readCloudBaseRecord();
      if(!canAdvance(current)) return;
      if(!writeFallbackCloudRecord(record)) throw new Error('CLOUD_RETRY_STORAGE_FAILED');
    }
  });
}

async function sendPendingCloudWrite(write){
  const { baseRevision, operationId, snapshot } = write;
  const { response, payload } = await fetchWithTimeout('/api/sync', {
    method:'PUT',
    credentials:'same-origin',
    cache:'no-store',
    headers:{ 'Content-Type':'application/json', 'Accept':'application/json' },
    body:JSON.stringify({ baseRevision, operationId, snapshot })
  }, 20000);
  if(response.status === 401){
    await handleSessionRejection();
    throw new Error('UNAUTHORIZED');
  }
  if(deviceState.peerClearingDevice) throw new Error('DEVICE_CLEAR_IN_PROGRESS');
  if(response.status === 409 || response.status === 400 || response.status === 413){
    await clearPendingCloudWrite(operationId);
    if(response.status === 409) return false;
    if(response.status === 413) throw new Error('PAYLOAD_TOO_LARGE');
  }
  if(!response.ok || !Number.isSafeInteger(payload?.cloudRevision) || payload.cloudRevision !== baseRevision + 1){
    throw new Error(payload?.error || 'CLOUD_WRITE_FAILED');
  }
  // Use the accepted snapshot as the common ancestor for edits made while its
  // response was missing.
  await acknowledgeCloudWrite(write, payload);
  await clearPendingCloudWrite(operationId);
  return true;
}

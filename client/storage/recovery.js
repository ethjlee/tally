import {
  cloneJson,
  cloudMergeBase,
  mergeConcurrentSnapshots,
  snapshotContentEqual
} from "../ledger/merge.js";
import { buildSnapshot, snapshotFromClean, validateBackupObject } from "../ledger/snapshot.js";
import { cloudState, deviceState, ledgerState } from "../state.js";
import { applyValidatedState } from "./apply-state.js";
import { idbGet, openDatabase, probeLocalStorage, safeLocalGet } from "./database.js";
import {
  EMERGENCY_STATE_KEY,
  FALLBACK_PREVIOUS_KEY,
  FALLBACK_STATE_KEY,
  LEGACY_DB_SNAPSHOTS,
  LEGACY_LOCAL_SNAPSHOTS,
  PREVIOUS_STATE_KEY,
  RECOVERY_KEY,
  RECOVERY_STATE_KEY,
  STATE_KEY,
  V7_DB_SNAPSHOTS,
  V7_LOCAL_SNAPSHOTS,
  V7_MIGRATION_BASE_FALLBACK_KEY,
  V7_MIGRATION_BASE_KEY
} from "./keys.js";
import { SCHEMA_VERSION } from "../../shared/ledger-contract.ts";
import {
  mirrorDurableSnapshot,
  parseStoredSnapshot,
  persistData,
  setupCrossWindowSync,
  storedV7Revision,
  withPersistenceLock,
  writeDurableSnapshot
} from "./persistence.js";
import { verifyCloudAccess } from "../sync/access.js";
import { initializeCloudSync } from "../sync/cloud.js";
import { migrateLegacyCloudBase, readFallbackCloudRecord } from "../sync/records.js";
import { renderCloudStatus } from "../ui/cloud-status.js";
import { renderAll } from "../ui/render.js";
import { requestPersistentStorage, showStorageBanner, updateStorageStatus } from "../ui/storage.js";

function parseCandidate(raw, source, candidates, problems, afterRevision = null){
  if(!raw) return;
  try{
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if(afterRevision !== null && (parsed?.schemaVersion !== 7 || parsed.revision <= afterRevision)) return;
    const clean = validateBackupObject(parsed, false);
    candidates.push({
      raw:parsed,
      clean,
      source,
      schemaVersion:Number.isInteger(parsed?.schemaVersion) ? parsed.schemaVersion : 1
    });
  }catch(e){
    problems.push(`${source}: ${e.message}`);
  }
}

async function readDatabaseCopies(sources, candidates, problems, afterRevision){
  if(!deviceState.tallyDb) return;
  for(const [key, source] of sources){
    try{ parseCandidate(await idbGet(key), source, candidates, problems, afterRevision); }
    catch(e){ problems.push(`${source}: ${e.message}`); }
  }
}

function readLocalCopies(sources, candidates, problems, afterRevision){
  for(const [key, source] of sources){
    parseCandidate(safeLocalGet(key), source, candidates, problems, afterRevision);
  }
}

export async function readCurrentCopies(candidates, problems){
  await readDatabaseCopies([[STATE_KEY, 'on-device database']], candidates, problems);
  parseCandidate(readFallbackCloudRecord()?.ledger, 'browser sync commit', candidates, problems);
  readLocalCopies([
    [EMERGENCY_STATE_KEY, 'emergency copy'],
    [FALLBACK_STATE_KEY, 'browser storage copy']
  ], candidates, problems);
  await readDatabaseCopies([
    [PREVIOUS_STATE_KEY, 'previous database copy'],
    [RECOVERY_KEY, 'database recovery copy']
  ], candidates, problems);
  readLocalCopies([
    [FALLBACK_PREVIOUS_KEY, 'previous browser storage copy'],
    [RECOVERY_STATE_KEY, 'browser recovery copy']
  ], candidates, problems);
}

export async function readV7Head(copies, problems, checkpoint){
  await readDatabaseCopies(V7_DB_SNAPSHOTS.slice(0,1), copies, problems, checkpoint);
  readLocalCopies(V7_LOCAL_SNAPSHOTS.slice(0,2), copies, problems, checkpoint);
  return copies.sort((a,b) => b.clean.revision - a.clean.revision).find(copy => copy.schemaVersion === 7);
}

function readOriginalLedger(candidates, problems){
  const legacyDataRaw = safeLocalGet('tally-data');
  if(!legacyDataRaw) return;
  try{
    const legacyData = JSON.parse(legacyDataRaw);
    const legacySettingsRaw = safeLocalGet('tally-settings');
    const legacySettings = legacySettingsRaw ? JSON.parse(legacySettingsRaw) : legacyData;
    parseCandidate({
      taskSections: legacyData.taskSections || [],
      habits: legacyData.habits || [],
      bonusTasks: legacyData.bonusTasks || [],
      entries: legacyData.entries || [],
      dailyBase: legacySettings.dailyBase,
      successThreshold: legacySettings.successThreshold,
      dayStartHour: legacySettings.dayStartHour,
      trackingStartDate: legacySettings.trackingStartDate,
      lastBackupAt: legacySettings.lastBackupAt,
      historyRangeDays: legacySettings.historyRangeDays
    }, 'legacy storage', candidates, problems);
  }catch(e){
    problems.push(`legacy storage: ${e.message}`);
  }
}

export async function recoverV7Changes(head, v7Copies, currentCopies, problems, requireBase = false){
  if(!head || (deviceState.migratedV7Revision !== null && head.clean.revision <= deviceState.migratedV7Revision)) return;

  await readDatabaseCopies(V7_DB_SNAPSHOTS.slice(1), v7Copies, problems);
  readLocalCopies(V7_LOCAL_SNAPSHOTS.slice(2), v7Copies, problems);
  v7Copies = v7Copies.filter(copy => copy.schemaVersion === 7);

  let remote = snapshotFromClean(head.clean);
  let base = null;
  if(deviceState.migratedV7Revision !== null){
    const checkpoints = [parseStoredSnapshot(safeLocalGet(V7_MIGRATION_BASE_FALLBACK_KEY))];
    try{ if(deviceState.tallyDb) checkpoints.unshift(parseStoredSnapshot(await idbGet(V7_MIGRATION_BASE_KEY))); }catch(e){}
    const previous = [...checkpoints, ...v7Copies].find(copy =>
      copy?.raw.schemaVersion === 7 && copy.clean.revision === deviceState.migratedV7Revision);
    if(previous) base = snapshotFromClean(previous.clean);
  }else{
    // Earlier v8 builds did not record the migration. A matching saved revision
    // can still establish the common ledger if both copies are available.
    for(const copy of currentCopies){
      const previous = v7Copies.find(candidate => candidate.clean.revision === copy.clean.revision);
      if(!previous) continue;
      const v8 = snapshotFromClean(copy.clean);
      v8.data.travelPauses = [];
      const v7 = snapshotFromClean(previous.clean);
      if(snapshotContentEqual(v8, v7)){
        base = v7;
        break;
      }
    }
  }
  if(requireBase && !base) throw new Error('V7_MIGRATION_BASE_MISSING');

  const current = buildSnapshot();
  if(!base){
    // Keep the current versions of records when the shared history is missing.
    // Previous v8 copies also identify records that were already removed in v8.
    const data = {};
    for(const [key, items] of Object.entries(remote.data)){
      const knownIds = new Set(current.data[key].map(item => item.id));
      for(const copy of currentCopies){
        for(const item of copy.clean[key]) knownIds.add(item.id);
      }
      data[key] = items.filter(item => !knownIds.has(item.id));
    }
    remote = { ...remote, data, settings:current.settings };
    base = cloudMergeBase(current);
  }

  const { snapshot, hadDirectConflict } = mergeConcurrentSnapshots(base, current, remote);
  const clean = validateBackupObject(snapshot, false);
  deviceState.migratedV7Revision = head.clean.revision;
  deviceState.pendingV7MigrationBase = head.raw;
  try{
    applyValidatedState(clean);
    await persistData();
  }finally{
    deviceState.pendingV7MigrationBase = null;
  }
  if(hadDirectConflict && !deviceState.persistFailed){
    showStorageBanner('Tally recovered changes from the older app. Where both versions edited the same record, Tally kept the current edit.', true);
  }
}

export async function loadAll(){
  const candidates = [];
  const problems = [];
  try{
    deviceState.canUseLocalStorage = probeLocalStorage();
    try{
      if(!deviceState.tallyDb) deviceState.tallyDb = await openDatabase();
      deviceState.storageMode = 'indexedDB';
      deviceState.storageAvailable = true;
    }catch(e){
      deviceState.tallyDb = null;
      deviceState.storageMode = deviceState.canUseLocalStorage ? 'localStorage' : 'memory';
      deviceState.storageAvailable = deviceState.canUseLocalStorage;
    }

    if(!await verifyCloudAccess()) return;

    await readCurrentCopies(candidates, problems);

    const v7Copies = [];
    let v7Head;
    if(candidates.length){
      candidates.sort((a,b) => b.clean.revision - a.clean.revision);
      const checkpoint = storedV7Revision(candidates[0].raw);
      v7Head = await readV7Head(v7Copies, problems, checkpoint);
    }else{
      await readDatabaseCopies(V7_DB_SNAPSHOTS, v7Copies, problems);
      readLocalCopies(V7_LOCAL_SNAPSHOTS, v7Copies, problems);
      if(v7Copies.length){
        candidates.push(...v7Copies);
        await migrateLegacyCloudBase('cloud-base-v7', 'tally-cloud-base-v7');
      }
    }
    if(!candidates.length){
      await readDatabaseCopies(LEGACY_DB_SNAPSHOTS, candidates, problems);
      readLocalCopies(LEGACY_LOCAL_SNAPSHOTS, candidates, problems);
      readOriginalLedger(candidates, problems);
      if(candidates.length) await migrateLegacyCloudBase();
    }

    if(candidates.length){
      candidates.sort((a,b) => b.clean.revision - a.clean.revision);
      const chosen = candidates[0];
      if(chosen.schemaVersion === 7){
        deviceState.migratedV7Revision = chosen.clean.revision;
        deviceState.pendingV7MigrationBase = chosen.raw;
      }else deviceState.migratedV7Revision = storedV7Revision(chosen.raw);
      applyValidatedState(chosen.clean);
      let loadedSnapshot = buildSnapshot();
      let result;
      if(chosen.source !== 'on-device database' || chosen.schemaVersion !== SCHEMA_VERSION){
        try{
          result = await withPersistenceLock(() => writeDurableSnapshot(loadedSnapshot, loadedSnapshot.revision, true));
        }catch(error){
          console.warn('Tally: could not promote the saved ledger during startup', error);
          showStorageBanner('Tally opened a saved copy but could not update browser storage. Save a backup before closing the app.', true);
        }
      }
      if(result?.status === 'conflict'){
        deviceState.migratedV7Revision = storedV7Revision(result.latest);
        applyValidatedState(validateBackupObject(result.latest, false));
        loadedSnapshot = buildSnapshot();
      }
      deviceState.durableRevision = ledgerState.stateRevision;
      deviceState.durableBaseSnapshot = cloneJson(loadedSnapshot);
      mirrorDurableSnapshot(loadedSnapshot);
      deviceState.pendingV7MigrationBase = null;
    } else {
      deviceState.durableRevision = ledgerState.stateRevision;
      deviceState.durableBaseSnapshot = null;
    }

    await recoverV7Changes(v7Head, v7Copies, candidates.filter(copy => copy.schemaVersion === SCHEMA_VERSION), problems);

    if(problems.length && !candidates.length){
      deviceState.unreadableLocalState = true;
      showStorageBanner('Saved data could not be read. It was left untouched; restore a known-good backup from Data.', true);
    } else if(!deviceState.storageAvailable){
      showStorageBanner("This browser is blocking durable storage. Save a backup before closing the app.", true);
    }

    setupCrossWindowSync();
    if(cloudState.cloudEnabled) await initializeCloudSync();
    if(deviceState.startupBlocked) return;
    renderAll();
    requestPersistentStorage();
    deviceState.appReady = true;
  }catch(e){
    console.error('Tally: startup failed', e);
    showStorageBanner('Tally could not finish loading saved data. Your existing storage was not overwritten.', true);
    renderAll();
  }finally{
    if(!deviceState.startupBlocked) document.getElementById('loadingScreen').style.display = 'none';
    updateStorageStatus();
    renderCloudStatus();
  }
}

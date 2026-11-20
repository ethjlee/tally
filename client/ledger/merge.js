import { validIsoTimestamp } from "./snapshot.js";
import { CLIENT_ID, DEFAULT_BACKUP_REMINDER_DAYS } from "../state.js";
import { SCHEMA_VERSION } from "../../shared/ledger-contract.ts";

export function cloneJson(value){
  return JSON.parse(JSON.stringify(value));
}
export function valuesEqual(a, b){
  return JSON.stringify(a) === JSON.stringify(b);
}
function mergeEntitiesById(baseItems, localItems, remoteItems, equal = valuesEqual, mergeEdits = null){
  const base = new Map(baseItems.map(item => [item.id, item]));
  const local = new Map(localItems.map(item => [item.id, item]));
  const remote = new Map(remoteItems.map(item => [item.id, item]));
  const ids = new Set([...base.keys(), ...local.keys(), ...remote.keys()]);
  const merged = [];
  let hadDirectConflict = false;

  for(const id of ids){
    const b = base.get(id);
    const l = local.get(id);
    const r = remote.get(id);
    let chosen;
    if(equal(l, b)) chosen = r;
    else if(equal(r, b)) chosen = l;
    else if(equal(l, r)) chosen = l;
    else {
      const combined = mergeEdits && b && l && r && mergeEdits(b, l, r);
      if(combined){
        merged.push(combined);
        continue;
      }
      hadDirectConflict = true;
      // If one copy deleted an item while the other edited it, preserve the edit.
      // If both edited the same item, keep the local edit; the complete remote
      // state remains in IndexedDB's rotating previous snapshot.
      chosen = l == null ? r : l;
    }
    if(chosen != null) merged.push({ ...chosen });
  }
  return { items:merged, hadDirectConflict };
}
export function mergeTravelPauseDates(base, local, remote){
  const startConflict = local.start !== base.start && remote.start !== base.start && local.start !== remote.start;
  const endConflict = local.end !== base.end && remote.end !== base.end && local.end !== remote.end;
  const start = local.start === base.start ? remote.start : local.start;
  const end = local.end === base.end ? remote.end : local.end;
  if(startConflict || endConflict || (end && end < start)) return null;
  return { id:base.id, start, end };
}
export function mergeChangedFields(base, local, remote){
  const merged = {};
  for(const key of Object.keys(local)){
    if(local[key] === base[key]) merged[key] = remote[key];
    else if(remote[key] === base[key] || local[key] === remote[key]) merged[key] = local[key];
    else return null;
  }
  return merged;
}
export function editableEntryFields(entry){
  return { date:entry.date, name:entry.name, type:entry.type, magnitude:Math.abs(entry.points) };
}
function mergeEntryEdits(base, local, remote){
  const fields = entry => ({ ...editableEntryFields(entry), ts:entry.ts, habitId:entry.habitId, bonusId:entry.bonusId });
  const merged = mergeChangedFields(fields(base), fields(local), fields(remote));
  if(!merged) return null;
  const { date, name, type, magnitude, ts, habitId, bonusId } = merged;
  const entry = { id:base.id, date, name, type, points:type === 'bad' ? -magnitude : magnitude, ts };
  if(type === 'bonus' && bonusId) entry.bonusId = bonusId;
  if(type !== 'bonus' && habitId) entry.habitId = habitId;
  return entry;
}
function habitDefinition(habit){
  if(!habit) return habit;
  const { streak, lastDate, ...definition } = habit;
  return definition;
}
function mergeHabitEdits(base, local, remote){
  const merged = mergeChangedFields(habitDefinition(base), habitDefinition(local), habitDefinition(remote));
  return merged && { ...local, ...merged };
}
export function mergeConcurrentSnapshots(baseSnapshot, localSnapshot, remoteSnapshot){
  const base = baseSnapshot || remoteSnapshot;
  const habitsMerge = mergeEntitiesById(base.data.habits, localSnapshot.data.habits, remoteSnapshot.data.habits,
    (a, b) => valuesEqual(habitDefinition(a), habitDefinition(b)), mergeHabitEdits);
  const bonusMerge = mergeEntitiesById(base.data.bonusTasks, localSnapshot.data.bonusTasks, remoteSnapshot.data.bonusTasks,
    valuesEqual, mergeChangedFields);
  const dailyBonusMerge = mergeEntitiesById(base.data.dailyBonuses || [], localSnapshot.data.dailyBonuses || [],
    remoteSnapshot.data.dailyBonuses || [], valuesEqual, mergeChangedFields);
  const taskSectionMerge = mergeEntitiesById(base.data.taskSections || [], localSnapshot.data.taskSections || [], remoteSnapshot.data.taskSections || []);
  const milestoneMerge = mergeEntitiesById(base.data.milestones, localSnapshot.data.milestones, remoteSnapshot.data.milestones,
    valuesEqual, mergeChangedFields);
  const pauseMerge = mergeEntitiesById(base.data.travelPauses || [], localSnapshot.data.travelPauses || [],
    remoteSnapshot.data.travelPauses || [], valuesEqual, mergeTravelPauseDates);
  const completedDayMerge = mergeEntitiesById(base.data.completedDays, localSnapshot.data.completedDays, remoteSnapshot.data.completedDays);
  const entryMerge = mergeEntitiesById(base.data.entries, localSnapshot.data.entries, remoteSnapshot.data.entries,
    valuesEqual, mergeEntryEdits);
  const settings = {};
  let hadDirectConflict = pauseMerge.hadDirectConflict || habitsMerge.hadDirectConflict || bonusMerge.hadDirectConflict || dailyBonusMerge.hadDirectConflict || taskSectionMerge.hadDirectConflict ||
    milestoneMerge.hadDirectConflict || completedDayMerge.hadDirectConflict || entryMerge.hadDirectConflict;
  const sectionKinds = new Map(taskSectionMerge.items.map(section => [section.id, section.kind]));
  for(const [kind, items] of [['habit', habitsMerge.items], ['bonus', bonusMerge.items]]){
    for(const item of items){
      if(item.sectionId && sectionKinds.get(item.sectionId) !== kind){
        item.sectionId = null;
        hadDirectConflict = true;
      }
    }
  }
  const completedDates = new Set();
  const completed = completedDayMerge.items.filter(item => {
    if(completedDates.has(item.date)){
      hadDirectConflict = true;
      return false;
    }
    completedDates.add(item.date);
    return true;
  });
  for(const key of ['dailyBase','successThreshold','dayStartHour','trackingStartDate','lastBackupAt','historyRangeDays','backupReminderDays','taskSortModes']){
    const b = base.settings[key];
    const l = localSnapshot.settings[key];
    const r = remoteSnapshot.settings[key];
    if(key === 'lastBackupAt'){
      const dates = [validIsoTimestamp(l), validIsoTimestamp(r)].filter(Boolean).sort();
      settings[key] = dates.length ? dates[dates.length - 1] : null;
      continue;
    }
    if(key === 'taskSortModes'){
      settings[key] = {};
      for(const kind of ['habit','bonus']){
        const baseMode = b[kind];
        const localMode = l[kind];
        const remoteMode = r[kind];
        if(valuesEqual(localMode, baseMode)) settings[key][kind] = remoteMode;
        else if(valuesEqual(remoteMode, baseMode) || valuesEqual(localMode, remoteMode)) settings[key][kind] = localMode;
        else {
          settings[key][kind] = localMode;
          hadDirectConflict = true;
        }
      }
      continue;
    }
    if(valuesEqual(l, b)) settings[key] = r;
    else if(valuesEqual(r, b) || valuesEqual(l, r)) settings[key] = l;
    else {
      settings[key] = l;
      hadDirectConflict = true;
    }
  }
  return {
    snapshot:{
      app:'Tally',
      schemaVersion:SCHEMA_VERSION,
      revision:Math.max(localSnapshot.revision || 0, remoteSnapshot.revision || 0),
      writerId:CLIENT_ID,
      data:{
        taskSections:taskSectionMerge.items,
        habits:habitsMerge.items,
        bonusTasks:bonusMerge.items,
        dailyBonuses:dailyBonusMerge.items,
        milestones:milestoneMerge.items,
        travelPauses:pauseMerge.items,
        completedDays:completed,
        entries:entryMerge.items
      },
      settings
    },
    hadDirectConflict
  };
}
function snapshotContent(snapshot){
  const habits = snapshot.data.habits.map(habitDefinition);
  return { data:{ ...snapshot.data, habits }, settings:snapshot.settings };
}

export function snapshotContentEqual(a, b){
  return !!a && !!b && valuesEqual(snapshotContent(a), snapshotContent(b));
}

export function snapshotWithReminderCadence(snapshot, days){
  return { ...snapshot, settings:{ ...snapshot.settings, backupReminderDays:days } };
}

export function cloudSnapshotContentEqual(a, b){
  return !!a && !!b && snapshotContentEqual(
    snapshotWithReminderCadence(a, DEFAULT_BACKUP_REMINDER_DAYS),
    snapshotWithReminderCadence(b, DEFAULT_BACKUP_REMINDER_DAYS)
  );
}

export function cloudMergeBase(reference){
  return {
    app:'Tally',
    schemaVersion:SCHEMA_VERSION,
    revision:0,
    writerId:null,
    data:{ taskSections:[], habits:[], bonusTasks:[], dailyBonuses:[], milestones:[], travelPauses:[], completedDays:[], entries:[] },
    settings:cloneJson(reference.settings)
  };
}

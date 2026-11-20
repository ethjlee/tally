import { pauseOn, statsStartKey, todayKey } from "./days.js";
import { ledgerState } from "../state.js";
import { MAX_MANUAL_ORDER } from "../../shared/ledger-contract.ts";

export const TASK_SORT_OPTIONS = [
  ['manual','Manual'],
  ['name-asc','A → Z'],
  ['name-desc','Z → A'],
  ['usage-desc','Most used'],
  ['usage-asc','Least used'],
  ['points-desc','Highest points'],
  ['points-asc','Lowest points']
];
export function taskItems(kind){
  if(kind === 'bonus') return ledgerState.bonusTasks;
  if(kind === 'habit') return ledgerState.habits;
  return ledgerState.habits.filter(habit => habit.type === kind);
}
export function taskActivity(kind, selectedDate){
  const isHabit = kind === 'habit';
  const list = taskItems(kind);
  const byId = new Map(list.map(item => [item.id, item]));
  const byName = new Map();
  for(const item of list){
    const key = isHabit ? item.type + '\u0000' + item.name : item.name;
    byName.set(key, byName.has(key) ? null : item);
  }
  const counts = new Map();
  const selectedCounts = new Map();
  const creditDates = new Map();
  const start = statsStartKey();
  const end = todayKey();
  for(const entry of ledgerState.entries){
    if(entry.date < start || entry.date > end || entry.derived) continue;
    if(isHabit ? entry.type === 'bonus' : entry.type !== 'bonus') continue;
    const linkedId = isHabit ? entry.habitId : entry.bonusId;
    const key = isHabit ? entry.type + '\u0000' + entry.name : entry.name;
    const task = linkedId ? byId.get(linkedId) : byName.get(key);
    if(!task) continue;
    const matchesTaskType = !isHabit || entry.type === task.type;
    if(matchesTaskType && entry.date === selectedDate) selectedCounts.set(task.id, (selectedCounts.get(task.id) || 0) + 1);
    if(pauseOn(entry.date)) continue;
    counts.set(task.id, (counts.get(task.id) || 0) + 1);
    if(isHabit && matchesTaskType && entry.type === 'good' && entry.date <= selectedDate){
      if(!creditDates.has(task.id)) creditDates.set(task.id, new Set());
      creditDates.get(task.id).add(entry.date);
    }
  }
  return { counts, selectedCounts, creditDates };
}
export function sectionIdValue(value){
  return value && value !== 'unsectioned' ? value : null;
}
export function sectionsForKind(kind){
  const sectionKind = kind === 'good' || kind === 'bad' ? 'habit' : kind;
  return ledgerState.taskSections.filter(section => section.kind === sectionKind).slice().sort((a, b) =>
    (Number(a.order) || 0) - (Number(b.order) || 0) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}
export function taskSectionFor(kind, sectionId){
  const normalized = sectionIdValue(sectionId);
  const sectionKind = kind === 'good' || kind === 'bad' ? 'habit' : kind;
  return normalized ? ledgerState.taskSections.find(section => section.id === normalized && section.kind === sectionKind) || null : null;
}
export function manualTaskItems(kind, sectionId){
  const normalized = sectionIdValue(sectionId);
  return taskItems(kind).filter(item => sectionIdValue(item.sectionId) === normalized).slice().sort((a, b) =>
    (Number(a.order) || 0) - (Number(b.order) || 0) ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}
export function sortedTaskItems(kind, sectionId, usage){
  const mode = ledgerState.taskSortModes[kind] || 'manual';
  const list = manualTaskItems(kind, sectionId);
  const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity:'base' }) || a.id.localeCompare(b.id);
  if(mode === 'name-asc') return list.sort(byName);
  if(mode === 'name-desc') return list.sort((a, b) => -byName(a, b));
  if(mode === 'usage-desc') return list.sort((a, b) => (usage.get(b.id) || 0) - (usage.get(a.id) || 0) || byName(a, b));
  if(mode === 'usage-asc') return list.sort((a, b) => (usage.get(a.id) || 0) - (usage.get(b.id) || 0) || byName(a, b));
  if(mode === 'points-desc') return list.sort((a, b) => b.points - a.points || byName(a, b));
  if(mode === 'points-asc') return list.sort((a, b) => a.points - b.points || byName(a, b));
  return list;
}
function nextManualOrder(sortedItems, slots){
  if(!sortedItems.length) return 0;
  const highest = Number(sortedItems.at(-1).order) || 0;
  if(highest + slots <= MAX_MANUAL_ORDER) return highest + 1;
  sortedItems.forEach((item, order) => { item.order = order; });
  return sortedItems.length;
}
export function nextTaskOrder(kind, sectionId, excludeId, slots = 1){
  return nextManualOrder(manualTaskItems(kind, sectionId).filter(item => item.id !== excludeId), slots);
}
export function nextTaskSectionOrder(kind, excludeId){
  return nextManualOrder(sectionsForKind(kind).filter(section => section.id !== excludeId), 1);
}

import {
  manualTaskItems,
  sectionIdValue,
  sectionsForKind,
  taskItems,
  taskSectionFor
} from "../ledger/tasks.js";
import { ledgerState } from "../state.js";
import { persistData } from "../storage/persistence.js";
import { renderAll } from "./render.js";
import { setReorderStatus } from "./tasks.js";

export function moveTaskSectionToPosition(kind, id, beforeId){
  if(!['habit','bonus'].includes(kind)) return false;
  const section = taskSectionFor(kind, id);
  if(!section) return false;
  const remaining = sectionsForKind(kind).filter(item => item.id !== id);
  let insertionIndex = beforeId ? remaining.findIndex(item => item.id === beforeId) : remaining.length;
  if(insertionIndex < 0) insertionIndex = remaining.length;
  remaining.splice(insertionIndex, 0, section);
  remaining.forEach((item, order) => { item.order = order; });
  persistData();
  renderAll();
  setReorderStatus(`${section.name} section moved to position ${insertionIndex + 1}.`);
  return true;
}
export function moveTaskSectionByKeyboard(kind, id, key){
  const list = sectionsForKind(kind);
  const index = list.findIndex(section => section.id === id);
  if(index < 0) return false;
  let beforeId = null;
  if(key === 'ArrowUp' && index > 0) beforeId = list[index - 1].id;
  else if(key === 'ArrowDown' && index < list.length - 1) beforeId = list[index + 2]?.id || null;
  else if(key === 'Home'){
    if(index === 0) return false;
    beforeId = list[0].id;
  }
  else if(key === 'End'){
    if(index === list.length - 1) return false;
    beforeId = null;
  }else{
    return false;
  }
  return moveTaskSectionToPosition(kind, id, beforeId);
}
export function moveTaskToPosition(kind, id, rawSectionId, beforeId){
  if(!['habit','bonus'].includes(kind) || ledgerState.taskSortModes[kind] !== 'manual') return false;
  const task = taskItems(kind).find(item => item.id === id);
  if(!task) return false;
  const targetSectionId = sectionIdValue(rawSectionId);
  if(targetSectionId && !taskSectionFor(kind, targetSectionId)) return false;
  const sourceSectionId = sectionIdValue(task.sectionId);
  const sourceRemaining = manualTaskItems(kind, sourceSectionId).filter(item => item.id !== id);
  const targetRemaining = sourceSectionId === targetSectionId
    ? sourceRemaining
    : manualTaskItems(kind, targetSectionId).filter(item => item.id !== id);
  let insertionIndex = beforeId ? targetRemaining.findIndex(item => item.id === beforeId) : targetRemaining.length;
  if(insertionIndex < 0) insertionIndex = targetRemaining.length;
  targetRemaining.splice(insertionIndex, 0, task);
  task.sectionId = targetSectionId;
  sourceRemaining.forEach((item, order) => { item.order = order; });
  targetRemaining.forEach((item, order) => { item.order = order; });
  persistData();
  renderAll();
  const sectionName = taskSectionFor(kind, targetSectionId)?.name || (kind === 'habit' ? 'Unsorted' : 'Unsectioned');
  setReorderStatus(`${task.name} moved to ${sectionName}, position ${insertionIndex + 1}.`);
  return true;
}
export function moveTaskByKeyboard(kind, id, key){
  const task = taskItems(kind).find(item => item.id === id);
  if(!task || ledgerState.taskSortModes[kind] !== 'manual') return false;
  const sectionId = sectionIdValue(task.sectionId);
  const list = manualTaskItems(kind, sectionId);
  const index = list.findIndex(item => item.id === id);
  if(index < 0) return false;
  let targetSectionId = sectionId;
  let beforeId = null;
  if(key === 'ArrowUp' && index > 0) beforeId = list[index - 1].id;
  else if(key === 'ArrowDown' && index < list.length - 1) beforeId = list[index + 2]?.id || null;
  else if(key === 'Home'){
    if(index === 0) return false;
    beforeId = list[0].id;
  }
  else if(key === 'End'){
    if(index === list.length - 1) return false;
    beforeId = null;
  }
  else if(key === 'ArrowLeft' || key === 'ArrowRight'){
    const sectionIds = [null, ...sectionsForKind(kind).map(section => section.id)];
    const currentSectionIndex = sectionIds.findIndex(value => value === sectionId);
    const direction = key === 'ArrowLeft' ? -1 : 1;
    const targetIndex = currentSectionIndex + direction;
    if(targetIndex < 0 || targetIndex >= sectionIds.length) return false;
    targetSectionId = sectionIds[targetIndex];
  }else{
    return false;
  }
  return moveTaskToPosition(kind, id, targetSectionId, beforeId);
}

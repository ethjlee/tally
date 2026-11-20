import { moveTaskSectionToPosition, moveTaskToPosition } from "./task-order.js";
import { sectionIdValue, taskItems, taskSectionFor } from "../ledger/tasks.js";
import { ledgerState } from "../state.js";
import { persistSettings } from "../storage/persistence.js";
import { renderAll } from "./render.js";
import { taskKindLabel } from "./task-editor.js";
import { setReorderStatus } from "./tasks.js";

let taskDragState = null;
let taskSectionDragState = null;
function clearTaskDropIndicators(){
  document.querySelectorAll('.drop-before,.drop-after,.drop-target').forEach(element => {
    element.classList.remove('drop-before','drop-after','drop-target');
  });
}
export function cleanupTaskDrag(){
  if(!taskDragState) return;
  taskDragState.row?.classList.remove('drag-source');
  taskDragState.ghost?.remove();
  clearTaskDropIndicators();
  document.body.classList.remove('task-dragging');
  taskDragState = null;
}
export function beginTaskDrag(event, handle){
  const kind = handle.dataset.kind;
  const id = handle.dataset.id;
  if(!['habit','bonus'].includes(kind) || !id) return;
  if(ledgerState.taskSortModes[kind] !== 'manual'){
    event.preventDefault();
    ledgerState.taskSortModes[kind] = 'manual';
    persistSettings();
    renderAll();
    setReorderStatus(`${taskKindLabel(kind)} switched to Manual sorting. Drag the handle again to move this entry.`);
    return;
  }
  const row = handle.closest('[data-task-row]');
  if(!row) return;
  event.preventDefault();
  try{ handle.setPointerCapture(event.pointerId); }catch(e){}
  taskDragState = {
    pointerId:event.pointerId,
    kind,
    id,
    row,
    startX:event.clientX,
    startY:event.clientY,
    active:false,
    targetSectionId:null,
    beforeId:null,
    hasTarget:false,
    ghost:null
  };
}
export function updateTaskDrag(event){
  const state = taskDragState;
  if(!state || event.pointerId !== state.pointerId) return;
  const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
  if(!state.active && distance < 4) return;
  if(!state.active){
    state.active = true;
    state.row.classList.add('drag-source');
    document.body.classList.add('task-dragging');
    const task = taskItems(state.kind).find(item => item.id === state.id);
    const ghost = document.createElement('div');
    ghost.className = 'task-drag-ghost';
    ghost.textContent = task?.name || 'Move entry';
    document.body.appendChild(ghost);
    state.ghost = ghost;
  }
  event.preventDefault();
  state.ghost.style.left = `${event.clientX}px`;
  state.ghost.style.top = `${event.clientY}px`;
  clearTaskDropIndicators();
  state.hasTarget = false;

  const underPointer = document.elementFromPoint ? document.elementFromPoint(event.clientX, event.clientY) : null;
  const zone = underPointer?.closest?.(`[data-task-drop-zone][data-kind="${state.kind}"]`);
  if(zone){
    const rows = [...zone.querySelectorAll(`[data-task-row][data-kind="${state.kind}"]`)]
      .filter(row => row.dataset.id !== state.id);
    let beforeId = null;
    let marker = null;
    for(const row of rows){
      const rect = row.getBoundingClientRect();
      if(event.clientY < rect.top + rect.height / 2){
        beforeId = row.dataset.id;
        marker = row;
        break;
      }
    }
    if(marker) marker.classList.add('drop-before');
    else if(rows.length) rows[rows.length - 1].classList.add('drop-after');
    else zone.classList.add('drop-target');
    state.targetSectionId = sectionIdValue(zone.dataset.sectionId);
    state.beforeId = beforeId;
    state.hasTarget = true;
  }
  if(typeof window.scrollBy === 'function'){
    if(event.clientY < 72) window.scrollBy({ top:-10, behavior:'auto' });
    else if(event.clientY > window.innerHeight - 88) window.scrollBy({ top:10, behavior:'auto' });
  }
}
export function finishTaskDrag(event){
  const state = taskDragState;
  if(!state || event.pointerId !== state.pointerId) return;
  const shouldMove = state.active && state.hasTarget;
  const { kind, id, targetSectionId, beforeId } = state;
  cleanupTaskDrag();
  if(shouldMove) moveTaskToPosition(kind, id, targetSectionId, beforeId);
}
export function cleanupTaskSectionDrag(){
  if(!taskSectionDragState) return;
  taskSectionDragState.group?.classList.remove('drag-source');
  taskSectionDragState.ghost?.remove();
  clearTaskDropIndicators();
  document.body.classList.remove('task-dragging');
  taskSectionDragState = null;
}
export function beginTaskSectionDrag(event, handle){
  const kind = handle.dataset.kind;
  const id = handle.dataset.id;
  const section = taskSectionFor(kind, id);
  const group = handle.closest('[data-task-group]');
  if(!section || !group) return;
  event.preventDefault();
  try{ handle.setPointerCapture(event.pointerId); }catch(e){}
  taskSectionDragState = {
    pointerId:event.pointerId,
    kind,
    id,
    group,
    startX:event.clientX,
    startY:event.clientY,
    active:false,
    beforeId:null,
    hasTarget:false,
    ghost:null
  };
}
export function updateTaskSectionDrag(event){
  const state = taskSectionDragState;
  if(!state || event.pointerId !== state.pointerId) return;
  const distance = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
  if(!state.active && distance < 4) return;
  if(!state.active){
    state.active = true;
    state.group.classList.add('drag-source');
    document.body.classList.add('task-dragging');
    const section = taskSectionFor(state.kind, state.id);
    const ghost = document.createElement('div');
    ghost.className = 'task-drag-ghost';
    ghost.textContent = section?.name || 'Move section';
    document.body.appendChild(ghost);
    state.ghost = ghost;
  }
  event.preventDefault();
  state.ghost.style.left = `${event.clientX}px`;
  state.ghost.style.top = `${event.clientY}px`;
  clearTaskDropIndicators();
  state.hasTarget = false;

  const underPointer = document.elementFromPoint ? document.elementFromPoint(event.clientX, event.clientY) : null;
  const listId = state.kind === 'habit' ? 'habitList' : 'bonusList';
  const listRoot = document.getElementById(listId);
  if(underPointer && listRoot?.contains(underPointer)){
    const groups = [...listRoot.querySelectorAll(`[data-task-group][data-kind="${state.kind}"][data-custom-section="true"]`)]
      .filter(group => group.dataset.sectionId !== state.id);
    let beforeId = null;
    let marker = null;
    for(const group of groups){
      const rect = group.getBoundingClientRect();
      if(event.clientY < rect.top + rect.height / 2){
        beforeId = group.dataset.sectionId;
        marker = group;
        break;
      }
    }
    if(marker) marker.classList.add('drop-before');
    else if(groups.length) groups[groups.length - 1].classList.add('drop-after');
    state.beforeId = beforeId;
    state.hasTarget = true;
  }
  if(typeof window.scrollBy === 'function'){
    if(event.clientY < 72) window.scrollBy({ top:-10, behavior:'auto' });
    else if(event.clientY > window.innerHeight - 88) window.scrollBy({ top:10, behavior:'auto' });
  }
}
export function finishTaskSectionDrag(event){
  const state = taskSectionDragState;
  if(!state || event.pointerId !== state.pointerId) return;
  const shouldMove = state.active && state.hasTarget;
  const { kind, id, beforeId } = state;
  cleanupTaskSectionDrag();
  if(shouldMove) moveTaskSectionToPosition(kind, id, beforeId);
}

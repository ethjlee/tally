import { uid } from "../ledger/id.js";
import { mergeChangedFields } from "../ledger/merge.js";
import { recomputeAllHabitStreaks } from "../ledger/streaks.js";
import {
  manualTaskItems,
  nextTaskOrder,
  nextTaskSectionOrder,
  sectionIdValue,
  sectionsForKind,
  taskItems,
  taskSectionFor
} from "../ledger/tasks.js";
import { ledgerState } from "../state.js";
import { persistData } from "../storage/persistence.js";
import { closeDialog, openDialog, showConfirm } from "./dialog.js";
import { escapeHtml } from "./dom.js";
import { renderAll } from "./render.js";
import { canAddRecord, clearFieldError, showFieldError } from "./validation.js";

let editingHabit = null;
let editingBonus = null;
let editingDailyBonus = null;
let editingMilestone = null;
let editingTaskSectionId = null;
let taskSectionKindDraft = 'habit';
let habitTypeDraft = 'good';
function populateTaskSectionSelect(elementId, kind, selectedSectionId){
  const select = document.getElementById(elementId);
  if(!select) return;
  const selected = sectionIdValue(selectedSectionId);
  select.innerHTML = [
    `<option value="">${kind === 'habit' ? 'Unsorted' : 'Unsectioned'}</option>`,
    ...sectionsForKind(kind).map(section =>
      `<option value="${escapeHtml(section.id)}">${escapeHtml(section.name)}</option>`
    )
  ].join('');
  select.value = selected && taskSectionFor(kind, selected) ? selected : '';
}
export function openHabitModal(type, id){
  const h = id ? ledgerState.habits.find(item => item.id === id) : null;
  if(id && !h) return;
  editingHabit = h ? { id:h.id, ...editableHabitFields(h) } : null;
  const title = document.getElementById('habitModalTitle');
  const delBtn = document.getElementById('deleteHabitBtn');
  clearFieldError('habitError');

  if(h){
    document.getElementById('habitName').value = h.name;
    document.getElementById('habitPoints').value = h.points;
    setHabitType(h.type);
    populateTaskSectionSelect('habitSectionInput', 'habit', h.sectionId);
    title.textContent = 'Edit ' + (h.type === 'good' ? 'credit' : 'debit');
    delBtn.style.display = 'block';
  } else {
    document.getElementById('habitName').value = '';
    document.getElementById('habitPoints').value = '';
    setHabitType(type || 'good');
    populateTaskSectionSelect('habitSectionInput', 'habit', null);
    title.textContent = 'Add ' + (type === 'bad' ? 'debit' : 'credit');
    delBtn.style.display = 'none';
  }
  openDialog('habitOverlay', 'habitName');
}
export function closeHabitModal(){
  closeDialog('habitOverlay');
  editingHabit = null;
}
export function setHabitType(type){
  habitTypeDraft = type;
  document.getElementById('segGood').classList.toggle('active', type === 'good');
  document.getElementById('segGood').classList.toggle('good', true);
  document.getElementById('segBad').classList.toggle('active', type === 'bad');
  document.getElementById('segBad').classList.toggle('bad', true);
  document.getElementById('pointsLabel').textContent = type === 'good' ? 'Points earned' : 'Points lost';
  document.getElementById('habitHint').style.display = type === 'good' ? 'block' : 'none';
}
function editableHabitFields(habit){
  const { name, points, type, sectionId } = habit;
  return { name, points, type, sectionId:sectionIdValue(sectionId) };
}
function validateTaskSectionChoice(kind, sectionId, currentSectionId){
  if(!sectionId || taskSectionFor(kind, sectionId)) return true;
  populateTaskSectionSelect(`${kind}SectionInput`, kind, currentSectionId);
  showFieldError(`${kind}Error`, 'That section was removed. Review the section and save again.', `${kind}SectionInput`);
  return false;
}
export function saveHabit(){
  const name = document.getElementById('habitName').value.trim();
  const pointsRaw = document.getElementById('habitPoints').value;
  const points = Number(pointsRaw);
  const sectionId = sectionIdValue(document.getElementById('habitSectionInput').value);
  clearFieldError('habitError');
  if(!name) return showFieldError('habitError', 'Enter a habit name.', 'habitName');
  if(!Number.isInteger(points) || points < 1 || points > 999){
    return showFieldError('habitError', 'Points must be a whole number from 1 to 999.', 'habitPoints');
  }
  if(editingHabit){
    const h = ledgerState.habits.find(x => x.id === editingHabit.id);
    if(!h) return showFieldError('habitError', 'This habit no longer exists. Close and try again.');
    const draft = { name, points, type:habitTypeDraft, sectionId };
    const edit = mergeChangedFields(editingHabit, draft, editableHabitFields(h));
    if(!edit){
      return showFieldError('habitError', 'This habit changed in another tab or device. Close and reopen it to review the latest values.');
    }
    if(!validateTaskSectionChoice('habit', edit.sectionId, h.sectionId)) return;
    if(sectionIdValue(h.sectionId) !== edit.sectionId) h.order = nextTaskOrder('habit', edit.sectionId, h.id);
    const streakChanged = h.type !== edit.type || h.name !== edit.name;
    Object.assign(h, edit);
    if(streakChanged) recomputeAllHabitStreaks();
  } else {
    if(!validateTaskSectionChoice('habit', sectionId, null)) return;
    if(!canAddRecord('habits', ledgerState.habits, 'habitError')) return;
    ledgerState.habits.push({
      id: uid(), name, type: habitTypeDraft, points, streak:0, lastDate:null,
      order:nextTaskOrder('habit', sectionId), sectionId
    });
  }
  persistData();
  closeHabitModal();
  renderAll();
}
export async function deleteHabitConfirm(){
  const id = editingHabit?.id;
  if(!id) return;
  const ok = await showConfirm('Delete this habit? Past entries stay in your history.');
  if(ok){
    ledgerState.habits = ledgerState.habits.filter(x => x.id !== id);
    persistData();
    closeHabitModal();
    renderAll();
  }
}

export function openBonusModal(id){
  const bonus = id ? ledgerState.bonusTasks.find(item => item.id === id) : null;
  if(id && !bonus) return;
  editingBonus = bonus ? { ...bonus } : null;
  const title = document.getElementById('bonusModalTitle');
  const delBtn = document.getElementById('deleteBonusBtn');
  clearFieldError('bonusError');
  if(bonus){
    document.getElementById('bonusName').value = bonus.name;
    document.getElementById('bonusPoints').value = bonus.points;
    populateTaskSectionSelect('bonusSectionInput', 'bonus', bonus.sectionId);
    title.textContent = 'Edit bonus entry';
    delBtn.style.display = 'block';
  } else {
    document.getElementById('bonusName').value = '';
    document.getElementById('bonusPoints').value = '';
    populateTaskSectionSelect('bonusSectionInput', 'bonus', null);
    title.textContent = 'Add bonus entry';
    delBtn.style.display = 'none';
  }
  openDialog('bonusOverlay', 'bonusName');
}
export function closeBonusModal(){
  closeDialog('bonusOverlay');
  editingBonus = null;
}
export function saveBonus(){
  const name = document.getElementById('bonusName').value.trim();
  const points = Number(document.getElementById('bonusPoints').value);
  const sectionId = sectionIdValue(document.getElementById('bonusSectionInput').value);
  clearFieldError('bonusError');
  if(!name) return showFieldError('bonusError', 'Enter a bonus name.', 'bonusName');
  if(!Number.isInteger(points) || points < 1 || points > 999){
    return showFieldError('bonusError', 'Points must be a whole number from 1 to 999.', 'bonusPoints');
  }
  if(editingBonus){
    const bonus = ledgerState.bonusTasks.find(item => item.id === editingBonus.id);
    if(!bonus) return showFieldError('bonusError', 'This bonus entry no longer exists. Close and try again.');
    const edit = mergeChangedFields(editingBonus, { name, points, sectionId }, bonus);
    if(!edit){
      return showFieldError('bonusError', 'This bonus entry changed in another tab or device. Close and reopen it to review the latest values.');
    }
    if(!validateTaskSectionChoice('bonus', edit.sectionId, bonus.sectionId)) return;
    if(sectionIdValue(bonus.sectionId) !== edit.sectionId) bonus.order = nextTaskOrder('bonus', edit.sectionId, bonus.id);
    Object.assign(bonus, edit);
  } else {
    if(!validateTaskSectionChoice('bonus', sectionId, null)) return;
    if(!canAddRecord('bonusTasks', ledgerState.bonusTasks, 'bonusError')) return;
    ledgerState.bonusTasks.push({ id:uid(), name, points, order:nextTaskOrder('bonus', sectionId), sectionId });
  }
  persistData();
  closeBonusModal();
  renderAll();
}
export async function deleteBonusConfirm(){
  const id = editingBonus?.id;
  if(!id) return;
  const ok = await showConfirm('Delete this bonus entry? Past entries stay in your history.');
  if(ok){
    ledgerState.bonusTasks = ledgerState.bonusTasks.filter(x => x.id !== id);
    persistData();
    closeBonusModal();
    renderAll();
  }
}

export function taskKindLabel(kind){
  return kind === 'habit' ? 'Habits' : 'Bonus entries';
}
export function openTaskSectionModal(kind, id){
  const section = id ? ledgerState.taskSections.find(item => item.id === id) : null;
  taskSectionKindDraft = section?.kind || (['habit','bonus'].includes(kind) ? kind : 'habit');
  editingTaskSectionId = section?.id || null;
  document.getElementById('taskSectionName').value = section?.name || '';
  const topic = taskSectionKindDraft === 'habit';
  document.getElementById('taskSectionModalTitle').textContent =
    `${section ? 'Edit' : 'Add'} ${topic ? 'topic' : 'section'}`;
  document.getElementById('taskSectionKindHint').textContent =
    topic
      ? 'Topics can contain both credits and debits. Scoring types and history stay unchanged.'
      : 'Bonus sections remain separate from habit topics.';
  document.getElementById('deleteTaskSectionBtn').style.display = section ? 'block' : 'none';
  clearFieldError('taskSectionError');
  openDialog('taskSectionOverlay', 'taskSectionName');
}
export function closeTaskSectionModal(){
  closeDialog('taskSectionOverlay');
  editingTaskSectionId = null;
}
export function saveTaskSection(){
  const name = document.getElementById('taskSectionName').value.trim();
  clearFieldError('taskSectionError');
  if(!name) return showFieldError('taskSectionError', 'Enter a section name.', 'taskSectionName');
  const duplicate = ledgerState.taskSections.some(section =>
    section.kind === taskSectionKindDraft &&
    section.id !== editingTaskSectionId &&
    section.name.localeCompare(name, undefined, { sensitivity:'base' }) === 0
  );
  if(duplicate) return showFieldError('taskSectionError', 'A section with that name already exists here.', 'taskSectionName');
  if(editingTaskSectionId){
    const section = ledgerState.taskSections.find(item => item.id === editingTaskSectionId);
    if(!section) return showFieldError('taskSectionError', 'This section no longer exists. Close and try again.');
    section.name = name;
  }else{
    if(!canAddRecord('taskSections', ledgerState.taskSections, 'taskSectionError')) return;
    ledgerState.taskSections.push({
      id:uid(), name, kind:taskSectionKindDraft,
      order:nextTaskSectionOrder(taskSectionKindDraft)
    });
  }
  persistData();
  closeTaskSectionModal();
  renderAll();
}
export async function deleteTaskSectionConfirm(){
  const section = ledgerState.taskSections.find(item => item.id === editingTaskSectionId);
  if(!section) return;
  const affected = taskItems(section.kind).filter(item => item.sectionId === section.id);
  const fallbackName = section.kind === 'habit' ? 'Unsorted' : 'Unsectioned';
  const itemName = section.kind === 'habit' ? 'habits' : 'bonus entries';
  const ok = await showConfirm(
    `Delete “${section.name}”? Its ${affected.length} ${itemName} will move to ${fallbackName}; no entries or history will be deleted.`,
    `Delete ${section.kind === 'habit' ? 'topic' : 'section'}`
  );
  if(!ok) return;
  const moving = manualTaskItems(section.kind, section.id);
  let order = nextTaskOrder(section.kind, null, undefined, moving.length);
  moving.forEach(item => {
    item.sectionId = null;
    item.order = order++;
  });
  ledgerState.taskSections = ledgerState.taskSections.filter(item => item.id !== section.id);
  persistData();
  closeTaskSectionModal();
  renderAll();
}

export function openDailyBonusModal(id){
  const bonus = id ? ledgerState.dailyBonuses.find(item => item.id === id) : null;
  if(id && !bonus) return;
  editingDailyBonus = bonus && { ...bonus };
  clearFieldError('dailyBonusError');
  document.getElementById('dailyBonusModalTitle').textContent = id ? 'Edit automatic daily bonus' : 'Add automatic daily bonus';
  document.getElementById('dailyBonusName').value = bonus?.name || '';
  document.getElementById('dailyBonusPoints').value = bonus?.points || '';
  document.getElementById('dailyBonusDescription').value = bonus?.description || '';
  document.getElementById('deleteDailyBonusBtn').style.display = id ? 'block' : 'none';
  openDialog('dailyBonusOverlay', 'dailyBonusName');
}
export function closeDailyBonusModal(){
  closeDialog('dailyBonusOverlay');
  editingDailyBonus = null;
}
export function saveDailyBonus(){
  const name = document.getElementById('dailyBonusName').value.trim();
  const points = Number(document.getElementById('dailyBonusPoints').value);
  const description = document.getElementById('dailyBonusDescription').value.trim();
  clearFieldError('dailyBonusError');
  if(!name || name.length > 60) return showFieldError('dailyBonusError', 'Enter a name of up to 60 characters.', 'dailyBonusName');
  if(!Number.isInteger(points) || points < 1 || points > 9999){
    return showFieldError('dailyBonusError', 'Reward points must be a whole number from 1 to 9,999.', 'dailyBonusPoints');
  }
  if(description.length > 160){
    return showFieldError('dailyBonusError', 'Keep the description to 160 characters or fewer.', 'dailyBonusDescription');
  }
  if(editingDailyBonus){
    const bonus = ledgerState.dailyBonuses.find(item => item.id === editingDailyBonus.id);
    if(!bonus) return showFieldError('dailyBonusError', 'This daily bonus no longer exists. Close and try again.');
    const merged = mergeChangedFields(editingDailyBonus, { name, points, description }, bonus);
    if(!merged){
      return showFieldError('dailyBonusError', 'This daily bonus changed in another tab or device. Close and reopen it to review the latest values.');
    }
    Object.assign(bonus, merged);
  }else{
    if(!canAddRecord('dailyBonuses', ledgerState.dailyBonuses, 'dailyBonusError')) return;
    ledgerState.dailyBonuses.push({ id:uid(), name, points, description });
  }
  persistData();
  closeDailyBonusModal();
  renderAll();
}
export async function deleteDailyBonusConfirm(){
  const bonus = ledgerState.dailyBonuses.find(item => item.id === editingDailyBonus?.id);
  if(!bonus) return;
  if(await showConfirm(`Delete “${bonus.name}”? Every automatic award generated by it will be removed retroactively.`, 'Delete daily bonus')){
    ledgerState.dailyBonuses = ledgerState.dailyBonuses.filter(item => item.id !== bonus.id);
    persistData();
    closeDailyBonusModal();
    renderAll();
  }
}

export function openMilestoneModal(id){
  const milestone = id ? ledgerState.milestones.find(item => item.id === id) : null;
  if(id && !milestone) return;
  editingMilestone = milestone ? { ...milestone } : null;
  const title = document.getElementById('milestoneModalTitle');
  const delBtn = document.getElementById('deleteMilestoneBtn');
  clearFieldError('milestoneError');
  if(milestone){
    document.getElementById('milestoneName').value = milestone.name;
    document.getElementById('milestoneDays').value = milestone.days;
    document.getElementById('milestonePoints').value = milestone.points;
    document.getElementById('milestoneDescription').value = milestone.description || '';
    title.textContent = 'Edit success milestone';
    delBtn.style.display = 'block';
  }else{
    document.getElementById('milestoneName').value = '';
    document.getElementById('milestoneDays').value = '';
    document.getElementById('milestonePoints').value = '';
    document.getElementById('milestoneDescription').value = '';
    title.textContent = 'Add success milestone';
    delBtn.style.display = 'none';
  }
  openDialog('milestoneOverlay', 'milestoneName');
}
export function closeMilestoneModal(){
  closeDialog('milestoneOverlay');
  editingMilestone = null;
}
export function saveMilestone(){
  const name = document.getElementById('milestoneName').value.trim();
  const days = Number(document.getElementById('milestoneDays').value);
  const points = Number(document.getElementById('milestonePoints').value);
  const description = document.getElementById('milestoneDescription').value.trim();
  clearFieldError('milestoneError');
  if(!name) return showFieldError('milestoneError', 'Enter a milestone name.', 'milestoneName');
  if(!Number.isInteger(days) || days < 1 || days > 100000){
    return showFieldError('milestoneError', 'Successful day must be a whole number from 1 to 100,000.', 'milestoneDays');
  }
  if(!Number.isInteger(points) || points < 1 || points > 9999){
    return showFieldError('milestoneError', 'Reward points must be a whole number from 1 to 9,999.', 'milestonePoints');
  }
  if(description.length > 160){
    return showFieldError('milestoneError', 'Keep the description to 160 characters or fewer.', 'milestoneDescription');
  }
  if(editingMilestone){
    const milestone = ledgerState.milestones.find(item => item.id === editingMilestone.id);
    if(!milestone) return showFieldError('milestoneError', 'This milestone no longer exists. Close and try again.');
    const edit = mergeChangedFields(editingMilestone, { name, days, points, description }, milestone);
    if(!edit){
      return showFieldError('milestoneError', 'This milestone changed in another tab or device. Close and reopen it to review the latest values.');
    }
    Object.assign(milestone, edit);
  }else{
    if(!canAddRecord('milestones', ledgerState.milestones, 'milestoneError')) return;
    ledgerState.milestones.push({ id:uid(), name, days, points, description });
  }
  persistData();
  closeMilestoneModal();
  renderAll();
}
export async function deleteMilestoneConfirm(){
  const milestone = ledgerState.milestones.find(item => item.id === editingMilestone?.id);
  if(!milestone) return;
  const ok = await showConfirm(
    `Delete “${milestone.name}”? Every automatic award generated by it will be removed retroactively.`,
    'Delete milestone'
  );
  if(ok){
    ledgerState.milestones = ledgerState.milestones.filter(item => item.id !== milestone.id);
    persistData();
    closeMilestoneModal();
    renderAll();
  }
}

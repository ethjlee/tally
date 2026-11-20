import { cloudState } from "../state.js";
import { escapeHtml } from "./dom.js";

export function setCloudStatus(mode, message){
  cloudState.cloudStatusMode = mode;
  cloudState.cloudStatusMessage = message;
  renderCloudStatus();
}

export function renderCloudStatus(){
  const el = document.getElementById('cloudStatusEl');
  const button = document.getElementById('cloudSyncBtn');
  if(!el) return;
  const labels = {
    checking:'Checking encrypted sync',
    syncing:'Syncing encrypted ledger',
    synced:'Encrypted cloud is up to date',
    offline:'Offline — device copy is available',
    rollback:'Cloud ledger was restored',
    error:'Cloud sync needs attention'
  };
  const title = labels[cloudState.cloudStatusMode] || labels.error;
  const identity = cloudState.cloudUsername ? ` · ${escapeHtml(cloudState.cloudUsername)}` : '';
  el.innerHTML = `<strong>${title}${identity}</strong><br>${escapeHtml(cloudState.cloudStatusMessage)}`;
  if(button) button.disabled = cloudState.cloudStatusMode === 'syncing' || cloudState.cloudRollbackResolving;
  const recovery = document.getElementById('cloudRollbackActions');
  if(recovery){
    recovery.hidden = !cloudState.cloudRollback;
    for(const choice of recovery.querySelectorAll('button')){
      choice.disabled = cloudState.cloudRollbackResolving || cloudState.cloudStatusMode === 'syncing';
    }
  }
}

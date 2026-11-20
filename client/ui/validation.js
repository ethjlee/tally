import { SYNC_COLLECTION_LIMITS } from "../../shared/ledger-contract.ts";
import { showStorageBanner } from "./storage.js";

export function canAddRecord(collection, records, fieldError){
  const limit = SYNC_COLLECTION_LIMITS[collection];
  if(records.length < limit) return true;
  const message = `This collection has reached the cloud limit of ${limit.toLocaleString()} records.`;
  if(fieldError) showFieldError(fieldError, message);
  else showStorageBanner(message);
  return false;
}

export function showFieldError(id, message, focusId){
  const el = document.getElementById(id);
  el.textContent = message;
  el.classList.add('show');
  if(focusId) document.getElementById(focusId).focus();
}
export function clearFieldError(id){
  const el = document.getElementById(id);
  if(!el) return;
  el.textContent = '';
  el.classList.remove('show');
}

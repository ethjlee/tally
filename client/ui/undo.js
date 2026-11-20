import { deleteEntry } from "../ledger/actions.js";
import { pauseOn } from "../ledger/days.js";

let undoToastTimer = null;
let undoCallback = null;
export function showUndoToast(entry){
  const sign = entry.points > 0 ? '+' : '';
  showUndoAction(`${sign}${entry.points} · ${entry.name}${pauseOn(entry.date) ? ' · Excluded' : ''}`, () => deleteEntry(entry.id, false));
}
export function showUndoAction(message, callback){
  document.getElementById('undoToastText').textContent = message;
  const toast = document.getElementById('undoToast');
  undoCallback = callback;
  toast.classList.add('show');
  clearTimeout(undoToastTimer);
  undoToastTimer = setTimeout(() => {
    toast.classList.remove('show');
    undoCallback = null;
  }, 5000);
}
export function undoFromToast(){
  const toast = document.getElementById('undoToast');
  toast.classList.remove('show');
  clearTimeout(undoToastTimer);
  const callback = undoCallback;
  undoCallback = null;
  if(callback) callback();
}

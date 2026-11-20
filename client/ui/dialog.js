// Stands in for window.confirm(), which is unreliable inside iOS "Add to Home
// Screen" apps (it can silently no-op instead of showing anything). Every
// destructive action in the app routes through this instead.
let confirmResolver = null;
const dialogOpeners = new Map();
export function visibleDialogLayers(){
  return [...document.querySelectorAll('.overlay.show')].sort((a, b) => {
    const aZ = Number.parseInt(getComputedStyle(a).zIndex, 10) || 0;
    const bZ = Number.parseInt(getComputedStyle(b).zIndex, 10) || 0;
    return aZ - bZ;
  });
}
function syncModalLayers(){
  const visible = visibleDialogLayers();
  const shell = document.querySelector('.shell');
  const nav = document.querySelector('.bottom-nav');
  const hasModal = visible.length > 0;
  if(shell) shell.inert = hasModal;
  if(nav) nav.inert = hasModal;
  visible.forEach((overlay, index) => { overlay.inert = index !== visible.length - 1; });
}
export function openDialog(id, focusId){
  const overlay = document.getElementById(id);
  dialogOpeners.set(id, document.activeElement);
  overlay.classList.add('show');
  overlay.setAttribute('aria-hidden', 'false');
  syncModalLayers();
  setTimeout(() => {
    const target = focusId ? document.getElementById(focusId) : overlay.querySelector('button,input,select,textarea');
    if(target) target.focus();
  }, 30);
}
export function closeDialog(id){
  const overlay = document.getElementById(id);
  overlay.classList.remove('show');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.inert = false;
  syncModalLayers();
  const opener = dialogOpeners.get(id);
  dialogOpeners.delete(id);
  if(opener && opener.isConnected) setTimeout(() => opener.focus(), 0);
}
export function showConfirm(message, confirmLabel){
  return new Promise(resolve => {
    confirmResolver = resolve;
    document.getElementById('confirmMessage').textContent = message;
    document.getElementById('confirmActionBtn').textContent = confirmLabel || 'Delete';
    openDialog('confirmOverlay', 'confirmActionBtn');
  });
}
export function resolveConfirm(result){
  closeDialog('confirmOverlay');
  const resolve = confirmResolver;
  confirmResolver = null;
  if(resolve) resolve(result);
}

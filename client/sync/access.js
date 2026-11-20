import { cloudState, deviceState } from "../state.js";
import { idbGet, idbPut, safeLocalGet, safeLocalRemove, safeLocalSet } from "../storage/database.js";
import { TRUSTED_DEVICE_FALLBACK_KEY, TRUSTED_DEVICE_KEY } from "../storage/keys.js";
import { setCloudStatus } from "../ui/cloud-status.js";
import { showDeviceClearScreen } from "./sign-out.js";

export async function fetchWithTimeout(url, options = {}, timeoutMs = 10000){
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try{
    const response = await fetch(url, { ...options, signal:controller.signal });
    if(response.status === 401 || response.status === 413){
      controller.abort();
      return { response, payload:null };
    }
    const payload = await response.json().catch(error => {
      if(controller.signal.aborted) throw error;
      return null;
    });
    return { response, payload };
  }finally{
    clearTimeout(timer);
  }
}

async function trustedDeviceMarker(){
  const fallback = safeLocalGet(TRUSTED_DEVICE_FALLBACK_KEY);
  if(fallback === '0') return false;
  try{
    if(deviceState.tallyDb && await idbGet(TRUSTED_DEVICE_KEY)) return true;
  }catch(e){}
  return fallback === '1';
}

async function markTrustedDevice(){
  try{
    if(deviceState.tallyDb) await idbPut(TRUSTED_DEVICE_KEY, { trusted:true, markedAt:new Date().toISOString() });
  }catch(e){}
  safeLocalSet(TRUSTED_DEVICE_FALLBACK_KEY, '1');
}

export async function revokeTrustedDevice(){
  // A revocation in browser storage also disables trust from an older database copy.
  const fallbackRevoked = safeLocalSet(TRUSTED_DEVICE_FALLBACK_KEY, '0');
  if(deviceState.tallyDb){
    try{
      await idbPut(TRUSTED_DEVICE_KEY, null);
      if(fallbackRevoked) safeLocalRemove(TRUSTED_DEVICE_FALLBACK_KEY);
      else if(safeLocalGet(TRUSTED_DEVICE_FALLBACK_KEY) === '1'){
        window.localStorage.removeItem(TRUSTED_DEVICE_FALLBACK_KEY);
      }
    }catch(error){
      if(!fallbackRevoked) throw error;
    }
  }else if(!fallbackRevoked && (window.indexedDB || safeLocalGet(TRUSTED_DEVICE_FALLBACK_KEY) === '1')){
    throw new Error('TRUST_REVOCATION_FAILED');
  }
}

export async function handleSessionRejection(){
  cloudState.cloudEnabled = false;
  deviceState.startupBlocked = true;
  deviceState.appReady = false;
  showDeviceClearScreen('Your session ended. Sign in to open your ledger.');
  try{
    await revokeTrustedDevice();
  }catch(error){
    console.warn('Tally: could not revoke offline trust', error);
  }
  window.location.replace('/login');
}

export async function verifyCloudAccess(){
  setCloudStatus('checking', 'Verifying your server-side session. No ledger data has loaded yet.');
  try{
    const { response, payload:account } = await fetchWithTimeout('/api/account', {
      credentials:'same-origin',
      cache:'no-store',
      headers:{ 'Accept':'application/json' }
    });
    if(response.status === 401){
      await handleSessionRejection();
      return false;
    }
    if(!response.ok) throw new Error('ACCOUNT_UNAVAILABLE');
    if(!account || account.authenticated !== true) throw new Error('ACCOUNT_INVALID');
    if(deviceState.startupBlocked || deviceState.peerClearingDevice) return false;
    cloudState.cloudUsername = String(account.username || '');
    cloudState.cloudEnabled = true;
    await markTrustedDevice();
    return true;
  }catch(e){
    if(deviceState.startupBlocked) return false;
    if(await trustedDeviceMarker()){
      cloudState.cloudEnabled = false;
      setCloudStatus('offline', 'Signed-in device recognized. Changes stay on this device and will sync after reconnection.');
      return true;
    }
    deviceState.startupBlocked = true;
    deviceState.startupNeedsConnection = true;
    const loading = document.getElementById('loadingScreen');
    loading.textContent = 'Connect to the internet to sign in';
    return false;
  }
}

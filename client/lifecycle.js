import { isValidDateKey } from "../shared/ledger-contract.ts";
import { todayKey } from "./ledger/days.js";
import { recomputeAllHabitStreaks } from "./ledger/streaks.js";
import { cloudState, deviceState, ledgerState, viewState } from "./state.js";
import { loadAll } from "./storage/recovery.js";
import { syncCloudNow } from "./sync/cloud.js";
import { renderAll } from "./ui/render.js";

let dayRefreshTimer = null;
let lastKnownDay = todayKey();
export function startApp(){
  if(!deviceState.startupInFlight){
    deviceState.startupBlocked = false;
    deviceState.startupNeedsConnection = false;
    const loading = document.getElementById('loadingScreen');
    loading.textContent = 'Checking private ledger…';
    loading.style.display = 'flex';
    deviceState.startupInFlight = loadAll().finally(() => {
      lastKnownDay = todayKey();
      deviceState.startupInFlight = null;
    });
  }
  return deviceState.startupInFlight;
}
// The ledger day is only ever computed at render time (there's no stored "current day").
// These just make sure a render actually happens when it rolls over, covering the case
// where the app is left open and awake across the day-start boundary.
export function updateLedgerDay(){
  const now = todayKey();
  if(now === lastKnownDay) return false;
  const wasShowingLatest = !isValidDateKey(viewState.todayViewDate) || viewState.todayViewDate === lastKnownDay;
  lastKnownDay = now;
  if(wasShowingLatest) viewState.todayViewDate = now;
  return true;
}
export function refreshIfNewDay(){
  if(updateLedgerDay()){
    recomputeAllHabitStreaks();
    renderAll();
  }
}
export function scheduleNextDayRefresh(){
  clearTimeout(dayRefreshTimer);
  const now = new Date();
  const next = new Date(now);
  next.setHours(ledgerState.dayStartHour, 0, 0, 0);
  if(next <= now){
    next.setDate(next.getDate() + 1);
    // Reapply the hour after a spring-forward day normalized a missing hour.
    next.setHours(ledgerState.dayStartHour, 0, 0, 0);
  }
  dayRefreshTimer = setTimeout(() => {
    refreshIfNewDay();
    scheduleNextDayRefresh();
  }, Math.max(1, next.getTime() - now.getTime()));
}
export function refreshCloudIfStale(){
  if(!deviceState.appReady || deviceState.clearingDevice || deviceState.peerClearingDevice || !navigator.onLine || Date.now() - cloudState.lastCloudRefreshAt < 30000) return;
  syncCloudNow();
}

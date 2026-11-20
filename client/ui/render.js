import { renderBackupDate, renderResetPreview, updateBackupReminder } from "../backup/controls.js";
import { summarizeLedger } from "../ledger/scoring.js";
import { scheduleNextDayRefresh } from "../lifecycle.js";
import { viewState } from "../state.js";
import { renderCloudStatus } from "./cloud-status.js";
import { renderDayActivity } from "./day.js";
import { renderHistory } from "./history.js";
import { renderStats, renderTrends } from "./statistics.js";
import { updateStorageStatus } from "./storage.js";
import {
  renderBonusList,
  renderDailyBonusList,
  renderHabitList,
  renderMilestoneList,
  renderSortSelect
} from "./tasks.js";
import {
  activeLedgerDate,
  renderActivityLog,
  renderCompletionControl,
  renderHeader,
  renderTodayNavigator
} from "./today.js";
import { renderTravelList } from "./travel.js";

export function renderAll(didLog){
  scheduleNextDayRefresh();
  const ledger = summarizeLedger();
  if(document.getElementById('travelOverlay')?.classList.contains('show')) renderTravelList();
  renderTodayNavigator();
  renderHeader(didLog, ledger);
  renderCompletionControl(activeLedgerDate(), 'todayCompletionControl');
  renderActivityLog(ledger);
  renderSortSelect('habit');
  renderSortSelect('bonus');
  renderHabitList();
  renderBonusList();
  renderDailyBonusList();
  renderMilestoneList();
  renderHistory(ledger);
  renderStats(ledger);
  renderTrends(ledger);
  renderBackupDate();
  updateBackupReminder();
  renderResetPreview();
  renderCloudStatus();
  if(viewState.selectedDayKey && document.getElementById('dayOverlay').classList.contains('show')){
    renderDayActivity(ledger);
  }
}

export function switchView(view){
  if(!['today','insights','manage'].includes(view)) return;
  viewState.activeView = view;
  document.querySelectorAll('.view').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  document.querySelectorAll('.nav-btn').forEach(btn => {
    const active = btn.dataset.view === view;
    btn.classList.toggle('active', active);
    if(active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  window.scrollTo({ top:0, behavior:matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  if(view === 'manage'){
    updateStorageStatus();
    renderCloudStatus();
  }
  renderHeader();
}

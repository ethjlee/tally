import { setTravelPauses } from "../ledger/days.js";
import { recomputeAllHabitStreaks } from "../ledger/streaks.js";
import { updateLedgerDay } from "../lifecycle.js";
import { ledgerState } from "../state.js";

export function applyValidatedState(clean){
  ledgerState.taskSections = clean.taskSections;
  ledgerState.habits = clean.habits;
  ledgerState.bonusTasks = clean.bonusTasks;
  ledgerState.dailyBonuses = clean.dailyBonuses;
  ledgerState.milestones = clean.milestones;
  setTravelPauses(clean.travelPauses);
  ledgerState.completedDays = clean.completedDays;
  ledgerState.entries = clean.entries;
  ledgerState.dailyBase = clean.dailyBase;
  ledgerState.successThreshold = clean.successThreshold;
  ledgerState.dayStartHour = clean.dayStartHour;
  ledgerState.trackingStartDate = clean.trackingStartDate;
  ledgerState.lastBackupAt = clean.lastBackupAt;
  ledgerState.historyRangeDays = clean.historyRangeDays;
  ledgerState.backupReminderDays = clean.backupReminderDays;
  ledgerState.taskSortModes = { ...clean.taskSortModes };
  ledgerState.stateRevision = clean.revision || 0;
  updateLedgerDay();
  recomputeAllHabitStreaks();
}

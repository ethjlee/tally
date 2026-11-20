import { ledgerDateKeyForHour } from "./ledger/calendar.js";
import { uid } from "./ledger/id.js";

export const DEFAULT_BACKUP_REMINDER_DAYS = 7;
const DEFAULT_DAY_START_HOUR = 7;
export const CLIENT_ID = uid();

export const ledgerState = {
  habits: [],
  bonusTasks: [],
  dailyBonuses: [],
  taskSections: [],
  entries: [],
  milestones: [],
  travelPauses: [],
  completedDays: [],
  dailyBase: 100,
  successThreshold: 80,
  dayStartHour: DEFAULT_DAY_START_HOUR,
  trackingStartDate: ledgerDateKeyForHour(DEFAULT_DAY_START_HOUR),
  historyRangeDays: 14,
  lastBackupAt: null,
  backupReminderDays: DEFAULT_BACKUP_REMINDER_DAYS,
  taskSortModes: { habit:'manual', bonus:'manual' },
  stateRevision: 0,
};

export const deviceState = {
  storageAvailable: true,
  storageMode: 'memory',
  tallyDb: null,
  durableRevision: 0,
  durableBaseSnapshot: null,
  clearingDevice: false,
  peerClearingDevice: false,
  unreadableLocalState: false,
  startupBlocked: false,
  startupNeedsConnection: false,
  startupInFlight: null,
  appReady: false,
  canUseLocalStorage: false,
  migratedV7Revision: null,
  pendingV7MigrationBase: null,
  persistInFlight: null,
  persistDirty: false,
  persistFailed: false,
  syncChannel: null,
  stickyStorageWarning: false,
};

export const cloudState = {
  cloudEnabled: false,
  cloudBaseSnapshot: null,
  cloudSyncInFlight: null,
  cloudRefreshRequested: false,
  cloudRollback: null,
  cloudRollbackResolving: false,
  cloudSyncTimer: null,
  cloudUsername: '',
  cloudLastSyncedAt: null,
  cloudStatusMode: 'checking',
  cloudStatusMessage: 'Checking your private account…',
  lastCloudRefreshAt: 0,
};

export const viewState = {
  activeView: 'today',
  todayViewDate: null,
  selectedDayKey: null,
  selectedHistoryDate: null,
  pendingCsvBackupText: null,
  editingPause: null,
  reminderDismissedThisSession: false,
};

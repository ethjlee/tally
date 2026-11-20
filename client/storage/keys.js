export const DB_NAME = 'tally-ledger';
export const DB_VERSION = 1;
export const DB_STORE = 'records';
// Older cached clients can replace their own primary and recovery records at
// startup. Keep the current ledger and sync base outside those write paths.
export const STATE_KEY = 'state-v8';
export const PREVIOUS_STATE_KEY = 'previous-v8';
export const RECOVERY_KEY = 'recovery-v8';
export const FALLBACK_STATE_KEY = 'tally-state-v8';
export const FALLBACK_PREVIOUS_KEY = 'tally-state-previous-v8';
export const EMERGENCY_STATE_KEY = 'tally-emergency-v8';
export const RECOVERY_STATE_KEY = 'tally-recovery-v8';
export const CLOUD_BASE_KEY = 'cloud-base-v8';
export const CLOUD_BASE_FALLBACK_KEY = 'tally-cloud-base-v8';
export const PENDING_CLOUD_WRITE_KEY = 'cloud-pending-v8';
export const PENDING_CLOUD_WRITE_FALLBACK_KEY = 'tally-cloud-pending-v8';
export const LEGACY_CLOUD_BASE_KEY = 'cloud-base-v1';
export const LEGACY_CLOUD_BASE_FALLBACK_KEY = 'tally-cloud-base-v1';
export const V7_MIGRATION_BASE_KEY = 'migration-base-v7';
export const V7_MIGRATION_BASE_FALLBACK_KEY = 'tally-migration-base-v7';
export const V7_DB_SNAPSHOTS = [['state-v7','previous ledger'], ['previous-v7','previous ledger copy'], ['recovery-v7','previous recovery copy']];
export const V7_LOCAL_SNAPSHOTS = ['tally-state-v7','tally-emergency-v7','tally-state-previous-v7','tally-recovery-v7'].map(key => [key,key]);
export const LEGACY_DB_SNAPSHOTS = [
  ['state', 'legacy on-device database'],
  ['previous', 'legacy previous database copy'],
  ['recovery', 'legacy database recovery copy']
];
export const LEGACY_LOCAL_SNAPSHOTS = [
  ['tally-emergency-v2', 'legacy emergency copy'],
  ['tally-state-v2', 'legacy browser storage copy'],
  ['tally-state-previous-v2', 'legacy previous browser storage copy'],
  ['tally-recovery-v2', 'legacy browser recovery copy']
];
export const TRUSTED_DEVICE_KEY = 'trusted-device-v1';
export const TRUSTED_DEVICE_FALLBACK_KEY = 'tally-trusted-device-v1';
export const MAX_BACKUP_BYTES = 128 * 1024 * 1024;

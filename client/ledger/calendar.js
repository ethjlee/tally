// The "ledger day" starts at whatever hour is set in Settings ("Day starts at"),
// not midnight. Compare local calendar fields directly so the boundary stays at the
// chosen wall-clock hour even when daylight-saving time changes.
function formatLocalDate(d){
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
export function ledgerDateKeyForHour(hour, d = new Date()){
  const local = new Date(d);
  if(local.getHours() < hour) local.setDate(local.getDate() - 1);
  return formatLocalDate(local);
}
export function addDaysToKey(key, n){
  const [y,m,dn] = String(key).split('-').map(Number);
  const d = new Date(0);
  d.setUTCHours(12, 0, 0, 0);
  d.setUTCFullYear(y, m - 1, dn);
  d.setUTCDate(d.getUTCDate() + n);
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function dateKeyOrdinal(key){
  const [y,m,d] = String(key).split('-').map(Number);
  const utc = new Date(0);
  utc.setUTCHours(0, 0, 0, 0);
  utc.setUTCFullYear(y, m - 1, d);
  return Math.floor(utc.getTime() / 86400000);
}
export function calendarDaysInclusive(start, end){
  if(start > end) return 0;
  return dateKeyOrdinal(end) - dateKeyOrdinal(start) + 1;
}
export function laterDateKey(a, b){ return a > b ? a : b; }

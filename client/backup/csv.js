import { isInStatsWindow, pauseOn } from "../ledger/days.js";
import { allActivityEntries } from "../ledger/scoring.js";
import { SAFE_ID, buildExport, validIsoTimestamp, validateBackupObject } from "../ledger/snapshot.js";
import { MAX_MANUAL_ORDER } from "../../shared/ledger-contract.ts";
import { MAX_BACKUP_BYTES } from "../storage/keys.js";

function csvCell(value, protectFormula){
  let text = String(value == null ? '' : value);
  if(protectFormula && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const FULL_CSV_BACKUP_VERSION = '8';
const FULL_CSV_V1_HEADERS = [
  'format_version','record_type','revision','writer_id','id','name_json','type',
  'points','streak','last_date','ledger_date','timestamp_ms','habit_id','bonus_id',
  'daily_base','success_threshold','day_start_hour','tracking_start_date',
  'history_range_days','last_backup_at','exported_at'
];
const FULL_CSV_V2_HEADERS = [...FULL_CSV_V1_HEADERS, 'threshold_days', 'description_json'];
const FULL_CSV_V3_HEADERS = [...FULL_CSV_V2_HEADERS, 'backup_reminder_days'];
const FULL_CSV_V4_HEADERS = [
  ...FULL_CSV_V3_HEADERS,
  'good_sort_mode','bad_sort_mode','bonus_sort_mode','manual_order'
];
const FULL_CSV_V5_HEADERS = [...FULL_CSV_V4_HEADERS, 'section_id'];
const FULL_CSV_HEADERS = [...FULL_CSV_V5_HEADERS, 'habit_sort_mode'];
function fullCsvRow(values){
  return FULL_CSV_HEADERS.map(header => values[header] == null ? '' : values[header]);
}
export function buildFullCsvBackup(){
  const snapshot = buildExport();
  const rows = [
    fullCsvRow({
      format_version:FULL_CSV_BACKUP_VERSION,
      record_type:'meta',
      revision:snapshot.revision,
      writer_id:snapshot.writerId,
      exported_at:snapshot.exportedAt
    }),
    fullCsvRow({
      record_type:'settings',
      daily_base:snapshot.settings.dailyBase,
      success_threshold:snapshot.settings.successThreshold,
      day_start_hour:snapshot.settings.dayStartHour,
      tracking_start_date:snapshot.settings.trackingStartDate,
      history_range_days:snapshot.settings.historyRangeDays,
      last_backup_at:snapshot.settings.lastBackupAt || '',
      backup_reminder_days:snapshot.settings.backupReminderDays,
      good_sort_mode:snapshot.settings.taskSortModes.habit,
      bad_sort_mode:snapshot.settings.taskSortModes.habit,
      bonus_sort_mode:snapshot.settings.taskSortModes.bonus,
      habit_sort_mode:snapshot.settings.taskSortModes.habit
    }),
    ...snapshot.data.taskSections.map(section => fullCsvRow({
      record_type:'task_section',
      id:section.id,
      name_json:JSON.stringify(section.name),
      type:section.kind,
      manual_order:section.order
    })),
    ...snapshot.data.habits.map(habit => fullCsvRow({
      record_type:'habit',
      id:habit.id,
      name_json:JSON.stringify(habit.name),
      type:habit.type,
      points:habit.points,
      streak:habit.streak,
      last_date:habit.lastDate || '',
      manual_order:habit.order,
      section_id:habit.sectionId || ''
    })),
    ...snapshot.data.bonusTasks.map(bonus => fullCsvRow({
      record_type:'bonus',
      id:bonus.id,
      name_json:JSON.stringify(bonus.name),
      points:bonus.points,
      manual_order:bonus.order,
      section_id:bonus.sectionId || ''
    })),
    ...snapshot.data.dailyBonuses.map(bonus => fullCsvRow({
      record_type:'daily_bonus',
      id:bonus.id,
      name_json:JSON.stringify(bonus.name),
      points:bonus.points,
      description_json:JSON.stringify(bonus.description || '')
    })),
    ...snapshot.data.milestones.map(milestone => fullCsvRow({
      record_type:'milestone',
      id:milestone.id,
      name_json:JSON.stringify(milestone.name),
      points:milestone.points,
      threshold_days:milestone.days,
      description_json:JSON.stringify(milestone.description || '')
    })),
    ...snapshot.data.travelPauses.map(pause => fullCsvRow({
      record_type:'travel_pause', id:pause.id, ledger_date:pause.start, last_date:pause.end
    })),
    ...snapshot.data.completedDays.map(day => fullCsvRow({
      record_type:'completed_day',
      id:day.id,
      ledger_date:day.date,
      timestamp_ms:day.ts
    })),
    ...snapshot.data.entries.map(entry => fullCsvRow({
      record_type:'entry',
      id:entry.id,
      name_json:JSON.stringify(entry.name),
      type:entry.type,
      points:entry.points,
      ledger_date:entry.date,
      timestamp_ms:entry.ts,
      habit_id:entry.habitId || '',
      bonus_id:entry.bonusId || ''
    }))
  ];
  const text = '\uFEFF' + [FULL_CSV_HEADERS, ...rows]
    .map(row => row.map(value => csvCell(value, false)).join(','))
    .join('\r\n') + '\r\n';
  return { text, exportedAt:snapshot.exportedAt };
}
function parseCsvRows(raw){
  if(typeof raw !== 'string') throw new Error('The CSV backup must be text.');
  if(raw.length > MAX_BACKUP_BYTES) throw new Error('The CSV backup is too large.');
  const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
  if(!text) throw new Error('The CSV backup is empty.');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let quoteClosed = false;
  const finishField = () => {
    row.push(field);
    field = '';
    quoteClosed = false;
  };
  const finishRow = () => {
    finishField();
    rows.push(row);
    row = [];
  };
  for(let i = 0; i < text.length; i++){
    const char = text[i];
    if(inQuotes){
      if(char === '"'){
        if(text[i + 1] === '"'){
          field += '"';
          i++;
        }else{
          inQuotes = false;
          quoteClosed = true;
        }
      }else{
        field += char;
      }
      continue;
    }
    if(quoteClosed){
      if(char === ','){
        finishField();
      }else if(char === '\n'){
        finishRow();
      }else if(char === '\r'){
        if(text[i + 1] === '\n') i++;
        finishRow();
      }else{
        throw new Error('The CSV backup has characters after a closing quote.');
      }
      continue;
    }
    if(char === '"'){
      if(field) throw new Error('The CSV backup has a quote inside an unquoted field.');
      inQuotes = true;
    }else if(char === ','){
      finishField();
    }else if(char === '\n'){
      finishRow();
    }else if(char === '\r'){
      if(text[i + 1] === '\n') i++;
      finishRow();
    }else{
      field += char;
    }
  }
  if(inQuotes) throw new Error('The CSV backup has an unclosed quoted field.');
  if(quoteClosed || field || row.length) finishRow();
  return rows;
}
function csvBackupInteger(value, label, min, max){
  if(!/^-?(0|[1-9]\d*)$/.test(value)) throw new Error(`${label} must be a whole number.`);
  const number = Number(value);
  if(!Number.isSafeInteger(number) || number < min || number > max) throw new Error(`${label} is out of range.`);
  return number;
}
function csvBackupName(value, rowNumber){
  let name;
  try{ name = JSON.parse(value); }
  catch(e){ throw new Error(`Row ${rowNumber} has an invalid encoded name.`); }
  if(typeof name !== 'string') throw new Error(`Row ${rowNumber} has an invalid encoded name.`);
  return name;
}
function assertCsvFields(record, allowed, rowNumber, headers = FULL_CSV_HEADERS){
  for(const header of headers){
    if(!allowed.includes(header) && record[header] !== ''){
      throw new Error(`Row ${rowNumber} has unexpected data in ${header}.`);
    }
  }
}
export function parseFullCsvBackup(raw){
  const rows = parseCsvRows(raw);
  if(rows.length < 3) throw new Error('The CSV backup is missing required rows.');
  const matchesHeaders = headers =>
    rows[0].length === headers.length && headers.every((header, index) => rows[0][index] === header);
  const headers = matchesHeaders(FULL_CSV_HEADERS)
    ? FULL_CSV_HEADERS
    : (matchesHeaders(FULL_CSV_V5_HEADERS)
      ? FULL_CSV_V5_HEADERS
      : (matchesHeaders(FULL_CSV_V4_HEADERS)
        ? FULL_CSV_V4_HEADERS
        : (matchesHeaders(FULL_CSV_V3_HEADERS)
          ? FULL_CSV_V3_HEADERS
          : (matchesHeaders(FULL_CSV_V2_HEADERS)
            ? FULL_CSV_V2_HEADERS
            : (matchesHeaders(FULL_CSV_V1_HEADERS) ? FULL_CSV_V1_HEADERS : null)))));
  if(!headers){
    throw new Error('This is not a recognized Tally CSV backup.');
  }
  const records = rows.slice(1).map((values, index) => {
    const rowNumber = index + 2;
    if(values.length !== headers.length) throw new Error(`Row ${rowNumber} has the wrong number of columns.`);
    if(values.every(value => value === '')) throw new Error(`Row ${rowNumber} is blank.`);
    return {
      rowNumber,
      values:Object.fromEntries(headers.map((header, column) => [header, values[column]]))
    };
  });
  const metaRows = records.filter(record => record.values.record_type === 'meta');
  const settingsRows = records.filter(record => record.values.record_type === 'settings');
  if(metaRows.length !== 1) throw new Error('The CSV backup must contain exactly one meta row.');
  if(settingsRows.length !== 1) throw new Error('The CSV backup must contain exactly one settings row.');

  const meta = metaRows[0];
  assertCsvFields(meta.values, ['format_version','record_type','revision','writer_id','exported_at'], meta.rowNumber, headers);
  const expectedVersion = headers === FULL_CSV_HEADERS
    ? (['6','7'].includes(meta.values.format_version) ? meta.values.format_version : FULL_CSV_BACKUP_VERSION)
    : (headers === FULL_CSV_V5_HEADERS
      ? '5'
      : (headers === FULL_CSV_V4_HEADERS
        ? '4'
        : (headers === FULL_CSV_V3_HEADERS ? '3' : (headers === FULL_CSV_V2_HEADERS ? '2' : '1'))));
  if(meta.values.format_version !== expectedVersion){
    throw new Error(`CSV backup version ${meta.values.format_version || '(missing)'} is not supported.`);
  }
  const exportedAt = validIsoTimestamp(meta.values.exported_at);
  if(!exportedAt) throw new Error('The CSV backup has an invalid export date.');
  if(meta.values.writer_id && !SAFE_ID.test(meta.values.writer_id)) throw new Error('The CSV backup has an invalid writer ID.');
  const revision = csvBackupInteger(meta.values.revision, 'CSV revision', 0, Number.MAX_SAFE_INTEGER);

  const settingsRow = settingsRows[0];
  const settings = settingsRow.values;
  assertCsvFields(settings, [
    'record_type','daily_base','success_threshold','day_start_hour',
    'tracking_start_date','history_range_days','last_backup_at',
    'backup_reminder_days','good_sort_mode','bad_sort_mode','bonus_sort_mode','habit_sort_mode'
  ], settingsRow.rowNumber, headers);
  if(settings.last_backup_at && !validIsoTimestamp(settings.last_backup_at)){
    throw new Error('The CSV backup has an invalid previous backup date.');
  }
  const historyRange = settings.history_range_days === 'all'
    ? 'all'
    : csvBackupInteger(settings.history_range_days, 'History range', 1, 100000);
  if(![7,14,30,90,'all'].includes(historyRange)) throw new Error('The CSV backup has an unsupported history range.');

  const habits = [];
  const bonusTasks = [];
  const restoredDailyBonuses = [];
  const restoredTaskSections = [];
  const restoredMilestones = [];
  const restoredPauses = [];
  const restoredCompletedDays = [];
  const restoredEntries = [];
  for(const record of records){
    const value = record.values;
    if(value.record_type === 'meta' || value.record_type === 'settings') continue;
    if(value.record_type === 'task_section'){
      if(headers !== FULL_CSV_HEADERS && headers !== FULL_CSV_V5_HEADERS) throw new Error(`Row ${record.rowNumber} has an unsupported record type.`);
      assertCsvFields(value, ['record_type','id','name_json','type','manual_order'], record.rowNumber, headers);
      restoredTaskSections.push({
        id:value.id,
        name:csvBackupName(value.name_json, record.rowNumber),
        kind:value.type,
        order:csvBackupInteger(value.manual_order, `Row ${record.rowNumber} manual order`, 0, MAX_MANUAL_ORDER)
      });
    }else if(value.record_type === 'habit'){
      assertCsvFields(value, ['record_type','id','name_json','type','points','streak','last_date','manual_order','section_id'], record.rowNumber, headers);
      const habit = {
        id:value.id,
        name:csvBackupName(value.name_json, record.rowNumber),
        type:value.type,
        points:csvBackupInteger(value.points, `Row ${record.rowNumber} points`, 1, 999),
        streak:csvBackupInteger(value.streak, `Row ${record.rowNumber} streak`, 0, 100000),
        lastDate:value.last_date || null
      };
      if(headers === FULL_CSV_HEADERS || headers === FULL_CSV_V5_HEADERS || headers === FULL_CSV_V4_HEADERS){
        habit.order = csvBackupInteger(value.manual_order, `Row ${record.rowNumber} manual order`, 0, MAX_MANUAL_ORDER);
      }
      if(headers === FULL_CSV_HEADERS || headers === FULL_CSV_V5_HEADERS) habit.sectionId = value.section_id || null;
      habits.push(habit);
    }else if(value.record_type === 'bonus'){
      assertCsvFields(value, ['record_type','id','name_json','points','manual_order','section_id'], record.rowNumber, headers);
      const bonus = {
        id:value.id,
        name:csvBackupName(value.name_json, record.rowNumber),
        points:csvBackupInteger(value.points, `Row ${record.rowNumber} points`, 1, 999)
      };
      if(headers === FULL_CSV_HEADERS || headers === FULL_CSV_V5_HEADERS || headers === FULL_CSV_V4_HEADERS){
        bonus.order = csvBackupInteger(value.manual_order, `Row ${record.rowNumber} manual order`, 0, MAX_MANUAL_ORDER);
      }
      if(headers === FULL_CSV_HEADERS || headers === FULL_CSV_V5_HEADERS) bonus.sectionId = value.section_id || null;
      bonusTasks.push(bonus);
    }else if(value.record_type === 'entry'){
      assertCsvFields(value, [
        'record_type','id','name_json','type','points','ledger_date',
        'timestamp_ms','habit_id','bonus_id'
      ], record.rowNumber, headers);
      const entry = {
        id:value.id,
        name:csvBackupName(value.name_json, record.rowNumber),
        type:value.type,
        points:csvBackupInteger(value.points, `Row ${record.rowNumber} points`, -9999, 9999),
        date:value.ledger_date,
        ts:csvBackupInteger(value.timestamp_ms, `Row ${record.rowNumber} timestamp`, 0, 8640000000000000)
      };
      if(value.habit_id) entry.habitId = value.habit_id;
      if(value.bonus_id) entry.bonusId = value.bonus_id;
      restoredEntries.push(entry);
    }else if(value.record_type === 'travel_pause' && expectedVersion === '8'){
      assertCsvFields(value, ['record_type','id','ledger_date','last_date'], record.rowNumber, headers);
      restoredPauses.push({ id:value.id, start:value.ledger_date, end:value.last_date || null });
    }else if(value.record_type === 'daily_bonus'){
      if(Number(expectedVersion) < 7) throw new Error(`Row ${record.rowNumber} has an unsupported record type.`);
      assertCsvFields(value, ['record_type','id','name_json','points','description_json'], record.rowNumber, headers);
      restoredDailyBonuses.push({
        id:value.id,
        name:csvBackupName(value.name_json, record.rowNumber),
        points:csvBackupInteger(value.points, `Row ${record.rowNumber} points`, 1, 9999),
        description:csvBackupName(value.description_json, record.rowNumber)
      });
    }else if(value.record_type === 'milestone'){
      if(headers === FULL_CSV_V1_HEADERS) throw new Error(`Row ${record.rowNumber} has an unsupported record type.`);
      assertCsvFields(value, [
        'record_type','id','name_json','points','threshold_days','description_json'
      ], record.rowNumber, headers);
      restoredMilestones.push({
        id:value.id,
        name:csvBackupName(value.name_json, record.rowNumber),
        days:csvBackupInteger(value.threshold_days, `Row ${record.rowNumber} successful day`, 1, 100000),
        points:csvBackupInteger(value.points, `Row ${record.rowNumber} points`, 1, 9999),
        description:csvBackupName(value.description_json, record.rowNumber)
      });
    }else if(value.record_type === 'completed_day'){
      if(headers === FULL_CSV_V1_HEADERS) throw new Error(`Row ${record.rowNumber} has an unsupported record type.`);
      assertCsvFields(value, ['record_type','id','ledger_date','timestamp_ms'], record.rowNumber, headers);
      restoredCompletedDays.push({
        id:value.id,
        date:value.ledger_date,
        ts:csvBackupInteger(value.timestamp_ms, `Row ${record.rowNumber} timestamp`, 0, 8640000000000000)
      });
    }else{
      throw new Error(`Row ${record.rowNumber} has an unsupported record type.`);
    }
  }
  return validateBackupObject({
    app:'Tally',
    schemaVersion:Number(expectedVersion),
    revision,
    writerId:meta.values.writer_id || null,
    exportedAt,
    data:{
      taskSections:restoredTaskSections,
      habits,
      bonusTasks,
      dailyBonuses:restoredDailyBonuses,
      milestones:restoredMilestones,
      travelPauses:restoredPauses,
      completedDays:restoredCompletedDays,
      entries:restoredEntries
    },
    settings:{
      dailyBase:csvBackupInteger(settings.daily_base, 'Daily base', 0, 9999),
      successThreshold:csvBackupInteger(settings.success_threshold, 'Success threshold', 0, 9999),
      dayStartHour:csvBackupInteger(settings.day_start_hour, 'Day start hour', 0, 23),
      trackingStartDate:settings.tracking_start_date,
      historyRangeDays:historyRange,
      lastBackupAt:settings.last_backup_at || null,
      // Version 1/2 CSV files predate this column. Default legacy imports to Off
      // rather than unexpectedly enabling reminders that the file could not express.
      backupReminderDays:headers === FULL_CSV_HEADERS || headers === FULL_CSV_V5_HEADERS || headers === FULL_CSV_V4_HEADERS || headers === FULL_CSV_V3_HEADERS
        ? csvBackupInteger(settings.backup_reminder_days, 'Backup reminder cadence', 0, 366)
        : 0,
      taskSortModes:headers === FULL_CSV_HEADERS
        ? {
            habit:settings.habit_sort_mode,
            bonus:settings.bonus_sort_mode
          }
        : (headers === FULL_CSV_V5_HEADERS || headers === FULL_CSV_V4_HEADERS
          ? {
            good:settings.good_sort_mode,
            bad:settings.bad_sort_mode,
            bonus:settings.bonus_sort_mode
          }
          : { good:'manual', bad:'manual', bonus:'manual' })
    }
  }, false);
}
export function buildActivityCsv(){
  const headers = ['ledger_date','logged_at','name','type','points','included_in_statistics','source','entry_id','habit_id','bonus_id','milestone_id','daily_bonus_id'];
  const rows = allActivityEntries()
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date) || a.ts - b.ts || a.id.localeCompare(b.id))
    .map(entry => [
      entry.date,
      new Date(entry.ts).toISOString(),
      entry.name,
      entry.type,
      Number(entry.points) || 0,
      isInStatsWindow(entry.date) && !pauseOn(entry.date) ? 'true' : 'false',
      entry.dailyBonusId ? 'automatic_daily_bonus' : (entry.derived ? 'automatic_milestone' : 'manual'),
      entry.id,
      entry.habitId || '',
      entry.bonusId || '',
      entry.milestoneId || '',
      entry.dailyBonusId || ''
    ]);
  return '\uFEFF' + [headers, ...rows]
    .map(row => row.map((value, index) => csvCell(value, index === 2)).join(','))
    .join('\r\n') + '\r\n';
}

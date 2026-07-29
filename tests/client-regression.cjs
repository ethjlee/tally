const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');
const { indexedDB, IDBKeyRange, IDBFactory } = require('fake-indexeddb');

const publicDir = path.join(__dirname, '..', 'public');
const html = fs.readFileSync(path.join(publicDir, 'tally.html'), 'utf8')
  .replace('<link rel="stylesheet" href="/tally.css">', `<style>${fs.readFileSync(path.join(publicDir, 'tally.css'), 'utf8')}</style>`)
  .replace('<script src="/tally.js" defer></script>', `<script>${fs.readFileSync(path.join(publicDir, 'tally.js'), 'utf8')}</script>`);
const browserErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => browserErrors.push(String(error.message || error)));
virtualConsole.on('error', error => browserErrors.push(String(error)));

function installNetworkStubs(window, sharedCloud = null) {
  const cloud = sharedCloud || { revision: 0, snapshot: null, updatedAt: null };
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    value: { register: async () => ({}) }
  });
  window.fetch = async (input, options = {}) => {
    const url = new URL(String(input), window.location.href);
    if (url.pathname === '/api/account') {
      return new Response(JSON.stringify({ authenticated: true, username: 'owner' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (url.pathname === '/api/sync' && (!options.method || options.method === 'GET')) {
      return new Response(JSON.stringify({
        cloudRevision: cloud.revision,
        snapshot: cloud.snapshot,
        updatedAt: cloud.updatedAt
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/sync' && options.method === 'PUT') {
      const body = JSON.parse(options.body);
      if (body.baseRevision !== cloud.revision) {
        return new Response(JSON.stringify({
          error: 'REVISION_CONFLICT',
          cloudRevision: cloud.revision,
          snapshot: cloud.snapshot,
          updatedAt: cloud.updatedAt
        }), { status: 409, headers: { 'Content-Type': 'application/json' } });
      }
      cloud.revision++;
      cloud.snapshot = body.snapshot;
      cloud.updatedAt = new Date().toISOString();
      return new Response(JSON.stringify({
        status: 'written',
        cloudRevision: cloud.revision,
        updatedAt: cloud.updatedAt
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.pathname === '/api/auth/sign-out') {
      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Not found', { status: 404 });
  };
}

const dom = new JSDOM(html, {
  url: 'https://tally.local/',
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    installNetworkStubs(window);
    window.indexedDB = indexedDB;
    window.IDBKeyRange = IDBKeyRange;
    window.matchMedia = () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {}
    });
    window.scrollTo = () => {};
    Object.defineProperty(window.navigator, 'storage', {
      configurable: true,
      value: {
        persisted: async () => true,
        persist: async () => true,
        estimate: async () => ({ usage: 4096, quota: 1024 * 1024 })
      }
    });
  }
});

const { window } = dom;
const results = [];
const failures = [];

function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  if (!pass) failures.push({ name, detail });
}

function eq(actual, expected, name) {
  const pass = Object.is(actual, expected);
  record(name, pass, pass ? '' : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function ok(value, name, detail = '') {
  record(name, Boolean(value), detail);
}

function waitFor(predicate, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeout) {
        clearInterval(timer);
        reject(new Error('Timed out'));
      }
    }, 10);
  });
}

function setLedger({ start, entries = [], completedDays = [], milestones = [], base = 100, threshold = 80 }) {
  const payload = JSON.stringify({ start, entries, completedDays, milestones, base, threshold });
  window.eval(`
    {
      const payload = ${payload};
      trackingStartDate = payload.start;
      dailyBase = payload.base;
      successThreshold = payload.threshold;
      entries = payload.entries;
      completedDays = payload.completedDays;
      milestones = payload.milestones;
      taskSections = [];
      habits = [];
      bonusTasks = [];
      taskSortModes = { good:'manual', bad:'manual', bonus:'manual' };
      todayViewDate = todayKey();
      recomputeAllHabitStreaks();
    }
  `);
}

(async () => {
  await waitFor(() => window.document.getElementById('loadingScreen').style.display === 'none');
  ok(!browserErrors.length, 'Boots without browser runtime errors', browserErrors.join(' | '));
  eq(window.document.querySelectorAll('.view').length, 3, 'Renders all three primary views');
  eq(window.document.querySelectorAll('#milestoneList').length, 1, 'Milestone editor appears once');
  ok(window.document.getElementById('todayView').contains(window.document.getElementById('milestoneList')), 'Milestone editor is on Today');

  const today = window.todayKey();
  const d1 = window.addDaysToKey(today, -2);
  const d2 = window.addDaysToKey(today, -1);
  const d3 = today;

  window.eval(`
    trackingStartDate = addDaysToKey('${today}', -20);
    entries = Array.from({ length:20 }, (_, index) => {
      const date = addDaysToKey('${today}', index - 20);
      return {
        id:'fixed_history_' + index, date, name:'Fixed credit', type:'good',
        points:10, ts:index + 1, habitId:'fixed_credit'
      };
    });
    completedDays = [];
    milestones = [];
    taskSections = [];
    bonusTasks = [];
    habits = [
      { id:'fixed_credit', name:'Fixed credit', type:'good', points:10, streak:20, lastDate:'${d2}', order:0, sectionId:null },
      { id:'fixed_debit', name:'Fixed debit', type:'bad', points:7, streak:0, lastDate:null, order:0, sectionId:null }
    ];
    renderAll();
  `);
  window.logHabit('fixed_credit');
  eq(window.eval(`entries.find(entry => entry.habitId === 'fixed_credit').points`), 10, 'A long credit streak still awards configured points');
  eq(window.eval(`habits.find(habit => habit.id === 'fixed_credit').streak`), 21, 'Credit habit streak remains informational');
  window.logHabit('fixed_credit');
  eq(window.eval(`entries.filter(entry => entry.habitId === 'fixed_credit').every(entry => entry.points === 10)`), true, 'Repeated same-day credit taps remain fixed');
  window.logHabit('fixed_debit');
  eq(window.eval(`entries.find(entry => entry.habitId === 'fixed_debit').points`), -7, 'Debit points remain fixed and negative');
  ok(window.document.getElementById('goodList').textContent.includes('🔥 21-day streak'), 'Informational habit streak remains visible');
  ok(!/·\s*×\d+\.\d+/.test(window.document.getElementById('goodList').textContent), 'Multiplier label is absent from the habit UI');
  eq(window.document.querySelector('#goodList .pill').textContent, '+10', 'Credit pill shows configured points');

  window.eval(`
    trackingStartDate = '${d1}';
    todayViewDate = '${today}';
    taskSections = [];
    habits = [
      { id:'sort_z', name:'Zulu', type:'good', points:30, streak:0, lastDate:null, order:0, sectionId:null },
      { id:'sort_a', name:'Alpha', type:'good', points:10, streak:0, lastDate:null, order:1, sectionId:null },
      { id:'sort_m', name:'Mike', type:'good', points:20, streak:0, lastDate:null, order:2, sectionId:null }
    ];
    bonusTasks = [
      { id:'bonus_z', name:'Zulu bonus', points:9, order:0, sectionId:null },
      { id:'bonus_a', name:'Alpha bonus', points:3, order:1, sectionId:null }
    ];
    entries = [
      { id:'use_1', date:'${d1}', name:'Mike', type:'good', points:20, ts:1, habitId:'sort_m' },
      { id:'use_2', date:'${d2}', name:'Mike', type:'good', points:20, ts:2, habitId:'sort_m' },
      { id:'use_3', date:'${d2}', name:'Alpha', type:'good', points:10, ts:3, habitId:'sort_a' }
    ];
    completedDays = [];
    milestones = [];
    taskSortModes = { good:'manual', bad:'manual', bonus:'manual' };
    renderAll();
  `);
  const visibleCreditNames = () => [...window.document.querySelectorAll('#goodList .row-name')].map(node => node.textContent);
  eq(JSON.stringify(visibleCreditNames()), JSON.stringify(['Zulu','Alpha','Mike']), 'Manual sorting preserves explicit task order');
  window.setTaskSortMode('good', 'name-asc');
  eq(JSON.stringify(visibleCreditNames()), JSON.stringify(['Alpha','Mike','Zulu']), 'A-to-Z task sorting works');
  window.setTaskSortMode('good', 'usage-desc');
  eq(JSON.stringify(visibleCreditNames()), JSON.stringify(['Mike','Alpha','Zulu']), 'Most-used task sorting uses linked history');
  window.setTaskSortMode('good', 'manual');
  window.moveTaskToPosition('good', 'sort_z', null, 'sort_m');
  eq(JSON.stringify(visibleCreditNames()), JSON.stringify(['Alpha','Zulu','Mike']), 'Manual move changes and rerenders stored task order');
  eq(window.document.querySelectorAll('#goodList .drag-handle').length, 3, 'Every credit has one six-dot drag handle');
  eq(window.document.querySelectorAll('#goodList .drag-handle circle').length, 18, 'Drag handles render the requested six-dot grip');
  eq(window.document.querySelectorAll('#goodList .order-btn').length, 0, 'Old visible arrow controls are removed');
  ok(window.document.querySelector('#goodList [data-task-row]').lastElementChild.classList.contains('drag-handle'), 'Drag handle is the rightmost row control');
  window.setTaskSortMode('good', 'name-asc');
  window.beginTaskDrag({ preventDefault() {}, pointerId:1 }, window.document.querySelector('#goodList .drag-handle'));
  eq(window.eval(`taskSortModes.good`), 'manual', 'Touching a handle in automatic mode switches the list to Manual');

  window.eval(`
    taskSections = [
      { id:'section_morning', name:'Morning', kind:'good', order:0 },
      { id:'section_evening', name:'Evening', kind:'good', order:1 },
      { id:'section_bonus', name:'Special', kind:'bonus', order:0 }
    ];
    habits.find(item => item.id === 'sort_m').sectionId = 'section_morning';
    habits.find(item => item.id === 'sort_m').order = 0;
    renderAll();
  `);
  window.moveTaskToPosition('good', 'sort_z', 'section_morning', 'sort_m');
  eq(window.eval(`habits.find(item => item.id === 'sort_z').sectionId`), 'section_morning', 'Drag core moves a credit into another credit section');
  eq(JSON.stringify([...window.document.querySelectorAll('[data-section-id="section_morning"] .row-name')].map(node => node.textContent)), JSON.stringify(['Zulu','Mike']), 'Cross-section move preserves the requested insertion position');
  eq(window.moveTaskToPosition('good', 'sort_a', 'section_bonus', null), false, 'Credit cannot move into a bonus section');
  window.moveTaskByKeyboard('good', 'sort_m', 'ArrowRight');
  eq(window.eval(`habits.find(item => item.id === 'sort_m').sectionId`), 'section_evening', 'Keyboard handle can move a task to the next same-type section');
  eq(window.moveTaskByKeyboard('good', 'sort_m', 'Home'), false, 'Keyboard Home is a no-op when a task is already first');
  eq(window.moveTaskByKeyboard('good', 'sort_m', 'End'), false, 'Keyboard End is a no-op when a task is already last');
  const alphaHandle = window.document.querySelector('[data-drag-handle][data-id="sort_a"]');
  const morningDropZone = window.document.querySelector('[data-task-drop-zone][data-section-id="section_morning"]');
  const originalElementFromPoint = window.document.elementFromPoint;
  window.document.elementFromPoint = () => morningDropZone;
  window.beginTaskDrag({ pointerId:42, clientX:10, clientY:10, preventDefault() {} }, alphaHandle);
  window.updateTaskDrag({ pointerId:42, clientX:30, clientY:200, preventDefault() {} });
  window.finishTaskDrag({ pointerId:42 });
  window.document.elementFromPoint = originalElementFromPoint;
  eq(window.eval(`habits.find(item => item.id === 'sort_a').sectionId`), 'section_morning', 'Pointer drag lifecycle moves a task into the drop-target section');
  eq(window.document.querySelectorAll('.task-drag-ghost').length, 0, 'Pointer drag cleans up its floating preview');
  window.setTaskSortMode('good', 'name-asc');
  eq(JSON.stringify([...window.document.querySelectorAll('[data-section-id="section_morning"] .row-name')].map(node => node.textContent)), JSON.stringify(['Alpha','Zulu']), 'Automatic sorting applies within each custom section');
  eq(window.eval(`habits.find(item => item.id === 'sort_a').sectionId`), 'section_morning', 'Automatic sorting does not change section membership');
  window.setTaskSortMode('good', 'manual');
  window.openHabitModal('good', 'sort_a');
  ok([...window.document.getElementById('habitSectionInput').options].some(option => option.value === 'section_morning'), 'Edit modal offers section assignment as a fallback');
  window.closeHabitModal();

  window.openTaskSectionModal('bad');
  window.document.getElementById('taskSectionName').value = 'Temporary';
  window.saveTaskSection();
  const temporarySectionId = window.eval(`taskSections.find(section => section.name === 'Temporary').id`);
  window.eval(`
    habits.push({id:'temporary_debit',name:'Temporary debit',type:'bad',points:2,streak:0,lastDate:null,order:0,sectionId:'${temporarySectionId}'});
    renderAll();
  `);
  window.openTaskSectionModal('bad', temporarySectionId);
  const deleteTemporarySection = window.deleteTaskSectionConfirm();
  window.resolveConfirm(true);
  await deleteTemporarySection;
  eq(window.eval(`taskSections.some(section => section.id === '${temporarySectionId}')`), false, 'Custom section can be deleted');
  eq(window.eval(`habits.find(item => item.id === 'temporary_debit').sectionId`), null, 'Deleting a section moves its tasks to Unsectioned');
  window.eval(`habits = habits.filter(item => item.id !== 'temporary_debit'); renderAll();`);

  window.setTaskSortMode('bonus', 'points-asc');
  eq(window.document.querySelector('#bonusList .row-name').textContent, '✦ Alpha bonus', 'Point-value sorting works for bonus entries');
  const sortedJsonBackup = window.validateBackupObject(JSON.parse(JSON.stringify(window.buildExport())));
  eq(sortedJsonBackup.taskSortModes.bonus, 'points-asc', 'JSON backup preserves selected task sort modes');
  eq(sortedJsonBackup.taskSections.length, 3, 'JSON backup preserves custom task sections');
  eq(sortedJsonBackup.habits.find(item => item.id === 'sort_z').order, 0, 'JSON backup preserves manual task order within its section');
  const sortedCsvBackup = window.parseFullCsvBackup(window.buildFullCsvBackup().text);
  eq(sortedCsvBackup.taskSortModes.bonus, 'points-asc', 'Complete CSV preserves selected task sort modes');
  eq(sortedCsvBackup.taskSections.length, 3, 'Complete CSV preserves custom task sections');
  eq(sortedCsvBackup.habits.find(item => item.id === 'sort_z').sectionId, 'section_morning', 'Complete CSV preserves task section assignment');
  eq(sortedCsvBackup.habits.find(item => item.id === 'sort_z').order, 0, 'Complete CSV preserves manual task order within its section');
  const legacyV4JsonBackup = JSON.parse(JSON.stringify(window.buildExport()));
  legacyV4JsonBackup.schemaVersion = 4;
  delete legacyV4JsonBackup.data.taskSections;
  legacyV4JsonBackup.data.habits.forEach(item => delete item.sectionId);
  legacyV4JsonBackup.data.bonusTasks.forEach(item => delete item.sectionId);
  const migratedLegacyV4Json = window.validateBackupObject(legacyV4JsonBackup);
  eq(migratedLegacyV4Json.taskSections.length, 0, 'Version-4 JSON migrates without inventing sections');
  eq(migratedLegacyV4Json.habits.every(item => item.sectionId === null), true, 'Version-4 JSON tasks migrate to Unsectioned');
  const legacyJsonBackup = JSON.parse(JSON.stringify(legacyV4JsonBackup));
  legacyJsonBackup.schemaVersion = 3;
  delete legacyJsonBackup.settings.taskSortModes;
  legacyJsonBackup.data.habits.forEach(item => delete item.order);
  legacyJsonBackup.data.bonusTasks.forEach(item => delete item.order);
  const migratedLegacyJson = window.validateBackupObject(legacyJsonBackup);
  eq(migratedLegacyJson.taskSortModes.good, 'manual', 'Version-3 JSON migrates to manual sorting');
  eq(migratedLegacyJson.habits.find(item => item.id === 'sort_z').order, 0, 'Version-3 JSON migrates visible array order');

  window.eval(`todayViewDate = '${d2}'; taskSortModes.good = 'manual'; renderAll();`);
  window.logHabit('sort_a');
  window.logBonus('bonus_a');
  eq(window.eval(`entries.filter(entry => entry.date === '${d2}' && entry.habitId === 'sort_a').length`), 2, 'Front-page credit tap targets selected historical day');
  eq(window.eval(`entries.filter(entry => entry.date === '${d2}' && entry.bonusId === 'bonus_a').length`), 1, 'Front-page bonus tap targets selected historical day');
  eq(window.document.getElementById('todayDateCaption').textContent, 'Yesterday', 'Front-page navigator labels yesterday clearly');
  ok(window.document.getElementById('statusEl').textContent.includes('on this day'), 'Header score identifies a historical ledger day');
  ok(window.document.getElementById('goodList').textContent.includes('2× this day'), 'Task count follows selected historical day');
  window.returnToToday();
  eq(window.document.getElementById('todayDateInput').value, today, 'Today shortcut returns front page to current ledger day');

  setLedger({
    start: d1,
    entries: [
      { id: 'entry_a', date: d1, name: 'Credit', type: 'good', points: 20, ts: 1 }
    ],
    completedDays: [
      { id: 'day_c', date: d3, ts: 3 }
    ]
  });

  let byDate = window.dailyTotalsByDate();
  let avg = window.averageScoreWindow(7, byDate);
  eq(avg.average, 110, '7-day average excludes unknown day and averages tracked scores');
  eq(avg.tracked, 2, '7-day average reports two tracked days');
  eq(avg.calendarDays, 3, '7-day average reports three calendar days of coverage');
  let stats = window.computeStats();
  eq(stats.daysTracked, 2, 'Stats count activity and explicit completion as tracked');
  eq(stats.successRate, 100, 'Success rate uses tracked days only');

  setLedger({
    start: d1,
    entries: [
      { id: 'entry_a', date: d1, name: 'Credit', type: 'good', points: 0, ts: 1 },
      { id: 'entry_c', date: d3, name: 'Credit', type: 'good', points: 0, ts: 3 }
    ],
    milestones: [
      { id: 'm_two', name: 'Two successes', days: 2, points: 25, description: '' }
    ]
  });
  const awardsAcrossGap = window.deriveMilestoneEntries();
  eq(awardsAcrossGap.length, 1, 'Approved rule: unknown day pauses milestone streak');
  stats = window.computeStats();
  eq(stats.currentStreak, 2, 'Approved rule: unknown day pauses current success streak');

  setLedger({
    start: d1,
    entries: [
      { id: 'entry_a', date: d1, name: 'Credit', type: 'good', points: 0, ts: 1 }
    ]
  });
  eq(window.computeStats().currentStreak, 1, 'A paused streak remains current through later unknown days');

  setLedger({
    start: d1,
    entries: [
      { id: 'entry_a', date: d1, name: 'Credit', type: 'good', points: 0, ts: 1 },
      { id: 'entry_b', date: d2, name: 'Debit', type: 'bad', points: -30, ts: 2 },
      { id: 'entry_c', date: d3, name: 'Credit', type: 'good', points: 0, ts: 3 }
    ],
    milestones: [
      { id: 'm_two', name: 'Two successes', days: 2, points: 25, description: '' }
    ]
  });
  eq(window.deriveMilestoneEntries().length, 0, 'Tracked unsuccessful day resets milestone progress');
  eq(window.computeStats().currentStreak, 1, 'Tracked unsuccessful day resets current success streak');

  setLedger({
    start: d1,
    entries: [
      { id: 'entry_a', date: d1, name: 'Credit', type: 'good', points: 0, ts: 1 },
      { id: 'entry_b', date: d2, name: 'Credit', type: 'good', points: 0, ts: 2 }
    ],
    milestones: [
      { id: 'm_two', name: 'Two successes', days: 2, points: 25, description: '' }
    ]
  });
  const awards = window.deriveMilestoneEntries();
  eq(awards.length, 1, 'Milestone awards once on exact successful-day threshold');
  eq(awards[0] && awards[0].date, d2, 'Milestone lands on the threshold day');
  byDate = window.dailyTotalsByDate();
  eq(byDate[d2], 25, 'Milestone reward is included in daily totals');
  eq(window.manualDailyTotalsByDate()[d2], 0, 'Milestone reward is excluded from success qualification');
  avg = window.averageScoreWindow(7, byDate);
  eq(avg.average, 112.5, 'Average includes an earned milestone reward');

  const trend = window.computeTrends();
  eq(trend.avgDailyNet, 12.5, 'Recent pace includes earned milestone rewards');
  eq(trend.projections.d30Net, 400, '30-day projected net total is arithmetically consistent');
  eq(trend.projections.d30, 112.5, '30-day projected average is arithmetically consistent');

  const exportObject = window.buildExport();
  const cleanJson = window.validateBackupObject(JSON.parse(JSON.stringify(exportObject)));
  eq(cleanJson.entries.length, 2, 'JSON backup round-trip preserves entries');
  eq(cleanJson.milestones.length, 1, 'JSON backup round-trip preserves milestones');
  eq(cleanJson.taskSortModes.good, 'manual', 'JSON backup round-trip preserves task sorting');
  const csv = window.buildFullCsvBackup().text;
  const cleanCsv = window.parseFullCsvBackup(csv);
  eq(cleanCsv.entries.length, 2, 'CSV backup round-trip preserves entries');
  eq(cleanCsv.milestones.length, 1, 'CSV backup round-trip preserves milestones');
  eq(cleanCsv.taskSortModes.good, 'manual', 'CSV backup round-trip preserves task sorting');

  window.eval(`backupReminderDays = 0`);
  const csvNoReminder = window.parseFullCsvBackup(window.buildFullCsvBackup().text);
  eq(csvNoReminder.backupReminderDays, 0, 'CSV backup preserves disabled reminder setting');
  window.eval(`backupReminderDays = 14`);
  const csvTwoWeeks = window.parseFullCsvBackup(window.buildFullCsvBackup().text);
  eq(csvTwoWeeks.backupReminderDays, 14, 'CSV backup preserves enabled reminder frequency');

  const legacyV4Rows = window.parseCsvRows(window.buildFullCsvBackup().text)
    .filter(row => row[1] !== 'task_section');
  const sectionColumn = legacyV4Rows[0].indexOf('section_id');
  legacyV4Rows.forEach(row => row.splice(sectionColumn, 1));
  legacyV4Rows[1][legacyV4Rows[0].indexOf('format_version')] = '4';
  const legacyV4Csv = legacyV4Rows
    .map(row => row.map(value => window.csvCell(value, false)).join(','))
    .join('\r\n') + '\r\n';
  eq(window.parseFullCsvBackup(legacyV4Csv).taskSections.length, 0, 'Legacy version-4 CSV migrates without custom sections');

  const legacyV3Rows = window.parseCsvRows(legacyV4Csv);
  ['manual_order','bonus_sort_mode','bad_sort_mode','good_sort_mode'].forEach(column => {
    const index = legacyV3Rows[0].indexOf(column);
    legacyV3Rows.forEach(row => row.splice(index, 1));
  });
  legacyV3Rows[1][legacyV3Rows[0].indexOf('format_version')] = '3';
  const legacyV3Csv = legacyV3Rows
    .map(row => row.map(value => window.csvCell(value, false)).join(','))
    .join('\r\n') + '\r\n';
  eq(window.parseFullCsvBackup(legacyV3Csv).backupReminderDays, 14, 'Legacy version-3 CSV preserves its reminder setting');
  eq(window.parseFullCsvBackup(legacyV3Csv).taskSortModes.good, 'manual', 'Legacy version-3 CSV defaults task sorting safely');

  const legacyV2Rows = window.parseCsvRows(legacyV3Csv);
  const reminderColumn = legacyV2Rows[0].indexOf('backup_reminder_days');
  legacyV2Rows.forEach(row => row.splice(reminderColumn, 1));
  legacyV2Rows[1][legacyV2Rows[0].indexOf('format_version')] = '2';
  const legacyCsv = legacyV2Rows
    .map(row => row.map(value => window.csvCell(value, false)).join(','))
    .join('\r\n') + '\r\n';
  eq(window.parseFullCsvBackup(legacyCsv).backupReminderDays, 0, 'Legacy version-2 CSV remains importable with reminders safely off');

  setLedger({
    start: d1,
    entries: [
      { id: 'entry_a', date: d1, name: 'Credit', type: 'good', points: 10, ts: 1 },
      { id: 'entry_c', date: d3, name: 'Credit', type: 'good', points: 30, ts: 3 }
    ]
  });
  window.eval(`historyRangeDays = 7; selectedHistoryDate = '${d3}'`);
  window.renderHistory();
  const pathData = window.document.querySelector('.chart-score-line').getAttribute('d');
  ok((pathData.match(/M/g) || []).length >= 2, 'History line breaks across unknown days', pathData);
  const gapPathData = window.document.querySelector('.chart-score-gap').getAttribute('d');
  ok(/^M.+ L/.test(gapPathData), 'History renders a dashed connector across unknown days', gapPathData);
  ok(window.document.querySelector('.legend-swatch.gap'), 'History explains dashed unknown gaps in its legend');

  let seed = 0x5eed1234;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  let randomizedRulesPass = true;
  for (let scenario = 0; scenario < 250 && randomizedRulesPass; scenario++) {
    const start = window.addDaysToKey(today, -29);
    const scenarioEntries = [];
    const referenceAwards = [];
    const definitions = [
      { id: 'm1', name: 'One', days: 1, points: 3, description: '' },
      { id: 'm3', name: 'Three', days: 3, points: 7, description: '' },
      { id: 'm5', name: 'Five', days: 5, points: 11, description: '' }
    ];
    let run = 0;
    let best = 0;
    let successes = 0;
    let tracked = 0;
    for (let offset = 0; offset < 30; offset++) {
      const date = window.addDaysToKey(start, offset);
      const draw = random();
      if (draw < 0.34) continue;
      tracked++;
      const success = draw < 0.78;
      scenarioEntries.push({
        id: `r_${scenario}_${offset}`,
        date,
        name: success ? 'Success' : 'Failure',
        type: success ? 'good' : 'bad',
        points: success ? 0 : -30,
        ts: scenario * 100 + offset
      });
      if (success) {
        successes++;
        run++;
        best = Math.max(best, run);
        definitions.filter(item => item.days === run)
          .forEach(item => referenceAwards.push(`${item.id}:${date}`));
      } else {
        run = 0;
      }
    }
    setLedger({ start, entries: scenarioEntries, milestones: definitions });
    const actualAwards = window.deriveMilestoneEntries().map(item => `${item.milestoneId}:${item.date}`);
    const actualStats = window.computeStats();
    const expectedRate = tracked ? Math.round(successes / tracked * 100) : null;
    randomizedRulesPass =
      JSON.stringify(actualAwards) === JSON.stringify(referenceAwards) &&
      (tracked === 0 || (
        actualStats.currentStreak === run &&
        actualStats.bestStreak === best &&
        actualStats.successRate === expectedRate
      ));
  }
  ok(randomizedRulesPass, '250 randomized histories match pause/reset milestone and streak rules');

  const expectedSavedEntries = window.eval('entries.length');
  await window.persistData();
  const saved = await window.idbGet('state');
  const cleanSaved = window.validateBackupObject(saved);
  eq(cleanSaved.entries.length, expectedSavedEntries, 'Durable IndexedDB write preserves ledger');

  function createRaceBrowser(factory, sharedCloud = null) {
    const errors = [];
    const consoleForBrowser = new VirtualConsole();
    consoleForBrowser.on('jsdomError', error => errors.push(String(error.message || error)));
    const browser = new JSDOM(html, {
      url: 'https://tally-race.local/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: consoleForBrowser,
      beforeParse(raceWindow) {
        installNetworkStubs(raceWindow, sharedCloud);
        raceWindow.indexedDB = factory;
        raceWindow.IDBKeyRange = IDBKeyRange;
        raceWindow.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        raceWindow.scrollTo = () => {};
        Object.defineProperty(raceWindow.navigator, 'storage', {
          configurable: true,
          value: {
            persisted: async () => true,
            persist: async () => true,
            estimate: async () => ({ usage: 4096, quota: 1024 * 1024 })
          }
        });
      }
    });
    return { browser, errors };
  }

  const raceFactory = new IDBFactory();
  const raceA = createRaceBrowser(raceFactory);
  const raceB = createRaceBrowser(raceFactory);
  await Promise.all([
    waitFor(() => raceA.browser.window.document.getElementById('loadingScreen').style.display === 'none'),
    waitFor(() => raceB.browser.window.document.getElementById('loadingScreen').style.display === 'none')
  ]);
  const raceDate = raceA.browser.window.todayKey();
  await Promise.all([
    raceA.browser.window.eval(`entries.push({id:'race_a',date:'${raceDate}',name:'A',type:'good',points:1,ts:1});persistData()`),
    raceB.browser.window.eval(`entries.push({id:'race_b',date:'${raceDate}',name:'B',type:'good',points:2,ts:2});persistData()`)
  ]);
  await new Promise(resolve => setTimeout(resolve, 30));
  const raceSnapshot = await raceA.browser.window.idbGet('state');
  const raceClean = raceA.browser.window.validateBackupObject(raceSnapshot);
  eq(raceClean.entries.length, 2, 'Simultaneous open copies merge independent entries');
  ok(!raceA.errors.length && !raceB.errors.length, 'Concurrent browser copies avoid runtime errors', [...raceA.errors, ...raceB.errors].join(' | '));
  raceA.browser.window.close();
  raceB.browser.window.close();

  const sharedCloud = { revision: 0, snapshot: null, updatedAt: null };
  const cloudA = createRaceBrowser(new IDBFactory(), sharedCloud);
  const cloudB = createRaceBrowser(new IDBFactory(), sharedCloud);
  await Promise.all([
    waitFor(() => cloudA.browser.window.document.getElementById('loadingScreen').style.display === 'none'),
    waitFor(() => cloudB.browser.window.document.getElementById('loadingScreen').style.display === 'none')
  ]);
  const cloudDate = cloudA.browser.window.todayKey();
  await Promise.all([
    cloudA.browser.window.eval(`
      entries.push({id:'cloud_a',date:'${cloudDate}',name:'Cloud A',type:'good',points:1,ts:11});
      taskSections.push({id:'cloud_good_section',name:'Cloud group',kind:'good',order:0});
      habits.push({id:'cloud_habit',name:'Cloud habit',type:'good',points:4,streak:0,lastDate:null,order:7,sectionId:'cloud_good_section'});
      taskSortModes.good = 'name-desc';
      persistData()
    `),
    cloudB.browser.window.eval(`
      entries.push({id:'cloud_b',date:'${cloudDate}',name:'Cloud B',type:'good',points:2,ts:12});
      taskSections.push({id:'cloud_bonus_section',name:'Cloud specials',kind:'bonus',order:0});
      bonusTasks.push({id:'cloud_bonus',name:'Cloud bonus',points:5,order:3,sectionId:'cloud_bonus_section'});
      taskSortModes.bonus = 'points-asc';
      persistData()
    `)
  ]);
  await Promise.all([
    cloudA.browser.window.syncCloudNow(),
    cloudB.browser.window.syncCloudNow()
  ]);
  await new Promise(resolve => setTimeout(resolve, 50));

  const cloudReader = createRaceBrowser(new IDBFactory(), sharedCloud);
  await waitFor(() => cloudReader.browser.window.document.getElementById('loadingScreen').style.display === 'none');
  const cloudIds = cloudReader.browser.window.eval('entries.map(entry => entry.id).sort()');
  eq(JSON.stringify(cloudIds), JSON.stringify(['cloud_a', 'cloud_b']), 'Two separate devices merge independent cloud writes without lost data');
  eq(cloudReader.browser.window.eval(`habits.find(item => item.id === 'cloud_habit').order`), 7, 'Cloud merge preserves explicit manual habit order');
  eq(cloudReader.browser.window.eval(`habits.find(item => item.id === 'cloud_habit').sectionId`), 'cloud_good_section', 'Cloud merge preserves credit section membership');
  eq(cloudReader.browser.window.eval(`bonusTasks.find(item => item.id === 'cloud_bonus').order`), 3, 'Cloud merge preserves explicit manual bonus order');
  eq(cloudReader.browser.window.eval(`taskSections.length`), 2, 'Cloud merge preserves independent custom sections from two devices');
  eq(cloudReader.browser.window.eval(`taskSortModes.good`), 'name-desc', 'Cloud merge preserves credit sort preference');
  eq(cloudReader.browser.window.eval(`taskSortModes.bonus`), 'points-asc', 'Cloud merge preserves independent bonus sort preference');
  ok(sharedCloud.revision >= 3, 'Cloud revision advances monotonically through a write conflict');
  cloudA.browser.window.close();
  cloudB.browser.window.close();
  cloudReader.browser.window.close();

  console.log(JSON.stringify({
    passed: results.length - failures.length,
    total: results.length,
    failures,
    browserErrors
  }, null, 2));
  window.close();
  process.exit(failures.length ? 1 : 0);
})().catch(error => {
  console.error(error);
  window.close();
  process.exit(2);
});

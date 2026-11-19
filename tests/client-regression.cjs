const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { indexedDB, IDBKeyRange, IDBFactory } = require('fake-indexeddb');

const publicDir = path.join(__dirname, '..', 'public');
const shellHtml = fs.readFileSync(path.join(publicDir, 'tally.html'), 'utf8');
const html = shellHtml
  .replace('<link rel="stylesheet" href="/tally.css">', `<style>${fs.readFileSync(path.join(publicDir, 'tally.css'), 'utf8')}</style>`)
  .replace(/<script src="\/tally-v\d+\.js" defer><\/script>/, () => `<script>${fs.readFileSync(path.join(publicDir, 'tally.js'), 'utf8')}</script>`);
const browserErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => browserErrors.push(String(error.message || error)));
virtualConsole.on('error', error => browserErrors.push(String(error)));

function installNetworkStubs(window, sharedCloud = null) {
  window.TextEncoder = TextEncoder;
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
    window.scrollBy = () => {};
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

function setLedger({ start, entries = [], completedDays = [], milestones = [], dailyBonuses = [], base = 100, threshold = 80 }) {
  const payload = JSON.stringify({ start, entries, completedDays, milestones, dailyBonuses, base, threshold });
  window.eval(`
    {
      const payload = ${payload};
      trackingStartDate = payload.start;
      dailyBase = payload.base;
      successThreshold = payload.threshold;
      entries = payload.entries;
      completedDays = payload.completedDays;
      milestones = payload.milestones;
      dailyBonuses = payload.dailyBonuses;
      taskSections = [];
      habits = [];
      bonusTasks = [];
      taskSortModes = { habit:'manual', bonus:'manual' };
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
  eq(window.document.querySelectorAll('#dailyBonusList').length, 1, 'Automatic daily bonus editor appears once on Today');
  ok(window.document.getElementById('todayView').contains(window.document.getElementById('dailyBonusList')), 'Automatic daily bonus editor is on Today');

  const today = window.todayKey();
  const d1 = window.addDaysToKey(today, -2);
  const d2 = window.addDaysToKey(today, -1);
  const d3 = today;

  const startupDateState = window.eval(`{
    const savedHour = dayStartHour;
    const savedStart = trackingStartDate;
    const savedView = todayViewDate;
    dayStartHour = 4;
    trackingStartDate = addDaysToKey(todayKey(), -30);
    todayViewDate = null;
    const expected = todayKey();
    const actual = activeLedgerDate();
    dayStartHour = savedHour;
    trackingStartDate = savedStart;
    todayViewDate = savedView;
    ({ expected, actual });
  }`);
  eq(startupDateState.actual, startupDateState.expected, 'Today opens on the current configured ledger day instead of the tracking start date');

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
  ok(window.document.getElementById('habitList').textContent.includes('🔥 21-day streak'), 'Informational habit streak remains visible');
  ok(!/·\s*×\d+\.\d+/.test(window.document.getElementById('habitList').textContent), 'Multiplier label is absent from the habit UI');
  eq(window.document.querySelector('#habitList .pill').textContent, '+10', 'Credit pill shows configured points');

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
    taskSortModes = { habit:'manual', bonus:'manual' };
    renderAll();
  `);
  const visibleHabitNames = () => [...window.document.querySelectorAll('#habitList .row-name')].map(node => node.textContent);
  eq(JSON.stringify(visibleHabitNames()), JSON.stringify(['Zulu','Alpha','Mike']), 'Manual sorting preserves explicit task order');
  window.setTaskSortMode('habit', 'name-asc');
  eq(JSON.stringify(visibleHabitNames()), JSON.stringify(['Alpha','Mike','Zulu']), 'A-to-Z task sorting works');
  window.setTaskSortMode('habit', 'usage-desc');
  eq(JSON.stringify(visibleHabitNames()), JSON.stringify(['Mike','Alpha','Zulu']), 'Most-used task sorting uses linked history');
  window.setTaskSortMode('habit', 'manual');
  window.moveTaskToPosition('habit', 'sort_z', null, 'sort_m');
  eq(JSON.stringify(visibleHabitNames()), JSON.stringify(['Alpha','Zulu','Mike']), 'Manual move changes and rerenders stored task order');
  eq(window.document.querySelectorAll('#habitList .drag-handle').length, 3, 'Every habit has one six-dot drag handle');
  eq(window.document.querySelectorAll('#habitList .drag-handle circle').length, 18, 'Drag handles render the requested six-dot grip');
  eq(window.document.querySelectorAll('#habitList .order-btn').length, 0, 'Old visible arrow controls are removed');
  ok(window.document.querySelector('#habitList [data-task-row]').lastElementChild.classList.contains('drag-handle'), 'Drag handle is the rightmost row control');
  window.setTaskSortMode('habit', 'name-asc');
  window.beginTaskDrag({ preventDefault() {}, pointerId:1 }, window.document.querySelector('#habitList .drag-handle'));
  eq(window.eval(`taskSortModes.habit`), 'manual', 'Touching a handle in automatic mode switches the list to Manual');

  window.eval(`
    taskSections = [
      { id:'section_morning', name:'Morning', kind:'habit', order:0 },
      { id:'section_evening', name:'Evening', kind:'habit', order:1 },
      { id:'section_bonus', name:'Special', kind:'bonus', order:0 }
    ];
    habits.find(item => item.id === 'sort_m').sectionId = 'section_morning';
    habits.find(item => item.id === 'sort_m').order = 0;
    habits.push({ id:'topic_debit', name:'Late scrolling', type:'bad', points:5, streak:0, lastDate:null, order:0, sectionId:'section_evening' });
    renderAll();
  `);
  ok(Boolean(window.document.querySelector('#habitList [data-task-group][data-section-id=""]')), 'Unsorted appears while it contains habits');
  eq(window.document.querySelectorAll('#habitList [data-section-drag-handle]').length, 2, 'Custom topics have drag handles');
  eq(window.document.querySelectorAll('#habitList [data-section-drag-handle] circle').length, 12, 'Topic drag handles use the six-dot grip');
  window.moveTaskToPosition('habit', 'sort_z', 'section_morning', 'sort_m');
  eq(window.eval(`habits.find(item => item.id === 'sort_z').sectionId`), 'section_morning', 'Drag core moves a credit into another credit section');
  eq(JSON.stringify([...window.document.querySelectorAll('[data-section-id="section_morning"] .row-name')].map(node => node.textContent)), JSON.stringify(['Zulu','Mike']), 'Cross-section move preserves the requested insertion position');
  eq(window.moveTaskToPosition('habit', 'sort_a', 'section_bonus', null), false, 'Habit cannot move into a bonus section');
  window.moveTaskByKeyboard('habit', 'sort_m', 'ArrowRight');
  eq(window.eval(`habits.find(item => item.id === 'sort_m').sectionId`), 'section_evening', 'Keyboard handle can move a task to the next topic');
  eq(window.eval(`habits.filter(item => item.sectionId === 'section_evening').map(item => item.type).sort().join(',')`), 'bad,good', 'One topic can contain both credits and debits');
  eq(window.moveTaskByKeyboard('habit', 'sort_m', 'Home'), true, 'Keyboard Home moves a credit ahead of a debit in the same topic');
  eq(window.eval(`manualTaskItems('habit', 'section_evening')[0].id`), 'sort_m', 'Keyboard Home places the habit first');
  eq(window.moveTaskByKeyboard('habit', 'sort_m', 'End'), true, 'Keyboard End moves a credit after a debit in the same topic');
  eq(window.eval(`manualTaskItems('habit', 'section_evening').at(-1).id`), 'sort_m', 'Keyboard End places the habit last');
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
  eq(window.document.querySelector('#habitList [data-task-group][data-section-id=""]'), null, 'Empty Unsorted group disappears');
  window.moveTaskToPosition('habit', 'sort_a', null, null);
  ok(Boolean(window.document.querySelector('#habitList [data-task-group][data-section-id=""]')), 'Unsorted reappears when a habit is moved into it');
  window.moveTaskToPosition('habit', 'sort_a', 'section_morning', null);

  const eveningSectionHandle = window.document.querySelector('[data-section-drag-handle][data-id="section_evening"]');
  const morningSectionGroup = window.document.querySelector('[data-task-group][data-section-id="section_morning"]');
  window.document.elementFromPoint = () => morningSectionGroup;
  window.beginTaskSectionDrag({ pointerId:43, clientX:10, clientY:10, preventDefault() {} }, eveningSectionHandle);
  window.updateTaskSectionDrag({ pointerId:43, clientX:10, clientY:-10, preventDefault() {} });
  window.finishTaskSectionDrag({ pointerId:43 });
  window.document.elementFromPoint = originalElementFromPoint;
  const visibleTopics = () => [...window.document.querySelectorAll('#habitList [data-task-group][data-custom-section="true"] .task-group-name')].map(node => node.textContent);
  eq(JSON.stringify(visibleTopics()), JSON.stringify(['Evening','Morning']), 'Pointer drag reorders custom topics');
  window.moveTaskSectionByKeyboard('habit', 'section_morning', 'Home');
  eq(JSON.stringify(visibleTopics()), JSON.stringify(['Morning','Evening']), 'Keyboard topic handle reorders custom topics');
  eq(window.document.querySelectorAll('.task-drag-ghost').length, 0, 'Section pointer drag cleans up its floating preview');

  window.setTaskSortMode('habit', 'name-asc');
  eq(JSON.stringify([...window.document.querySelectorAll('[data-section-id="section_morning"] .row-name')].map(node => node.textContent)), JSON.stringify(['Alpha','Zulu']), 'Automatic sorting applies within each custom section');
  eq(window.eval(`habits.find(item => item.id === 'sort_a').sectionId`), 'section_morning', 'Automatic sorting does not change section membership');
  window.setTaskSortMode('habit', 'manual');
  window.openHabitModal('good', 'sort_a');
  ok([...window.document.getElementById('habitSectionInput').options].some(option => option.value === 'section_morning'), 'Edit modal offers section assignment as a fallback');
  window.closeHabitModal();

  window.openTaskSectionModal('habit');
  window.document.getElementById('taskSectionName').value = 'Temporary';
  window.saveTaskSection();
  const temporarySectionId = window.eval(`taskSections.find(section => section.name === 'Temporary').id`);
  window.eval(`
    habits.push({id:'temporary_debit',name:'Temporary debit',type:'bad',points:2,streak:0,lastDate:null,order:0,sectionId:'${temporarySectionId}'});
    renderAll();
  `);
  window.openTaskSectionModal('habit', temporarySectionId);
  const deleteTemporarySection = window.deleteTaskSectionConfirm();
  window.resolveConfirm(true);
  await deleteTemporarySection;
  eq(window.eval(`taskSections.some(section => section.id === '${temporarySectionId}')`), false, 'Custom section can be deleted');
  eq(window.eval(`habits.find(item => item.id === 'temporary_debit').sectionId`), null, 'Deleting a topic moves its habits to Unsorted');
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

  const legacyV5JsonBackup = JSON.parse(JSON.stringify(window.buildExport()));
  legacyV5JsonBackup.schemaVersion = 5;
  legacyV5JsonBackup.data.taskSections = [
    { id:'legacy_good_morning', name:'Morning', kind:'good', order:0 },
    { id:'legacy_bad_morning', name:'Morning', kind:'bad', order:0 },
    { id:'legacy_bad_focus', name:'Focus', kind:'bad', order:1 },
    { id:'legacy_bonus_special', name:'Special', kind:'bonus', order:0 }
  ];
  legacyV5JsonBackup.data.habits.find(item => item.id === 'sort_z').sectionId = 'legacy_good_morning';
  legacyV5JsonBackup.data.habits.find(item => item.id === 'sort_a').sectionId = 'legacy_good_morning';
  legacyV5JsonBackup.data.habits.find(item => item.id === 'sort_m').sectionId = 'legacy_good_morning';
  legacyV5JsonBackup.data.habits.find(item => item.id === 'topic_debit').sectionId = 'legacy_bad_morning';
  legacyV5JsonBackup.data.habits.push({
    id:'legacy_focus_debit', name:'Distracted browsing', type:'bad', points:4,
    streak:0, lastDate:null, order:0, sectionId:'legacy_bad_focus'
  });
  legacyV5JsonBackup.data.bonusTasks[0].sectionId = 'legacy_bonus_special';
  legacyV5JsonBackup.settings.taskSortModes = {
    good:'manual', bad:'usage-desc', bonus:'points-asc'
  };
  const migratedLegacyV5Json = window.validateBackupObject(legacyV5JsonBackup);
  eq(migratedLegacyV5Json.habits.length, legacyV5JsonBackup.data.habits.length, 'Version-5 topic migration preserves every habit');
  eq(migratedLegacyV5Json.taskSections.filter(item => item.kind === 'habit' && item.name === 'Morning').length, 1, 'Same-named Credit and Debit sections merge into one topic');
  eq(
    migratedLegacyV5Json.habits.find(item => item.id === 'sort_z').sectionId,
    migratedLegacyV5Json.habits.find(item => item.id === 'topic_debit').sectionId,
    'Merged topic preserves both former Credit and Debit assignments'
  );
  eq(
    migratedLegacyV5Json.taskSections.find(item => item.id === migratedLegacyV5Json.habits.find(habit => habit.id === 'legacy_focus_debit').sectionId).name,
    'Focus',
    'Debit-only sections become topics with their assignments intact'
  );
  eq(migratedLegacyV5Json.taskSections.find(item => item.id === 'legacy_bonus_special').kind, 'bonus', 'Bonus sections remain separate during migration');
  eq(migratedLegacyV5Json.bonusTasks[0].sectionId, 'legacy_bonus_special', 'Bonus section assignments remain intact');
  eq(migratedLegacyV5Json.taskSortModes.habit, 'manual', 'Conflicting legacy Credit and Debit sort modes migrate safely to Manual');

  const legacyV4JsonBackup = JSON.parse(JSON.stringify(legacyV5JsonBackup));
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
  eq(migratedLegacyJson.taskSortModes.habit, 'manual', 'Version-3 JSON migrates to manual habit sorting');
  eq(migratedLegacyJson.habits.find(item => item.id === 'sort_z').order, 0, 'Version-3 JSON migrates visible array order');

  window.eval(`todayViewDate = '${d2}'; taskSortModes.habit = 'manual'; renderAll();`);
  window.logHabit('sort_a');
  window.logBonus('bonus_a');
  eq(window.eval(`entries.filter(entry => entry.date === '${d2}' && entry.habitId === 'sort_a').length`), 2, 'Front-page credit tap targets selected historical day');
  eq(window.eval(`entries.filter(entry => entry.date === '${d2}' && entry.bonusId === 'bonus_a').length`), 1, 'Front-page bonus tap targets selected historical day');
  eq(window.document.getElementById('todayDateCaption').textContent, 'Yesterday', 'Front-page navigator labels yesterday clearly');
  ok(window.document.getElementById('statusEl').textContent.includes('on this day'), 'Header score identifies a historical ledger day');
  ok(window.document.getElementById('habitList').textContent.includes('2× this day'), 'Task count follows selected historical day');
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
  eq(awardsAcrossGap.length, 0, 'Current day milestone waits until the next day starts');
  window.eval(`entries.find(entry => entry.id === 'entry_a').date = addDaysToKey('${d1}', -1); entries.find(entry => entry.id === 'entry_c').date = '${d2}'; trackingStartDate = addDaysToKey('${d1}', -1)`);
  eq(window.deriveMilestoneEntries().length, 1, 'Approved rule: unknown day pauses milestone streak across finished days');
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
  eq(cleanJson.taskSortModes.habit, 'manual', 'JSON backup round-trip preserves habit sorting');
  const csv = window.buildFullCsvBackup().text;
  const cleanCsv = window.parseFullCsvBackup(csv);
  eq(cleanCsv.entries.length, 2, 'CSV backup round-trip preserves entries');
  eq(cleanCsv.milestones.length, 1, 'CSV backup round-trip preserves milestones');
  eq(cleanCsv.taskSortModes.habit, 'manual', 'CSV backup round-trip preserves habit sorting');

  window.eval(`backupReminderDays = 0`);
  const csvNoReminder = window.parseFullCsvBackup(window.buildFullCsvBackup().text);
  eq(csvNoReminder.backupReminderDays, 0, 'CSV backup preserves disabled reminder setting');
  window.eval(`backupReminderDays = 14`);
  const csvTwoWeeks = window.parseFullCsvBackup(window.buildFullCsvBackup().text);
  eq(csvTwoWeeks.backupReminderDays, 14, 'CSV backup preserves enabled reminder frequency');

  const legacyV5Rows = window.parseCsvRows(window.buildFullCsvBackup().text);
  const habitSortColumn = legacyV5Rows[0].indexOf('habit_sort_mode');
  legacyV5Rows.forEach(row => row.splice(habitSortColumn, 1));
  legacyV5Rows[1][legacyV5Rows[0].indexOf('format_version')] = '5';
  const legacyV5Csv = legacyV5Rows
    .map(row => row.map(value => window.csvCell(value, false)).join(','))
    .join('\r\n') + '\r\n';
  eq(window.parseFullCsvBackup(legacyV5Csv).taskSortModes.habit, 'manual', 'Legacy version-5 CSV migrates Credit and Debit sorting safely');

  const legacyV4Rows = window.parseCsvRows(legacyV5Csv)
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
  eq(window.parseFullCsvBackup(legacyV3Csv).taskSortModes.habit, 'manual', 'Legacy version-3 CSV defaults habit sorting safely');

  const legacyV2Rows = window.parseCsvRows(legacyV3Csv);
  const reminderColumn = legacyV2Rows[0].indexOf('backup_reminder_days');
  legacyV2Rows.forEach(row => row.splice(reminderColumn, 1));
  legacyV2Rows[1][legacyV2Rows[0].indexOf('format_version')] = '2';
  const legacyCsv = legacyV2Rows
    .map(row => row.map(value => window.csvCell(value, false)).join(','))
    .join('\r\n') + '\r\n';
  eq(window.parseFullCsvBackup(legacyCsv).backupReminderDays, 0, 'Legacy version-2 CSV remains importable with reminders safely off');
  const legacyV1Rows = legacyV2Rows
    .filter(row => !['milestone', 'completed_day'].includes(row[1]))
    .map(row => row.slice(0, window.eval('FULL_CSV_V1_HEADERS.length')));
  legacyV1Rows.find(row => row[1] === 'meta')[0] = '1';
  const legacyV1Csv = legacyV1Rows.map(row => row.map(value => window.csvCell(value, false)).join(',')).join('\r\n');
  eq(window.parseFullCsvBackup(legacyV1Csv).entries.length, cleanCsv.entries.length, 'Version-1 CSV restores its historical entries');

  const jsonInput = window.document.getElementById('restoreFileInput');
  const restoreText = window.document.getElementById('restoreText');
  let finishOldRead;
  Object.defineProperty(jsonInput, 'files', { configurable:true, value:[{
    size:10, text:() => new Promise(resolve => { finishOldRead = resolve; })
  }] });
  jsonInput.dispatchEvent(new window.Event('change'));
  restoreText.value = JSON.stringify(window.buildExport());
  Object.defineProperty(jsonInput, 'files', { configurable:true, value:[{ size:11 * 1024 * 1024 }] });
  jsonInput.dispatchEvent(new window.Event('change'));
  finishOldRead(JSON.stringify(window.buildExport()));
  await Promise.resolve();
  eq(restoreText.value, '', 'Rejecting a JSON file clears the previous backup and ignores an earlier slow read');
  delete jsonInput.files;

  const oversizedBackup = window.buildSnapshot();
  oversizedBackup.data.bonusTasks = Array.from({length:1001}, (_, order) => ({
    id:`large_${order}`, name:'Bonus', points:1, order, sectionId:null
  }));
  let collectionError;
  try { window.validateBackupObject(oversizedBackup); }
  catch(error){ collectionError = error.code; }
  eq(collectionError, 'SYNC_COLLECTION_LIMIT', 'An import cannot create a collection larger than the server allows');
  eq(window.parseStoredSnapshot(oversizedBackup).clean.bonusTasks.length, 1001,
    'Existing larger local ledgers stay readable for recovery and export');

  setLedger({ start: window.addDaysToKey(today, -4) });
  window.renderAll();
  window.document.querySelector('[data-action="open-daily-bonus"]').click();
  window.document.getElementById('dailyBonusName').value = 'No debits';
  window.document.getElementById('dailyBonusPoints').value = '0';
  window.document.querySelector('[data-action="save-daily-bonus"]').click();
  ok(window.document.getElementById('dailyBonusError').textContent.includes('whole number'), 'Daily bonus editor rejects invalid reward points');
  window.document.getElementById('dailyBonusPoints').value = '80';
  window.document.getElementById('dailyBonusDescription').value = 'A day without debits';
  window.document.querySelector('[data-action="save-daily-bonus"]').click();
  eq(window.eval('dailyBonuses.length'), 1, 'Daily bonus rule can be created through the UI');
  let dailyAwards = window.deriveDailyBonusEntries();
  eq(dailyAwards.length, 4, 'Daily bonus catches up every elapsed day including completely empty days');
  ok(dailyAwards.every(entry => entry.date < today), 'Daily bonus excludes the unfinished current day');
  eq(window.deriveDailyBonusEntries(d1).length, 3, 'Daily bonus respects the requested historical end date');
  eq(window.computeStats().daysTracked, 4, 'Automatic rewards make empty days visible in statistics');
  eq(window.dailyTotalsByDate()[d2], 80, 'Daily bonus is included in daily score totals');
  eq(window.manualDailyTotalsByDate()[d2], undefined, 'Daily bonus stays separate from manual source activity');
  const stableDailyIds = dailyAwards.map(entry => entry.id).join(',');
  window.renderAll();
  eq(window.deriveDailyBonusEntries().map(entry => entry.id).join(','), stableDailyIds, 'Repeated checks keep stable award IDs without duplicates');
  eq(window.eval('entries.length'), 0, 'Derived daily awards are never saved as manual entries');
  window.openDayActivity(d2);
  ok(window.document.getElementById('dayActivityList').textContent.includes('Automatic daily bonus'), 'Historical activity labels automatic daily bonuses');
  eq(window.document.querySelectorAll('#dayActivityList [data-action="delete-history-entry"]').length, 0, 'Derived daily rewards cannot be individually deleted');
  window.closeDayActivity();

  const dailyBackup = window.buildExport();
  const restoredDailyJson = window.validateBackupObject(JSON.parse(JSON.stringify(dailyBackup)));
  const restoredDailyCsv = window.parseFullCsvBackup(window.buildFullCsvBackup().text);
  eq(restoredDailyJson.dailyBonuses[0].points, 80, 'JSON backup preserves daily reward points');
  eq(restoredDailyCsv.dailyBonuses[0].description, 'A day without debits', 'Complete CSV preserves automatic daily bonus rules');
  const activityCsv = window.buildActivityCsv();
  ok(activityCsv.includes('automatic_daily_bonus') && activityCsv.includes('daily_bonus_id'), 'Activity CSV identifies daily bonus awards and their source rule');
  const legacyV6Json = JSON.parse(JSON.stringify(dailyBackup));
  legacyV6Json.schemaVersion = 6;
  delete legacyV6Json.data.dailyBonuses;
  eq(window.validateBackupObject(legacyV6Json).dailyBonuses.length, 0, 'Legacy version-6 JSON imports without inventing automatic rules');
  const legacyV6CsvRows = window.parseCsvRows(window.buildFullCsvBackup().text).filter(row => row[1] !== 'daily_bonus');
  legacyV6CsvRows[1][0] = '6';
  const legacyV6Csv = legacyV6CsvRows.map(row => row.map(value => window.csvCell(value, false)).join(',')).join('\r\n');
  eq(window.parseFullCsvBackup(legacyV6Csv).dailyBonuses.length, 0, 'Legacy version-6 CSV remains importable');
  window.applyValidatedState(restoredDailyCsv);
  eq(window.deriveDailyBonusEntries().map(entry => entry.id).join(','), stableDailyIds, 'Restoring daily rules regenerates the same awards once each');

  window.eval(`habits = [{id:'daily_debit',name:'Debit',type:'bad',points:5,streak:0,lastDate:null,order:0,sectionId:null}]; todayViewDate = '${d2}'`);
  window.logHabit('daily_debit');
  eq(window.deriveDailyBonusEntries().filter(entry => entry.date === d2).length, 0, 'Backdated debit immediately removes that day’s automatic reward');
  window.logHabit('daily_debit');
  let debitIds = window.eval('entries.map(entry => entry.id)');
  window.deleteEntry(debitIds[0], false);
  eq(window.deriveDailyBonusEntries().filter(entry => entry.date === d2).length, 0, 'Deleting only one of multiple debits keeps the bonus withheld');
  window.deleteEntry(debitIds[1], true);
  eq(window.deriveDailyBonusEntries().filter(entry => entry.date === d2).length, 1, 'Deleting the last debit immediately restores exactly one reward on the now-empty day');
  window.undoFromToast();
  eq(window.deriveDailyBonusEntries().filter(entry => entry.date === d2).length, 0, 'Undoing a debit deletion withdraws the reward again');
  window.deleteEntry(debitIds[1], false);

  const dailyRuleId = window.eval('dailyBonuses[0].id');
  window.openDailyBonusModal(dailyRuleId);
  window.document.getElementById('dailyBonusPoints').value = '95';
  window.saveDailyBonus();
  eq(window.dailyTotalsByDate()[d2], 95, 'Editing daily reward points recalculates historical awards immediately');
  window.openDailyBonusModal(dailyRuleId);
  const deletingDailyRule = window.deleteDailyBonusConfirm();
  window.resolveConfirm(true);
  await deletingDailyRule;
  eq(window.deriveDailyBonusEntries().length, 0, 'Deleting an automatic daily rule removes all of its generated rewards');
  eq(window.eval('dailyBonuses.length'), 0, 'Daily bonus delete confirmation removes the rule');

  setLedger({
    start: d1,
    entries: [{ id:'net_positive_credit', date:d1, name:'Credit', type:'good', points:100, ts:1 }],
    dailyBonuses: [{ id:'daily_history', name:'No debits', points:80, description:'' }]
  });
  window.setTodayViewDate(d1);
  window.eval(`bonusTasks = [{id:'manual_history_bonus',name:'Manual bonus',points:13,order:0,sectionId:null}]`);
  window.logBonus('manual_history_bonus');
  eq(window.document.getElementById('scoreEl').textContent, '293', 'Historical score includes credits, a manual bonus, and the automatic daily reward');
  window.openDayActivity(d1);
  window.document.querySelector('[data-action="add-day-entry"]').click();
  window.document.getElementById('entryNameInput').value = 'Backdated debit';
  window.document.getElementById('entryTypeInput').value = 'bad';
  window.document.getElementById('entryPointsInput').value = '5';
  window.document.querySelector('[data-action="save-entry"]').click();
  const historyDebitId = window.eval(`entries.find(entry => entry.name === 'Backdated debit').id`);
  eq(window.document.getElementById('scoreEl').textContent, '208', 'Adding a debit through the history editor immediately withdraws the reward even with a positive net total');
  ok(!window.document.getElementById('dayActivityList').textContent.includes('Automatic daily bonus'), 'Open historical activity updates immediately after a backdated debit is created');
  window.openEntryModal(historyDebitId);
  window.document.getElementById('entryDateInput').value = d2;
  window.saveEditedEntry();
  eq(window.deriveDailyBonusEntries().map(entry => entry.date).join(','), d1, 'Moving a debit restores the old date’s reward and withdraws the destination date’s reward');
  window.openEntryModal(historyDebitId);
  window.document.getElementById('entryTypeInput').value = 'good';
  window.saveEditedEntry();
  eq(window.deriveDailyBonusEntries().length, 2, 'Changing a historical debit into a credit immediately restores the reward');
  window.openEntryModal(historyDebitId);
  window.document.getElementById('entryTypeInput').value = 'bad';
  window.saveEditedEntry();
  const deletingHistoryDebit = window.deleteHistoricalEntry(historyDebitId);
  window.resolveConfirm(true);
  await deletingHistoryDebit;
  eq(window.deriveDailyBonusEntries().length, 2, 'Confirmed deletion through the historical editor immediately restores the bonus');
  ok(window.document.getElementById('dayActivityList').textContent.includes('Automatic daily bonus'), 'Restored reward appears immediately in the open historical activity');
  eq(window.eval(`entries.filter(entry => entry.bonusId === 'manual_history_bonus').length`), 1, 'Automatic reward recalculation preserves the manually logged bonus exactly once');
  window.closeDayActivity();

  setLedger({
    start: d2,
    dailyBonuses: [{ id:'daily_threshold', name:'No debits', points:80, description:'' }],
    base: 20,
    threshold: 100
  });
  window.setTodayViewDate(d2);
  eq(window.document.getElementById('scoreEl').textContent, '100', 'Automatic bonus contributes to the displayed score');
  eq(window.document.getElementById('successTagEl').textContent, '80 to go for a success day', 'Success badge excludes automatic bonus points');
  eq(window.document.getElementById('thresholdProgressEl').style.width, '20%', 'Success progress bar excludes automatic bonus points');

  let dailySeed = 0xa110da7e;
  const dailyRandom = () => {
    dailySeed = (Math.imul(dailySeed, 1664525) + 1013904223) >>> 0;
    return dailySeed / 0x100000000;
  };
  let dailyReferenceFailure = '';
  for(let scenario = 0; scenario < 250 && !dailyReferenceFailure; scenario++){
    const rules = Array.from({ length:scenario % 4 }, (_, index) => ({
      id:`daily_reference_${index}`, name:`Reward ${index}`, points:1 + Math.floor(dailyRandom() * 9999), description:''
    }));
    const sourceEntries = [];
    const sourceCompletions = [];
    const expected = [];
    const referenceDate = offset => {
      const date = new Date(`${today}T12:00:00Z`);
      date.setUTCDate(date.getUTCDate() + offset);
      return date.toISOString().slice(0, 10);
    };
    for(let offset = -32; offset <= 1; offset++){
      const date = referenceDate(offset);
      const kind = Math.floor(dailyRandom() * 5);
      const add = (type, points, suffix) => sourceEntries.push({
        id:`reference_${scenario}_${offset + 32}_${suffix}`, date, name:type, type, points, ts:sourceEntries.length + 1
      });
      if(kind === 1) add('good', 100, 'credit');
      if(kind === 2) add('bonus', 20, 'manual_bonus');
      if(kind >= 3){
        add('good', 100, 'credit');
        add('bad', -1, 'debit');
      }
      if(kind === 4) add('bad', 0, 'zero_debit');
      if(dailyRandom() < 0.3) sourceCompletions.push({ id:`reference_complete_${offset + 32}`, date, ts:1 });
      if(offset >= -30 && offset < 0 && kind < 3){
        for(const rule of rules) expected.push(`${date}:${rule.id}:${rule.points}`);
      }
    }
    setLedger({ start:referenceDate(-30), entries:sourceEntries, completedDays:sourceCompletions, dailyBonuses:rules });
    const actual = window.deriveDailyBonusEntries().map(entry => `${entry.date}:${entry.dailyBonusId}:${entry.points}`);
    if(JSON.stringify(actual) !== JSON.stringify(expected)){
      dailyReferenceFailure = `Scenario ${scenario}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
    }
  }
  ok(!dailyReferenceFailure, '250 independently generated daily histories match exact reward dates, rules, and points, including bounds and multiple debits', dailyReferenceFailure);

  const realWindowDate = window.Date;
  const beforeClockState = window.buildSnapshot();
  let clockNow = new realWindowDate(2026, 2, 8, 6, 59, 59, 999).getTime();
  window.Date = class extends realWindowDate {
    constructor(...args) { super(...(args.length ? args : [clockNow])); }
    static now() { return clockNow; }
  };
  try {
    window.eval('dayStartHour = 7');
    setLedger({
      start: '2026-03-07',
      dailyBonuses: [{ id:'auto_clock', name:'No debits', points:80, description:'' }],
      milestones: [{ id:'milestone_clock', name:'One success', days:1, points:10, description:'' }],
      completedDays: [{ id:'day_clock', date:'2026-03-07', ts:1 }]
    });
    window.eval(`lastKnownDay = todayKey(); todayViewDate = todayKey()`);
    eq(window.deriveDailyBonusEntries().length, 0, 'Daily bonus waits until the configured day-start boundary even after midnight');
    eq(window.deriveMilestoneEntries().length, 0, 'Milestone waits until the configured day-start boundary');
    let scheduledDelay;
    let scheduledCallback;
    const realSetTimeout = window.setTimeout;
    window.setTimeout = (callback, delay) => { scheduledCallback = callback; scheduledDelay = delay; return 0; };
    window.scheduleNextDayRefresh();
    window.setTimeout = realSetTimeout;
    eq(scheduledDelay, 1, 'Day refresh timer targets the exact configured boundary');
    clockNow++;
    scheduledCallback();
    eq(window.deriveDailyBonusEntries().length, 1, 'Daily bonus appears at the next day-start boundary');
    eq(window.deriveMilestoneEntries().length, 1, 'Success milestone appears at the same boundary');
    eq(window.eval('todayViewDate'), '2026-03-08', 'Automatic rollover advances the Today view');
    eq(window.deriveDailyBonusEntries()[0].ts, clockNow, 'Daily reward timestamp is next-day start rather than noon');
    eq(window.deriveMilestoneEntries()[0].ts, clockNow, 'Milestone timestamp is next-day start rather than noon');
    clockNow = new realWindowDate(2026, 2, 11, 7).getTime();
    window.dispatchEvent(new window.Event('pageshow'));
    eq(window.deriveDailyBonusEntries().length, 4, 'Returning after several days catches up every finished day across daylight-saving time');
    eq(window.deriveMilestoneEntries().length, 1, 'Catching up does not duplicate a milestone award');
    window.eval('dailyBase = 0; successThreshold = 50');
    eq(window.computeStats().successRate, 0, 'Automatic daily points cannot create success qualification');
    eq(window.deriveMilestoneEntries().length, 0, 'Automatic daily points cannot bootstrap milestone rewards');
    window.eval(`entries.push({id:'clock_debit',date:'2026-03-09',name:'Debit',type:'bad',points:0,ts:1})`);
    eq(window.deriveDailyBonusEntries().length, 3, 'Any debit entry disqualifies its date even if its point value is zero');
    window.eval(`trackingStartDate = '2026-03-09'`);
    eq(window.deriveDailyBonusEntries().length, 1, 'Daily rewards respect a changed statistics start date');
    clockNow = new realWindowDate(2026, 2, 8, 3).getTime();
    window.eval('dayStartHour = 2');
    window.setTimeout = (callback, delay) => { scheduledDelay = delay; return 0; };
    try {
      window.scheduleNextDayRefresh();
    } finally {
      window.setTimeout = realSetTimeout;
    }
    eq(scheduledDelay, new realWindowDate(2026, 2, 9, 2).getTime() - clockNow, 'Next refresh returns to the configured hour after a missing daylight-saving hour');

    let boundaryFailure = '';
    for(const [year, month, day] of [[2026, 0, 1], [2024, 1, 29], [2026, 2, 8], [2026, 10, 1]]){
      for(let hour = 0; hour < 24 && !boundaryFailure; hour++){
        const boundary = new realWindowDate(year, month, day, hour).getTime();
        const finishedDay = new Date(Date.UTC(year, month, day - 1)).toISOString().slice(0, 10);
        clockNow = boundary - 1;
        window.eval(`dayStartHour = ${hour}`);
        setLedger({
          start:finishedDay,
          dailyBonuses:[{ id:'boundary_reward', name:'No debits', points:80, description:'' }],
          milestones:[{ id:'boundary_milestone', name:'One day', days:1, points:25, description:'' }],
          completedDays:[{ id:'boundary_complete', date:finishedDay, ts:1 }]
        });
        const beforeCount = window.allActivityEntries().length;
        clockNow = boundary;
        const earned = window.allActivityEntries();
        if(beforeCount !== 0 || earned.length !== 2 || !earned.every(entry => entry.date === finishedDay && entry.ts === boundary)){
          boundaryFailure = `${year}-${month + 1}-${day}, start hour ${hour}: ${beforeCount} awards before boundary, ${JSON.stringify(earned)} at boundary`;
        }
      }
    }
    ok(!boundaryFailure, 'All 24 start hours finalize rewards only at the boundary across New Year, leap day, and both daylight-saving changes', boundaryFailure);

    clockNow = new realWindowDate(2026, 10, 19, 6).getTime();
    window.eval('dayStartHour = 7');
    setLedger({ start:'2026-11-18', dailyBonuses:[{ id:'settings_reward', name:'No debits', points:80, description:'' }] });
    window.eval('lastKnownDay = todayKey()');
    window.openSettings();
    window.document.getElementById('dayStartInput').value = '5';
    window.saveSettings();
    eq(window.eval('todayViewDate'), '2026-11-19', 'Changing the day-start hour immediately keeps Today on the current ledger day');
    eq(window.deriveDailyBonusEntries().length, 1, 'Changing the start hour immediately finalizes a newly finished day');
    window.setTodayViewDate('2026-11-18');
    window.refreshIfNewDay();
    eq(window.eval('todayViewDate'), '2026-11-18', 'A later refresh preserves an intentionally selected past day after changing start time');
    window.returnToToday();
    const changedBoundaryState = window.validateBackupObject(window.buildSnapshot());
    changedBoundaryState.dayStartHour = 7;
    window.applyValidatedState(changedBoundaryState);
    eq(window.eval('todayViewDate'), '2026-11-18', 'Applying synced settings immediately follows a ledger day that moves backward');
    eq(window.deriveDailyBonusEntries().length, 0, 'Applying a later day-start hour withdraws awards for a day that is still open');
    changedBoundaryState.dayStartHour = 5;
    window.applyValidatedState(changedBoundaryState);
    eq(window.eval('todayViewDate'), '2026-11-19', 'Applying synced settings immediately follows a ledger day that moves forward');
    eq(window.deriveDailyBonusEntries().length, 1, 'Applying an earlier day-start hour restores the now-finalized award');
    window.setTodayViewDate('2026-11-18');
    changedBoundaryState.dayStartHour = 4;
    window.applyValidatedState(changedBoundaryState);
    window.refreshIfNewDay();
    eq(window.eval('todayViewDate'), '2026-11-18', 'Synced settings preserve a selected historical day when the current ledger date stays the same');
  } finally {
    window.Date = realWindowDate;
    window.applyValidatedState(window.validateBackupObject(beforeClockState));
    window.eval('lastKnownDay = todayKey(); todayViewDate = todayKey()');
    window.scheduleNextDayRefresh();
  }

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
        definitions.filter(item => item.days === run && date < today)
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
  const saved = await window.idbGet(window.eval('STATE_KEY'));
  const cleanSaved = window.validateBackupObject(saved);
  eq(cleanSaved.entries.length, expectedSavedEntries, 'Durable IndexedDB write preserves ledger');

  function createRaceBrowser(factory, sharedCloud = null, {
    offline = false, now = null, localCopies = {}, markup = html
  } = {}) {
    const errors = [];
    const consoleForBrowser = new VirtualConsole();
    consoleForBrowser.on('jsdomError', error => errors.push(String(error.message || error)));
    const browser = new JSDOM(markup, {
      url: 'https://tally-race.local/',
      runScripts: 'dangerously',
      pretendToBeVisual: true,
      virtualConsole: consoleForBrowser,
      beforeParse(raceWindow) {
        installNetworkStubs(raceWindow, sharedCloud);
        for(const [key, value] of Object.entries(localCopies)){
          raceWindow.localStorage.setItem(key, value);
        }
        if(offline){
          Object.defineProperty(raceWindow.navigator, 'onLine', { configurable:true, value:false });
          raceWindow.fetch = async () => { throw new TypeError('Offline test'); };
        }
        if(now !== null){
          const RealDate = raceWindow.Date;
          raceWindow.Date = class extends RealDate {
            constructor(...args) { super(...(args.length ? args : [now])); }
            static now() { return now; }
          };
        }
        raceWindow.indexedDB = factory;
        raceWindow.IDBKeyRange = IDBKeyRange;
        raceWindow.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
        raceWindow.scrollTo = () => {};
        raceWindow.scrollBy = () => {};
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

  async function openTestLedger(factory, cloud, options){
    const { browser } = createRaceBrowser(factory, cloud, options);
    await waitFor(() => browser.window.eval('appReady'));
    return browser.window;
  }

  function appendTestEntry(win, id){
    return win.eval(`entries.push({id:${JSON.stringify(id)},date:todayKey(),name:'Test entry',type:'good',points:1,ts:1}); persistData()`);
  }

  function pauseCall(win, name){
    const original = win[name];
    let entered, release;
    const started = new Promise(resolve => { entered = resolve; });
    const paused = new Promise(resolve => { release = resolve; });
    win[name] = async (...args) => {
      win[name] = original;
      entered();
      await paused;
      return original(...args);
    };
    return { started, release };
  }

  function cloudEntryIds(cloud){
    return cloud.snapshot.data.entries.map(entry => entry.id).sort().join(',');
  }

  const staleFactory = new IDBFactory();
  const staleCloud = { revision:0, snapshot:null, updatedAt:null };
  const freshTab = await openTestLedger(staleFactory, staleCloud);
  const staleTab = await openTestLedger(staleFactory, staleCloud);
  await appendTestEntry(freshTab, 'from_fresh_tab');
  await freshTab.syncCloudNow();
  const revisionBeforeStaleSync = staleCloud.revision;
  ok(await staleTab.syncCloudNow(), 'A stale tab can safely sync without a broadcast');
  eq(cloudEntryIds(staleCloud), 'from_fresh_tab', 'Syncing an untouched stale tab preserves the other tab’s entry');
  eq(staleCloud.revision, revisionBeforeStaleSync, 'Refreshing a stale tab does not upload a replacement ledger');
  freshTab.closeDeviceDatabase();
  staleTab.closeDeviceDatabase();
  freshTab.close();
  staleTab.close();

  const conflictCloud = { revision:0, snapshot:null, updatedAt:null };
  const conflictDevice = await openTestLedger(new IDBFactory(), conflictCloud);
  await conflictDevice.eval(`
    taskSections.push({id:'shared_topic',name:'Shared topic',kind:'habit',order:0});
    persistData();
  `);
  await conflictDevice.syncCloudNow();
  const confirmedBase = conflictCloud.revision;
  await conflictDevice.eval(`
    habits.push({id:'new_habit',name:'New habit',type:'good',points:1,streak:0,lastDate:null,order:0,sectionId:'shared_topic'});
    persistData();
  `);
  conflictCloud.snapshot.data.taskSections = [];
  conflictCloud.snapshot.data.entries.push({
    id:'from_remote', date:conflictDevice.todayKey(), name:'Remote entry', type:'good', points:1, ts:1
  });
  conflictCloud.revision++;
  const saveRecovery = conflictDevice.saveRecoverySnapshot;
  conflictDevice.saveRecoverySnapshot = async () => false;
  eq(await conflictDevice.syncCloudNow(), false, 'A merge stops when it cannot keep its recovery copy');
  eq((await conflictDevice.readCloudBaseRecord()).cloudRevision, confirmedBase,
    'Failed reconciliation keeps the previous confirmed cloud base');
  eq(cloudEntryIds(conflictCloud), 'from_remote', 'A failed merge leaves the cloud ledger intact');
  conflictDevice.saveRecoverySnapshot = saveRecovery;
  const recoveryPause = pauseCall(conflictDevice, 'saveRecoverySnapshot');
  const retry = conflictDevice.syncCloudNow();
  await recoveryPause.started;
  await appendTestEntry(conflictDevice, 'during_cloud_merge');
  recoveryPause.release();
  ok(await retry, 'Retry resolves an orphaned topic reference and syncs the ledger');
  eq(cloudEntryIds(conflictCloud), 'during_cloud_merge,from_remote', 'Cloud merge preserves entries added remotely and during recovery');
  eq(conflictCloud.snapshot.data.taskSections.length, 0, 'Cloud retry preserves the topic deletion');
  eq(conflictCloud.snapshot.data.habits[0].sectionId, null, 'Habit added to a concurrently deleted topic becomes unsorted');

  const newerCloud = structuredClone(conflictCloud.snapshot);
  newerCloud.data.entries.push({
    id:'later_remote', date:conflictDevice.todayKey(), name:'Later remote', type:'good', points:1, ts:1
  });
  conflictCloud.snapshot = newerCloud;
  conflictCloud.revision++;
  const readingBase = pauseCall(conflictDevice, 'readCloudBaseRecord');
  const refresh = conflictDevice.syncCloudNow();
  await readingBase.started;
  await appendTestEntry(conflictDevice, 'during_base_read');
  readingBase.release();
  ok(await refresh, 'Cloud refresh completes after concurrent local save');
  eq(cloudEntryIds(conflictCloud), 'during_base_read,during_cloud_merge,from_remote,later_remote',
    'Cloud refresh merges a save made while reading its base');

  const localConflict = conflictDevice.buildSnapshot();
  localConflict.revision++;
  localConflict.data.entries.push({
    id:'another_tab', date:conflictDevice.todayKey(), name:'Other tab', type:'good', points:1, ts:1
  });
  await conflictDevice.idbPut(conflictDevice.eval('STATE_KEY'), localConflict);
  const savePause = pauseCall(conflictDevice, 'saveRecoverySnapshot');
  const firstSave = appendTestEntry(conflictDevice, 'before_local_recovery');
  await savePause.started;
  const secondSave = appendTestEntry(conflictDevice, 'during_local_recovery');
  savePause.release();
  await Promise.all([firstSave, secondSave]);
  const currentLocal = await conflictDevice.idbGet(conflictDevice.eval('STATE_KEY'));
  ok(['another_tab','before_local_recovery','during_local_recovery'].every(id =>
    currentLocal.data.entries.some(entry => entry.id === id)), 'Local write conflicts preserve edits during the recovery write');

  await conflictDevice.eval(`
    habits.push(
      {id:'debit_first',name:'Same name',type:'bad',points:1,order:1,streak:0,lastDate:null,sectionId:null},
      {id:'debit_second',name:'Same name',type:'bad',points:2,order:2,streak:0,lastDate:null,sectionId:null}
    );
    logHabit('debit_first');
  `);
  conflictDevice.openEntryModal(conflictDevice.buildSnapshot().data.entries.at(-1).id);
  conflictDevice.saveEditedEntry();
  await conflictDevice.eval('persistInFlight');
  eq(conflictDevice.buildSnapshot().data.entries.at(-1).habitId, 'debit_first',
    'Saving an unchanged debit keeps its original habit ID');
  eq(conflictDevice.eval("taskActivity('habit', todayKey()).selectedCounts.get('debit_first')"), 1,
    'Aggregated task activity counts the linked debit with duplicate names');
  conflictDevice.closeDeviceDatabase();
  conflictDevice.close();

  for(const factory of [new IDBFactory(), undefined]){
    const signOutCloud = { revision:0, snapshot:null, updatedAt:null };
    const device = await openTestLedger(factory, signOutCloud);
    await appendTestEntry(device, 'keep_in_cloud');
    const signOut = device.signOutAndClearDevice();
    device.resolveConfirm(true);
    await signOut;
    device.dispatchEvent(new device.Event('pagehide'));
    Object.defineProperty(device.document, 'hidden', { configurable:true, value:true });
    device.document.dispatchEvent(new device.Event('visibilitychange'));
    eq(device.localStorage.getItem(device.eval('EMERGENCY_STATE_KEY')), null,
      'Sign-out navigation does not recreate the emergency ledger');
    eq(device.localStorage.getItem(device.eval('FALLBACK_STATE_KEY')), null,
      'Sign-out clears the browser storage copy even without IndexedDB');
    eq(cloudEntryIds(signOutCloud), 'keep_in_cloud', 'Sign-out confirms the saved cloud ledger before cleaning up');
    device.close();
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
  const raceSnapshot = await raceA.browser.window.idbGet(raceA.browser.window.eval('STATE_KEY'));
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
      taskSections.push({id:'cloud_habit_topic',name:'Cloud topic',kind:'habit',order:0});
      habits.push({id:'cloud_habit',name:'Cloud habit',type:'good',points:4,streak:0,lastDate:null,order:7,sectionId:'cloud_habit_topic'});
      dailyBonuses.push({id:'cloud_daily_a',name:'No debits A',points:80,description:'Daily reward A'});
      taskSortModes.habit = 'name-desc';
      persistData()
    `),
    cloudB.browser.window.eval(`
      entries.push({id:'cloud_b',date:'${cloudDate}',name:'Cloud B',type:'good',points:2,ts:12});
      taskSections.push({id:'cloud_bonus_section',name:'Cloud specials',kind:'bonus',order:0});
      bonusTasks.push({id:'cloud_bonus',name:'Cloud bonus',points:5,order:3,sectionId:'cloud_bonus_section'});
      dailyBonuses.push({id:'cloud_daily_b',name:'No debits B',points:10,description:'Daily reward B'});
      taskSortModes.bonus = 'points-asc';
      persistData()
    `)
  ]);
  await Promise.all([
    cloudA.browser.window.syncCloudNow(),
    cloudB.browser.window.syncCloudNow()
  ]);
  await new Promise(resolve => setTimeout(resolve, 50));

  const readerFactory = new IDBFactory();
  const cloudReader = createRaceBrowser(readerFactory, sharedCloud);
  await waitFor(() => cloudReader.browser.window.document.getElementById('loadingScreen').style.display === 'none');
  const cloudIds = cloudReader.browser.window.eval('entries.map(entry => entry.id).sort()');
  eq(JSON.stringify(cloudIds), JSON.stringify(['cloud_a', 'cloud_b']), 'Two separate devices merge independent cloud writes without lost data');
  eq(cloudReader.browser.window.eval(`habits.find(item => item.id === 'cloud_habit').order`), 7, 'Cloud merge preserves explicit manual habit order');
  eq(cloudReader.browser.window.eval(`habits.find(item => item.id === 'cloud_habit').sectionId`), 'cloud_habit_topic', 'Cloud merge preserves habit topic membership');
  eq(cloudReader.browser.window.eval(`bonusTasks.find(item => item.id === 'cloud_bonus').order`), 3, 'Cloud merge preserves explicit manual bonus order');
  eq(cloudReader.browser.window.eval(`taskSections.length`), 2, 'Cloud merge preserves an independent habit topic and bonus section');
  eq(cloudReader.browser.window.eval(`taskSortModes.habit`), 'name-desc', 'Cloud merge preserves habit sort preference');
  eq(cloudReader.browser.window.eval(`taskSortModes.bonus`), 'points-asc', 'Cloud merge preserves independent bonus sort preference');
  eq(cloudReader.browser.window.eval('dailyBonuses.length'), 2, 'Cloud conflict merge preserves independent daily bonus rules from both devices');
  eq(cloudReader.browser.window.eval(`dailyBonuses.find(item => item.id === 'cloud_daily_a').points`), 80, 'Reopening on another device restores configured automatic reward points');
  ok(sharedCloud.revision >= 3, 'Cloud revision advances monotonically through a write conflict');

  const previousCloudDay = window.addDaysToKey(cloudDate, -1);
  await cloudReader.browser.window.eval(`
    trackingStartDate = addDaysToKey('${cloudDate}', -2);
    entries.push({id:'cloud_backdated_debit',date:'${previousCloudDay}',name:'Backdated debit',type:'bad',points:-5,ts:13});
    persistData()
  `);
  await cloudReader.browser.window.syncCloudNow();
  await cloudA.browser.window.syncCloudNow();
  eq(cloudA.browser.window.deriveDailyBonusEntries().filter(entry => entry.date === previousCloudDay).length, 0, 'A synced backdated debit withdraws the daily rewards on another device');
  eq(cloudA.browser.window.deriveDailyBonusEntries().length, 2, 'Syncing a backdated debit preserves rewards on unaffected days');
  await cloudA.browser.window.eval(`deleteEntry('cloud_backdated_debit', false); persistData()`);
  await cloudA.browser.window.syncCloudNow();
  await cloudReader.browser.window.syncCloudNow();
  const syncedDailyAwards = cloudReader.browser.window.deriveDailyBonusEntries();
  eq(syncedDailyAwards.filter(entry => entry.date === previousCloudDay).length, 2, 'Deleting the last debit on another device restores each daily reward after sync');
  eq(new Set(syncedDailyAwards.map(entry => entry.id)).size, 4, 'Cross-device edits preserve exactly one award per eligible date and rule');
  ok(!cloudA.errors.length && !cloudB.errors.length && !cloudReader.errors.length, 'Cloud rule and historical debit edits avoid browser runtime errors', [...cloudA.errors, ...cloudB.errors, ...cloudReader.errors].join(' | '));
  cloudA.browser.window.close();
  cloudB.browser.window.close();
  cloudReader.browser.window.closeDeviceDatabase();
  cloudReader.browser.window.close();

  const offlineDay = window.addDaysToKey(cloudDate, 3);
  const offlineReload = createRaceBrowser(readerFactory, sharedCloud, {
    offline:true, now:new Date(`${offlineDay}T07:00:00`).getTime()
  });
  await waitFor(() => offlineReload.browser.window.document.getElementById('loadingScreen').style.display === 'none');
  eq(offlineReload.browser.window.eval('appReady'), true, 'A previously trusted device reopens from durable storage while offline');
  eq(offlineReload.browser.window.deriveDailyBonusEntries().length, 10, 'Reopening offline after three days catches up all eligible daily rewards from persisted rules');
  eq(offlineReload.browser.window.eval('entries.length'), 2, 'Offline catch-up preserves manual source entries without storing duplicate automatic rewards');
  const offlineAwardIds = offlineReload.browser.window.deriveDailyBonusEntries().map(entry => entry.id).join(',');
  offlineReload.browser.window.dispatchEvent(new offlineReload.browser.window.Event('pageshow'));
  eq(offlineReload.browser.window.deriveDailyBonusEntries().map(entry => entry.id).join(','), offlineAwardIds, 'Repeated offline page resumes do not duplicate caught-up rewards');
  ok(!offlineReload.errors.length, 'Offline reopen and catch-up avoid browser runtime errors', offlineReload.errors.join(' | '));
  offlineReload.browser.window.close();

  const legacySnapshot = window.buildSnapshot();
  legacySnapshot.schemaVersion = 6;
  legacySnapshot.revision = 20;
  legacySnapshot.data = {
    taskSections:[], habits:[], bonusTasks:[], milestones:[], completedDays:[],
    entries:[{ id:'legacy_entry', date:cloudDate, name:'Legacy entry', type:'good', points:1, ts:1 }]
  };
  legacySnapshot.settings.trackingStartDate = cloudDate;
  const legacyBase = { cloudRevision:4, snapshot:legacySnapshot };

  const existingCloudSnapshot = structuredClone(legacySnapshot);
  existingCloudSnapshot.schemaVersion = 7;
  existingCloudSnapshot.data.dailyBonuses = [{
    id:'existing_rule', name:'Existing daily reward', points:11, description:''
  }];
  existingCloudSnapshot.revision++;
  existingCloudSnapshot.data.entries[0].points = 12;
  existingCloudSnapshot.data.entries.push({
    id:'cloud_only', date:cloudDate, name:'Cloud entry', type:'good', points:10, ts:2
  });
  const pendingLegacyLocal = structuredClone(legacySnapshot);
  pendingLegacyLocal.data.entries.push({
    id:'offline_only', date:cloudDate, name:'Offline entry', type:'good', points:3, ts:3
  });
  const upgradeCloud = { revision:10, snapshot:existingCloudSnapshot, updatedAt:null };
  const upgraded = await openTestLedger(new IDBFactory(), upgradeCloud, {
    localCopies:{
      'tally-state-v2':JSON.stringify(pendingLegacyLocal),
      'tally-cloud-base-v1':JSON.stringify({ cloudRevision:10, snapshot:existingCloudSnapshot })
    }
  });
  eq(cloudEntryIds(upgradeCloud), 'cloud_only,legacy_entry,offline_only',
    'An online upgrade preserves existing cloud entries and independent legacy offline edits');
  eq(upgradeCloud.snapshot.data.entries.find(entry => entry.id === 'legacy_entry').points, 12,
    'An unconfirmed old base cannot authorize overwriting an existing cloud entry');
  eq(upgradeCloud.snapshot.data.dailyBonuses[0].id, 'existing_rule',
    'An upgrade from a legacy device copy preserves existing automatic bonus rules');
  eq((await upgraded.readCloudBaseRecord()).cloudRevision, upgradeCloud.revision,
    'The upgraded client records confirmed ancestry after persisting the merged ledger');
  upgraded.closeDeviceDatabase();
  upgraded.close();

  const migrationFactory = new IDBFactory();
  const legacyDb = await new Promise((resolve, reject) => {
    const request = migrationFactory.open('tally-ledger', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  function writeLegacyRecords(records){
    return new Promise((resolve, reject) => {
      const tx = legacyDb.transaction('records', 'readwrite');
      for(const [key, value] of Object.entries(records)) tx.objectStore('records').put(value, key);
      tx.oncomplete = resolve;
      tx.onabort = () => reject(tx.error);
    });
  }
  await writeLegacyRecords({
    state:legacySnapshot,
    recovery:legacySnapshot,
    'cloud-base-v1':legacyBase,
    'trusted-device-v1':{ trusted:true }
  });
  const migrated = createRaceBrowser(migrationFactory, null, {
    offline:true,
    localCopies:{ 'tally-cloud-base-v1':JSON.stringify({ ...legacyBase, cloudRevision:5 }) }
  });
  const migratedWindow = migrated.browser.window;
  await waitFor(() => migratedWindow.eval('appReady'));
  eq(migratedWindow.eval('entries[0].id'), 'legacy_entry', 'An offline upgrade migrates the legacy IndexedDB ledger');
  await migratedWindow.eval(`
    entries.push({id:'updated_entry',date:'${cloudDate}',name:'New entry',type:'good',points:2,ts:2});
    dailyBonuses.push({id:'updated_rule',name:'Daily points',points:10,description:''});
    persistData();
  `);
  const updatedSnapshot = migratedWindow.buildSnapshot();
  const staleSnapshot = { ...legacySnapshot, revision:50 };
  await writeLegacyRecords({
    state:staleSnapshot,
    recovery:staleSnapshot,
    'cloud-base-v1':{ cloudRevision:7, snapshot:staleSnapshot }
  });
  migratedWindow.closeDeviceDatabase();
  migratedWindow.close();
  legacyDb.close();
  const migratedReload = createRaceBrowser(migrationFactory, null, { offline:true });
  const reloadedWindow = migratedReload.browser.window;
  await waitFor(() => reloadedWindow.eval('appReady'));
  eq(JSON.stringify(reloadedWindow.buildSnapshot().data), JSON.stringify(updatedSnapshot.data),
    'A higher revision written to the legacy keys cannot replace current IndexedDB entries or bonus rules');
  eq((await reloadedWindow.readCloudBaseRecord()).cloudRevision, 5,
    'Migration keeps the newest legacy sync base and protects it from later legacy writes');
  reloadedWindow.localStorage.setItem('tally-cloud-base-v7', JSON.stringify({
    cloudRevision:8, localRevision:updatedSnapshot.revision, snapshot:updatedSnapshot
  }));
  await reloadedWindow.eval("entries = entries.filter(entry => entry.id !== 'updated_entry'); persistData()");
  await reloadedWindow.reconcileCloudState({ cloudRevision:8, snapshot:updatedSnapshot });
  eq(reloadedWindow.eval("entries.some(entry => entry.id === 'updated_entry')"), false,
    'Returning to IndexedDB preserves local deletions made against a newer fallback sync base');
  reloadedWindow.closeDeviceDatabase();
  reloadedWindow.close();

  const stagedCopies = {
    'tally-state-v2':JSON.stringify(updatedSnapshot),
    'tally-recovery-v2':JSON.stringify(legacySnapshot),
    'tally-trusted-device-v1':'1'
  };
  const fallbackMigration = createRaceBrowser(null, null, { offline:true, localCopies:stagedCopies });
  const fallbackWindow = fallbackMigration.browser.window;
  fallbackWindow.dispatchEvent(new fallbackWindow.Event('pagehide'));
  Object.defineProperty(fallbackWindow.document, 'hidden', { configurable:true, value:true });
  fallbackWindow.document.dispatchEvent(new fallbackWindow.Event('visibilitychange'));
  await waitFor(() => fallbackWindow.eval('appReady'));
  eq(fallbackWindow.eval('storageMode'), 'localStorage', 'Migration also runs when IndexedDB is unavailable');
  const protectedMirror = fallbackWindow.localStorage.getItem(fallbackWindow.eval('FALLBACK_STATE_KEY'));
  eq(JSON.stringify(JSON.parse(protectedMirror).data), JSON.stringify(updatedSnapshot.data),
    'Backgrounding the app during startup still migrates existing version-7 data');
  fallbackWindow.close();
  const fallbackReload = createRaceBrowser(null, null, {
    offline:true,
    localCopies:{
      ...stagedCopies,
      'tally-state-v2':JSON.stringify(staleSnapshot),
      'tally-state-v7':protectedMirror
    }
  });
  const fallbackReloadWindow = fallbackReload.browser.window;
  await waitFor(() => fallbackReloadWindow.eval('appReady'));
  eq(JSON.stringify(fallbackReloadWindow.buildSnapshot().data), JSON.stringify(updatedSnapshot.data),
    'An older cached app writing to the legacy fallback key cannot replace current entries or daily rules');
  fallbackReloadWindow.clearTallyLocalStorage();
  eq(fallbackReloadWindow.localStorage.length, 0, 'Sign-out cleanup clears both generations of browser storage');
  fallbackReloadWindow.close();

  // Exercise a deployment where older markup ends up with the current script.
  const legacyMarkup = html
    .replace(/id="dailyBonusList"/, 'id="legacyBonusList"')
    .replace(/id="dailyBonus(?:Name|Points|Description)"/g, '');
  const legacyShell = createRaceBrowser(new IDBFactory(), null, { markup:legacyMarkup });
  await waitFor(() => legacyShell.browser.window.eval('appReady'));
  ok(!legacyShell.errors.length, 'The current script can boot with older cached markup', legacyShell.errors.join(' | '));
  legacyShell.browser.window.close();

  const clientPath = shellHtml.match(/<script src="(\/tally-v\d+\.js)" defer>/)?.[1];
  const shellAssets = new Map();
  const oldAssets = new Map([['/tally.js', 'legacy client']]);
  const workerListeners = new Map();
  const shellOrigin = 'https://tally.local';
  let precacheRuns = 0;
  const responses = [];
  const shellCache = {
    async addAll(requests){
      precacheRuns++;
      for(const request of requests){
        const route = new URL(request.url).pathname;
        const body = route === '/tally-v8.html' ? shellHtml : route;
        shellAssets.set(route, body);
      }
    },
    async match(route){ return shellAssets.get(route); }
  };
  vm.runInNewContext(fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8'), {
    self:{ location:{ origin:shellOrigin }, addEventListener:(event, listener) => workerListeners.set(event, listener) },
    caches:{ open:async () => shellCache, match:async route => oldAssets.get(route) },
    Request:class extends Request {
      constructor(route, options){ super(new URL(route, shellOrigin), options); }
    },
    URL,
    fetch:async request => { responses.push(request.url); return 'network'; }
  });
  let installed;
  workerListeners.get('install')({ waitUntil:promise => { installed = promise; } });
  await installed;
  function dispatchShellFetch(route){
    let response;
    workerListeners.get('fetch')({
      request:new Request(new URL(route, shellOrigin)),
      respondWith:value => { response = value; }
    });
    return response;
  }
  eq(await dispatchShellFetch('/tally.html'), shellHtml, 'An installed worker serves the precached HTML');
  eq(await dispatchShellFetch(clientPath), clientPath, 'The cached HTML and its exact script version are available together');
  eq(dispatchShellFetch('/tally.js'), undefined, 'The legacy script URL is outside the current shell cache');
  eq(responses.length, 0, 'The installed shell opens from its cache');
  shellAssets.clear();
  eq(await dispatchShellFetch(clientPath), 'network', 'A missing versioned script is fetched by its exact URL');
  eq(await dispatchShellFetch('/tally.html'), shellHtml, 'The worker precaches the whole shell again after sign-out clears it');
  eq(precacheRuns, 2, 'Shell refill is one complete precache operation');

  const largeLedger = createRaceBrowser(new IDBFactory(), null, {
    now:new Date(2026, 10, 19, 8).getTime()
  });
  const largeWindow = largeLedger.browser.window;
  await waitFor(() => largeWindow.eval('appReady'));
  largeWindow.eval(`
    trackingStartDate = '2021-11-19';
    dailyBonuses = Array.from({length:100}, (_, index) =>
      ({id:'large_rule_'+index,name:index === 0 ? 'constructor' : 'Rule '+index,points:80,description:''}));
    entries = [
      {id:'named_credit',date:todayKey(),name:'constructor',type:'good',points:10,ts:1},
      {id:'named_debit',date:todayKey(),name:'__proto__',type:'bad',points:-5,ts:2}
    ];
    milestones = [{id:'named_milestone',name:'constructor',days:1,points:25,description:''}];
  `);
  const renderedDates = [];
  const originalDailyRows = largeWindow.dailyBonusEntriesForDate;
  largeWindow.dailyBonusEntriesForDate = date => {
    renderedDates.push(date);
    return originalDailyRows(date);
  };
  largeWindow.renderAll();
  eq(renderedDates.length, 0, 'Rendering totals, statistics, and a closed activity log creates no daily award rows');
  const largeStats = largeWindow.computeStats();
  const bonusDayCount = largeWindow.eval("calendarDaysInclusive('2021-11-19', addDaysToKey(todayKey(), -1))");
  eq(largeStats.biggestGains[0].name, 'constructor', 'Contributor rankings accept inherited property names');
  eq(largeStats.biggestGains[0].points, 80 * bonusDayCount + 35, 'Rankings combine same-name manual, daily and milestone gains');
  eq(largeStats.biggestGains[0].count, bonusDayCount + 2, 'Rankings retain the complete count of aggregated rewards');
  eq(largeStats.biggestDrains[0].name, '__proto__', 'Contributor rankings accept special names in debits');
  eq(largeWindow.document.getElementById('allTimeEl').textContent, `+${8000 * bonusDayCount + 30}`,
    'All-time points include award totals across the full history');
  const yesterday = largeWindow.addDaysToKey(largeWindow.todayKey(), -1);
  largeWindow.openDayActivity(yesterday);
  eq(JSON.stringify(renderedDates), JSON.stringify([yesterday]), 'Opening historical activity generates rows for only the selected day');
  eq(largeWindow.document.querySelectorAll('#dayActivityList .row').length, 100, 'The selected day still displays all its individual rewards');
  largeWindow.close();
  ok(!browserErrors.length, 'Expanded daily bonus scenarios finish without browser runtime errors', browserErrors.join(' | '));

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

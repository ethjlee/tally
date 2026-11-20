const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { JSDOM, VirtualConsole } = require('jsdom');
const { indexedDB, IDBKeyRange, IDBFactory } = require('fake-indexeddb');

const publicDir = path.join(__dirname, '..', 'public');
const shellHtml = fs.readFileSync(path.join(publicDir, 'tally.html'), 'utf8');
const clientBundle = fs.readFileSync(path.join(publicDir, 'assets', 'ledger.js'), 'utf8');
// Existing race and migration fixtures edit live state in the simulated browser.
const stateAccessors = `
  for (const state of [ledgerState, deviceState, cloudState, viewState]) {
    for (const key of Object.keys(state)) {
      Object.defineProperty(window, key, { get: () => state[key], set: value => { state[key] = value; } });
    }
  }`;
const html = shellHtml
  .replace('<link rel="stylesheet" href="/tally.css">', `<style>${fs.readFileSync(path.join(publicDir, 'tally.css'), 'utf8')}</style>`)
  .replace(/<script src="\/tally-v\d+\.js" defer><\/script>/, () => `<script>${clientBundle}\n${stateAccessors}</script>`);
const browserErrors = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', error => browserErrors.push(String(error.message || error)));
virtualConsole.on('error', error => browserErrors.push(String(error)));

function installNetworkStubs(window, sharedCloud = null) {
  window.TextEncoder = TextEncoder;
  const cloud = sharedCloud || { revision: 0, snapshot: null, updatedAt: null };
  const receipts = cloud.receipts ||= new Map();
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
      const receipt = receipts.get(body.operationId);
      if (receipt) return new Response(JSON.stringify(receipt), { status: 200 });
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
      const result = {
        status: 'written',
        cloudRevision: cloud.revision,
        updatedAt: cloud.updatedAt
      };
      receipts.set(body.operationId, result);
      return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
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
      setTravelPauses([]);
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
  const emptyUnsorted = window.document.querySelector('#habitList [data-task-drop-zone][data-section-id=""]');
  ok(emptyUnsorted && emptyUnsorted.querySelector('.task-group-empty'), 'Manual sorting keeps an empty Unsorted drop target');
  const assignedHandle = window.document.querySelector('[data-drag-handle][data-id="sort_a"]');
  window.document.elementFromPoint = () => emptyUnsorted;
  window.beginTaskDrag({ pointerId:44, clientX:10, clientY:10, preventDefault() {} }, assignedHandle);
  window.updateTaskDrag({ pointerId:44, clientX:30, clientY:200, preventDefault() {} });
  window.finishTaskDrag({ pointerId:44 });
  window.document.elementFromPoint = originalElementFromPoint;
  eq(window.eval(`habits.find(item => item.id === 'sort_a').sectionId`), null, 'Pointer drag returns a habit to an empty Unsorted group');
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
  Object.defineProperty(jsonInput, 'files', { configurable:true, value:[{ size:window.eval('MAX_BACKUP_BYTES') + 1 }] });
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
    window.setTravelPauses([{ id:'boundary_trip', start:'2026-03-08', end:'2026-03-08' }]);
    clockNow = new realWindowDate(2026, 2, 9, 6, 59).getTime();
    ok(window.pauseOn(window.todayKey()), 'The last travel day stays paused up to the configured rollover');
    clockNow = new realWindowDate(2026, 2, 9, 7).getTime();
    eq(window.pauseOn(window.todayKey()), null, 'Travel ends precisely when the next ledger day starts');
    eq(window.deriveDailyBonusEntries().length, 1, 'Crossing the day boundary skips the finished vacation reward');
    window.setTravelPauses([]);
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

  const chart = window.document.querySelector('.line-chart');
  const firstPoint = chart.querySelector('.chart-hit');
  const chartScore = () => window.document.querySelector('.chart-selection-readout strong').textContent;
  chart.querySelector('.chart-plot').getBoundingClientRect = () => ({
    left:40, right:240, top:10, bottom:210, width:200
  });
  function chartPointer(type, pointerType, x, { y = 50, time } = {}){
    const event = new window.MouseEvent(type, { bubbles:true, clientX:x, clientY:y });
    Object.assign(event, { pointerType, pointerId:1, isPrimary:true });
    if(time !== undefined) Object.defineProperty(event, 'timeStamp', { value:time });
    firstPoint.dispatchEvent(event);
  }
  chartPointer('pointermove', 'mouse', 40);
  eq(chartScore(), '110', 'Hover previews the plotted score');
  chartPointer('pointermove', 'mouse', 140);
  eq(chartScore(), '—', 'Hover over an unknown day shows a gap');
  chartPointer('pointerleave', 'mouse', 245);
  eq(chartScore(), '130', 'Leaving the chart restores the selected date');
  const tapClick = () => firstPoint.dispatchEvent(new window.MouseEvent('click', { bubbles:true, detail:1 }));
  chartPointer('pointerdown', 'touch', 40);
  eq(chartScore(), '110', 'Touch shows a score immediately');
  chartPointer('pointermove', 'touch', 140);
  eq(chartScore(), '—', 'Dragging immediately previews the next day');
  chartPointer('pointerup', 'touch', 140);
  eq(chartScore(), '—', 'The preview stays visible after lifting a finger');
  eq(window.eval('selectedHistoryDate'), d2, 'A touch drag selects the previewed date');
  tapClick();
  eq(window.eval('selectedDayKey'), null, 'A touch drag does not open day details');

  chartPointer('pointerdown', 'touch', 40);
  chartPointer('pointermove', 'touch', 41, { y:110 });
  chartPointer('pointercancel', 'touch', 41, { y:110 });
  eq(chartScore(), '—', 'A cancelled touch scroll restores the last selected preview');

  chartPointer('pointerdown', 'touch', 40, { time:100 });
  chartPointer('pointerup', 'touch', 40, { time:500 });
  tapClick();
  eq(window.eval('selectedDayKey'), null, 'Releasing a long press leaves detail closed');
  chartPointer('pointerdown', 'touch', 40, { time:600 });
  chartPointer('pointerup', 'touch', 40, { time:650 });
  tapClick();
  eq(window.eval('selectedDayKey'), d1, 'The next quick tap opens the tapped day');
  window.closeDayActivity();

  const sparseChartStart = window.addDaysToKey(today, -89);
  setLedger({ start:sparseChartStart, entries:[{ id:'sparse', date:d1, name:'Credit', type:'good', points:10, ts:1 }] });
  window.eval('historyRangeDays = 90');
  window.renderHistory();
  const sparseHit = window.document.querySelector('.chart-hit');
  const sparseDot = window.document.querySelector('.chart-dot');
  const hitStart = Number(sparseHit.getAttribute('x'));
  const hitWidth = Number(sparseHit.getAttribute('width'));
  const dotCenter = Number(sparseDot.getAttribute('cx'));
  const dotRadius = Number(sparseDot.getAttribute('r'));
  ok(hitStart <= dotCenter - dotRadius && hitStart + hitWidth >= dotCenter + dotRadius,
    'A sparse point on the 90-day chart has a tap target that covers the entire dot');
  sparseDot.dispatchEvent(new window.MouseEvent('click', { bubbles:true, detail:1 }));
  eq(window.eval('selectedDayKey'), d1, 'Clicking a visible dot opens its own activity');
  window.closeDayActivity();

  const tripStart = window.addDaysToKey(today, -3);
  const beforeTrip = window.addDaysToKey(today, -4);
  setLedger({
    start:beforeTrip,
    dailyBonuses:[{ id:'no_debits', name:'No debits', points:5, description:'' }],
    milestones:[{ id:'twice', name:'Two days', days:2, points:20, description:'' }],
    completedDays:[{ id:'marked', date:d1, ts:2 }],
    entries:[
      { id:'before', date:beforeTrip, name:'Walk', type:'good', points:1, ts:1, habitId:'walk' },
      { id:'vacation', date:tripStart, name:'Holiday credit', type:'bonus', points:100, ts:2, bonusId:'holiday_bonus' },
      { id:'loss', date:d1, name:'Holiday debit', type:'bad', points:-99, ts:3, habitId:'holiday_debit' },
      { id:'return', date:d2, name:'Walk', type:'good', points:1, ts:4, habitId:'walk' }
    ]
  });
  window.eval("habits = [{id:'walk',name:'Walk',type:'good',points:1,streak:0,lastDate:null,order:0,sectionId:null}]");
  window.eval("habits.push({id:'holiday_debit',name:'Holiday debit',type:'bad',points:99,streak:0,lastDate:null,order:1,sectionId:null}); bonusTasks = [{id:'holiday_bonus',name:'Holiday credit',points:100,order:0,sectionId:null}]");
  const rawTripEntries = JSON.stringify(window.buildSnapshot().data.entries);
  const beforePausing = JSON.stringify(window.dailyTotalsByDate());
  window.document.querySelector('#todayView [data-action="open-travel"]').click();
  window.document.getElementById('travelStart').value = tripStart;
  window.document.getElementById('travelEnd').value = d1;
  window.document.getElementById('saveTravel').click();
  eq(window.dailyTotalsByDate()[tripStart], undefined, 'Retroactive pause excludes the entire +100 day and its automatic bonus');
  eq(window.computeStats().currentStreak, 2, 'Paused debit and completion mark cannot break or advance a streak');
  eq(window.computeStats().daysTracked, 2, 'Statistics skip both paused dates');
  eq(window.computeStats().biggestDrains.length, 0, 'Paused debits are excluded from contributors');
  window.eval(`todayViewDate = '${d1}'`);
  window.renderHabitList();
  ok(window.document.querySelector('[data-task-row][data-id="holiday_debit"]').textContent.includes('1× this day'),
    'A habit row still counts entries on the selected paused day');
  eq(window.taskActivity('habit', d1).counts.has('holiday_debit'), false, 'A paused habit log does not count toward usage sorting');
  window.eval(`todayViewDate = '${tripStart}'`);
  window.renderBonusList();
  ok(window.document.querySelector('[data-task-row][data-id="holiday_bonus"]').textContent.includes('1× this day'),
    'A bonus row still counts entries on the selected paused day');
  eq(window.taskActivity('bonus', tripStart).counts.has('holiday_bonus'), false, 'A paused bonus log does not count toward usage sorting');
  window.eval(`todayViewDate = '${today}'`);
  eq(window.eval("habits[0].streak"), 2, 'Habit streak bridges both vacation days');
  eq(window.deriveMilestoneEntries()[0].date, d2, 'Milestone moves to the next qualifying closed day');
  eq(window.deriveDailyBonusEntries().length, 2, 'No daily bonus is earned on vacation');
  ok(window.buildActivityCsv().split('\n').some(row => row.includes('Holiday credit') && row.includes('false')), 'Activity export marks the original credit as excluded');
  eq(JSON.stringify(window.buildSnapshot().data.entries), rawTripEntries, 'Travel mode preserves original entries');
  const tripSnapshot = window.buildSnapshot();
  const tripId = tripSnapshot.data.travelPauses[0].id;
  eq(window.parseFullCsvBackup(window.buildFullCsvBackup().text).travelPauses[0].end, d1, 'Full CSV restores inclusive travel dates');
  eq(window.validateBackupObject(window.buildExport()).travelPauses[0].start, tripStart, 'JSON export restores the pause start');
  window.openDayActivity(tripStart);
  ok(window.document.getElementById('daySummary').textContent.includes('Paused') &&
     window.document.getElementById('dayActivityList').textContent.includes('Holiday credit'), 'History explains the exclusion beside the original entry');
  window.document.querySelector('#dayCompletionControl [data-action="open-travel"]').click();
  window.document.getElementById('travelStart').value = d1;
  window.document.getElementById('saveTravel').click();
  eq(window.dailyTotalsByDate()[tripStart], 125, 'Shortening a pause restores the credit and its earned rewards');
  window.openTravel(d1);
  window.document.getElementById('removeTravel').click();
  eq(JSON.stringify(window.dailyTotalsByDate()), beforePausing, 'Removing the trip restores every original score');
  window.closeDayActivity();

  window.openTravel(today);
  window.document.getElementById('travelStart').value = d2;
  window.document.getElementById('saveTravel').click();
  eq(window.document.getElementById('scoreEl').textContent, '—', 'Open-ended pause hides the baseline score');
  eq(window.parseFullCsvBackup(window.buildFullCsvBackup().text).travelPauses[0].end, null, 'An open-ended pause round-trips through CSV');
  eq(window.countingDaysBetween(today, window.addDaysToKey(today, 30)), 0, 'An open pause removes future days from projected gains');
  window.openTravel(today);
  window.document.querySelector('[data-action="resume-travel"]').click();
  eq(window.buildSnapshot().data.travelPauses[0].end, d2, 'Resume today leaves yesterday paused');
  eq(window.pauseOn(today), null, 'Today counts immediately after resuming');

  const concurrentTrip = structuredClone(tripSnapshot);
  concurrentTrip.data.travelPauses.push({ id:'next_trip', start:today, end:null });
  const editedTrip = structuredClone(tripSnapshot);
  editedTrip.data.travelPauses[0].end = tripStart;
  const mergedTrips = window.mergeConcurrentSnapshots(tripSnapshot, editedTrip, concurrentTrip).snapshot;
  eq(mergedTrips.data.travelPauses.length, 2, 'Sync keeps concurrent trip additions alongside edits');
  eq(mergedTrips.data.travelPauses.find(p => p.id === tripId).end, tripStart, 'Sync preserves the edited end date');
  window.applyValidatedState(window.validateBackupObject(mergedTrips));
  eq(window.isDayTracked(tripStart), false, 'Restoring a synced snapshot reapplies a one-day pause');
  eq(window.isDayTracked(d1), true, 'The day after a one-day pause counts normally');

  const peerTrip = structuredClone(tripSnapshot);
  peerTrip.data.travelPauses[0].start = d1;
  const extendedTrip = structuredClone(tripSnapshot);
  extendedTrip.data.travelPauses[0].end = today;
  const expectedTrip = { id:tripId, start:d1, end:today };
  const { snapshot:mergedDates, hadDirectConflict } = window.mergeConcurrentSnapshots(tripSnapshot, extendedTrip, peerTrip);
  eq(JSON.stringify(mergedDates.data.travelPauses[0]), JSON.stringify(expectedTrip), 'Sync combines edits to opposite bounds of a pause');
  eq(hadDirectConflict, false, 'Independent changes to a pause need no conflict warning');

  window.applyValidatedState(window.validateBackupObject(tripSnapshot));
  window.openTravel(tripStart);
  window.document.getElementById('travelEnd').value = today;
  window.applyValidatedState(window.validateBackupObject(peerTrip));
  window.renderAll();
  window.document.getElementById('saveTravel').click();
  eq(JSON.stringify(window.buildSnapshot().data.travelPauses[0]), JSON.stringify(expectedTrip),
    'Saving an open travel form retains a synced change to its untouched date');

  window.openTravel(d1);
  window.document.getElementById('travelEnd').value = '';
  const shortenedTrip = window.buildSnapshot();
  shortenedTrip.data.travelPauses[0].end = d2;
  window.applyValidatedState(window.validateBackupObject(shortenedTrip));
  window.document.getElementById('saveTravel').click();
  ok(window.document.getElementById('travelError').textContent.includes('changed elsewhere'),
    'An open travel form flags conflicting edits to the same date');
  eq(window.buildSnapshot().data.travelPauses[0].end, d2, 'A conflicting form save preserves the latest synced date');
  window.closeDialog('travelOverlay');

  const overlapBase = structuredClone(tripSnapshot);
  const overlapLocal = structuredClone(overlapBase);
  overlapLocal.data.travelPauses[0].end = today;
  const overlapRemote = structuredClone(overlapBase);
  overlapRemote.data.travelPauses.push({ id:'overlap_trip', start:d1, end:null });
  const overlappingTrips = window.mergeConcurrentSnapshots(overlapBase, overlapLocal, overlapRemote).snapshot;
  window.applyValidatedState(window.validateBackupObject(overlappingTrips));
  window.openTravel(tripStart);
  window.document.getElementById('travelEnd').value = d2;
  window.document.getElementById('saveTravel').click();
  eq(window.buildSnapshot().data.travelPauses.find(p => p.id === tripId).end, d2,
    'A synced overlap can be shortened even when some overlap remains');
  window.openTravel(tripStart);
  window.document.getElementById('travelEnd').value = today;
  window.document.getElementById('saveTravel').click();
  ok(window.document.getElementById('travelError').textContent.includes('overlap'), 'Expanding an existing overlap is rejected');
  eq(window.buildSnapshot().data.travelPauses.find(p => p.id === tripId).end, d2, 'A rejected overlap leaves the saved trip intact');
  window.closeDialog('travelOverlay');

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
    offline = false, now = null, localCopies = {}, markup = html, blockedStorage = false
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
        if(blockedStorage){
          Object.defineProperty(raceWindow, 'localStorage', {
            get(){ throw new raceWindow.DOMException('Storage is disabled', 'SecurityError'); }
          });
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

  const reconnect = createRaceBrowser(new IDBFactory(), null, { offline:true }).browser.window;
  await waitFor(() => reconnect.eval('startupNeedsConnection && !startupInFlight'));
  Object.defineProperty(reconnect.navigator, 'onLine', { configurable:true, value:true });
  installNetworkStubs(reconnect);
  reconnect.dispatchEvent(new reconnect.Event('online'));
  await waitFor(() => reconnect.eval('appReady'));
  eq(reconnect.document.getElementById('loadingScreen').style.display, 'none',
    'An untrusted device completes startup when the connection returns');
  reconnect.close();

  const retryFactory = new IDBFactory();
  const retryCloud = { revision:0, snapshot:null, updatedAt:null };
  const retryDevice = await openTestLedger(retryFactory, retryCloud);
  await appendTestEntry(retryDevice, 'keep_on_retry');
  await retryDevice.syncCloudNow();
  await appendTestEntry(retryDevice, 'delete_after_lost_response');
  const retryFetch = retryDevice.fetch;
  retryDevice.fetch = async (input, options) => {
    const response = await retryFetch(input, options);
    if(String(input) === '/api/sync' && options.method === 'PUT' && response.ok){
      throw new TypeError('Connection lost after committing the upload');
    }
    return response;
  };
  eq(await retryDevice.syncCloudNow(), false, 'A lost upload response leaves the operation pending');
  const pendingUpload = await retryDevice.idbGet('cloud-pending-v8');
  eq(retryCloud.receipts.get(pendingUpload?.operationId)?.cloudRevision, retryCloud.revision,
    'The exact accepted operation is saved on-device for retry');
  retryDevice.deleteEntry('delete_after_lost_response', false);
  await retryDevice.eval('persistInFlight');
  retryDevice.closeDeviceDatabase();
  retryDevice.close();

  const otherRetryDevice = await openTestLedger(new IDBFactory(), retryCloud);
  await appendTestEntry(otherRetryDevice, 'independent_cloud_entry');
  await otherRetryDevice.syncCloudNow();
  otherRetryDevice.close();
  const retryReopen = await openTestLedger(retryFactory, retryCloud);
  eq(cloudEntryIds(retryCloud), 'independent_cloud_entry,keep_on_retry',
    'Replaying a lost response after reload and a newer cloud write preserves the local deletion and remote addition');
  eq(retryReopen.buildSnapshot().data.entries.map(entry => entry.id).sort().join(','), cloudEntryIds(retryCloud),
    'The retried cloud and local ledgers agree');
  eq(await retryReopen.idbGet('cloud-pending-v8'), null, 'A confirmed pending upload is cleared after reconciliation');
  retryReopen.close();

  const delayedFactory = new IDBFactory();
  const delayedCloud = { revision:0, snapshot:null, updatedAt:null };
  const delayedTab = await openTestLedger(delayedFactory, delayedCloud);
  const currentTab = await openTestLedger(delayedFactory, delayedCloud);
  const remoteTab = await openTestLedger(new IDBFactory(), delayedCloud);
  await appendTestEntry(remoteTab, 'deleted_during_sync');
  await remoteTab.syncCloudNow();
  const delayedFetch = delayedTab.fetch;
  let pauseRefresh;
  const getServed = new Promise(resolve => { pauseRefresh = resolve; });
  delayedTab.fetch = async (input, options) => {
    const response = await delayedFetch(input, options);
    if(String(input) === '/api/sync' && !options.method){
      delayedTab.fetch = delayedFetch;
      pauseRefresh(pauseCall(delayedTab, 'refreshDurableState'));
    }
    return response;
  };
  const delayedSync = delayedTab.syncCloudNow();
  const delayedRefresh = await getServed;
  await delayedRefresh.started;
  await currentTab.syncCloudNow();
  currentTab.deleteEntry('deleted_during_sync', false);
  await currentTab.eval('persistInFlight');
  await currentTab.syncCloudNow();
  delayedRefresh.release();
  ok(await delayedSync, 'A delayed tab retries a stale download');
  eq(cloudEntryIds(delayedCloud), '', 'A delayed download cannot undo a confirmed deletion');
  [delayedTab, currentTab, remoteTab].forEach(tab => tab.close());

  const checkpointCloud = { revision:0, snapshot:null, updatedAt:null };
  const checkpointDevice = await openTestLedger(null, checkpointCloud);
  const checkpointPeer = await openTestLedger(new IDBFactory(), checkpointCloud);
  await appendTestEntry(checkpointPeer, 'downloaded_entry');
  await checkpointPeer.syncCloudNow();
  const setCheckpointItem = checkpointDevice.Storage.prototype.setItem;
  checkpointDevice.Storage.prototype.setItem = function(key, value){
    if(key === 'tally-cloud-base-v8') throw new checkpointDevice.DOMException('Quota exceeded', 'QuotaExceededError');
    return setCheckpointItem.call(this, key, value);
  };
  eq(await checkpointDevice.syncCloudNow(), false, 'A download fails visibly if its sync record cannot be saved');
  eq(checkpointDevice.buildSnapshot().data.entries.length, 0, 'A failed sync commit leaves the active ledger intact');
  checkpointDevice.Storage.prototype.setItem = function(key, value){
    if(key === 'tally-state-v8') throw new checkpointDevice.DOMException('Quota exceeded', 'QuotaExceededError');
    return setCheckpointItem.call(this, key, value);
  };
  ok(await checkpointDevice.syncCloudNow(), 'The fallback commit survives failure to refresh a separate ledger mirror');
  const checkpointCopies = Object.fromEntries(Object.entries(checkpointDevice.localStorage)
    .filter(([key]) => key !== 'tally-emergency-v8'));
  checkpointDevice.close();
  checkpointPeer.close();
  const checkpointReopen = await openTestLedger(null, checkpointCloud, { localCopies:checkpointCopies, offline:true });
  eq(checkpointReopen.buildSnapshot().data.entries[0]?.id, 'downloaded_entry',
    'Offline startup restores the committed ledger from the fallback sync record');
  checkpointReopen.deleteEntry('downloaded_entry', false);
  await checkpointReopen.eval('persistInFlight');
  const afterDeletion = Object.fromEntries(Object.entries(checkpointReopen.localStorage));
  checkpointReopen.close();
  const checkpointOnline = await openTestLedger(null, checkpointCloud, { localCopies:afterDeletion });
  eq(cloudEntryIds(checkpointCloud), '', 'A deletion after journal recovery survives reconnection');
  checkpointOnline.close();

  const outboxFactory = new IDBFactory();
  const outboxCloud = { revision:0, snapshot:null, updatedAt:null };
  const outboxDevice = await openTestLedger(outboxFactory, outboxCloud);
  await appendTestEntry(outboxDevice, 'outbox_entry');
  const outboxPut = outboxDevice.idbPut;
  outboxDevice.idbPut = (key, value, check) => key === 'cloud-pending-v8' && value
    ? Promise.reject(new outboxDevice.DOMException('Quota exceeded', 'QuotaExceededError'))
    : outboxPut(key, value, check);
  const outboxFetch = outboxDevice.fetch;
  outboxDevice.fetch = async (input, options) => {
    if(String(input) === '/api/sync' && options.method === 'PUT'){
      await outboxFetch(input, options);
      throw new TypeError('Lost upload response');
    }
    return outboxFetch(input, options);
  };
  eq(await outboxDevice.syncCloudNow(), false, 'An upload with a lost response stays pending in browser storage');
  const outboxCopies = Object.fromEntries(Object.entries(outboxDevice.localStorage));
  const outboxId = JSON.parse(outboxCopies['tally-cloud-pending-v8'] || 'null')?.operationId;
  ok(outboxCloud.receipts.has(outboxId), 'Browser storage retains the accepted operation after an IndexedDB quota error');
  const acceptedRevision = outboxCloud.revision;
  outboxDevice.close();
  const outboxReopen = await openTestLedger(outboxFactory, outboxCloud, { localCopies:outboxCopies });
  eq(outboxCloud.revision, acceptedRevision, 'Reload reuses the same operation ID without another cloud write');
  eq(outboxReopen.localStorage.getItem('tally-cloud-pending-v8'), null, 'The fallback operation clears after acknowledgement');
  outboxReopen.close();

  for(const validDatabaseCopy of [true, false]){
    const corruptCloud = { revision:0, snapshot:null, updatedAt:null };
    const corruptDevice = await openTestLedger(new IDBFactory(), corruptCloud);
    await appendTestEntry(corruptDevice, 'corrupt_mirror_entry');
    corruptDevice.localStorage.setItem('tally-cloud-pending-v8', '{');
    if(validDatabaseCopy){
      await corruptDevice.idbPut('cloud-pending-v8', {
        baseRevision:corruptCloud.revision, operationId:'healthy_pending_copy', snapshot:corruptDevice.buildSnapshot()
      });
    }
    ok(await corruptDevice.syncCloudNow(), 'A malformed retry mirror does not block sync');
    eq(cloudEntryIds(corruptCloud), 'corrupt_mirror_entry', 'Sync preserves the local entry with a malformed retry mirror');
    if(validDatabaseCopy) ok(corruptCloud.receipts.has('healthy_pending_copy'), 'Sync replays the valid IndexedDB copy');
    corruptDevice.close();
  }

  for(const choice of ['cloud', 'device', 'changed', 'reused revision']){
    const restoredCloud = { revision:0, snapshot:null, updatedAt:null };
    const rollbackDevice = await openTestLedger(new IDBFactory(), restoredCloud);
    await appendTestEntry(rollbackDevice, 'before_database_restore');
    await rollbackDevice.syncCloudNow();
    const older = structuredClone(restoredCloud);
    await appendTestEntry(rollbackDevice, 'after_database_restore');
    await rollbackDevice.syncCloudNow();
    Object.assign(restoredCloud, older);
    if(choice === 'reused revision'){
      restoredCloud.revision++;
      restoredCloud.snapshot.data.entries.push({ ...restoredCloud.snapshot.data.entries[0], id:'new_cloud_branch' });
    }
    eq(await rollbackDevice.syncCloudNow(), false, 'A database rollback pauses sync for an explicit decision');
    eq(rollbackDevice.buildSnapshot().data.entries.map(entry => entry.id).join(','),
      'before_database_restore,after_database_restore', 'Rollback detection leaves the original device branch in place');
    const keepCloud = choice === 'cloud' || choice === 'reused revision';
    const recoveryChoice = rollbackDevice.document.querySelector(
      `[data-action="resolve-cloud-rollback"][data-choice="${keepCloud ? 'cloud' : 'device'}"]`
    );
    ok(recoveryChoice && !recoveryChoice.closest('[hidden]'), 'The sync panel offers both rollback recovery choices');
    if(recoveryChoice){
      recoveryChoice.click();
      ok(rollbackDevice.document.getElementById('confirmOverlay').classList.contains('show'),
        'Choosing a rollback recovery opens a confirmation');
      if(choice === 'changed'){
        restoredCloud.revision++;
        restoredCloud.snapshot.data.entries[0].name = 'Changed while the prompt was open';
      }
      rollbackDevice.resolveConfirm(true);
      await waitFor(() => !rollbackDevice.eval('cloudRollbackResolving'));
      if(choice === 'changed'){
        eq(restoredCloud.snapshot.data.entries[0].name, 'Changed while the prompt was open',
          'A server change during confirmation prevents replacing either ledger');
        eq(rollbackDevice.buildSnapshot().data.entries.length, 2, 'An invalidated choice leaves the device ledger intact');
      }else{
        const expected = keepCloud ? cloudEntryIds(older) : 'after_database_restore,before_database_restore';
        eq(cloudEntryIds(restoredCloud), expected, 'Rollback recovery keeps the chosen cloud ledger');
        eq(rollbackDevice.buildSnapshot().data.entries.map(entry => entry.id).sort().join(','), expected,
          'The device and cloud agree after explicit rollback recovery');
        eq((await rollbackDevice.idbGet('recovery-v8')).data.entries.length, keepCloud ? 2 : 1,
          'Rollback recovery keeps a local copy of the ledger that was replaced');
      }
    }
    rollbackDevice.close();
  }

  const recoveryFactory = new IDBFactory();
  const damaged = await openTestLedger(recoveryFactory, null);
  await appendTestEntry(damaged, 'valid_previous_entry');
  const validPrevious = await damaged.idbGet('state-v8');
  await damaged.idbPut('previous-v8', validPrevious);
  await damaged.idbPut('state-v8', {
    ...validPrevious,
    revision:validPrevious.revision + 10,
    data:{ ...validPrevious.data, entries:null }
  });
  damaged.closeDeviceDatabase();
  damaged.close();
  const repaired = await openTestLedger(recoveryFactory, null, { offline:true });
  eq((await repaired.idbGet('state-v8')).data.entries[0].id, 'valid_previous_entry',
    'A healthy previous copy replaces a malformed primary with a higher revision');
  await appendTestEntry(repaired, 'after_recovery');
  eq((await repaired.idbGet('state-v8')).data.entries.length, 2, 'New changes persist after promoting a recovery snapshot');
  repaired.close();

  const unreadable = JSON.stringify({ ...validPrevious, data:{ ...validPrevious.data,
    entries:[{ ...validPrevious.data.entries[0], points:'invalid' }]
  } });
  const damagedCopies = { 'tally-state-v8':unreadable, 'tally-trusted-device-v1':'1' };
  const unreadableDevice = await openTestLedger(null, null, { offline:true, localCopies:damagedCopies });
  unreadableDevice.setHistoryRange('30');
  await unreadableDevice.eval('persistInFlight');
  eq(unreadableDevice.localStorage.getItem('tally-state-v8'), unreadable,
    'Changing the history range preserves an unreadable ledger');
  unreadableDevice.dispatchEvent(new unreadableDevice.Event('pagehide'));
  Object.defineProperty(unreadableDevice.document, 'hidden', { configurable:true, value:true });
  unreadableDevice.document.dispatchEvent(new unreadableDevice.Event('visibilitychange'));
  eq(unreadableDevice.localStorage.getItem('tally-emergency-v8'), null,
    'Closing or hiding an unreadable ledger does not publish an empty emergency snapshot');
  const unreadableReopen = await openTestLedger(null, null, {
    offline:true, localCopies:Object.fromEntries(Object.entries(unreadableDevice.localStorage))
  });
  ok(unreadableReopen.eval('unreadableLocalState'), 'Reopening still detects the unreadable ledger');
  eq(unreadableReopen.localStorage.getItem('tally-state-v8'), unreadable,
    'Reopening preserves the original unreadable bytes for recovery');
  unreadableDevice.close();
  unreadableReopen.close();

  const initialFactory = new IDBFactory();
  const initialCloud = { revision:0, snapshot:null, updatedAt:null };
  const initialTime = new Date(2026, 7, 1, 12).getTime();
  const initialDevice = await openTestLedger(initialFactory, initialCloud, { now:initialTime });
  const initialStart = initialDevice.todayKey();
  eq((await initialDevice.idbGet('state-v8'))?.settings.trackingStartDate, initialStart,
    'First sync commits the initial ledger alongside its cloud base');
  initialDevice.closeDeviceDatabase();
  initialDevice.close();
  const initialPeer = await openTestLedger(new IDBFactory(), initialCloud, { now:initialTime });
  await appendTestEntry(initialPeer, 'first_day_entry');
  await initialPeer.syncCloudNow();
  initialPeer.close();
  const initialReopen = await openTestLedger(initialFactory, initialCloud, { now:initialTime + 86400000 });
  eq(initialCloud.snapshot.settings.trackingStartDate, initialStart, 'Reopening preserves the original statistics start');
  eq(initialReopen.computeStats().daysTracked, 1, 'The peer’s entry stays in statistics after reopening');
  initialReopen.close();

  const restoreDevice = await openTestLedger(new IDBFactory(), null, {
    offline:true, localCopies:{ 'tally-trusted-device-v1':'1' }
  });
  restoreDevice.eval(`
    bonusTasks = Array.from({ length:1001 }, (_, order) => ({
      id:'local_bonus_' + order, name:'Bonus', points:1, order, sectionId:null
    }));
  `);
  const oversizedJson = JSON.stringify(restoreDevice.buildExport());
  const oversizedCsv = restoreDevice.buildFullCsvBackup().text;
  for(const format of ['JSON', 'CSV']){
    restoreDevice.eval('bonusTasks = []');
    await restoreDevice.persistData();
    restoreDevice.openBackup();
    let restore;
    if(format === 'JSON'){
      restoreDevice.document.getElementById('restoreText').value = oversizedJson;
      restore = restoreDevice.doRestore();
    }else{
      restoreDevice.pendingCsvBackupText = oversizedCsv;
      restore = restoreDevice.doCsvRestore();
    }
    restoreDevice.resolveConfirm(true);
    await restore;
    eq((await restoreDevice.idbGet('state-v8')).data.bonusTasks.length, 1001,
      `Complete ${format} backups restore locally above the cloud collection limit`);
  }
  restoreDevice.close();

  const startupCloud = { revision:0, snapshot:null, updatedAt:null };
  const { browser:startupBrowser } = createRaceBrowser(new IDBFactory(), startupCloud, {
    offline:true, localCopies:{ 'tally-state-v8':JSON.stringify(validPrevious), 'tally-trusted-device-v1':'1' }
  });
  const startupDevice = startupBrowser.window;
  let failPromotion;
  startupDevice.idbWriteState = () => new Promise((resolve, reject) => {
    failPromotion = () => reject(new Error('IndexedDB quota exceeded'));
  });
  await waitFor(() => failPromotion);
  Object.defineProperty(startupDevice.navigator, 'onLine', { configurable:true, value:true });
  installNetworkStubs(startupDevice, startupCloud);
  startupDevice.dispatchEvent(new startupDevice.Event('online'));
  failPromotion();
  await waitFor(() => !startupDevice.eval('startupInFlight'));
  ok(startupDevice.eval('appReady'), 'A startup database write failure leaves the fallback ledger ready');
  await waitFor(() => startupCloud.snapshot !== null);
  eq(cloudEntryIds(startupCloud), 'valid_previous_entry', 'Reconnecting syncs the fallback ledger after a startup write failure');
  await waitFor(() => !startupDevice.eval('cloudSyncInFlight'));

  const startupFetch = startupDevice.fetch;
  let stalledSignal;
  startupDevice.fetch = async (_input, { signal }) => {
    stalledSignal = signal;
    return { status:200, json:() => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once:true });
    }) };
  };
  const stalledBody = startupDevice.fetchWithTimeout('/api/account', {}, 15).then(
    () => 'completed', error => error.name
  );
  const bodyResult = await Promise.race([stalledBody, new Promise(resolve => setTimeout(() => resolve('pending'), 150))]);
  eq(bodyResult, 'AbortError', 'The network timeout covers a stalled JSON response body');
  ok(stalledSignal.aborted, 'The response-body timeout aborts the fetch signal');
  startupDevice.fetch = startupFetch;
  startupDevice.close();

  for(const operation of ['merge', 'restore']){
    const quotaDevice = await openTestLedger(new IDBFactory(), null);
    await appendTestEntry(quotaDevice, 'keep_on_save_failure');
    quotaDevice.openBackup();
    const backup = quotaDevice.buildExport();
    backup.data.entries[0].id = 'backup_entry';
    const clean = quotaDevice.validateBackupObject(backup);
    const storage = quotaDevice.Storage.prototype;
    const originalSetItem = storage.setItem;
    storage.setItem = function(key, value){
      if(key === 'tally-state-v8' || key === 'tally-emergency-v8'){
        throw new quotaDevice.DOMException('Quota exceeded', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, value);
    };
    quotaDevice.idbWriteState = async () => { throw new Error('IndexedDB quota exceeded'); };
    const importMethod = operation === 'merge' ? 'mergeValidatedBackup' : 'restoreValidatedBackup';
    const failedImport = quotaDevice[importMethod](clean, 'JSON backup');
    quotaDevice.resolveConfirm(true);
    await failedImport;
    ok(quotaDevice.document.getElementById('backupOverlay').classList.contains('show'),
      `Failed backup ${operation} leaves the dialog open`);
    ok(quotaDevice.document.getElementById('backupStatus').textContent.includes('could not save'),
      `Failed backup ${operation} reports the storage error`);
    eq(quotaDevice.buildSnapshot().data.entries.map(entry => entry.id).join(','), 'keep_on_save_failure',
      `Failed backup ${operation} leaves the active ledger intact`);
    const emergency = JSON.parse(quotaDevice.localStorage.getItem('tally-emergency-v8'));
    eq(emergency.data.entries[0].id, 'keep_on_save_failure', `Failed backup ${operation} keeps the emergency copy intact`);

    storage.setItem = originalSetItem;
    const retriedImport = quotaDevice[importMethod](clean, 'JSON backup');
    quotaDevice.resolveConfirm(true);
    await retriedImport;
    const savedImport = JSON.parse(quotaDevice.localStorage.getItem('tally-state-v8'));
    eq(savedImport.data.entries.map(entry => entry.id).sort().join(','),
      operation === 'merge' ? 'backup_entry,keep_on_save_failure' : 'backup_entry',
      `Backup ${operation} can be retried once storage is available`);
    quotaDevice.close();
  }

  const entryEditFactory = new IDBFactory();
  const entryEditor = await openTestLedger(entryEditFactory, null);
  const entryEditPeer = await openTestLedger(entryEditFactory, null, { offline:true });
  await appendTestEntry(entryEditor, 'concurrent_entry');
  await entryEditPeer.refreshDurableState();
  entryEditor.openEntryModal('concurrent_entry');
  entryEditor.document.getElementById('entryNameInput').value = 'Local name';
  await entryEditPeer.eval('entries[0].points = 12; persistData()');
  await entryEditor.refreshDurableState();
  entryEditor.saveEditedEntry();
  await entryEditor.eval('persistInFlight');
  let updatedEntry = (await entryEditor.idbGet('state-v8')).data.entries[0];
  eq(updatedEntry.name, 'Local name', 'The open entry editor saves the field the user changed');
  eq(updatedEntry.points, 12, 'The open entry editor retains an untouched field updated in another tab');

  entryEditor.openEntryModal('concurrent_entry');
  entryEditor.document.getElementById('entryNameInput').value = 'Another local name';
  await entryEditPeer.refreshDurableState();
  await entryEditPeer.eval('entries[0].name = "Peer name"; persistData()');
  await entryEditor.refreshDurableState();
  entryEditor.saveEditedEntry();
  ok(entryEditor.document.getElementById('entryError').textContent.includes('changed in another tab'),
    'The entry editor reports conflicting changes to the same field');
  eq(entryEditor.buildSnapshot().data.entries[0].name, 'Peer name', 'A stale form cannot overwrite a conflicting peer change');

  entryEditor.openEntryModal('concurrent_entry');
  entryEditor.document.getElementById('entryNameInput').value = 'Name saved during race';
  await entryEditPeer.eval('entries[0].points = 21; persistData()');
  entryEditor.saveEditedEntry();
  await entryEditor.eval('persistInFlight');
  updatedEntry = (await entryEditor.idbGet('state-v8')).data.entries[0];
  eq(updatedEntry.name, 'Name saved during race', 'A racing IndexedDB save retains the local field edit');
  eq(updatedEntry.points, 21, 'A racing IndexedDB save retains the independent peer field edit');

  await entryEditPeer.refreshDurableState();
  entryEditor.deleteEntry('concurrent_entry', true);
  await entryEditor.eval('persistInFlight');
  await entryEditPeer.eval('entries[0].points = 24; persistData()');
  await entryEditor.refreshDurableState();
  entryEditor.undoFromToast();
  await appendTestEntry(entryEditor, 'entry_after_undo');
  const afterUndo = (await entryEditor.idbGet('state-v8')).data.entries;
  eq(afterUndo.filter(entry => entry.id === 'concurrent_entry').length, 1, 'Undo leaves one copy of the entry recovered by sync');
  eq(afterUndo.find(entry => entry.id === 'concurrent_entry')?.points, 24, 'Undo preserves the peer’s edit');
  ok(afterUndo.some(entry => entry.id === 'entry_after_undo'), 'New entries still save after Undo');

  await entryEditor.eval("dailyBonuses.push({id:'daily_rule',name:'Daily rule',points:5,description:''}); persistData()");
  await entryEditPeer.refreshDurableState();
  for(const refreshEditor of [true, false]){
    entryEditor.openDailyBonusModal('daily_rule');
    const description = refreshEditor ? 'Saved after tab refresh' : 'Saved during tab race';
    const points = refreshEditor ? 20 : 35;
    entryEditor.document.getElementById('dailyBonusDescription').value = description;
    await entryEditPeer.eval(`dailyBonuses[0].points = ${points}; persistData()`);
    if(refreshEditor) await entryEditor.refreshDurableState();
    entryEditor.saveDailyBonus();
    await entryEditor.eval('persistInFlight');
    const dailyRule = (await entryEditor.idbGet('state-v8')).data.dailyBonuses[0];
    eq(dailyRule.description, description, 'The daily-bonus editor saves the changed description');
    eq(dailyRule.points, points, 'The daily-bonus editor preserves the peer’s points');
    await entryEditPeer.refreshDurableState();
  }

  await entryEditor.eval(`
    taskSections.push({id:'exercise',name:'Exercise',kind:'habit',order:0});
    habits.push({id:'walk',name:'Walk',type:'good',points:5,streak:0,lastDate:null,order:0,sectionId:'exercise'});
    persistData();
  `);
  await entryEditPeer.refreshDurableState();
  entryEditor.openHabitModal('good', 'walk');
  entryEditor.document.getElementById('habitName').value = 'Jog';
  await entryEditPeer.eval('habits[0].points = 20; taskSections = []; habits[0].sectionId = null; persistData()');
  await entryEditor.refreshDurableState();
  entryEditor.saveHabit();
  await entryEditor.eval('persistInFlight');
  const updatedHabit = (await entryEditor.idbGet('state-v8')).data.habits[0];
  eq(updatedHabit.name, 'Jog', 'The open habit editor saves the field the user changed');
  eq(updatedHabit.points, 20, 'The open habit editor keeps a peer change to an untouched field');
  eq(updatedHabit.sectionId, null, 'The open habit editor keeps the peer’s section deletion');

  entryEditor.openHabitModal('good', 'walk');
  entryEditor.document.getElementById('habitPoints').value = '25';
  await entryEditPeer.refreshDurableState();
  await entryEditPeer.eval('habits[0].points = 30; persistData()');
  await entryEditor.refreshDurableState();
  entryEditor.saveHabit();
  ok(entryEditor.document.getElementById('habitError').textContent.includes('changed in another tab'),
    'The habit editor reports competing changes to the same field');
  eq(entryEditor.buildSnapshot().data.habits[0].points, 30, 'A conflicting habit form leaves the saved value intact');
  entryEditor.close();
  entryEditPeer.close();

  const csvDevice = await openTestLedger(null, null, { offline:true, localCopies:{ 'tally-trusted-device-v1':'1' } });
  const emptyCsv = csvDevice.buildFullCsvBackup().text;
  csvDevice.openBackup();
  const csvInput = csvDevice.document.getElementById('csvRestoreFileInput');
  let finishOldCsvRead;
  const oldFileRead = new Promise(resolve => { finishOldCsvRead = resolve; });
  const oldCsvFile = { size:emptyCsv.length, text:() => oldFileRead };
  const newCsvFile = { size:csv.length, text:async () => csv };
  function chooseCsv(file){
    Object.defineProperty(csvInput, 'files', { configurable:true, value:[file] });
    csvInput.dispatchEvent(new csvDevice.Event('change'));
  }
  chooseCsv(oldCsvFile);
  chooseCsv(newCsvFile);
  await waitFor(() => !csvDevice.document.getElementById('restoreCsvBtn').disabled);
  finishOldCsvRead(emptyCsv);
  await oldFileRead;
  const restoreCsv = csvDevice.doCsvRestore();
  csvDevice.resolveConfirm(true);
  await restoreCsv;
  eq(csvDevice.buildSnapshot().data.entries.map(entry => entry.id).join(','), 'entry_a,entry_b',
    'Restore uses the selected CSV after an earlier file finishes reading late');
  csvDevice.close();

  const backupDevice = await openTestLedger(new IDBFactory(), null, { offline:true, localCopies:{ 'tally-trusted-device-v1':'1' } });
  backupDevice.openBackup();
  backupDevice.eval(`
    {
      const date = addDaysToKey(todayKey(), -1);
      entries = Array.from({length:90000}, (_, index) => ({
        id:'long_ledger_' + index, date, name:'Walk', type:'good', points:2, ts:1
      }));
    }
  `);
  const largeJson = JSON.stringify(backupDevice.buildExport(), null, 2);
  const largeCsv = backupDevice.buildFullCsvBackup().text;
  backupDevice.eval('entries = []');
  for(const [inputId, text, ready] of [
    ['restoreFileInput', largeJson, () => backupDevice.document.getElementById('restoreText').value.length > 0],
    ['csvRestoreFileInput', largeCsv, () => !backupDevice.document.getElementById('restoreCsvBtn').disabled]
  ]){
    const size = Buffer.byteLength(text);
    ok(size > 10 * 1024 * 1024, `${inputId} fixture exceeds the old file limit`);
    const input = backupDevice.document.getElementById(inputId);
    Object.defineProperty(input, 'files', { value:[{ size, text:async () => text }] });
    input.dispatchEvent(new backupDevice.Event('change'));
    await waitFor(ready);
    ok(backupDevice.document.getElementById('backupStatus').textContent.includes('90000 logged entries'),
      `${inputId} accepts the complete backup`);
  }
  const restoreLargeBackup = backupDevice.doCsvRestore();
  backupDevice.resolveConfirm(true);
  await restoreLargeBackup;
  eq((await backupDevice.idbGet('state-v8')).data.entries.length, 90000, 'A large CSV restore writes the full ledger');
  backupDevice.close();

  const offlineTrust = { offline:true, localCopies:{ 'tally-trusted-device-v1':'1' } };
  for(const format of ['JSON', 'CSV']){
    const factory = new IDBFactory();
    const device = await openTestLedger(factory, null, offlineTrust);
    await appendTestEntry(device, 'original_entry');
    const previousRevision = device.buildSnapshot().revision;
    device.openBackup();
    let restoring;
    if(format === 'JSON'){
      const backup = device.buildExport();
      backup.revision = Number.MAX_SAFE_INTEGER;
      backup.data.entries[0].id = 'restored_entry';
      device.document.getElementById('restoreText').value = JSON.stringify(backup);
      restoring = device.doRestore();
    }else{
      device.pendingCsvBackupText = device.buildFullCsvBackup().text
        .replace(/(\r\n"\d+","meta",")\d+/, (_, prefix) => prefix + Number.MAX_SAFE_INTEGER)
        .replace('"original_entry"', '"restored_entry"');
      restoring = device.doCsvRestore();
    }
    device.resolveConfirm(true);
    await restoring;
    eq((await device.idbGet('state-v8')).revision, previousRevision + 1, `${format} restore advances the local revision`);
    device.closeDeviceDatabase();
    device.close();
    const reopened = await openTestLedger(factory, null, offlineTrust);
    eq(reopened.buildSnapshot().data.entries[0]?.id, 'restored_entry', `${format} restore with a high source revision survives reopen`);
    reopened.closeDeviceDatabase();
    reopened.close();
  }

  const settingsDevice = await openTestLedger(new IDBFactory(), null, { offline:true, localCopies:{ 'tally-trusted-device-v1':'1' } });
  settingsDevice.openSettings();
  const baseInput = settingsDevice.document.getElementById('baseInput');
  const thresholdInput = settingsDevice.document.getElementById('thresholdInput');
  baseInput.value = '';
  settingsDevice.saveSettings();
  eq(settingsDevice.buildSnapshot().settings.dailyBase, 100, 'Leaving the daily base blank preserves its prior value');
  baseInput.value = '0';
  thresholdInput.value = '';
  settingsDevice.saveSettings();
  eq(settingsDevice.buildSnapshot().settings.successThreshold, 80, 'Leaving the threshold blank preserves its prior value');
  thresholdInput.value = '0';
  settingsDevice.saveSettings();
  await settingsDevice.eval('persistInFlight');
  eq((await settingsDevice.idbGet('state-v8')).settings.successThreshold, 0, 'The scoring form still accepts an explicit zero');
  const customCadence = settingsDevice.buildExport();
  customCadence.settings.backupReminderDays = 42;
  settingsDevice.applyValidatedState(settingsDevice.validateBackupObject(customCadence, false));
  settingsDevice.openSettings();
  const reminderInput = settingsDevice.document.getElementById('reminderInput');
  eq(reminderInput.value, '42', 'Settings displays the valid imported custom reminder cadence');
  baseInput.value = '10';
  settingsDevice.saveSettings();
  await settingsDevice.eval('persistInFlight');
  eq((await settingsDevice.idbGet('state-v8')).settings.backupReminderDays, 42, 'Saving an unrelated setting preserves the custom reminder cadence');
  settingsDevice.openSettings();
  reminderInput.value = '0';
  settingsDevice.saveSettings();
  await settingsDevice.eval('persistInFlight');
  eq((await settingsDevice.idbGet('state-v8')).settings.backupReminderDays, 0, 'An explicit reminder change still overrides the imported cadence');
  settingsDevice.close();

  const historicalDevice = await openTestLedger(new IDBFactory(), null, {
    offline:true, now:Date.UTC(1970, 0, 3, 12), localCopies:{ 'tally-trusted-device-v1':'1' }
  });
  historicalDevice.openSettings();
  historicalDevice.document.getElementById('startDateInput').value = '1969-12-30';
  historicalDevice.saveSettings();
  await historicalDevice.eval('persistInFlight');
  historicalDevice.openNewEntryModal('1969-12-31');
  historicalDevice.document.getElementById('entryNameInput').value = 'Early ledger entry';
  historicalDevice.document.getElementById('entryPointsInput').value = '5';
  historicalDevice.saveEditedEntry();
  await appendTestEntry(historicalDevice, 'present_day_entry');
  historicalDevice.toggleDayCompletion('1969-12-30');
  await historicalDevice.eval('persistInFlight');
  const historicalLedger = (await historicalDevice.idbGet('state-v8')).data;
  eq(historicalLedger.entries.find(entry => entry.name === 'Early ledger entry')?.date, '1969-12-31',
    'An entry dated before the Unix epoch saves with the chosen ledger date');
  ok(historicalLedger.entries.some(entry => entry.id === 'present_day_entry'), 'A current entry saves after a pre-1970 backfill');
  eq(historicalLedger.completedDays[0]?.date, '1969-12-30', 'A pre-1970 completion mark also saves');

  const imported = historicalDevice.buildExport();
  imported.data.completedDays[0].id = 'imported_completion_id';
  imported.data.entries.push({ ...imported.data.entries[0], id:'unrelated_import' });
  const mergeBackup = historicalDevice.mergeValidatedBackup(historicalDevice.validateBackupObject(imported), 'JSON backup');
  historicalDevice.resolveConfirm(true);
  await mergeBackup;
  const mergedBackup = (await historicalDevice.idbGet('state-v8')).data;
  eq(mergedBackup.completedDays.map(day => day.id).join(','), historicalLedger.completedDays[0]?.id,
    'Backup merge keeps the existing completion mark when another ID shares its date');
  ok(mergedBackup.entries.some(entry => entry.id === 'unrelated_import'), 'Duplicate completion dates do not block unrelated backup entries');
  historicalDevice.close();

  const remindersCloud = { revision:0, snapshot:null, updatedAt:null };
  const remindersFactory = new IDBFactory();
  const remindersDevice = await openTestLedger(remindersFactory, remindersCloud);
  const remindersPeer = await openTestLedger(new IDBFactory(), remindersCloud);
  const initialReminderRevision = remindersCloud.revision;
  remindersDevice.openSettings();
  remindersDevice.document.getElementById('reminderInput').value = '0';
  remindersDevice.saveSettings();
  await remindersDevice.eval('persistInFlight');
  await remindersDevice.syncCloudNow();
  eq(remindersCloud.revision, initialReminderRevision, 'Changing only the reminder cadence does not upload a cloud revision');
  await appendTestEntry(remindersDevice, 'entry_with_reminders_off');
  await remindersDevice.syncCloudNow();
  await remindersPeer.syncCloudNow();
  eq(remindersPeer.buildSnapshot().settings.backupReminderDays, 7, 'Cloud changes leave the receiving device’s reminder cadence intact');
  eq(remindersCloud.snapshot.settings.backupReminderDays, 7, 'A cloud upload uses the default cadence required by the snapshot schema');
  await appendTestEntry(remindersPeer, 'entry_with_reminders_on');
  await remindersPeer.syncCloudNow();
  remindersDevice.closeDeviceDatabase();
  remindersDevice.close();
  const remindersReopen = await openTestLedger(remindersFactory, remindersCloud);
  eq(remindersReopen.buildSnapshot().settings.backupReminderDays, 0, 'The disabled cadence persists through reload and incoming cloud changes');
  ok(remindersReopen.buildSnapshot().data.entries.some(entry => entry.id === 'entry_with_reminders_on'),
    'The device with reminders off still receives new entries from the other device');
  remindersReopen.close();
  remindersPeer.close();

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

  await conflictDevice.eval("entries.find(entry => entry.id === 'from_remote').name = 'Device edit'; persistData()");
  conflictCloud.snapshot.data.entries.find(entry => entry.id === 'from_remote').name = 'Cloud edit';
  conflictCloud.snapshot.revision += 100;
  conflictCloud.revision++;
  ok(await conflictDevice.syncCloudNow(), 'A direct conflict keeps syncing after recovery is saved');
  eq(conflictCloud.snapshot.data.entries.find(entry => entry.id === 'from_remote').name, 'Device edit',
    'A direct conflict keeps the local edit in the active ledger');
  eq((await conflictDevice.idbGet('recovery-v8')).data.entries.find(entry => entry.id === 'from_remote').name, 'Cloud edit',
    'A direct conflict keeps the losing cloud edit in device recovery');

  await conflictDevice.idbPut('recovery-v8', null);
  conflictDevice.dismissStorageBanner();
  conflictCloud.snapshot.data.entries.find(entry => entry.id === 'from_remote').name = 'Incoming during commit';
  conflictCloud.snapshot.revision = Number.MAX_SAFE_INTEGER;
  conflictCloud.revision++;
  const writeTransaction = conflictDevice.idbWriteTransaction;
  let transactionCompleted = false;
  let editedDuringTransaction = false;
  conflictDevice.idbWriteTransaction = (keys, update) => {
    conflictDevice.idbWriteTransaction = writeTransaction;
    return writeTransaction(keys, (records, store) => {
      const result = update(records, store);
      if(result) setImmediate(() => {
        editedDuringTransaction = !transactionCompleted;
        conflictDevice.eval("entries.find(entry => entry.id === 'from_remote').name = 'Edited during commit'; persistData()");
      });
      return result;
    }).finally(() => { transactionCompleted = true; });
  };
  ok(await conflictDevice.syncCloudNow(), 'Sync completes after a local edit during its IndexedDB commit');
  ok(editedDuringTransaction, 'The local edit arrives while the cloud transaction is in flight');
  eq(conflictCloud.snapshot.data.entries.find(entry => entry.id === 'from_remote').name, 'Edited during commit',
    'The late local edit reaches the cloud');
  eq((await conflictDevice.idbGet('recovery-v8'))?.data.entries.find(entry => entry.id === 'from_remote').name, 'Incoming during commit',
    'The late conflict keeps the competing cloud edit in device recovery');
  ok(conflictDevice.document.getElementById('storageBanner').classList.contains('show'), 'The late conflict displays a recovery warning');

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

  const emergencyFactory = new IDBFactory();
  const emergencyCloud = { revision:0, snapshot:null, updatedAt:null };
  const emergencyDevice = await openTestLedger(emergencyFactory, emergencyCloud);
  await appendTestEntry(emergencyDevice, 'already_synced');
  await emergencyDevice.syncCloudNow();
  const emergency = emergencyDevice.buildSnapshot();
  emergency.revision++;
  emergency.data.entries.push({ ...emergency.data.entries[0], id:'interrupted_save' });
  emergencyDevice.writeEmergencyMirror(emergency);
  const emergencyClear = emergencyDevice.signOutAndClearDevice();
  emergencyDevice.resolveConfirm(true);
  await emergencyClear;
  ok(emergencyDevice.appReady, 'Sign-out stops while an emergency copy contains unsynced changes');
  const emergencyCopies = Object.fromEntries(Object.entries(emergencyDevice.localStorage));
  ok(emergencyCopies['tally-emergency-v8'], 'Sign-out preserves the interrupted save');
  emergencyDevice.closeDeviceDatabase();
  emergencyDevice.close();
  const emergencyReopen = await openTestLedger(emergencyFactory, emergencyCloud, { localCopies:emergencyCopies });
  eq(cloudEntryIds(emergencyCloud), 'already_synced,interrupted_save', 'Reopening syncs the preserved emergency copy');
  emergencyReopen.close();

  const indexedDbOnly = await openTestLedger(new IDBFactory(), null, { blockedStorage:true });
  await appendTestEntry(indexedDbOnly, 'indexed_db_only');
  const indexedDbClear = indexedDbOnly.signOutAndClearDevice();
  indexedDbOnly.resolveConfirm(true);
  await indexedDbClear;
  eq(indexedDbOnly.tallyDb, null, 'Sign-out removes the database when localStorage is blocked');
  eq(indexedDbOnly.document.querySelector('#loadingScreen button'), null, 'Unavailable localStorage does not leave a cleanup retry');
  indexedDbOnly.close();

  const lateEmergency = await openTestLedger(new IDBFactory(), null);
  await appendTestEntry(lateEmergency, 'before_logout');
  const lateEmergencyFetch = lateEmergency.fetch;
  lateEmergency.fetch = async (input, options) => {
    if(String(input) === '/api/auth/sign-out'){
      const snapshot = lateEmergency.buildSnapshot();
      snapshot.revision++;
      snapshot.data.entries.push({ ...snapshot.data.entries[0], id:'late_emergency_entry' });
      lateEmergency.writeEmergencyMirror(snapshot);
    }
    return lateEmergencyFetch(input, options);
  };
  const lateEmergencyClear = lateEmergency.signOutAndClearDevice();
  lateEmergency.resolveConfirm(true);
  await lateEmergencyClear;
  ok(lateEmergency.localStorage.getItem('tally-emergency-v8')?.includes('late_emergency_entry'),
    'Cleanup preserves an emergency copy written while sign-out was in flight');
  ok(await lateEmergency.idbGet('state-v8'), 'Cleanup keeps the database when a late emergency copy needs recovery');
  lateEmergency.close();

  const lostSignOutFactory = new IDBFactory();
  const lostSignOutDevice = await openTestLedger(lostSignOutFactory, null);
  await appendTestEntry(lostSignOutDevice, 'before_lost_sign_out');
  const originalSignOutFetch = lostSignOutDevice.fetch;
  let lostSignOutRequests = 0;
  lostSignOutDevice.fetch = async (input, options) => {
    if(String(input) === '/api/auth/sign-out' && ++lostSignOutRequests === 1){
      await originalSignOutFetch(input, options);
      throw new TypeError('Response lost after server sign-out');
    }
    return originalSignOutFetch(input, options);
  };
  const lostSignOut = lostSignOutDevice.signOutAndClearDevice();
  lostSignOutDevice.resolveConfirm(true);
  await lostSignOut;
  const lostSignOutScreen = lostSignOutDevice.document.getElementById('loadingScreen');
  eq(lostSignOutDevice.getComputedStyle(lostSignOutDevice.document.querySelector('.shell')).display, 'none',
    'The ledger stays covered when the sign-out response is lost');
  ok(!await lostSignOutDevice.trustedDeviceMarker(), 'An unconfirmed sign-out revokes offline trust');
  const lostSignOutReopen = createRaceBrowser(lostSignOutFactory, null, {
    offline:true, localCopies:Object.fromEntries(Object.entries(lostSignOutDevice.localStorage))
  }).browser.window;
  await waitFor(() => lostSignOutReopen.eval('startupNeedsConnection && !startupInFlight'));
  eq(lostSignOutReopen.buildSnapshot().data.entries.length, 0, 'An offline reopen cannot load the ledger after unconfirmed sign-out');
  lostSignOutReopen.closeDeviceDatabase();
  lostSignOutReopen.close();
  lostSignOutScreen.querySelector('button').click();
  await waitFor(() => lostSignOutDevice.localStorage.length === 0);
  eq(lostSignOutRequests, 2, 'Retrying an unconfirmed sign-out completes device cleanup');
  lostSignOutDevice.close();

  const cleanupDevice = await openTestLedger(new IDBFactory(), null);
  await appendTestEntry(cleanupDevice, 'before_cleanup_retry');
  const cleanupFetch = cleanupDevice.fetch;
  let signOutRequests = 0;
  cleanupDevice.fetch = (input, options) => {
    if(String(input) === '/api/auth/sign-out') signOutRequests++;
    return cleanupFetch(input, options);
  };
  const deleteDatabase = cleanupDevice.deleteDeviceDatabase;
  cleanupDevice.deleteDeviceDatabase = async () => {
    cleanupDevice.deleteDeviceDatabase = deleteDatabase;
    throw new Error('Delete failed');
  };
  const cleanupAttempt = cleanupDevice.signOutAndClearDevice();
  cleanupDevice.resolveConfirm(true);
  await cleanupAttempt;
  const cleanupScreen = cleanupDevice.document.getElementById('loadingScreen');
  eq(cleanupScreen.style.display, 'flex', 'The cleanup error keeps the signed-out screen visible');
  eq(cleanupDevice.getComputedStyle(cleanupDevice.document.querySelector('.shell')).display, 'none',
    'The ledger stays hidden after sign-out even when device cleanup fails');
  eq(cleanupDevice.localStorage.getItem('tally-trusted-device-v1'), null, 'Sign-out removes offline trust before cleanup succeeds');
  cleanupScreen.querySelector('button').click();
  await waitFor(() => cleanupDevice.localStorage.length === 0);
  eq(signOutRequests, 1, 'Retrying device cleanup works with the session already signed out');
  cleanupDevice.close();

  const blockedFactory = new IDBFactory();
  const blockedDevice = await openTestLedger(blockedFactory, null);
  const otherConnection = await new Promise((resolve, reject) => {
    const request = blockedFactory.open('tally-ledger', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const blockedAttempt = blockedDevice.signOutAndClearDevice();
  blockedDevice.resolveConfirm(true);
  const blockedScreen = blockedDevice.document.getElementById('loadingScreen');
  await waitFor(() => blockedScreen.textContent.includes('Close other Tally tabs'));
  eq(blockedDevice.getComputedStyle(blockedDevice.document.querySelector('.shell')).display, 'none',
    'A pending database deletion keeps the ledger hidden');
  otherConnection.close();
  await blockedAttempt;
  eq(blockedDevice.localStorage.length, 0, 'Closing the other connection lets device cleanup finish');
  blockedDevice.close();

  const rejectedUpload = await openTestLedger(new IDBFactory(), null);
  await appendTestEntry(rejectedUpload, 'rejected_upload');
  const originalUpload = rejectedUpload.fetch;
  rejectedUpload.fetch = (input, options) => String(input) === '/api/sync' && options.method === 'PUT'
    ? Promise.resolve(new Response('FUNCTION_PAYLOAD_TOO_LARGE', { status:413 }))
    : originalUpload(input, options);
  eq(await rejectedUpload.syncCloudNow(), false, 'A host-level 413 stops the upload cleanly');
  ok(rejectedUpload.document.getElementById('cloudStatusEl').textContent.includes('exceeds the cloud size limit'),
    'A non-JSON 413 reports the cloud size limit');
  eq(await rejectedUpload.readPendingCloudWrite(), null, 'A host-level 413 clears the rejected pending upload');
  eq((await rejectedUpload.idbGet('state-v8')).data.entries[0].id, 'rejected_upload',
    'A host-level 413 keeps the on-device ledger');
  rejectedUpload.close();

  const rejectedSession = await openTestLedger(new IDBFactory(), null);
  const authenticatedFetch = rejectedSession.fetch;
  rejectedSession.fetch = (input, options) => String(input) === '/api/sync'
    ? Promise.resolve(new Response(null, { status:401 }))
    : authenticatedFetch(input, options);
  eq(await rejectedSession.syncCloudNow(), false, 'A rejected session stops sync');
  eq(await rejectedSession.trustedDeviceMarker(), false, 'A rejected session revokes offline trust');
  eq(rejectedSession.appReady, false, 'A rejected session locks the active ledger');
  rejectedSession.close();

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

  const editFactory = new IDBFactory();
  const firstEditor = await openTestLedger(editFactory, null);
  await firstEditor.eval(`
    bonusTasks = [{ id:'shared_bonus', name:'Bonus', points:10, order:1000000, sectionId:null }];
    milestones = [{ id:'shared_milestone', name:'Milestone', days:1, points:10, description:'' }];
    persistData();
  `);
  const secondEditor = await openTestLedger(editFactory, null, { offline:true });
  firstEditor.openBonusModal('shared_bonus');
  firstEditor.openMilestoneModal('shared_milestone');
  await secondEditor.eval('bonusTasks[0].points = 30; milestones[0].points = 40; persistData()');
  await firstEditor.refreshDurableState();
  firstEditor.document.getElementById('bonusName').value = 'Renamed bonus';
  firstEditor.document.getElementById('milestoneName').value = 'Renamed milestone';
  firstEditor.saveMilestone();
  firstEditor.saveBonus();
  await firstEditor.eval('persistInFlight');
  const edited = await firstEditor.idbGet('state-v8');
  eq(edited.data.bonusTasks[0].points, 30, 'Renaming a bonus preserves the peer’s points edit');
  eq(edited.data.milestones[0].points, 40, 'Renaming a milestone preserves the peer’s points edit');
  firstEditor.openBonusModal();
  firstEditor.document.getElementById('bonusName').value = 'New bonus';
  firstEditor.document.getElementById('bonusPoints').value = '10';
  firstEditor.saveBonus();
  await firstEditor.eval('persistInFlight');
  eq((await firstEditor.idbGet('state-v8')).data.bonusTasks.map(item => item.order).join(','), '0,1',
    'Appending after the highest supported order preserves both tasks');
  await secondEditor.refreshDurableState();
  await firstEditor.eval("bonusTasks[0].name = 'First edit'; persistData()");
  await secondEditor.eval("bonusTasks[0].name = 'Second edit'; persistData()");
  await secondEditor.persistSettings();
  eq((await secondEditor.idbGet('recovery-v8')).data.bonusTasks[0].name, 'First edit',
    'The competing edit stays in recovery after the previous copy rotates');
  firstEditor.close();
  secondEditor.close();

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
      setTravelPauses([{id:'cloud_trip',start:addDaysToKey(todayKey(),10),end:null}]);
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
  eq(cloudReader.browser.window.buildSnapshot().data.travelPauses[0].id, 'cloud_trip', 'Another device receives a scheduled pause after concurrent sync');
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
  eq(offlineReload.browser.window.buildSnapshot().data.travelPauses[0].id, 'cloud_trip', 'Offline reopen preserves synced travel dates');
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
  reloadedWindow.localStorage.setItem(reloadedWindow.eval('CLOUD_BASE_FALLBACK_KEY'), JSON.stringify({
    cloudRevision:8, localRevision:updatedSnapshot.revision, snapshot:updatedSnapshot
  }));
  await reloadedWindow.eval("entries = entries.filter(entry => entry.id !== 'updated_entry'); persistData()");
  await reloadedWindow.reconcileCloudState({ cloudRevision:8, snapshot:updatedSnapshot });
  eq(reloadedWindow.eval("entries.some(entry => entry.id === 'updated_entry')"), false,
    'Returning to IndexedDB preserves local deletions made against a newer fallback sync base');
  reloadedWindow.closeDeviceDatabase();
  reloadedWindow.close();

  const stagedCopies = {
    'tally-state-v7':JSON.stringify({ ...updatedSnapshot, schemaVersion:7 }),
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
  const fallbackKey = fallbackWindow.eval('FALLBACK_STATE_KEY');
  fallbackWindow.close();
  const fallbackReload = createRaceBrowser(null, null, {
    offline:true,
    localCopies:{
      ...stagedCopies,
      'tally-state-v2':JSON.stringify(staleSnapshot),
      'tally-state-v7':JSON.stringify(staleSnapshot),
      [fallbackKey]:protectedMirror
    }
  });
  const fallbackReloadWindow = fallbackReload.browser.window;
  await waitFor(() => fallbackReloadWindow.eval('appReady'));
  eq(JSON.stringify(fallbackReloadWindow.buildSnapshot().data), JSON.stringify(updatedSnapshot.data),
    'An older cached app writing to the legacy fallback key cannot replace current entries or daily rules');
  fallbackReloadWindow.clearTallyLocalStorage();
  eq(fallbackReloadWindow.localStorage.length, 0, 'Sign-out cleanup clears both generations of browser storage');
  fallbackReloadWindow.close();

  const v7Ledger = structuredClone(existingCloudSnapshot);
  v7Ledger.revision = 20;
  v7Ledger.data.entries.push({ id:'both_edited', date:cloudDate, name:'Shared entry', type:'good', points:1, ts:3 });
  v7Ledger.data.entries.push({ id:'v7_deleted', date:cloudDate, name:'To remove in v7', type:'good', points:5, ts:4 });
  const v7LateSave = structuredClone(v7Ledger);
  v7LateSave.revision += 3;
  v7LateSave.data.entries[0].points = 25;
  v7LateSave.data.entries.find(entry => entry.id === 'both_edited').points = 11;
  v7LateSave.data.entries = v7LateSave.data.entries.filter(entry => entry.id !== 'v7_deleted');
  v7LateSave.data.entries.push({ id:'late_v7', date:cloudDate, name:'Late save from v7', type:'good', points:4, ts:5 });
  const v7Storage = { 'tally-state-v7':JSON.stringify(v7Ledger), 'tally-trusted-device-v1':'1' };
  const mixedVersionFactory = new IDBFactory();
  const firstV8 = await openTestLedger(mixedVersionFactory, null, { offline:true, localCopies:v7Storage });
  await firstV8.eval("entries.find(entry => entry.id === 'cloud_only').points = 32; entries.find(entry => entry.id === 'both_edited').points = 12; setTravelPauses([{id:'keep_trip',start:todayKey(),end:null}]); persistData()");
  await firstV8.idbPut('state-v7', v7LateSave);
  await firstV8.idbPut('previous-v7', { ...v7LateSave, revision:v7LateSave.revision - 1 });
  firstV8.closeDeviceDatabase();
  firstV8.close();

  const trustedCopies = { 'tally-trusted-device-v1':'1' };
  for(const factory of [new IDBFactory(), null]){
    const migrationCloud = { revision:0, snapshot:null, updatedAt:null };
    const device = await openTestLedger(factory, migrationCloud, { localCopies:v7Storage });
    if(factory) await device.idbPut('state-v7', v7LateSave);
    else device.localStorage.setItem('tally-state-v7', JSON.stringify(v7LateSave));
    const signingOut = device.signOutAndClearDevice();
    device.resolveConfirm(true);
    await signingOut;
    eq(cloudEntryIds(migrationCloud), 'both_edited,cloud_only,late_v7,legacy_entry',
      'Sign-out syncs late v7 additions and deletions before clearing device storage');
    eq(migrationCloud.snapshot.data.entries.find(entry => entry.id === 'legacy_entry')?.points, 25,
      'Sign-out syncs a late v7 edit to an existing entry');
    eq(device.localStorage.length, 0, 'Sign-out removes the local migration checkpoint after syncing');
    device.close();
  }

  const lateSignOutFactory = new IDBFactory();
  const lateSignOut = await openTestLedger(lateSignOutFactory, null, { localCopies:v7Storage });
  const originalFetch = lateSignOut.fetch;
  lateSignOut.fetch = async (input, options) => {
    if(String(input) === '/api/auth/sign-out') await lateSignOut.idbPut('state-v7', v7LateSave);
    return originalFetch(input, options);
  };
  const signingOut = lateSignOut.signOutAndClearDevice();
  lateSignOut.resolveConfirm(true);
  await signingOut;
  eq((await lateSignOut.idbGet('state-v7')).revision, v7LateSave.revision,
    'A newer v7 save arriving after the final sync prevents device deletion');
  lateSignOut.closeDeviceDatabase();
  lateSignOut.close();

  const initialFallbackV8 = await openTestLedger(null, null, { offline:true, localCopies:v7Storage });
  await initialFallbackV8.eval("entries.find(entry => entry.id === 'cloud_only').points = 32; persistData()");
  const fallbackCopies = Object.fromEntries(Object.keys(initialFallbackV8.localStorage).map(key =>
    [key, initialFallbackV8.localStorage.getItem(key)]));
  initialFallbackV8.close();
  const recoveredFallbackV8 = await openTestLedger(null, null, {
    offline:true,
    localCopies:{
      ...fallbackCopies,
      'tally-state-v7':JSON.stringify(v7LateSave),
      'tally-state-previous-v7':JSON.stringify({ ...v7LateSave, revision:v7LateSave.revision - 1 })
    }
  });
  const recoveredFallbackEntries = recoveredFallbackV8.buildSnapshot().data.entries;
  eq(recoveredFallbackEntries.map(entry => entry.id).sort().join(','), 'both_edited,cloud_only,late_v7,legacy_entry',
    'Browser-storage migration recovers v7 additions and deletions after the old previous copy rotates');
  eq(recoveredFallbackEntries.find(entry => entry.id === 'legacy_entry')?.points, 25,
    'Browser-storage migration recovers a late v7 edit using the saved checkpoint');
  eq(recoveredFallbackEntries.find(entry => entry.id === 'cloud_only')?.points, 32,
    'Browser-storage migration preserves an independent v8 edit');
  recoveredFallbackV8.close();

  const recoveredV8 = await openTestLedger(mixedVersionFactory, null, { offline:true, localCopies:trustedCopies });
  const recoveredState = recoveredV8.buildSnapshot();
  eq(recoveredState.data.entries.map(entry => entry.id).sort().join(','), 'both_edited,cloud_only,late_v7,legacy_entry',
    'Reload merges late v7 additions and deletions even after the v7 previous copy rotates');
  eq(recoveredState.data.entries.find(entry => entry.id === 'legacy_entry')?.points, 25,
    'Reload recovers a v7 edit to an existing entry when the common ledger is known');
  eq(recoveredState.data.entries.find(entry => entry.id === 'cloud_only')?.points, 32, 'Late v7 recovery preserves an independent v8 edit');
  eq(recoveredState.data.entries.find(entry => entry.id === 'both_edited')?.points, 12, 'A conflicting v7 edit keeps the current v8 value');
  eq(recoveredState.data.travelPauses[0]?.id, 'keep_trip', 'Late v7 recovery preserves travel pauses');
  eq(recoveredV8.buildExport().migratedV7Revision, undefined, 'Migration metadata stays out of backups');
  await recoveredV8.eval("entries = entries.filter(entry => entry.id !== 'late_v7'); persistData()");
  recoveredV8.closeDeviceDatabase();
  recoveredV8.close();

  const restartedV8 = await openTestLedger(mixedVersionFactory, null, { offline:true, localCopies:trustedCopies });
  eq(restartedV8.buildSnapshot().data.entries.some(entry => entry.id === 'late_v7'), false,
    'Reload does not reimport a previously recovered v7 entry after its deletion');
  restartedV8.closeDeviceDatabase();
  restartedV8.close();

  const unmarkedV8 = { ...recoveredState, data:{ ...recoveredState.data, entries:updatedSnapshot.data.entries } };
  const fallbackV8 = await openTestLedger(null, null, {
    offline:true,
    localCopies:{ ...trustedCopies, [fallbackKey]:JSON.stringify(unmarkedV8), 'tally-state-v7':JSON.stringify(v7LateSave) }
  });
  eq(fallbackV8.buildSnapshot().data.entries.map(entry => entry.id).sort().join(','), 'both_edited,cloud_only,late_v7,legacy_entry,updated_entry',
    'An existing v8 browser-storage copy recovers independent v7 records without a migration checkpoint');
  eq(fallbackV8.buildSnapshot().data.entries.find(entry => entry.id === 'legacy_entry')?.points, unmarkedV8.data.entries[0].points,
    'Without confirmed ancestry, recovery keeps the current version of shared records');
  await fallbackV8.eval("entries = entries.filter(entry => entry.id !== 'late_v7'); persistData()");
  const fallbackAfterDelete = fallbackV8.localStorage.getItem(fallbackKey);
  fallbackV8.close();
  const fallbackAfterRestart = await openTestLedger(null, null, {
    offline:true,
    localCopies:{ ...trustedCopies, [fallbackKey]:fallbackAfterDelete, 'tally-state-v7':JSON.stringify(v7LateSave) }
  });
  eq(fallbackAfterRestart.buildSnapshot().data.entries.some(entry => entry.id === 'late_v7'), false,
    'The browser-storage checkpoint also prevents reimporting a deleted recovered entry');
  fallbackAfterRestart.close();

  // Exercise a deployment where older markup ends up with the current script.
  const legacyMarkup = html
    .replace(/id="dailyBonusList"/, 'id="legacyBonusList"')
    .replace(/id="dailyBonus(?:Name|Points|Description)"/g, '')
    .replace(/<div class="overlay" id="travelOverlay">[\s\S]*?(?=<!-- Automatic daily bonus modal -->)/, '');
  const legacyShell = createRaceBrowser(new IDBFactory(), null, { markup:legacyMarkup });
  await waitFor(() => legacyShell.browser.window.eval('appReady'));
  const legacyWindow = legacyShell.browser.window;
  legacyWindow.eval("setTravelPauses([{id:'active_trip',start:todayKey(),end:null}]); renderAll()");
  eq(legacyWindow.document.getElementById('scoreEl').textContent, '—', 'Older markup still displays active pauses');
  eq(legacyWindow.document.querySelector('#todayCompletionControl [data-action="open-travel"]'), null,
    'Older markup omits the edit action when it has no travel dialog');
  legacyWindow.document.querySelector('#todayView [data-action="open-travel"]').click();
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
        const body = route === clientPath.replace('.js', '.html') ? shellHtml : route;
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
  largeWindow.closeDayActivity();
  largeWindow.eval(`
    trackingStartDate = '1800-01-01';
    dailyBonuses = dailyBonuses.slice(0, 1);
    historyRangeDays = 'all';
    renderHistory();
  `);
  ok(largeWindow.document.querySelector('#historyChart .chart-score-line').getAttribute('d').length > 0,
    'All-history chart renders more than two centuries of tracked days');
  ok(largeWindow.document.querySelectorAll('#historyChart .chart-hit').length < 400,
    'A wide history keeps the number of interactive markers bounded');
  largeWindow.document.getElementById('historyDateInput').value = '1800-01-02';
  largeWindow.jumpToExactDate();
  eq(largeWindow.eval('selectedDayKey'), '1800-01-02', 'Exact date navigation works across the full chart range');
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

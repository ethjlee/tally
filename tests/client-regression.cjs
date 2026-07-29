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
      habits = [];
      bonusTasks = [];
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
  const csv = window.buildFullCsvBackup().text;
  const cleanCsv = window.parseFullCsvBackup(csv);
  eq(cleanCsv.entries.length, 2, 'CSV backup round-trip preserves entries');
  eq(cleanCsv.milestones.length, 1, 'CSV backup round-trip preserves milestones');

  window.eval(`backupReminderDays = 0`);
  const csvNoReminder = window.parseFullCsvBackup(window.buildFullCsvBackup().text);
  eq(csvNoReminder.backupReminderDays, 0, 'CSV backup preserves disabled reminder setting');
  window.eval(`backupReminderDays = 14`);
  const csvTwoWeeks = window.parseFullCsvBackup(window.buildFullCsvBackup().text);
  eq(csvTwoWeeks.backupReminderDays, 14, 'CSV backup preserves enabled reminder frequency');

  const legacyRows = window.parseCsvRows(window.buildFullCsvBackup().text);
  const reminderColumn = legacyRows[0].indexOf('backup_reminder_days');
  legacyRows.forEach(row => row.splice(reminderColumn, 1));
  legacyRows[1][legacyRows[0].indexOf('format_version')] = '2';
  const legacyCsv = legacyRows
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
    cloudA.browser.window.eval(`entries.push({id:'cloud_a',date:'${cloudDate}',name:'Cloud A',type:'good',points:1,ts:11});persistData()`),
    cloudB.browser.window.eval(`entries.push({id:'cloud_b',date:'${cloudDate}',name:'Cloud B',type:'good',points:2,ts:12});persistData()`)
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

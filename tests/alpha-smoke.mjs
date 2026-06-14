import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

let appCode = fs.readFileSync(new URL('../app.js', import.meta.url), 'utf8');
appCode = appCode.replace(/\/\* ══════════════════════════════════════════\n   BOOT[\s\S]*$/, '');

const suite = `
class FixedDate extends Date {
  constructor(...args) { super(...(args.length ? args : ['2026-06-14T12:00:00'])); }
  static now() { return new Date('2026-06-14T12:00:00').getTime(); }
}
Date = FixedDate;

function resetState(overrides = {}) {
  S = normalizeState({
    ...cloneData(DEFAULT_STATE),
    onboarded: true,
    tasks: [],
    events: [],
    intensities: {},
    taskLog: {},
    pinnedAllocations: {},
    manualOverrides: {},
    ...overrides,
  });
  invalidatePlan();
}

function makeTask(id, hours, dueOffset, extra = {}) {
  const deadline = ds(addDays(today(), dueOffset));
  return {
    id, type: 'task', name: id, priority: 'mandatory',
    deadline, date: deadline, hours, dist: 'even',
    repeat: 'none', logged: 0, color: '#111111', ...extra,
  };
}

function total(plan, taskId) {
  return roundHours(Object.values(plan.allocations[taskId] || {}).reduce((sum, hours) => sum + hours, 0));
}

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, status: 'PASS' });
  } catch (error) {
    results.push({ name, status: 'FAIL', error: error.message });
  }
}

test('legacy single-task pins migrate to occurrence overrides', () => {
  const state = normalizeState({
    tasks: [makeTask('legacy', 2, 1)],
    events: [],
    pinnedAllocations: { ['legacy|' + ds(today())]: 2 },
  });
  assert.equal(state.manualOverrides.legacy.pinned[ds(today())], 2);
});

test('skip exclusion preserves all hours when later capacity exists', () => {
  const task = makeTask('skip', 4, 1);
  resetState({ maxDailyHours: 4, tasks: [task] });
  const before = allocateSchedule();
  assert.equal(total(before, task.id), 4);
  S.manualOverrides[task.id] = { pinned: {}, excludedDates: [ds(today())] };
  invalidatePlan();
  const after = allocateSchedule();
  assert.equal(after.allocations[task.id][ds(today())] || 0, 0);
  assert.equal(after.allocations[task.id][task.deadline], 4);
  assert.equal(after.occurrenceResults[task.id].fullyAllocated, true);
});

test('deadline-day skip remains a visible shortfall', () => {
  const task = makeTask('deadline', 2, 0);
  resetState({ tasks: [task] });
  S.manualOverrides[task.id] = { pinned: {}, excludedDates: [ds(today())] };
  invalidatePlan();
  const plan = allocateSchedule();
  assert.equal(total(plan, task.id), 0);
  assert.equal(plan.conflicts[task.id].shortfall, 2);
});

test('repeating occurrence override does not bleed into the next occurrence', () => {
  const repeating = makeTask('repeat', 2, 0, {
    repeat: 'weekly',
    repeatEndType: 'count',
    repeatCount: 2,
  });
  resetState({ tasks: [repeating] });
  const firstId = 'repeat|occ|' + ds(today());
  const secondDate = ds(addDays(today(), 7));
  const secondId = 'repeat|occ|' + secondDate;
  S.manualOverrides[firstId] = { pinned: {}, excludedDates: [ds(today())] };
  invalidatePlan();
  const plan = allocateSchedule();
  assert.equal(plan.occurrenceResults[firstId].fullyAllocated, false);
  assert.equal(plan.occurrenceResults[secondId].fullyAllocated, true);
});

test('user-entered HTML is escaped before rendering', () => {
  assert.equal(escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.equal(safeColor('not-a-colour'), '#111111');
});

JSON.stringify(results);
`;

const element = {
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: { setProperty() {} },
  appendChild() {},
  append() {},
  remove() {},
  click() {},
  querySelector() { return element; },
  querySelectorAll() { return []; },
  value: '',
  textContent: '',
  innerHTML: '',
  dataset: {},
};

const context = {
  console,
  JSON,
  Math,
  Number,
  assert,
  setTimeout() {},
  requestAnimationFrame(fn) { if (typeof fn === 'function') fn(); },
  localStorage: { getItem() { return null; }, setItem() {} },
  document: {
    querySelectorAll() { return []; },
    querySelector() { return element; },
    getElementById() { return element; },
    createElement() { return { ...element, style: {}, dataset: {} }; },
    addEventListener() {},
    body: element,
  },
};

const results = JSON.parse(vm.runInNewContext(appCode + suite, context, { timeout: 10000 }));
for (const result of results) {
  console.log(`${result.status} ${result.name}${result.error ? ': ' + result.error : ''}`);
}
if (results.some(result => result.status !== 'PASS')) process.exitCode = 1;

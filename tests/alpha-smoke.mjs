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

function occurrenceTotal(plan, occurrenceId) {
  return roundHours(Object.values(plan.occurrenceAllocations[occurrenceId] || {})
    .reduce((sum, hours) => sum + hours, 0));
}

function withInteractionStubs(fn) {
  const oldRender = render;
  const oldSave = save;
  const oldToast = showToast;
  const oldSnapshot = snapshotForUndo;
  let toast = '';
  render = () => {};
  save = () => true;
  showToast = message => { toast = message; };
  snapshotForUndo = () => {};
  try {
    return fn(() => toast);
  } finally {
    render = oldRender;
    save = oldSave;
    showToast = oldToast;
    snapshotForUndo = oldSnapshot;
  }
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

test('current-day unchecked log cannot inflate a repeating occurrence', () => {
  const repeating = makeTask('pq', 10, 6, {
    repeat: 'weekly',
    repeatEndType: 'count',
    repeatCount: 2,
  });
  resetState({
    tasks: [repeating],
    taskLog: {
      ['pq|' + ds(today())]: { scheduled: 2, completed: 0, checked: false },
    },
  });
  const plan = allocateSchedule();
  const occurrenceId = 'pq|occ|' + repeating.deadline;
  const allocated = roundHours(Object.values(plan.occurrenceAllocations[occurrenceId] || {})
    .reduce((sum, hours) => sum + hours, 0));
  assert.equal(allocated, 10);
  assert.equal(plan.occurrenceResults[occurrenceId].shortfall, 0);
});

test('dragged weekly task with weekday events remains capped at requested hours', () => {
  const deadline = ds(addDays(today(), 7));
  const occurrenceId = 'pq-drag|occ|' + deadline;
  const repeating = makeTask('pq-drag', 10, 7, {
    repeat: 'weekly',
    repeatEndType: 'count',
    repeatCount: 2,
  });
  resetState({
    baseline: 8,
    maxDailyHours: 12,
    tasks: [repeating],
    events: [{
      id: 'fcs',
      type: 'event',
      name: 'FCS',
      date: ds(addDays(today(), 1)),
      start: '07:30',
      end: '17:00',
      repeat: 'weekdays',
      color: '#e85d26',
    }],
    taskLog: {
      ['pq-drag|' + ds(today())]: { scheduled: 2, completed: 0, checked: false },
    },
    manualOverrides: {
      [occurrenceId]: {
        pinned: {
          [ds(addDays(today(), 6))]: 4,
          [deadline]: 4,
        },
        excludedDates: [],
      },
    },
  });
  const plan = allocateSchedule();
  const allocation = plan.occurrenceAllocations[occurrenceId] || {};
  const allocated = roundHours(Object.values(allocation).reduce((sum, hours) => sum + hours, 0));
  assert.equal(allocated, 10, JSON.stringify({
    allocation,
    result: plan.occurrenceResults[occurrenceId],
    free: plan.dailyFree,
  }));
  assert.equal(allocation[ds(addDays(today(), 6))], 4);
  assert.equal(allocation[deadline], 4);
});

test('genuine past missed work still carries forward', () => {
  const task = makeTask('carry', 4, 1);
  resetState({
    tasks: [task],
    taskLog: {
      ['carry|' + ds(addDays(today(), -1))]: { scheduled: 2, completed: 0, checked: false },
    },
  });
  const plan = allocateSchedule();
  assert.equal(total(plan, task.id), 6);
});

test('user-entered HTML is escaped before rendering', () => {
  assert.equal(escapeHtml('<img src=x onerror=1>'), '&lt;img src=x onerror=1&gt;');
  assert.equal(safeColor('not-a-colour'), '#111111');
});

test('stress 1: twenty repeated drags never change the requested total', () => {
  resetState({ maxDailyHours: 8, tasks: [makeTask('drag-loop', 10, 4)] });
  withInteractionStubs(() => {
    for (let i = 0; i < 20; i++) {
      const plan = allocateSchedule();
      const allocation = plan.allocations['drag-loop'];
      const source = Object.keys(allocation).find(date => allocation[date] > 0);
      const target = Object.keys(plan.dailyFree).find(date => (
        date !== source &&
        date <= S.tasks[0].deadline &&
        parseDate(date) >= today() &&
        (plan.dailyFree[date] || 0) >= allocation[source]
      ));
      assert.ok(source && target, 'drag source/target should exist');
      assert.equal(moveTaskAllocation('drag-loop', source, target, allocation[source]), true);
      assert.equal(total(allocateSchedule(), 'drag-loop'), 10);
    }
  });
});

test('stress 2: moving a visually split day moves the full day allocation once', () => {
  const deadline = ds(addDays(today(), 1));
  resetState({
    maxDailyHours: 8,
    tasks: [makeTask('split', 6, 1)],
    events: [{
      id: 'middle', type: 'event', name: 'Middle', date: ds(today()),
      start: '11:00', end: '12:00', repeat: 'none', color: '#e85d26',
    }],
  });
  withInteractionStubs(() => {
    const before = allocateSchedule();
    const sourceHours = before.allocations.split[ds(today())];
    assert.equal(moveTaskAllocation('split', ds(today()), deadline, sourceHours), true);
    const after = allocateSchedule();
    assert.equal(after.allocations.split[ds(today())] || 0, 0);
    assert.equal(total(after, 'split'), 6);
  });
});

test('stress 3: occupied target rejects and restores the exact override state', () => {
  const tomorrow = ds(addDays(today(), 1));
  resetState({
    maxDailyHours: 4,
    tasks: [makeTask('move', 4, 1), makeTask('blocker', 4, 1, { notBefore: tomorrow })],
  });
  withInteractionStubs(getToast => {
    const beforePlan = allocateSchedule();
    const beforeOverrides = JSON.stringify(S.manualOverrides);
    const sourceHours = beforePlan.allocations.move[ds(today())] || 0;
    assert.equal(moveTaskAllocation('move', ds(today()), tomorrow, sourceHours), false);
    assert.equal(JSON.stringify(S.manualOverrides), beforeOverrides);
    assert.match(getToast(), /leave work unscheduled|kept the current plan/i);
    assert.equal(total(allocateSchedule(), 'move'), total(beforePlan, 'move'));
  });
});

test('stress 4: drag before not-before, after deadline, and into past is rejected', () => {
  const notBefore = ds(addDays(today(), 2));
  const deadline = ds(addDays(today(), 4));
  resetState({ tasks: [makeTask('window', 4, 4, { notBefore })] });
  withInteractionStubs(() => {
    const source = Object.keys(allocateSchedule().allocations.window)[0];
    assert.equal(moveTaskAllocation('window', source, ds(addDays(today(), 1)), 2), false);
    assert.equal(moveTaskAllocation('window', source, ds(addDays(today(), 5)), 2), false);
    assert.equal(moveTaskAllocation('window', source, ds(addDays(today(), -1)), 2), false);
    assert.equal(JSON.stringify(S.manualOverrides), '{}');
  });
});

test('stress 5: dragging one weekly occurrence leaves the next untouched', () => {
  const firstDeadline = ds(addDays(today(), 7));
  const secondDeadline = ds(addDays(today(), 14));
  const repeating = makeTask('weekly-drag', 6, 7, {
    repeat: 'weekly', repeatEndType: 'count', repeatCount: 2,
  });
  resetState({ tasks: [repeating] });
  withInteractionStubs(() => {
    const before = allocateSchedule();
    const firstId = 'weekly-drag|occ|' + firstDeadline;
    const secondId = 'weekly-drag|occ|' + secondDeadline;
    const secondBefore = JSON.stringify(before.occurrenceAllocations[secondId]);
    const source = Object.keys(before.occurrenceAllocations[firstId])[0];
    const target = firstDeadline;
    const hours = before.occurrenceAllocations[firstId][source];
    assert.equal(moveTaskAllocation('weekly-drag', source, target, hours), true);
    const after = allocateSchedule();
    assert.equal(occurrenceTotal(after, firstId), 6);
    assert.equal(occurrenceTotal(after, secondId), 6);
    assert.equal(JSON.stringify(after.occurrenceAllocations[secondId]), secondBefore);
  });
});

test('stress 6: repeated skip preserves demand until no later capacity exists', () => {
  resetState({ maxDailyHours: 8, tasks: [makeTask('skip-loop', 8, 4)] });
  withInteractionStubs(() => {
    let successes = 0;
    for (let i = 0; i < 5; i++) {
      const plan = allocateSchedule();
      const source = Object.keys(plan.allocations['skip-loop']).sort()[0];
      if (!source) break;
      const moved = skipTaskToTomorrow('skip-loop', source);
      if (!moved) break;
      successes++;
      assert.equal(total(allocateSchedule(), 'skip-loop'), 8);
    }
    assert.ok(successes >= 1);
  });
});

test('stress 7: skip on deadline day fails without changing the plan', () => {
  resetState({ tasks: [makeTask('deadline-skip', 2, 0)] });
  withInteractionStubs(getToast => {
    const before = JSON.stringify(allocateSchedule().allocations['deadline-skip']);
    assert.equal(skipTaskToTomorrow('deadline-skip', ds(today())), false);
    assert.equal(JSON.stringify(allocateSchedule().allocations['deadline-skip']), before);
    assert.match(getToast(), /not skipped/i);
  });
});

test('stress 8: skip with all later days blocked rolls back', () => {
  const tomorrow = ds(addDays(today(), 1));
  resetState({
    maxDailyHours: 4,
    tasks: [makeTask('blocked-skip', 4, 1)],
    events: [{
      id: 'tomorrow-block', type: 'event', name: 'Block',
      date: tomorrow, start: '09:00', end: '13:00', repeat: 'none', color: '#e85d26',
    }],
  });
  withInteractionStubs(() => {
    const before = JSON.stringify(allocateSchedule().allocations['blocked-skip']);
    assert.equal(skipTaskToTomorrow('blocked-skip', ds(today())), false);
    assert.equal(JSON.stringify(allocateSchedule().allocations['blocked-skip']), before);
  });
});

test('stress 9: done and not-done cycling cannot create demand', () => {
  const task = makeTask('toggle', 4, 1);
  resetState({ tasks: [task] });
  withInteractionStubs(() => {
    for (let i = 0; i < 20; i++) toggleTaskLog(task, ds(today()), 2);
    assert.equal(S.taskLog['toggle|' + ds(today())], undefined);
    assert.equal(total(allocateSchedule(), 'toggle'), 4);
  });
});

test('stress 10: partial past completion carries forward once, not repeatedly', () => {
  const task = makeTask('partial', 4, 1);
  resetState({
    tasks: [task],
    taskLog: {
      ['partial|' + ds(addDays(today(), -1))]: { scheduled: 4, completed: 1, checked: false },
    },
  });
  const first = allocateSchedule();
  const second = allocateSchedule();
  invalidatePlan();
  const third = allocateSchedule();
  assert.equal(total(first, 'partial'), 7);
  assert.equal(total(second, 'partial'), 7);
  assert.equal(total(third, 'partial'), 7);
});

test('stress 11: completion on one repeating date does not alter later occurrences', () => {
  const firstDeadline = ds(addDays(today(), 7));
  const secondDeadline = ds(addDays(today(), 14));
  const repeating = makeTask('repeat-done', 5, 7, {
    repeat: 'weekly', repeatEndType: 'count', repeatCount: 2,
  });
  resetState({ tasks: [repeating] });
  withInteractionStubs(() => {
    const before = allocateSchedule();
    toggleTaskLog(repeating, ds(today()), before.allocations['repeat-done'][ds(today())] || 0);
    const after = allocateSchedule();
    assert.equal(occurrenceTotal(after, 'repeat-done|occ|' + firstDeadline), 5);
    assert.equal(occurrenceTotal(after, 'repeat-done|occ|' + secondDeadline), 5);
  });
});

test('stress 12: completion, drag, and uncheck do not duplicate hours', () => {
  const task = makeTask('combo', 8, 3);
  resetState({ tasks: [task] });
  withInteractionStubs(() => {
    const before = allocateSchedule();
    const source = Object.keys(before.allocations.combo).sort()[0];
    toggleTaskLog(task, source, before.allocations.combo[source]);
    const plan = allocateSchedule();
    const dragSource = Object.keys(plan.allocations.combo).sort()[1];
    const target = task.deadline;
    assert.equal(moveTaskAllocation('combo', dragSource, target, plan.allocations.combo[dragSource]), true);
    toggleTaskLog(task, source, before.allocations.combo[source]);
    assert.equal(total(allocateSchedule(), 'combo'), 8);
  });
});

test('stress 13: rejected drag does not disturb same-deadline fairness', () => {
  const deadline = ds(addDays(today(), 1));
  resetState({
    maxDailyHours: 4,
    tasks: [makeTask('fair-a', 4, 1), makeTask('fair-b', 4, 1)],
    events: [{
      id: 'capacity-cut', type: 'event', name: 'Cut', date: deadline,
      start: '09:00', end: '11:00', repeat: 'none', color: '#e85d26',
    }],
  });
  withInteractionStubs(() => {
    const before = allocateSchedule();
    assert.equal(total(before, 'fair-a'), 3);
    assert.equal(total(before, 'fair-b'), 3);
    const source = ds(today());
    assert.equal(moveTaskAllocation('fair-a', source, deadline, before.allocations['fair-a'][source]), false);
    const after = allocateSchedule();
    assert.equal(total(after, 'fair-a'), 3);
    assert.equal(total(after, 'fair-b'), 3);
  });
});

test('stress 14: priority cascade returns one hard/soft schedule summary', () => {
  resetState({
    maxDailyHours: 6,
    tasks: [
      makeTask('mandatory-new', 8, 1),
      makeTask('optional-a', 4, 1, { priority: 'optional' }),
      makeTask('optional-b', 4, 1, { priority: 'optional' }),
    ],
  });
  const plan = allocateSchedule();
  assert.equal(total(plan, 'mandatory-new'), 8);
  assert.equal(plan.conflictSummary.hard.length, 0);
  assert.equal(plan.conflictSummary.soft.length, 2);
  assert.equal(plan.affectedTasks.length, 2);
  assert.ok(plan.conflictSummary.soft.every(conflict => conflict.shortfall > 0));
});

test('stress 15: failed conflict proposals leave application state byte-for-byte unchanged', () => {
  const target = makeTask('proposal-target', 20, 0);
  resetState({
    maxDailyHours: 4,
    tasks: [makeTask('existing', 4, 0)],
  });
  const oldGet = document.getElementById;
  const oldOverwork = _overworkDays;
  const oldDemoted = _demotedTasks;
  const oldIntensity = _intensityOverrides;
  try {
    const values = {
      'copt-deadline': ds(today()),
      'copt-hours': '20',
      'copt-extra-hrs': '1',
    };
    document.getElementById = id => ({
      value: values[id] || '',
      classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
      style: {},
      textContent: '',
    });
    _overworkDays = { [ds(today())]: true };
    _demotedTasks = { existing: true };
    _intensityOverrides = { [ds(today())]: S.baseline };

    for (const selected of [1, 2, 3, 5, 6]) {
      const before = JSON.stringify(S);
      const result = verifyConflictResolution(selected, target, null);
      assert.equal(result.ok, false, 'proposal ' + selected + ' should fail');
      assert.equal(JSON.stringify(S), before, 'proposal ' + selected + ' mutated live state');
    }
  } finally {
    document.getElementById = oldGet;
    _overworkDays = oldOverwork;
    _demotedTasks = oldDemoted;
    _intensityOverrides = oldIntensity;
  }
});

test('stress 16: edited overwork is removed and never inherited by another task', () => {
  const deadline = ds(today());
  const original = makeTask('overwork-owner', 6, 0);
  resetState({
    maxDailyHours: 4,
    tasks: [original],
    taskOverworkAllowances: {
      ['overwork-owner|' + deadline + '|' + deadline]: 2,
    },
  });
  assert.equal(total(allocateSchedule(), 'overwork-owner'), 6);
  const editedDeadline = ds(addDays(today(), 1));
  _commitTask({ ...original, deadline: editedDeadline, date: editedDeadline }, original.id);
  assert.equal(Object.keys(S.taskOverworkAllowances).length, 0);
  S.tasks.push(makeTask('unrelated', 5, 0, { priority: 'optional' }));
  invalidatePlan();
  const plan = allocateSchedule();
  assert.ok(total(plan, 'unrelated') <= 4);
  assert.ok(plan.conflicts.unrelated);
});

test('stress 17: repeating event add, edit, and delete revalidate all affected days', () => {
  const task = makeTask('event-window', 18, 2);
  resetState({ maxDailyHours: 8, tasks: [task] });
  const baseline = allocateSchedule();
  assert.equal(total(baseline, task.id), 18);

  S.events.push({
    id: 'repeat-event', type: 'event', name: 'Repeat',
    date: ds(today()), start: '09:00', end: '13:00',
    repeat: 'daily', repeatEndType: 'count', repeatCount: 3, color: '#e85d26',
  });
  invalidatePlan();
  const added = allocateSchedule();
  assert.equal(total(added, task.id), 12);
  assert.equal(added.conflicts[task.id].shortfall, 6);

  S.events[0] = { ...S.events[0], end: '15:00' };
  invalidatePlan();
  const edited = allocateSchedule();
  assert.equal(total(edited, task.id), 6);
  assert.equal(edited.conflicts[task.id].shortfall, 12);

  S.events = [];
  invalidatePlan();
  const deleted = allocateSchedule();
  assert.equal(total(deleted, task.id), 18);
  assert.equal(deleted.conflicts[task.id], undefined);
});

test('stress 18: complex state survives repeated backup and restore identically', () => {
  const weekly = makeTask('persist-weekly', 7, 7, {
    repeat: 'weekly', repeatEndType: 'count', repeatCount: 4,
  });
  const single = makeTask('persist-single', 5, 3, { priority: 'optional' });
  const weeklyOccurrence = 'persist-weekly|occ|' + weekly.deadline;
  resetState({
    baseline: 8,
    maxDailyHours: 10,
    distribution: 'weighted',
    tasks: [weekly, single],
    events: [{
      id: 'persist-event', type: 'event', name: 'Class',
      date: ds(today()), start: '08:00', end: '10:00',
      repeat: 'weekdays', color: '#e85d26',
    }],
    intensities: { [ds(addDays(today(), 2))]: 4 },
    taskLog: {
      ['persist-single|' + ds(addDays(today(), -1))]: { scheduled: 2, completed: 1, checked: false },
    },
    manualOverrides: {
      [weeklyOccurrence]: {
        pinned: { [weekly.deadline]: 3 },
        excludedDates: [ds(today())],
      },
    },
    taskOverworkAllowances: {
      ['persist-weekly|' + weekly.deadline + '|' + weekly.deadline]: 1,
    },
  });
  const beforePlan = JSON.stringify(allocateSchedule());
  const beforeState = JSON.stringify(normalizeState(S));
  for (let i = 0; i < 10; i++) {
    S = normalizeState(JSON.parse(JSON.stringify({ state: S })).state);
    invalidatePlan();
  }
  assert.equal(JSON.stringify(S), beforeState);
  assert.equal(JSON.stringify(allocateSchedule()), beforePlan);
});

test('stress 19: navigation and render-only state cannot alter allocation', () => {
  resetState({
    tasks: [
      makeTask('nav-a', 10, 5),
      makeTask('nav-b', 7, 8, { priority: 'optional' }),
    ],
    events: [{
      id: 'nav-event', type: 'event', name: 'Event',
      date: ds(addDays(today(), 1)), start: '09:00', end: '12:00',
      repeat: 'weekly', repeatEndType: 'count', repeatCount: 3, color: '#e85d26',
    }],
  });
  const expected = JSON.stringify(allocateSchedule());
  const views = ['week', 'agenda', 'settings'];
  for (let i = 0; i < 50; i++) {
    S.view = views[i % views.length];
    S.weekOffset = (i % 9) - 4;
    assert.equal(JSON.stringify(allocateSchedule()), expected);
  }
});

test('stress 20: 150 tasks and 50 repeating events remain finite and deterministic', () => {
  const tasks = [];
  for (let i = 0; i < 100; i++) {
    tasks.push(makeTask('bulk-single-' + i, 1 + (i % 12), i % 30, {
      priority: i % 4 === 0 ? 'optional' : 'mandatory',
      dist: ['even', 'front', 'back', 'weighted'][i % 4],
    }));
  }
  for (let i = 0; i < 50; i++) {
    tasks.push(makeTask('bulk-repeat-' + i, 1 + (i % 5), i % 7, {
      priority: i % 3 === 0 ? 'optional' : 'mandatory',
      repeat: i % 2 ? 'weekly' : 'weekdays',
      repeatEndType: 'count',
      repeatCount: 8,
    }));
  }
  const events = [];
  for (let i = 0; i < 50; i++) {
    const startHour = 7 + (i % 8);
    events.push({
      id: 'bulk-event-' + i,
      type: 'event',
      name: 'Event ' + i,
      date: ds(addDays(today(), i % 7)),
      start: String(startHour).padStart(2, '0') + ':00',
      end: String(startHour + 1).padStart(2, '0') + ':00',
      repeat: i % 3 === 0 ? 'weekdays' : 'weekly',
      repeatEndType: 'count',
      repeatCount: 12,
      color: '#e85d26',
    });
  }
  resetState({ maxDailyHours: 12, tasks, events });
  const started = performance.now();
  const first = allocateSchedule();
  const elapsed = performance.now() - started;
  const serialized = JSON.stringify(first);
  invalidatePlan();
  const second = allocateSchedule();
  assert.equal(JSON.stringify(second), serialized);
  assert.ok(elapsed < 5000, 'allocation took ' + elapsed + 'ms');

  Object.values(first.occurrenceAllocations).forEach(allocation => {
    Object.values(allocation).forEach(hours => assert.ok(Number.isFinite(hours) && hours >= 0));
  });
  first.occurrences.forEach(occurrence => {
    assert.ok(occurrenceTotal(first, occurrence.occId) <= roundHours(occurrence.hours) + ALLOC_EPSILON);
  });
  Object.entries(first.dailyUsed).forEach(([date, used]) => {
    assert.ok(Number.isFinite(used));
    assert.ok(used <= (first.dailyFree[date] || 0) + ALLOC_EPSILON);
  });
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
  performance,
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

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

test('daily reduction locks the chosen amount and redistributes the remainder', () => {
  const task = makeTask('reduce-day', 6, 2);
  resetState({ maxDailyHours: 4, tasks: [task] });
  const before = allocateSchedule();
  assert.equal(before.allocations[task.id][ds(today())], 2);
  const occ = before.occurrences.find(candidate => candidate.taskId === task.id);
  setDayConstraint(occ, ds(today()), 1);
  invalidatePlan();
  const after = allocateSchedule();
  assert.equal(after.allocations[task.id][ds(today())], 1);
  assert.equal(total(after, task.id), 6);
  assert.equal(after.occurrenceResults[occ.occId].fullyAllocated, true);
});

test('daily increase pulls hours from automatic days without changing task total', () => {
  const task = makeTask('increase-day', 6, 2);
  resetState({ maxDailyHours: 4, tasks: [task] });
  const before = allocateSchedule();
  const occ = before.occurrences.find(candidate => candidate.taskId === task.id);
  setDayConstraint(occ, ds(today()), 3);
  invalidatePlan();
  const after = allocateSchedule();
  assert.equal(after.allocations[task.id][ds(today())], 3);
  assert.equal(total(after, task.id), 6);
  assert.equal(
    roundHours(Object.entries(after.allocations[task.id])
      .filter(([date]) => date !== ds(today()))
      .reduce((sum, [, hours]) => sum + hours, 0)),
    3
  );
});

test('an impossible user lock remains stored and reports a constraint conflict', () => {
  const task = makeTask('fixed-conflict', 6, 1);
  resetState({ maxDailyHours: 4, tasks: [task] });
  const before = allocateSchedule();
  const occ = before.occurrences.find(candidate => candidate.taskId === task.id);
  setDayConstraint(occ, ds(today()), 4);
  S.events.push({
    id: 'fixed-block', type: 'event', name: 'Block',
    date: ds(today()), start: '09:00', end: '12:00',
    repeat: 'none', color: '#e85d26',
  });
  invalidatePlan();
  const after = allocateSchedule();
  assert.equal(constraintHoursForDate(occ, ds(today())), 4);
  assert.equal(after.allocations[task.id][ds(today())], 1);
  assert.equal(after.conflicts[task.id].shortfall, 3);
  assert.equal(after.conflicts[task.id].reason, 'user_constraints');
});

test('releasing one fixed day returns it to automatic scheduling', () => {
  const task = makeTask('release-day', 6, 2);
  resetState({ maxDailyHours: 4, tasks: [task] });
  const before = allocateSchedule();
  const occ = before.occurrences.find(candidate => candidate.taskId === task.id);
  setDayConstraint(occ, ds(today()), 1);
  invalidatePlan();
  assert.equal(allocateSchedule().allocations[task.id][ds(today())], 1);
  releaseDayConstraint(occ, ds(today()));
  invalidatePlan();
  const after = allocateSchedule();
  assert.equal(constraintHoursForDate(occ, ds(today())), undefined);
  assert.equal(after.allocations[task.id][ds(today())], 2);
  assert.equal(total(after, task.id), 6);
});

test('ordinary task edits preserve valid user-controlled days', () => {
  const task = makeTask('edit-fixed', 6, 2);
  resetState({ maxDailyHours: 4, tasks: [task] });
  const plan = allocateSchedule();
  const occ = plan.occurrences.find(candidate => candidate.taskId === task.id);
  setDayConstraint(occ, ds(today()), 1);
  invalidatePlan();
  _commitTask({ ...task, name: 'Renamed fixed task' }, task.id);
  assert.equal(constraintHoursForDate(occ, ds(today())), 1);
  assert.equal(allocateSchedule().allocations[task.id][ds(today())], 1);
});

test('past intensity is historical while today and future remain editable', () => {
  assert.equal(canEditIntensity(ds(addDays(today(), -1))), false);
  assert.equal(canEditIntensity(ds(today())), true);
  assert.equal(canEditIntensity(ds(addDays(today(), 1))), true);
});

test('completion state exposes the same action in every view', () => {
  const task = makeTask('completion-state', 2, 0);
  resetState({ tasks: [task] });
  assert.deepEqual(taskCompletionState(task, ds(today())), {
    done: false,
    actionLabel: 'Mark done',
  });
  S.taskLog[task.id + '|' + ds(today())] = {
    scheduled: 2,
    completed: 2,
    checked: true,
  };
  assert.deepEqual(taskCompletionState(task, ds(today())), {
    done: true,
    actionLabel: 'Mark not done',
  });
});

test('week task blocks render completion controls without a scope error', () => {
  const oldCreateElement = document.createElement;
  const buttonStub = { addEventListener() {} };
  const blockStub = {
    className: '',
    classList: { toggle() {} },
    style: {},
    dataset: {},
    draggable: false,
    innerHTML: '',
    addEventListener() {},
    appendChild() {},
  };
  const actionsStub = {
    className: '',
    innerHTML: '',
    querySelectorAll() { return [buttonStub, buttonStub, buttonStub, buttonStub]; },
  };
  document.createElement = tag => tag === 'div' && !blockStub.className ? blockStub : actionsStub;
  try {
    const task = makeTask('week-render', 2, 0);
    resetState({ tasks: [task] });
    const block = makeWeekBlock(task, 'task', ds(today()), 2, 0);
    assert.equal(block, blockStub);
    assert.match(actionsStub.innerHTML, /Mark done/);
  } finally {
    document.createElement = oldCreateElement;
  }
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
      const after = allocateSchedule();
      assert.ok(total(after, 'drag-loop') <= 10);
      assert.equal(
        roundHours(total(after, 'drag-loop') + (after.conflicts['drag-loop']?.shortfall || 0)),
        10
      );
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

test('stress 3: occupied target keeps the user move and exposes the shortfall', () => {
  const tomorrow = ds(addDays(today(), 1));
  resetState({
    maxDailyHours: 4,
    tasks: [makeTask('move', 4, 1), makeTask('blocker', 4, 1, { notBefore: tomorrow })],
  });
  withInteractionStubs(getToast => {
    const beforePlan = allocateSchedule();
    const sourceHours = beforePlan.allocations.move[ds(today())] || 0;
    assert.equal(moveTaskAllocation('move', ds(today()), tomorrow, sourceHours), true);
    const after = allocateSchedule();
    assert.equal(S.manualOverrides.move.pinned[tomorrow], sourceHours);
    assert.ok(S.manualOverrides.move.excludedDates.includes(ds(today())));
    assert.equal(after.allocations.move[ds(today())] || 0, 0);
    assert.equal(after.conflicts.move.shortfall, 2);
    assert.match(getToast(), /needs adjusting/i);
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
      assert.equal(moved, true);
      successes++;
      const after = allocateSchedule();
      assert.equal(
        roundHours(total(after, 'skip-loop') + (after.conflicts['skip-loop']?.shortfall || 0)),
        8
      );
      if (after.conflicts['skip-loop']) break;
    }
    assert.ok(successes >= 1);
  });
});

test('stress 7: skip on deadline day remains fixed at zero with a visible shortfall', () => {
  resetState({ tasks: [makeTask('deadline-skip', 2, 0)] });
  withInteractionStubs(getToast => {
    assert.equal(skipTaskToTomorrow('deadline-skip', ds(today())), true);
    const plan = allocateSchedule();
    assert.equal(total(plan, 'deadline-skip'), 0);
    assert.equal(plan.conflicts['deadline-skip'].shortfall, 2);
    assert.ok(S.manualOverrides['deadline-skip'].excludedDates.includes(ds(today())));
    assert.match(getToast(), /cannot fit/i);
  });
});

test('stress 8: skip with all later days blocked keeps the skip and flags demand', () => {
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
    assert.equal(skipTaskToTomorrow('blocked-skip', ds(today())), true);
    const after = allocateSchedule();
    assert.equal(after.allocations['blocked-skip'][ds(today())] || 0, 0);
    assert.equal(after.conflicts['blocked-skip'].shortfall, 4);
    assert.equal(after.conflicts['blocked-skip'].reason, 'user_constraints');
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

test('stress 13: constrained drag stays authoritative without stealing extra capacity', () => {
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
    assert.equal(moveTaskAllocation('fair-a', source, deadline, before.allocations['fair-a'][source]), true);
    const after = allocateSchedule();
    assert.equal(after.allocations['fair-a'][source] || 0, 0);
    assert.equal(total(after, 'fair-a'), 2);
    assert.equal(total(after, 'fair-b'), 3);
    assert.equal(after.conflicts['fair-a'].shortfall, 2);
    assert.equal(after.dailyUsed[deadline], 2);
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

test('projects migrate defensively and orphaned task assignments become unassigned', () => {
  const state = normalizeState({
    projects: [
      { id: 'study', name: 'Study', color: '#2e6b4f' },
      { id: 'study', name: 'Duplicate', color: 'bad' },
    ],
    hiddenProjectIds: ['study', 'missing', UNASSIGNED_PROJECT_ID],
    tasks: [
      makeTask('valid-project', 2, 1, { projectId: 'study' }),
      makeTask('orphan-project', 2, 1, { projectId: 'missing' }),
    ],
    events: [],
  });
  assert.equal(state.projects.length, 2);
  assert.notEqual(state.projects[0].id, state.projects[1].id);
  assert.equal(state.projects[1].color, '#3f3f3f');
  assert.equal(state.tasks[0].projectId, 'study');
  assert.equal(state.tasks[1].projectId, null);
  assert.deepEqual(state.hiddenProjectIds, ['study', UNASSIGNED_PROJECT_ID]);
});

test('project visibility filters never change canonical allocation', () => {
  resetState({
    projects: [
      { id: 'study', name: 'Study', color: '#2e6b4f' },
      { id: 'work', name: 'Work', color: '#4a3a7a' },
    ],
    tasks: [
      makeTask('study-task', 5, 2, { projectId: 'study' }),
      makeTask('work-task', 5, 2, { projectId: 'work' }),
      makeTask('no-project-task', 3, 2),
    ],
  });
  const expected = JSON.stringify(allocateSchedule());
  S.hiddenProjectIds = ['study', UNASSIGNED_PROJECT_ID];
  assert.equal(isTaskVisible(S.tasks[0]), false);
  assert.equal(isTaskVisible(S.tasks[1]), true);
  assert.equal(isTaskVisible(S.tasks[2]), false);
  assert.equal(JSON.stringify(allocateSchedule()), expected);
});

test('project metadata survives repeated backup normalization without plan drift', () => {
  resetState({
    projects: [{ id: 'alpha', name: 'Alpha', color: '#8b3a2a' }],
    hiddenProjectIds: ['alpha'],
    tasks: [makeTask('alpha-task', 6, 3, { projectId: 'alpha' })],
  });
  const beforeState = JSON.stringify(S);
  const beforePlan = JSON.stringify(allocateSchedule());
  for (let i = 0; i < 5; i++) {
    S = normalizeState(JSON.parse(JSON.stringify(S)));
    invalidatePlan();
  }
  assert.equal(JSON.stringify(S), beforeState);
  assert.equal(JSON.stringify(allocateSchedule()), beforePlan);
});


test('v0.1 weekday capacity overrides change schedulable workload', () => {
  const monday = ds(addDays(today(), 1));
  resetState({ maxDailyHours: 8, weekdayCapacity: { '1': 2 }, tasks: [makeTask('weekday-cap', 8, 1, { notBefore: monday })] });
  const plan = allocateSchedule();
  assert.equal(plan.dailyCapacity[monday], 2);
  assert.equal(total(plan, 'weekday-cap'), 2);
  assert.equal(plan.conflicts['weekday-cap'].shortfall, 6);
});

test('v0.1 working-hours window caps daily capacity', () => {
  resetState({ maxDailyHours: 8, dayStart: '09:00', dayEnd: '12:00', tasks: [makeTask('window-cap', 8, 0)] });
  const plan = allocateSchedule();
  assert.equal(plan.dailyCapacity[ds(today())], 3);
  assert.equal(total(plan, 'window-cap'), 3);
});

test('v0.2 daily working-hours override takes precedence over weekday defaults', () => {
  const date = ds(today());
  resetState({
    maxDailyHours: 8,
    weekdayCapacity: { [String(today().getDay())]: 7 },
    dailyWorkingHours: { [date]: { dayStart: '10:00', dayEnd: '14:00', maxDailyHours: 3 } },
    tasks: [makeTask('daily-hours', 6, 0)],
  });
  const plan = allocateSchedule();
  assert.deepEqual(workingHoursForDay(date), {
    dayStart: '10:00', dayEnd: '14:00', maxDailyHours: 3, minBlockHours: 0.5,
  });
  assert.equal(plan.dailyCapacity[date], 3);
  assert.equal(total(plan, 'daily-hours'), 3);
});

test('v0.2 fixed task time is preserved and automatic work avoids it', () => {
  const date = ds(today());
  const task = makeTask('fixed-time', 3, 0);
  resetState({
    tasks: [task],
    manualOverrides: {
      [task.id]: {
        pinned: {},
        excludedDates: [],
        timeBlocks: { [date]: { start: '14:00', end: '16:00', mode: 'fixed' } },
      },
    },
  });
  const timeline = buildDayTimeline(date);
  const fixed = timeline.taskBlocks.find(block => block.mode === 'fixed');
  const automatic = timeline.taskBlocks.find(block => block.mode === 'flexible');
  assert.deepEqual(
    { start: fixed.start, end: fixed.end, hours: fixed.hours },
    { start: 14, end: 16, hours: 2 }
  );
  assert.ok(automatic.end <= fixed.start || automatic.start >= fixed.end);
});

test('v0.2 preferred task time yields to a recurring availability block', () => {
  const date = ds(today());
  const task = makeTask('preferred-time', 2, 0);
  resetState({
    tasks: [task],
    events: [{
      id: 'standup', type: 'event', kind: 'availability', name: 'Daily standup', date,
      start: '10:00', end: '12:00', repeat: 'daily', color: '#111111',
    }],
    manualOverrides: {
      [task.id]: {
        pinned: {},
        excludedDates: [],
        timeBlocks: { [date]: { start: '10:00', end: '12:00', mode: 'preferred' } },
      },
    },
  });
  const timeline = buildDayTimeline(date);
  const blocks = timeline.taskBlocks.filter(block => block.item.id === task.id);
  assert.ok(blocks.length > 0);
  assert.ok(blocks.every(block => block.end <= 10 || block.start >= 12));
  assert.ok(blocks.every(block => block.mode === 'flexible'));
});

test('v0.1 minimum preferred block duration avoids too-small days', () => {
  resetState({ maxDailyHours: 8, minBlockHours: 1, tasks: [makeTask('min-block', 2, 1)], events: [{
    id: 'tiny-left', type: 'event', name: 'Tiny left', date: ds(today()), start: '09:00', end: '16:30', repeat: 'none', color: '#111111'
  }] });
  const plan = allocateSchedule();
  assert.equal(plan.dailyFree[ds(today())], 0.5);
  assert.equal(plan.allocations['min-block'][ds(today())] || 0, 0);
  assert.equal(plan.allocations['min-block'][ds(addDays(today(), 1))], 2);
});

test('v0.1 non-splittable task schedules as one block when a day can fit', () => {
  resetState({ maxDailyHours: 4, tasks: [makeTask('one-block', 3, 2, { splittable: false })] });
  const alloc = allocateSchedule().allocations['one-block'];
  assert.equal(Object.keys(alloc).length, 1);
  assert.equal(total(allocateSchedule(), 'one-block'), 3);
});

test('v0.1 non-splittable task reports shortfall when no single day can fit', () => {
  resetState({ maxDailyHours: 2, tasks: [makeTask('too-large-one-block', 3, 2, { splittable: false })] });
  const plan = allocateSchedule();
  assert.equal(total(plan, 'too-large-one-block'), 0);
  assert.equal(plan.conflicts['too-large-one-block'].shortfall, 3);
});

test('v0.1 partial check-in carries only unfinished work forward', () => {
  const task = makeTask('partial-checkin', 5, 1);
  resetState({ tasks: [task] });
  withInteractionStubs(() => {
    recordTaskCheckin(task, ds(addDays(today(), -1)), 4, 1.5);
  });
  const plan = allocateSchedule();
  assert.equal(total(plan, 'partial-checkin'), 7.5);
});

test('v0.1 front-loaded strategy places at least as much today as deadline day', () => {
  resetState({ maxDailyHours: 8, tasks: [makeTask('front-load', 6, 2, { dist: 'front' })] });
  const alloc = allocateSchedule().allocations['front-load'];
  assert.ok((alloc[ds(today())] || 0) >= (alloc[ds(addDays(today(), 2))] || 0));
});

test('v0.1 back-loaded strategy places at least as much on deadline as today', () => {
  resetState({ maxDailyHours: 8, tasks: [makeTask('back-load', 6, 2, { dist: 'back' })] });
  const alloc = allocateSchedule().allocations['back-load'];
  assert.ok((alloc[ds(addDays(today(), 2))] || 0) >= (alloc[ds(today())] || 0));
});

test('v0.1 free-time weighted strategy favors the freer day', () => {
  resetState({ maxDailyHours: 8, tasks: [makeTask('weighted-load', 4, 1, { dist: 'weighted' })], events: [{
    id: 'today-busy', type: 'event', name: 'Busy', date: ds(today()), start: '09:00', end: '15:00', repeat: 'none', color: '#111111'
  }] });
  const alloc = allocateSchedule().allocations['weighted-load'];
  assert.ok((alloc[ds(addDays(today(), 1))] || 0) > (alloc[ds(today())] || 0));
});

test('v0.1 twenty hours due next Friday repairs sensibly after Tuesday is missed', () => {
  const friday = ds(addDays(weekStartDate(0), 11));
  const tuesday = ds(addDays(weekStartDate(0), 2));
  resetState({ maxDailyHours: 6, tasks: [makeTask('success-case', 20, 12, { deadline: friday, date: friday, notBefore: ds(weekStartDate(0)) })] });
  const before = allocateSchedule();
  const missed = before.allocations['success-case'][tuesday] || 0;
  S.taskLog['success-case|' + tuesday] = { scheduled: missed, completed: 0, checked: false };
  invalidatePlan();
  const after = allocateSchedule();
  assert.equal(roundHours(total(after, 'success-case')), roundHours(20 + missed));
  assert.ok((after.allocations['success-case'][ds(addDays(parseDate(tuesday), 1))] || 0) <= 6);
  assert.equal(after.conflicts['success-case'], undefined);
});


test('v0.1 malformed capacity settings normalize safely', () => {
  const state = normalizeState({ weekdayCapacity: { '1': 'bad', '2': 30 }, minBlockHours: -4, splitTasks: false, tasks: [], events: [] });
  assert.equal(state.weekdayCapacity['1'], 8);
  assert.equal(state.weekdayCapacity['2'], 24);
  assert.equal(state.minBlockHours, 0.25);
  assert.equal(state.splitTasks, false);
});


test('review: constrained batch keeps non-splittable tasks whole', () => {
  resetState({ maxDailyHours: 4, tasks: [
    makeTask('whole-a', 3, 0, { splittable: false }),
    makeTask('whole-b', 3, 0, { splittable: false }),
  ] });
  const plan = allocateSchedule();
  const totals = ['whole-a', 'whole-b'].map(id => total(plan, id)).sort((a, b) => a - b);
  assert.deepEqual(totals, [0, 3]);
  assert.equal(plan.conflicts['whole-a'] || plan.conflicts['whole-b'] ? true : false, true);
});

test('review: min block is enforced on every automatic allocation chunk', () => {
  resetState({ maxDailyHours: 8, minBlockHours: 1, tasks: [makeTask('chunk-min', 2, 2)] });
  const allocation = allocateSchedule().allocations['chunk-min'];
  assert.equal(Object.values(allocation).length, 2);
  Object.values(allocation).forEach(hours => assert.ok(hours >= 1, JSON.stringify(allocation)));
});

test('review: submitCheckin records partial completed hours from the UI input', () => {
  resetState({ tasks: [] });
  const oldQuery = document.querySelectorAll;
  const oldGet = document.getElementById;
  const item = {
    dataset: { key: 'ui-partial|' + ds(addDays(today(), -1)), scheduled: '4', completed: '1.5' },
    querySelector(selector) {
      if (selector === '.ci-completed input') return { value: '1.5' };
      if (selector === '.ci-check') return { classList: { contains() { return false; } } };
      return null;
    },
  };
  document.querySelectorAll = selector => selector === '.checkin-task-item' ? [item] : [];
  document.getElementById = id => id === 'checkin-bg'
    ? { classList: { add() {} } }
    : element;
  withInteractionStubs(() => submitCheckin());
  document.querySelectorAll = oldQuery;
  document.getElementById = oldGet;
  assert.deepEqual(S.taskLog[item.dataset.key], { scheduled: 4, completed: 1.5, checked: false });
});


test('v0.1 audit: mixed mandatory and optional constrained batch is deterministic and capacity safe', () => {
  const tomorrow = ds(addDays(today(), 1));
  resetState({
    maxDailyHours: 4,
    weekdayCapacity: { [String(parseDate(tomorrow).getDay())]: 2 },
    tasks: [
      makeTask('audit-whole', 3, 1, { splittable: false }),
      makeTask('audit-split', 8, 1, { minBlockHours: 1 }),
      makeTask('audit-optional', 5, 1, { priority: 'optional' }),
    ],
  });
  const first = allocateSchedule();
  const second = allocateSchedule();
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(roundHours((first.dailyUsed[ds(today())] || 0) + (first.dailyUsed[tomorrow] || 0)), 6);
  assert.equal(total(first, 'audit-whole'), 3);
  assert.equal(roundHours(total(first, 'audit-split') + first.conflicts['audit-split'].shortfall), 8);
  assert.equal(total(first, 'audit-optional'), 0);
  assert.equal(first.conflicts['audit-optional'].type, 'soft');
});

test('v0.1 audit: partial carry-forward and pins conserve demand', () => {
  const task = makeTask('audit-partial-pinned', 6, 2);
  resetState({ maxDailyHours: 4, tasks: [task], taskLog: {
    ['audit-partial-pinned|' + ds(addDays(today(), -1))]: { scheduled: 3, completed: 1, checked: false },
  } });
  const plan = allocateSchedule();
  const occ = plan.occurrences.find(candidate => candidate.taskId === task.id);
  setDayConstraint(occ, ds(today()), 2);
  invalidatePlan();
  const after = allocateSchedule();
  assert.equal(after.allocations['audit-partial-pinned'][ds(today())], 2);
  assert.equal(roundHours(total(after, 'audit-partial-pinned') + (after.conflicts['audit-partial-pinned']?.shortfall || 0)), 8);
});


test('v0.1 ux: day view items and search cover tasks events and projects', () => {
  resetState({
    projects: [{ id: 'launch-project', name: 'Launch Project', color: '#2e6b4f' }],
    tasks: [makeTask('day-task', 2, 0, { name: 'Day Task', projectId: 'launch-project' })],
    events: [{ id: 'day-event', type: 'event', name: 'Day Event', date: ds(today()), start: '10:00', end: '11:00', repeat: 'none', color: '#111111' }],
  });
  const items = dayScheduleItems(ds(today()));
  assert.equal(items.length, 2);
  assert.deepEqual(searchMatches('launch').map(hit => hit.type).sort(), ['project', 'task']);
  assert.equal(searchMatches('day event')[0].type, 'event');
});

test('cloud sync payload omits bearer tokens', () => {
  resetState({ cloud: { endpoint: 'https://example.test/state', token: 'secret-token' } });
  const state = stateForCloudSync();
  assert.equal(state.cloud.endpoint, 'https://example.test/state');
  assert.equal(Object.hasOwn(state.cloud, 'token'), false);
});

test('release gate: working-hour inputs normalize immediately and reject reversed windows', () => {
  assert.deepEqual(workingHoursSettings('09:00', '18:00', 999, -1), {
    dayStart: '09:00',
    dayEnd: '18:00',
    maxDailyHours: 24,
    minBlockHours: 0.25,
  });
  assert.equal(workingHoursSettings('18:00', '09:00', 8, 0.5), null);
  const recovered = normalizeState({ dayStart: '18:00', dayEnd: '09:00', tasks: [], events: [] });
  assert.equal(recovered.dayStart, '09:00');
  assert.equal(recovered.dayEnd, '18:00');
});

test('release gate: invalid task hours and event ranges are rejected', () => {
  assert.equal(taskHoursFromInput(0), null);
  assert.equal(taskHoursFromInput(-1), null);
  assert.equal(taskHoursFromInput(0.5), 0.5);
  assert.equal(eventTimeRangeIsValid('17:00', '09:00'), false);
  assert.equal(eventTimeRangeIsValid('09:00', '09:00'), false);
  assert.equal(eventTimeRangeIsValid('09:00', '10:00'), true);
});

test('release gate: reduction finds the largest schedulable non-splittable estimate', () => {
  resetState({ maxDailyHours: 4 });
  const task = makeTask('reduce-whole', 5, 2, { splittable: false });
  assert.equal(maximumFittingTaskHours(task), 4);
  assert.equal(taskEstimateFits(task, 4), true);
  assert.equal(taskEstimateFits(task, 4.5), false);
});

test('release gate: exported backups omit cloud access tokens without mutating local state', () => {
  resetState({ cloud: { endpoint: 'https://example.test/state', token: 'secret-token' } });
  const backup = stateForBackup();
  assert.equal(backup.cloud.endpoint, 'https://example.test/state');
  assert.equal(Object.hasOwn(backup.cloud, 'token'), false);
  assert.equal(S.cloud.token, 'secret-token');
});

test('cloud load validation rejects non-Calico documents', () => {
  assert.equal(isCalicoStateDocument({}), false);
  assert.equal(isCalicoStateDocument({ tasks: [], events: [] }), true);
  assert.equal(isCalicoStateDocument({ state: { tasks: [], events: [] } }), false);
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
  focus() {},
  select() {},
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

const results = JSON.parse(vm.runInNewContext(appCode + suite, context, { timeout: 20000 }));
const resultsUrl = new URL('./alpha-results.json', import.meta.url);
const summary = {
  total: results.length,
  passed: results.filter(r => r.status === 'PASS').length,
  failed: results.filter(r => r.status !== 'PASS').length,
  results,
};
let previous;
try {
  previous = JSON.parse(fs.readFileSync(resultsUrl, 'utf8'));
} catch {}
const previousSummary = previous && {
  total: previous.total,
  passed: previous.passed,
  failed: previous.failed,
  results: previous.results,
};
const generatedAt = JSON.stringify(previousSummary) === JSON.stringify(summary)
  ? previous.generatedAt
  : new Date().toISOString();
fs.writeFileSync(resultsUrl, JSON.stringify({ generatedAt, ...summary }, null, 2));
for (const result of results) {
  console.log(`${result.status} ${result.name}${result.error ? ': ' + result.error : ''}`);
}
if (results.some(result => result.status !== 'PASS')) process.exitCode = 1;

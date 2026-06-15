/* ══════════════════════════════════════════
   SLIDER FILL — sets --pct CSS var so the
   orange gradient tracks the thumb position.
   Call after any slider value change.
══════════════════════════════════════════ */
function updateSliderFill(slider) {
  const min = +slider.min || 1;
  const max = +slider.max || 10;
  const val = +slider.value;
  const pct = ((val - min) / (max - min)) * 100;
  slider.style.setProperty('--pct', pct + '%');
}

function updateAllSliderFills() {
  document.querySelectorAll('.cal-slider, .cal-slider-sm').forEach(updateSliderFill);
}

'use strict';

/* ══════════════════════════════════════════
   STATE
══════════════════════════════════════════ */
const DEFAULT_STATE = {
  stateVersion: 2,
  onboarded: false,
  baseline: 7,
  distribution: 'even',
  dayStart: '09:00',
  dayEnd: '18:00',
  maxDailyHours: 8,
  taskOverworkAllowances: {}, // 'taskId|deadline|dateStr' → extra hours for that task occurrence only
  view: 'week',
  weekOffset: 0,
  tasks: [],
  events: [],
  intensities: {},       // dateStr → 1‥10
  intensityHistory: [],  // [{date, dir}]
  nudgeDismissed: false,
  taskLog: {},        // 'taskId|dateStr' → {scheduled, completed, checked}
  lastCheckinDate: null,
  manualOverrides: {}, // occurrenceId → { pinned: {dateStr: hours}, excludedDates: [] }
};

let S = { ...DEFAULT_STATE };
let editingId   = null;
let editingType = null;
let pickedColor = '#111111';
let _loadRecoveryMessage = '';
const _undoStack = [];

/* ══════════════════════════════════════════
   PERSISTENCE
══════════════════════════════════════════ */
const STORAGE_KEY = 'calico_v2';
const LEGACY_STORAGE_KEY = 'calico_v1';
const STATE_VERSION = 2;

function cloneData(value) {
  return JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeState(input) {
  const raw = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const next = {
    ...cloneData(DEFAULT_STATE),
    ...raw,
    stateVersion: STATE_VERSION,
  };

  next.baseline = finiteNumber(next.baseline, 7, 1, 10);
  next.maxDailyHours = finiteNumber(next.maxDailyHours, 8, 0.5, 24);
  next.weekOffset = Math.trunc(finiteNumber(next.weekOffset, 0, -520, 520));
  next.tasks = Array.isArray(next.tasks) ? next.tasks.filter(Boolean) : [];
  next.events = Array.isArray(next.events) ? next.events.filter(Boolean) : [];
  next.intensities = next.intensities && typeof next.intensities === 'object' ? next.intensities : {};
  next.intensityHistory = Array.isArray(next.intensityHistory) ? next.intensityHistory.slice(-30) : [];
  next.taskLog = next.taskLog && typeof next.taskLog === 'object' ? next.taskLog : {};
  next.taskOverworkAllowances = next.taskOverworkAllowances && typeof next.taskOverworkAllowances === 'object'
    ? next.taskOverworkAllowances : {};
  next.manualOverrides = next.manualOverrides && typeof next.manualOverrides === 'object'
    ? next.manualOverrides : {};
  if (!['week', 'agenda', 'settings'].includes(next.view)) next.view = 'week';
  if (!['even', 'front', 'back', 'weighted'].includes(next.distribution)) next.distribution = 'even';

  // Migrate safe legacy pins for single-occurrence tasks. Repeating legacy
  // pins are discarded because they cannot identify an occurrence.
  const legacyPins = raw.pinnedAllocations && typeof raw.pinnedAllocations === 'object'
    ? raw.pinnedAllocations : {};
  Object.entries(legacyPins).forEach(([key, hours]) => {
    const splitAt = key.lastIndexOf('|');
    if (splitAt < 0) return;
    const taskId = key.slice(0, splitAt);
    const dateStr = key.slice(splitAt + 1);
    const task = next.tasks.find(t => t.id === taskId);
    if (!task || (task.repeat && task.repeat !== 'none')) return;
    if (!next.manualOverrides[taskId]) next.manualOverrides[taskId] = { pinned: {}, excludedDates: [] };
    next.manualOverrides[taskId].pinned ||= {};
    next.manualOverrides[taskId].pinned[dateStr] = finiteNumber(hours, 0, 0, 24);
  });
  delete next.pinnedAllocations;
  delete next.dayCapOverrides;

  Object.values(next.manualOverrides).forEach(override => {
    override.pinned = override.pinned && typeof override.pinned === 'object' ? override.pinned : {};
    Object.entries(override.pinned).forEach(([dateStr, hours]) => {
      override.pinned[dateStr] = finiteNumber(hours, 0, 0, 24);
    });
    override.excludedDates = Array.isArray(override.excludedDates)
      ? Array.from(new Set(override.excludedDates.filter(Boolean))) : [];
  });

  return next;
}

function save() {
  try {
    S.stateVersion = STATE_VERSION;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(S));
    return true;
  } catch (error) {
    console.error('Calico could not save state', error);
    showToast('Calico could not save. Export a backup before closing.');
    return false;
  }
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) {
      S = normalizeState(DEFAULT_STATE);
      return;
    }
    S = normalizeState(JSON.parse(raw));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(S));
  } catch (error) {
    console.error('Calico state recovery', error);
    try {
      const broken = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      if (broken) localStorage.setItem(`calico_recovery_${Date.now()}`, broken);
    } catch (_) {}
    S = normalizeState(DEFAULT_STATE);
    _loadRecoveryMessage = 'Saved data was damaged, so Calico opened a clean recovery state.';
  }
}

function snapshotForUndo(label, state = S) {
  _undoStack.push({ label, state: cloneData(state) });
  if (_undoStack.length > 10) _undoStack.shift();
  syncUndoButton();
}

function syncUndoButton() {
  const btn = document.getElementById('undo-btn');
  if (!btn) return;
  btn.disabled = !_undoStack.length;
  btn.title = _undoStack.length ? `Undo ${_undoStack[_undoStack.length - 1].label}` : 'Nothing to undo';
}

function undoLastAction() {
  const previous = _undoStack.pop();
  if (!previous) return;
  S = normalizeState(previous.state);
  invalidatePlan();
  save();
  render();
  syncUndoButton();
  showToast(`Undid ${previous.label}`);
}

function exportData() {
  const payload = JSON.stringify({ exportedAt: new Date().toISOString(), state: S }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `calico-backup-${ds(today())}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast('Backup exported');
}

function chooseImportFile() {
  document.getElementById('import-data-file')?.click();
}

async function importDataFile(input) {
  const file = input.files?.[0];
  input.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const candidate = parsed.state || parsed;
    if (!candidate || !Array.isArray(candidate.tasks) || !Array.isArray(candidate.events)) {
      throw new Error('This is not a Calico backup.');
    }
    if (!confirm('Replace the current Calico data with this backup?')) return;
    snapshotForUndo('data import');
    S = normalizeState(candidate);
    invalidatePlan();
    save();
    render();
    showToast('Backup imported');
  } catch (error) {
    console.error('Calico import failed', error);
    showToast(error.message || 'That backup could not be imported');
  }
}

/* ══════════════════════════════════════════
   DATE HELPERS
══════════════════════════════════════════ */
function today()         { const d = new Date(); d.setHours(0,0,0,0); return d; }
function ds(d)           { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
function addDays(d, n)   { const r = new Date(d); r.setDate(r.getDate()+n); return r; }
function parseDate(s)    { return new Date(s + 'T00:00:00'); }
function fmt(d)          { return d.toLocaleDateString('en-GB', {day:'numeric', month:'short'}); }
function timeH(t)        { const [h,m]=t.split(':').map(Number); return h+m/60; }

const DNAMES  = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const DFULL   = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

function weekStartDate(offset=0) {
  const d = today();
  const dow = d.getDay(); // 0=Sun
  const monday = addDays(d, (dow===0 ? -6 : 1-dow) + offset*7);
  return monday;
}

/* ══════════════════════════════════════════
   INTENSITY
══════════════════════════════════════════ */
function getInt(dateStr) { return S.intensities[dateStr] ?? S.baseline; }

function setInt(dateStr, val) {
  S.intensities[dateStr] = val;
  // track direction vs baseline for nudge — any day, not just today
  const dir = val > S.baseline ? 'up' : val < S.baseline ? 'down' : 'neutral';
  const h = S.intensityHistory;
  const last = h[h.length-1];
  // update existing entry for this date, or push new one
  if (last && last.date === dateStr) {
    last.dir = dir;
  } else {
    h.push({ date: dateStr, dir });
    if (h.length > 30) h.splice(0, h.length - 30);
  }
  checkNudge();
  save();
  render();
}

function checkNudge() {
  if (S.nudgeDismissed) return;
  const h = S.intensityHistory;
  if (h.length < 3) return;
  const last3 = h.slice(-3);
  if (last3.every(x=>x.dir==='up') || last3.every(x=>x.dir==='down')) {
    document.getElementById('nudge').classList.remove('hidden');
  }
}

/* ══════════════════════════════════════════
   CANONICAL ALLOCATION ENGINE
══════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════
   CALICO CANONICAL ALLOCATION ENGINE
   
   Single source of truth for all scheduling decisions.
   Everything else only reads from the result of allocateSchedule().
   
   Output shape:
   {
     allocations:   { taskId: { dateStr: hours } }
     conflicts:     { taskId: { allocated, needed, shortfall, unallocated } }
     dailyCapacity: { dateStr: hours }  — max before events
     dailyFree:     { dateStr: hours }  — max after events
     dailyUsed:     { dateStr: hours }  — actually scheduled
     dailyEvents:   { dateStr: [{id,name,start,end,color}] }
     window:        { from: dateStr, to: dateStr }
   }
══════════════════════════════════════════════════════════════════ */

const ENGINE_HORIZON_DAYS = 180; // rolling window from today

/* ─── Step 1: Build date window ─────────────────────────────── */
function buildDateWindow(tasks) {
  const todayDate = today();
  // Find furthest task deadline
  let maxDate = addDays(todayDate, ENGINE_HORIZON_DAYS);
  tasks.forEach(t => {
    if (!t.deadline) return;
    const d = parseDate(t.deadline);
    if (d > maxDate) maxDate = d;
    // Repeating tasks with end date
    if (t.repeatEndDate) {
      const re = parseDate(t.repeatEndDate);
      if (re > maxDate) maxDate = re;
    }
  });
  // Hard cap at 365 days
  const hardCap = addDays(todayDate, 365);
  if (maxDate > hardCap) maxDate = hardCap;
  
  const days = [];
  let cur = new Date(todayDate);
  while (cur <= maxDate) {
    days.push(ds(cur));
    cur = addDays(cur, 1);
  }
  return { days, from: ds(todayDate), to: ds(maxDate) };
}

/* ─── Step 2: Compute daily capacity ────────────────────────── */
function buildDailyCapacity(days) {
  const capacity = {}; // dateStr → raw max (before events)
  const free     = {}; // dateStr → free after events
  const events   = {}; // dateStr → [{...}]

  days.forEach(dStr => {
    // Raw capacity = maxDailyHours × intensityRatio
    const base     = S.maxDailyHours || 8;
    const ratio    = getInt(dStr) / Math.max(1, S.baseline || 7);
    // Intensity can exceed baseline (ratio > 1) to allow more capacity.
    // Overwork is task-scoped and is applied while allocating an occurrence.
    const rawCap   = base * ratio;
    // Hard cap: never exceed 24h (physical limit of a day).
    const cap      = Math.round(Math.min(24, Math.max(0, rawCap)) * 100) / 100;
    capacity[dStr] = cap;

    // Events on this day
    const dayEvs = eventsOnDay(dStr);
    events[dStr] = dayEvs;
    const eventHrs = dayEvs.reduce((s, ev) => {
      return s + Math.max(0, timeH(ev.end || '10:00') - timeH(ev.start || '09:00'));
    }, 0);
    free[dStr] = Math.max(0, Math.round((cap - eventHrs) * 100) / 100);
  });

  return { capacity, free, events };
}

/* ─── Step 3: Expand tasks into occurrences ─────────────────── */
function expandTaskOccurrences(tasks, days) {
  const todayDate = today();
  const toDate    = parseDate(days[days.length - 1]);
  const occurrences = []; // flat list of {taskId, occId, windowStart, deadline, hours, priority, dist, notBefore, pinned, loggedShortfall}

  tasks.forEach(task => {
    if (!task.deadline) return;

    // Compute logged shortfall (missed hours to add back)
    let loggedShortfall = 0;
    Object.entries(S.taskLog).forEach(([key, entry]) => {
      const [tid, logDate] = key.split('|');
      if (tid !== task.id) return;
      // Only completed past days can create carryover. A current/future
      // checkbox being toggled off is not missed work and must never increase
      // an occurrence beyond its requested hours.
      if (!logDate || parseDate(logDate) >= todayDate) return;
      const gap = Math.max(0, (entry.scheduled || 0) - (entry.completed ?? entry.scheduled ?? 0));
      loggedShortfall += gap;
    });

    const baseHours = Math.max(0, task.hours - (task.logged ?? 0));

    if (!task.repeat || task.repeat === 'none') {
      // Single occurrence
      const deadline = parseDate(task.deadline);
      if (deadline < todayDate) return; // past
      const occ = {
        taskId:         task.id,
        occId:          task.id,
        windowStart:    ds(todayDate),
        deadline:       task.deadline,
        hours:          baseHours + loggedShortfall,
        priority:       task.priority || 'mandatory',
        dist:           task.dist === 'inherit' ? S.distribution : (task.dist || 'even'),
        notBefore:      task.notBefore || null,
        color:          task.color,
        name:           task.name,
      };
      occurrences.push(occ);
    } else {
      // Repeating: expand occurrences
      const repeatStart = parseDate(task.date || task.deadline);
      let prevOccDate   = null;
      let count         = 0;
      let cur           = new Date(repeatStart);

      while (cur <= toDate) {
        const dStr = ds(cur);

        if (engineRepeatOccursOn(task, dStr)) {
          // Check repeat end
          if (task.repeatEndType === 'date' && task.repeatEndDate) {
            if (cur > parseDate(task.repeatEndDate)) break;
          }
          if (task.repeatEndType === 'count' && task.repeatCount) {
            if (count >= task.repeatCount) break;
          }
          count++;

          // Only future occurrences get allocated
          if (cur >= todayDate) {
            const winStart = prevOccDate
              ? ds(addDays(parseDate(prevOccDate), 1) >= todayDate
                  ? addDays(parseDate(prevOccDate), 1)
                  : todayDate)
              : ds(todayDate);

            occurrences.push({
              taskId:      task.id,
              occId:       task.id + '|occ|' + dStr,
              windowStart: winStart,
              deadline:    dStr,
              hours:       task.hours + (count === 1 ? loggedShortfall : 0),
              priority:    task.priority || 'mandatory',
              dist:        task.dist === 'inherit' ? S.distribution : (task.dist || 'even'),
              notBefore:   task.notBefore || null,
              repeat:      task.repeat,
              repeatDays:  task.repeatDays || [],
              color:       task.color,
              name:        task.name,
            });
          }
          prevOccDate = dStr;
        }
        cur = addDays(cur, 1);
      }
    }
  });

  // Sort into priority waves, then by deadline urgency and demand pressure.
  occurrences.sort((a, b) => {
    const pa = occurrencePriorityRank(a);
    const pb = occurrencePriorityRank(b);
    if (pa !== pb) return pa - pb;
    if (a.deadline !== b.deadline) return a.deadline < b.deadline ? -1 : 1;
    const ua = occurrenceUrgency(a);
    const ub = occurrenceUrgency(b);
    if (ua !== ub) return ub - ua;
    return a.occId < b.occId ? -1 : a.occId > b.occId ? 1 : 0;
  });

  return occurrences;
}

function occurrencePriorityRank(occ) {
  if (occ.priority === 'hard' || occ.priority === 'hard-deadline') return 0;
  if (occ.priority === 'mandatory') return 1;
  if (occ.priority === 'deferred' || occ.priority === 'bumped') return 3;
  return 2;
}

function occurrenceUrgency(occ) {
  const start = parseDate(occ.notBefore || occ.windowStart || ds(today()));
  const end = parseDate(occ.deadline);
  const days = Math.max(1, Math.floor((end - start) / 86400000) + 1);
  return (+occ.hours || 0) / days;
}

function engineRepeatOccursOn(task, dateStr) {
  const start  = parseDate(task.date || task.deadline);
  const target = parseDate(dateStr);
  if (target < start) return false;
  if (dateStr === (task.date || task.deadline)) return true;
  const dow      = target.getDay();
  const startDow = start.getDay();
  if (task.repeat === 'daily')    return true;
  if (task.repeat === 'weekly')   return dow === startDow;
  if (task.repeat === 'weekdays') return dow >= 1 && dow <= 5;
  if (task.repeat === 'weekends') return dow === 0 || dow === 6;
  if (task.repeat === 'custom')   return (task.repeatDays || []).includes(dow);
  if (task.repeat === 'interval') {
    const diff = Math.round((target.getTime() - start.getTime()) / 86400000);
    return diff >= 0 && diff % (task.repeatInterval || 7) === 0;
  }
  return false;
}

function occurrenceCanAllocateOn(occ, dateStr) {
  const dow = parseDate(dateStr).getDay();

  // Daily and weekly tasks may use the whole window between occurrences. For
  // weekday/weekend/custom repeats, keep each occurrence on days that match the
  // repeat pattern so weekday work does not spill onto weekends.
  if (occ.repeat === 'weekdays') return dow >= 1 && dow <= 5;
  if (occ.repeat === 'weekends') return dow === 0 || dow === 6;
  if (occ.repeat === 'custom') return (occ.repeatDays || []).includes(dow);

  return true;
}

/* ─── Event occurrence helpers ────────────────────────────────
   These are deliberately kept outside allocateSchedule(): the engine needs
   them while building daily capacity, and the week/agenda renderers need the
   same answers for event display. */
function eventOccursOn(ev, dateStr) {
  if (!ev.repeat || ev.repeat === 'none') {
    return ev.date === dateStr;
  }

  const start  = parseDate(ev.date);
  const target = parseDate(dateStr);
  if (target < start) return false;

  if (ev.repeatEndType === 'date' && ev.repeatEndDate) {
    if (target > parseDate(ev.repeatEndDate)) return false;
  }

  // The chosen start date itself is always an occurrence.
  if (dateStr === ev.date) return true;

  const dow      = target.getDay();
  const startDow = start.getDay();

  if (ev.repeat === 'daily')    return true;
  if (ev.repeat === 'weekly')   return dow === startDow;
  if (ev.repeat === 'weekdays') return dow >= 1 && dow <= 5;
  if (ev.repeat === 'weekends') return dow === 0 || dow === 6;
  if (ev.repeat === 'custom')   return (ev.repeatDays || []).includes(dow);
  if (ev.repeat === 'interval') {
    const interval = ev.repeatInterval || 7;
    const diff = Math.round((target.getTime() - start.getTime()) / 86400000);
    return diff >= 0 && diff % interval === 0;
  }
  return false;
}

function countOccurrencesBefore(ev, dateStr) {
  if (!ev.repeat || ev.repeat === 'none') return 0;
  const start  = parseDate(ev.date);
  const target = parseDate(dateStr);
  let count = 0;
  let cur = new Date(start);

  while (cur < target) {
    if (eventOccursOn(ev, ds(cur))) count++;
    cur = addDays(cur, 1);
  }
  return count;
}

function eventsOnDay(dateStr) {
  return S.events.filter(ev => {
    if (!eventOccursOn(ev, dateStr)) return false;
    if (ev.repeatEndType === 'count' && ev.repeatCount) {
      const n = countOccurrencesBefore(ev, dateStr);
      if (n >= ev.repeatCount) return false;
    }
    return true;
  });
}


function overworkKeyForOccurrence(occ, dateStr) {
  return occ.taskId + '|' + occ.deadline + '|' + dateStr;
}

function taskScopedOverworkFor(occ, dateStr) {
  if (!S.taskOverworkAllowances) return 0;
  return +(S.taskOverworkAllowances[overworkKeyForOccurrence(occ, dateStr)] || 0);
}

function pinnedHoursForOccurrence(occ, dateStr) {
  const override = S.manualOverrides?.[occ.occId];
  return override?.pinned?.[dateStr];
}

function excludedDatesForOccurrence(occ) {
  return new Set(S.manualOverrides?.[occ.occId]?.excludedDates || []);
}

function occurrenceHasUserConstraints(occ) {
  const override = S.manualOverrides?.[occ.occId];
  return !!override && (
    Object.keys(override.pinned || {}).length > 0 ||
    (override.excludedDates || []).length > 0
  );
}

/* ─── Step 4: Allocate each occurrence ──────────────────────── */
const ALLOC_EPSILON = 0.05;
const ALLOC_PROGRESS_EPSILON = 0.01;

function roundHours(n) {
  return Math.round((+n || 0) * 100) / 100;
}

function consumeCapacityForOccurrence(occ, dateStr, hours, remainingCapacity, extraRemaining) {
  const h = Math.max(0, +hours || 0);
  if (h <= 0) return 0;

  const normalUse = Math.min(remainingCapacity[dateStr] || 0, h);
  remainingCapacity[dateStr] = Math.max(0, (remainingCapacity[dateStr] || 0) - normalUse);

  const extraUse = Math.min(extraRemaining[dateStr] || 0, h - normalUse);
  extraRemaining[dateStr] = Math.max(0, (extraRemaining[dateStr] || 0) - extraUse);

  return normalUse + extraUse;
}

function getEligibleDays(occ, remainingCapacity, extraRemaining, excludedDays) {
  const todayDate = today();
  const deadline  = parseDate(occ.deadline);
  const winStart  = occ.notBefore
    ? (parseDate(occ.notBefore) > todayDate ? parseDate(occ.notBefore) : todayDate)
    : (parseDate(occ.windowStart) > todayDate ? parseDate(occ.windowStart) : todayDate);

  if (deadline < todayDate) return [];

  const days = [];
  let cur = new Date(winStart);
  while (cur <= deadline) {
    const dStr = ds(cur);
    const effectiveCap = (remainingCapacity[dStr] || 0) + (extraRemaining[dStr] || 0);
    if (!excludedDays?.has(dStr) && occurrenceCanAllocateOn(occ, dStr) && effectiveCap > 0.001) {
      days.push({ date: dStr, free: effectiveCap });
    }
    cur = addDays(cur, 1);
  }
  return days;
}

function buildDayWeights(occ, eligibleDays) {
  const dist = occ.dist || 'even';
  return eligibleDays.map((day, i) => {
    if (dist === 'even')     return 1;
    if (dist === 'front')    return eligibleDays.length - i;
    if (dist === 'back')     return i + 1;
    if (dist === 'weighted') return Math.max(0, day.free);
    return 1;
  });
}

function normalizeAllocation(allocation) {
  const out = {};
  Object.entries(allocation).forEach(([d, h]) => {
    const rounded = roundHours(h);
    if (rounded > 0.001) out[d] = rounded;
  });
  return out;
}

function adjustAllocationToTotal(allocation, targetTotal) {
  const out = normalizeAllocation(allocation);
  const keys = Object.keys(out);
  if (!keys.length) return out;

  const target = roundHours(targetTotal);
  const current = roundHours(keys.reduce((s, d) => s + out[d], 0));
  let diff = roundHours(target - current);
  if (Math.abs(diff) < 0.01) return out;

  const lastKey = keys[keys.length - 1];
  out[lastKey] = roundHours(out[lastKey] + diff);
  if (out[lastKey] <= 0.001) delete out[lastKey];
  return out;
}

function allocateOccurrenceConvergent(occ, remainingCapacity) {
  // Place occ.hours across occ.windowStart → occ.deadline.
  // Uses normal remainingCapacity first, then task-scoped overwork allowance.
  // Overwork is consumed locally for this occurrence and never becomes global
  // capacity for unrelated tasks.
  const allocation = {};
  const excludedDays = excludedDatesForOccurrence(occ);
  const extraRemaining = {};

  const todayDate = today();
  const deadline  = parseDate(occ.deadline);
  const winStart  = occ.notBefore
    ? (parseDate(occ.notBefore) > todayDate ? parseDate(occ.notBefore) : todayDate)
    : (parseDate(occ.windowStart) > todayDate ? parseDate(occ.windowStart) : todayDate);

  if (deadline >= todayDate) {
    let cur = new Date(winStart);
    while (cur <= deadline) {
      const dStr = ds(cur);
      if (occurrenceCanAllocateOn(occ, dStr)) {
        extraRemaining[dStr] = taskScopedOverworkFor(occ, dStr);
      }
      cur = addDays(cur, 1);
    }
  }

  let remaining = Math.max(0, +occ.hours || 0);
  let pinnedUnfilled = 0;

  if (deadline >= todayDate) {
    let cur = new Date(winStart);
    while (cur <= deadline && remaining > ALLOC_PROGRESS_EPSILON) {
      const dStr = ds(cur);
      const pinnedH = pinnedHoursForOccurrence(occ, dStr);
      if (pinnedH === undefined) {
        cur = addDays(cur, 1);
        continue;
      }

      const requested = Math.min(+pinnedH || 0, remaining);
      const used = occurrenceCanAllocateOn(occ, dStr)
        ? consumeCapacityForOccurrence(occ, dStr, requested, remainingCapacity, extraRemaining)
        : 0;

      if (used > 0.001) {
        allocation[dStr] = (allocation[dStr] || 0) + used;
      }
      remaining -= requested;
      pinnedUnfilled += Math.max(0, requested - used);
      excludedDays.add(dStr);
      cur = addDays(cur, 1);
    }
  }

  let guard = 0;
  while (remaining > ALLOC_EPSILON && guard++ < 1000) {
    const eligible = getEligibleDays(occ, remainingCapacity, extraRemaining, excludedDays);
    if (!eligible.length) break;

    const weights = buildDayWeights(occ, eligible);
    const totalWeight = weights.reduce((s, w) => s + Math.max(0, w), 0);
    if (totalWeight <= 0) break;

    const roundTarget = remaining;
    let allocatedThisRound = 0;

    eligible.forEach((day, i) => {
      if (remaining <= ALLOC_PROGRESS_EPSILON) return;
      const weight = Math.max(0, weights[i]);
      if (weight <= 0) return;

      const share = (weight / totalWeight) * roundTarget;
      const used = consumeCapacityForOccurrence(
        occ,
        day.date,
        Math.min(share, day.free, remaining),
        remainingCapacity,
        extraRemaining
      );

      if (used > 0.001) {
        allocation[day.date] = (allocation[day.date] || 0) + used;
        remaining -= used;
        allocatedThisRound += used;
      }
    });

    if (allocatedThisRound <= ALLOC_PROGRESS_EPSILON) break;
  }

  if (remaining <= ALLOC_EPSILON) remaining = 0;
  remaining += pinnedUnfilled;
  if (remaining <= ALLOC_EPSILON) remaining = 0;
  const allocated = (+occ.hours || 0) - remaining;

  return {
    allocation: adjustAllocationToTotal(allocation, allocated),
    allocated: roundHours(allocated),
    shortfall: roundHours(remaining),
    fullyAllocated: remaining <= ALLOC_EPSILON,
  };
}

function batchCapacityForOccurrences(batch, remainingCapacity) {
  const normalDays = new Set();
  let taskScopedExtra = 0;

  batch.forEach(occ => {
    const extraRemaining = {};
    const todayDate = today();
    const deadline = parseDate(occ.deadline);
    const winStart = occ.notBefore
      ? (parseDate(occ.notBefore) > todayDate ? parseDate(occ.notBefore) : todayDate)
      : (parseDate(occ.windowStart) > todayDate ? parseDate(occ.windowStart) : todayDate);

    if (deadline < todayDate) return;

    let cur = new Date(winStart);
    const excludedDays = excludedDatesForOccurrence(occ);
    while (cur <= deadline) {
      const dStr = ds(cur);
      if (!excludedDays.has(dStr) && occurrenceCanAllocateOn(occ, dStr)) {
        if ((remainingCapacity[dStr] || 0) > 0.001) normalDays.add(dStr);
        const extra = taskScopedOverworkFor(occ, dStr);
        if (extra > 0.001) {
          extraRemaining[dStr] = extra;
          taskScopedExtra += extra;
        }
      }
      cur = addDays(cur, 1);
    }
  });

  const normal = Array.from(normalDays).reduce((s, d) => s + (remainingCapacity[d] || 0), 0);
  return normal + taskScopedExtra;
}

function allocateOccurrenceBatchConvergent(batch, remainingCapacity) {
  if (batch.length === 1) {
    const only = batch[0];
    return { [only.occId]: allocateOccurrenceConvergent(only, remainingCapacity) };
  }

  const results = {};
  const totalNeeded = batch.reduce((s, occ) => s + (+occ.hours || 0), 0);
  const available = batchCapacityForOccurrences(batch, remainingCapacity);
  const constrained = available + ALLOC_EPSILON < totalNeeded;

  let quotaRemaining = constrained ? Math.max(0, available) : totalNeeded;

  batch.forEach((occ, index) => {
    let quota = +occ.hours || 0;
    if (constrained) {
      if (index === batch.length - 1) {
        quota = quotaRemaining;
      } else {
        quota = Math.min(occ.hours, (occ.hours / totalNeeded) * available);
        quotaRemaining -= quota;
      }
    }

    const result = allocateOccurrenceConvergent({ ...occ, hours: Math.max(0, quota) }, remainingCapacity);
    results[occ.occId] = {
      allocation: result.allocation,
      allocated: result.allocated,
      shortfall: roundHours((+occ.hours || 0) - result.allocated),
      fullyAllocated: (+occ.hours || 0) - result.allocated <= ALLOC_EPSILON,
    };
  });

  if (!constrained) {
    batch.forEach(occ => {
      const result = results[occ.occId];
      if (result.shortfall <= ALLOC_EPSILON) return;
      const extra = allocateOccurrenceConvergent({ ...occ, hours: result.shortfall }, remainingCapacity);
      Object.entries(extra.allocation).forEach(([d, h]) => {
        result.allocation[d] = (result.allocation[d] || 0) + h;
      });
      result.allocated = roundHours(result.allocated + extra.allocated);
      result.shortfall = roundHours((+occ.hours || 0) - result.allocated);
      result.fullyAllocated = result.shortfall <= ALLOC_EPSILON;
      result.allocation = adjustAllocationToTotal(result.allocation, result.allocated);
    });
  }

  return results;
}

function conflictTypeForOccurrence(occ) {
  return occurrencePriorityRank(occ) <= 1 ? 'hard' : 'soft';
}

function conflictReasonForOccurrence(occ, result, free) {
  const todayDate = today();
  const deadline = parseDate(occ.deadline);
  let sawFreeDay = false;

  let cur = parseDate(occ.windowStart);
  if (cur < todayDate) cur = todayDate;
  if (occ.notBefore && parseDate(occ.notBefore) > cur) cur = parseDate(occ.notBefore);

  while (cur <= deadline) {
    if ((free[ds(cur)] || 0) > 0.001 || taskScopedOverworkFor(occ, ds(cur)) > 0.001) {
      sawFreeDay = true;
      break;
    }
    cur = addDays(cur, 1);
  }

  if (occurrenceHasUserConstraints(occ)) return 'user_constraints';
  if (!sawFreeDay) return 'event_blocked';
  if (occ.priority === 'deferred' || occ.priority === 'bumped') return 'accepted_shortfall';
  if (conflictTypeForOccurrence(occ) === 'soft' && result.allocated < (+occ.hours || 0)) {
    return 'displaced_by_higher_priority';
  }
  return 'insufficient_capacity';
}

/* ─── Step 5: Main engine entry point ───────────────────────── */
let _plan     = null;
let _planKey  = '';

function allocateSchedule() {
  // Build cache key
  const key = JSON.stringify({
    tasks: S.tasks,
    events: S.events,
    intensities: S.intensities,
    baseline: S.baseline,
    maxDailyHours: S.maxDailyHours,
    taskOverworkAllowances: S.taskOverworkAllowances,
    manualOverrides: S.manualOverrides,
    taskLog: S.taskLog,
    distribution: S.distribution,
    dayStart: S.dayStart,
    dayEnd: S.dayEnd,
  });
  if (_plan && _planKey === key) return _plan;

  const { days, from, to } = buildDateWindow(S.tasks);
  const { capacity, free, events } = buildDailyCapacity(days);

  // remainingCapacity starts equal to free, gets consumed as tasks are placed
  const remainingCapacity = { ...free };

  const occurrences = expandTaskOccurrences(S.tasks, days);

  // Allocate priority waves to convergence. Occurrences with the same priority
  // and deadline share constrained capacity proportionally instead of
  // first-come-first-served.
  const occAllocs = {};  // occId → {dateStr: hours}
  const occResults = {}; // occId → {allocated, shortfall, fullyAllocated}
  for (let i = 0; i < occurrences.length;) {
    const first = occurrences[i];
    const batch = [];
    while (
      i < occurrences.length &&
      occurrencePriorityRank(occurrences[i]) === occurrencePriorityRank(first) &&
      occurrences[i].deadline === first.deadline
    ) {
      batch.push(occurrences[i]);
      i++;
    }

    const batchResults = allocateOccurrenceBatchConvergent(batch, remainingCapacity);
    batch.forEach(occ => {
      const result = batchResults[occ.occId];
      occAllocs[occ.occId] = result.allocation;
      occResults[occ.occId] = {
        allocated: result.allocated,
        shortfall: result.shortfall,
        fullyAllocated: result.fullyAllocated,
      };
    });
  }

  // Merge occurrence allocations back to task level
  const allocations = {}; // taskId → {dateStr: hours}
  S.tasks.forEach(t => { allocations[t.id] = {}; });

  occurrences.forEach(occ => {
    const occAlloc = occAllocs[occ.occId] || {};
    Object.entries(occAlloc).forEach(([d, h]) => {
      allocations[occ.taskId][d] = Math.round(((allocations[occ.taskId][d] || 0) + h) * 100) / 100;
    });
  });

  // Compute dailyUsed
  const dailyUsed = {};
  days.forEach(d => {
    let used = 0;
    S.tasks.forEach(t => { used += allocations[t.id][d] || 0; });
    if (used > 0.001) dailyUsed[d] = Math.round(used * 100) / 100;
  });

  // Compute conflicts — tasks that couldn't be fully allocated. Keep the
  // existing taskId-indexed map for current UI compatibility, and also expose a
  // grouped schedule health summary for non-cascading conflict UI.
  const conflicts = {};
  const conflictSummary = { hard: [], soft: [] };
  const affectedTasks = [];
  occurrences.forEach(occ => {
    const result = occResults[occ.occId] || { allocated: 0, shortfall: occ.hours, fullyAllocated: false };
    const allocated = result.allocated;
    const shortfall = result.shortfall;
    if (shortfall > 0.05) {
      const type = conflictTypeForOccurrence(occ);
      const reason = conflictReasonForOccurrence(occ, result, free);
      const conflictEntry = {
        taskId: occ.taskId,
        occurrenceId: occ.occId,
        needed: roundHours(occ.hours),
        allocated: roundHours(allocated),
        shortfall: roundHours(shortfall),
        originalDeadline: occ.deadline,
        suggested: null,
        type,
        reason,
      };
      conflictSummary[type].push(conflictEntry);
      if (!affectedTasks.includes(occ.taskId)) affectedTasks.push(occ.taskId);

      // Accumulate conflicts per task
      if (!conflicts[occ.taskId]) {
        conflicts[occ.taskId] = { taskId: occ.taskId, allocated: 0, needed: 0, shortfall: 0, unallocated: 0, type, reason, occurrences: [] };
      }
      conflicts[occ.taskId].needed     += occ.hours;
      conflicts[occ.taskId].allocated  += allocated;
      conflicts[occ.taskId].shortfall  += shortfall;
      conflicts[occ.taskId].unallocated += shortfall;
      conflicts[occ.taskId].occurrences.push({
        occId: occ.occId,
        deadline: occ.deadline,
        allocated,
        needed: occ.hours,
        shortfall,
        fullyAllocated: result.fullyAllocated,
        type,
        reason,
      });
      if (type === 'hard') conflicts[occ.taskId].type = 'hard';
      if (conflicts[occ.taskId].reason !== reason) conflicts[occ.taskId].reason = 'mixed';
    }
  });

  Object.values(conflicts).forEach(info => {
    info.needed = roundHours(info.needed);
    info.allocated = roundHours(info.allocated);
    info.shortfall = roundHours(info.shortfall);
    info.unallocated = roundHours(info.unallocated);
  });

  _plan = {
    allocations,
    occurrenceAllocations: occAllocs,
    occurrenceResults: occResults,
    occurrences,
    conflicts,
    conflictsByTask: conflicts,
    conflictSummary,
    affectedTasks,
    dailyCapacity: capacity,
    dailyFree: free,
    dailyUsed,
    dailyEvents: events,
    window: { from, to },
  };
  _planKey = key;
  return _plan;
}

function invalidatePlan() {
  _plan    = null;
  _planKey = '';
}

/* ─── Thin accessors (read-only from plan) ───────────────────── */
function taskHoursOnDay(task, dateStr) {
  const plan = allocateSchedule();
  return plan.allocations[task.id]?.[dateStr] ?? 0;
}

function totalLoadOnDay(dateStr) {
  const plan = allocateSchedule();
  return plan.dailyUsed[dateStr] ?? 0;
}

function eventHoursOnDay(dateStr) {
  // Read event hours from plan (computed once in buildDailyCapacity)
  const plan = allocateSchedule();
  const dayEvs = plan.dailyEvents[dateStr] || [];
  return dayEvs.reduce((s, ev) => {
    return s + Math.max(0, timeH(ev.end || '10:00') - timeH(ev.start || '09:00'));
  }, 0);
}

function tasksOnDay(dateStr) {
  return S.tasks.filter(t => taskHoursOnDay(t, dateStr) > 0);
}

function dailyCapacityOn(dateStr) {
  const plan = allocateSchedule();
  return plan.dailyCapacity[dateStr] ?? 0;
}

function dayOverloadLevel(dateStr) {
  const plan  = allocateSchedule();
  const load  = plan.dailyUsed[dateStr]  ?? 0;
  const free  = plan.dailyFree[dateStr]  ?? 0;
  if (load <= free) return 'none';
  if (load <= free * 1.2) return 'mild';
  return 'hard';
}

/* ─── Conflict check for saving a new task ───────────────────── */
function allocationForHypotheticalTask(taskObj, deadlineOverride) {
  const originalTasks = S.tasks.slice();
  const tempId = taskObj.id || '__temp__';
  const tempTask = { ...taskObj, id: tempId };
  if (deadlineOverride) tempTask.deadline = deadlineOverride;

  // Validate as a replacement, not as an extra duplicate.
  S.tasks = S.tasks.filter(t => t.id !== tempId && t.id !== editingId);
  S.tasks.push(tempTask);
  invalidatePlan();

  const plan = allocateSchedule();
  const allocated = Object.values(plan.allocations[tempId] || {}).reduce((s,h) => s + h, 0);

  S.tasks = originalTasks;
  invalidatePlan();

  return { allocated, plan, taskId: tempId };
}

function computeConflict(taskObj) {
  if (parseDate(taskObj.deadline) < today()) return null;
  if (occurrencePriorityRank({ priority: taskObj.priority || 'mandatory' }) > 1) return null;

  const { allocated, plan, taskId } = allocationForHypotheticalTask(taskObj);
  const conflict = plan.conflicts?.[taskId];
  if (conflict && conflict.type !== 'hard') return null;
  const shortfall = conflict
    ? roundHours(conflict.shortfall || 0)
    : roundHours(taskObj.hours - allocated);
  const needed = conflict ? roundHours(conflict.needed || taskObj.hours) : taskObj.hours;
  const avail = conflict ? roundHours(conflict.allocated || 0) : roundHours(allocated);

  let freeDays = 0;
  let cur = new Date(today());
  const deadline = parseDate(taskObj.deadline);
  while (cur <= deadline) {
    if ((plan.dailyFree[ds(cur)] ?? 0) > 0) freeDays++;
    cur = addDays(cur, 1);
  }

  if (shortfall <= 0.05) return null;

  return {
    avail,
    needed,
    shortfall,
    days:        freeDays,
    suggested:   findEarliestFittingDeadline(taskObj),
    allBlocked:  freeDays === 0,
  };
}

function findEarliestFittingDeadline(taskObj) {
  let cur = parseDate(taskObj.deadline);
  const hardLimit = addDays(today(), 365);

  for (let i = 0; i < 365; i++) {
    cur = addDays(cur, 1);
    if (cur > hardLimit) return null;
    const { allocated, plan, taskId } = allocationForHypotheticalTask(taskObj, ds(cur));
    const conflict = plan.conflicts?.[taskId];
    if (!conflict || (conflict.shortfall || 0) <= 0.05) return ds(cur);
  }
  return null;
}

function conflictInfoForExistingTask(task) {
  const plan = allocateSchedule();
  const info = plan.conflicts && plan.conflicts[task.id];
  if (!info) return null;

  let freeDays = 0;
  let cur = new Date(today());
  const deadline = parseDate(task.deadline);
  while (cur <= deadline) {
    if ((plan.dailyFree[ds(cur)] ?? 0) > 0) freeDays++;
    cur = addDays(cur, 1);
  }

  return {
    avail:      Math.round((info.allocated || 0) * 100) / 100,
    needed:     Math.round((info.needed || task.hours) * 100) / 100,
    shortfall:  Math.round((info.shortfall || 0) * 100) / 100,
    days:       freeDays,
    suggested:  findEarliestFittingDeadline(task),
    allBlocked: freeDays === 0,
  };
}

function revalidateExistingTasks(showDialog) {
  invalidatePlan();
  const plan = allocateSchedule();
  const ids = (plan.conflictSummary?.hard || []).map(c => c.taskId);
  const softCount = plan.conflictSummary?.soft?.length || 0;
  if (!ids.length && softCount) {
    showOverloadToast(`This change displaced ${softCount} optional task${softCount!==1?'s':''}.`);
    return false;
  }
  if (!ids.length) return false;

  const task = S.tasks.find(t => t.id === ids[0]);
  if (!task) return false;

  const conflict = conflictInfoForExistingTask(task);
  if (!conflict) return false;

  if (showDialog) {
    _pendingTask = { obj: { ...task }, editingId: task.id, isEdit: true };
    showConflictDialog(conflict, { ...task });
  } else {
    showOverloadToast(`${task.name}: ${Math.round(conflict.shortfall*10)/10}h cannot be scheduled. Consider extending the deadline or reducing hours.`);
  }
  return true;
}

/* ══════════════════════════════════════════
   COLOUR HELPERS
══════════════════════════════════════════ */
function hexBg(hex, alpha) {
  hex = safeColor(hex);
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function safeColor(value, fallback = '#111111') {
  return /^#[0-9a-f]{6}$/i.test(value || '') ? value : fallback;
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

/* ══════════════════════════════════════════
   RENDER
══════════════════════════════════════════ */
function render() {
  updateWeekLabel();
  renderSidebar();
  if (S.view==='week')        renderWeek();
  else if (S.view==='agenda')   renderAgenda();
  else if (S.view==='settings') renderSettings();
  syncNavButtons();
  // Update orange fill on all visible sliders after DOM settles
  requestAnimationFrame(updateAllSliderFills);
}

function updateWeekLabel() {
  const ws = weekStartDate(S.weekOffset);
  const we = addDays(ws, 6);
  document.getElementById('week-label').textContent = `${fmt(ws)} – ${fmt(we)}`;
}

function syncNavButtons() {
  ['week','agenda','settings'].forEach(v => {
    document.getElementById(`nav-${v}`)?.classList.toggle('active', S.view===v);
    document.getElementById(`mb-${v}`)?.classList.toggle('active', S.view===v);
  });
  document.getElementById('sw-week')?.classList.toggle('active', S.view==='week');
  document.getElementById('sw-agenda')?.classList.toggle('active', S.view==='agenda');
  ['view-week','view-agenda','view-settings'].forEach(id => {
    document.getElementById(id).classList.toggle('hidden', !id.endsWith(S.view));
  });
  // topbar nav arrows / toggle only relevant for week+agenda
  const topRight = document.querySelector('.topbar-right');
  if (topRight) topRight.style.display = S.view==='settings' ? 'none' : '';
  const topLeft = document.querySelector('.topbar-left');
  if (topLeft) {
    topLeft.querySelectorAll('.icon-btn,.pill-btn').forEach(b => {
      b.style.visibility = S.view==='settings' ? 'hidden' : '';
    });
  }
}

/* ── Sidebar ── */
function renderSidebar() {
  document.getElementById('sb-baseline').textContent = S.baseline;
  const plan = allocateSchedule();

  const sbTasks = document.getElementById('sb-tasks');
  sbTasks.innerHTML = '';
  S.tasks.forEach(t => {
    const conflict = plan.conflicts?.[t.id];
    const rem = Math.max(0, t.hours - (t.logged ?? 0));
    const rl  = t.repeat && t.repeat !== 'none' ? repeatLabel(t) : '';
    const el  = document.createElement('div');
    el.className = `sb-pill${conflict?.type === 'soft' ? ' needs-review' : ''}`;
    el.innerHTML = `<span class="sb-dot" style="background:${safeColor(t.color)}"></span>
      <span class="sb-name">${escapeHtml(t.name)}</span>
      <span class="sb-hrs">${conflict?.type === 'soft' ? roundHours(conflict.shortfall) + 'h short' : (rl ? rl : rem + 'h')}</span>`;
    el.onclick = () => openModal('task', t.id);
    sbTasks.appendChild(el);
  });

  renderReviewSidebar(plan);

  const sbEvents = document.getElementById('sb-events');
  sbEvents.innerHTML = '';
  S.events.forEach(e => {
    const el = document.createElement('div');
    el.className = 'sb-pill';
    el.innerHTML = `<span class="sb-dot" style="background:${safeColor(e.color)}"></span>
      <span class="sb-name">${escapeHtml(e.name)}</span>
      <span class="sb-hrs">${e.date?.slice(5) ?? ''}</span>`;
    el.onclick = () => openModal('event', e.id);
    sbEvents.appendChild(el);
  });
}

function softConflictEntries(plan = allocateSchedule()) {
  return plan.conflictSummary?.soft || [];
}

function renderReviewSidebar(plan = allocateSchedule()) {
  const wrap = document.getElementById('sb-review-wrap');
  const list = document.getElementById('sb-review');
  if (!wrap || !list) return;

  const soft = softConflictEntries(plan);
  wrap.classList.toggle('hidden', !soft.length);
  list.innerHTML = '';

  soft.slice(0, 4).forEach(info => {
    const task = S.tasks.find(t => t.id === info.taskId);
    if (!task) return;
    const el = document.createElement('div');
    el.className = 'sb-pill review';
    el.innerHTML = `<span class="sb-dot" style="background:${safeColor(task.color, '#9b9b9b')}"></span>
      <span class="sb-name">${escapeHtml(task.name)}</span>
      <span class="sb-hrs">${roundHours(info.shortfall)}h short</span>`;
    el.onclick = () => openReviewPanel(info.taskId);
    list.appendChild(el);
  });
}

/* ── Week view ── */
function renderWeek() {
  const ws = weekStartDate(S.weekOffset);
  const days = Array.from({length:7}, (_,i) => addDays(ws,i));
  const todayStr = ds(today());

  // Headers
  const head = document.getElementById('wk-head');
  head.innerHTML = '<div></div>';
  days.forEach((d,i) => {
    const dStr = ds(d);
    const isT = dStr === todayStr;
    const cell = document.createElement('div');
    cell.className = 'wk-head-cell';
    cell.innerHTML = `<div class="wk-dname">${DNAMES[i]}</div>
      <div class="wk-dnum${isT?' today':''}">${d.getDate()}</div>`;
    head.appendChild(cell);
  });

  // Intensity row
  const intRow = document.getElementById('wk-int');
  intRow.innerHTML = '<div class="wk-int-label">Daily<br>intensity</div>';
  days.forEach(d => {
    const dStr = ds(d);
    const val = getInt(dStr);
    const cell = document.createElement('div');
    cell.className = 'wk-int-cell';
    cell.innerHTML = `<input type="range" class="cal-slider-sm" min="1" max="10" value="${val}" data-d="${dStr}">
      <div class="wk-int-val" id="wiv-${dStr}">${val}</div>`;
    intRow.appendChild(cell);
  });
  intRow.querySelectorAll('input[type=range]').forEach(s => {
    updateSliderFill(s);
    s.addEventListener('input', () => {
      const v = +s.value;
      updateSliderFill(s);
      document.getElementById(`wiv-${s.dataset.d}`).textContent = v;
      setInt(s.dataset.d, v);
    });
  });

  // Body
  const body = document.getElementById('wk-body');
  body.innerHTML = '';

  // Time gutter — full 24 hours
  const gutter = document.createElement('div');
  gutter.className = 'wk-time-col';
  const startH = timeH(S.dayStart);
  const endH   = timeH(S.dayEnd);
  const GRID_START = 0;   // always start at midnight
  const GRID_END   = 24;  // always end at midnight
  for (let h = GRID_START; h < GRID_END; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'wk-time-slot';
    if (h === 0)       lbl.textContent = '12am';
    else if (h === 12) lbl.textContent = '12pm';
    else if (h > 12)   lbl.textContent = `${h-12}pm`;
    else               lbl.textContent = `${h}am`;
    // Mark working hours window
    if (h >= Math.floor(startH) && h < Math.ceil(endH)) {
      lbl.classList.add('wk-working-hour');
    }
    gutter.appendChild(lbl);
  }
  body.appendChild(gutter);

  // Day columns
  const hoursShown = GRID_END - GRID_START; // always 24
  days.forEach((d, i) => {
    const dStr = ds(d);
    const isT  = dStr === todayStr;
    const isWe = i >= 5;
    const col  = document.createElement('div');
    col.className = `wk-day-col${isT?' today-col':''}${isWe?' weekend':''}`;
    col.dataset.date = dStr;

    for (let h = GRID_START; h < GRID_END; h++) {
      const line = document.createElement('div');
      const isWorking = h >= Math.floor(startH) && h < Math.ceil(endH);
      line.className = 'wk-hr-line' + (isWorking ? ' working' : ' non-working');
      col.appendChild(line);
    }

    // Events
    eventsOnDay(dStr).forEach(ev => {
      const block = makeWeekBlock(ev, 'event', dStr);
      if (block) col.appendChild(block);
    });

    // Build a timeline of free slots around events for this day
    // Mandatory tasks first, then optional — placed in event-free gaps
    const dayEvents = eventsOnDay(dStr).map(ev => ({
      start: timeH(ev.start || '09:00'),
      end:   timeH(ev.end   || '10:00'),
    })).sort((a, b) => a.start - b.start);

    // Free slots: gaps in [startH, endH] not covered by events
    const freeSlots = [];
    let cursor = startH;
    dayEvents.forEach(ev => {
      if (ev.start > cursor) freeSlots.push({ start: cursor, end: ev.start });
      cursor = Math.max(cursor, ev.end);
    });
    if (cursor < endH) freeSlots.push({ start: cursor, end: endH });

    // Sort tasks: mandatory first, then optional
    const dayTasks = tasksOnDay(dStr)
      .map(t => ({ task: t, hrs: taskHoursOnDay(t, dStr) }))
      .filter(x => x.hrs > 0)
      .sort((a, b) => {
        if (a.task.priority === b.task.priority) return 0;
        return a.task.priority === 'mandatory' ? -1 : 1;
      });

    // Place tasks into free slots sequentially
    let slotIdx = 0;
    let slotCursor = freeSlots.length ? freeSlots[0].start : startH;

    dayTasks.forEach(({ task: t, hrs }) => {
      let remaining = hrs;
      while (remaining > 0.05 && slotIdx < freeSlots.length) {
        const slot = freeSlots[slotIdx];
        const available = slot.end - slotCursor;
        if (available <= 0.05) { slotIdx++; slotCursor = freeSlots[slotIdx]?.start ?? endH; continue; }
        const used   = Math.min(remaining, available);
        const topPx  = (slotCursor - 0) * 54; // offset from midnight (GRID_START=0)
        const block  = makeWeekBlock(t, 'task', dStr, used, topPx);
        if (block) col.appendChild(block);
        slotCursor += used;
        remaining  -= used;
        if (slotCursor >= slot.end - 0.05) { slotIdx++; slotCursor = freeSlots[slotIdx]?.start ?? endH; }
      }
    });

    body.appendChild(col);
  });

  // Init drag-and-drop on day columns
  requestAnimationFrame(initWeekDragTargets);

  // Auto-scroll to current time (or day start if not today's week)
  requestAnimationFrame(() => {
    const wkBody = document.getElementById('wk-body');
    if (!wkBody) return;
    const now = new Date();
    const scrollToH = days.some(d => ds(d) === ds(today()))
      ? now.getHours() + now.getMinutes() / 60 - 1 // 1hr before now
      : startH; // scroll to day start for other weeks
    wkBody.scrollTop = Math.max(0, scrollToH * 54);
  });
}

function makeWeekBlock(item, type, sourceDs, hours, stackTop) {
  const block = document.createElement('div');
  block.className = `wk-block${item.priority==='optional'?' optional':''}`;
  const color = safeColor(item.color);
  block.style.background = hexBg(color, 0.12);
  block.style.borderLeftColor = color;
  block.style.color = color;

  if (type === 'event') {
    const sh = timeH(item.start || '09:00');
    const eh = timeH(item.end   || '10:00');
    const dur = Math.max(eh - sh, 0.25);
    block.style.top    = ((sh - 0) * 54) + 'px'; // 0 = GRID_START (midnight)
    block.style.height = (dur * 54) + 'px';
    block.innerHTML = `<div class="wk-block-title">${escapeHtml(item.name)}</div>
      <div class="wk-block-sub">${item.start}–${item.end}</div>`;
  } else {
    block.style.top    = stackTop + 'px';
    block.style.height = (hours * 54) + 'px';
    const isFixed = hasManualOverrideForTaskDate(item.id, sourceDs);
    block.classList.toggle('user-fixed', isFixed);
    block.innerHTML = `<div class="wk-block-title">${escapeHtml(item.name)}</div>
      <div class="wk-block-sub">${Math.round(hours*10)/10}h${isFixed ? ' · fixed' : ''}</div>`;
  }

  if (type === 'task') {
    // Drag to reschedule
    block.draggable = true;
    block.dataset.taskId   = item.id;
    block.dataset.sourceDs = sourceDs;
    // A rendered day may contain several visual chunks around events. Moving
    // any chunk moves the occurrence's full allocation for that day.
    block.dataset.hrs      = taskHoursOnDay(item, sourceDs);
    block.addEventListener('dragstart', onTaskDragStart);
    block.addEventListener('click', e => { if (!e._wasDrag) openModal('task', item.id); });

    const actions = document.createElement('div');
    actions.className = 'wk-block-actions';
    const done = !!S.taskLog[item.id + '|' + sourceDs]?.checked;
    actions.innerHTML = `
      <button type="button" class="wk-block-action${done ? ' active' : ''}" title="${done ? 'Mark not done' : 'Mark done'}">${done ? '✓' : '○'}</button>
      <button type="button" class="wk-block-action" title="Adjust hours for this day">±</button>
      <button type="button" class="wk-block-action" title="Skip and reallocate">→</button>`;
    const [doneBtn, adjustBtn, skipBtn] = actions.querySelectorAll('button');
    doneBtn.addEventListener('click', e => {
      e.stopPropagation();
      toggleTaskLog(item, sourceDs, taskHoursOnDay(item, sourceDs));
    });
    adjustBtn.addEventListener('click', e => {
      e.stopPropagation();
      openDayHoursEditor(item.id, sourceDs);
    });
    skipBtn.addEventListener('click', e => {
      e.stopPropagation();
      skipTaskToTomorrow(item.id, sourceDs);
    });
    block.appendChild(actions);
  } else {
    block.onclick = () => openModal('event', item.id);
  }
  return block;
}

/* ── Agenda view ── */
function renderAgenda() {
  const ws = weekStartDate(S.weekOffset);
  const days = Array.from({length:7}, (_,i) => addDays(ws,i));
  const todayStr = ds(today());
  const body = document.getElementById('agenda-body');
  body.innerHTML = '';

  days.forEach((d, i) => {
    const dStr   = ds(d);
    const isT    = dStr === todayStr;
    const isPast = parseDate(dStr) < today() && !isT;
    const val    = getInt(dStr);
    const load   = totalLoadOnDay(dStr);
    const cap    = dailyCapacityOn(dStr);
    const overload = dayOverloadLevel(dStr);
    const tasks  = tasksOnDay(dStr);
    const events = eventsOnDay(dStr);

    // Overload class for load cell
    const loadClass = overload === 'hard' ? ' load-hard'
                    : overload === 'mild' ? ' load-mild' : '';
    const loadTitle  = overload !== 'none'
      ? ` title="${load}h scheduled, ${cap}h capacity"` : '';

    const dayEl = document.createElement('div');
    dayEl.className = 'ag-day';
    dayEl.dataset.date = dStr;
    dayEl.innerHTML = `
      <div class="ag-day-head">
        <div class="ag-date">
          <div class="ag-dname">${DFULL[i]}</div>
          <div class="ag-dnum${isT?' today':''}">${d.getDate()}</div>
        </div>
        <div class="ag-int-col">
          <div class="ag-int-lbl">Intensity</div>
          <div class="ag-int-row">
            <input type="range" class="ag-int-slider cal-slider-sm" min="1" max="10" value="${val}" data-d="${dStr}">
            <div class="ag-int-val${val < S.baseline ? ' int-low' : ''}" id="aiv-${dStr}">${val}</div>
          </div>
        </div>
        <div class="ag-load${loadClass}"${loadTitle}>
          <div class="ag-load-lbl">Load</div>
          <div class="ag-load-hrs">${load}h</div>
          ${overload !== 'none' ? `<div class="ag-load-cap">${cap}h cap</div>` : ''}
        </div>
      </div>`;

    // Event strips (compact one-liners)
    if (events.length) {
      const strips = document.createElement('div');
      strips.className = 'ag-event-strips';
      events.forEach(ev => {
        const rl = repeatLabel(ev);
        const strip = document.createElement('div');
        strip.className = 'ag-event-strip';
        strip.innerHTML = `
          <span class="ag-strip-dot" style="background:${safeColor(ev.color)}"></span>
          <span class="ag-strip-name">${escapeHtml(ev.name)}</span>
          <span class="ag-strip-time">${ev.start}–${ev.end}</span>
          ${rl ? `<span class="repeat-badge">${rl}</span>` : ''}`;
        strip.onclick = () => openModal('event', ev.id);
        strips.appendChild(strip);
      });
      dayEl.appendChild(strips);
    }

    // Task rows
    if (tasks.length) {
      const taskWrap = document.createElement('div');
      taskWrap.className = 'ag-task-rows';
      tasks.forEach(t => taskWrap.appendChild(makeAgendaTaskRow(t, dStr)));
      dayEl.appendChild(taskWrap);
    }

    if (!events.length && !tasks.length) {
      const empty = document.createElement('div');
      empty.className = 'ag-empty';
      empty.textContent = 'Nothing scheduled';
      dayEl.appendChild(empty);
    }

    // Redistribution notice for past days with missed tasks
    if (isPast && tasks.length) {
      const missed = tasks.filter(t => {
        const key = t.id + '|' + dStr;
        const e = S.taskLog[key];
        return !e || !e.checked;
      });
      if (missed.length) {
        const notice = document.createElement('div');
        notice.className = 'ag-redist-notice';
        const hrs = missed.reduce((sum, t) => sum + taskHoursOnDay(t, dStr), 0);
        const names = missed.map(t => escapeHtml(t.name)).join(', ');
        notice.innerHTML = `<span class="ag-redist-icon">↻</span>
          <span>${Math.round(hrs*10)/10}h from <strong>${names}</strong> redistributed to future days</span>`;
        dayEl.appendChild(notice);
      }
    }

    // Intensity slider
    const slider = dayEl.querySelector('.ag-int-slider');
    updateSliderFill(slider);
    slider.addEventListener('input', () => {
      const v = +slider.value;
      updateSliderFill(slider);
      document.getElementById(`aiv-${dStr}`).textContent = v;
      setInt(dStr, v);
    });

    body.appendChild(dayEl);
  });

  requestAnimationFrame(initAgendaDragTargets);
}

function repeatLabel(ev) {
  if (!ev.repeat || ev.repeat === 'none') return '';
  const map = {
    daily: 'Daily', weekly: 'Weekly', weekdays: 'Weekdays',
    weekends: 'Weekends', custom: 'Custom', interval: `Every ${ev.repeatInterval||7}d`
  };
  return map[ev.repeat] || '';
}

function makeAgendaTaskRow(task, dStr) {
  const el = document.createElement('div');
  const isPast = parseDate(dStr) < today();
  const logKey = task.id + '|' + dStr;
  const logEntry = S.taskLog[logKey];
  const isDone   = logEntry && logEntry.checked;
  const isMissed = isPast && !isDone;

  el.className = `ag-task-row${task.priority==='optional'?' optional':''}${isDone?' completed':''}${isMissed?' missed':''}`;
  const color = safeColor(task.color);
  el.style.setProperty('--task-color', color);

  const hrs = taskHoursOnDay(task, dStr);
  const avg = task.hours / Math.max(1, daysRemaining(task));
  const conflict = allocateSchedule().conflicts?.[task.id];
  let redistBadge = '';
  if (conflict?.type === 'soft') {
    redistBadge = `<span class="badge badge-reduced">${roundHours(conflict.shortfall)}h unscheduled</span>`;
  } else if (!isPast) {
    if (hrs < avg * 0.85) redistBadge = `<span class="badge badge-reduced">↓ reduced</span>`;
    else if (hrs > avg * 1.15) redistBadge = `<span class="badge badge-extra">↑ extra</span>`;
  }

  const taskRl    = repeatLabel(task);
  const priBadge  = task.priority === 'optional'
    ? `<span class="badge badge-opt">optional</span>`
    : task.priority === 'deferred' ? `<span class="badge badge-opt">deferred</span>` : '';
  const mandBadge = task.priority === 'mandatory' ? `<span class="badge">mandatory</span>` : '';
  const statusBadge = isDone
    ? `<span class="badge badge-done">done</span>`
    : isMissed ? `<span class="badge badge-missed">missed</span>` : '';
  const fixedBadge = hasManualOverrideForTaskDate(task.id, dStr)
    ? `<span class="badge badge-fixed">fixed</span>` : '';

  const hrsDisplay = isDone
    ? `<div class="ag-task-hrs crossed">${hrs}h</div>`
    : `<div class="ag-task-hrs">${hrs}h</div>`;

  const checkbox = `<button type="button" class="ag-task-check" title="${isDone ? 'Mark not done' : 'Mark done'}">${isDone ? '✓' : ''}</button>`;

  el.innerHTML = `
    ${checkbox}
    <div class="ag-task-accent"></div>
    <div class="ag-task-name">${escapeHtml(task.name)}</div>
    <div class="ag-task-badges">
      ${mandBadge}${priBadge}${statusBadge}${fixedBadge}${redistBadge}
      ${taskRl ? `<span class="repeat-badge">${taskRl}</span>` : ''}
    </div>
    ${hrsDisplay}`;

  const checkBtn = el.querySelector('.ag-task-check');
  checkBtn.addEventListener('click', e => {
    e.stopPropagation();
    toggleTaskLog(task, dStr, hrs);
  });

  if (!isPast) {
    el.draggable = true;
    el.dataset.taskId = task.id;
    el.dataset.sourceDs = dStr;
    el.dataset.hrs = hrs;
    el.addEventListener('dragstart', onTaskDragStart);

    const skipBtn = document.createElement('button');
    skipBtn.className = 'ag-skip-btn';
    skipBtn.textContent = 'Skip →';
    skipBtn.title = 'Reallocate this work to later eligible days';
    skipBtn.addEventListener('click', e => {
      e.stopPropagation();
      skipTaskToTomorrow(task.id, dStr);
    });
    el.appendChild(skipBtn);

    const adjustBtn = document.createElement('button');
    adjustBtn.className = 'ag-skip-btn';
    adjustBtn.textContent = 'Adjust';
    adjustBtn.title = 'Fix a different number of hours on this day';
    adjustBtn.addEventListener('click', e => {
      e.stopPropagation();
      openDayHoursEditor(task.id, dStr);
    });
    el.appendChild(adjustBtn);

    if (hasManualOverrideForTaskDate(task.id, dStr)) {
      const autoBtn = document.createElement('button');
      autoBtn.className = 'ag-skip-btn';
      autoBtn.textContent = 'Auto';
      autoBtn.title = 'Return this day to automatic scheduling';
      autoBtn.addEventListener('click', e => {
        e.stopPropagation();
        returnTaskDayToAuto(task.id, dStr);
      });
      el.appendChild(autoBtn);
    }
  }
  el.addEventListener('click', () => openModal('task', task.id));
  return el;
}

function toggleTaskLog(task, dStr, scheduledHrs) {
  const key = task.id + '|' + dStr;
  const entry = S.taskLog[key];
  if (!entry || !entry.checked) {
    // Mark as done — fully completed
    S.taskLog[key] = { scheduled: scheduledHrs, completed: scheduledHrs, checked: true };
  } else if (parseDate(dStr) >= today()) {
    // Undoing a current/future completion returns it to neutral. Recording it
    // as missed here would immediately add the same hours back as carryover.
    delete S.taskLog[key];
  } else {
    // Uncheck — mark as missed (0 completed)
    S.taskLog[key] = { scheduled: scheduledHrs, completed: 0, checked: false };
  }
  invalidatePlan();
  save(); render();
  showToast(S.taskLog[key]?.checked ? 'Marked done' : 'Marked not done');
}

/* ══════════════════════════════════════════
   CONFLICT RESOLUTION SYSTEM
══════════════════════════════════════════ */

/* ── State for conflict dialog ── */
let _conflictTask = null;   // the task obj being resolved
let _conflictData = null;   // {avail, needed, shortfall, days, suggested}
let _overworkDays = {};     // dateStr → bool
let _demotedTasks = {};     // task id → bool
let _intensityOverrides = {}; // dateStr → newVal

function showConflictDialog(conflict, taskObj) {
  _conflictTask = taskObj;
  _conflictData = conflict;
  _overworkDays = {};
  _demotedTasks = {};
  _intensityOverrides = {};

  // Populate static text
  document.getElementById('conflict-task-name').textContent = taskObj.name + ' — ' + taskObj.hours + 'h estimated';
  const summaryMsg = conflict.allBlocked
    ? 'Events fill all available time before the deadline — no free hours remain for tasks.'
    : 'Only ' + conflict.avail + 'h available before the deadline. ' + conflict.shortfall + 'h cannot be scheduled.';
  document.getElementById('conflict-summary').textContent = summaryMsg;
  document.getElementById('cs-hours').textContent  = taskObj.hours + 'h';
  document.getElementById('cs-avail').textContent  = conflict.avail + 'h';
  document.getElementById('cs-avail-sub').textContent = 'across ' + conflict.days + ' day' + (conflict.days!==1?'s':'');
  document.getElementById('cs-short').textContent  = '−' + conflict.shortfall + 'h';

  // Suggestion
  const sugText = document.getElementById('csug-text');
  if (conflict.suggested) {
    const sugD = parseDate(conflict.suggested);
    const sugFmt = sugD.toLocaleDateString('en-GB', {day:'numeric', month:'short'});
    sugText.innerHTML = '<strong>Extend deadline to ' + sugFmt + '.</strong> That\'s the earliest date where all ' + taskObj.hours + 'h can be fully scheduled at your current intensity.';
    document.getElementById('conflict-suggestion').classList.remove('hidden');
  } else {
    document.getElementById('conflict-suggestion').classList.add('hidden');
  }

  // Option 1 — deadline picker
  document.getElementById('copt-deadline').value = conflict.suggested || taskObj.deadline;
  updateDeadlineBadge();

  // Option 2 — hours reduction
  document.getElementById('copt-hours').value = conflict.avail;
  document.getElementById('copt-hours-note').textContent = 'Max that fits by current deadline: ' + conflict.avail + 'h';

  // Option 3 — overwork day chips
  buildOverworkChips();

  // Option 4 — save note
  document.getElementById('copt-saveas-note').textContent =
    conflict.shortfall + 'h will remain unscheduled. Overload warnings will appear on affected days.';

  // Option 5 — other mandatory tasks
  buildDemoteList();

  // Option 6 — intensity rows
  buildIntensityRows();

  // Select nothing by default
  for (let i=1;i<=7;i++) document.getElementById('copt-'+i)?.classList.remove('selected');

  document.getElementById('conflict-bg').classList.remove('hidden');
}

function closeConflict() {
  document.getElementById('conflict-bg').classList.add('hidden');
  _pendingTask = null;
  _conflictTask = null;
}

function discardConflictTask() {
  closeConflict();
  // Task was never committed, so nothing to remove
}

function selectCopt(n) {
  for (let i=1;i<=7;i++) {
    const el = document.getElementById('copt-'+i);
    if (el) el.classList.toggle('selected', i===n);
  }
}

function applySuggestion() {
  if (!_conflictData?.suggested) return;
  document.getElementById('copt-deadline').value = _conflictData.suggested;
  updateDeadlineBadge();
  selectCopt(1);
}

function updateDeadlineBadge() {
  const val = document.getElementById('copt-deadline').value;
  if (!val || !_conflictTask) return;

  const testTask = { ..._conflictTask, deadline: val };
  const { allocated, plan, taskId } = allocationForHypotheticalTask(testTask, val);
  const conflict = plan.conflicts?.[taskId];
  const shortfall = conflict
    ? Math.round((conflict.shortfall || 0) * 10) / 10
    : Math.round((testTask.hours - allocated) * 10) / 10;

  const badge = document.getElementById('copt-deadline-badge');
  const note  = document.getElementById('copt-deadline-note');
  if (shortfall <= 0) {
    badge.textContent = 'fits';
    badge.className = 'copt-badge ok';
    note.textContent = 'All ' + testTask.hours + 'h can be scheduled by this date.';
  } else {
    badge.textContent = 'still −' + shortfall + 'h short';
    badge.className = 'copt-badge';
    note.textContent = 'Choose a later date to fully resolve the conflict.';
  }
}

document.addEventListener('input', function(e) {
  if (e.target.id === 'copt-deadline') updateDeadlineBadge();
});

function buildOverworkChips() {
  const container = document.getElementById('copt-day-chips');
  container.innerHTML = '';
  const t = today();
  const end = parseDate(_conflictTask.deadline);
  let cur = new Date(t);
  while (cur <= end) {
    const dStr = ds(cur);
    const chip = document.createElement('div');
    chip.className = 'copt-day-chip';
    chip.textContent = cur.toLocaleDateString('en-GB', {weekday:'short', day:'numeric'});
    chip.dataset.date = dStr;
    chip.addEventListener('click', (e) => {
      e.stopPropagation();
      _overworkDays[dStr] = !_overworkDays[dStr];
      chip.classList.toggle('on', !!_overworkDays[dStr]);
      updateOverworkBadge();
    });
    container.appendChild(chip);
    cur = addDays(cur, 1);
  }
  updateOverworkBadge();
}

function updateOverworkBadge() {
  const extra = parseFloat(document.getElementById('copt-extra-hrs').value) || 0;
  const days = Object.values(_overworkDays).filter(Boolean).length;
  const freed = Math.round(days * extra * 10) / 10;
  const badge = document.getElementById('copt-overwork-badge');
  badge.textContent = freed > 0 ? '+' + freed + 'h freed' : '0h freed';
  badge.className = freed >= (_conflictData?.shortfall||0) ? 'copt-badge ok' : 'copt-badge';
}

function buildDemoteList() {
  const container = document.getElementById('copt-other-tasks');
  container.innerHTML = '';
  // Other mandatory tasks sorted by hours desc
  const others = S.tasks
    .filter(t => t.id !== _conflictTask.id && t.priority === 'mandatory' && t.deadline >= ds(today()))
    .sort((a,b) => b.hours - a.hours);

  if (!others.length) {
    container.innerHTML = '<span class="copt-note">No other mandatory tasks to demote.</span>';
    return;
  }

  others.forEach(t => {
    const item = document.createElement('div');
    item.className = 'copt-task-item';
    item.innerHTML = `<div class="copt-check"></div>
      <div class="copt-task-name">${escapeHtml(t.name)}</div>
      <div class="copt-task-hrs">${t.hours}h</div>`;
    item.addEventListener('click', e => {
      e.stopPropagation();
      _demotedTasks[t.id] = !_demotedTasks[t.id];
      item.classList.toggle('checked', !!_demotedTasks[t.id]);
      item.querySelector('.copt-check').textContent = _demotedTasks[t.id] ? '✓' : '';
      updateDemoteBadge();
    });
    container.appendChild(item);
  });
  updateDemoteBadge();
}

function updateDemoteBadge() {
  let freed = 0;
  Object.entries(_demotedTasks).forEach(([id, checked]) => {
    if (!checked) return;
    const t = S.tasks.find(x => x.id === id);
    if (t) freed += t.hours;
  });
  freed = Math.round(freed * 10) / 10;
  const badge = document.getElementById('copt-demote-badge');
  badge.textContent = freed + 'h freed';
  badge.className = freed >= (_conflictData?.shortfall||0) ? 'copt-badge ok' : 'copt-badge';
}

function buildIntensityRows() {
  const container = document.getElementById('copt-int-rows');
  container.innerHTML = '';
  const t = today();
  const end = parseDate(_conflictTask.deadline);
  const baseline = S.baseline;
  let lowDays = [];
  let cur = new Date(t);
  while (cur <= end) {
    const dStr = ds(cur);
    const intVal = getInt(dStr);
    if (intVal < baseline) lowDays.push({ dStr, intVal, d: new Date(cur) });
    cur = addDays(cur, 1);
  }

  if (!lowDays.length) {
    container.innerHTML = '<span class="copt-note">No days below your baseline in this window.</span>';
    document.getElementById('copt-int-badge').textContent = '0h';
    return;
  }

  lowDays.forEach(({ dStr, intVal, d }) => {
    const row = document.createElement('div');
    row.className = 'copt-int-row';
    const dayLabel = d.toLocaleDateString('en-GB', {weekday:'short', day:'numeric'});
    row.innerHTML = `<div class="copt-int-day">${dayLabel}</div>
      <div class="copt-int-from">${intVal} →</div>
      <input type="number" class="copt-input copt-int-input" value="${baseline}" min="${intVal}" max="10" data-date="${dStr}" data-orig="${intVal}">
      <span class="copt-badge" id="cib-${dStr}"></span>`;
    container.appendChild(row);
  });

  container.querySelectorAll('.copt-int-input').forEach(inp => {
    inp.addEventListener('input', e => { e.stopPropagation(); updateIntBadges(); });
    inp.addEventListener('click', e => e.stopPropagation());
  });
  updateIntBadges();
}

function updateIntBadges() {
  let totalFreed = 0;
  document.querySelectorAll('.copt-int-input').forEach(inp => {
    const dStr = inp.dataset.date;
    const orig = +inp.dataset.orig;
    const newVal = Math.min(10, Math.max(orig, +inp.value || orig));
    _intensityOverrides[dStr] = newVal;
    // Extra free hours = difference in free capacity at new vs old intensity
    const maxH    = S.maxDailyHours || 8;
    const evHrs   = eventHoursOnDay(dStr);
    const oldFree = Math.max(0, Math.min(24, (orig / S.baseline) * maxH) - evHrs);
    const newFree = Math.max(0, Math.min(24, (newVal / S.baseline) * maxH) - evHrs);
    const extra   = Math.round((newFree - oldFree) * 10) / 10;
    totalFreed += extra;
    const badge = document.getElementById('cib-' + dStr);
    if (badge) { badge.textContent = extra > 0 ? '+' + extra + 'h' : '0h'; }
  });
  totalFreed = Math.round(totalFreed * 10) / 10;
  const badge = document.getElementById('copt-int-badge');
  if (badge) badge.textContent = totalFreed + 'h freed';
  const note = document.getElementById('copt-int-note');
  if (note) note.textContent = totalFreed < (_conflictData?.shortfall||0) ? '— best combined with another option' : '';
  const cls = totalFreed >= (_conflictData?.shortfall||0) ? 'copt-badge ok' : 'copt-badge';
  if (badge) badge.className = cls;
}

function cloneStateForProposal() {
  return JSON.parse(JSON.stringify(S));
}

function applyConflictSelectionToState(selected, baseTask, editId) {
  const task = { ...baseTask };

  if (selected === 1) {
    const newDeadline = document.getElementById('copt-deadline').value;
    if (!newDeadline) return null;
    task.deadline = newDeadline;
    if (!task.repeat || task.repeat === 'none') task.date = newDeadline;
  } else if (selected === 2) {
    task.hours = Math.max(0.5, parseFloat(document.getElementById('copt-hours').value) || 0.5);
  } else if (selected === 4) {
    task.priority = 'optional';
  } else if (selected === 5) {
    Object.entries(_demotedTasks).forEach(([id, checked]) => {
      if (!checked) return;
      const t = S.tasks.find(x => x.id === id);
      if (t) t.priority = 'optional';
    });
  } else if (selected === 6) {
    Object.entries(_intensityOverrides).forEach(([dStr, val]) => {
      S.intensities[dStr] = val;
    });
  } else if (selected === 7) {
    // "Save anyway" means this task accepts partial scheduling. It must not
    // displace already accepted mandatory work on the next full recalculation.
    task.priority = 'deferred';
  }

  _commitTask(task, editId);

  if (selected === 3) {
    // Overwork is intentionally added after _commitTask, because editing a task
    // clears stale allowances for that task id.
    if (!S.taskOverworkAllowances) S.taskOverworkAllowances = {};
    const extra = parseFloat(document.getElementById('copt-extra-hrs').value) || 0;
    Object.entries(_overworkDays).forEach(([dStr, on]) => {
      if (!on || extra <= 0) return;
      const key = task.id + '|' + task.deadline + '|' + dStr;
      S.taskOverworkAllowances[key] = roundHours(extra);
    });
    invalidatePlan();
  }

  return task;
}

function verifyConflictResolution(selected, baseTask, editId) {
  const originalState = S;
  const originalPlan = _plan;
  const originalPlanKey = _planKey;
  const draftState = cloneStateForProposal();

  try {
    S = draftState;
    invalidatePlan();
    const proposedTask = applyConflictSelectionToState(selected, baseTask, editId);
    if (!proposedTask) return { ok: false, message: 'Please complete the selected option.' };
    const fixedHours = maximumFixedHoursForTask(proposedTask.id);
    if (fixedHours > proposedTask.hours + ALLOC_EPSILON) {
      return {
        ok: false,
        shortfall: 0,
        hardConflicts: [],
        proposedTask,
        message: `This task has ${fixedHours}h fixed across one occurrence. Adjust those days before reducing the total estimate.`,
      };
    }

    const plan = allocateSchedule();
    const conflict = plan.conflicts?.[proposedTask.id];
    const shortfall = roundHours(conflict?.shortfall || 0);
    const softOnly = conflict?.type === 'soft' && occurrencePriorityRank({ priority: proposedTask.priority || 'mandatory' }) > 1;
    const hardConflicts = plan.conflictSummary?.hard || [];
    const acceptsSoftShortfall = selected === 4 || selected === 7;
    return {
      ok: (shortfall <= ALLOC_EPSILON || (softOnly && acceptsSoftShortfall)) && hardConflicts.length === 0,
      shortfall,
      hardConflicts,
      proposedTask,
    };
  } finally {
    S = originalState;
    _plan = originalPlan;
    _planKey = originalPlanKey;
  }
}

function applyConflictResolution() {
  // Find selected option
  let selected = 0;
  for (let i=1;i<=7;i++) {
    if (document.getElementById('copt-'+i)?.classList.contains('selected')) { selected = i; break; }
  }
  if (!selected) { showToast('Please select a resolution option'); return; }

  const task = { ..._conflictTask };
  const editId = _pendingTask?.editingId || (S.tasks.some(t => t.id === task.id) ? task.id : null);

  if (selected !== 7) {
    const verified = verifyConflictResolution(selected, task, editId);
    if (!verified.ok) {
      const remaining = verified.shortfall !== undefined ? verified.shortfall : _conflictData?.shortfall;
      const otherHard = (verified.hardConflicts || []).filter(c => c.taskId !== task.id);
      if (otherHard.length) {
        showToast(`That would leave ${otherHard.length} mandatory task${otherHard.length!==1?'s':''} short. Add more capacity or choose another option.`);
      } else {
        showToast(verified.message || `Still ${remaining}h short. Choose another option or add more capacity.`);
      }
      return;
    }
  }

  const proposedTask = applyConflictSelectionToState(selected, task, editId);
  if (!proposedTask) { showToast('Please complete the selected option'); return; }

  // Commit the task
  closeConflict();
  save(); render();
  if (selected === 7) {
    revalidateExistingTasks(false);
    showToast('Saved with unresolved scheduling conflict');
  } else {
    showToast('Saved');
  }
}

function softConflictInfoForTask(task) {
  const plan = allocateSchedule();
  const info = plan.conflicts?.[task.id];
  if (!info || info.type !== 'soft') return null;

  return {
    avail: roundHours(info.allocated || 0),
    needed: roundHours(info.needed || task.hours),
    shortfall: roundHours(info.shortfall || 0),
    days: Math.max(1, (info.occurrences || []).length),
    suggested: null,
    allBlocked: false,
    soft: true,
  };
}

function openReviewPanel(taskId) {
  const bg = document.getElementById('review-bg');
  const list = document.getElementById('review-list');
  const summary = document.getElementById('review-summary');
  if (!bg || !list || !summary) return;

  const plan = allocateSchedule();
  const soft = softConflictEntries(plan);
  const entries = taskId ? soft.filter(c => c.taskId === taskId) : soft;

  summary.textContent = soft.length
    ? `${soft.length} task${soft.length!==1?'s':''} with unscheduled hours`
    : 'No tasks need review.';

  list.innerHTML = '';
  if (!entries.length) {
    const empty = document.createElement('div');
    empty.className = 'review-empty';
    empty.textContent = 'Nothing needs review right now.';
    list.appendChild(empty);
  }

  entries.forEach(info => {
    const task = S.tasks.find(t => t.id === info.taskId);
    if (!task) return;
    const card = document.createElement('div');
    card.className = 'review-item';
    const scheduled = roundHours(info.allocated || 0);
    const needed = roundHours(info.needed || task.hours);
    const shortfall = roundHours(info.shortfall || 0);
    const reason = info.reason === 'accepted_shortfall'
      ? 'Saved with hours intentionally left unscheduled'
      : info.reason === 'displaced_by_higher_priority'
      ? 'Lower priority than scheduled work'
      : info.reason === 'event_blocked'
        ? 'Blocked by events'
        : 'Not enough remaining capacity';

    card.innerHTML = `
      <div class="review-item-head">
        <span class="sb-dot" style="background:${safeColor(task.color, '#9b9b9b')}"></span>
        <div class="review-title-wrap">
          <div class="review-title">${escapeHtml(task.name)}</div>
          <div class="review-reason">${reason}</div>
        </div>
        <span class="review-badge">${shortfall}h short</span>
      </div>
      <div class="review-meter">
        <div class="review-meter-fill" style="width:${needed ? Math.min(100, (scheduled / needed) * 100) : 0}%"></div>
      </div>
      <div class="review-stats">
        <span>${scheduled}h scheduled</span>
        <span>${needed}h needed</span>
      </div>
      <div class="review-actions">
        <button class="btn-ghost" data-action="edit">Edit</button>
        <button class="btn-primary" data-action="resolve">Resolve</button>
        <button class="btn-ghost" data-action="keep">Keep deferred</button>
      </div>`;

    card.querySelector('[data-action="edit"]').onclick = () => {
      closeReviewPanel();
      openModal('task', task.id);
    };
    card.querySelector('[data-action="resolve"]').onclick = () => {
      openSoftConflictResolution(task);
    };
    card.querySelector('[data-action="keep"]').onclick = () => {
      showToast(`${task.name} kept deferred`);
    };
    list.appendChild(card);
  });

  bg.classList.remove('hidden');
}

function closeReviewPanel() {
  document.getElementById('review-bg')?.classList.add('hidden');
}

function openSoftConflictResolution(task) {
  const conflict = softConflictInfoForTask(task);
  if (!conflict) {
    showToast('This task no longer needs review');
    render();
    return;
  }
  closeReviewPanel();
  _pendingTask = { obj: { ...task }, editingId: task.id, isEdit: true };
  showConflictDialog(conflict, { ...task });
}

function showOverloadToast(msg) {
  const existing = document.getElementById('overload-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'overload-toast';
  el.className = 'overload-toast';
  const text = document.createElement('span');
  text.className = 'overload-toast-text';
  text.textContent = msg;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = '✕';
  close.onclick = () => el.remove();
  el.append(text, close);
  document.body.appendChild(el);
  // Auto-dismiss after 8s
  setTimeout(() => { if (el.parentNode) el.remove(); }, 8000);
}

function daysRemaining(task) {
  const deadline = parseDate(task.deadline);
  const t = today();
  let n = 0, cur = new Date(t);
  while (cur <= deadline) { n++; cur = addDays(cur,1); }
  return n;
}

/* ── Settings view ── */
function renderSettings() {
  // Sync baseline slider
  const bs = document.getElementById('settings-baseline-slider');
  bs.value = S.baseline;
  requestAnimationFrame(() => updateSliderFill(bs));
  document.getElementById('settings-baseline-num').textContent = S.baseline;
  document.getElementById('settings-baseline-desc').textContent = intensityDesc(S.baseline);

  // Sync distribution radio
  const radios = document.querySelectorAll('input[name="settings-dist"]');
  radios.forEach(r => { r.checked = r.value === S.distribution; });

  // Sync working hours
  document.getElementById('settings-day-start').value = S.dayStart;
  document.getElementById('settings-day-end').value   = S.dayEnd;

  // Sync max daily hours
  const mdh = document.getElementById('settings-max-daily-hours');
  if (mdh) mdh.value = S.maxDailyHours || 8;
}

function saveBaseline() {
  S.baseline = +document.getElementById('settings-baseline-slider').value;
  S.intensityHistory = [];
  S.nudgeDismissed   = false;
  document.getElementById('nudge').classList.add('hidden');
  save(); render();
  revalidateExistingTasks(true);
  showToast('Baseline saved');
}

function saveDist() {
  const checked = document.querySelector('input[name="settings-dist"]:checked');
  if (checked) S.distribution = checked.value;
  save(); render();
  showToast('Distribution saved');
}

function saveWorkingHours() {
  S.dayStart = document.getElementById('settings-day-start').value;
  S.dayEnd   = document.getElementById('settings-day-end').value;
  const mdh = document.getElementById('settings-max-daily-hours');
  if (mdh) S.maxDailyHours = Math.max(0.5, parseFloat(mdh.value) || 8);
  save(); render();
  revalidateExistingTasks(true);
  showToast('Working hours saved');
}

function resetData() {
  if (!confirm('Clear all tasks, events and intensity data? You can undo this until the page closes.')) return;
  snapshotForUndo('clear all data');
  S.tasks = []; S.events = []; S.intensities = {}; S.intensityHistory = [];
  S.taskLog = {}; S.manualOverrides = {}; S.taskOverworkAllowances = {};
  invalidatePlan();
  save(); render();
  showToast('Data cleared');
}

/* ══════════════════════════════════════════
   MODAL
══════════════════════════════════════════ */
function onTaskRepeatChange() {
  const val = document.getElementById('f-task-repeat').value;
  const isRepeat = val !== 'none';
  document.getElementById('task-repeat-custom').classList.toggle('hidden', val !== 'custom');
  document.getElementById('task-repeat-interval').classList.toggle('hidden', val !== 'interval');
  document.getElementById('task-repeat-end-wrap').classList.toggle('hidden', !isRepeat);
  document.getElementById('task-start-date-row').classList.toggle('hidden', !isRepeat);
  // When repeating, deadline becomes "occurs every X" and start date is the anchor
  document.getElementById('task-deadline-label').textContent = isRepeat ? 'First occurrence' : 'Deadline';
  if (isRepeat) {
    const first = document.getElementById('f-deadline').value;
    const start = document.getElementById('f-task-start-date');
    if (first && (!start.value || start.value === ds(today()))) start.value = first;
  }
}

function onTaskRepeatEndChange() {
  const val = document.getElementById('f-task-repeat-end-type').value;
  document.getElementById('task-repeat-end-date-wrap').classList.toggle('hidden', val !== 'date');
  document.getElementById('task-repeat-end-count-wrap').classList.toggle('hidden', val !== 'count');
}

function onRepeatChange() {
  const val = document.getElementById('f-repeat').value;
  document.getElementById('repeat-custom').classList.toggle('hidden', val !== 'custom');
  document.getElementById('repeat-interval').classList.toggle('hidden', val !== 'interval');
  document.getElementById('repeat-end-wrap').classList.toggle('hidden', val === 'none');
}

function onRepeatEndChange() {
  const val = document.getElementById('f-repeat-end-type').value;
  document.getElementById('repeat-end-date-wrap').classList.toggle('hidden', val !== 'date');
  document.getElementById('repeat-end-count-wrap').classList.toggle('hidden', val !== 'count');
}

function onTypeChange() {
  const type = document.getElementById('f-type').value;
  document.getElementById('task-fields').classList.toggle('hidden', type !== 'task');
  document.getElementById('event-fields').classList.toggle('hidden', type !== 'event');
}

function manualOverrideKeysForTask(taskId) {
  return Object.keys(S.manualOverrides || {}).filter(key => (
    key === taskId || key.startsWith(taskId + '|occ|')
  ));
}

function maximumFixedHoursForTask(taskId) {
  return manualOverrideKeysForTask(taskId).reduce((maximum, key) => {
    const override = S.manualOverrides[key] || {};
    const fixed = Object.values(override.pinned || {})
      .reduce((sum, hours) => sum + Math.max(0, +hours || 0), 0);
    return Math.max(maximum, roundHours(fixed));
  }, 0);
}

function updateTaskManualControls(taskId) {
  const controls = document.getElementById('task-manual-controls');
  if (!controls) return;
  const keys = taskId ? manualOverrideKeysForTask(taskId) : [];
  const dayCount = keys.reduce((count, key) => {
    const override = S.manualOverrides[key] || {};
    return count + new Set([
      ...Object.keys(override.pinned || {}),
      ...(override.excludedDates || []),
    ]).size;
  }, 0);
  controls.classList.toggle('hidden', dayCount === 0);
  document.getElementById('task-manual-summary').textContent =
    `${dayCount} day${dayCount === 1 ? '' : 's'} fixed by you. Calico will not change them automatically.`;
}

function returnEditedTaskToAuto() {
  if (!editingId) return;
  const keys = manualOverrideKeysForTask(editingId);
  if (!keys.length) return;
  snapshotForUndo('return task to automatic scheduling');
  keys.forEach(key => delete S.manualOverrides[key]);
  invalidatePlan();
  save();
  render();
  updateTaskManualControls(editingId);
  showToast('All days for this task are automatic again');
}

function openModal(type, id) {
  editingId   = id ?? null;
  editingType = type;
  pickedColor = '#111111';

  document.getElementById('modal-title-text').textContent = id ? `Edit ${type}` : `Add ${type}`;
  document.getElementById('modal-del').classList.toggle('hidden', !id);
  document.getElementById('f-type').value = type;
  onTypeChange();

  const todayVal = ds(today());
  document.getElementById('f-deadline').value = todayVal;
  document.getElementById('f-date').value     = todayVal;

  if (id) {
    const item = type==='task'
      ? S.tasks.find(x=>x.id===id)
      : S.events.find(x=>x.id===id);
    if (item) {
      document.getElementById('f-name').value     = item.name;
      document.getElementById('f-type').value     = item.type || type;
      document.getElementById('f-priority').value = item.priority || 'mandatory';
      onTypeChange();
      if ((item.type||type) === 'task') {
        document.getElementById('f-deadline').value     = item.deadline || todayVal;
        document.getElementById('f-task-start-date').value = item.date || item.deadline || todayVal;
        document.getElementById('f-hours').value        = item.hours || 4;
        document.getElementById('f-dist').value         = item.dist     || 'inherit';
        document.getElementById('f-not-before').value    = item.notBefore || '';
        document.getElementById('f-task-repeat').value  = item.repeat || 'none';
        onTaskRepeatChange();
        if (item.repeat && item.repeat !== 'none') {
          document.getElementById('f-task-start-date').value = item.date || todayVal;
          document.getElementById('f-task-repeat-end-type').value = item.repeatEndType || 'date';
          onTaskRepeatEndChange();
          document.getElementById('f-task-repeat-end-date').value = item.repeatEndDate || '';
          document.getElementById('f-task-repeat-count').value    = item.repeatCount || 10;
          if (item.repeat === 'custom') {
            document.querySelectorAll('input[name="trday"]').forEach(cb => {
              cb.checked = (item.repeatDays || []).includes(+cb.value);
            });
          }
          if (item.repeat === 'interval') {
            document.getElementById('f-task-interval').value = item.repeatInterval || 7;
          }
        }
      } else {
        document.getElementById('f-date').value    = item.date  || todayVal;
        document.getElementById('f-start').value  = item.start || '09:00';
        document.getElementById('f-end').value    = item.end   || '10:00';
        document.getElementById('f-repeat').value = item.repeat || 'none';
        onRepeatChange();
        if (item.repeat === 'custom') {
          document.querySelectorAll('input[name="rday"]').forEach(cb => {
            cb.checked = (item.repeatDays || []).includes(+cb.value);
          });
        }
        if (item.repeat === 'interval') {
          document.getElementById('f-interval').value = item.repeatInterval || 7;
        }
        if (item.repeat && item.repeat !== 'none') {
          document.getElementById('f-repeat-end-type').value = item.repeatEndType || 'date';
          onRepeatEndChange();
          document.getElementById('f-repeat-end-date').value  = item.repeatEndDate  || '';
          document.getElementById('f-repeat-count').value     = item.repeatCount    || 10;
        }
      }
      pickedColor = item.color || '#111111';
    }
  } else {
    document.getElementById('f-name').value          = '';
    document.getElementById('f-priority').value       = 'mandatory';
    document.getElementById('f-hours').value          = 4;
    document.getElementById('f-dist').value           = 'inherit';
    document.getElementById('f-not-before').value    = '';
    document.getElementById('f-start').value          = '09:00';
    document.getElementById('f-end').value            = '10:00';
    document.getElementById('f-repeat').value         = 'none';
    document.getElementById('f-task-repeat').value    = 'none';
    document.getElementById('f-task-start-date').value = ds(today());
    onRepeatChange();
    onTaskRepeatChange();
    document.querySelectorAll('input[name="rday"]').forEach(cb => { cb.checked = false; });
    document.querySelectorAll('input[name="trday"]').forEach(cb => { cb.checked = false; });
  }

  updateTaskManualControls(type === 'task' ? id : null);
  syncColourPicker();
  document.getElementById('modal-bg').classList.remove('hidden');
  document.getElementById('f-name').focus();
}

function closeModal() {
  document.getElementById('modal-bg').classList.add('hidden');
  editingId = null;
}

function saveItem() {
  const name = document.getElementById('f-name').value.trim();
  if (!name) { document.getElementById('f-name').focus(); return; }
  const type     = document.getElementById('f-type').value;
  const priority = document.getElementById('f-priority').value;
  const color    = pickedColor;

  if (type === 'task') {
    const repeatVal = document.getElementById('f-task-repeat').value;
    const obj = {
      id: editingId || uid(),
      type: 'task', name, priority, color,
      deadline: document.getElementById('f-deadline').value,
      date:     document.getElementById('f-deadline').value,
      hours:    parseFloat(document.getElementById('f-hours').value) || 4,
      dist:       document.getElementById('f-dist').value,
      notBefore:  document.getElementById('f-not-before').value || null,
      logged:   0,
      repeat:   repeatVal,
    };
    if (repeatVal !== 'none') {
      // For repeating tasks, the visible "First occurrence" date is the
      // recurrence anchor. Keep date/deadline aligned so the first occurrence
      // does not silently anchor to today's default start date.
      obj.date = obj.deadline;
      const endType = document.getElementById('f-task-repeat-end-type').value;
      obj.repeatEndType = endType;
      if (endType === 'date') {
        obj.repeatEndDate = document.getElementById('f-task-repeat-end-date').value;
      } else {
        obj.repeatCount = parseInt(document.getElementById('f-task-repeat-count').value) || 10;
      }
      if (repeatVal === 'custom') {
        obj.repeatDays = Array.from(document.querySelectorAll('input[name="trday"]:checked'))
          .map(cb => +cb.value);
      }
      if (repeatVal === 'interval') {
        obj.repeatInterval = parseInt(document.getElementById('f-task-interval').value) || 7;
      }
    }

    const fixedHours = editingId ? maximumFixedHoursForTask(editingId) : 0;
    if (fixedHours > obj.hours + ALLOC_EPSILON) {
      showToast(`This task has ${fixedHours}h fixed across one occurrence. Release or reduce those days first.`);
      return;
    }

    // Check conflict before committing
    const conflict = computeConflict(obj);
    if (conflict) {
      _pendingTask = { obj, editingId: editingId, isEdit: !!editingId };
      document.getElementById('modal-bg').classList.add('hidden');
      showConflictDialog(conflict, obj);
      return;
    }

    // No conflict — commit
    _commitTask(obj, editingId);
    document.getElementById('modal-bg').classList.add('hidden');
    editingId = null;
    save(); render();

  } else {
    // Event — save directly
    const repeatVal = document.getElementById('f-repeat').value;
    const obj = {
      id: editingId || uid(),
      type: 'event', name, priority, color,
      date:  document.getElementById('f-date').value,
      start: document.getElementById('f-start').value,
      end:   document.getElementById('f-end').value,
      repeat: repeatVal,
    };
    if (repeatVal !== 'none') {
      const endType = document.getElementById('f-repeat-end-type').value;
      obj.repeatEndType = endType;
      if (endType === 'date') {
        obj.repeatEndDate = document.getElementById('f-repeat-end-date').value;
      } else {
        obj.repeatCount = parseInt(document.getElementById('f-repeat-count').value) || 10;
      }
      if (repeatVal === 'custom') {
        obj.repeatDays = Array.from(document.querySelectorAll('input[name="rday"]:checked'))
          .map(cb => +cb.value);
      }
      if (repeatVal === 'interval') {
        obj.repeatInterval = parseInt(document.getElementById('f-interval').value) || 7;
      }
    }
    if (editingId) {
      const i = S.events.findIndex(x => x.id === editingId);
      if (i >= 0) S.events[i] = obj;
    } else {
      S.events.push(obj);
    }
    document.getElementById('modal-bg').classList.add('hidden');
    editingId = null;
    save(); render();
    // Events reduce future capacity, so revalidate existing tasks immediately.
    revalidateExistingTasks(true);
  }
}

let _pendingTask = null;

function _commitTask(obj, eid) {
  // Remove stale task-scoped overwork allowances if a task is edited/replaced.
  if (eid && S.taskOverworkAllowances) {
    Object.keys(S.taskOverworkAllowances).forEach(k => {
      if (k.startsWith(eid + '|')) delete S.taskOverworkAllowances[k];
    });
  }

  if (eid) {
    const i = S.tasks.findIndex(x => x.id === eid);
    if (i >= 0) { obj.logged = S.tasks[i].logged ?? 0; S.tasks[i] = obj; }
    else S.tasks.push(obj);
  } else {
    S.tasks.push(obj);
  }
  invalidatePlan();

  // Preserve user-authored day constraints across ordinary task edits. If the
  // recurrence itself changed, discard only constraints whose occurrence no
  // longer exists.
  if (eid && S.manualOverrides) {
    const validOccurrenceIds = new Set(
      (allocateSchedule().occurrences || [])
        .filter(occ => occ.taskId === eid)
        .map(occ => occ.occId)
    );
    manualOverrideKeysForTask(eid).forEach(key => {
      if (!validOccurrenceIds.has(key)) delete S.manualOverrides[key];
    });
    invalidatePlan();
  }
}

function deleteItem() {
  if (!editingId) return;
  const item = S.tasks.find(x => x.id === editingId) || S.events.find(x => x.id === editingId);
  if (!item || !confirm(`Delete "${item.name || 'this item'}"?`)) return;
  snapshotForUndo(`delete ${item.name || 'item'}`);
  S.tasks  = S.tasks.filter(x=>x.id!==editingId);
  S.events = S.events.filter(x=>x.id!==editingId);
  if (S.manualOverrides) {
    Object.keys(S.manualOverrides).forEach(key => {
      if (key === editingId || key.startsWith(editingId + '|occ|')) delete S.manualOverrides[key];
    });
  }
  invalidatePlan();
  document.getElementById('modal-bg').classList.add('hidden');
  editingId = null;
  save(); render();
}

function syncColourPicker() {
  document.querySelectorAll('.col-dot').forEach(d => {
    d.classList.toggle('selected', d.dataset.c === pickedColor);
  });
}

document.addEventListener('click', function(e) {
  const dot = e.target.closest('.col-dot');
  if (dot && dot.closest('#colour-row')) {
    pickedColor = dot.dataset.c;
    syncColourPicker();
  }
  if (e.target.id === 'modal-bg') closeModal();
  if (e.target.id === 'conflict-bg') closeConflict();
  if (e.target.id === 'review-bg') closeReviewPanel();
  if (e.target.id === 'day-hours-bg') closeDayHoursEditor();
});

/* ══════════════════════════════════════════
   NAVIGATION
══════════════════════════════════════════ */
function setView(v) { S.view = v; save(); render(); }
function shiftWeek(d) { S.weekOffset += d; save(); render(); }
function goToday() { S.weekOffset = 0; save(); render(); }

/* ══════════════════════════════════════════
   NUDGE
══════════════════════════════════════════ */
function dismissNudge() {
  S.nudgeDismissed = true;
  document.getElementById('nudge').classList.add('hidden');
  save();
}

/* ══════════════════════════════════════════
   ONBOARDING
══════════════════════════════════════════ */
const INT_DESCS = {
  1:'Very light days — just a couple of focused hours.',
  2:'Short bursts of effort, plenty of rest.',
  3:'A few gentle hours, low pressure.',
  4:'Moderate, below your average.',
  5:'Balanced — around 4–5 focused hours.',
  6:'Solid output, comfortable but engaged.',
  7:'Around 6–7 focused hours with regular breaks.',
  8:'High-output days — sustained concentration.',
  9:'Near-peak effort, long focused sessions.',
  10:'Maximum intensity — fully on, all day.',
};
function intensityDesc(v) { return INT_DESCS[v] || ''; }

document.addEventListener('input', function(e) {
  if (e.target.classList.contains('cal-slider') || e.target.classList.contains('cal-slider-sm')) {
    updateSliderFill(e.target);
  }
  if (e.target.id === 'ob-slider') {
    document.getElementById('ob-num').textContent  = e.target.value;
    document.getElementById('ob-desc').textContent = intensityDesc(+e.target.value);
  }
  if (e.target.id === 'settings-baseline-slider') {
    document.getElementById('settings-baseline-num').textContent  = e.target.value;
    document.getElementById('settings-baseline-desc').textContent = intensityDesc(+e.target.value);
  }
});

function obNext(step) {
  document.getElementById(`ob-${step}`).classList.add('hidden');
  document.getElementById(`ob-${step+1}`).classList.remove('hidden');
}

function obFinish() {
  S.baseline     = +document.getElementById('ob-slider').value;
  const checked  = document.querySelector('input[name="dist"]:checked');
  S.distribution = checked ? checked.value : 'even';
  S.onboarded    = true;
  document.getElementById('onboarding').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  save(); render();
}

/* ══════════════════════════════════════════
   TOAST
══════════════════════════════════════════ */
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.classList.add('hidden'), 300);
  }, 2000);
}

/* ══════════════════════════════════════════
   UTILS
══════════════════════════════════════════ */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2,6);
}



/* ══════════════════════════════════════════
   DRAG TO RESCHEDULE + SKIP
══════════════════════════════════════════ */
let _dragTaskId   = null;
let _dragSourceDs = null;
let _dragHrs      = 0;

function onTaskDragStart(e) {
  _dragTaskId   = e.currentTarget.dataset.taskId;
  _dragSourceDs = e.currentTarget.dataset.sourceDs;
  _dragHrs      = parseFloat(e.currentTarget.dataset.hrs) || 0;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', _dragTaskId);
  e.currentTarget._wasDrag = true;
  setTimeout(() => { e.currentTarget._wasDrag = false; }, 200);
}

function initWeekDragTargets() {
  document.querySelectorAll('.wk-day-col').forEach(col => {
    col.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drag-over');
    });
    col.addEventListener('dragleave', () => col.classList.remove('drag-over'));
    col.addEventListener('drop', e => {
      e.preventDefault();
      col.classList.remove('drag-over');
      const targetDs = col.dataset.date;
      if (!targetDs || !_dragTaskId || targetDs === _dragSourceDs) return;
      moveTaskAllocation(_dragTaskId, _dragSourceDs, targetDs, _dragHrs);
    });
  });
}

function initAgendaDragTargets() {
  document.querySelectorAll('.ag-day').forEach(day => {
    day.addEventListener('dragover', event => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      day.classList.add('drag-over');
    });
    day.addEventListener('dragleave', () => day.classList.remove('drag-over'));
    day.addEventListener('drop', event => {
      event.preventDefault();
      day.classList.remove('drag-over');
      const targetDs = day.dataset.date;
      if (!targetDs || !_dragTaskId || targetDs === _dragSourceDs) return;
      moveTaskAllocation(_dragTaskId, _dragSourceDs, targetDs, _dragHrs);
    });
  });
}

function occurrenceForTaskDate(taskId, dateStr, plan = allocateSchedule()) {
  const occurrences = plan.occurrences || [];
  const allocated = occurrences.find(occ => (
    occ.taskId === taskId &&
    (plan.occurrenceAllocations?.[occ.occId]?.[dateStr] || 0) > ALLOC_PROGRESS_EPSILON
  ));
  if (allocated) return allocated;

  const constrained = occurrences.find(occ => {
    if (occ.taskId !== taskId) return false;
    const override = S.manualOverrides?.[occ.occId];
    return override && (
      Object.prototype.hasOwnProperty.call(override.pinned || {}, dateStr) ||
      (override.excludedDates || []).includes(dateStr)
    );
  });
  if (constrained) return constrained;

  return occurrences.find(occ => {
    if (occ.taskId !== taskId) return false;
    const start = parseDate(occ.notBefore || occ.windowStart);
    const date = parseDate(dateStr);
    return date >= start && date <= parseDate(occ.deadline) && occurrenceCanAllocateOn(occ, dateStr);
  }) || null;
}

function hasManualOverrideForTaskDate(taskId, dateStr, plan = allocateSchedule()) {
  const occ = occurrenceForTaskDate(taskId, dateStr, plan);
  if (!occ) return false;
  const override = S.manualOverrides?.[occ.occId];
  return !!override && (
    Object.prototype.hasOwnProperty.call(override.pinned || {}, dateStr) ||
    (override.excludedDates || []).includes(dateStr)
  );
}

function ensureManualOverride(occId) {
  if (!S.manualOverrides) S.manualOverrides = {};
  if (!S.manualOverrides[occId]) {
    S.manualOverrides[occId] = { pinned: {}, excludedDates: [] };
  }
  const override = S.manualOverrides[occId];
  override.pinned ||= {};
  override.excludedDates = Array.isArray(override.excludedDates) ? override.excludedDates : [];
  return override;
}

function cleanupManualOverride(occId) {
  const override = S.manualOverrides?.[occId];
  if (!override) return;
  override.pinned ||= {};
  override.excludedDates = Array.isArray(override.excludedDates) ? override.excludedDates : [];
  if (!Object.keys(override.pinned).length && !override.excludedDates.length) {
    delete S.manualOverrides[occId];
  }
}

function constraintHoursForDate(occ, dateStr) {
  const override = S.manualOverrides?.[occ.occId];
  if (!override) return undefined;
  if ((override.excludedDates || []).includes(dateStr)) return 0;
  if (Object.prototype.hasOwnProperty.call(override.pinned || {}, dateStr)) {
    return roundHours(override.pinned[dateStr]);
  }
  return undefined;
}

function constrainedDatesForOccurrence(occ) {
  const override = S.manualOverrides?.[occ.occId];
  if (!override) return [];
  return Array.from(new Set([
    ...Object.keys(override.pinned || {}),
    ...(override.excludedDates || []),
  ])).sort();
}

function setDayConstraint(occ, dateStr, hours) {
  const override = ensureManualOverride(occ.occId);
  const value = roundHours(Math.max(0, +hours || 0));
  delete override.pinned[dateStr];
  override.excludedDates = override.excludedDates.filter(date => date !== dateStr);
  if (value <= ALLOC_PROGRESS_EPSILON) {
    override.excludedDates.push(dateStr);
  } else {
    override.pinned[dateStr] = value;
  }
}

function releaseDayConstraint(occ, dateStr) {
  const override = S.manualOverrides?.[occ.occId];
  if (!override) return;
  delete override.pinned?.[dateStr];
  override.excludedDates = (override.excludedDates || []).filter(date => date !== dateStr);
  cleanupManualOverride(occ.occId);
}

function manualConstraintResult(occ, plan = allocateSchedule()) {
  const result = plan.occurrenceResults?.[occ.occId] || {
    allocated: 0,
    shortfall: occ.hours,
    fullyAllocated: false,
  };
  return {
    plan,
    allocated: roundHours(result.allocated || 0),
    shortfall: roundHours(result.shortfall || 0),
    fullyAllocated: !!result.fullyAllocated,
  };
}

function commitManualConstraint(label, previous, occ, focusDate, successMessage) {
  invalidatePlan();
  const result = manualConstraintResult(occ);
  snapshotForUndo(label, { ...S, manualOverrides: previous });
  save();
  render();

  if (!result.fullyAllocated) {
    openDayHoursEditor(occ.taskId, focusDate, occ.occId);
    showDayHoursWarning(result.shortfall);
    return result;
  }

  showToast(successMessage);
  return result;
}

function moveTaskAllocation(taskId, fromDs, toDs, hrs) {
  const beforePlan = allocateSchedule();
  const occ = occurrenceForTaskDate(taskId, fromDs, beforePlan);
  if (!occ) {
    showToast('That scheduled block could not be found');
    return false;
  }
  const earliest = occ.notBefore && parseDate(occ.notBefore) > parseDate(occ.windowStart)
    ? occ.notBefore : occ.windowStart;
  if (parseDate(toDs) < today() || parseDate(toDs) < parseDate(earliest) || parseDate(toDs) > parseDate(occ.deadline)) {
    showToast(`Move it between ${fmt(parseDate(earliest))} and ${fmt(parseDate(occ.deadline))}`);
    return false;
  }
  if (!occurrenceCanAllocateOn(occ, toDs)) {
    showToast('That occurrence cannot be scheduled on this day');
    return false;
  }

  const previous = cloneData(S.manualOverrides || {});
  const override = ensureManualOverride(occ.occId);
  const sourceWasFixed = constraintHoursForDate(occ, fromDs) !== undefined;
  const targetExisting = constraintHoursForDate(occ, toDs)
    ?? beforePlan.occurrenceAllocations?.[occ.occId]?.[toDs]
    ?? 0;
  delete override.pinned[fromDs];
  override.excludedDates = override.excludedDates.filter(d => d !== fromDs);
  if (!sourceWasFixed) {
    override.excludedDates.push(fromDs);
  }
  override.excludedDates = Array.from(new Set(override.excludedDates));
  override.excludedDates = override.excludedDates.filter(d => d !== toDs);
  // Pin the target's existing occurrence allocation as well as the moved
  // hours. Otherwise turning an automatically allocated target into a pinned
  // day silently discards the hours it already held.
  override.pinned[toDs] = roundHours(Math.min(+occ.hours || 0, targetExisting + hrs));

  const result = commitManualConstraint(
    'task move',
    previous,
    occ,
    toDs,
    `Moved to ${fmt(parseDate(toDs))}`
  );
  if (!result.fullyAllocated) {
    showToast(`Move saved; ${result.shortfall}h now needs adjusting`);
  }
  return true;
}

function skipTaskToTomorrow(taskId, dStr) {
  const beforePlan = allocateSchedule();
  const occ = occurrenceForTaskDate(taskId, dStr, beforePlan);
  if (!occ) {
    showToast('That scheduled work could not be found');
    return false;
  }

  const previous = cloneData(S.manualOverrides || {});
  setDayConstraint(occ, dStr, 0);
  const result = commitManualConstraint(
    'task skip',
    previous,
    occ,
    dStr,
    'Skipped and reallocated before the deadline'
  );
  if (!result.fullyAllocated) {
    showToast(`Skip saved; ${result.shortfall}h cannot fit before ${fmt(parseDate(occ.deadline))}`);
  }
  return true;
}

function returnTaskDayToAuto(taskId, dStr) {
  const plan = allocateSchedule();
  const occ = occurrenceForTaskDate(taskId, dStr, plan);
  if (!occ || constraintHoursForDate(occ, dStr) === undefined) {
    showToast('This day is already using automatic scheduling');
    return;
  }
  const previous = cloneData(S.manualOverrides || {});
  releaseDayConstraint(occ, dStr);
  commitManualConstraint(
    'return day to automatic scheduling',
    previous,
    occ,
    dStr,
    'This day is automatic again'
  );
}

let _dayHoursOccId = null;
let _dayHoursDate = null;
let _dayHoursOriginal = 0;

function dayHoursOccurrence() {
  const plan = allocateSchedule();
  return (plan.occurrences || []).find(occ => occ.occId === _dayHoursOccId) || null;
}

function maxConstraintHoursForDate(occ, dateStr) {
  const otherFixed = constrainedDatesForOccurrence(occ).reduce((sum, date) => {
    if (date === dateStr) return sum;
    return sum + Math.max(0, constraintHoursForDate(occ, date) || 0);
  }, 0);
  return roundHours(Math.max(0, (+occ.hours || 0) - otherFixed));
}

function openDayHoursEditor(taskId, dateStr, occurrenceId) {
  const plan = allocateSchedule();
  const occ = (plan.occurrences || []).find(candidate => candidate.occId === occurrenceId)
    || occurrenceForTaskDate(taskId, dateStr, plan);
  if (!occ) {
    showToast('That task occurrence could not be found');
    return;
  }

  const task = S.tasks.find(candidate => candidate.id === taskId);
  const fixed = constraintHoursForDate(occ, dateStr);
  const scheduled = plan.occurrenceAllocations?.[occ.occId]?.[dateStr] || 0;
  _dayHoursOccId = occ.occId;
  _dayHoursDate = dateStr;
  _dayHoursOriginal = roundHours(fixed === undefined ? scheduled : fixed);

  document.getElementById('day-hours-title').textContent = task?.name || occ.name || 'Adjust daily hours';
  document.getElementById('day-hours-date').textContent =
    parseDate(dateStr).toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long',
    });

  const input = document.getElementById('day-hours-input');
  input.value = _dayHoursOriginal;
  input.max = maxConstraintHoursForDate(occ, dateStr);
  document.getElementById('day-hours-auto').classList.toggle('hidden', fixed === undefined);
  document.getElementById('day-hours-all-auto').classList.toggle(
    'hidden',
    constrainedDatesForOccurrence(occ).length === 0
  );
  document.getElementById('day-hours-warning').classList.add('hidden');
  renderDayHoursLocks(occ, dateStr);
  previewDayHours();

  const result = manualConstraintResult(occ, plan);
  if (!result.fullyAllocated && occurrenceHasUserConstraints(occ)) {
    showDayHoursWarning(result.shortfall);
  }
  document.getElementById('day-hours-bg').classList.remove('hidden');
  input.focus();
  input.select();
}

function closeDayHoursEditor() {
  document.getElementById('day-hours-bg').classList.add('hidden');
  _dayHoursOccId = null;
  _dayHoursDate = null;
}

function renderDayHoursLocks(occ, focusDate) {
  const wrap = document.getElementById('day-hours-locks-wrap');
  const list = document.getElementById('day-hours-locks');
  const otherDates = constrainedDatesForOccurrence(occ).filter(date => date !== focusDate);
  wrap.classList.toggle('hidden', otherDates.length === 0);
  list.innerHTML = '';

  otherDates.forEach(date => {
    const row = document.createElement('div');
    row.className = 'day-hours-lock-row';
    row.innerHTML = `
      <span>${parseDate(date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
      <strong>${constraintHoursForDate(occ, date) || 0}h</strong>
      <button type="button" class="btn-ghost">Release</button>`;
    row.querySelector('button').onclick = () => releaseConstraintFromEditor(date);
    list.appendChild(row);
  });
}

function previewDayHours() {
  const occ = dayHoursOccurrence();
  if (!occ) return;
  const input = document.getElementById('day-hours-input');
  const max = maxConstraintHoursForDate(occ, _dayHoursDate);
  const value = Math.max(0, Number(input.value) || 0);
  const note = document.getElementById('day-hours-note');
  if (value > max + ALLOC_EPSILON) {
    note.textContent = `At most ${max}h can be fixed here because other fixed days already account for the rest.`;
    note.classList.add('bad');
    return;
  }

  const difference = roundHours(_dayHoursOriginal - value);
  note.classList.remove('bad');
  if (Math.abs(difference) <= ALLOC_EPSILON) {
    note.textContent = 'Saving makes this day user-controlled. Calico will leave it unchanged.';
  } else if (difference > 0) {
    note.textContent = `${difference}h will be redistributed to other eligible days before the deadline.`;
  } else {
    note.textContent = `${Math.abs(difference)}h will be pulled from the task's other automatic days.`;
  }
}

function stepDayHours(delta) {
  const input = document.getElementById('day-hours-input');
  input.value = roundHours(Math.max(0, (Number(input.value) || 0) + delta));
  previewDayHours();
}

function showDayHoursWarning(shortfall) {
  const warning = document.getElementById('day-hours-warning');
  if (!warning) return;
  document.getElementById('day-hours-warning-title').textContent =
    `${roundHours(shortfall)}h cannot currently be scheduled.`;
  document.getElementById('day-hours-warning-copy').textContent =
    'Your fixed days have been kept. Adjust or release one of them, or close this panel and resolve the remaining conflict separately.';
  warning.classList.remove('hidden');
}

function saveDayHours() {
  const occ = dayHoursOccurrence();
  if (!occ) return;
  const input = document.getElementById('day-hours-input');
  const hours = roundHours(Math.max(0, Number(input.value) || 0));
  const max = maxConstraintHoursForDate(occ, _dayHoursDate);
  if (hours > max + ALLOC_EPSILON) {
    previewDayHours();
    input.focus();
    return;
  }

  const previous = cloneData(S.manualOverrides || {});
  setDayConstraint(occ, _dayHoursDate, hours);
  const result = commitManualConstraint(
    'adjust daily task hours',
    previous,
    occ,
    _dayHoursDate,
    'Daily hours fixed; remaining work was redistributed'
  );
  if (result.fullyAllocated) closeDayHoursEditor();
}

function returnDayToAuto() {
  const occ = dayHoursOccurrence();
  if (!occ || constraintHoursForDate(occ, _dayHoursDate) === undefined) return;
  const previous = cloneData(S.manualOverrides || {});
  releaseDayConstraint(occ, _dayHoursDate);
  const result = commitManualConstraint(
    'return day to automatic scheduling',
    previous,
    occ,
    _dayHoursDate,
    'This day is automatic again'
  );
  if (result.fullyAllocated) closeDayHoursEditor();
}

function releaseConstraintFromEditor(dateStr) {
  const occ = dayHoursOccurrence();
  if (!occ) return;
  const previous = cloneData(S.manualOverrides || {});
  releaseDayConstraint(occ, dateStr);
  const result = commitManualConstraint(
    'release fixed task day',
    previous,
    occ,
    _dayHoursDate,
    'Fixed day released'
  );
  if (result.fullyAllocated) {
    openDayHoursEditor(occ.taskId, _dayHoursDate, occ.occId);
  }
}

function returnOccurrenceToAuto() {
  const occ = dayHoursOccurrence();
  if (!occ || !S.manualOverrides?.[occ.occId]) return;
  const previous = cloneData(S.manualOverrides || {});
  delete S.manualOverrides[occ.occId];
  invalidatePlan();
  const result = manualConstraintResult(occ);
  snapshotForUndo('return occurrence to automatic scheduling', { ...S, manualOverrides: previous });
  save();
  render();
  closeDayHoursEditor();
  if (result.fullyAllocated) {
    showToast('This occurrence is automatic again');
  } else {
    showOverloadToast(`${occ.name}: ${result.shortfall}h still cannot fit before the deadline.`);
  }
}

/* ══════════════════════════════════════════
   DAILY CHECK-IN SYSTEM
══════════════════════════════════════════ */

function maybeShowCheckin() {
  // Find tasks scheduled for yesterday that haven't been checked
  const yesterday = ds(addDays(today(), -1));
  const unchecked = [];

  S.tasks.forEach(t => {
    const hrs = taskHoursOnDay(t, yesterday);

    if (hrs <= 0) return;
    const key = t.id + '|' + yesterday;
    const entry = S.taskLog[key];
    if (!entry || !entry.checked) {
      unchecked.push({ task: t, hrs, key, entry });
    }
  });

  if (!unchecked.length) return; // nothing to check in about

  // Build modal content
  const d = parseDate(yesterday);
  const dayLabel = d.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  document.getElementById('checkin-date').textContent =
    dayLabel.toUpperCase() + ' — ' + unchecked.length + ' task' + (unchecked.length !== 1 ? 's' : '') + ' scheduled';

  const container = document.getElementById('checkin-tasks');
  container.innerHTML = '';

  unchecked.forEach(({ task, hrs, key, entry }) => {
    const alreadyPartial = entry && !entry.checked;
    const completed = entry ? (entry.completed ?? 0) : 0;

    const item = document.createElement('div');
    item.className = 'checkin-task-item';
    item.dataset.key = key;
    item.dataset.scheduled = hrs;
    item.dataset.completed = completed;
    item.innerHTML = `
      <div class="ci-row">
        <div class="ci-check" onclick="toggleCheckinItem(this)">${completed >= hrs ? '✓' : ''}</div>
        <div class="ci-accent" style="background:${safeColor(task.color)}"></div>
        <div class="ci-name">${escapeHtml(task.name)}</div>
        <div class="ci-scheduled">${hrs}h scheduled</div>
      </div>
      <div class="ci-partial ${completed >= hrs ? 'hidden' : ''}">
        <span>How much did you complete?</span>
        <input type="number" class="ci-partial-input" value="${completed}" min="0" max="${hrs}" step="0.5"
          oninput="onPartialInput(this)">
        <span>h</span>
        <span class="ci-redist-note" id="ci-note-${key.replace('|','-')}"></span>
      </div>`;

    if (completed >= hrs) {
      item.querySelector('.ci-check').classList.add('checked');
      item.querySelector('.ci-row').classList.add('done');
    }
    updatePartialNote(item.querySelector('.ci-partial-input'), hrs);
    container.appendChild(item);
  });

  document.getElementById('checkin-bg').classList.remove('hidden');
}

function toggleCheckinItem(checkEl) {
  const row   = checkEl.closest('.checkin-task-item');
  const hrs   = parseFloat(row.dataset.scheduled);
  const isNowChecked = !checkEl.classList.contains('checked');

  checkEl.classList.toggle('checked', isNowChecked);
  checkEl.textContent = isNowChecked ? '✓' : '';
  row.querySelector('.ci-row').classList.toggle('done', isNowChecked);
  row.dataset.completed = isNowChecked ? hrs : 0;

  const partial = row.querySelector('.ci-partial');
  partial.classList.toggle('hidden', isNowChecked);
  if (!isNowChecked) {
    const inp = partial.querySelector('.ci-partial-input');
    inp.value = 0;
    updatePartialNote(inp, hrs);
  }
}

function onPartialInput(inp) {
  const row = inp.closest('.checkin-task-item');
  const hrs = parseFloat(row.dataset.scheduled);
  const val = Math.min(hrs, Math.max(0, parseFloat(inp.value) || 0));
  row.dataset.completed = val;
  updatePartialNote(inp, hrs);
}

function updatePartialNote(inp, scheduledHrs) {
  const val  = parseFloat(inp.value) || 0;
  const gap  = Math.round((scheduledHrs - val) * 10) / 10;
  const row  = inp.closest('.checkin-task-item');
  const key  = row.dataset.key;
  const note = document.getElementById('ci-note-' + key.replace('|', '-'));
  if (!note) return;
  note.textContent = gap > 0 ? `→ ${gap}h will be redistributed` : '→ fully done';
  note.style.color = gap > 0 ? 'var(--accent)' : '#1e6641';
}

function submitCheckin() {
  const todayStr = ds(today());
  const yesterday = ds(addDays(today(), -1));

  document.querySelectorAll('.checkin-task-item').forEach(item => {
    const key       = item.dataset.key;
    const scheduled = parseFloat(item.dataset.scheduled);
    const completed = parseFloat(item.dataset.completed);
    const checked   = item.querySelector('.ci-check').classList.contains('checked') || completed >= scheduled;
    S.taskLog[key]  = { scheduled, completed: checked ? scheduled : completed, checked };
  });

  S.lastCheckinDate = todayStr;
  invalidatePlan();
  document.getElementById('checkin-bg').classList.add('hidden');
  save(); render();
  showToast('Check-in saved');
}

function dismissCheckin() {
  // Mark as seen today so it doesn't re-prompt until tomorrow
  S.lastCheckinDate = ds(today());
  document.getElementById('checkin-bg').classList.add('hidden');
  save();
}

function remindCheckinLater() {
  // Don't mark as seen — will re-prompt on next page load today
  document.getElementById('checkin-bg').classList.add('hidden');
}

/* ══════════════════════════════════════════
   BOOT
══════════════════════════════════════════ */
load();

if (S.onboarded) {
  document.getElementById('onboarding').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  render();
  // Show check-in prompt once per day if there are unchecked past tasks
  const todayStr = ds(today());
  if (S.lastCheckinDate !== todayStr) {
    maybeShowCheckin();
  }
} else {
  document.getElementById('onboarding').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
  render();
}

syncUndoButton();
if (_loadRecoveryMessage) {
  setTimeout(() => showToast(_loadRecoveryMessage), 0);
}

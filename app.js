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
  onboarded: false,
  baseline: 7,
  distribution: 'even',
  dayStart: '09:00',
  dayEnd: '18:00',
  maxDailyHours: 8,
  dayCapOverrides: {},
  view: 'week',
  weekOffset: 0,
  tasks: [],
  events: [],
  intensities: {},       // dateStr → 1‥10
  intensityHistory: [],  // [{date, dir}]
  nudgeDismissed: false,
  taskLog: {},        // 'taskId|dateStr' → {scheduled, completed, checked}
  lastCheckinDate: null,
  pinnedAllocations: {}, // 'taskId|dateStr' → hours — drag/skip pinned
};

let S = { ...DEFAULT_STATE };
let editingId   = null;
let editingType = null;
let pickedColor = '#111111';

/* ══════════════════════════════════════════
   PERSISTENCE
══════════════════════════════════════════ */
function save() {
  try { localStorage.setItem('calico_v1', JSON.stringify(S)); } catch(e) {}
}
function load() {
  try {
    const raw = localStorage.getItem('calico_v1');
    if (raw) S = { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch(e) {}
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
   ALLOCATION ENGINE
══════════════════════════════════════════ */
function effectiveDist(task) {
  return task.dist === 'inherit' ? S.distribution : task.dist;
}

function allocate(task) {
  // Returns {dateStr: hours} for all days from today → deadline.
  // Uses iterative redistribution: hours that can't fit on a capped day
  // flow to the next available days, so total always equals remaining.
  const out = {};
  if (!task.deadline) return out;
  const deadline = parseDate(task.deadline);
  const t = today();
  if (deadline < t) return out;

  const notBefore = task.notBefore ? parseDate(task.notBefore) : null;
  const days = [];
  let cur = new Date(t);
  while (cur <= deadline) {
    const dStr = ds(cur);
    // Skip days before notBefore date
    if (!notBefore || cur >= notBefore) days.push(dStr);
    cur = addDays(cur, 1);
  }
  if (!days.length) return out;

  // Base remaining = estimated hours minus any explicitly logged completion
  // Also add back any hours from past days that were scheduled but not completed
  let loggedShortfall = 0;
  Object.entries(S.taskLog).forEach(([key, entry]) => {
    const [tid, dStr] = key.split('|');
    if (tid !== task.id) return;
    if (parseDate(dStr) >= today()) return; // only past days
    const gap = Math.max(0, (entry.scheduled || 0) - (entry.completed ?? entry.scheduled ?? 0));
    loggedShortfall += gap;
  });
  const baseRemaining = Math.max(0, task.hours - (task.logged ?? 0) + loggedShortfall);

  // Handle pinned allocations — remove pinned days from distribution pool
  const pinned = {};
  let pinnedTotal = 0;
  days.forEach(d => {
    const pKey = task.id + '|' + d;
    if (S.pinnedAllocations[pKey] !== undefined) {
      pinned[d] = Math.min(S.pinnedAllocations[pKey], freeHoursOnDay(d));
      pinnedTotal += pinned[d];
      out[d] = Math.round(pinned[d] * 10) / 10;
    }
  });
  const unpinnedDays = days.filter(d => pinned[d] === undefined);
  const remaining = Math.max(0, baseRemaining - pinnedTotal);
  if (!unpinnedDays.length || remaining < 0.01) return out;

  const dist = effectiveDist(task);
  const caps = unpinnedDays.map(d => freeHoursOnDay(d)); // max per day

  // Base weights from distribution preference
  let weights = unpinnedDays.map((d, i) => {
    if (dist === 'even')     return 1;
    if (dist === 'front')    return unpinnedDays.length - i;
    if (dist === 'back')     return i + 1;
    if (dist === 'weighted') return Math.max(0, caps[i]);
    return 1;
  });
  // Zero out fully blocked days
  weights = weights.map((w, i) => caps[i] > 0 ? w : 0);

  // Iterative redistribution
  const alloc  = new Array(unpinnedDays.length).fill(0);
  const locked = new Array(unpinnedDays.length).fill(false);
  let toDistribute = remaining;

  for (let iter = 0; iter < unpinnedDays.length; iter++) {
    const freeIdxs = weights.map((w,i) => (!locked[i] && w > 0) ? i : -1).filter(i => i >= 0);
    if (!freeIdxs.length) break;
    const wTotal = freeIdxs.reduce((s, i) => s + weights[i], 0);
    if (!wTotal) break;

    let overflow = 0;
    freeIdxs.forEach(i => {
      const raw = (weights[i] / wTotal) * toDistribute;
      if (raw >= caps[i]) {
        alloc[i] = caps[i];
        locked[i] = true;
        overflow += raw - caps[i];
      } else {
        alloc[i] = raw;
      }
    });

    toDistribute = overflow;
    if (toDistribute < 0.01) break;
  }

  unpinnedDays.forEach((d, i) => {
    if (alloc[i] > 0.01) out[d] = Math.round(alloc[i] * 10) / 10;
  });
  return out;
}

/* ── Repeating task occurrence engine ──
   For a repeating task, each occurrence is treated as an independent
   mini-task: deadline = occurrence date, window starts the day after
   the previous occurrence (or today, whichever is later).
   We generate virtual occurrence objects so the allocator can treat
   each one like a normal task. */

function taskOccurrencesBetween(task, fromDate, toDate) {
  // Returns array of {deadline: dateStr, windowStart: dateStr}
  // for all occurrences of this task in [fromDate, toDate]
  if (!task.repeat || task.repeat === 'none') {
    // Non-repeating: single occurrence at task.deadline
    if (!task.deadline) return [];
    const d = parseDate(task.deadline);
    if (d >= fromDate && d <= toDate) {
      return [{ deadline: task.deadline, windowStart: ds(fromDate) }];
    }
    return [];
  }

  const occurrences = [];
  const start = parseDate(task.date || task.deadline); // repeat start date
  let prevOccDate = null;
  let count = 0;
  let cur = new Date(start);

  // Walk forward from the task start date, collecting occurrences up to toDate
  while (cur <= toDate) {
    const dStr = ds(cur);
    if (taskRepeatOccursOn(task, dStr)) {
      // Check count/date end
      if (task.repeatEndType === 'date' && task.repeatEndDate) {
        if (cur > parseDate(task.repeatEndDate)) break;
      }
      if (task.repeatEndType === 'count' && task.repeatCount) {
        if (count >= task.repeatCount) break;
      }
      count++;
      if (cur >= fromDate) {
        // window starts day after prev occurrence, or fromDate, whichever later
        const winStart = prevOccDate
          ? ds(addDays(parseDate(prevOccDate), 1) > fromDate
              ? addDays(parseDate(prevOccDate), 1)
              : fromDate)
          : ds(fromDate);
        occurrences.push({ deadline: dStr, windowStart: winStart });
      }
      prevOccDate = dStr;
    }
    cur = addDays(cur, 1);
  }
  return occurrences;
}

function taskRepeatOccursOn(task, dateStr) {
  // Same logic as eventOccursOn but for tasks
  const start  = parseDate(task.date || task.deadline);
  const target = parseDate(dateStr);
  if (target < start) return false;
  const dow = target.getDay();
  if (task.repeat === 'daily')    return true;
  if (task.repeat === 'weekly')   return dow === start.getDay();
  if (task.repeat === 'weekdays') return dow >= 1 && dow <= 5;
  if (task.repeat === 'weekends') return dow === 0 || dow === 6;
  if (task.repeat === 'custom')   return (task.repeatDays || []).includes(dow);
  if (task.repeat === 'interval') {
    const interval = task.repeatInterval || 7;
    const diff = Math.round((target - start) / 86400000);
    return diff >= 0 && diff % interval === 0;
  }
  return false;
}

function allocateOccurrence(task, windowStart, deadlineStr) {
  // Same iterative redistribution as allocate() but for one occurrence window
  const out = {};
  const start    = parseDate(windowStart);
  const deadline = parseDate(deadlineStr);
  const t        = today();
  const from     = start > t ? start : t;

  const days = [];
  let cur = new Date(from);
  while (cur <= deadline) { days.push(ds(cur)); cur = addDays(cur, 1); }
  if (!days.length) return out;

  // Add unfinished hours from past occurrences back into this occurrence's pool
  let occShortfall = 0;
  Object.entries(S.taskLog).forEach(([key, entry]) => {
    const [tid, dStr] = key.split('|');
    if (tid !== task.id) return;
    if (parseDate(dStr) >= today()) return;
    occShortfall += Math.max(0, (entry.scheduled || 0) - (entry.completed ?? entry.scheduled ?? 0));
  });
  const hours = (task.hours || 1) + occShortfall;
  const dist  = effectiveDist(task);
  const caps  = days.map(d => freeHoursOnDay(d));

  let weights = days.map((d, i) => {
    if (dist === 'even')     return 1;
    if (dist === 'front')    return days.length - i;
    if (dist === 'back')     return i + 1;
    if (dist === 'weighted') return Math.max(0, caps[i]);
    return 1;
  });
  weights = weights.map((w, i) => caps[i] > 0 ? w : 0);

  const alloc  = new Array(days.length).fill(0);
  const locked = new Array(days.length).fill(false);
  let toDistribute = hours;

  for (let iter = 0; iter < days.length; iter++) {
    const freeIdxs = weights.map((w,i) => (!locked[i] && w > 0) ? i : -1).filter(i => i >= 0);
    if (!freeIdxs.length) break;
    const wTotal = freeIdxs.reduce((s, i) => s + weights[i], 0);
    if (!wTotal) break;
    let overflow = 0;
    freeIdxs.forEach(i => {
      const raw = (weights[i] / wTotal) * toDistribute;
      if (raw >= caps[i]) { alloc[i] = caps[i]; locked[i] = true; overflow += raw - caps[i]; }
      else { alloc[i] = raw; }
    });
    toDistribute = overflow;
    if (toDistribute < 0.01) break;
  }

  days.forEach((d, i) => {
    if (alloc[i] > 0.01) out[d] = Math.round(alloc[i] * 10) / 10;
  });
  return out;
}

// Cache of allocations per task per visible week to avoid recomputation
let _allocCache = {};
function clearAllocCache() { _allocCache = {}; }

function getAllocations(task, visibleDays) {
  // Returns {dateStr: hours} for all visible days, summed across occurrences
  const cacheKey = task.id + '|' + visibleDays[0] + '|' + visibleDays[visibleDays.length-1];
  if (_allocCache[cacheKey]) return _allocCache[cacheKey];

  const from = parseDate(visibleDays[0]);
  const to   = parseDate(visibleDays[visibleDays.length - 1]);
  const out  = {};

  if (!task.repeat || task.repeat === 'none') {
    // Non-repeating: standard allocate
    const alloc = allocate(task);
    visibleDays.forEach(d => { if (alloc[d]) out[d] = alloc[d]; });
  } else {
    // Repeating: find occurrences in a wider window (prev occurrence may be before visible range)
    const lookback = addDays(from, -365); // look back up to a year to find windowStart
    const occs = taskOccurrencesBetween(task, lookback, to);
    occs.forEach(occ => {
      const alloc = allocateOccurrence(task, occ.windowStart, occ.deadline);
      visibleDays.forEach(d => {
        if (alloc[d]) out[d] = (out[d] || 0) + alloc[d];
      });
    });
  }

  _allocCache[cacheKey] = out;
  return out;
}

// Visible days for current week view (used as allocation context)
let _visibleDays = [];
function setVisibleDays(days) { _visibleDays = days; clearAllocCache(); }

function taskHoursOnDay(task, dateStr) {
  if (!_visibleDays.length) return allocate(task)[dateStr] ?? 0;
  return getAllocations(task, _visibleDays)[dateStr] ?? 0;
}

function totalLoadOnDay(dateStr) {
  return Math.round(
    S.tasks.reduce((a, t) => a + taskHoursOnDay(t, dateStr), 0) * 10
  ) / 10;
}

function eventHoursOnDay(dateStr) {
  // Total hours blocked by events on this day
  return eventsOnDay(dateStr).reduce((sum, ev) => {
    const sh = timeH(ev.start || '09:00');
    const eh = timeH(ev.end   || '10:00');
    return sum + Math.max(0, eh - sh);
  }, 0);
}

function dailyCapacity(dateStr) {
  // Raw max task hours scaled by intensity (before event blocking)
  // maxDailyHours is set by the user in Settings — independent of working window
  const override = S.dayCapOverrides && S.dayCapOverrides[dateStr];
  const base     = override || S.maxDailyHours || 8;
  const ratio    = getInt(dateStr) / (S.baseline || 7);
  return Math.round(Math.min(base, base * ratio) * 10) / 10;
}

function freeHoursOnDay(dateStr) {
  // Actual available hours for tasks: capacity minus event time, min 0
  const cap       = dailyCapacity(dateStr);
  const eventHrs  = eventHoursOnDay(dateStr);
  return Math.max(0, Math.round((cap - eventHrs) * 10) / 10);
}

function dayOverloadLevel(dateStr) {
  // Returns: 'none' | 'mild' | 'hard'
  // Uses freeHoursOnDay (event-aware) as the real capacity ceiling
  const load = totalLoadOnDay(dateStr);
  const free = freeHoursOnDay(dateStr);
  if (load <= free) return 'none';
  if (load <= free * 1.2) return 'mild';
  return 'hard';
}

function tasksOnDay(dateStr) {
  return S.tasks.filter(t => taskHoursOnDay(t, dateStr) > 0);
}

function eventOccursOn(ev, dateStr) {
  if (!ev.repeat || ev.repeat === 'none') {
    return ev.date === dateStr;
  }
  const start  = parseDate(ev.date);
  const target = parseDate(dateStr);

  // Must be on or after start date
  if (target < start) return false;

  // Check repeat end — inclusive on end date
  if (ev.repeatEndType === 'date' && ev.repeatEndDate) {
    if (target > parseDate(ev.repeatEndDate)) return false;
  }

  // The start date itself always counts — user explicitly chose it
  if (dateStr === ev.date) return true;

  const dow = target.getDay(); // 0=Sun, 1=Mon … 6=Sat
  const startDow = start.getDay();

  if (ev.repeat === 'daily')    return true;
  if (ev.repeat === 'weekly')   return dow === startDow;
  if (ev.repeat === 'weekdays') return dow >= 1 && dow <= 5;
  if (ev.repeat === 'weekends') return dow === 0 || dow === 6;
  if (ev.repeat === 'custom')   return (ev.repeatDays || []).includes(dow);
  if (ev.repeat === 'interval') {
    const interval = ev.repeatInterval || 7;
    const diffMs = target.getTime() - start.getTime();
    const diff   = Math.round(diffMs / 86400000);
    return diff >= 0 && diff % interval === 0;
  }
  return false;
}

function countOccurrencesBefore(ev, dateStr) {
  // Count occurrences from ev.date up to but NOT including dateStr
  if (!ev.repeat || ev.repeat === 'none') return 0;
  const start  = parseDate(ev.date);
  const target = parseDate(dateStr);
  let count = 0, cur = new Date(start);
  // Walk from start up to (not including) target
  while (cur.getTime() < target.getTime()) {
    if (eventOccursOn(ev, ds(cur))) count++;
    cur = addDays(cur, 1);
  }
  return count;
}

function eventsOnDay(dateStr) {
  return S.events.filter(ev => {
    if (!eventOccursOn(ev, dateStr)) return false;
    // Check count-based end
    if (ev.repeatEndType === 'count' && ev.repeatCount) {
      const n = countOccurrencesBefore(ev, dateStr);
      if (n >= ev.repeatCount) return false;
    }
    return true;
  });
}

/* ══════════════════════════════════════════
   COLOUR HELPERS
══════════════════════════════════════════ */
function hexBg(hex, alpha) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}
function isDark(hex) {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return (r*299+g*587+b*114)/1000 < 128;
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
    document.getElementById(`nav-${v}`).classList.toggle('active', S.view===v);
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

  const sbTasks = document.getElementById('sb-tasks');
  sbTasks.innerHTML = '';
  S.tasks.forEach(t => {
    const rem = Math.max(0, t.hours - (t.logged ?? 0));
    const rl  = t.repeat && t.repeat !== 'none' ? repeatLabel(t) : '';
    const el  = document.createElement('div');
    el.className = 'sb-pill';
    el.innerHTML = `<span class="sb-dot" style="background:${t.color}"></span>
      <span class="sb-name">${t.name}</span>
      <span class="sb-hrs">${rl ? rl : rem + 'h'}</span>`;
    el.onclick = () => openModal('task', t.id);
    sbTasks.appendChild(el);
  });

  const sbEvents = document.getElementById('sb-events');
  sbEvents.innerHTML = '';
  S.events.forEach(e => {
    const el = document.createElement('div');
    el.className = 'sb-pill';
    el.innerHTML = `<span class="sb-dot" style="background:${e.color}"></span>
      <span class="sb-name">${e.name}</span>
      <span class="sb-hrs">${e.date?.slice(5) ?? ''}</span>`;
    el.onclick = () => openModal('event', e.id);
    sbEvents.appendChild(el);
  });
}

/* ── Week view ── */
function renderWeek() {
  const ws = weekStartDate(S.weekOffset);
  const days = Array.from({length:7}, (_,i) => addDays(ws,i));
  setVisibleDays(days.map(d => ds(d)));
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
      const block = makeWeekBlock(ev, 'event', startH);
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
        _currentRenderDStr = dStr;
        const block  = makeWeekBlock(t, 'task', startH, used, topPx);
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

function makeWeekBlock(item, type, startH, hours, stackTop) {
  const block = document.createElement('div');
  block.className = `wk-block${item.priority==='optional'?' optional':''}`;
  const color = item.color || '#111';
  block.style.background = hexBg(color, 0.12);
  block.style.borderLeftColor = color;
  block.style.color = color;

  if (type === 'event') {
    const sh = timeH(item.start || '09:00');
    const eh = timeH(item.end   || '10:00');
    const dur = Math.max(eh - sh, 0.25);
    block.style.top    = ((sh - 0) * 54) + 'px'; // 0 = GRID_START (midnight)
    block.style.height = (dur * 54) + 'px';
    block.innerHTML = `<div class="wk-block-title">${item.name}</div>
      <div class="wk-block-sub">${item.start}–${item.end}</div>`;
  } else {
    block.style.top    = stackTop + 'px';
    block.style.height = (hours * 54) + 'px';
    block.innerHTML = `<div class="wk-block-title">${item.name}</div>
      <div class="wk-block-sub">${hours}h</div>`;
  }

  if (type === 'task') {
    // Drag to reschedule
    block.draggable = true;
    block.dataset.taskId   = item.id;
    block.dataset.sourceDs = arguments[3] !== undefined ? _currentRenderDStr : '';
    block.dataset.hrs      = hours || 0;
    block.addEventListener('dragstart', onTaskDragStart);
    block.addEventListener('click', e => { if (!e._wasDrag) openModal('task', item.id); });
  } else {
    block.onclick = () => openModal('event', item.id);
  }
  return block;
}

/* ── Agenda view ── */
function renderAgenda() {
  const ws = weekStartDate(S.weekOffset);
  const days = Array.from({length:7}, (_,i) => addDays(ws,i));
  setVisibleDays(days.map(d => ds(d)));
  const todayStr = ds(today());
  const body = document.getElementById('agenda-body');
  body.innerHTML = '';

  days.forEach((d, i) => {
    const dStr   = ds(d);
    const isT    = dStr === todayStr;
    const isPast = parseDate(dStr) < today() && !isT;
    const val    = getInt(dStr);
    const load   = totalLoadOnDay(dStr);
    const cap    = dailyCapacity(dStr);
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
          <span class="ag-strip-dot" style="background:${ev.color||'#111'}"></span>
          <span class="ag-strip-name">${ev.name}</span>
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
        const names = missed.map(t => t.name).join(', ');
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
  const color = task.color || '#111';
  el.style.setProperty('--task-color', color);

  const hrs = taskHoursOnDay(task, dStr);
  const avg = task.hours / Math.max(1, daysRemaining(task));
  let redistBadge = '';
  if (!isPast) {
    if (hrs < avg * 0.85) redistBadge = `<span class="badge badge-reduced">↓ reduced</span>`;
    else if (hrs > avg * 1.15) redistBadge = `<span class="badge badge-extra">↑ extra</span>`;
  }

  const taskRl    = repeatLabel(task);
  const priBadge  = task.priority === 'optional' ? `<span class="badge badge-opt">optional</span>` : '';
  const mandBadge = task.priority === 'mandatory' ? `<span class="badge">mandatory</span>` : '';
  const statusBadge = isDone
    ? `<span class="badge badge-done">done</span>`
    : isMissed ? `<span class="badge badge-missed">missed</span>` : '';

  const hrsDisplay = isDone
    ? `<div class="ag-task-hrs crossed">${hrs}h</div>`
    : `<div class="ag-task-hrs">${hrs}h</div>`;

  const checkbox = isPast
    ? `<div class="ag-task-check">${isDone ? '✓' : ''}</div>`
    : '';

  el.innerHTML = `
    ${checkbox}
    <div class="ag-task-accent"></div>
    <div class="ag-task-name">${task.name}</div>
    <div class="ag-task-badges">
      ${mandBadge}${priBadge}${statusBadge}${redistBadge}
      ${taskRl ? `<span class="repeat-badge">${taskRl}</span>` : ''}
    </div>
    ${hrsDisplay}`;

  if (isPast) {
    el.addEventListener('click', e => {
      e.stopPropagation();
      toggleTaskLog(task, dStr, hrs);
    });
  } else {
    // Add skip button for today and future days
    const skipBtn = document.createElement('button');
    skipBtn.className = 'ag-skip-btn';
    skipBtn.textContent = 'Skip →';
    skipBtn.title = 'Move to tomorrow';
    skipBtn.addEventListener('click', e => {
      e.stopPropagation();
      skipTaskToTomorrow(task.id, dStr);
    });
    el.appendChild(skipBtn);
    el.addEventListener('click', () => openModal('task', task.id));
  }
  return el;
}

function toggleTaskLog(task, dStr, scheduledHrs) {
  const key = task.id + '|' + dStr;
  const entry = S.taskLog[key];
  if (!entry || !entry.checked) {
    // Mark as done — fully completed
    S.taskLog[key] = { scheduled: scheduledHrs, completed: scheduledHrs, checked: true };
  } else {
    // Uncheck — mark as missed (0 completed)
    S.taskLog[key] = { scheduled: scheduledHrs, completed: 0, checked: false };
  }
  clearAllocCache();
  save(); render();
}

function makeAgendaEntry(item, type, dStr) {
  // Kept for any legacy callers — routes to correct renderer
  if (type === 'task') return makeAgendaTaskRow(item, dStr);
  // Events are now rendered as strips, this shouldn't be called for events
  return document.createElement('div');
}

/* ══════════════════════════════════════════
   CONFLICT RESOLUTION SYSTEM
══════════════════════════════════════════ */

// Compute total free hours across a task's window (today → deadline)
function totalFreeHoursInWindow(deadline) {
  const todayDate = today();
  const end = parseDate(deadline);
  if (end < todayDate) return 0;
  let total = 0, cur = new Date(todayDate);
  while (cur <= end) {
    total += freeHoursOnDay(ds(cur));
    cur = addDays(cur, 1);
  }
  return Math.round(total * 10) / 10;
}

// Count free days in window
function freeDaysInWindow(deadline) {
  const todayDate = today();
  const end = parseDate(deadline);
  let n = 0, cur = new Date(todayDate);
  while (cur <= end) { if (freeHoursOnDay(ds(cur)) > 0) n++; cur = addDays(cur, 1); }
  return n;
}

// Find earliest deadline where taskHours fits
function earliestFittingDeadline(taskHours, fromDeadline) {
  const todayDate = today();
  let cumFree = 0, cur = new Date(todayDate);
  for (let i = 0; i < 730; i++) {
    cumFree += freeHoursOnDay(ds(cur));
    if (cumFree >= taskHours) return ds(cur);
    cur = addDays(cur, 1);
  }
  return null;
}

// Compute total free hours available for a task in its window.
// "Free" = capacity - event hours, summed across all days today → deadline.
// We subtract the raw hours of other mandatory tasks that share the window,
// but only up to each day's free capacity (no double-counting).
function freeHoursExcluding(deadline, excludeTaskId) {
  const todayDate = today();
  const end = parseDate(deadline);
  if (end < todayDate) return 0;

  let available = 0;
  let cur = new Date(todayDate);
  while (cur <= end) {
    const dStr    = ds(cur);
    const dayFree = freeHoursOnDay(dStr);

    // Subtract hours committed to other mandatory tasks on this day
    let committed = 0;
    S.tasks.forEach(otherTask => {
      if (otherTask.id === excludeTaskId) return;
      if (otherTask.priority === 'optional') return;
      if (!otherTask.deadline) return;
      const otherEnd   = parseDate(otherTask.deadline);
      // Use todayDate (not shadowed 't') as the window start
      const otherStart = otherTask.notBefore ? parseDate(otherTask.notBefore) : todayDate;
      if (cur < otherStart || cur > otherEnd) return;
      const daysInWindow = Math.max(1, Math.round((otherEnd.getTime() - otherStart.getTime()) / 86400000) + 1);
      const dailyShare   = Math.min(dayFree, otherTask.hours / daysInWindow);
      committed += dailyShare;
    });

    available += Math.max(0, dayFree - committed);
    cur = addDays(cur, 1);
  }

  return Math.max(0, Math.round(available * 10) / 10);
}

function computeConflict(taskObj) {
  // Returns conflict info or null if no conflict
  if (taskObj.priority === 'optional') return null;

  // Past deadlines: silently return nothing, no conflict
  if (parseDate(taskObj.deadline) < today()) return null;

  const avail     = freeHoursExcluding(taskObj.deadline, editingId || null);
  const needed    = taskObj.hours;
  const shortfall = Math.round((needed - avail) * 10) / 10;
  if (shortfall <= 0) return null;

  const days      = freeDaysInWindow(taskObj.deadline);
  const suggested = earliestFittingDeadline(needed, taskObj.deadline);

  // Special case: all time blocked by events
  const allBlocked = days === 0;
  return { avail, needed, shortfall, days, suggested, allBlocked };
}

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
  const avail = totalFreeHoursInWindow(val);
  const shortfall = Math.round((_conflictTask.hours - avail) * 10) / 10;
  const badge = document.getElementById('copt-deadline-badge');
  const note  = document.getElementById('copt-deadline-note');
  if (shortfall <= 0) {
    badge.textContent = '+' + Math.round((avail - _conflictTask.hours)*10)/10 + 'h freed';
    badge.className = 'copt-badge ok';
    note.textContent = 'All ' + _conflictTask.hours + 'h can be scheduled by this date.';
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
      <div class="copt-task-name">${t.name}</div>
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
    // Extra free hours = freeHours at new intensity - freeHours at old intensity
    const maxH = S.maxDailyHours || 6;
    const oldFree = Math.max(0, (orig / S.baseline) * maxH - eventHoursOnDay(dStr));
    const newFree = Math.max(0, (newVal / S.baseline) * maxH - eventHoursOnDay(dStr));
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

function applyConflictResolution() {
  // Find selected option
  let selected = 0;
  for (let i=1;i<=7;i++) {
    if (document.getElementById('copt-'+i)?.classList.contains('selected')) { selected = i; break; }
  }
  if (!selected) { showToast('Please select a resolution option'); return; }

  const task = { ..._conflictTask };

  if (selected === 1) {
    // Extend deadline
    const newDeadline = document.getElementById('copt-deadline').value;
    if (!newDeadline) { showToast('Please set a new deadline'); return; }
    task.deadline = newDeadline;
    if (!task.repeat || task.repeat === 'none') task.date = newDeadline;
  } else if (selected === 2) {
    // Reduce hours
    task.hours = Math.max(0.5, parseFloat(document.getElementById('copt-hours').value) || 0.5);
  } else if (selected === 3) {
    // Overwork days — directly raise maxDailyHours for selected days via a
    // per-day override stored in S.dayCapOverrides
    if (!S.dayCapOverrides) S.dayCapOverrides = {};
    const extra = parseFloat(document.getElementById('copt-extra-hrs').value) || 0;
    Object.entries(_overworkDays).forEach(([dStr, on]) => {
      if (!on) return;
      const eventHrs  = eventHoursOnDay(dStr);
      const taskHrs   = totalLoadOnDay(dStr); // already scheduled tasks
      const usedHrs   = eventHrs + taskHrs;
      // Hard cap: never exceed 24h in a day
      const hardMax   = Math.min(24, usedHrs + (S.maxDailyHours || 6) + extra) - eventHrs;
      S.dayCapOverrides[dStr] = Math.max(S.maxDailyHours || 6, hardMax);
    });
  } else if (selected === 4) {
    // Mark optional
    task.priority = 'optional';
  } else if (selected === 5) {
    // Demote other tasks
    Object.entries(_demotedTasks).forEach(([id, checked]) => {
      if (!checked) return;
      const t = S.tasks.find(x => x.id === id);
      if (t) t.priority = 'optional';
    });
  } else if (selected === 6) {
    // Apply intensity overrides
    Object.entries(_intensityOverrides).forEach(([dStr, val]) => {
      S.intensities[dStr] = val;
    });
  }
  // Option 7: save anyway — no changes to task

  // Commit the task
  _commitTask(task, _pendingTask?.editingId || null);
  closeConflict();
  save(); render();
  showToast('Saved');
}

function checkTaskOverload() {
  // Scan the next 30 days for overloaded days
  // Uses freeHoursOnDay (event-aware) as the real capacity ceiling
  const days = Array.from({length:30}, (_,i) => ds(addDays(today(), i)));
  setVisibleDays(days);
  const hardDays = days.filter(d => dayOverloadLevel(d) === 'hard');
  if (hardDays.length) {
    const first = hardDays[0];
    const load  = totalLoadOnDay(first);
    const free  = freeHoursOnDay(first);
    const evHrs = Math.round(eventHoursOnDay(first) * 10) / 10;
    const evNote = evHrs > 0 ? ` (${evHrs}h blocked by events)` : '';
    showOverloadToast(`${hardDays.length} day${hardDays.length>1?'s':''} exceed capacity — e.g. ${first}: ${load}h of tasks, only ${free}h free${evNote}. Reduce hours, extend deadlines, or mark tasks optional.`);
  }
  // Restore visible days to current week
  const ws = weekStartDate(S.weekOffset);
  setVisibleDays(Array.from({length:7}, (_,i) => ds(addDays(ws,i))));
}

function showOverloadToast(msg) {
  const existing = document.getElementById('overload-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'overload-toast';
  el.className = 'overload-toast';
  el.innerHTML = `<span class="overload-toast-text">${msg}</span>
    <button onclick="this.parentElement.remove()">✕</button>`;
  document.body.appendChild(el);
  // Auto-dismiss after 8s
  setTimeout(() => { if (el.parentNode) el.remove(); }, 8000);
}

function adjustHours(id, delta) {
  const t = S.tasks.find(x => x.id===id);
  if (!t) return;
  t.hours = Math.max(0.5, Math.round((t.hours + delta) * 2) / 2);
  save(); render();
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
  showToast('Working hours saved');
}

function resetData() {
  if (!confirm('Clear all tasks, events and intensity data? This cannot be undone.')) return;
  S.tasks = []; S.events = []; S.intensities = []; S.intensityHistory = [];
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
      obj.date = document.getElementById('f-task-start-date').value || obj.deadline;
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
  }
}

let _pendingTask = null;

function _commitTask(obj, eid) {
  if (eid) {
    const i = S.tasks.findIndex(x => x.id === eid);
    if (i >= 0) { obj.logged = S.tasks[i].logged ?? 0; S.tasks[i] = obj; }
    else S.tasks.push(obj);
  } else {
    S.tasks.push(obj);
  }
}

function deleteItem() {
  if (!editingId) return;
  S.tasks  = S.tasks.filter(x=>x.id!==editingId);
  S.events = S.events.filter(x=>x.id!==editingId);
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
let _currentRenderDStr = '';
let _dragTaskId   = null;
let _dragSourceDs = null;
let _dragHrs      = 0;

function onTaskDragStart(e) {
  _dragTaskId   = e.currentTarget.dataset.taskId;
  _dragSourceDs = _currentRenderDStr;
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
      pinTaskToDay(_dragTaskId, _dragSourceDs, targetDs, _dragHrs);
    });
  });
}

function pinTaskToDay(taskId, fromDs, toDs, hrs) {
  if (!S.pinnedAllocations) S.pinnedAllocations = {};
  // Remove old pin from source day
  const fromKey = taskId + '|' + fromDs;
  const toKey   = taskId + '|' + toDs;
  delete S.pinnedAllocations[fromKey];
  // Pin to new day
  S.pinnedAllocations[toKey] = hrs;
  clearAllocCache();
  save(); render();
  // Re-init drag targets after re-render
  requestAnimationFrame(initWeekDragTargets);
  showToast('Task moved to ' + toDs);
}

function skipTaskToTomorrow(taskId, dStr) {
  const hrs     = taskHoursOnDay(S.tasks.find(t => t.id === taskId), dStr);
  const tomorrow = ds(addDays(parseDate(dStr), 1));
  pinTaskToDay(taskId, dStr, tomorrow, hrs);
  showToast('Skipped to tomorrow');
}

/* ══════════════════════════════════════════
   DAILY CHECK-IN SYSTEM
══════════════════════════════════════════ */

function maybeShowCheckin() {
  // Find tasks scheduled for yesterday that haven't been checked
  const yesterday = ds(addDays(today(), -1));
  const unchecked = [];

  S.tasks.forEach(t => {
    const hrs = (() => {
      // Temporarily set visible days to include yesterday for allocation
      const saved = _visibleDays.slice();
      if (!_visibleDays.includes(yesterday)) {
        _visibleDays = [yesterday];
        clearAllocCache();
      }
      const h = taskHoursOnDay(t, yesterday);
      _visibleDays = saved;
      clearAllocCache();
      return h;
    })();

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
        <div class="ci-accent" style="background:${task.color||'#111'}"></div>
        <div class="ci-name">${task.name}</div>
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
  clearAllocCache();
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

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
  view: 'week',
  weekOffset: 0,
  tasks: [],
  events: [],
  intensities: {},       // dateStr → 1‥10
  intensityHistory: [],  // [{date, dir}]
  nudgeDismissed: false,
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
function ds(d)           { return d.toISOString().slice(0,10); }
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
  // Returns {dateStr: hours} for all days from today → deadline
  const out = {};
  if (!task.deadline) return out;
  const deadline = parseDate(task.deadline);
  const t = today();
  if (deadline < t) return out;

  const days = [];
  let cur = new Date(t);
  while (cur <= deadline) { days.push(ds(cur)); cur = addDays(cur,1); }
  if (!days.length) return out;

  const remaining = Math.max(0, task.hours - (task.logged ?? 0));
  const dist = effectiveDist(task);

  // Base weights
  let weights = days.map((d,i) => {
    if (dist === 'even')     return 1;
    if (dist === 'front')    return days.length - i;
    if (dist === 'back')     return i + 1;
    if (dist === 'weighted') return getInt(d); // more hours on high-intensity days
    return 1;
  });

  // Modulate by intensity ratio
  weights = weights.map((w,i) => w * (getInt(days[i]) / S.baseline));

  const total = weights.reduce((a,b)=>a+b,0);
  if (!total) return out;
  days.forEach((d,i) => {
    const h = (weights[i]/total) * remaining;
    out[d] = Math.round(h * 10) / 10;
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
  // Allocate task.hours across days in [windowStart .. deadline]
  // using intensity-weighted distribution, same as the base allocator
  const out = {};
  const start    = parseDate(windowStart);
  const deadline = parseDate(deadlineStr);
  const t        = today();
  const from     = start > t ? start : t; // never allocate to the past

  const days = [];
  let cur = new Date(from);
  while (cur <= deadline) { days.push(ds(cur)); cur = addDays(cur, 1); }
  if (!days.length) return out;

  const hours    = task.hours || 1;
  const dist     = effectiveDist(task);
  let weights    = days.map((d, i) => {
    if (dist === 'even')     return 1;
    if (dist === 'front')    return days.length - i;
    if (dist === 'back')     return i + 1;
    if (dist === 'weighted') return getInt(d);
    return 1;
  });
  weights = weights.map((w, i) => w * (getInt(days[i]) / S.baseline));
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return out;
  days.forEach((d, i) => {
    out[d] = Math.round((weights[i] / total) * hours * 10) / 10;
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

function tasksOnDay(dateStr) {
  return S.tasks.filter(t => taskHoursOnDay(t, dateStr) > 0);
}

function eventOccursOn(ev, dateStr) {
  if (!ev.repeat || ev.repeat === 'none') {
    return ev.date === dateStr;
  }
  const start  = parseDate(ev.date);
  const target = parseDate(dateStr);
  if (target < start) return false;

  // Check repeat end
  if (ev.repeatEndType === 'date' && ev.repeatEndDate) {
    if (target > parseDate(ev.repeatEndDate)) return false;
  }

  const dow = target.getDay(); // 0=Sun, 1=Mon … 6=Sat

  if (ev.repeat === 'daily')    return true;
  if (ev.repeat === 'weekly')   return dow === start.getDay();
  if (ev.repeat === 'weekdays') return dow >= 1 && dow <= 5;
  if (ev.repeat === 'weekends') return dow === 0 || dow === 6;
  if (ev.repeat === 'custom')   return (ev.repeatDays || []).includes(dow);
  if (ev.repeat === 'interval') {
    const interval = ev.repeatInterval || 7;
    const diff = Math.round((target - start) / 86400000);
    return diff >= 0 && diff % interval === 0;
  }
  return false;
}

function countOccurrencesBefore(ev, dateStr) {
  // Count how many times ev occurs from ev.date up to (not including) dateStr
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

  // Time gutter
  const gutter = document.createElement('div');
  gutter.className = 'wk-time-col';
  const startH = timeH(S.dayStart);
  const endH   = timeH(S.dayEnd);
  for (let h = Math.floor(startH); h <= Math.ceil(endH); h++) {
    const lbl = document.createElement('div');
    lbl.className = 'wk-time-slot';
    lbl.textContent = h === 12 ? '12pm' : h > 12 ? `${h-12}pm` : `${h}am`;
    gutter.appendChild(lbl);
  }
  body.appendChild(gutter);

  // Day columns
  const hoursShown = Math.ceil(endH) - Math.floor(startH);
  days.forEach((d, i) => {
    const dStr = ds(d);
    const isT  = dStr === todayStr;
    const isWe = i >= 5;
    const col  = document.createElement('div');
    col.className = `wk-day-col${isT?' today-col':''}${isWe?' weekend':''}`;

    for (let h = 0; h < hoursShown; h++) {
      const line = document.createElement('div');
      line.className = 'wk-hr-line';
      col.appendChild(line);
    }

    // Events
    eventsOnDay(dStr).forEach(ev => {
      const block = makeWeekBlock(ev, 'event', startH);
      if (block) col.appendChild(block);
    });

    // Tasks stacked from dayStart
    let stackTop = 0; // px from top of day start
    tasksOnDay(dStr).forEach(t => {
      const hrs = taskHoursOnDay(t, dStr);
      if (hrs <= 0) return;
      const block = makeWeekBlock(t, 'task', startH, hrs, stackTop);
      if (block) col.appendChild(block);
      stackTop += hrs * 52 + 3;
    });

    body.appendChild(col);
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
    block.style.top    = ((sh - startH) * 52) + 'px';
    block.style.height = (dur * 52 - 2) + 'px';
    block.innerHTML = `<div class="wk-block-title">${item.name}</div>
      <div class="wk-block-sub">${item.start}–${item.end}</div>`;
  } else {
    block.style.top    = stackTop + 'px';
    block.style.height = (hours * 52 - 2) + 'px';
    block.innerHTML = `<div class="wk-block-title">${item.name}</div>
      <div class="wk-block-sub">${hours}h</div>`;
  }

  block.onclick = () => openModal(type, item.id);
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
    const dStr = ds(d);
    const isT  = dStr === todayStr;
    const val  = getInt(dStr);
    const load = totalLoadOnDay(dStr);
    const tasks  = tasksOnDay(dStr);
    const events = eventsOnDay(dStr);

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
            <div class="ag-int-val" id="aiv-${dStr}">${val}</div>
          </div>
        </div>
        <div class="ag-load">
          <div class="ag-load-lbl">Load</div>
          <div class="ag-load-hrs">${load}h</div>
        </div>
      </div>`;

    const entries = document.createElement('div');
    entries.className = 'ag-entries';

    if (!events.length && !tasks.length) {
      entries.innerHTML = '<div class="ag-empty">Nothing scheduled</div>';
    }
    events.forEach(ev => entries.appendChild(makeAgendaEntry(ev, 'event', dStr)));
    tasks.forEach(t  => entries.appendChild(makeAgendaEntry(t, 'task', dStr)));

    dayEl.appendChild(entries);

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

function makeAgendaEntry(item, type, dStr) {
  const el = document.createElement('div');
  el.className = `ag-entry${item.priority==='optional'?' optional':''}`;
  const color = item.color || '#111';
  el.style.borderLeft = `3px solid ${color}`;
  el.style.borderRadius = '6px';

  let metaHtml = '';
  let redistBadge = '';

  if (type === 'task') {
    const hrs = taskHoursOnDay(item, dStr);
    const avg = item.hours / Math.max(1, daysRemaining(item));
    if (hrs < avg * 0.85) redistBadge = `<span class="badge badge-reduced">↓ reduced</span>`;
    else if (hrs > avg * 1.15) redistBadge = `<span class="badge badge-extra">↑ extra</span>`;
    const taskRl = repeatLabel(item);
    metaHtml = `${hrs}h ${redistBadge}
      ${taskRl ? `<span class="repeat-badge">${taskRl}</span>` : ''}
      <div class="hrs-editor">
        <button class="he-minus" title="Reduce hours per occurrence">−</button>
        <span class="hrs-num">${item.hours}h</span>
        <button class="he-plus" title="Increase hours per occurrence">+</button>
      </div>`;
  } else {
    const rl = repeatLabel(item);
    metaHtml = `${item.start}–${item.end}${rl ? ` <span class="repeat-badge">${rl}</span>` : ''}`;
  }

  const typeBadge  = type==='task'
    ? `<span class="badge badge-task">task</span>`
    : `<span class="badge badge-event">event</span>`;
  const priBadge   = item.priority==='optional'
    ? `<span class="badge badge-opt">optional</span>` : '';

  el.innerHTML = `
    <div class="ae-ico">${type==='task' ? '✎' : '◷'}</div>
    <div class="ae-name">${item.name}</div>
    <div class="ae-badges">${typeBadge}${priBadge}</div>
    <div class="ae-meta">${metaHtml}</div>`;

  if (type === 'task') {
    el.querySelector('.he-minus').addEventListener('click', e => {
      e.stopPropagation();
      adjustHours(item.id, -0.5);
    });
    el.querySelector('.he-plus').addEventListener('click', e => {
      e.stopPropagation();
      adjustHours(item.id, 0.5);
    });
  }

  el.addEventListener('click', () => openModal(type, item.id));
  return el;
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
        document.getElementById('f-dist').value         = item.dist  || 'inherit';
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
      date:     document.getElementById('f-deadline').value, // repeat start = deadline for non-repeating
      hours:    parseFloat(document.getElementById('f-hours').value) || 4,
      dist:     document.getElementById('f-dist').value,
      logged:   0,
      repeat:   repeatVal,
    };
    if (repeatVal !== 'none') {
      // For repeating tasks, f-task-start-date is the repeat start
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
    if (editingId) {
      const i = S.tasks.findIndex(x=>x.id===editingId);
      if (i>=0) { obj.logged = S.tasks[i].logged ?? 0; S.tasks[i] = obj; }
    } else {
      S.tasks.push(obj);
    }
  } else {
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
      const i = S.events.findIndex(x=>x.id===editingId);
      if (i>=0) S.events[i] = obj;
    } else {
      S.events.push(obj);
    }
  }

  document.getElementById('modal-bg').classList.add('hidden');
  editingId = null;
  save(); render();
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
   BOOT
══════════════════════════════════════════ */
load();

if (S.onboarded) {
  document.getElementById('onboarding').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
} else {
  document.getElementById('onboarding').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');
}

render();

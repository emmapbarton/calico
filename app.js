/* ── State ── */
let state = {
  baseline: 7,
  distribution: 'even',
  weekOffset: 0,
  view: 'week',
  tasks: [],
  events: [],
  intensities: {}, // dateStr -> 1..10
  editingId: null,
  selectedColor: '#7c6fcd',
  intensityHistory: [], // [{date, val}] recent direction tracking
};

/* ── Persistence ── */
function save() {
  localStorage.setItem('flowcal', JSON.stringify(state));
}
function load() {
  try {
    const d = JSON.parse(localStorage.getItem('flowcal'));
    if (d) {
      state = { ...state, ...d };
      // ensure arrays exist
      if (!state.tasks) state.tasks = [];
      if (!state.events) state.events = [];
      if (!state.intensities) state.intensities = {};
      if (!state.intensityHistory) state.intensityHistory = [];
    }
  } catch(e) {}
}

/* ── Date Helpers ── */
function today() {
  const d = new Date();
  d.setHours(0,0,0,0);
  return d;
}
function dateStr(d) {
  return d.toISOString().slice(0,10);
}
function addDays(d, n) {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}
function weekStart(offset = 0) {
  const d = today();
  const day = d.getDay();
  const monday = addDays(d, (day === 0 ? -6 : 1 - day) + offset * 7);
  return monday;
}
function formatDate(d) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}
function parseDate(str) {
  const d = new Date(str + 'T00:00:00');
  return d;
}
const DAY_NAMES = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
const DAY_NAMES_FULL = ['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'];

/* ── Intensity ── */
function getIntensity(ds) {
  return state.intensities[ds] ?? state.baseline;
}
function setIntensity(ds, val) {
  state.intensities[ds] = val;
  // track history for baseline nudge
  const today_str = dateStr(today());
  const h = state.intensityHistory;
  // record if today
  const last = h[h.length - 1];
  if (!last || last.date !== today_str) {
    const diff = val - state.baseline;
    const dir = diff > 0 ? 'up' : diff < 0 ? 'down' : 'neutral';
    h.push({ date: today_str, dir });
    if (h.length > 10) h.splice(0, h.length - 10);
  }
  checkBaselineNudge();
  save();
  render();
}

function checkBaselineNudge() {
  const h = state.intensityHistory;
  if (h.length < 3) return;
  const last3 = h.slice(-3);
  const allUp = last3.every(x => x.dir === 'up');
  const allDown = last3.every(x => x.dir === 'down');
  if ((allUp || allDown) && !state.nudgeDismissed) {
    document.getElementById('nudge-banner').classList.remove('hidden');
  }
}

/* ── Distribution ── */
function getDistribution(task) {
  return task.distribution === 'inherit' ? state.distribution : task.distribution;
}

function distributionWeights(n, dist) {
  if (n === 0) return [];
  if (dist === 'even') return Array(n).fill(1);
  if (dist === 'front') {
    // triangle: n, n-1, ... 1
    const weights = [];
    for (let i = n; i >= 1; i--) weights.push(i);
    return weights;
  }
  if (dist === 'back') {
    const weights = [];
    for (let i = 1; i <= n; i++) weights.push(i);
    return weights;
  }
  // 'weighted' by intensity (or even if intensities not set yet)
  return Array(n).fill(1);
}

/* ── Allocated hours per day for a task ── */
function getAllocatedHoursForTask(task, ds) {
  const alloc = computeAllocation(task);
  return alloc[ds] ?? 0;
}

function computeAllocation(task) {
  // Returns {dateStr: hours} for all future/current days of this task
  const result = {};
  if (task.type !== 'task') return result;

  const deadline = parseDate(task.deadline);
  const todayD = today();
  const dist = getDistribution(task);

  // Days from today up to and including deadline
  const futureDays = [];
  let cursor = new Date(todayD);
  while (cursor <= deadline) {
    futureDays.push(dateStr(cursor));
    cursor = addDays(cursor, 1);
  }

  if (futureDays.length === 0) return result;

  // Hours already logged (past days)
  const hoursLogged = task.loggedHours ?? 0;
  const remaining = Math.max(0, task.hours - hoursLogged);

  // Compute weights, adjusted by intensity
  let weights = distributionWeights(futureDays.length, dist);
  if (dist === 'weighted') {
    weights = futureDays.map(d => getIntensity(d));
  }

  // Adjust weights by intensity ratio relative to baseline
  const intensityAdjusted = futureDays.map((d, i) => {
    const ratio = getIntensity(d) / state.baseline;
    return weights[i] * ratio;
  });

  const totalWeight = intensityAdjusted.reduce((a, b) => a + b, 0);
  if (totalWeight === 0) return result;

  futureDays.forEach((d, i) => {
    const h = (intensityAdjusted[i] / totalWeight) * remaining;
    result[d] = Math.round(h * 10) / 10;
  });

  return result;
}

/* ── Total task load for a day ── */
function getDayLoad(ds) {
  let total = 0;
  state.tasks.forEach(t => {
    total += getAllocatedHoursForTask(t, ds);
  });
  return Math.round(total * 10) / 10;
}

/* ── Events on a day ── */
function getEventsOnDay(ds) {
  return state.events.filter(e => e.date === ds);
}

/* ── Tasks active on a day ── */
function getTasksOnDay(ds) {
  const todayD = today();
  return state.tasks.filter(t => {
    if (!t.deadline) return false;
    const deadline = parseDate(t.deadline);
    const start = t.startDate ? parseDate(t.startDate) : todayD;
    const d = parseDate(ds);
    return d >= start && d <= deadline && getAllocatedHoursForTask(t, ds) > 0;
  });
}

/* ── Hex to rgba ── */
function hexToRgba(hex, a) {
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}

/* ── Render ── */
function render() {
  renderSidebar();
  if (state.view === 'week') renderWeek();
  else renderAgenda();
  updateWeekRangeLabel();
  updateNavActive();
}

function updateWeekRangeLabel() {
  const ws = weekStart(state.weekOffset);
  const we = addDays(ws, 6);
  document.getElementById('week-range-label').textContent =
    `${formatDate(ws)} – ${formatDate(we)}`;
}

function updateNavActive() {
  document.getElementById('nav-week').classList.toggle('active', state.view === 'week');
  document.getElementById('nav-agenda').classList.toggle('active', state.view === 'agenda');
  document.getElementById('toggle-week').classList.toggle('active', state.view === 'week');
  document.getElementById('toggle-agenda').classList.toggle('active', state.view === 'agenda');
  document.getElementById('view-week').classList.toggle('hidden', state.view !== 'week');
  document.getElementById('view-agenda').classList.toggle('hidden', state.view !== 'agenda');
}

/* ── Sidebar ── */
function renderSidebar() {
  document.getElementById('baseline-val').textContent = state.baseline;

  // Task pills
  const tl = document.getElementById('task-list-sidebar');
  tl.innerHTML = '';
  state.tasks.forEach(t => {
    const pill = document.createElement('div');
    pill.className = 'task-pill';
    const remaining = Math.max(0, t.hours - (t.loggedHours ?? 0));
    pill.innerHTML = `
      <span class="task-pill-dot" style="background:${t.color}"></span>
      <span class="task-pill-name">${t.name}</span>
      <span class="task-pill-hrs">${remaining}h</span>
    `;
    pill.onclick = () => openAddModal('task', t.id);
    tl.appendChild(pill);
  });

  // Event pills
  const el = document.getElementById('event-list-sidebar');
  el.innerHTML = '';
  state.events.forEach(ev => {
    const pill = document.createElement('div');
    pill.className = 'task-pill';
    pill.innerHTML = `
      <span class="task-pill-dot" style="background:${ev.color}"></span>
      <span class="task-pill-name">${ev.name}</span>
      <span class="task-pill-hrs">${ev.date ? ev.date.slice(5) : ''}</span>
    `;
    pill.onclick = () => openAddModal('event', ev.id);
    el.appendChild(pill);
  });
}

/* ── Week View ── */
function renderWeek() {
  const ws = weekStart(state.weekOffset);
  const days = Array.from({length:7}, (_,i) => addDays(ws, i));
  const todayStr = dateStr(today());

  // Headers
  const header = document.getElementById('week-header');
  header.innerHTML = '<div class="week-header-spacer"></div>';
  days.forEach((d, i) => {
    const ds = dateStr(d);
    const isT = ds === todayStr;
    const div = document.createElement('div');
    div.className = 'day-col-hd';
    div.innerHTML = `
      <div class="d-name">${DAY_NAMES[i]}</div>
      <div class="d-num${isT?' is-today':''}">${d.getDate()}</div>
    `;
    header.appendChild(div);
  });

  // Intensity row
  const intRow = document.getElementById('week-intensity-row');
  intRow.innerHTML = '<div class="int-row-label">Daily<br>intensity</div>';
  days.forEach(d => {
    const ds = dateStr(d);
    const val = getIntensity(ds);
    const cell = document.createElement('div');
    cell.className = 'int-cell';
    cell.innerHTML = `
      <input type="range" class="int-cell-slider" min="1" max="10" value="${val}" data-date="${ds}">
      <div class="int-cell-val" id="iv-${ds}">${val}</div>
    `;
    intRow.appendChild(cell);
  });
  intRow.querySelectorAll('.int-cell-slider').forEach(s => {
    s.addEventListener('input', () => {
      const ds = s.dataset.date;
      const v = parseInt(s.value);
      document.getElementById(`iv-${ds}`).textContent = v;
      setIntensity(ds, v);
    });
  });

  // Body
  const body = document.getElementById('week-body');
  body.innerHTML = '';

  // Time gutter
  const gutter = document.createElement('div');
  gutter.className = 'time-gutter';
  for (let h = 8; h <= 19; h++) {
    const lbl = document.createElement('div');
    lbl.className = 'time-slot-label';
    lbl.textContent = h === 12 ? '12pm' : h > 12 ? `${h-12}pm` : `${h}am`;
    gutter.appendChild(lbl);
  }
  body.appendChild(gutter);

  // Day columns
  days.forEach((d, i) => {
    const ds = dateStr(d);
    const isT = ds === todayStr;
    const isWe = i >= 5;
    const col = document.createElement('div');
    col.className = `week-day-col${isT?' is-today':''}${isWe?' is-weekend':''}`;
    col.dataset.date = ds;

    // Hour lines
    for (let h = 0; h < 12; h++) {
      const line = document.createElement('div');
      line.className = 'hour-line';
      col.appendChild(line);
    }

    // Events
    getEventsOnDay(ds).forEach(ev => {
      const block = createWeekBlock(ev, 'event', ds);
      col.appendChild(block);
    });

    // Tasks (as time blocks based on allocated hours, starting from 9am)
    let taskTop = 56; // start at 9am = 1 hour from 8am top = 56px
    const eventsH = getEventsOnDay(ds).reduce((a, ev) => {
      const sh = timeToDecimal(ev.start || '09:00');
      const eh = timeToDecimal(ev.end || '10:00');
      return a + (eh - sh);
    }, 0);

    getTasksOnDay(ds).forEach(t => {
      const hrs = getAllocatedHoursForTask(t, ds);
      if (hrs <= 0) return;
      const block = createWeekBlock(t, 'task', ds, hrs, taskTop);
      col.appendChild(block);
      taskTop += hrs * 56 + 4;
    });

    body.appendChild(col);
  });
}

function timeToDecimal(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h + m / 60;
}

function createWeekBlock(item, type, ds, hours, topOffset) {
  const block = document.createElement('div');
  block.className = `week-block${item.priority === 'optional' ? ' optional' : ''}`;

  const color = item.color || '#7c6fcd';
  block.style.background = hexToRgba(color, 0.15);
  block.style.borderLeftColor = color;
  block.style.color = color;

  if (type === 'event') {
    const sh = timeToDecimal(item.start || '09:00');
    const eh = timeToDecimal(item.end || '10:00');
    const duration = Math.max(eh - sh, 0.5);
    const topPx = (sh - 8) * 56;
    block.style.top = topPx + 'px';
    block.style.height = (duration * 56 - 2) + 'px';
    block.innerHTML = `<div class="wb-title">${item.name}</div><div class="wb-hrs">${item.start}–${item.end}</div>`;
  } else {
    const h = hours ?? 1;
    block.style.top = (topOffset ?? 56) + 'px';
    block.style.height = (h * 56 - 2) + 'px';
    block.innerHTML = `<div class="wb-title">${item.name}</div><div class="wb-hrs">${h}h</div>`;
  }

  block.onclick = () => openAddModal(type, item.id);
  return block;
}

/* ── Agenda View ── */
function renderAgenda() {
  const ws = weekStart(state.weekOffset);
  const days = Array.from({length:7}, (_,i) => addDays(ws, i));
  const todayStr = dateStr(today());
  const body = document.getElementById('agenda-body');
  body.innerHTML = '';

  days.forEach((d, i) => {
    const ds = dateStr(d);
    const isT = ds === todayStr;
    const int = getIntensity(ds);
    const load = getDayLoad(ds);
    const tasks = getTasksOnDay(ds);
    const events = getEventsOnDay(ds);

    const dayDiv = document.createElement('div');
    dayDiv.className = 'agenda-day';

    // Determine badge text for days with redistribution
    dayDiv.innerHTML = `
      <div class="agenda-day-header">
        <div class="agenda-date-col">
          <div class="agenda-d-name">${DAY_NAMES_FULL[i]}</div>
          <div class="agenda-d-num${isT?' is-today':''}">${d.getDate()}</div>
        </div>
        <div class="agenda-int-col">
          <div class="agenda-int-label">Intensity</div>
          <div class="agenda-int-wrap">
            <input type="range" class="agenda-int-slider" min="1" max="10" value="${int}" data-date="${ds}">
            <div class="agenda-int-val" id="aiv-${ds}">${int}</div>
          </div>
        </div>
        <div class="agenda-load-col">
          <div class="agenda-load-label">Task load</div>
          <div class="agenda-load-hrs">${load}h</div>
        </div>
      </div>
    `;

    const entries = document.createElement('div');
    entries.className = 'agenda-entries';

    if (events.length === 0 && tasks.length === 0) {
      entries.innerHTML = '<div class="agenda-empty">No tasks or events</div>';
    }

    events.forEach(ev => {
      entries.appendChild(createAgendaEntry(ev, 'event', ds));
    });
    tasks.forEach(t => {
      entries.appendChild(createAgendaEntry(t, 'task', ds));
    });

    dayDiv.appendChild(entries);

    // Slider listener
    const slider = dayDiv.querySelector('.agenda-int-slider');
    slider.addEventListener('input', () => {
      const v = parseInt(slider.value);
      document.getElementById(`aiv-${ds}`).textContent = v;
      setIntensity(ds, v);
    });

    body.appendChild(dayDiv);
  });
}

function createAgendaEntry(item, type, ds) {
  const entry = document.createElement('div');
  entry.className = `agenda-entry${item.priority === 'optional' ? ' optional' : ''}`;

  const color = item.color || '#7c6fcd';
  entry.style.borderLeft = `3px solid ${color}`;

  let hrs = '';
  let redistBadge = '';
  if (type === 'task') {
    const h = getAllocatedHoursForTask(item, ds);
    hrs = `${h}h`;

    // Check if different from "average" allocation
    const avg = item.hours / Math.max(1, getDaysRemaining(item));
    if (h < avg * 0.85) redistBadge = `<span class="badge badge-reduced">↓ reduced</span>`;
    else if (h > avg * 1.15) redistBadge = `<span class="badge badge-extra">↑ extra</span>`;
  } else {
    hrs = `${item.start}–${item.end}`;
  }

  const typeBadge = type === 'task'
    ? `<span class="badge badge-task">task</span>`
    : `<span class="badge badge-event">event</span>`;
  const priBadge = item.priority === 'optional'
    ? `<span class="badge badge-opt">optional</span>` : '';

  entry.innerHTML = `
    <div class="entry-icon-col">${type === 'task' ? '✎' : '◷'}</div>
    <div class="entry-name">${item.name}</div>
    <div class="entry-badges">${typeBadge}${priBadge}</div>
    <div class="entry-meta">
      ${hrs}
      ${redistBadge}
      ${type === 'task' ? hoursEditorHtml(item) : ''}
    </div>
  `;

  // Hours editor buttons
  if (type === 'task') {
    const minusBtn = entry.querySelector('.he-minus');
    const plusBtn = entry.querySelector('.he-plus');
    if (minusBtn) minusBtn.addEventListener('click', e => {
      e.stopPropagation();
      adjustTaskHours(item.id, -0.5);
    });
    if (plusBtn) plusBtn.addEventListener('click', e => {
      e.stopPropagation();
      adjustTaskHours(item.id, 0.5);
    });
  }

  entry.addEventListener('click', () => openAddModal(type, item.id));
  return entry;
}

function hoursEditorHtml(task) {
  return `
    <div class="hours-editor" title="Adjust total hours">
      <button class="he-minus">−</button>
      <span class="hrs-num">${task.hours}h total</span>
      <button class="he-plus">+</button>
    </div>
  `;
}

function adjustTaskHours(id, delta) {
  const task = state.tasks.find(t => t.id === id);
  if (!task) return;
  task.hours = Math.max(0.5, Math.round((task.hours + delta) * 2) / 2);
  save();
  render();
}

function getDaysRemaining(task) {
  const deadline = parseDate(task.deadline);
  const todayD = today();
  let count = 0;
  let cursor = new Date(todayD);
  while (cursor <= deadline) { count++; cursor = addDays(cursor, 1); }
  return count;
}

/* ── Modal ── */
function openAddModal(type, id) {
  state.editingId = id ?? null;
  state.selectedColor = '#7c6fcd';

  const modal = document.getElementById('modal-overlay');
  const titleEl = document.getElementById('modal-title');
  const deleteBtn = document.getElementById('modal-delete-btn');

  document.getElementById('field-type').value = type;
  onTypeChange();

  // Set today as default date
  const todayVal = dateStr(today());
  document.getElementById('field-deadline').value = todayVal;
  document.getElementById('field-event-date').value = todayVal;

  if (id) {
    const item = type === 'task'
      ? state.tasks.find(t => t.id === id)
      : state.events.find(e => e.id === id);
    if (item) {
      titleEl.textContent = `Edit ${type}`;
      deleteBtn.style.display = '';
      document.getElementById('field-name').value = item.name;
      document.getElementById('field-type').value = item.type || type;
      document.getElementById('field-priority').value = item.priority || 'mandatory';
      onTypeChange();
      if (item.type === 'task' || type === 'task') {
        document.getElementById('field-deadline').value = item.deadline || todayVal;
        document.getElementById('field-hours').value = item.hours || 4;
        document.getElementById('field-distribution').value = item.distribution || 'inherit';
      } else {
        document.getElementById('field-event-date').value = item.date || todayVal;
        document.getElementById('field-start').value = item.start || '09:00';
        document.getElementById('field-end').value = item.end || '10:00';
      }
      state.selectedColor = item.color || '#7c6fcd';
    }
  } else {
    titleEl.textContent = `Add ${type}`;
    deleteBtn.style.display = 'none';
    document.getElementById('field-name').value = '';
    document.getElementById('field-priority').value = 'mandatory';
    document.getElementById('field-hours').value = 4;
    document.getElementById('field-distribution').value = 'inherit';
    document.getElementById('field-start').value = '09:00';
    document.getElementById('field-end').value = '10:00';
  }

  // Update color picker
  document.querySelectorAll('.color-dot').forEach(dot => {
    dot.classList.toggle('selected', dot.dataset.color === state.selectedColor);
  });

  modal.classList.remove('hidden');
  document.getElementById('field-name').focus();
}

function onTypeChange() {
  const type = document.getElementById('field-type').value;
  document.getElementById('task-fields').classList.toggle('hidden', type !== 'task');
  document.getElementById('event-fields').classList.toggle('hidden', type !== 'event');
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-overlay')) return;
  document.getElementById('modal-overlay').classList.add('hidden');
  state.editingId = null;
}

function saveItem() {
  const name = document.getElementById('field-name').value.trim();
  if (!name) { document.getElementById('field-name').focus(); return; }

  const type = document.getElementById('field-type').value;
  const priority = document.getElementById('field-priority').value;
  const color = state.selectedColor;

  if (type === 'task') {
    const deadline = document.getElementById('field-deadline').value;
    const hours = parseFloat(document.getElementById('field-hours').value) || 4;
    const distribution = document.getElementById('field-distribution').value;

    if (state.editingId) {
      const t = state.tasks.find(x => x.id === state.editingId);
      if (t) Object.assign(t, { name, priority, color, deadline, hours, distribution, type });
    } else {
      state.tasks.push({ id: uid(), type: 'task', name, priority, color, deadline, hours, distribution, loggedHours: 0 });
    }
  } else {
    const date = document.getElementById('field-event-date').value;
    const start = document.getElementById('field-start').value;
    const end = document.getElementById('field-end').value;

    if (state.editingId) {
      const ev = state.events.find(x => x.id === state.editingId);
      if (ev) Object.assign(ev, { name, priority, color, date, start, end, type: 'event' });
    } else {
      state.events.push({ id: uid(), type: 'event', name, priority, color, date, start, end });
    }
  }

  document.getElementById('modal-overlay').classList.add('hidden');
  state.editingId = null;
  save();
  render();
}

function deleteCurrentItem() {
  if (!state.editingId) return;
  state.tasks = state.tasks.filter(t => t.id !== state.editingId);
  state.events = state.events.filter(e => e.id !== state.editingId);
  document.getElementById('modal-overlay').classList.add('hidden');
  state.editingId = null;
  save();
  render();
}

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ── Color picker ── */
document.getElementById('color-picker').addEventListener('click', e => {
  const dot = e.target.closest('.color-dot');
  if (!dot) return;
  state.selectedColor = dot.dataset.color;
  document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('selected'));
  dot.classList.add('selected');
});

/* ── Week navigation ── */
function shiftWeek(dir) { state.weekOffset += dir; render(); }
function goToday() { state.weekOffset = 0; render(); }

/* ── View switching ── */
function setView(v) { state.view = v; save(); render(); }

/* ── Reassess baseline ── */
function showReassess() {
  const slider = document.getElementById('reassess-slider');
  slider.value = state.baseline;
  document.getElementById('reassess-val').textContent = state.baseline;
  document.getElementById('reassess-overlay').classList.remove('hidden');
}
function closeReassess(e) {
  if (e && e.target !== document.getElementById('reassess-overlay')) return;
  document.getElementById('reassess-overlay').classList.add('hidden');
}
function saveReassess() {
  const v = parseInt(document.getElementById('reassess-slider').value);
  state.baseline = v;
  state.intensityHistory = [];
  state.nudgeDismissed = false;
  document.getElementById('reassess-overlay').classList.add('hidden');
  dismissNudge();
  save();
  render();
}
function dismissNudge() {
  state.nudgeDismissed = true;
  document.getElementById('nudge-banner').classList.add('hidden');
}

document.getElementById('reassess-slider').addEventListener('input', function() {
  document.getElementById('reassess-val').textContent = this.value;
});

/* ── Onboarding ── */
function obNext(step) {
  document.getElementById(`ob-step-${step}`).classList.add('hidden');
  document.getElementById(`ob-step-${step+1}`).classList.remove('hidden');
}
function obFinish() {
  state.baseline = parseInt(document.getElementById('ob-intensity').value);
  const distEl = document.querySelector('input[name="dist"]:checked');
  state.distribution = distEl ? distEl.value : 'even';
  document.getElementById('onboarding').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  save();
  render();
}

// Onboarding slider live update
const obSlider = document.getElementById('ob-intensity');
const obVal = document.getElementById('ob-int-val');
const obDesc = document.getElementById('ob-int-desc');
const descriptions = {
  1: "Very light days — a couple of focused hours maximum.",
  2: "Short bursts of effort, plenty of rest in between.",
  3: "A few hours of work, low pressure.",
  4: "Moderate effort, below average load.",
  5: "A balanced day — around 4–5 focused hours.",
  6: "Solid output, comfortable but engaged.",
  7: "Around 6–7 focused hours a day, with regular breaks.",
  8: "High-output days — sustained concentration.",
  9: "Near-peak effort, long focused sessions.",
  10: "Maximum intensity — full-on, all day."
};
obSlider.addEventListener('input', function() {
  obVal.textContent = this.value;
  obDesc.textContent = descriptions[this.value];
});

/* ── Boot ── */
load();
if (state.baseline && state.tasks !== undefined) {
  // Already onboarded
  document.getElementById('onboarding').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  render();
} else {
  // Fresh start — show onboarding
}

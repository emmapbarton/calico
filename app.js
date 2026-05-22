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
  // track direction vs baseline for nudge
  if (dateStr === ds(today())) {
    const dir = val > S.baseline ? 'up' : val < S.baseline ? 'down' : 'neutral';
    const h = S.intensityHistory;
    const last = h[h.length-1];
    if (!last || last.date !== dateStr) {
      h.push({ date: dateStr, dir });
      if (h.length > 14) h.splice(0, h.length-14);
    }
    checkNudge();
  }
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

function taskHoursOnDay(task, dateStr) {
  return allocate(task)[dateStr] ?? 0;
}

function totalLoadOnDay(dateStr) {
  return Math.round(
    S.tasks.reduce((a,t) => a + taskHoursOnDay(t, dateStr), 0) * 10
  ) / 10;
}

function tasksOnDay(dateStr) {
  return S.tasks.filter(t => {
    if (!t.deadline) return false;
    const d = parseDate(dateStr);
    return d >= today() && d <= parseDate(t.deadline) && taskHoursOnDay(t, dateStr) > 0;
  });
}

function eventsOnDay(dateStr) {
  return S.events.filter(e => e.date === dateStr);
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
  if (S.view==='week')     renderWeek();
  else if (S.view==='agenda') renderAgenda();
  else if (S.view==='settings') renderSettings();
  syncNavButtons();
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
    const el = document.createElement('div');
    el.className = 'sb-pill';
    el.innerHTML = `<span class="sb-dot" style="background:${t.color}"></span>
      <span class="sb-name">${t.name}</span>
      <span class="sb-hrs">${rem}h</span>`;
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
    cell.innerHTML = `<input type="range" min="1" max="10" value="${val}" data-d="${dStr}">
      <div class="wk-int-val" id="wiv-${dStr}">${val}</div>`;
    intRow.appendChild(cell);
  });
  intRow.querySelectorAll('input[type=range]').forEach(s => {
    s.addEventListener('input', () => {
      const v = +s.value;
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
            <input type="range" class="ag-int-slider" min="1" max="10" value="${val}" data-d="${dStr}">
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
    slider.addEventListener('input', () => {
      const v = +slider.value;
      document.getElementById(`aiv-${dStr}`).textContent = v;
      setInt(dStr, v);
    });

    body.appendChild(dayEl);
  });
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
    metaHtml = `${hrs}h ${redistBadge}
      <div class="hrs-editor">
        <button class="he-minus" title="Reduce total hours">−</button>
        <span class="hrs-num">${item.hours}h total</span>
        <button class="he-plus" title="Increase total hours">+</button>
      </div>`;
  } else {
    metaHtml = `${item.start}–${item.end}`;
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
        document.getElementById('f-deadline').value = item.deadline || todayVal;
        document.getElementById('f-hours').value    = item.hours || 4;
        document.getElementById('f-dist').value     = item.dist  || 'inherit';
      } else {
        document.getElementById('f-date').value  = item.date  || todayVal;
        document.getElementById('f-start').value = item.start || '09:00';
        document.getElementById('f-end').value   = item.end   || '10:00';
      }
      pickedColor = item.color || '#111111';
    }
  } else {
    document.getElementById('f-name').value     = '';
    document.getElementById('f-priority').value = 'mandatory';
    document.getElementById('f-hours').value    = 4;
    document.getElementById('f-dist').value     = 'inherit';
    document.getElementById('f-start').value    = '09:00';
    document.getElementById('f-end').value      = '10:00';
  }

  syncColourPicker();
  document.getElementById('modal-bg').classList.remove('hidden');
  document.getElementById('f-name').focus();
}

function onTypeChange() {
  const type = document.getElementById('f-type').value;
  document.getElementById('task-fields').classList.toggle('hidden', type!=='task');
  document.getElementById('event-fields').classList.toggle('hidden', type!=='event');
}

function closeModal(e) {
  if (e && e.target !== document.getElementById('modal-bg')) return;
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
    const obj = {
      id: editingId || uid(),
      type: 'task', name, priority, color,
      deadline: document.getElementById('f-deadline').value,
      hours:    parseFloat(document.getElementById('f-hours').value) || 4,
      dist:     document.getElementById('f-dist').value,
      logged:   0,
    };
    if (editingId) {
      const i = S.tasks.findIndex(x=>x.id===editingId);
      if (i>=0) { obj.logged = S.tasks[i].logged ?? 0; S.tasks[i] = obj; }
    } else {
      S.tasks.push(obj);
    }
  } else {
    const obj = {
      id: editingId || uid(),
      type: 'event', name, priority, color,
      date:  document.getElementById('f-date').value,
      start: document.getElementById('f-start').value,
      end:   document.getElementById('f-end').value,
    };
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

document.getElementById('colour-row').addEventListener('click', e => {
  const dot = e.target.closest('.col-dot');
  if (!dot) return;
  pickedColor = dot.dataset.c;
  syncColourPicker();
});

document.getElementById('modal-bg').addEventListener('click', closeModal);

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

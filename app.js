/* Focus — private, offline to-dos. All data stays in this browser's IndexedDB.
   No network requests are ever made by this script. */
'use strict';
(() => {
  const APP_VERSION = '2.0.0';
  const STEPS = [0, 25, 50, 75, 100];
  const SPACES = { work: 'Work', personal: 'Personal' };

  /* ---------------- date helpers (local time, weeks start Monday) ---------------- */
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { if (!s) return null; const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
  const sod = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const today = () => sod(new Date());
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const weekStart = (d) => addDays(sod(d), -((d.getDay() + 6) % 7));
  const diffDays = (a, b) => Math.round((sod(a) - sod(b)) / 86400000);
  const nextDow = (from, dow, inclToday) => { let n = (dow - from.getDay() + 7) % 7; if (n === 0 && !inclToday) n = 7; return addDays(from, n); };
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DOWL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtShort = (d) => `${DOW[d.getDay()]} ${MON[d.getMonth()]} ${d.getDate()}`;
  const thisWeek = () => ymd(weekStart(new Date()));

  const DUE_CHIPS = [
    { k: 'today', label: 'Today', fn: (t) => t },
    { k: 'tomorrow', label: 'Tomorrow', fn: (t) => addDays(t, 1) },
    { k: 'fri', label: 'This Fri', fn: (t) => nextDow(t, 5, true) },
    { k: 'nextmon', label: 'Next Mon', fn: (t) => nextDow(t, 1, false) },
    { k: 'week', label: '+1 week', fn: (t) => addDays(t, 7) },
  ];

  function dueInfo(s) {
    const d = parseYmd(s); const n = diffDays(d, today());
    if (n < 0) return { cls: 'over', label: n === -1 ? 'Overdue · yesterday' : `Overdue · ${-n}d`, n };
    if (n === 0) return { cls: 'today', label: 'Due today', n };
    if (n === 1) return { cls: 'soon', label: 'Tomorrow', n };
    if (n < 7) return { cls: 'soon', label: DOWL[d.getDay()], n };
    return { cls: '', label: fmtShort(d), n };
  }

  /* ---------------- misc helpers ---------------- */
  const $ = (s, el = document) => el.querySelector(s);
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const snapStep = (p) => STEPS.reduce((a, b) => (Math.abs(b - p) < Math.abs(a - p) ? b : a), 0);
  const ICON = {
    dots: '<svg viewBox="0 0 24 24"><circle cx="5.5" cy="12" r="1.3"/><circle cx="12" cy="12" r="1.3"/><circle cx="18.5" cy="12" r="1.3"/></svg>',
    x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    cal: '<svg viewBox="0 0 24 24"><rect x="4" y="5.5" width="16" height="14.5" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>',
    shield: '<svg viewBox="0 0 24 24"><path d="M12 3.5 19.5 6v5.5c0 4.6-3.2 7.8-7.5 9-4.3-1.2-7.5-4.4-7.5-9V6z"/><path d="m9 12 2.2 2.2L15.5 10"/></svg>',
    left: '<svg viewBox="0 0 24 24"><path d="m15 5-7 7 7 7"/></svg>',
    right: '<svg viewBox="0 0 24 24"><path d="m9 5 7 7-7 7"/></svg>',
  };

  /* ---------------- storage: IndexedDB with localStorage fallback ---------------- */
  const Store = {
    db: null, kind: 'localStorage',
    async open() {
      try {
        if (!('indexedDB' in window)) throw new Error('no idb');
        this.db = await new Promise((res, rej) => {
          const r = indexedDB.open('focus-app', 1);
          r.onupgradeneeded = () => r.result.createObjectStore('kv');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
          r.onblocked = () => rej(new Error('blocked'));
        });
        this.kind = 'IndexedDB';
      } catch (e) { this.db = null; this.kind = 'localStorage'; }
    },
    get(k) {
      if (!this.db) { try { return Promise.resolve(JSON.parse(localStorage.getItem('focus:' + k) || 'null')); } catch { return Promise.resolve(null); } }
      return new Promise((res, rej) => { const r = this.db.transaction('kv').objectStore('kv').get(k); r.onsuccess = () => res(r.result ?? null); r.onerror = () => rej(r.error); });
    },
    set(k, v) {
      if (!this.db) { localStorage.setItem('focus:' + k, JSON.stringify(v)); return Promise.resolve(); }
      return new Promise((res, rej) => { const tx = this.db.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
    },
  };

  /* ---------------- state ---------------- */
  const defaultState = () => ({ v: 1, tasks: [], targets: [], prefs: { view: 'home', lastSpace: 'work', lastExport: null } });
  let state = defaultState();
  const ui = { view: 'home', filter: 'active', day: null, qa: { open: false, space: null, due: null, dueTouched: false, critical: false, critTouched: false } };
  let persisted = null;

  let saveChain = Promise.resolve();
  function persist() {
    const snap = JSON.parse(JSON.stringify(state));
    saveChain = saveChain.then(() => Store.set('state', snap)).catch((err) => { console.warn('save failed', err); toast('Could not save — storage blocked or full'); });
    return saveChain;
  }
  let fxMuted = false;
  function commit(msg, mutate, undoable = true) {
    const before = undoable ? JSON.stringify(state) : null;
    const wasDone = new Set(state.tasks.filter((t) => t.progress >= 100).map((t) => t.id));
    mutate();
    const newly = fxMuted ? [] : state.tasks.filter((t) => t.progress >= 100 && !wasDone.has(t.id)).map((t) => t.id);
    const pts = newly.length > 3 ? [] : newly.map((id) => {
      const r = els.main.querySelector(`.task[data-id="${CSS.escape(id)}"] .ring`);
      if (r) { const b = r.getBoundingClientRect(); if (b.bottom > 0 && b.top < innerHeight) return [b.left + b.width / 2, b.top + b.height / 2]; }
      return [innerWidth / 2, innerHeight * 0.42];
    });
    persist();
    render();
    pts.forEach((p, i) => setTimeout(() => burst(p[0], p[1]), i * 120));
    if (msg) toast(msg, undoable ? () => { state = JSON.parse(before); persist(); render(); } : null);
  }

  const getTask = (id) => state.tasks.find((t) => t.id === id);
  const getTarget = (id) => state.targets.find((t) => t.id === id);
  const isDone = (t) => t.progress >= 100;
  const touch = (t) => { t.updated = Date.now(); };
  function setProgress(t, p) {
    t.progress = p;
    if (p >= 100) { t.blocked = false; t.doneAt = t.doneAt || Date.now(); } else t.doneAt = null;
    touch(t);
  }
  function statusOf(t) { if (isDone(t)) return 'done'; if (t.blocked) return 'blocked'; return t.progress > 0 ? 'doing' : 'todo'; }
  function setStatus(t, s) {
    if (s === 'todo') { t.blocked = false; setProgress(t, 0); }
    else if (s === 'doing') { t.blocked = false; setProgress(t, t.progress > 0 && t.progress < 100 ? t.progress : 25); }
    else if (s === 'blocked') { if (isDone(t)) setProgress(t, 75); t.blocked = true; touch(t); }
    else if (s === 'done') setProgress(t, 100);
  }
  function newTask(o) {
    const now = Date.now();
    return { id: uid(), title: o.title, notes: o.notes || '', space: o.space || 'work', critical: !!o.critical, priority: o.priority || 'normal',
      due: o.due || null, progress: o.progress || 0, blocked: false, targetId: o.targetId || null, created: now, updated: now, doneAt: null };
  }

  function targetProgress(tg) {
    const linked = state.tasks.filter((t) => t.targetId === tg.id);
    if (tg.mode === 'manual') return { pct: tg.manual || 0, linked, auto: false };
    if (!linked.length) return { pct: 0, linked, auto: true };
    return { pct: Math.round(linked.reduce((a, t) => a + t.progress, 0) / linked.length), linked, auto: true };
  }

  /* ---------------- sorting / grouping ---------------- */
  function cmpTasks(a, b) {
    if (isDone(a) !== isDone(b)) return isDone(a) ? 1 : -1;
    if (a.critical !== b.critical) return a.critical ? -1 : 1;
    const da = a.due || '9999', db = b.due || '9999';
    if (da !== db) return da < db ? -1 : 1;
    const pr = { high: 0, normal: 1, low: 2 };
    if (pr[a.priority] !== pr[b.priority]) return pr[a.priority] - pr[b.priority];
    return a.created - b.created;
  }
  function mustDo() {
    const t0 = today();
    return state.tasks.filter((t) => !isDone(t) && (t.critical || (t.due && diffDays(parseYmd(t.due), t0) <= 1)))
      .map((t) => ({ t, over: t.due && diffDays(parseYmd(t.due), t0) < 0 }))
      .sort((a, b) => (a.over !== b.over ? (a.over ? -1 : 1) : a.t.critical !== b.t.critical ? (a.t.critical ? -1 : 1) : cmpTasks(a.t, b.t)))
      .map((x) => x.t);
  }

  /* ---------------- quick-add text parsing ---------------- */
  const DOWMAP = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  function parseQuick(text) {
    const t = today(); const words = text.trim().split(/\s+/).filter(Boolean); const out = [];
    let due = null, critical = false, space = null;
    for (let i = 0; i < words.length; i++) {
      const raw = words[i]; const w = raw.toLowerCase().replace(/[.,;:]+$/, ''); let m;
      if (/^!+$/.test(w)) { critical = true; continue; }
      if (/^!+\S/.test(w)) { critical = true; out.push(raw.replace(/^!+/, '')); continue; }
      if (['today', 'tod', 'tdy', 'tonight'].includes(w)) { due = t; continue; }
      if (['tomorrow', 'tmr', 'tmrw', 'tomorow', 'tmw'].includes(w)) { due = addDays(t, 1); continue; }
      if (w === 'eow') { due = nextDow(t, 5, true); continue; }
      if ((w === 'next' || w === 'nxt') && i + 1 < words.length) {
        const n = words[i + 1].toLowerCase().replace(/[.,;:]+$/, '');
        if (n in DOWMAP) { due = addDays(weekStart(t), 7 + ((DOWMAP[n] + 6) % 7)); i++; continue; }
        if (n === 'week' || n === 'wk') { due = nextDow(t, 1, false); i++; continue; }
      }
      if (w in DOWMAP) { due = nextDow(t, DOWMAP[w], true); continue; }
      if ((m = w.match(/^\+(\d{1,3})([dw]?)$/))) { due = addDays(t, +m[1] * (m[2] === 'w' ? 7 : 1)); continue; }
      if ((m = w.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/))) {
        const mo = +m[1], da = +m[2]; let y = m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : t.getFullYear();
        let d = new Date(y, mo - 1, da);
        if (d.getMonth() === mo - 1 && d.getDate() === da) {
          if (!m[3] && d < t) d = new Date(y + 1, mo - 1, da);
          due = d; continue;
        }
      }
      if (['@work', '@w', '#work', '#w'].includes(w)) { space = 'work'; continue; }
      if (['@personal', '@p', '#personal', '#p', '@home', '#home', '@me'].includes(w)) { space = 'personal'; continue; }
      out.push(raw);
    }
    return { title: out.join(' '), due, critical, space };
  }

  /* ---------------- rendering ---------------- */
  const els = {};
  function ringSvg(t) {
    const p = t.progress, C = 100.53, done = p >= 100;
    const lbl = done ? '<svg viewBox="0 0 24 24" style="width:20px;height:20px;transform:none;filter:none;stroke-width:3.2"><path d="m6 12.5 4 4 8-9"/></svg>'
      : t.blocked ? '<svg viewBox="0 0 24 24" style="width:16px;height:16px;transform:none;filter:none;stroke-width:3"><path d="M9 6v12M15 6v12"/></svg>' : p ? p + '' : '';
    return `<svg viewBox="0 0 40 40" aria-hidden="true">${done ? '<circle class="fill" cx="20" cy="20" r="18"/>' : ''}<circle class="trk" cx="20" cy="20" r="16"/><circle class="arc" cx="20" cy="20" r="16" stroke-dasharray="${C}" data-rk="${esc(t.id)}" data-off="${(C * (1 - p / 100)).toFixed(2)}" style="stroke-dashoffset:${(ringMem.has(t.id) ? ringMem.get(t.id) : C).toFixed(2)}"/></svg><span class="rl">${lbl}</span>`;
  }
  function taskRow(t, showSpace) {
    const st = statusOf(t); const dl = t.due ? dueInfo(t.due) : null; const tg = t.targetId ? getTarget(t.targetId) : null;
    const meta = [
      showSpace ? `<span class="sp-tag">${SPACES[t.space]}</span>` : '',
      dl && !isDone(t) ? `<span class="due ${dl.cls}">${dl.label}</span>` : '',
      dl && isDone(t) ? `<span>${fmtShort(parseYmd(t.due))}</span>` : '',
      st === 'blocked' ? '<span class="badge blocked">Blocked</span>' : '',
      st === 'doing' ? `<span class="badge prog">In progress</span>` : '',
      t.priority === 'high' && !isDone(t) ? '<span class="badge hi">High</span>' : '',
      tg ? `<span class="tgt">◎ ${esc(tg.title)}</span>` : '',
      t.notes ? '<span aria-label="has notes">✎</span>' : '',
    ].join('');
    const aria = `${esc(t.title)}. ${st === 'done' ? 'Done' : t.progress + ' percent'}. Tap to advance progress.`;
    const over = dl && dl.n < 0 && !isDone(t);
    return `<li class="task sp-${t.space} ${isDone(t) ? 'is-done' : ''} ${t.blocked ? 'is-blocked' : ''} ${st === 'doing' ? 'is-doing' : ''} ${t.critical && !isDone(t) ? 'is-crit' : over ? 'is-over' : ''}" data-id="${esc(t.id)}">
      <div class="swipe-bg" aria-hidden="true"><span class="l">✓ ${isDone(t) ? 'Reopen' : 'Complete'}</span><span class="r">+1 day ⟶</span></div>
      <div class="task-inner">
        <button class="ring" data-act="cycle" aria-label="${aria}">${ringSvg(t)}</button>
        <div class="task-main" data-act="edit">
          <div class="task-title">${t.critical && !isDone(t) ? '<span class="crit-tag" aria-label="Critical">!</span>' : ''}${esc(t.title)}</div>
          ${meta ? `<div class="task-meta">${meta}</div>` : ''}
        </div>
        <button class="more-btn" data-act="menu" aria-label="Quick actions">${ICON.dots}</button>
      </div></li>`;
  }
  const taskList = (list, showSpace) => `<ul class="tasks">${list.map((t) => taskRow(t, showSpace)).join('')}</ul>`;
  const secHead = (title, n, cls = '', right = '') => `<div class="sec-h"><h2 class="${cls}">${title}${n != null ? `<span class="n">${n}</span>` : ''}</h2>${right}</div>`;
  /* animated number: renders previous value, render() tweens it to the new one */
  const ringMem = new Map(), barMem = new Map(), countMem = new Map();
  const num = (key, n, suf = '') => `<b class="num" data-ck="${esc(key)}" data-count="${n}" data-suf="${suf}">${countMem.has(key) ? countMem.get(key) : 0}${suf}</b>`;
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  let lastRendered = null;
  function render() {
    const v = ui.view; const viewChanged = lastRendered !== v; lastRendered = v;
    const rm = reduced();
    // FLIP: remember where each task row was
    const before = new Map();
    if (!viewChanged && !rm) els.main.querySelectorAll('.task').forEach((r) => { if (!before.has(r.dataset.id)) before.set(r.dataset.id, r.getBoundingClientRect().top); });
    document.body.dataset.view = v;
    els.tabbar.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.view === v));
    if (v === 'home') renderHome();
    else if (v === 'more') renderMore();
    else renderSpace(v);
    renderQA();
    afterRender(viewChanged, before, rm);
  }
  function afterRender(viewChanged, before, rm) {
    const main = els.main;
    if (viewChanged && !rm) {
      main.classList.remove('enter'); void main.offsetWidth; main.classList.add('enter');
      main.querySelectorAll('.sec, .set-card').forEach((el, i) => el.style.setProperty('--i', Math.min(i, 8)));
      clearTimeout(afterRender.t); afterRender.t = setTimeout(() => main.classList.remove('enter'), 1100);
    }
    if (!rm && before.size) {
      const seen = new Set();
      main.querySelectorAll('.task').forEach((r) => {
        const id = r.dataset.id; if (seen.has(id)) return; seen.add(id);
        if (before.has(id)) {
          const dy = before.get(id) - r.getBoundingClientRect().top;
          if (Math.abs(dy) > 2) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 420, easing: 'cubic-bezier(.2,.9,.25,1)' });
        } else r.animate([{ opacity: 0, transform: 'scale(.94) translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 380, easing: 'cubic-bezier(.2,.9,.25,1)' });
      });
    }
    // tween rings, bars and counters from their previous values
    void main.offsetWidth;
    main.querySelectorAll('.arc[data-rk]').forEach((a) => { a.style.strokeDashoffset = a.dataset.off; ringMem.set(a.dataset.rk, +a.dataset.off); });
    main.querySelectorAll('.bar i[data-bk]').forEach((b) => { b.style.width = b.dataset.w + '%'; barMem.set(b.dataset.bk, +b.dataset.w); });
    document.querySelectorAll('[data-count]').forEach((el) => {
      const key = el.dataset.ck, to = +el.dataset.count, suf = el.dataset.suf || '';
      const from = countMem.has(key) ? countMem.get(key) : 0; countMem.set(key, to);
      if (rm || from === to) { el.textContent = to + suf; return; }
      const t0 = performance.now(), dur = 700;
      const step = (now) => { const k = Math.min(1, (now - t0) / dur); const e = 1 - Math.pow(1 - k, 3);
        el.textContent = Math.round(from + (to - from) * e) + suf; if (k < 1 && el.isConnected) requestAnimationFrame(step); };
      requestAnimationFrame(step);
    });
  }

  function renderHome() {
    const now = new Date(); const h = now.getHours();
    const greet = h < 5 ? 'Late night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
    const open = state.tasks.filter((t) => !isDone(t));
    const crit = open.filter((t) => t.critical).length;
    const over = open.filter((t) => t.due && diffDays(parseYmd(t.due), today()) < 0).length;
    els.topbar.innerHTML = `<div><small><span class="live"></span>Focus·OS // ${DOW[now.getDay()]} ${MON[now.getMonth()]} ${now.getDate()}</small><h1 class="grad">${greet}</h1>
      <div class="tb-stats"><span class="pill">${num('open', open.length)} open</span>${crit ? `<span class="pill crit">${num('crit', crit)} critical</span>` : ''}${over ? `<span class="pill over">${num('over', over)} overdue</span>` : ''}</div></div>`;

    // week strip
    const ws = weekStart(now); const t0 = today(); let days = '';
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i); const k = ymd(d);
      const due = open.filter((t) => t.due === k);
      const w = due.filter((t) => t.space === 'work').length, p = due.length - w;
      const c = due.filter((t) => t.critical).length;
      const isToday = k === ymd(t0);
      const overN = isToday ? over : 0;
      days += `<button class="wd ${isToday ? 'today' : ''} ${d < t0 ? 'past' : ''} ${ui.day === k ? 'sel' : ''}" data-act="day" data-day="${k}" aria-label="${fmtShort(d)}: ${w} work, ${p} personal due">
        <span class="dn">${DOW[d.getDay()].toUpperCase()}</span><span class="dd">${d.getDate()}</span>
        <span class="cnt">${w ? `<i class="w">${w}</i>` : ''}${p ? `<i class="p">${p}</i>` : ''}${overN ? `<i class="x" title="overdue">${overN}</i>` : ''}</span>${c ? '' : ''}</button>`;
    }
    let dayView = '';
    if (ui.day) {
      const list = state.tasks.filter((t) => t.due === ui.day).sort(cmpTasks);
      dayView = `<div class="dayview">${secHead('Due ' + fmtShort(parseYmd(ui.day)), list.length, '', '<button class="link-btn" data-act="day" data-day="">Close</button>')}${list.length ? taskList(list, true) : '<div class="empty">Nothing due this day.</div>'}</div>`;
    }
    const week = `<section class="card sec"><div class="week-h"><span>Week of ${MON[ws.getMonth()]} ${ws.getDate()}</span><span class="legend"><span style="--c:var(--work)">Work</span><span style="--c:var(--personal)">Personal</span></span></div><div class="week">${days}</div>${dayView}</section>`;

    // must do
    const md = mustDo();
    let must;
    if (!state.tasks.length) {
      must = `<div class="card empty"><b>Welcome to Focus</b>Add a task below — try <code>Prep board deck fri !</code><br>Everything stays on this device.<br><button class="btn" data-act="sample">Load sample tasks</button></div>`;
    } else if (!md.length) {
      must = '<div class="card empty"><b>Nothing urgent</b>No critical, overdue or due-soon tasks.</div>';
    } else {
      const cap = 5; const shown = ui.mustAll ? md : md.slice(0, cap);
      must = taskList(shown, true) + (md.length > cap ? `<button class="btn block" data-act="mustall" style="margin-top:8px">${ui.mustAll ? 'Show less' : `Show all ${md.length}`}</button>` : '');
    }
    const mustSec = `<section class="sec">${secHead('Must do', md.length || null, md.length ? 'crit' : '')}${must}</section>`;

    // targets
    const wk = thisWeek();
    const tgs = state.targets.filter((t) => t.week === wk);
    const lastWk = ymd(addDays(parseYmd(wk), -7));
    const carry = state.targets.filter((t) => t.week === lastWk && targetProgress(t).pct < 100);
    let tgHtml = '';
    for (const sp of ['work', 'personal']) {
      const list = tgs.filter((t) => t.space === sp);
      tgHtml += `<div class="tg-group sp-${sp}"><div class="tg-gh"><b>${SPACES[sp]}</b><button class="link-btn" data-act="addtarget" data-space="${sp}">+ Target</button></div>
        <div class="tg-list">${list.length ? list.map(targetCard).join('') : `<div class="card empty" style="padding:14px">No ${SPACES[sp].toLowerCase()} targets this week.</div>`}</div></div>`;
    }
    const carryBtn = !tgs.length && carry.length ? `<button class="btn block" data-act="carry" style="margin-bottom:12px">Carry over ${carry.length} unfinished target${carry.length > 1 ? 's' : ''} from last week</button>` : '';
    const done = tgs.filter((t) => targetProgress(t).pct >= 100).length;
    const tgSec = `<section class="sec">${secHead("This week's targets", tgs.length ? `${done}/${tgs.length}` : null)}${carryBtn}${tgHtml}</section>`;

    els.main.innerHTML = mustSec + tgSec + week;
  }

  function targetCard(tg) {
    const { pct, linked, auto } = targetProgress(tg);
    const doneN = linked.filter(isDone).length;
    const meta = auto ? (linked.length ? `${doneN}/${linked.length} linked tasks done · auto` : 'No linked tasks yet · tap to link') : 'Manual · tap % to advance';
    return `<div class="card target sp-${tg.space} ${pct >= 100 ? 'complete' : ''}" data-act="target" data-id="${esc(tg.id)}" role="button" tabindex="0">
      <div class="tg-top"><span class="tg-title">${pct >= 100 ? '✓ ' : ''}${esc(tg.title)}</span>${auto ? `<span class="tg-pct">${num('tg:' + tg.id, pct, '%')}</span>` : `<button class="tg-pct" data-act="tgcycle" data-id="${esc(tg.id)}" aria-label="Advance progress">${num('tg:' + tg.id, pct, '%')}</button>`}</div>
      <div class="bar"><i data-bk="${esc(tg.id)}" data-w="${pct}" style="width:${barMem.has(tg.id) ? barMem.get(tg.id) : 0}%"></i></div><div class="tg-meta">${meta}</div></div>`;
  }

  function renderSpace(sp) {
    const all = state.tasks.filter((t) => t.space === sp);
    const open = all.filter((t) => !isDone(t)); const done = all.filter(isDone);
    const t0 = today();
    const crit = open.filter((t) => t.critical).length;
    const over = open.filter((t) => t.due && diffDays(parseYmd(t.due), t0) < 0).length;
    els.topbar.innerHTML = `<div><small><span class="live"></span>Sector // ${SPACES[sp]}</small><h1 class="acc-h"><span class="acc">${SPACES[sp]}</span></h1>
      <div class="tb-stats"><span class="pill">${num(sp + ':open', open.length)} open</span>${done.length ? `<span class="pill">${num(sp + ':done', done.length)} done</span>` : ''}${crit ? `<span class="pill crit">${num(sp + ':crit', crit)} critical</span>` : ''}${over ? `<span class="pill over">${num(sp + ':over', over)} overdue</span>` : ''}</div></div>
      <div class="seg sm" role="tablist"><button data-act="filter" data-f="active" class="${ui.filter === 'active' ? 'on' : ''}">Active</button><button data-act="filter" data-f="done" class="${ui.filter === 'done' ? 'on' : ''}">Done</button></div>`;
    let html = '';
    if (ui.filter === 'done') {
      const list = done.sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
      html = list.length ? `<section class="sec">${secHead('Completed', list.length, '', '<button class="link-btn" data-act="cleardone">Clear</button>')}${taskList(list)}</section>`
        : '<div class="card empty sec"><b>Nothing done yet</b>Tap a ring to log progress, or swipe right to finish.</div>';
    } else {
      const endWk = addDays(weekStart(t0), 6);
      const groups = [['Critical', 'crit', []], ['Overdue', 'over', []], ['Today', '', []], ['Tomorrow', '', []], ['Rest of this week', '', []], ['Later', '', []], ['No deadline', '', []]];
      for (const t of open.sort(cmpTasks)) {
        let g;
        if (t.critical) g = 0;
        else if (!t.due) g = 6;
        else {
          const n = diffDays(parseYmd(t.due), t0);
          g = n < 0 ? 1 : n === 0 ? 2 : n === 1 ? 3 : parseYmd(t.due) <= endWk ? 4 : 5;
        }
        groups[g][2].push(t);
      }
      html = groups.filter((g) => g[2].length).map((g) => `<section class="sec">${secHead(g[0], g[2].length, g[1])}${taskList(g[2])}</section>`).join('');
      if (!open.length) html = `<div class="card empty sec"><b>All clear in ${SPACES[sp]}</b>Type below to add a task. Tip: <code>fri</code>, <code>tomorrow</code>, <code>!</code> for critical.${!state.tasks.length ? '<br><button class="btn" data-act="sample">Load sample tasks</button>' : ''}</div>`;
    }
    els.main.innerHTML = html;
  }

  function renderMore() {
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    const last = state.prefs.lastExport ? new Date(state.prefs.lastExport) : null;
    const stale = !last || Date.now() - last > 7 * 86400000;
    els.topbar.innerHTML = '<div><small><span class="live"></span>Local vault // offline</small><h1 class="grad">Data &amp; settings</h1></div>';
    els.main.innerHTML = `
      <section class="card set-card sec"><div class="shield">${ICON.shield}<div><h3>Your data stays on this iPhone</h3>
        <p>Tasks are stored only in this app's on-device storage. No accounts, no sync, no analytics — the app makes no network requests at all.</p></div></div>
        <div class="kv"><span>Storage</span><b>${Store.kind}</b></div>
        <div class="kv"><span>Protected from auto-cleanup</span><b class="${persisted ? 'ok' : 'warn'}">${persisted ? 'Yes' : standalone ? 'Not guaranteed' : 'Add to Home Screen'}</b></div>
        <div class="kv"><span>Tasks / targets</span><b>${state.tasks.length} / ${state.targets.length}</b></div>
        <div class="kv"><span>Last backup</span><b class="${stale ? 'warn' : 'ok'}">${last ? fmtShort(last) : 'Never'}</b></div></section>
      <section class="card set-card"><h3>Backup</h3><p>Export saves a JSON file to your device (Files › Downloads). Import reads a file you pick — nothing is uploaded anywhere.</p>
        <div class="btns"><button class="btn primary" data-act="export">Export backup</button><button class="btn" data-act="import">Import…</button></div></section>
      ${standalone ? '' : `<section class="card set-card"><h3>Install on iPhone</h3><p>In Safari tap <b>Share</b> → <b>Add to Home Screen</b>. It then opens full-screen, works offline, and iOS won't clear its data for inactivity.</p></section>`}
      <section class="card set-card"><h3>Fast moves</h3><ul class="tips">
        <li><b>Tap the ring</b> to step progress 0 → 25 → 50 → 75 → 100%.</li>
        <li><b>Swipe right</b> = done · <b>swipe left</b> = push deadline +1 day.</li>
        <li><b>Long-press</b> or <b>⋯</b> for status, deadline, critical, delete. Tap a task to edit.</li>
        <li>Quick-add words: <code>today</code> <code>tmr</code> <code>fri</code> <code>next mon</code> <code>+3d</code> <code>+2w</code> <code>11/14</code> · <code>!</code> critical · <code>@w</code>/<code>@p</code> space.</li></ul></section>
      <section class="card set-card"><h3>Clean up</h3><p>Erasing cannot be undone unless you have a backup.</p>
        <div class="btns"><button class="btn" data-act="cleardone">Clear all completed</button><button class="btn danger" data-act="erase">Erase all data</button></div></section>
      <p class="empty ver">Focus·OS v${APP_VERSION} · works offline</p>`;
  }

  /* ---------------- quick add ---------------- */
  const defaultSpace = () => (ui.view === 'work' || ui.view === 'personal' ? ui.view : state.prefs.lastSpace || 'work');
  function qaEffective() {
    const p = parseQuick(els.qaInput.value);
    return {
      title: p.title,
      space: p.space || ui.qa.space || defaultSpace(),
      due: ui.qa.dueTouched ? ui.qa.due : p.due ? ymd(p.due) : null,
      critical: ui.qa.critTouched ? ui.qa.critical : p.critical,
    };
  }
  function renderQA() {
    els.qa.classList.toggle('open', ui.qa.open); document.body.classList.toggle('qa-open', ui.qa.open);
    if (!ui.qa.open) return;
    const e = qaEffective(); const t0 = today();
    const known = DUE_CHIPS.some((c) => ymd(c.fn(t0)) === e.due);
    els.qaChips.innerHTML =
      `<button type="button" class="chip space sp-${e.space}" data-qa="space" aria-label="Space: ${SPACES[e.space]}, tap to switch">● ${SPACES[e.space]}</button>` +
      `<button type="button" class="chip crit ${e.critical ? 'on' : ''}" data-qa="crit" aria-pressed="${e.critical}">! Critical</button>` +
      DUE_CHIPS.map((c) => `<button type="button" class="chip ${ymd(c.fn(t0)) === e.due ? 'on' : ''}" data-qa="due" data-k="${c.k}">${c.label}</button>`).join('') +
      `<label class="chip ${e.due && !known ? 'on' : ''}">${ICON.cal}${e.due && !known ? fmtShort(parseYmd(e.due)) : 'Date'}<input type="date" data-qa="date" value="${e.due || ''}" aria-label="Pick a date"></label>` +
      (e.due ? `<button type="button" class="chip ghost" data-qa="nodue" aria-label="Clear deadline">${ICON.x}</button>` : '');
  }
  function qaReset() { Object.assign(ui.qa, { space: null, due: null, dueTouched: false, critical: false, critTouched: false }); }
  function qaSubmit() {
    const e = qaEffective();
    if (!e.title.trim()) { if (!els.qaInput.value.trim()) { ui.qa.open = false; els.qaInput.blur(); renderQA(); } return; }
    const t = newTask({ title: e.title.trim().slice(0, 500), space: e.space, due: e.due, critical: e.critical });
    els.qaInput.value = ''; qaReset();
    commit(`Added to ${SPACES[t.space]}${t.due ? ' · ' + dueInfo(t.due).label.replace('Due today', 'today') : ''}`, () => {
      state.tasks.push(t); state.prefs.lastSpace = t.space;
    });
    const row = els.main.querySelector(`.task[data-id="${CSS.escape(t.id)}"]`);
    if (row) { row.classList.add('flash'); row.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
  }

  /* ---------------- actions ---------------- */
  function cycle(id) {
    const t = getTask(id); if (!t) return;
    const next = t.progress >= 100 ? 0 : STEPS.find((s) => s > t.progress);
    if (next === 100) commit(`Done: ${t.title}`, () => setProgress(t, 100));
    else commit(null, () => setProgress(t, next));
    const ring = els.main.querySelector(`.task[data-id="${CSS.escape(id)}"] .ring`);
    if (ring) ring.classList.add('bump');
  }
  function toggleDone(id) {
    const t = getTask(id); if (!t) return;
    if (isDone(t)) commit(`Reopened: ${t.title}`, () => setProgress(t, 75));
    else commit(`Done: ${t.title}`, () => setProgress(t, 100));
  }
  function snooze(id, days = 1) {
    const t = getTask(id); if (!t) return;
    const base = t.due && parseYmd(t.due) > today() ? parseYmd(t.due) : today();
    const nd = addDays(base, days);
    commit(`Moved to ${fmtShort(nd)}`, () => { t.due = ymd(nd); touch(t); });
  }
  function loadSample() {
    const t0 = today(); const d = (n) => ymd(addDays(t0, n)); const wk = thisWeek();
    const tw = { id: uid(), title: 'Ship Q4 roadmap', space: 'work', week: wk, mode: 'auto', manual: 0, created: Date.now() };
    const tw2 = { id: uid(), title: 'Clear inbox to zero by Fri', space: 'work', week: wk, mode: 'manual', manual: 50, created: Date.now() };
    const tp = { id: uid(), title: 'Run 3 times', space: 'personal', week: wk, mode: 'auto', manual: 0, created: Date.now() };
    const mk = (o, p = 0) => { const t = newTask(o); setProgress(t, p); return t; };
    const tasks = [
      mk({ title: 'Finalize roadmap slides', space: 'work', due: d(0), critical: true, targetId: tw.id }, 50),
      mk({ title: 'Review budget with finance', space: 'work', due: d(1), targetId: tw.id }, 25),
      mk({ title: 'Send vendor contract redlines', space: 'work', due: d(-1), priority: 'high' }),
      mk({ title: 'Roadmap sign-off from VP', space: 'work', due: ymd(nextDow(t0, 5, true)), targetId: tw.id }),
      mk({ title: 'Draft hiring plan', space: 'work', due: d(6), notes: '2 eng, 1 design' }),
      mk({ title: '1:1 notes cleanup', space: 'work' }, 100),
      mk({ title: 'Renew passport', space: 'personal', due: d(2), critical: true }),
      mk({ title: 'Morning run', space: 'personal', due: d(0), targetId: tp.id }, 100),
      mk({ title: 'Run — intervals', space: 'personal', due: d(2), targetId: tp.id }),
      mk({ title: 'Book dentist', space: 'personal', due: d(1) }),
      mk({ title: 'Plan weekend trip', space: 'personal' }, 25),
    ];
    tasks[2].priority = 'high';
    fxMuted = true; commit('Sample tasks loaded', () => { state.tasks.push(...tasks); state.targets.push(tw, tw2, tp); }); fxMuted = false;
  }

  /* ---------------- sheets ---------------- */
  let sheetCleanup = null;
  function openSheet(html, mount) {
    els.sheet.innerHTML = '<div class="grab"></div>' + html;
    els.overlay.classList.add('open'); els.overlay.setAttribute('aria-hidden', 'false');
    els.sheet.scrollTop = 0;
    sheetCleanup = mount ? mount(els.sheet) : null;
  }
  function closeSheet() {
    els.overlay.classList.remove('open'); els.overlay.setAttribute('aria-hidden', 'true');
    if (typeof sheetCleanup === 'function') sheetCleanup(); sheetCleanup = null;
    if (document.activeElement && els.sheet.contains(document.activeElement)) document.activeElement.blur();
  }
  const sheetHead = (title) => `<div class="sheet-h"><h3>${title}</h3><button class="x-btn" data-close aria-label="Close">${ICON.x}</button></div>`;
  const segHtml = (id, opts, cur) => `<div class="seg" id="${id}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" class="${String(cur) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const dueChipsHtml = (cur) => {
    const t0 = today(); const known = DUE_CHIPS.some((c) => ymd(c.fn(t0)) === cur);
    return DUE_CHIPS.map((c) => `<button type="button" class="chip ${ymd(c.fn(t0)) === cur ? 'on' : ''}" data-due="${ymd(c.fn(t0))}">${c.label}</button>`).join('') +
      `<label class="chip ${cur && !known ? 'on' : ''}">${ICON.cal}${cur && !known ? fmtShort(parseYmd(cur)) : 'Pick date'}<input type="date" value="${cur || ''}" data-due-input aria-label="Pick a date"></label>` +
      `<button type="button" class="chip ${!cur ? 'on' : ''}" data-due="">None</button>`;
  };
  function onSeg(root, id, fn) { const s = $('#' + id, root); s.addEventListener('click', (e) => { const b = e.target.closest('button[data-v]'); if (!b) return; s.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b)); fn(b.dataset.v); }); }

  function openQuickMenu(id) {
    const t = getTask(id); if (!t) return;
    const st = statusOf(t);
    const other = t.space === 'work' ? 'personal' : 'work';
    const sBtn = (v, l, dot) => `<button class="btn ${st === v ? 'on' : ''}" data-st="${v}" style="--dot:${dot}"><i></i>${l}</button>`;
    openSheet(`${sheetHead(esc(t.title))}
      <div class="lbl">Status</div><div class="qm-grid">${sBtn('todo', 'Not started', 'var(--muted)')}${sBtn('doing', 'In progress', 'var(--accent)')}${sBtn('blocked', 'Blocked', 'var(--crit)')}${sBtn('done', 'Done', 'var(--ok)')}</div>
      <div class="lbl">Progress</div>${segHtml('qmProg', STEPS.map((s) => [s, s + '%']), t.progress)}
      <div class="lbl" style="margin-top:16px">Deadline</div><div class="chips wrap" id="qmDue">${dueChipsHtml(t.due)}</div>
      <div class="qm-grid" style="margin-top:16px">
        <button class="btn" data-q="crit" style="${t.critical ? 'color:var(--crit)' : ''}">${t.critical ? 'Unmark critical' : '! Mark critical'}</button>
        <button class="btn" data-q="move">Move to ${SPACES[other]}</button>
        <button class="btn" data-q="edit">Edit details…</button>
        <button class="btn danger" data-q="del">Delete</button></div>`, (root) => {
      root.addEventListener('click', (e) => {
        const s = e.target.closest('[data-st]'); const q = e.target.closest('[data-q]'); const d = e.target.closest('[data-due]');
        if (s) { closeSheet(); commit(s.dataset.st === 'done' ? `Done: ${t.title}` : null, () => setStatus(t, s.dataset.st)); }
        else if (d) { closeSheet(); commit(d.dataset.due ? `Due ${fmtShort(parseYmd(d.dataset.due))}` : 'Deadline cleared', () => { t.due = d.dataset.due || null; touch(t); }); }
        else if (q) {
          const a = q.dataset.q; closeSheet();
          if (a === 'crit') commit(t.critical ? 'Unmarked critical' : 'Marked critical', () => { t.critical = !t.critical; touch(t); });
          if (a === 'move') commit(`Moved to ${SPACES[other]}`, () => { t.space = other; const tg = t.targetId && getTarget(t.targetId); if (tg && tg.space !== other) t.targetId = null; touch(t); });
          if (a === 'edit') setTimeout(() => openEdit(id), 50);
          if (a === 'del') commit('Task deleted', () => { state.tasks = state.tasks.filter((x) => x.id !== id); });
        }
      });
      onSeg(root, 'qmProg', (v) => { closeSheet(); commit(+v === 100 ? `Done: ${t.title}` : null, () => setProgress(t, +v)); });
      $('[data-due-input]', root).addEventListener('change', (e) => { if (!e.target.value) return; closeSheet(); commit(`Due ${fmtShort(parseYmd(e.target.value))}`, () => { t.due = e.target.value; touch(t); }); });
    });
  }

  function openEdit(id) {
    const t = getTask(id); if (!t) return;
    const d = JSON.parse(JSON.stringify(t));
    const targetOpts = () => {
      const wk = thisWeek();
      const list = state.targets.filter((g) => g.space === d.space && (g.week === wk || g.id === d.targetId));
      return `<option value="">None</option>` + list.map((g) => `<option value="${esc(g.id)}" ${g.id === d.targetId ? 'selected' : ''}>${esc(g.title)}${g.week !== wk ? ' (past week)' : ''}</option>`).join('');
    };
    openSheet(`${sheetHead('Edit task')}
      <label class="fld"><span>Title</span><input type="text" id="eTitle" value="${esc(d.title)}" maxlength="500" enterkeyhint="done"></label>
      <label class="fld"><span>Notes</span><textarea id="eNotes" rows="3" placeholder="Optional">${esc(d.notes)}</textarea></label>
      <div class="fld"><span>Space</span>${segHtml('eSpace', [['work', 'Work'], ['personal', 'Personal']], d.space)}</div>
      <div class="fld row"><span>Critical</span><button type="button" class="switch ${d.critical ? 'on' : ''}" id="eCrit" role="switch" aria-checked="${d.critical}" aria-label="Critical"></button></div>
      <div class="fld"><span>Priority</span>${segHtml('ePri', [['low', 'Low'], ['normal', 'Normal'], ['high', 'High']], d.priority)}</div>
      <div class="fld"><span>Deadline <em id="eDueLbl"></em></span><div class="chips wrap" id="eDue">${dueChipsHtml(d.due)}</div></div>
      <div class="fld"><span>Progress</span>${segHtml('eProg', STEPS.map((s) => [s, s + '%']), d.progress)}</div>
      <div class="fld"><span>Status</span>${segHtml('eStat', [['todo', 'Not started'], ['doing', 'Doing'], ['blocked', 'Blocked'], ['done', 'Done']], statusOf(d))}</div>
      <label class="fld"><span>Weekly target</span><select id="eTarget">${targetOpts()}</select></label>
      <div class="sheet-actions"><button class="btn danger" id="eDel">Delete</button><button class="btn primary" id="eSave">Save</button></div>`, (root) => {
      const syncSeg = (sid, val) => $('#' + sid, root).querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(val)));
      const dueLbl = () => { $('#eDueLbl', root).textContent = d.due ? fmtShort(parseYmd(d.due)) : ''; };
      const renderDue = () => { $('#eDue', root).innerHTML = dueChipsHtml(d.due); dueLbl(); };
      dueLbl();
      root.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) return; });
      onSeg(root, 'eSpace', (v) => { d.space = v; const tg = d.targetId && getTarget(d.targetId); if (tg && tg.space !== v) d.targetId = null; $('#eTarget', root).innerHTML = targetOpts(); });
      onSeg(root, 'ePri', (v) => { d.priority = v; });
      onSeg(root, 'eProg', (v) => { setProgress(d, +v); syncSeg('eStat', statusOf(d)); });
      onSeg(root, 'eStat', (v) => { setStatus(d, v); syncSeg('eProg', d.progress); });
      $('#eCrit', root).addEventListener('click', (e) => { d.critical = !d.critical; e.currentTarget.classList.toggle('on', d.critical); e.currentTarget.setAttribute('aria-checked', d.critical); });
      $('#eDue', root).addEventListener('click', (e) => { const b = e.target.closest('[data-due]'); if (!b) return; d.due = b.dataset.due || null; renderDue(); });
      $('#eDue', root).addEventListener('change', (e) => { if (e.target.matches('[data-due-input]') && e.target.value) { d.due = e.target.value; renderDue(); } });
      $('#eTarget', root).addEventListener('change', (e) => { d.targetId = e.target.value || null; });
      $('#eTitle', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
      $('#eSave', root).addEventListener('click', () => {
        d.title = $('#eTitle', root).value.trim() || t.title; d.notes = $('#eNotes', root).value;
        closeSheet(); commit('Saved', () => { Object.assign(t, d); touch(t); });
      });
      $('#eDel', root).addEventListener('click', () => { closeSheet(); commit('Task deleted', () => { state.tasks = state.tasks.filter((x) => x.id !== id); }); });
    });
  }

  function openTarget(id, space) {
    const existing = id ? getTarget(id) : null;
    const d = existing ? { ...existing } : { id: uid(), title: '', space: space || 'work', week: thisWeek(), mode: 'auto', manual: 0, created: Date.now() };
    const linkedHtml = () => {
      if (!existing) return '<p class="tg-meta" style="margin:0 2px 12px">Save the target, then link tasks to it — progress is computed from them automatically.</p>';
      const linked = state.tasks.filter((t) => t.targetId === d.id).sort(cmpTasks);
      const avail = state.tasks.filter((t) => t.space === d.space && !t.targetId && !isDone(t)).sort(cmpTasks);
      return `<ul class="linked">${linked.map((t) => `<li class="${isDone(t) ? 'done' : ''}"><span>${esc(t.title)}</span><small>${t.progress}%</small><button class="x-btn" data-unlink="${esc(t.id)}" aria-label="Unlink">${ICON.x}</button></li>`).join('') || '<li><span class="tg-meta">No linked tasks yet</span></li>'}</ul>
        ${avail.length ? `<label class="fld"><select id="tLink"><option value="">+ Link an existing task…</option>${avail.map((t) => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}</select></label>` : ''}
        <div class="fld inline-add"><input type="text" id="tNew" placeholder="New linked task… (fri, !, tmr work)" enterkeyhint="done" style="width:auto;flex:1"><button class="btn primary" id="tNewBtn" type="button">Add</button></div>`;
    };
    openSheet(`${sheetHead(existing ? 'Weekly target' : 'New weekly target')}
      <label class="fld"><span>Target</span><input type="text" id="tTitle" value="${esc(d.title)}" placeholder="e.g. Ship Q4 roadmap" maxlength="200" enterkeyhint="done"></label>
      <div class="fld"><span>Space</span>${segHtml('tSpace', [['work', 'Work'], ['personal', 'Personal']], d.space)}</div>
      <div class="fld"><span>Progress tracking</span>${segHtml('tMode', [['auto', 'Auto from tasks'], ['manual', 'Manual']], d.mode)}</div>
      <div class="fld" id="tManualWrap" ${d.mode === 'manual' ? '' : 'hidden'}><span>Manual progress</span>${segHtml('tManual', STEPS.map((s) => [s, s + '%']), d.manual)}</div>
      <div class="lbl">Linked tasks</div><div id="tLinked">${linkedHtml()}</div>
      <div class="sheet-actions">${existing ? '<button class="btn danger" id="tDel">Delete</button>' : ''}<button class="btn primary" id="tSave">${existing ? 'Save' : 'Add target'}</button></div>`, (root) => {
      const rerenderLinked = () => { $('#tLinked', root).innerHTML = linkedHtml(); };
      onSeg(root, 'tSpace', (v) => { d.space = v; });
      onSeg(root, 'tMode', (v) => { d.mode = v; $('#tManualWrap', root).hidden = v !== 'manual'; });
      onSeg(root, 'tManual', (v) => { d.manual = +v; });
      if (!existing) setTimeout(() => $('#tTitle', root).focus(), 320);
      const linkedBox = $('#tLinked', root);
      linkedBox.addEventListener('click', (e) => {
        const u = e.target.closest('[data-unlink]');
        if (u) { const t = getTask(u.dataset.unlink); if (t) { t.targetId = null; touch(t); persist(); render(); rerenderLinked(); } }
        if (e.target.closest('#tNewBtn')) addNew();
      });
      linkedBox.addEventListener('change', (e) => {
        if (e.target.id === 'tLink' && e.target.value) { const t = getTask(e.target.value); if (t) { t.targetId = d.id; touch(t); persist(); render(); rerenderLinked(); } }
      });
      linkedBox.addEventListener('keydown', (e) => { if (e.target.id === 'tNew' && e.key === 'Enter') { e.preventDefault(); addNew(); } });
      function addNew() {
        const inp = $('#tNew', root); const p = parseQuick(inp.value); if (!p.title.trim()) return;
        state.tasks.push(newTask({ title: p.title.trim(), space: d.space, due: p.due ? ymd(p.due) : null, critical: p.critical, targetId: d.id }));
        persist(); render(); rerenderLinked(); setTimeout(() => $('#tNew', root) && $('#tNew', root).focus(), 0);
      }
      $('#tTitle', root).addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } });
      $('#tSave', root).addEventListener('click', () => {
        const title = $('#tTitle', root).value.trim(); if (!title) { $('#tTitle', root).focus(); return; }
        d.title = title.slice(0, 200); closeSheet();
        commit(existing ? 'Target saved' : 'Target added', () => {
          if (existing) {
            Object.assign(existing, d);
            state.tasks.forEach((t) => { if (t.targetId === d.id && t.space !== d.space) t.targetId = null; });
          } else state.targets.push(d);
        });
      });
      const del = $('#tDel', root);
      if (del) del.addEventListener('click', () => { closeSheet(); commit('Target deleted', () => { state.targets = state.targets.filter((x) => x.id !== d.id); state.tasks.forEach((t) => { if (t.targetId === d.id) t.targetId = null; }); }); });
    });
  }

  function confirmSheet(title, body, okLabel, danger, onOk) {
    openSheet(`${sheetHead(title)}<p style="color:var(--muted);margin:0 2px 8px">${body}</p><div class="sheet-actions"><button class="btn" data-close>Cancel</button><button class="btn ${danger ? 'danger' : 'primary'}" id="cOk">${okLabel}</button></div>`,
      (root) => { $('#cOk', root).addEventListener('click', () => { closeSheet(); onOk(); }); });
  }

  /* ---------------- backup ---------------- */
  function exportData() {
    const data = { app: 'focus', format: 1, exportedAt: new Date().toISOString(), tasks: state.tasks, targets: state.targets };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `focus-backup-${ymd(new Date())}.json`; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    state.prefs.lastExport = Date.now(); persist(); render();
    toast('Backup exported');
  }
  function normTask(x) {
    if (!x || typeof x !== 'object' || typeof x.title !== 'string' || !x.title.trim()) return null;
    const p = Number(x.progress);
    return { id: String(x.id || uid()).slice(0, 80), title: x.title.slice(0, 500), notes: typeof x.notes === 'string' ? x.notes.slice(0, 10000) : '',
      space: x.space === 'personal' ? 'personal' : 'work', critical: !!x.critical, priority: ['low', 'normal', 'high'].includes(x.priority) ? x.priority : 'normal',
      due: typeof x.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.due) ? x.due : null, progress: Number.isFinite(p) ? snapStep(p) : 0,
      blocked: !!x.blocked, targetId: x.targetId ? String(x.targetId).slice(0, 80) : null,
      created: Number(x.created) || Date.now(), updated: Number(x.updated) || Date.now(), doneAt: Number(x.doneAt) || null };
  }
  function normTarget(x) {
    if (!x || typeof x !== 'object' || typeof x.title !== 'string' || !x.title.trim()) return null;
    return { id: String(x.id || uid()).slice(0, 80), title: x.title.slice(0, 200), space: x.space === 'personal' ? 'personal' : 'work',
      week: typeof x.week === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x.week) ? x.week : thisWeek(), mode: x.mode === 'manual' ? 'manual' : 'auto',
      manual: snapStep(Number(x.manual) || 0), created: Number(x.created) || Date.now() };
  }
  async function importFile(file) {
    let data;
    try { if (file.size > 20e6) throw new Error('too big'); data = JSON.parse(await file.text()); } catch { toast('That file is not a valid Focus backup'); return; }
    if (!data || !Array.isArray(data.tasks)) { toast('That file is not a valid Focus backup'); return; }
    const tasks = data.tasks.map(normTask).filter(Boolean); const targets = (data.targets || []).map(normTarget).filter(Boolean);
    openSheet(`${sheetHead('Import backup')}<p style="color:var(--muted);margin:0 2px 8px">Found <b>${tasks.length}</b> tasks and <b>${targets.length}</b> targets${data.exportedAt ? ` from ${esc(String(data.exportedAt).slice(0, 10))}` : ''}.<br><br><b>Merge</b> keeps your current data and adds/updates from the file. <b>Replace</b> wipes current data first.</p>
      <div class="sheet-actions"><button class="btn" id="iMerge">Merge</button><button class="btn danger" id="iReplace">Replace</button></div>`, (root) => {
      const apply = (replace) => {
        closeSheet();
        commit(replace ? 'Backup restored' : 'Backup merged', () => {
          if (replace) { state.tasks = tasks; state.targets = targets; return; }
          const merge = (cur, inc) => { const m = new Map(cur.map((x) => [x.id, x])); inc.forEach((x) => { const e = m.get(x.id); if (!e || (x.updated || 0) >= (e.updated || 0)) m.set(x.id, x); }); return [...m.values()]; };
          state.tasks = merge(state.tasks, tasks); state.targets = merge(state.targets, targets);
        });
      };
      $('#iMerge', root).addEventListener('click', () => apply(false));
      $('#iReplace', root).addEventListener('click', () => apply(true));
    });
  }

  /* ---------------- toast ---------------- */
  let toastTimer;
  function toast(msg, undo) {
    clearTimeout(toastTimer);
    els.toast.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button type="button">Undo</button>' : ''}`;
    if (undo) els.toast.querySelector('button').onclick = () => { undo(); els.toast.classList.remove('show'); };
    els.toast.classList.add('show');
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), undo ? 4500 : 2200);
  }

  /* ---------------- gestures: swipe + long-press on task rows ---------------- */
  let g = null, suppressClick = 0;
  function bindGestures() {
    const main = els.main;
    main.addEventListener('pointerdown', (e) => {
      const row = e.target.closest('.task'); if (!row || e.button > 0) return;
      const inner = row.querySelector('.task-inner');
      g = { row, inner, id: row.dataset.id, x: e.clientX, y: e.clientY, dx: 0, mode: null, pid: e.pointerId,
        timer: setTimeout(() => { if (g && !g.mode) { g.mode = 'long'; suppressClick = Date.now(); if (navigator.vibrate) navigator.vibrate(10); openQuickMenu(g.id); } }, 480) };
    });
    main.addEventListener('pointermove', (e) => {
      if (!g || e.pointerId !== g.pid) return;
      const dx = e.clientX - g.x, dy = e.clientY - g.y;
      if (!g.mode) {
        if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy) * 1.3) { g.mode = 'swipe'; clearTimeout(g.timer); g.row.classList.add('swiping'); try { g.inner.setPointerCapture(e.pointerId); } catch {} }
        else if (Math.abs(dy) > 10) { g.mode = 'scroll'; clearTimeout(g.timer); }
      }
      if (g.mode === 'swipe') {
        g.dx = Math.max(-160, Math.min(160, dx));
        g.inner.style.transform = `translateX(${g.dx}px)`;
        g.row.classList.toggle('dir-r', g.dx > 0); g.row.classList.toggle('dir-l', g.dx < 0);
        g.row.classList.toggle('arm', Math.abs(g.dx) > 80);
      }
    });
    const end = () => {
      if (!g) return; clearTimeout(g.timer);
      if (g.mode === 'swipe') {
        suppressClick = Date.now();
        const { dx, id, row, inner } = g;
        row.classList.remove('swiping'); inner.style.transform = '';
        setTimeout(() => row.classList.remove('dir-r', 'dir-l', 'arm'), 250);
        if (dx > 80) setTimeout(() => toggleDone(id), 120);
        else if (dx < -80) setTimeout(() => snooze(id, 1), 120);
      }
      g = null;
    };
    main.addEventListener('pointerup', end);
    main.addEventListener('pointercancel', end);
    main.addEventListener('contextmenu', (e) => { if (e.target.closest('.task')) e.preventDefault(); });
  }

  /* ---------------- events ---------------- */
  function onMainClick(e) {
    if (Date.now() - suppressClick < 400) { e.preventDefault(); return; }
    const el = e.target.closest('[data-act]'); if (!el) return;
    const act = el.dataset.act; const row = el.closest('.task'); const id = row && row.dataset.id;
    switch (act) {
      case 'cycle': cycle(id); break;
      case 'edit': openEdit(id); break;
      case 'menu': openQuickMenu(id); break;
      case 'day': ui.day = el.dataset.day && ui.day !== el.dataset.day ? el.dataset.day : null; render(); break;
      case 'filter': ui.filter = el.dataset.f; render(); break;
      case 'sample': loadSample(); break;
      case 'mustall': ui.mustAll = !ui.mustAll; render(); break;
      case 'addtarget': openTarget(null, el.dataset.space); break;
      case 'target': openTarget(el.dataset.id); break;
      case 'tgcycle': {
        e.stopPropagation(); const tg = getTarget(el.dataset.id); if (!tg) break;
        const next = (tg.manual || 0) >= 100 ? 0 : STEPS.find((s) => s > (tg.manual || 0));
        commit(next === 100 ? `Target hit: ${tg.title}` : null, () => { tg.manual = next; }); break;
      }
      case 'carry': {
        const wk = thisWeek(); const lastWk = ymd(addDays(parseYmd(wk), -7));
        commit('Targets carried over', () => {
          state.targets.filter((t) => t.week === lastWk && targetProgress(t).pct < 100).forEach((old) => {
            const nt = { ...old, id: uid(), week: wk, created: Date.now() }; state.targets.push(nt);
            state.tasks.forEach((t) => { if (t.targetId === old.id && !isDone(t)) t.targetId = nt.id; });
          });
        }); break;
      }
      case 'export': exportData(); break;
      case 'import': els.importFile.value = ''; els.importFile.click(); break;
      case 'cleardone': {
        const sp = ui.view === 'work' || ui.view === 'personal' ? ui.view : null;
        const n = state.tasks.filter((t) => isDone(t) && (!sp || t.space === sp)).length;
        if (!n) { toast('No completed tasks'); break; }
        commit(`Cleared ${n} completed`, () => { state.tasks = state.tasks.filter((t) => !(isDone(t) && (!sp || t.space === sp))); }); break;
      }
      case 'erase':
        confirmSheet('Erase all data?', 'This deletes every task and target on this device. Export a backup first if you might need them.', 'Erase everything', true,
          () => { commit('All data erased', () => { const p = state.prefs; state = defaultState(); state.prefs.lastExport = p.lastExport; }); });
        break;
    }
  }

  function setView(v) {
    if (ui.view === v) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    ui.view = v; ui.day = null; ui.filter = 'active'; ui.qa.space = null; state.prefs.view = v; persist();
    render(); window.scrollTo(0, 0);
  }

  function bindEvents() {
    els.tabbar.addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });
    els.main.addEventListener('click', onMainClick);
    els.topbar.addEventListener('click', onMainClick);
    els.main.addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.target')) { e.preventDefault(); openTarget(e.target.dataset.id); } });

    // quick add
    els.qaInput.addEventListener('focus', () => { ui.qa.open = true; document.body.classList.add('qa-focus'); renderQA(); });
    els.qaInput.addEventListener('blur', () => document.body.classList.remove('qa-focus'));
    els.qaInput.addEventListener('input', renderQA);
    els.qa.addEventListener('submit', (e) => { e.preventDefault(); qaSubmit(); });
    els.qaChips.addEventListener('mousedown', (e) => { if (!e.target.closest('label')) e.preventDefault(); });
    els.qaChips.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-qa]'); if (!b) return;
      const eff = qaEffective();
      if (b.dataset.qa === 'space') ui.qa.space = eff.space === 'work' ? 'personal' : 'work';
      if (b.dataset.qa === 'crit') { ui.qa.critTouched = true; ui.qa.critical = !eff.critical; }
      if (b.dataset.qa === 'due') { const c = DUE_CHIPS.find((x) => x.k === b.dataset.k); const v = ymd(c.fn(today())); ui.qa.dueTouched = true; ui.qa.due = eff.due === v ? null : v; }
      if (b.dataset.qa === 'nodue') { ui.qa.dueTouched = true; ui.qa.due = null; }
      renderQA();
      els.qaInput.focus({ preventScroll: true });
    });
    els.qaChips.addEventListener('change', (e) => { if (e.target.dataset.qa === 'date' && e.target.value) { ui.qa.dueTouched = true; ui.qa.due = e.target.value; renderQA(); } });
    document.addEventListener('pointerdown', (e) => {
      if (ui.qa.open && !els.qa.contains(e.target) && !els.overlay.contains(e.target) && !els.toast.contains(e.target) && !els.qaInput.value.trim()) { ui.qa.open = false; qaReset(); renderQA(); }
    });

    // sheet
    els.overlay.addEventListener('click', (e) => { if (e.target === els.overlay || e.target.closest('[data-close]')) closeSheet(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { if (els.overlay.classList.contains('open')) closeSheet(); else if (ui.qa.open) { els.qaInput.blur(); ui.qa.open = false; renderQA(); } } });

    els.importFile.addEventListener('change', () => { const f = els.importFile.files[0]; if (f) importFile(f); });

    // keyboard (iOS): keep quick-add above the on-screen keyboard
    if (window.visualViewport) {
      const vv = window.visualViewport;
      const f = () => { const kb = Math.max(0, window.innerHeight - vv.height - vv.offsetTop); document.documentElement.style.setProperty('--kb', kb + 'px'); document.body.classList.toggle('kb-open', kb > 80); };
      vv.addEventListener('resize', f); vv.addEventListener('scroll', f);
    }
    // re-render when the day changes / app returns to foreground
    let lastDay = ymd(new Date());
    const dayCheck = () => { const d = ymd(new Date()); if (d !== lastDay) { lastDay = d; render(); } };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { dayCheck(); render(); } });
    setInterval(dayCheck, 60000);
  }

  /* ---------------- effects ---------------- */
  function burst(x, y) {
    if (reduced()) return;
    const b = document.createElement('div'); b.className = 'burst'; b.style.transform = `translate(${x}px,${y}px)`;
    const cols = ['var(--ok)', 'var(--work)', 'var(--personal)', '#ffffff'];
    let h = '<div class="wave"></div><div class="tx">COMPLETE</div>';
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * 360 + Math.random() * 14, d = 36 + Math.random() * 38;
      h += `<i class="p${i % 3 === 0 ? ' l' : ''}" style="--a:${a.toFixed(0)}deg;--d:${d.toFixed(0)}px;--c:${cols[i % 4]};animation-delay:${(Math.random() * 60).toFixed(0)}ms"></i>`;
    }
    b.innerHTML = h; document.body.appendChild(b);
    if (navigator.vibrate) navigator.vibrate(12);
    setTimeout(() => b.remove(), 1300);
  }
  function bindRipples() {
    const sel = '.btn,.chip,.seg button,.tabbar button,.qa-add,.more-btn,.target,.wd,.link-btn,.x-btn,.toast button,.task-inner';
    document.addEventListener('pointerdown', (e) => {
      if (reduced()) return;
      const el = e.target.closest(sel); if (!el) return;
      const r = el.getBoundingClientRect(); const s = document.createElement('span'); s.className = 'rip';
      s.style.left = (e.clientX - r.left) + 'px'; s.style.top = (e.clientY - r.top) + 'px';
      s.style.setProperty('--rs', (Math.max(r.width, r.height) / 16 * 2.3).toFixed(1));
      el.appendChild(s); setTimeout(() => s.remove(), 650);
    }, { passive: true });
  }
  /* starfield: ~30fps, capped DPR, paused when hidden, static under reduced motion */
  function starfield() {
    const c = $('#fx'); if (!c || !c.getContext) return; const ctx = c.getContext('2d');
    const mqR = matchMedia('(prefers-reduced-motion: reduce)'), mqL = matchMedia('(prefers-color-scheme: light)');
    let w = 0, h = 0, stars = [], raf = 0, last = 0, shoot = null;
    function size() {
      const dpr = Math.min(2, window.devicePixelRatio || 1); const nw = window.innerWidth, nh = window.innerHeight;
      c.width = Math.round(nw * dpr); c.height = Math.round(nh * dpr); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (nw !== w || !stars.length) {
        const n = Math.min(220, Math.round((nw * nh) / 4200));
        stars = Array.from({ length: n }, () => ({ x: Math.random() * nw, y: Math.random() * Math.max(nh, 900), z: Math.random() * 0.85 + 0.15, t: Math.random() * 6.28, s: Math.random() * 0.8 + 0.4, hue: Math.random() < 0.18 ? (Math.random() < 0.5 ? 1 : 2) : 0 }));
      }
      w = nw; h = nh; draw(0);
    }
    const tints = [[205, 222, 255], [120, 235, 255], [255, 140, 230]];
    function draw(dt) {
      ctx.clearRect(0, 0, w, h); const lt = mqL.matches;
      for (const s of stars) {
        s.y -= dt * 0.008 * s.z; if (s.y < -2) { s.y = h + 2; s.x = Math.random() * w; }
        s.t += dt * 0.0022 * s.s;
        const col = lt ? [50, 70, 150] : tints[s.hue];
        ctx.globalAlpha = (lt ? 0.22 : 0.9) * s.z * (0.5 + 0.5 * Math.sin(s.t));
        ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
        const r = s.z * 1.4; ctx.fillRect(s.x, s.y, r, r);
      }
      ctx.globalAlpha = 1;
      if (!lt && dt) {
        if (!shoot && Math.random() < dt * 0.00005) shoot = { x: w * (0.3 + Math.random() * 0.7), y: h * Math.random() * 0.4, l: 0 };
        if (shoot) {
          shoot.l += dt; const p = shoot.l / 800, x = shoot.x - p * 280, y = shoot.y + p * 140;
          const g = ctx.createLinearGradient(x, y, x + 70, y - 35); g.addColorStop(0, 'rgba(170,240,255,.9)'); g.addColorStop(1, 'rgba(170,240,255,0)');
          ctx.strokeStyle = g; ctx.lineWidth = 1.3; ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 70, y - 35); ctx.stroke();
          if (p >= 1) shoot = null;
        }
      }
    }
    function loop(ts) { raf = requestAnimationFrame(loop); const dt = ts - last; if (dt < 31) return; last = ts; draw(Math.min(dt, 80)); }
    function start() { cancelAnimationFrame(raf); raf = 0; if (mqR.matches || document.hidden) { draw(0); return; } last = performance.now(); raf = requestAnimationFrame(loop); }
    window.addEventListener('resize', size);
    document.addEventListener('visibilitychange', start);
    if (mqR.addEventListener) { mqR.addEventListener('change', start); mqL.addEventListener('change', () => draw(0)); }
    size(); start();
    fxState.running = () => raf !== 0;
  }
  const fxState = { running: () => false };

  /* ---------------- boot ---------------- */
  async function boot() {
    Object.assign(els, { topbar: $('#topbar'), main: $('#main'), tabbar: $('#tabbar'), qa: $('#qa'), qaInput: $('#qaInput'), qaChips: $('#qaChips'),
      overlay: $('#overlay'), sheet: $('#sheet'), toast: $('#toast'), importFile: $('#importFile') });
    await Store.open();
    try {
      const saved = await Store.get('state');
      if (saved && Array.isArray(saved.tasks)) {
        state = { ...defaultState(), ...saved, prefs: { ...defaultState().prefs, ...(saved.prefs || {}) } };
        state.tasks = state.tasks.map(normTask).filter(Boolean); state.targets = (state.targets || []).map(normTarget).filter(Boolean);
      }
    } catch (e) { console.warn('load failed', e); }
    ui.view = ['home', 'work', 'personal', 'more'].includes(state.prefs.view) ? state.prefs.view : 'home';
    bindEvents(); bindGestures(); bindRipples(); render(); starfield();
    // ask the browser not to evict our storage (granted automatically for Home Screen apps on iOS)
    try { if (navigator.storage && navigator.storage.persist) { persisted = (await navigator.storage.persisted()) || (await navigator.storage.persist()); if (ui.view === 'more') render(); } } catch {}
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW registration failed', e));
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) toast('App updated — reopen to use the new version'); });
    }
    window.__focus = { state: () => state, parseQuick, fx: () => fxState.running(), ready: true };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();

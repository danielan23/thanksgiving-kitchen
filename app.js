(() => {
  'use strict';

  // ---------- small helpers ----------
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const md = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>');
  const plain = s => String(s).replace(/\*+/g, '');
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
  };
  const session = {
    get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } },
  };

  const ICON = {
    back: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 5l-7 7 7 7"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/></svg>',
    phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6.5" y="2.5" width="11" height="19" rx="2.5"/><path d="M10.5 18h3"/></svg>',
    theme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor"/></svg>',
  };

  // ---------- state ----------
  let DATA = null;
  let prefs = Object.assign({ size: 0, theme: 'auto', wake: true }, store.get('tk:prefs', {}));
  let state = store.get('tk:state', { v: 1, recipes: {} });
  let timers = store.get('tk:timers', []);
  let current = null; // { recipe, tab }

  const saveState = () => store.set('tk:state', state);
  const savePrefs = () => store.set('tk:prefs', prefs);
  const saveTimers = () => store.set('tk:timers', timers);

  const recipeById = id => DATA.recipes.find(r => r.id === id);
  const totalSteps = r => r.method.reduce((n, g) => n + g.steps.length, 0);
  function rs(r) {
    let s = state.recipes[r.id];
    if (!s || s.rev !== r.revision) {
      const stale = !!s;
      s = state.recipes[r.id] = { rev: r.revision, steps: {}, ing: {}, touched: 0 };
      if (stale) setTimeout(() => toast('This recipe was revised, so your earlier ticks were cleared.'), 400);
    }
    return s;
  }
  const doneCount = r => Object.keys(rs(r).steps).length;

  // ---------- appearance ----------
  function applyPrefs() {
    const root = document.documentElement;
    root.style.setProperty('--scale', [1, 1.125, 1.25][prefs.size] || 1);
    if (prefs.theme === 'auto') root.removeAttribute('data-theme'); else root.dataset.theme = prefs.theme;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ---------- wake lock ----------
  let lock = null;
  const wakeSupported = 'wakeLock' in navigator;
  async function setWake(on) {
    if (!wakeSupported) return;
    try {
      if (on && !lock) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } else if (!on && lock) {
        await lock.release();
        lock = null;
      }
    } catch { lock = null; }
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && current && prefs.wake) setWake(true);
  });

  // ---------- timers ----------
  const FRAC = { '½': .5, '¼': .25, '¾': .75, '⅓': 1 / 3, '⅔': 2 / 3 };
  const num = s => {
    const m = String(s).match(/^(\d*)([.,]\d+)?([½¼¾⅓⅔])?$/);
    return m ? (parseFloat((m[1] || '0') + (m[2] || '').replace(',', '.')) || 0) + (FRAC[m[3]] || 0) : NaN;
  };
  const fmtMins = m => {
    if (m < 60) return `${+m.toFixed(1)} min`;
    const h = Math.floor(m / 60), r = Math.round(m - h * 60);
    return r ? `${h} h ${r} min` : `${h} h`;
  };
  // Durations are read from the method text itself; nothing is invented. A range starts at its lower end.
  function findTimers(text) {
    const t = plain(text), out = [], seen = new Set(), highs = new Set();
    const re = /(\d+(?:[.,]\d+)?[½¼¾⅓⅔]?|[½¼¾⅓⅔])(?:\s*[–-]\s*(\d+(?:[.,]\d+)?[½¼¾⅓⅔]?|[½¼¾⅓⅔]))?[\s-]*(minutes?|mins?|hours?|hrs?)\b/gi;
    let m;
    while ((m = re.exec(t))) {
      if (/(within|up to|no more than|every|per)\s*(about\s*)?$/i.test(t.slice(Math.max(0, m.index - 16), m.index))) continue;
      const hours = /^h/i.test(m[3]);
      const low = num(m[1]) * (hours ? 60 : 1);
      if (!(low > 0) || low > 480 || seen.has(low) || highs.has(low)) continue;
      seen.add(low);
      if (m[2]) highs.add(num(m[2]) * (hours ? 60 : 1));
      out.push({ mins: low, range: m[2] ? `${m[1]}–${m[2]} ${hours ? 'hours' : 'min'}` : '' });
    }
    return out;
  }
  let ctx = null, lastBeep = 0;
  function unlockAudio() {
    try { ctx = ctx || new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); } catch { /* no audio */ }
  }
  function beep() {
    if (!ctx) return;
    const t0 = ctx.currentTime;
    [0, .28, .56].forEach(o => {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.frequency.value = 880; g.gain.setValueAtTime(.0001, t0 + o);
      g.gain.exponentialRampToValueAtTime(.35, t0 + o + .02); g.gain.exponentialRampToValueAtTime(.0001, t0 + o + .22);
      osc.connect(g).connect(ctx.destination); osc.start(t0 + o); osc.stop(t0 + o + .25);
    });
    try { navigator.vibrate && navigator.vibrate([200, 100, 200]); } catch { /* ignore */ }
  }
  function toggleTimer(key, label, mins) {
    unlockAudio();
    const i = timers.findIndex(t => t.key === key);
    if (i >= 0) timers.splice(i, 1);
    else timers.push({ key, label, mins, end: Date.now() + mins * 60000, fired: false });
    saveTimers(); tick();
  }
  const mmss = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60); return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m)) + ':' + String(s % 60).padStart(2, '0'); };
  function tick() {
    const now = Date.now();
    timers.forEach(t => { if (!t.fired && now >= t.end) { t.fired = true; saveTimers(); } });
    timers = timers.filter(t => !(t.fired && now - t.end > 30 * 60000));
    const ringing = timers.some(t => t.fired);
    if (ringing && now - lastBeep > 4500) { lastBeep = now; beep(); }
    renderDock(now);
    $$('[data-act="timer"]').forEach(b => {
      const t = timers.find(x => x.key === b.dataset.key);
      b.classList.toggle('running', !!t);
      b.innerHTML = t ? `${ICON.clock}${t.fired ? 'Done' : mmss(t.end - now)}` : `${ICON.clock}${esc(b.dataset.text)}`;
      b.setAttribute('aria-label', t ? `Timer running, ${t.fired ? 'finished' : mmss(t.end - now) + ' left'}. Tap to cancel.` : b.dataset.aria);
    });
  }
  function renderDock(now = Date.now()) {
    const dock = $('#timer-dock');
    dock.hidden = !timers.length;
    document.body.classList.toggle('has-dock', !!timers.length);
    document.body.style.paddingBottom = timers.length ? `${dock.offsetHeight}px` : '';
    dock.innerHTML = timers.map(t => t.fired
      ? `<div class="timer finished"><span class="t-label">Time’s up: ${esc(t.label)}</span><button class="x" data-act="cancel" data-key="${esc(t.key)}">Dismiss</button></div>`
      : `<div class="timer"><span class="t-label">${esc(t.label)}</span><span class="t-time" aria-hidden="true">${mmss(t.end - now)}</span><button class="x" data-act="cancel" data-key="${esc(t.key)}" aria-label="Cancel timer for ${esc(t.label)}">Cancel</button></div>`).join('');
  }

  // ---------- views ----------
  function tools(recipe) {
    const themeLabel = { auto: 'Theme: automatic', light: 'Theme: light', dark: 'Theme: dark' }[prefs.theme];
    return `<div class="bar-tools">
      ${recipe && wakeSupported ? `<button class="tool" data-act="wake" aria-pressed="${prefs.wake}" aria-label="Keep screen on">${ICON.phone}<span>Awake</span></button>` : ''}
      <button class="tool" data-act="size" aria-label="Text size, currently ${['standard', 'large', 'extra large'][prefs.size]}. Tap to change.">Aa</button>
      <button class="tool" data-act="theme" aria-label="${themeLabel}. Tap to change.">${ICON.theme}</button>
    </div>`;
  }

  function homeView() {
    const started = DATA.recipes.filter(r => { const d = doneCount(r); return d > 0 && d < totalSteps(r); })
      .sort((a, b) => rs(b).touched - rs(a).touched)[0];
    const sections = DATA.courses.map(c => {
      const list = DATA.recipes.filter(r => r.course === c.id);
      if (!list.length) return '';
      return `<section class="course" style="--c:${c.color}"><h2><span class="dot"></span>${esc(c.label)}</h2><div class="cards">${list.map(r => {
        const d = doneCount(r), n = totalSteps(r);
        return `<a class="card" href="#/r/${r.id}" style="--c:${c.color}">
          <h3>${esc(r.title)}</h3>${r.subtitle ? `<div class="sub">${esc(r.subtitle)}</div>` : ''}${r.makes ? `<div class="makes">${esc(r.makes)}</div>` : ''}
          ${d ? `<div class="progress" aria-hidden="true"><i style="width:${Math.round(d / n * 100)}%"></i></div><div class="prog-label">${d === n ? 'All steps done' : `${d} of ${n} steps done`}</div>` : ''}</a>`;
      }).join('')}</div></section>`;
    }).join('');
    return `<header class="bar"><div class="bar-inner"><div class="bar-title">Thanksgiving Kitchen</div>${tools(false)}</div></header>
      <main class="wrap">
        <div class="home-head"><h1>What are we cooking?</h1><p>Saturday 28 November · 8 guests</p></div>
        ${started ? `<a class="resume" href="#/r/${started.id}/method"><small>Pick up where you left off</small><strong>${esc(started.title)}</strong><span>${doneCount(started)} of ${totalSteps(started)} steps done</span></a>` : ''}
        ${sections}
        <p class="home-foot">Your ticks are saved on this device. Open a recipe, tick ingredients as you weigh them and tick each step as you finish it.</p>
      </main>`;
  }

  function ingredientsPanel(r) {
    const s = rs(r);
    let html = '', last = '';
    if (r.batch.length) {
      html += `<details class="fold"><summary>Batch and portions</summary><div class="fold-body bul">${r.batch.map(b => `<li>${md(b)}</li>`).join('')}</div></details>`;
    }
    r.ingredients.forEach((g, gi) => {
      if (g.heading && g.heading !== last) html += `<h3 class="grp">${md(g.heading)}</h3>`;
      last = g.heading;
      if (g.group) html += `<h3 class="grp">${md(g.group)}</h3>`;
      const label = g.labels && g.labels.amount;
      if (label && !/^amount|batch amount$/i.test(label) && !/amount and preparation/i.test(label)) html += `<p class="col-label">${md(label)}</p>`;
      html += '<div class="ings">' + g.rows.map((row, ri) => {
        const key = `${gi}.${ri}`;
        return `<button class="ing" data-act="ing" data-key="${key}" aria-pressed="${!!s.ing[key]}">
          <span class="box">${ICON.check}</span>
          <span class="ing-text"><span class="ing-name">${md(row.name)}</span>
          ${row.amount ? `<span class="ing-amount">${md(row.amount)}</span>` : ''}
          ${(row.extra || []).map(e => `<span class="ing-extra"><b>${esc(e.label)}:</b> ${md(e.text)}</span>`).join('')}
          ${row.note ? `<span class="ing-note">${md(row.note)}</span>` : ''}</span></button>`;
      }).join('') + '</div>';
      (g.notes || []).forEach(n => { html += `<p class="small-note">${md(n)}</p>`; });
    });
    if (r.setup.length) {
      html += `<details class="fold"><summary>Equipment and set-up</summary><div class="fold-body">${r.setup.map(sec =>
        `${sec.heading ? `<p class="sub-h">${md(sec.heading)}</p>` : ''}<ul class="bul">${sec.items.map(i => `<li>${md(i)}</li>`).join('')}</ul>`).join('')}</div></details>`;
    }
    return html;
  }

  function stepHtml(r, st) {
    const timersFound = findTimers(st.text);
    const peek = plain(st.title || st.text).slice(0, 58).trim();
    const tools = timersFound.map(t => {
      const key = `${r.id}:${st.n}:${t.mins}`, text = fmtMins(t.mins);
      const aria = `Start a ${text} timer${t.range ? ` (the recipe says ${t.range})` : ''} for step ${st.n}`;
      return `<button class="pill" data-act="timer" data-key="${key}" data-mins="${t.mins}" data-label="${esc(r.title)}, step ${st.n}" data-text="${esc(text)}" data-aria="${esc(aria)}" ${t.range ? `title="Recipe says ${esc(t.range)}; this timer rings at the lower end"` : ''}>${ICON.clock}${esc(text)}</button>`;
    }).join('');
    return `<li class="step" id="s${st.n}" data-n="${st.n}">
      <button class="num" data-act="step" data-n="${st.n}" aria-pressed="false" aria-label="Mark step ${st.n} done"><span>${st.n}</span>${ICON.check}</button>
      <div class="step-body" data-act="peek">
        <h3 class="step-title" data-peek="${esc(peek)}${peek.length >= 58 ? '…' : ''}">${md(st.title || '')}</h3>
        <p class="step-text">${md(st.text)}</p>
        ${tools || st.aside ? `<div class="step-tools">${tools}${st.aside ? '<button class="pill ghost" data-act="aside" aria-expanded="false">Note</button>' : ''}</div>` : ''}
        ${st.aside ? `<div class="aside" hidden>${md(st.aside)}</div>` : ''}
      </div></li>`;
  }

  function methodPanel(r) {
    let html = '';
    r.method.forEach(g => {
      if (g.heading) html += `<h2 class="method-grp">${md(g.heading)}</h2>`;
      html += `<ol class="steps">${g.steps.map(st => stepHtml(r, st)).join('')}</ol>`;
      if (g.notes.length) html += `<div class="mnotes">${g.notes.map(n => `<div class="note-text">${md(n)}</div>`).join('')}</div>`;
    });
    return html + '<div class="alldone" hidden>All steps done. Enjoy it.</div>';
  }

  function notesPanel(r) {
    const asides = r.method.flatMap(g => g.steps).filter(s => s.aside);
    return `<div class="banner"><strong>Revision ${esc(r.revision)}.</strong> This is a banked master. Quantities, timings and yields are the recipe’s current working figures and stay untested until cooked.</div>
      ${r.notes.map(sec => `<h2 class="sec">${md(sec.heading || 'Make ahead and storage')}</h2><ul class="bul">${sec.items.map(i => `<li>${md(i)}</li>`).join('')}</ul>`).join('')}
      ${asides.length ? `<h2 class="sec">Notes on steps</h2><div class="stepnotes">${asides.map(s => `<div class="note-text"><strong>Step ${s.n}.</strong> ${md(s.aside)}</div>`).join('')}</div>` : ''}
      <div class="danger"><button class="btn warn" data-act="reset">Clear ticks for this recipe</button></div>`;
  }

  function recipeView(r, tab) {
    const course = DATA.courses.find(c => c.id === r.course);
    const n = totalSteps(r);
    const tabs = [['ingredients', 'Ingredients'], ['method', 'Method'], ['notes', 'Notes']];
    return `<header class="bar"><div class="bar-inner">
        <a class="back" href="#/" aria-label="Back to all recipes">${ICON.back}<span>Recipes</span></a>
        <div class="bar-title" aria-hidden="true"></div>${tools(true)}</div></header>
      <div class="recipe-head" style="--c:${course.color}">
        <span class="chip"><span class="dot" style="--c:${course.color}"></span>${esc(course.label)}</span>
        <h1>${esc(r.title)}</h1>${r.subtitle ? `<p class="sub">${esc(r.subtitle)}</p>` : ''}
        ${r.makes ? `<span class="makes">${esc(r.makes)}</span>` : ''}
      </div>
      <div class="tabbar"><div class="tabs" role="tablist" aria-label="Recipe sections">${tabs.map(([id, label]) =>
        `<button class="tab" role="tab" id="tab-${id}" data-act="tab" data-tab="${id}" aria-selected="${tab === id}" aria-controls="panel-${id}" tabindex="${tab === id ? 0 : -1}">${label}${id === 'method' ? ` <span class="n" id="method-n">${doneCount(r)}/${n}</span>` : ''}</button>`).join('')}</div></div>
      <div class="layout" data-tab="${tab}">
        <section class="panel p-ingredients" id="panel-ingredients" role="tabpanel" aria-labelledby="tab-ingredients">${ingredientsPanel(r)}</section>
        <section class="panel p-method" id="panel-method" role="tabpanel" aria-labelledby="tab-method">${methodPanel(r)}</section>
        <section class="panel p-notes" id="panel-notes" role="tabpanel" aria-labelledby="tab-notes">${notesPanel(r)}</section>
      </div>`;
  }

  // ---------- step state ----------
  function updateSteps() {
    if (!current) return;
    const r = current.recipe, s = rs(r);
    let firstOpen = null;
    $$('.step').forEach(li => {
      const n = li.dataset.n, done = !!s.steps[n];
      li.classList.toggle('done', done);
      if (!done) { li.classList.remove('open'); if (!firstOpen) firstOpen = li; }
      $('.num', li).setAttribute('aria-pressed', done);
      $('.num', li).setAttribute('aria-label', `${done ? 'Mark step ' + n + ' not done' : 'Mark step ' + n + ' done'}`);
    });
    $$('.step').forEach(li => li.classList.toggle('current', li === firstOpen));
    const all = !firstOpen && totalSteps(r) > 0;
    const done = $('.alldone'); if (done) done.hidden = !all;
    const label = $('#method-n'); if (label) label.textContent = `${doneCount(r)}/${totalSteps(r)}`;
    return firstOpen;
  }

  function setTab(tab, fromRoute) {
    if (!current) return;
    const layout = $('.layout');
    const key = `tk:scroll:${current.recipe.id}:`;
    session.set(key + layout.dataset.tab, String(window.scrollY));
    layout.dataset.tab = tab; current.tab = tab;
    $$('.tab').forEach(b => { const on = b.dataset.tab === tab; b.setAttribute('aria-selected', on); b.tabIndex = on ? 0 : -1; });
    if (!fromRoute) history.replaceState(null, '', `#/r/${current.recipe.id}/${tab}`);
    const stored = session.get(key + tab);
    const headBottom = Math.max(0, $('.tabbar').offsetTop - 56);
    window.scrollTo(0, stored != null ? +stored : Math.min(window.scrollY, headBottom));
  }

  // ---------- routing ----------
  async function render() {
    const m = location.hash.match(/^#\/r\/([\w-]+)(?:\/(ingredients|method|notes))?/);
    const app = $('#app');
    if (current) session.set('tk:scroll:' + current.recipe.id + ':' + current.tab, String(window.scrollY));
    else session.set('tk:home', String(window.scrollY));
    const r = m && recipeById(m[1]);
    if (r) {
      const tab = m[2] || (doneCount(r) > 0 ? 'method' : 'ingredients');
      current = { recipe: r, tab };
      app.innerHTML = recipeView(r, tab);
      document.title = `${r.title} · Thanksgiving Kitchen`;
      const first = updateSteps();
      const stored = session.get(`tk:scroll:${r.id}:${tab}`);
      if (stored != null) window.scrollTo(0, +stored);
      else if (tab === 'method' && first && doneCount(r) > 0) first.scrollIntoView({ block: 'start' });
      else window.scrollTo(0, 0);
      setWake(prefs.wake);
    } else {
      current = null;
      app.innerHTML = homeView();
      document.title = 'Thanksgiving Kitchen';
      window.scrollTo(0, +(session.get('tk:home') || 0));
      setWake(false);
    }
    tick();
  }

  // ---------- events ----------
  document.addEventListener('click', e => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act, r = current && current.recipe;
    if (act === 'step') {
      e.stopPropagation();
      const s = rs(r), n = el.dataset.n;
      if (s.steps[n]) delete s.steps[n]; else s.steps[n] = 1;
      s.touched = Date.now(); saveState();
      const was = !!s.steps[n];
      const next = updateSteps();
      if (was && next) next.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    } else if (act === 'peek') {
      const li = el.closest('.step');
      if (li && li.classList.contains('done') && !e.target.closest('button')) li.classList.toggle('open');
    } else if (act === 'ing') {
      const s = rs(r), k = el.dataset.key;
      if (s.ing[k]) delete s.ing[k]; else s.ing[k] = 1;
      s.touched = Date.now(); saveState();
      el.setAttribute('aria-pressed', !!s.ing[k]);
    } else if (act === 'timer') {
      toggleTimer(el.dataset.key, el.dataset.label, +el.dataset.mins);
    } else if (act === 'cancel') {
      timers = timers.filter(t => t.key !== el.dataset.key); saveTimers(); tick();
    } else if (act === 'aside') {
      const box = el.closest('.step-body').querySelector('.aside');
      box.hidden = !box.hidden; el.setAttribute('aria-expanded', !box.hidden);
    } else if (act === 'tab') {
      setTab(el.dataset.tab);
    } else if (act === 'size') {
      prefs.size = (prefs.size + 1) % 3; savePrefs(); applyPrefs();
      el.setAttribute('aria-label', `Text size, currently ${['standard', 'large', 'extra large'][prefs.size]}. Tap to change.`);
      toast(['Standard text', 'Large text', 'Extra large text'][prefs.size]);
    } else if (act === 'theme') {
      prefs.theme = { auto: 'light', light: 'dark', dark: 'auto' }[prefs.theme]; savePrefs(); applyPrefs();
      toast({ auto: 'Theme follows your device', light: 'Light theme', dark: 'Dark theme' }[prefs.theme]);
    } else if (act === 'wake') {
      prefs.wake = !prefs.wake; savePrefs(); setWake(prefs.wake);
      el.setAttribute('aria-pressed', prefs.wake);
      toast(prefs.wake ? 'Screen will stay on while you cook' : 'Screen can sleep again');
    } else if (act === 'reset') {
      if (confirm('Clear all ticks for this recipe?')) {
        state.recipes[r.id] = { rev: r.revision, steps: {}, ing: {}, touched: 0 }; saveState();
        $$('.ing').forEach(b => b.setAttribute('aria-pressed', 'false')); updateSteps(); toast('Cleared');
      }
    }
  });

  document.addEventListener('keydown', e => {
    if (!e.target.matches || !e.target.matches('.tab') || !['ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    const tabs = $$('.tab').filter(t => t.offsetParent);
    const i = tabs.indexOf(e.target), next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    setTab(next.dataset.tab); next.focus();
  });
  window.addEventListener('hashchange', render);
  window.addEventListener('pagehide', () => { if (current) session.set('tk:scroll:' + current.recipe.id + ':' + current.tab, String(window.scrollY)); });

  // ---------- start ----------
  applyPrefs();
  fetch('recipes.json').then(r => r.json()).then(d => { DATA = d; render(); setInterval(tick, 1000); })
    .catch(() => { $('#app').innerHTML = '<p class="loading">Could not load the recipes. Check your connection and reload.</p>'; });
})();

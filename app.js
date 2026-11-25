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
  let onPlan = false;
  if (!state.plan) state.plan = { done: {}, moved: {} };

  const saveState = () => store.set('tk:state', state);
  const savePrefs = () => store.set('tk:prefs', prefs);
  const saveTimers = () => store.set('tk:timers', timers);

  const recipeById = id => DATA.recipes.find(r => r.id === id);
  const totalSteps = r => r.method.reduce((n, g) => n + g.steps.length, 0);
  function rs(r) {
    let s = state.recipes[r.id];
    if (!s || s.rev !== r.revision) {
      const stale = !!s;
      // When a recipe is revised, r.carry[<old revision>] says which old steps and ingredient rows are
      // still the same ones. Those ticks move across; anything that changed in substance is cleared.
      const map = stale && r.carry && r.carry[s.rev];
      let kept = 0, cleared = 0;
      if (map) {
        const next = { rev: r.revision, steps: {}, ing: {}, touched: s.touched || 0 };
        [['steps', 'steps'], ['ing', 'ing']].forEach(([from, to]) => {
          Object.keys(s[from] || {}).forEach(k => {
            const nk = map[from] && map[from][k];
            if (nk !== undefined && nk !== null) { next[to][nk] = s[from][k]; kept++; } else cleared++;
          });
        });
        s = state.recipes[r.id] = next;
      } else {
        s = state.recipes[r.id] = { rev: r.revision, steps: {}, ing: {}, touched: 0 };
      }
      if (stale) {
        // One notice for however many recipes were revised since the last visit.
        rs.notes = rs.notes || [];
        rs.notes.push({ title: r.title, map: !!map, kept, cleared });
        clearTimeout(rs.t);
        rs.t = setTimeout(() => {
          const n = rs.notes; rs.notes = [];
          const lost = n.filter(x => !x.map || x.cleared);
          toast(n.length === 1 && !lost.length ? `${n[0].title} was revised. All your ticks are kept.`
            : lost.length ? `${n.length} recipe${n.length > 1 ? 's' : ''} revised. Ticks kept except where a step or amount changed: ${lost.map(x => x.title).join(', ')}.`
            : `${n.length} recipes revised. All your ticks are kept.`);
        }, 400);
      }
      if (stale) saveState(); // write the migrated state now so the notice shows once
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
        ${DATA.plan && DATA.plan.tasks.length ? planCard() : ''}
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

  // ---------- game plan ----------
  // Tasks, times and windows come from operations/master-schedule.csv via the build script.
  const P = () => DATA.plan;
  const dayLabel = d => (P().days.find(x => x.date === d) || { label: d }).label;
  const todayISO = () => { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`; };
  function effDate(t) { const m = state.plan.moved[t.id]; return m && m.from === t.date ? m.to : t.date; }
  function nextDayFor(t) { const d = effDate(t); const nd = P().days.find(x => x.date > d && x.date <= t.we && x.move !== false); return nd ? nd.date : null; }
  function defaultDay() { const t = todayISO(), days = P().days.map(d => d.date); return days.includes(t) ? t : (days.find(d => d > t) || days[days.length - 1]); }
  const tasksOn = d => P().tasks.filter(t => effDate(t) === d);
  const ownerLabel = o => ({ 'Daniela + helper': 'With helper', helper: 'Helper', cleaners: 'Cleaners' }[o] || '');

  function planCard() {
    const d = defaultDay(), list = tasksOn(d), done = list.filter(t => state.plan.done[t.id]).length;
    const next = list.find(t => !state.plan.done[t.id]);
    return `<a class="plan-card" href="#/plan/${d}"><small>Game plan · ${esc(dayLabel(d))}${d === todayISO() ? ' (today)' : ''}</small>
      <strong>${done} of ${list.length} tasks done</strong>
      <span>${next ? `Next: ${next.start ? esc(next.start) + ' · ' : ''}${esc(next.title)}` : 'All done for this day'}</span></a>`;
  }

  function badge(t, d) {
    if (t.priority === 'C') return '<span class="badge opt">Optional</span>';
    if (t.we > d) return `<span class="badge flex">Can wait until ${esc(dayLabel(t.we))}</span>`;
    return '<span class="badge fixed">This day only</span>';
  }

  function planView(day) {
    const list = tasksOn(day), isToday = day === todayISO();
    const firstOpen = list.find(t => !state.plan.done[t.id]);
    const chips = P().days.map(d => {
      const l = tasksOn(d.date), n = l.filter(t => state.plan.done[t.id]).length;
      return `<a class="daychip" href="#/plan/${d.date}" ${d.date === day ? 'aria-current="page"' : ''}>${esc(d.label)}<small>${n}/${l.length}</small></a>`;
    }).join('');
    const items = list.map(t => {
      const done = !!state.plan.done[t.id], moved = effDate(t) !== t.date, nd = nextDayFor(t), who = ownerLabel(t.owner);
      const more = t.note || nd || moved;
      return `<li class="task pri-${t.priority}${done ? ' done' : ''}${isToday && t === firstOpen ? ' next' : ''}">
        <button class="tick" data-act="ptask" data-id="${t.id}" aria-pressed="${done}" aria-label="${done ? 'Mark not done' : 'Mark done'}: ${esc(t.title)}"><span class="box">${ICON.check}</span></button>
        <div class="task-body">
          <div class="task-time">${moved ? 'Fit in when you can' : (t.start ? esc(t.start) : 'Any time')}${t.mins ? ' · ' + fmtMins(t.mins) : ''}</div>
          <h3 class="task-title">${esc(t.title)}</h3>
          <div class="task-meta">${badge(t, effDate(t))}${who ? `<span class="badge who">${who}</span>` : ''}${moved ? `<span class="badge moved">Moved from ${esc(dayLabel(t.date))}</span>` : ''}${t.recipe ? `<a class="recipe-link" href="#/r/${t.recipe}/method">Recipe ›</a>` : ''}</div>
          ${more ? `<details class="task-more"><summary>Details</summary>${t.note ? `<p>${md(t.note)}</p>` : ''}<div class="task-actions">${nd ? `<button class="pill" data-act="pmove" data-id="${t.id}" data-to="${nd}">Move to ${esc(dayLabel(nd))}</button>` : ''}${moved ? `<button class="pill ghost" data-act="punmove" data-id="${t.id}">Move back to ${esc(dayLabel(t.date))}</button>` : ''}</div></details>` : ''}
        </div></li>`;
    }).join('');
    return `<header class="bar"><div class="bar-inner"><a class="back" href="#/" aria-label="Back to all recipes">${ICON.back}<span>Recipes</span></a><div class="bar-title"></div>${tools(true)}</div></header>
      <main class="wrap plan">
        <div class="home-head"><h1>Game plan</h1><p>A proposed plan: times are allowances, not promises. When things change, copy your status and send it to Claude to re-plan.</p></div>
        <nav class="days" aria-label="Days">${chips}</nav>
        <h2 class="sec">${esc(dayLabel(day))}${isToday ? ' · today' : ''}</h2>
        ${list.length ? `<ol class="tasks">${items}</ol>` : '<p class="small-note">Nothing planned for this day.</p>'}
        <div class="plan-foot"><button class="btn" data-act="pcopy">Copy my status for Claude</button>
          <textarea id="status-text" class="status-text" readonly hidden aria-label="Your plan status"></textarea>
          <p class="small-note">Ticks and moves are saved on this device. A task can only move inside its window; anything else needs a re-plan.</p></div>
      </main>`;
  }

  function statusText() {
    const t0 = todayISO();
    const stamp = new Date().toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    const done = P().tasks.filter(t => state.plan.done[t.id]);
    const open = P().tasks.filter(t => !state.plan.done[t.id] && effDate(t) <= t0);
    const moved = P().tasks.filter(t => effDate(t) !== t.date);
    const lines = [`Thanksgiving plan status, ${stamp}`, '', `Done (${done.length}):`, ...done.map(t => `- ${t.id} ${t.title}`),
      '', `Not done yet, due today or earlier (${open.length}):`, ...open.map(t => `- ${t.id} ${t.title} (planned ${dayLabel(effDate(t))}${t.start ? ' ' + t.start : ''}; window until ${dayLabel(t.we)})`)];
    if (moved.length) lines.push('', 'Moved:', ...moved.map(t => `- ${t.id} ${t.title}: ${dayLabel(t.date)} → ${dayLabel(effDate(t))}`));
    return lines.join('\n');
  }

  function showDayChip() {
    const chip = $('.daychip[aria-current="page"]'), row = $('.days');
    if (chip && row) row.scrollLeft = chip.offsetLeft - row.offsetLeft - (row.clientWidth - chip.offsetWidth) / 2;
  }

  function rerenderPlan() {
    const y = window.scrollY, openIds = $$('details.task-more[open]').map(d => d.closest('.task').querySelector('[data-id]').dataset.id);
    const x = $('.days') ? $('.days').scrollLeft : 0;
    $('#app').innerHTML = planView(onPlan);
    if ($('.days')) $('.days').scrollLeft = x;
    openIds.forEach(id => { const b = $(`.tick[data-id="${id}"]`); if (b) { const det = b.closest('.task').querySelector('details'); if (det) det.open = true; } });
    window.scrollTo(0, y);
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
    else if (!onPlan) session.set('tk:home', String(window.scrollY));
    const pm = location.hash.match(/^#\/plan(?:\/(\d{4}-\d{2}-\d{2}))?/);
    const r = m && recipeById(m[1]);
    if (pm && DATA.plan) {
      current = null;
      onPlan = pm[1] && P().days.some(d => d.date === pm[1]) ? pm[1] : defaultDay();
      app.innerHTML = planView(onPlan);
      document.title = 'Game plan · Thanksgiving Kitchen';
      window.scrollTo(0, 0);
      showDayChip();
      setWake(prefs.wake);
      tick();
      return;
    }
    onPlan = false;
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
    } else if (act === 'ptask') {
      const id = el.dataset.id;
      if (state.plan.done[id]) delete state.plan.done[id]; else state.plan.done[id] = Date.now();
      saveState(); rerenderPlan();
    } else if (act === 'pmove' || act === 'punmove') {
      // Same-day follow-on tasks (those depending on this one) move with it when their window allows.
      const t = P().tasks.find(x => x.id === el.dataset.id), from = effDate(t), to = el.dataset.to;
      const group = [t], seen = new Set([t.id]);
      for (let i = 0; i < group.length; i++) {
        P().tasks.forEach(x => {
          if (!seen.has(x.id) && x.deps.includes(group[i].id) && effDate(x) === from && (act === 'punmove' || x.we >= to)) { seen.add(x.id); group.push(x); }
        });
      }
      group.forEach(x => { if (act === 'pmove') state.plan.moved[x.id] = { from: x.date, to }; else delete state.plan.moved[x.id]; });
      saveState(); rerenderPlan();
      const n = group.length > 1 ? `${group.length} tasks` : 'Task';
      toast(act === 'pmove' ? `${n} moved to ${dayLabel(to)}` : `${n} back on ${dayLabel(t.date)}`);
    } else if (act === 'pcopy') {
      const txt = statusText(), box = $('#status-text');
      box.value = txt; box.hidden = false;
      const fallback = () => { box.focus(); box.select(); toast('Select the text below and copy it'); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(() => toast('Status copied. Paste it into your chat with Claude.'), fallback);
      else fallback();
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

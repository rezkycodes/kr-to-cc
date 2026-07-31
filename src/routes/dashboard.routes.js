/**
 * Dashboard Routes
 *
 * The main menu / landing page for the proxy web UI. Links to every screen and
 * shows live connection + server status. Mounted at / (and /dashboard).
 *
 * Also serves embeddable viewer pages used inside dashboard cards:
 *   GET /ui/models        -> pretty-printed /v1/models JSON (iframe)
 *   GET /ui/models-check  -> auto model checker with green/red status (iframe)
 */

import express from 'express';
import { renderPage, THEME_CSS, ICONS } from '../ui/theme.js';

const router = express.Router();

const HEAD_CSS = /* html */ `<style>
  .mc-head { display:flex; flex-direction:column; gap:14px; cursor:pointer; }
  .menu-card.exp { display:block; }
  .frame-wrap { display:none; margin-top:16px; padding-top:16px; border-top:1px solid var(--border); }
  .menu-card.open .frame-wrap { display:block; }
  .ui-frame { width:100%; height:360px; border:1px solid var(--border); border-radius:9px; background:var(--bg); }
  .chev { transition: transform .16s ease; display:inline-flex; }
  .menu-card.open .chev { transform: rotate(180deg); }
</style>`;

const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="6 9 12 15 18 9"/></svg>';

function dashboardBody() {
    const linkCards = [
        {
            href: '/oauth/kiro', icon: ICONS.key, title: 'Sign in to Kiro',
            desc: 'Login with Google/GitHub, auto-import a token from Kiro IDE or CLI, or paste a refresh token. Stays signed in via auto-refresh.',
            cta: 'Open sign-in'
        },
        {
            href: '/config/claude', icon: ICONS.sliders, title: 'Configure Claude Code',
            desc: 'Point Claude Code at this proxy by writing ~/.claude/settings.json — pick your model mapping and apply in one click.',
            cta: 'Open config'
        }
    ].map(m => `
      <a class="menu-card" href="${m.href}">
        <span class="ic">${m.icon}</span>
        <h3>${m.title}</h3>
        <p>${m.desc}</p>
        <span class="go">${m.cta} ${ICONS.arrow}</span>
      </a>`).join('');

    const expCard = (id, src, icon, title, desc, cta) => `
      <div class="menu-card exp" id="${id}">
        <div class="mc-head" onclick="toggleFrame('${id}')">
          <span class="ic">${icon}</span>
          <h3>${title}</h3>
          <p>${desc}</p>
          <span class="go">${cta} ${CHEV}</span>
        </div>
        <div class="frame-wrap"><iframe class="ui-frame" data-src="${src}" title="${title}"></iframe></div>
      </div>`;

    return `
  <div class="page-head">
    <h1>Dashboard</h1>
    <p>Your local gateway to Claude models via Kiro. Sign in, wire up Claude Code, and check model availability — all from here.</p>
  </div>

  <div class="card" style="margin-bottom:24px; display:flex; flex-wrap:wrap; gap:14px; align-items:center;">
    <span class="badge" id="authBadge"><span class="dot"></span> checking sign-in…</span>
    <span class="badge" id="healthBadge"><span class="dot"></span> checking server…</span>
  </div>

  <div class="grid cols-2">
    ${linkCards}
  </div>

  <div class="section">
    <h2>Models</h2>
    <div class="stack">
      ${expCard('modelsCard', '/ui/models', ICONS.cube, 'Available models', 'Browse the full model catalog (16 models incl. Opus 5/4.8, Sonnet 5, and open-weight) as pretty JSON.', 'View JSON')}
      ${expCard('checkCard', '/ui/models-check', ICONS.pulse, 'Check active models', 'Probe models on demand — check one at a time or all at once. Nothing runs until you click, so you only spend quota when you want to.', 'Open checker')}
    </div>
  </div>

  <div class="section">
    <h2>Quick start</h2>
    <div class="card">
      <ol style="margin:0; padding-left:20px; color:var(--muted); line-height:1.9; font-size:14px;">
        <li><a href="/oauth/kiro" style="color:var(--fg); text-decoration:underline;">Sign in to Kiro</a> (or auto-import your existing Kiro IDE / CLI token).</li>
        <li><a href="/config/claude" style="color:var(--fg); text-decoration:underline;">Configure Claude Code</a> and click Apply.</li>
        <li>Restart Claude Code, then run <code style="color:var(--fg);">claude</code>.</li>
      </ol>
    </div>
  </div>`;
}

const SCRIPT = `
  const $ = (id) => document.getElementById(id);
  function setBadge(el, on, text) {
    el.className = 'badge' + (on ? ' on' : '');
    el.innerHTML = '<span class="dot"></span> ' + text;
  }
  async function refresh() {
    try {
      const r = await fetch('/oauth/kiro/status'); const d = await r.json();
      setBadge($('authBadge'), d.authenticated, d.authenticated ? 'Signed in' : 'Not signed in');
    } catch { setBadge($('authBadge'), false, 'Sign-in unknown'); }
    try {
      const r = await fetch('/health'); const d = await r.json();
      const ok = d.status === 'ok';
      setBadge($('healthBadge'), ok, ok ? 'Server healthy' : 'Server: ' + (d.status || 'error'));
    } catch { setBadge($('healthBadge'), false, 'Server unreachable'); }
  }
  function toggleFrame(id) {
    const card = document.getElementById(id);
    const frame = card.querySelector('iframe');
    const open = card.classList.toggle('open');
    if (open && !frame.src) frame.src = frame.dataset.src;
  }
  refresh();
`;

function handler(req, res) {
    res.type('html').send(renderPage({
        title: 'Kiro to Claude — Dashboard',
        active: 'dashboard',
        body: dashboardBody(),
        script: SCRIPT,
        head: HEAD_CSS
    }));
}

router.get('/', handler);
router.get('/dashboard', handler);

// ---------------------------------------------------------------------------
// Embeddable viewer pages (rendered inside dashboard iframes)
// ---------------------------------------------------------------------------

/** Minimal HTML shell for iframe content (no header/nav). */
function bare(title, body, script) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<style>${THEME_CSS}
  body { padding: 14px; background: var(--bg); }
  body::before { display: none; }
  pre { border: none; background: transparent; padding: 0; font-size: 12.5px; line-height: 1.55; }
  .jk { color: #ffffff; font-weight: 600; }
  .js { color: #b8b8b8; }
  .jn { color: #ededed; }
  .jb { color: #ffffff; font-weight: 600; }
  .row2 { display: flex; align-items: center; gap: 12px; padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .row2:last-child { border-bottom: none; }
  .row2 .mid { font-family: var(--mono); color: var(--fg); flex: 1; word-break: break-all; }
  .row2 .st { display: inline-flex; align-items: center; gap: 8px; }
  .row2 .meta { color: var(--muted-2); font-size: 11px; font-family: var(--mono); }
  .spin { width: 14px; height: 14px; border: 2px solid var(--border-strong); border-top-color: var(--fg); border-radius: 50%; animation: sp .7s linear infinite; }
  @keyframes sp { to { transform: rotate(360deg); } }
  .summary { font-size: 12px; color: var(--muted); }
  .bar { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; flex-wrap: wrap; }
  .btn { font: inherit; font-size: 13px; font-weight: 500; color: var(--bg); background: var(--fg); border: 1px solid var(--fg); border-radius: 6px; padding: 7px 12px; cursor: pointer; display: inline-flex; align-items: center; gap: 7px; box-shadow: 0 1px 2px 0 rgba(0,0,0,.3); transition: opacity .15s ease; }
  .btn:hover { opacity: .9; }
  .btn:disabled { opacity: .5; cursor: default; }
  .row2 .st { min-width: 62px; justify-content: flex-end; }
  .row2 .idle { color: var(--muted-2); }
  .recheck { font: inherit; color: var(--muted); background: transparent; border: 1px solid var(--border-strong); border-radius: 6px; padding: 4px 7px; cursor: pointer; display: inline-flex; align-items: center; transition: color .14s ease, border-color .14s ease; }
  .recheck:hover { color: var(--fg); border-color: var(--fg); }
  .recheck:disabled { opacity: .4; cursor: default; }
  .recheck:focus-visible, .btn:focus-visible { outline: 2px solid var(--fg); outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
</style>
</head>
<body>
${body}
<script>${script}</script>
</body>
</html>`;
}

/** GET /ui/models — pretty JSON viewer for /v1/models */
router.get('/ui/models', (req, res) => {
    const body = '<div id="out"><span class="summary">Loading models…</span></div>';
    const script = `
      function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
      function hl(json){
        return esc(json).replace(/("(\\\\u[a-zA-Z0-9]{4}|\\\\[^u]|[^\\\\"])*"(\\s*:)?|\\b(true|false|null)\\b|-?\\d+(?:\\.\\d*)?(?:[eE][+\\-]?\\d+)?)/g, function(m){
          let cls='jn';
          if(/^"/.test(m)) cls = /:$/.test(m) ? 'jk' : 'js';
          else if(/true|false|null/.test(m)) cls='jb';
          return '<span class="'+cls+'">'+m+'</span>';
        });
      }
      fetch('/v1/models').then(r=>r.json()).then(d=>{
        document.getElementById('out').innerHTML = '<pre>'+hl(JSON.stringify(d,null,2))+'</pre>';
      }).catch(e=>{ document.getElementById('out').innerHTML = '<span class="summary">Failed: '+e.message+'</span>'; });
    `;
    res.type('html').send(bare('Available models', body, script));
});

/** GET /ui/models-check — model availability checker (manual, per-model or all) */
router.get('/ui/models-check', (req, res) => {
    const check = '<svg viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="20 6 9 17 4 12"/></svg>';
    const cross = '<svg viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
    const redo = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>';
    const body = [
        '<div class="bar">',
        '  <button id="checkAll" class="btn">' + redo + ' Check all</button>',
        '  <span class="summary" id="sum">Nothing checked yet — run one model or check all.</span>',
        '</div>',
        '<div id="list"><span class="summary">Loading models…</span></div>'
    ].join('');
    const script = `
      const CHECK = ${JSON.stringify(check)};
      const CROSS = ${JSON.stringify(cross)};
      const REDO  = ${JSON.stringify(redo)};
      const list = document.getElementById('list');
      const sum = document.getElementById('sum');
      const checkAllBtn = document.getElementById('checkAll');
      const rows = {};
      let ids = [];

      function updateSummary(){
        let ok = 0, ko = 0;
        ids.forEach(id => { const s = rows[id].state; if (s === 'ok') ok++; else if (s === 'ko') ko++; });
        const checked = ok + ko;
        sum.textContent = checked ? ('Active ' + ok + '/' + checked + ' checked' + (ko ? ' (' + ko + ' inactive)' : '')) : 'Nothing checked yet — run one model or check all.';
      }
      function setPending(id){
        const row = rows[id]; if(!row) return;
        row.state = 'pending';
        row.el.querySelector('.st').innerHTML = '<span class="spin"></span>';
        row.el.querySelector('.recheck').disabled = true;
      }
      function setResult(id, ok, status, ms){
        const row = rows[id]; if(!row) return;
        row.state = ok ? 'ok' : 'ko';
        row.el.querySelector('.st').innerHTML = (ok ? CHECK : CROSS) + '<span class="meta">' + (ms != null ? ms + 'ms' : (status || '')) + '</span>';
        row.el.querySelector('.recheck').disabled = false;
        updateSummary();
      }
      async function checkOne(id){
        setPending(id);
        try {
          const r = await fetch('/v1/models/check?models=' + encodeURIComponent(id));
          const d = await r.json();
          const res = (d.results || [])[0] || {};
          setResult(id, !!res.active, res.status, res.latency_ms);
        } catch(e){ setResult(id, false, 'error'); }
      }
      async function checkAll(){
        checkAllBtn.disabled = true;
        sum.textContent = 'Checking ' + ids.length + ' models…';
        const queue = [...ids]; let active = 0;
        await new Promise(resolve => {
          function next(){
            if(!queue.length && active === 0){ resolve(); return; }
            while(active < 3 && queue.length){
              const id = queue.shift(); active++;
              checkOne(id).finally(() => { active--; next(); });
            }
          }
          next();
        });
        checkAllBtn.disabled = false;
      }
      async function load(){
        let d;
        try { d = await (await fetch('/v1/models')).json(); }
        catch(e){ list.innerHTML = '<span class="summary">Failed to load models: ' + e.message + '</span>'; return; }
        ids = (d.data || []).filter(m => !String(m.id).endsWith('-thinking')).map(m => m.id);
        list.innerHTML = '';
        ids.forEach(id => {
          const el = document.createElement('div'); el.className = 'row2';
          el.innerHTML = '<span class="mid">' + id + '</span>'
            + '<span class="st"><span class="idle">—</span></span>'
            + '<button class="recheck" title="Check this model" aria-label="Check ' + id + '">' + REDO + '</button>';
          el.querySelector('.recheck').addEventListener('click', () => checkOne(id));
          list.appendChild(el); rows[id] = { el: el, state: 'idle' };
        });
        updateSummary();
      }
      checkAllBtn.addEventListener('click', checkAll);
      load();
    `;
    res.type('html').send(bare('Check active models', body, script));
});

export default router;

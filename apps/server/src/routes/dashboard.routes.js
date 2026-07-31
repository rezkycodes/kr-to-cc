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
  main, .hdr-in { max-width:1280px; }
  main { padding:32px 24px 80px; }
  .dashboard-shell { min-width:0; }
  .dashboard-intro {
    display:grid; grid-template-columns:minmax(0,1.45fr) minmax(280px,.55fr); gap:48px; align-items:end;
    padding:20px 0 36px; border-bottom:1px solid var(--border);
  }
  .intro-copy { min-width:0; }
  .intro-copy h1 {
    max-width:14ch; margin:0; font-size:48px; font-weight:650; line-height:1.02;
    letter-spacing:-.035em; text-wrap:balance;
  }
  .intro-copy p { max-width:64ch; margin:16px 0 0; color:var(--muted); font-size:15px; line-height:1.65; text-wrap:pretty; }
  .intro-actions { display:flex; flex-wrap:wrap; align-items:center; gap:10px 18px; margin-top:24px; }
  .intro-actions .btn { min-height:44px; }
  .text-action {
    display:inline-flex; align-items:center; gap:7px; min-height:44px; color:var(--muted);
    font-size:13px; font-weight:500; transition:color .18s ease;
  }
  .text-action:hover { color:var(--fg); }
  .text-action:active, .intro-actions .btn:active { transform:translateY(1px); }
  .system-panel { border:1px solid var(--border); border-radius:12px; background:var(--surface); overflow:hidden; }
  .system-panel-head {
    display:flex; align-items:center; justify-content:space-between; gap:16px;
    min-height:48px; padding:11px 14px; border-bottom:1px solid var(--border);
  }
  .system-panel h2 { margin:0; font-size:13px; font-weight:600; letter-spacing:-.01em; }
  .system-panel-head code { color:var(--muted-2); font:500 10px/1 var(--mono); }
  .status-list { padding:3px 14px; }
  .status-row { display:flex; align-items:center; justify-content:space-between; gap:14px; min-height:45px; border-bottom:1px solid var(--border); }
  .status-row:last-child { border-bottom:0; }
  .status-name { color:var(--muted); font-size:12px; }
  .status-value { color:var(--fg); font:500 11px/1 var(--mono); }
  .system-note { margin:0; padding:11px 14px; color:var(--muted-2); background:var(--surface-2); font-size:10px; line-height:1.45; }
  .workspace-grid { display:grid; grid-template-columns:minmax(0,2.15fr) minmax(280px,.85fr); gap:22px; align-items:start; margin-top:28px; }
  .monitor-workspace { min-width:0; }
  .section-heading { display:flex; align-items:flex-end; justify-content:space-between; gap:16px; margin-bottom:13px; }
  .section-heading h2 { margin:0; font-size:18px; font-weight:600; letter-spacing:-.025em; }
  .section-heading p { max-width:64ch; margin:4px 0 0; color:var(--muted-2); font-size:12px; line-height:1.5; }
  .telemetry-shell { overflow:hidden; border:1px solid var(--border); border-radius:12px; background:#0b0b0c; }
  .ui-frame { display:block; width:100%; height:360px; border:1px solid var(--border); border-radius:9px; background:var(--bg); }
  .telemetry-frame { height:900px; min-height:720px; border:0; border-radius:0; }
  .setup-rail { display:grid; gap:24px; position:sticky; top:84px; }
  .rail-block { padding-top:15px; border-top:1px solid var(--border); }
  .rail-head { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:8px; }
  .rail-head h2 { margin:0; font-size:14px; font-weight:600; letter-spacing:-.015em; }
  .rail-meta { color:var(--muted-2); font:500 10px/1 var(--mono); }
  .setup-list, .quick-list { margin:0; padding:0; list-style:none; }
  .setup-action {
    display:grid; grid-template-columns:30px minmax(0,1fr) 18px; gap:11px; align-items:start;
    padding:15px 2px; border-bottom:1px solid var(--border); transition:background .18s ease, color .18s ease;
  }
  .setup-action:last-child { border-bottom:0; }
  .setup-action:hover .setup-title { color:var(--fg); }
  .setup-action:active { transform:translateY(1px); }
  .step-index { color:var(--muted-2); font:600 10px/1.4 var(--mono); letter-spacing:.04em; }
  .setup-title { display:block; color:var(--muted); font-size:13px; font-weight:600; line-height:1.35; transition:color .18s ease; }
  .setup-desc { display:block; margin-top:4px; color:var(--muted-2); font-size:11px; line-height:1.5; text-wrap:pretty; }
  .setup-action > svg { margin-top:1px; color:var(--muted-2); }
  .quick-list { counter-reset:quick; }
  .quick-list li {
    counter-increment:quick; display:grid; grid-template-columns:22px minmax(0,1fr); gap:8px;
    padding:8px 0; color:var(--muted); font-size:12px; line-height:1.5;
  }
  .quick-list li::before { content:counter(quick); color:var(--muted-2); font:600 10px/1.8 var(--mono); }
  .quick-list a { color:var(--fg); text-decoration:underline; text-underline-offset:3px; }
  .quick-command {
    display:flex; align-items:center; justify-content:space-between; gap:12px;
    margin-top:10px; padding:11px 12px; border:1px solid var(--border); border-radius:8px; background:var(--surface);
  }
  .quick-command span { color:var(--muted-2); font-size:10px; }
  .quick-command code { color:var(--fg); font:550 12px/1 var(--mono); }
  .operations { margin-top:38px; padding-top:25px; border-top:1px solid var(--border); }
  .operations-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }
  .operation-panel { min-width:0; border:1px solid var(--border); border-radius:12px; background:var(--surface); overflow:hidden; }
  .operation-summary { display:grid; grid-template-columns:40px minmax(0,1fr); gap:13px; padding:17px; }
  .operation-icon {
    display:grid; place-items:center; width:40px; height:40px; border:1px solid var(--border);
    border-radius:9px; background:var(--surface-2); color:var(--fg);
  }
  .operation-summary h3 { margin:1px 0 0; font-size:14px; font-weight:600; letter-spacing:-.015em; }
  .operation-summary p { margin:5px 0 0; color:var(--muted-2); font-size:11px; line-height:1.55; text-wrap:pretty; }
  .operation-toggle {
    display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; min-height:45px;
    padding:0 17px; border:0; border-top:1px solid var(--border); color:var(--muted);
    background:transparent; font:500 12px/1 var(--sans); cursor:pointer; text-align:left;
    transition:background .18s ease, color .18s ease;
  }
  .operation-toggle:hover { color:var(--fg); background:var(--surface-2); }
  .operation-toggle:active { background:var(--surface-3); }
  .operation-toggle:focus-visible { outline:2px solid var(--ring); outline-offset:-3px; }
  .chev { display:inline-flex; transition:transform .18s ease; }
  .operation-panel.open .chev { transform:rotate(180deg); }
  .frame-wrap { padding:14px; border-top:1px solid var(--border); }
  .frame-wrap[hidden] { display:none; }
  .operations-note { color:var(--muted-2); font:500 10px/1 var(--mono); }
  @media (max-width:1020px) {
    main { padding-top:24px; }
    .dashboard-intro { grid-template-columns:1fr; gap:28px; align-items:start; }
    .intro-copy h1 { font-size:40px; }
    .system-panel { max-width:620px; }
    .workspace-grid { grid-template-columns:1fr; gap:30px; }
    .setup-rail { grid-template-columns:repeat(2,minmax(0,1fr)); position:static; }
    .telemetry-frame { height:1040px; }
  }
  @media (max-width:700px) {
    main { padding:22px 16px 56px; }
    .dashboard-intro { padding:10px 0 28px; }
    .intro-copy h1 { max-width:13ch; font-size:32px; letter-spacing:-.03em; }
    .intro-copy p { font-size:14px; }
    .intro-actions { align-items:stretch; flex-direction:column; margin-top:20px; }
    .intro-actions .btn, .text-action { justify-content:center; width:100%; }
    .system-panel-head { align-items:flex-start; flex-direction:column; gap:5px; }
    .status-row { min-height:48px; }
    .section-heading { align-items:flex-start; flex-direction:column; }
    .telemetry-frame { height:1320px; min-height:800px; }
    .setup-rail, .operations-grid { grid-template-columns:1fr; }
    .operations { margin-top:30px; }
  }
  @media (prefers-reduced-motion:reduce) {
    .text-action:active, .intro-actions .btn:active, .setup-action:active { transform:none; }
  }
</style>`;

const CHEV = '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="6 9 12 15 18 9"/></svg>';

function dashboardBody() {
    const operationPanel = (id, src, icon, title, desc, cta) => `
      <article class="operation-panel" id="${id}">
        <div class="operation-summary">
          <span class="operation-icon">${icon}</span>
          <div>
            <h3>${title}</h3>
            <p>${desc}</p>
          </div>
        </div>
        <button class="operation-toggle" type="button" data-frame-toggle="${id}" aria-expanded="false" aria-controls="${id}Frame">
          <span>${cta}</span>${CHEV}
        </button>
        <div class="frame-wrap" id="${id}Frame" hidden>
          <iframe class="ui-frame" data-src="${src}" title="${title}" loading="lazy"></iframe>
        </div>
      </article>`;

    return `
  <div class="dashboard-shell">
    <section class="dashboard-intro" aria-labelledby="dashboardTitle">
      <div class="intro-copy">
        <h1 id="dashboardTitle">Claude through Kiro, fully visible.</h1>
        <p>Run Anthropic-compatible clients against your local gateway, then inspect request health, latency, model behavior, and failures without sending telemetry anywhere else.</p>
        <div class="intro-actions">
          <a class="btn primary" href="/oauth/kiro">Sign in to Kiro ${ICONS.arrow}</a>
          <a class="text-action" href="/config/claude">Configure Claude Code ${ICONS.arrow}</a>
        </div>
      </div>

      <section class="system-panel" aria-labelledby="gatewayStatusTitle">
        <div class="system-panel-head">
          <h2 id="gatewayStatusTitle">Gateway status</h2>
          <code>/v1/messages</code>
        </div>
        <div class="status-list" aria-live="polite">
          <div class="status-row">
            <span class="status-name">Authentication</span>
            <span class="badge" id="authBadge"><span class="dot"></span> Checking</span>
          </div>
          <div class="status-row">
            <span class="status-name">Local server</span>
            <span class="badge" id="healthBadge"><span class="dot"></span> Checking</span>
          </div>
          <div class="status-row">
            <span class="status-name">Telemetry storage</span>
            <span class="status-value">Memory only</span>
          </div>
        </div>
        <p class="system-note">Request metrics stay in this process and expire automatically after six hours.</p>
      </section>
    </section>

    <div class="workspace-grid">
      <section class="monitor-workspace" aria-labelledby="telemetryTitle">
        <div class="section-heading">
          <div>
            <h2 id="telemetryTitle">Live request telemetry</h2>
            <p>Outcomes, latency percentiles, model health, error categories, and recent failures.</p>
          </div>
          <span class="badge on"><span class="dot"></span> Refreshing every 3s</span>
        </div>
        <div class="telemetry-shell">
          <iframe id="telemetryFrame" class="ui-frame telemetry-frame" src="/ui/telemetry" title="Request telemetry" loading="eager" scrolling="no"></iframe>
        </div>
      </section>

      <aside class="setup-rail" aria-label="Setup and quick start">
        <section class="rail-block" aria-labelledby="setupTitle">
          <div class="rail-head">
            <h2 id="setupTitle">Get connected</h2>
            <span class="rail-meta">2 required steps</span>
          </div>
          <ol class="setup-list">
            <li>
              <a class="setup-action" href="/oauth/kiro">
                <span class="step-index">01</span>
                <span><span class="setup-title">Connect your Kiro account</span><span class="setup-desc">Use browser sign-in, auto-import from Kiro IDE or CLI, or add a refresh token.</span></span>
                ${ICONS.arrow}
              </a>
            </li>
            <li>
              <a class="setup-action" href="/config/claude">
                <span class="step-index">02</span>
                <span><span class="setup-title">Write Claude Code config</span><span class="setup-desc">Choose model mappings and safely update your local Claude settings.</span></span>
                ${ICONS.arrow}
              </a>
            </li>
          </ol>
        </section>

        <section class="rail-block" aria-labelledby="quickTitle">
          <div class="rail-head">
            <h2 id="quickTitle">Run Claude Code</h2>
            <span class="rail-meta">local workflow</span>
          </div>
          <ol class="quick-list">
            <li><span>Complete sign-in and apply the Claude config.</span></li>
            <li><span>Restart any open Claude Code session.</span></li>
            <li><span>Launch Claude Code from your project directory.</span></li>
          </ol>
          <div class="quick-command"><span>Terminal</span><code>claude</code></div>
        </section>
      </aside>
    </div>

    <section class="operations" aria-labelledby="modelsTitle">
      <div class="section-heading">
        <div>
          <h2 id="modelsTitle">Model operations</h2>
          <p>Inspect the published catalog or probe real availability only when you choose.</p>
        </div>
        <span class="operations-note">No automatic quota spend</span>
      </div>
      <div class="operations-grid">
        ${operationPanel('modelsCard', '/ui/models', ICONS.cube, 'Available models', 'Browse the complete model catalog and API identifiers as formatted JSON.', 'View catalog JSON')}
        ${operationPanel('checkCard', '/ui/models-check', ICONS.pulse, 'Check active models', 'Probe one model or run a bounded availability check across the catalog.', 'Open model checker')}
      </div>
    </section>
  </div>`;
}

const SCRIPT = `
  const $ = (id) => document.getElementById(id);
  let statusTimer;
  let telemetryObserver;

  function setBadge(el, on, text) {
    el.className = 'badge' + (on ? ' on' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    el.replaceChildren(dot, document.createTextNode(text));
  }

  async function refreshStatus() {
    try {
      const response = await fetch('/oauth/kiro/status', { cache: 'no-store' });
      const data = await response.json();
      setBadge($('authBadge'), data.authenticated, data.authenticated ? 'Signed in' : 'Not signed in');
    } catch {
      setBadge($('authBadge'), false, 'Status unknown');
    }
    try {
      const response = await fetch('/health', { cache: 'no-store' });
      const data = await response.json();
      const healthy = data.status === 'ok';
      setBadge($('healthBadge'), healthy, healthy ? 'Healthy' : 'Unavailable');
    } catch {
      setBadge($('healthBadge'), false, 'Unreachable');
    }
  }

  function toggleFrame(trigger) {
    const card = $(trigger.dataset.frameToggle);
    const frameWrap = $(trigger.getAttribute('aria-controls'));
    const frame = frameWrap.querySelector('iframe');
    const open = trigger.getAttribute('aria-expanded') !== 'true';
    trigger.setAttribute('aria-expanded', String(open));
    card.classList.toggle('open', open);
    frameWrap.hidden = !open;
    if (open && !frame.getAttribute('src')) frame.setAttribute('src', frame.dataset.src);
  }

  function fitTelemetryFrame() {
    const frame = $('telemetryFrame');
    try {
      const doc = frame.contentDocument;
      if (!doc) return;
      doc.body.style.overflow = 'hidden';
      const content = doc.querySelector('.telemetry');
      const height = Math.max(
        doc.body.scrollHeight,
        content ? content.getBoundingClientRect().height + 36 : 0,
        720
      );
      frame.style.height = Math.ceil(height) + 'px';
    } catch {
      // Same-origin iframe sizing is an enhancement; CSS fallback remains usable.
    }
  }

  function connectTelemetrySizer() {
    fitTelemetryFrame();
    const frame = $('telemetryFrame');
    if (!window.ResizeObserver || !frame.contentDocument) return;
    telemetryObserver = new ResizeObserver(fitTelemetryFrame);
    telemetryObserver.observe(frame.contentDocument.documentElement);
  }

  document.querySelectorAll('[data-frame-toggle]').forEach((trigger) => {
    trigger.addEventListener('click', () => toggleFrame(trigger));
  });
  $('telemetryFrame').addEventListener('load', connectTelemetrySizer);
  window.addEventListener('resize', fitTelemetryFrame);
  window.addEventListener('pagehide', () => {
    clearInterval(statusTimer);
    if (telemetryObserver) telemetryObserver.disconnect();
  }, { once: true });

  refreshStatus();
  statusTimer = setInterval(refreshStatus, 15000);
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
    const check = '<svg viewBox="0 0 24 24" fill="none" stroke="#f5f5f3" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="20 6 9 17 4 12"/></svg>';
    const cross = '<svg viewBox="0 0 24 24" fill="none" stroke="#8c8c90" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
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

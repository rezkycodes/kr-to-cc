/**
 * Claude Code Config Routes
 *
 * Browser UI + API to configure ~/.claude/settings.json so Claude Code points
 * at this proxy. Mounted at /config/claude.
 *
 *   GET  /config/claude          -> config UI
 *   GET  /config/claude/state    -> current settings + available models
 *   POST /config/claude/apply    -> merge config into settings.json
 *   POST /config/claude/manual   -> return the manual JSON snippet
 */

import express from 'express';
import {
    CLAUDE_SETTINGS_PATH,
    readClaudeSettings,
    extractConfig,
    buildManualSnippet,
    applyClaudeSettings
} from '../config/claude-config.js';
import { listKiroModels } from '../kiro/index.js';
import { gatewayOrigin } from '../utils/gateway-address.js';
import { renderPage, ICONS } from '../ui/theme.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

/** Sensible default model mapping for Claude Code. */
function defaultConfig(baseUrl) {
    return {
        baseUrl,
        authToken: 'dummy',
        opusModel: 'claude-opus-4-8',
        sonnetModel: 'claude-sonnet-4-5',
        haikuModel: 'claude-haiku-4-5',
        subagentModel: 'claude-sonnet-4-5'
    };
}

/**
 * Base URL Claude Code should use (this proxy, including the /v1 path).
 *
 * Claude Code talks to Express directly, so the port must be Express' own —
 * never the port of whatever dev server proxied this page.
 */
function suggestedBaseUrl(req) {
    return `${gatewayOrigin(req)}/v1`;
}

function modelRow(label, id, note) {
    return `
      <div class="model-field">
        <div class="field-label"><label class="lbl" for="${id}">${label}</label><span>${note}</span></div>
        <div class="field-row">
          <input id="${id}" />
          <select onchange="if(this.value){${id}.value=this.value; this.selectedIndex=0;}" id="${id}Sel" aria-label="Select ${label} model"></select>
        </div>
      </div>`;
}

const CONFIG_HEAD = /* html */ `<style>
  main, .hdr-in { --maxw: 1280px; }
  main { padding-top: 42px; }
  .config-layout { display: grid; grid-template-columns: minmax(280px,.7fr) minmax(0,1.3fr); align-items: start; gap: 48px; }
  .config-context { position: sticky; top: 114px; padding-right: 30px; }
  .config-context h1 { max-width: 8ch; margin: 20px 0 0; font-size: clamp(3.2rem,5.7vw,6rem); font-weight: 610; line-height: .9; letter-spacing: -.075em; }
  .config-context > p { max-width: 42ch; margin: 24px 0 0; color: var(--muted); line-height: 1.65; }
  .config-state { display: grid; gap: 0; margin-top: 38px; border-top: 1px solid var(--border); }
  .state-row { display: grid; grid-template-columns: 88px minmax(0,1fr); gap: 15px; padding: 13px 0; border-bottom: 1px solid var(--border); }
  .state-row > span:first-child { color: var(--muted-2); font: 600 9px/1.5 var(--mono); text-transform: uppercase; }
  .state-row > span:last-child { min-width: 0; color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
  .config-editor { min-width: 0; border: 1px solid var(--border); border-radius: 20px; overflow: hidden; background: var(--surface); }
  .editor-head { display: flex; align-items: center; justify-content: space-between; gap: 18px; min-height: 74px; padding: 18px 24px; border-bottom: 1px solid var(--border); }
  .editor-head h2 { margin: 0; font-size: 18px; font-weight: 620; letter-spacing: -.035em; }
  .editor-head p { margin: 5px 0 0; color: var(--muted-2); font: 500 10px/1.4 var(--mono); }
  .editor-section { padding: 26px 24px; border-bottom: 1px solid var(--border); }
  .editor-section:last-of-type { border-bottom: 0; }
  .editor-section-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 18px; }
  .editor-section-head h3 { margin: 0; font-size: 13px; font-weight: 650; }
  .editor-section-head span { color: var(--muted-2); font: 500 9px/1 var(--mono); text-transform: uppercase; }
  .endpoint-grid { display: grid; grid-template-columns: minmax(0,1fr) minmax(180px,.42fr); gap: 16px; }
  .model-grid { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 20px 16px; }
  .model-field { min-width: 0; }
  .field-label { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .field-label span { color: var(--muted-2); font: 500 8px/1 var(--mono); text-transform: uppercase; }
  .current-route { margin-top: 13px; padding: 11px 12px; border-left: 1px solid var(--fg); background: #0d0d0e; }
  .editor-actions { display: flex; flex-wrap: wrap; gap: 9px; padding: 20px 24px; background: #0e0e10; }
  #status { margin-left: calc(30% + 48px); }
  @media (max-width: 900px) {
    .config-layout { grid-template-columns: 1fr; gap: 32px; }
    .config-context { position: static; padding-right: 0; }
    .config-context h1 { max-width: 10ch; }
    #status { margin-left: 0; }
  }
  @media (max-width: 620px) {
    main { padding-top: 20px; }
    .config-editor { border-radius: 16px; }
    .editor-head { align-items: flex-start; flex-direction: column; }
    .endpoint-grid, .model-grid { grid-template-columns: 1fr; }
    .editor-section, .editor-head, .editor-actions { padding-inline: 18px; }
    .editor-actions .btn { width: 100%; }
  }
</style>`;

const BODY = /* html */ `
  <div class="config-layout">
    <aside class="config-context" aria-labelledby="configTitle">
      <div class="section-kicker">Claude Code / local routing</div>
      <h1 id="configTitle">Map Claude to this gateway.</h1>
      <p>Write only the managed environment keys. Existing Claude settings remain intact and the current file is backed up before every change.</p>
      <div class="config-state">
        <div class="state-row"><span>Connection</span><span><span class="badge" id="conn"><span class="dot"></span> Checking</span></span></div>
        <div class="state-row"><span>Settings</span><span id="pathInfo">Locating settings file</span></div>
        <div class="state-row"><span>Safety</span><span>Merge managed keys + timestamped backup</span></div>
      </div>
    </aside>

    <section class="config-editor" aria-labelledby="editorTitle">
      <header class="editor-head">
        <div><h2 id="editorTitle">Gateway mapping</h2><p>Changes apply to ~/.claude/settings.json</p></div>
        <button class="btn-link" type="button" onclick="openManual()">${ICONS.copy} View JSON</button>
      </header>

      <section class="editor-section">
        <div class="editor-section-head"><h3>Connection</h3><span>Required</span></div>
        <div class="endpoint-grid">
          <div><label class="lbl" for="baseUrl">Anthropic base URL</label><input id="baseUrl" placeholder="http://localhost:4000/v1" /><small class="hint">Claude Code sends Messages API requests to this endpoint.</small></div>
          <div><label class="lbl" for="authToken">Proxy API key</label><input id="authToken" type="password" autocomplete="off" placeholder="dummy" /><small class="hint">Use the configured proxy key, or dummy for local unsecured mode.</small></div>
        </div>
        <div class="current-route"><span class="current" id="current">Reading current route…</span></div>
      </section>

      <section class="editor-section">
        <div class="editor-section-head"><h3>Model aliases</h3><span>Free text or catalog</span></div>
        <div class="model-grid">
          ${modelRow('Claude Opus', 'opusModel', 'Primary reasoning')}
          ${modelRow('Claude Sonnet', 'sonnetModel', 'Daily coding')}
          ${modelRow('Claude Haiku', 'haikuModel', 'Fast tasks')}
          ${modelRow('Subagent', 'subagentModel', 'Delegated work')}
        </div>
      </section>

      <footer class="editor-actions">
        <button class="btn primary" type="button" onclick="apply()">${ICONS.check} Save configuration</button>
        <button class="btn" type="button" onclick="resetForm()">${ICONS.arrow} Restore defaults</button>
        <button class="btn" type="button" onclick="openManual()">${ICONS.copy} Manual JSON</button>
      </footer>
    </section>
  </div>

  <div id="status" class="status" role="status" aria-live="polite"></div>
  <div class="overlay" id="overlay" onclick="if(event.target===this)closeManual()">
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="manualTitle">
      <div class="mh" id="manualTitle">${ICONS.copy} Manual Claude Code configuration</div>
      <div class="mb">
        <div class="actions" style="justify-content:space-between;margin-bottom:12px"><code class="current" id="manualPath">~/.claude/settings.json</code><button class="btn-link" type="button" onclick="copyManual()">${ICONS.copy} Copy JSON</button></div>
        <pre id="manualJson">{}</pre>
      </div>
    </div>
  </div>
`;

const SCRIPT = `
  const $ = (id) => document.getElementById(id);
  let MODELS = []; let DEFAULTS = null;
  function show(kind, msg){ const s=$('status'); s.className='status show '+kind; s.textContent=msg; }
  function fillSelect(id){ $(id).innerHTML = '<option value="">Select model…</option>' + MODELS.map(m=>'<option value="'+m+'">'+m+'</option>').join(''); }
  function currentConfig(){ return {
    baseUrl:$('baseUrl').value.trim(), authToken:$('authToken').value.trim(),
    opusModel:$('opusModel').value.trim(), sonnetModel:$('sonnetModel').value.trim(),
    haikuModel:$('haikuModel').value.trim(), subagentModel:$('subagentModel').value.trim() }; }

  async function load(){
    const r = await fetch('/config/claude/state'); const d = await r.json();
    MODELS = d.models || []; DEFAULTS = d.defaults;
    ['opusModelSel','sonnetModelSel','haikuModelSel','subagentModelSel'].forEach(fillSelect);
    const c = (d.current && d.current.baseUrl) ? d.current : d.defaults;
    // Endpoint always defaults to THIS running proxy's URL (its port), not any
    // stale value already in settings.json.
    $('baseUrl').value = d.suggestedBaseUrl;
    $('authToken').value = c.authToken || 'dummy';
    $('opusModel').value = c.opusModel || d.defaults.opusModel;
    $('sonnetModel').value = c.sonnetModel || d.defaults.sonnetModel;
    $('haikuModel').value = c.haikuModel || d.defaults.haikuModel;
    $('subagentModel').value = c.subagentModel || d.defaults.subagentModel;
    const cur = d.current && d.current.baseUrl ? d.current.baseUrl : '(not set)';
    const pointsHere = d.current && d.current.baseUrl === d.suggestedBaseUrl;
    $('current').textContent = cur + (d.current && d.current.baseUrl && !pointsHere ? '  → will change to ' + d.suggestedBaseUrl : '');
    $('pathInfo').textContent = d.settingsPath;
    $('manualPath').textContent = d.settingsPath;
    const configured = pointsHere;
    $('conn').className = 'badge' + (configured ? ' on' : '');
    $('conn').innerHTML = '<span class="dot"></span> ' + (configured ? 'Connected' : 'Not pointing here');
    if (d.error) show('err', d.error);
  }

  function resetForm(){
    $('baseUrl').value = DEFAULTS.baseUrl; $('authToken').value = DEFAULTS.authToken;
    $('opusModel').value = DEFAULTS.opusModel; $('sonnetModel').value = DEFAULTS.sonnetModel;
    $('haikuModel').value = DEFAULTS.haikuModel; $('subagentModel').value = DEFAULTS.subagentModel;
    show('ok', 'Form reset to defaults (not yet applied).');
  }

  async function apply(){
    show('ok', 'Applying…');
    try {
      const r = await fetch('/config/claude/apply', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(currentConfig()) });
      const d = await r.json(); if (!r.ok || !d.success) throw new Error(d.error || 'apply failed');
      show('ok', 'Saved to ' + d.settingsPath + (d.backupPath ? ' (backup: ' + d.backupPath.split('/').pop() + ')' : '') + '. Restart Claude Code to pick it up.');
      load();
    } catch(e){ show('err', e.message); }
  }

  async function openManual(){
    try {
      const r = await fetch('/config/claude/manual', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(currentConfig()) });
      const d = await r.json(); $('manualJson').textContent = d.snippet; $('overlay').classList.add('show');
    } catch(e){ show('err', e.message); }
  }
  function closeManual(){ $('overlay').classList.remove('show'); }
  function copyManual(){ navigator.clipboard.writeText($('manualJson').textContent).then(()=>show('ok','Copied manual config.')); }

  load();
`;

/** GET /config/claude — UI */
router.get('/', (req, res) => {
    res.type('html').send(renderPage({
        title: 'Kiro to Claude — Claude Code Config',
        active: 'config',
        body: BODY,
        script: SCRIPT,
        head: CONFIG_HEAD
    }));
});

/** GET /config/claude/state — current settings + models */
router.get('/state', async (req, res) => {
    try {
        const { exists, settings, error } = readClaudeSettings();
        const current = extractConfig(settings);
        let models = [];
        try {
            const list = await listKiroModels();
            models = (list.data || []).map(m => m.id);
        } catch {
            // Model list is best-effort; the UI still works with free-text.
        }
        res.json({
            settingsPath: CLAUDE_SETTINGS_PATH,
            exists,
            error,
            current,
            models,
            suggestedBaseUrl: suggestedBaseUrl(req),
            defaults: defaultConfig(suggestedBaseUrl(req))
        });
    } catch (error) {
        logger.error('[Config] state error:', error);
        res.status(500).json({ error: error.message });
    }
});

/** POST /config/claude/apply — merge config into settings.json */
router.post('/apply', (req, res) => {
    try {
        const config = req.body || {};
        if (!config.baseUrl) {
            return res.status(400).json({ success: false, error: 'baseUrl is required.' });
        }
        const result = applyClaudeSettings(config);
        logger.success(`[Config] Wrote Claude settings to ${result.settingsPath}`);
        res.json({
            success: true,
            settingsPath: result.settingsPath,
            backupPath: result.backupPath
        });
    } catch (error) {
        logger.error('[Config] apply error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/** POST /config/claude/manual — build the manual JSON snippet */
router.post('/manual', (req, res) => {
    try {
        const snippet = buildManualSnippet(req.body || {});
        res.json({ snippet, settingsPath: CLAUDE_SETTINGS_PATH });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

export default router;

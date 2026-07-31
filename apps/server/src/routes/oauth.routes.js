/**
 * OAuth Routes for Kiro
 *
 * Express router that exposes a browser-driven Kiro sign-in flow plus
 * auto-import and manual token import. Mounted at /oauth/kiro.
 *
 *   GET  /oauth/kiro                 -> HTML sign-in UI
 *   GET  /oauth/kiro/authorize       -> build social login URL (?provider=)
 *   POST /oauth/kiro/exchange        -> exchange callback code for tokens
 *   GET  /oauth/kiro/sources         -> list local credential sources
 *   GET  /oauth/kiro/auto-import     -> import from Kiro CLI DB / AWS SSO cache
 *   POST /oauth/kiro/import          -> import a pasted refresh token
 *   GET  /oauth/kiro/status          -> current stored credential status
 *
 * All successful flows persist credentials to the proxy token store, so the
 * auto-refresh mechanism keeps them alive.
 *
 * SECURITY: these endpoints handle OAuth tokens and have no authentication of
 * their own. Only expose the proxy on a trusted (localhost) interface.
 */

import express from 'express';
import {
    generatePKCE,
    buildSocialLoginUrl,
    exchangeSocialCode,
    parseCallback,
    extractEmailFromJWT,
    discoverAllCredentialSources,
    discoverLocalCredentials,
    validateAndBuildCredentials
} from '../auth/kiro-oauth.js';
import { saveKiroCredentials, isKiroAuthenticated } from '../auth/kiro-token-extractor.js';
import { renderPage, ICONS } from '../ui/theme.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

const AUTH_HEAD = /* html */ `<style>
  main, .hdr-in { --maxw: 1280px; }
  main { padding-top: 42px; }
  .auth-layout { display: grid; grid-template-columns: minmax(300px,.78fr) minmax(0,1.22fr); min-height: 720px; border: 1px solid var(--border); border-radius: 22px; overflow: hidden; background: var(--surface); }
  .auth-context { position: relative; display: flex; min-width: 0; flex-direction: column; justify-content: space-between; padding: clamp(34px,5vw,66px); border-right: 1px solid var(--border); background: #0e0e10; }
  .auth-context::after { content: ""; position: absolute; top: 0; right: 42px; width: 1px; height: 28%; background: var(--fg); opacity: .75; animation: signal 3.4s cubic-bezier(.16,1,.3,1) infinite alternate; }
  @keyframes signal { from { transform: scaleY(.35); transform-origin: top; opacity: .25; } to { transform: scaleY(1); transform-origin: top; opacity: .8; } }
  .auth-context h1 { max-width: 9ch; margin: 22px 0 0; font-size: clamp(3rem,5vw,5.7rem); font-weight: 610; line-height: .91; letter-spacing: -.075em; }
  .auth-lede { max-width: 46ch; margin: 24px 0 0; color: var(--muted); line-height: 1.65; }
  .trust-list { display: grid; margin: 46px 0 0; border-top: 1px solid var(--border); }
  .trust-list div { display: grid; grid-template-columns: 94px 1fr; gap: 18px; padding: 13px 0; border-bottom: 1px solid var(--border); }
  .trust-list dt { color: var(--muted-2); font: 600 9px/1.5 var(--mono); text-transform: uppercase; }
  .trust-list dd { margin: 0; color: var(--muted); font-size: 11px; }
  .auth-endpoint { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-top: 32px; padding-top: 18px; border-top: 1px solid var(--border); color: var(--muted-2); font: 500 10px/1 var(--mono); }
  .auth-endpoint i { width: 8px; height: 8px; border: 1px solid var(--fg); border-radius: 50%; animation: breathe 2.4s ease-in-out infinite; }
  @keyframes breathe { 50% { transform: scale(.58); opacity: .45; } }
  .auth-workflow { min-width: 0; padding: clamp(28px,4vw,52px); }
  .workflow-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; padding-bottom: 24px; border-bottom: 1px solid var(--border); }
  .workflow-head h2 { margin: 0; font-size: 24px; font-weight: 610; letter-spacing: -.04em; }
  .workflow-head p { margin: 7px 0 0; color: var(--muted); font-size: 12px; }
  .auth-method { display: grid; grid-template-columns: 42px minmax(0,1fr); gap: 18px; padding: 27px 0; border-bottom: 1px solid var(--border); }
  .method-index { color: var(--muted-2); font: 650 10px/1.5 var(--mono); }
  .method-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 13px; }
  .method-head h3 { margin: 0; font-size: 14px; font-weight: 650; }
  .method-head span { color: var(--muted-2); font: 500 9px/1 var(--mono); text-transform: uppercase; }
  .social-actions { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); gap: 9px; }
  .callback-box { margin-top: 14px; padding: 16px; border: 1px solid var(--border); border-radius: 12px; background: #0c0c0d; }
  .source-list .btn { justify-content: space-between; text-align: left; white-space: normal; }
  .manual-grid { display: grid; gap: 13px; }
  details { border-top: 1px dashed var(--border-strong); padding-top: 13px; }
  summary { cursor: pointer; }
  #status { margin-inline: auto; max-width: 1280px; }
  @media (max-width: 860px) {
    .auth-layout { grid-template-columns: 1fr; }
    .auth-context { min-height: 500px; border-right: 0; border-bottom: 1px solid var(--border); }
    .auth-context h1 { max-width: 10ch; }
  }
  @media (max-width: 560px) {
    main { padding-top: 20px; }
    .auth-layout { border-radius: 16px; }
    .auth-context, .auth-workflow { padding: 26px 20px; }
    .workflow-head { flex-direction: column; }
    .auth-method { grid-template-columns: 30px minmax(0,1fr); gap: 10px; }
    .method-head { align-items: flex-start; flex-direction: column; gap: 5px; }
    .social-actions { grid-template-columns: 1fr; }
  }
</style>`;

const BODY = /* html */ `
  <div class="auth-layout">
    <aside class="auth-context" aria-labelledby="signinTitle">
      <div>
        <div class="section-kicker">Local access / Kiro identity</div>
        <h1 id="signinTitle">Connect Kiro to your gateway.</h1>
        <p class="auth-lede">Authorize this process to reach the models available to your Kiro account. Credentials remain on this machine and refresh automatically.</p>
        <dl class="trust-list">
          <div><dt>Storage</dt><dd>Local credential store only</dd></div>
          <div><dt>Session</dt><dd>Automatic access-token refresh</dd></div>
          <div><dt>Network</dt><dd>Loopback-bound management UI</dd></div>
        </dl>
      </div>
      <div class="auth-endpoint"><span>127.0.0.1 / private control plane</span><i aria-hidden="true"></i></div>
    </aside>

    <section class="auth-workflow" aria-labelledby="accessMethodsTitle">
      <header class="workflow-head">
        <div><h2 id="accessMethodsTitle">Choose an access method</h2><p>Use the first method already available on this machine.</p></div>
        <span class="badge" id="currentStatus"><span class="dot"></span> Checking</span>
      </header>

      <section class="auth-method">
        <span class="method-index">01</span>
        <div>
          <div class="method-head"><h3>Browser sign-in</h3><span>Google or GitHub</span></div>
          <div class="social-actions">
            <button class="btn primary" type="button" onclick="startSocial('google')">${ICONS.key} Continue with Google</button>
            <button class="btn" type="button" onclick="startSocial('github')">${ICONS.key} Continue with GitHub</button>
          </div>
          <div id="callbackBox" style="display:none" class="callback-box stack">
            <small class="hint">After approval, copy the complete <code>kiro://</code> callback URL or authorization code from the browser.</small>
            <div><label class="lbl" for="callback">Callback URL or code</label><textarea id="callback" placeholder="kiro://kiro.kiroAgent/authenticate-success?code=...&state=..."></textarea></div>
            <button class="btn primary" type="button" onclick="completeSocial()">${ICONS.check} Complete sign-in</button>
          </div>
        </div>
      </section>

      <section class="auth-method">
        <span class="method-index">02</span>
        <div>
          <div class="method-head"><h3>Import from this machine</h3><span>Kiro IDE, CLI, or AWS SSO</span></div>
          <small class="hint">Detected credentials are validated and refreshed before storage.</small>
          <div id="sourceList" class="stack source-list" style="margin-top:14px"></div>
          <button class="btn sm" type="button" style="margin-top:12px" onclick="loadSources()">${ICONS.pulse} Rescan local sources</button>
        </div>
      </section>

      <section class="auth-method">
        <span class="method-index">03</span>
        <div>
          <div class="method-head"><h3>Import a refresh token</h3><span>Manual fallback</span></div>
          <div class="manual-grid">
            <div><label class="lbl" for="refreshToken">Refresh token</label><input id="refreshToken" type="password" autocomplete="off" placeholder="Paste token" /><small class="hint">The token is sent only to this localhost process.</small></div>
            <details>
              <summary class="hint">Enterprise / IDC options</summary>
              <div class="stack" style="margin-top:13px">
                <div><label class="lbl" for="clientId">Client ID</label><input id="clientId" autocomplete="off" /></div>
                <div><label class="lbl" for="clientSecret">Client secret</label><input id="clientSecret" type="password" autocomplete="off" /></div>
                <div><label class="lbl" for="region">Region</label><input id="region" value="us-east-1" /></div>
              </div>
            </details>
            <button class="btn primary" type="button" onclick="manualImport()">${ICONS.check} Validate and import</button>
          </div>
        </div>
      </section>
    </section>
  </div>
  <div id="status" class="status" role="status" aria-live="polite"></div>
`;

const SCRIPT = `
  let pkce = null;
  const $ = (id) => document.getElementById(id);
  function show(kind, msg) { const s=$('status'); s.className='status show '+kind; s.textContent=msg; }

  async function refreshCurrent() {
    try {
      const r = await fetch('/oauth/kiro/status'); const d = await r.json();
      const el = $('currentStatus');
      el.className = 'badge' + (d.authenticated ? ' on' : '');
      el.innerHTML = '<span class="dot"></span> ' + (d.authenticated ? 'Signed in' : 'Not signed in yet');
    } catch {}
  }

  async function startSocial(provider) {
    show('ok', 'Preparing ' + provider + ' login…');
    try {
      const r = await fetch('/oauth/kiro/authorize?provider=' + provider);
      const d = await r.json(); if (!r.ok) throw new Error(d.error || 'authorize failed');
      pkce = { codeVerifier: d.codeVerifier, state: d.state, provider };
      window.open(d.authUrl, '_blank');
      $('callbackBox').style.display = 'flex';
      show('ok', 'Login tab opened. Paste the callback URL below to finish.');
    } catch (e) { show('err', e.message); }
  }

  async function completeSocial() {
    if (!pkce) return show('err', 'Start a social login first.');
    show('ok', 'Exchanging code…');
    try {
      const r = await fetch('/oauth/kiro/exchange', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ callback: $('callback').value, codeVerifier: pkce.codeVerifier, state: pkce.state, provider: pkce.provider }) });
      const d = await r.json(); if (!r.ok || !d.success) throw new Error(d.error || 'exchange failed');
      show('ok', 'Signed in' + (d.email ? ' as ' + d.email : '') + '. Token stored & auto-refresh enabled.');
      refreshCurrent();
    } catch (e) { show('err', e.message); }
  }

  async function loadSources() {
    const box = $('sourceList'); box.innerHTML = '<small class="hint">Scanning…</small>';
    try {
      const r = await fetch('/oauth/kiro/sources'); const d = await r.json();
      if (!d.sources || !d.sources.length) { box.innerHTML = '<small class="hint">No local Kiro credentials found. Use social login or manual import.</small>'; return; }
      box.innerHTML = '';
      for (const s of d.sources) {
        const exp = s.expiresAt ? (s.expired ? ' · expired (will refresh)' : ' · valid') : '';
        const meta = [s.provider, s.authType].filter(Boolean).join(' · ');
        const btn = document.createElement('button');
        btn.className = 'btn block'; btn.style.justifyContent = 'space-between';
        btn.innerHTML = '<span>Import from ' + s.label + (meta ? '  (' + meta + ')' : '') + exp + '</span>';
        btn.onclick = () => autoImport(s.id, s.label);
        box.appendChild(btn);
      }
    } catch (e) { box.innerHTML = '<small class="hint">Failed to scan: ' + e.message + '</small>'; }
  }

  async function autoImport(sourceId, label) {
    show('ok', 'Importing from ' + (label || 'source') + '…');
    try {
      const r = await fetch('/oauth/kiro/auto-import', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ source: sourceId }) });
      const d = await r.json(); if (!r.ok || !d.success) throw new Error(d.error || 'auto-import failed');
      show('ok', 'Imported from ' + (d.label || d.source) + (d.email ? ' (' + d.email + ')' : '') + '. Token stored & auto-refresh enabled.');
      refreshCurrent();
    } catch (e) { show('err', e.message); }
  }

  async function manualImport() {
    const refreshToken = $('refreshToken').value.trim();
    if (!refreshToken) return show('err', 'Enter a refresh token.');
    show('ok', 'Validating token…');
    try {
      const r = await fetch('/oauth/kiro/import', { method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ refreshToken, clientId: $('clientId').value.trim() || undefined, clientSecret: $('clientSecret').value.trim() || undefined, region: $('region').value.trim() || undefined }) });
      const d = await r.json(); if (!r.ok || !d.success) throw new Error(d.error || 'import failed');
      show('ok', 'Token imported' + (d.email ? ' (' + d.email + ')' : '') + '. Stored & auto-refresh enabled.');
      refreshCurrent();
    } catch (e) { show('err', e.message); }
  }

  refreshCurrent();
  loadSources();
`;

/** GET /oauth/kiro — sign-in UI */
router.get('/', (req, res) => {
    res.type('html').send(renderPage({
        title: 'Kiro to Claude — Sign in',
        active: 'signin',
        body: BODY,
        script: SCRIPT,
        head: AUTH_HEAD
    }));
});

/** GET /oauth/kiro/status — current credential status */
router.get('/status', (req, res) => {
    try {
        const authed = isKiroAuthenticated();
        res.json({ authenticated: authed });
    } catch {
        res.json({ authenticated: false });
    }
});

/** GET /oauth/kiro/authorize?provider=google|github */
router.get('/authorize', (req, res) => {
    try {
        const provider = req.query.provider;
        if (!provider || !['google', 'github'].includes(provider)) {
            return res.status(400).json({ error: "Invalid provider. Use 'google' or 'github'." });
        }
        const { codeVerifier, codeChallenge, state } = generatePKCE();
        const authUrl = buildSocialLoginUrl(provider, codeChallenge, state);
        res.json({ authUrl, state, codeVerifier, provider });
    } catch (error) {
        logger.error('[Kiro OAuth] authorize error:', error);
        res.status(500).json({ error: error.message });
    }
});

/** POST /oauth/kiro/exchange — exchange callback code for tokens */
router.post('/exchange', async (req, res) => {
    try {
        const { callback, code: rawCode, codeVerifier, state, provider } = req.body || {};
        if (!codeVerifier) {
            return res.status(400).json({ error: 'Missing codeVerifier. Start the login again.' });
        }

        // Accept either a pasted callback URL or a raw code.
        let code = rawCode;
        if (!code && callback) {
            const parsed = parseCallback(callback);
            code = parsed.code;
            // Best-effort CSRF check when the callback carries state.
            if (parsed.state && state && parsed.state !== state) {
                return res.status(400).json({ error: 'State mismatch — possible CSRF. Restart the login.' });
            }
        }
        if (!code) {
            return res.status(400).json({ error: 'No authorization code found in the callback.' });
        }

        const tokenData = await exchangeSocialCode(code, codeVerifier);
        const email = extractEmailFromJWT(tokenData.accessToken);

        saveKiroCredentials({
            authKey: 'kirocli:social:token',
            accessToken: tokenData.accessToken,
            refreshToken: tokenData.refreshToken,
            expiresAt: new Date(Date.now() + (tokenData.expiresIn || 3600) * 1000),
            region: 'us-east-1',
            profileArn: tokenData.profileArn || null,
            provider: provider || 'social'
        });

        res.json({ success: true, email });
    } catch (error) {
        logger.error('[Kiro OAuth] exchange error:', error);
        res.status(500).json({ error: error.message });
    }
});

/** GET /oauth/kiro/sources — list discoverable local credential sources */
router.get('/sources', async (req, res) => {
    try {
        const all = await discoverAllCredentialSources();
        const sources = all.map(s => {
            const expiresAt = s.expiresAt || null;
            const expired = expiresAt ? new Date(expiresAt) <= new Date() : null;
            return {
                id: s.source,
                label: s.label || s.source,
                provider: s.provider || null,
                authType: s.authKey && s.authKey.includes('social') ? 'social' : 'sso',
                expiresAt,
                expired,
                hasProfileArn: !!s.profileArn
            };
        });
        res.json({ sources });
    } catch (error) {
        logger.error('[Kiro OAuth] sources error:', error);
        res.status(500).json({ sources: [], error: error.message });
    }
});

/**
 * GET  /oauth/kiro/auto-import[?source=ID]
 * POST /oauth/kiro/auto-import  { source }
 * Import from a specific local source, or the highest-priority one if omitted.
 */
async function handleAutoImport(req, res) {
    try {
        const sourceId = (req.body && req.body.source) || req.query.source || null;
        const discovered = await discoverLocalCredentials(sourceId);
        if (!discovered) {
            return res.status(404).json({
                success: false,
                error: sourceId
                    ? `Source "${sourceId}" not found or has no valid token.`
                    : 'No local Kiro credentials found (Kiro CLI DB or AWS SSO cache). Sign in with Kiro first.'
            });
        }

        const creds = await validateAndBuildCredentials(discovered);
        const email = extractEmailFromJWT(creds.accessToken);
        saveKiroCredentials(creds);

        res.json({
            success: true,
            source: discovered.source,
            label: discovered.label || discovered.source,
            email
        });
    } catch (error) {
        logger.error('[Kiro OAuth] auto-import error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
}

router.get('/auto-import', handleAutoImport);
router.post('/auto-import', handleAutoImport);

/** POST /oauth/kiro/import — import a pasted refresh token */
router.post('/import', async (req, res) => {
    try {
        const { refreshToken, clientId, clientSecret, region, profileArn } = req.body || {};
        if (!refreshToken || typeof refreshToken !== 'string') {
            return res.status(400).json({ error: 'Refresh token is required.' });
        }

        const isIdc = !!(clientId && clientSecret);
        const discovered = {
            authKey: isIdc ? 'kirocli:odic:token' : 'kirocli:social:token',
            refreshToken: refreshToken.trim(),
            region: region || 'us-east-1',
            profileArn: profileArn || null,
            provider: isIdc ? 'idc' : 'imported',
            clientId: clientId || null,
            clientSecret: clientSecret || null
        };

        const creds = await validateAndBuildCredentials(discovered);
        const email = extractEmailFromJWT(creds.accessToken);
        saveKiroCredentials(creds);

        res.json({ success: true, email });
    } catch (error) {
        logger.error('[Kiro OAuth] import error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;

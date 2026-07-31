/**
 * Shared UI theme + page shell for all proxy web pages.
 *
 * Design system (via ui-ux-pro-max, dense operations console):
 *   - Monochrome off-black/white, base background #0b0b0c
 *   - Self-hosted Geist (UI) / Geist Mono (code and data)
 *   - SVG icons only, visible focus states, reduced-motion support, responsive
 *
 * Every page uses renderPage() so the header, navigation, and styling stay
 * consistent across the dashboard, sign-in, and config screens.
 */

/** Inline SVG icons (stroke-based, single visual language). */
export const ICONS = {
    logo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="24" height="24"><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M18.4 5.6L5.6 18.4"/></svg>',
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
    key: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2M16 7l3 3M14 9l3 3"/></svg>',
    sliders: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>',
    cube: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M21 16V8a2 2 0 0 0-1-1.7l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.7l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7 12 12l8.7-5M12 22V12"/></svg>',
    pulse: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="18" height="18"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><polyline points="20 6 9 17 4 12"/></svg>',
    arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>',
    external: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
};

/** Shared stylesheet — monochrome tokens + components. */
export const THEME_CSS = /* css */ `
@font-face {
  font-family: "Geist";
  src: url("/ui/assets/geist/Geist-Variable.woff2") format("woff2");
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}
@font-face {
  font-family: "Geist Mono";
  src: url("/ui/assets/geist/GeistMono-Variable.woff2") format("woff2");
  font-style: normal;
  font-weight: 100 900;
  font-display: swap;
}

:root {
  --bg: #0b0b0c;
  --surface: #111113;
  --surface-2: #171719;
  --surface-3: #1d1d20;
  --border: #29292d;
  --border-strong: #404045;
  --fg: #f5f5f3;
  --muted: #a6a6a8;
  --muted-2: #747477;
  --accent: #ffffff;
  --on-accent: #0b0b0c;
  --ring: #ffffff;
  --radius: 16px;
  --radius-sm: 9px;
  --maxw: 1200px;
  --sans: "Geist", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "Geist Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  color-scheme: dark;
}

* { box-sizing: border-box; }
html { min-width: 320px; background: var(--bg); -webkit-text-size-adjust: 100%; }
body {
  margin: 0; min-width: 320px; min-height: 100dvh; overflow-x: hidden;
  background: var(--bg); color: var(--fg); font-family: var(--sans);
  font-size: 15px; line-height: 1.55; letter-spacing: -.01em;
  -webkit-font-smoothing: antialiased;
}
body::before {
  content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background:
    linear-gradient(90deg, transparent 0, transparent calc(50% - .5px), rgba(255,255,255,.035) 50%, transparent calc(50% + .5px)),
    radial-gradient(circle at 78% 8%, rgba(255,255,255,.055), transparent 30%);
}
a { color: inherit; text-decoration: none; }
button, input, select, textarea { font: inherit; }
code, pre { font-family: var(--mono); }
::selection { color: var(--on-accent); background: var(--accent); }

.hdr {
  position: sticky; top: 0; z-index: 40; border-bottom: 1px solid var(--border);
  background: rgba(11,11,12,.9); backdrop-filter: blur(18px);
}
.hdr-in {
  display: grid; grid-template-columns: 1fr auto; align-items: center;
  width: min(var(--maxw), calc(100% - 48px)); min-height: 72px; margin: 0 auto; gap: 24px;
}
.brand { display: inline-flex; align-items: center; justify-self: start; gap: 11px; font-weight: 650; letter-spacing: -.025em; }
.brand .mark {
  display: grid; width: 38px; height: 38px; place-items: center;
  color: var(--on-accent); background: var(--accent); border-radius: 10px;
}
.brand small { display: block; margin-top: 1px; color: var(--muted-2); font-size: 10px; font-weight: 450; letter-spacing: 0; }
.nav { display: flex; align-items: center; justify-self: end; gap: 3px; padding: 4px; border: 1px solid var(--border); border-radius: 12px; background: var(--surface); }
.nav a {
  display: inline-flex; min-height: 38px; align-items: center; gap: 7px; padding: 0 12px;
  color: var(--muted); border-radius: 8px; font-size: 12px; font-weight: 600;
  transition: color .3s cubic-bezier(.16,1,.3,1), background .3s cubic-bezier(.16,1,.3,1), transform .3s cubic-bezier(.16,1,.3,1);
}
.nav a:hover { color: var(--fg); background: var(--surface-3); }
.nav a:active { transform: translateY(1px) scale(.98); }
.nav a.active { color: var(--on-accent); background: var(--accent); }
.nav a svg { opacity: .92; }

main { position: relative; width: min(var(--maxw), calc(100% - 48px)); margin: 0 auto; padding: 56px 0 96px; }
.page-head { margin-bottom: 34px; }
.page-head h1 { max-width: 15ch; margin: 0; font-size: clamp(2.5rem, 6vw, 5.25rem); font-weight: 610; line-height: .96; letter-spacing: -.065em; }
.page-head p { max-width: 62ch; margin: 22px 0 0; color: var(--muted); font-size: 15px; line-height: 1.65; }
.section-kicker { color: var(--muted-2); font: 650 10px/1.2 var(--mono); letter-spacing: .13em; text-transform: uppercase; }

.card { padding: 24px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.grid { display: grid; gap: 16px; }
.grid.cols-2 { grid-template-columns: repeat(2, minmax(0,1fr)); }
.grid.cols-3 { grid-template-columns: repeat(3, minmax(0,1fr)); }
.stack { display: flex; flex-direction: column; gap: 14px; }
.section { margin-top: 30px; padding-top: 26px; border-top: 1px solid var(--border); }
.section h2 { margin: 0 0 18px; color: var(--muted); font: 650 10px/1.2 var(--mono); letter-spacing: .12em; text-transform: uppercase; }

label.lbl { display: block; margin-bottom: 7px; color: var(--fg); font-size: 12px; font-weight: 600; }
input, select, textarea {
  width: 100%; min-height: 44px; padding: 0 13px; color: var(--fg);
  border: 1px solid var(--border-strong); border-radius: 9px; background: #0e0e10;
  box-shadow: inset 0 1px 0 rgba(255,255,255,.035);
  transition: border-color .3s cubic-bezier(.16,1,.3,1), background .3s cubic-bezier(.16,1,.3,1), box-shadow .3s cubic-bezier(.16,1,.3,1);
}
textarea { min-height: 94px; padding-block: 11px; resize: vertical; line-height: 1.5; }
select { appearance: none; padding-right: 38px; cursor: pointer; background-image: url("data:image/svg+xml;charset=UTF-8,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%23a6a6a8' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E"); background-repeat: no-repeat; background-position: right 12px center; }
select option { color: var(--fg); background: var(--surface); }
input::placeholder, textarea::placeholder { color: #5f5f63; }
input:hover, select:hover, textarea:hover { border-color: #5a5a60; }
input:focus, select:focus, textarea:focus { outline: none; border-color: var(--fg); box-shadow: 0 0 0 3px rgba(255,255,255,.1), inset 0 1px 0 rgba(255,255,255,.04); }
input:disabled, select:disabled, textarea:disabled { opacity: .5; cursor: not-allowed; }
.row { display: grid; gap: 8px; margin-bottom: 16px; }
.field-row { display: grid; grid-template-columns: minmax(0,1fr) 190px; gap: 9px; }
.current { color: var(--muted-2); font: 500 10px/1.5 var(--mono); overflow-wrap: anywhere; }
small.hint { display: block; color: var(--muted); font-size: 11px; line-height: 1.55; }

.btn {
  appearance: none; display: inline-flex; min-height: 44px; align-items: center; justify-content: center; gap: 8px;
  padding: 0 16px; color: var(--fg); border: 1px solid var(--border-strong); border-radius: 9px;
  background: transparent; font-size: 12px; font-weight: 650; white-space: nowrap; cursor: pointer;
  transition: color .3s cubic-bezier(.16,1,.3,1), background .3s cubic-bezier(.16,1,.3,1), border-color .3s cubic-bezier(.16,1,.3,1), transform .3s cubic-bezier(.16,1,.3,1);
}
.btn:hover { color: var(--fg); border-color: #66666c; background: var(--surface-3); }
.btn:active { transform: translateY(1px) scale(.98); }
.btn:disabled { opacity: .45; pointer-events: none; }
.btn.primary { color: var(--on-accent); border-color: var(--accent); background: var(--accent); }
.btn.primary:hover { color: var(--on-accent); background: #dededc; }
.btn.block { width: 100%; }
.btn.sm { min-height: 38px; padding-inline: 13px; font-size: 11px; }
.btn-link { display: inline-flex; align-items: center; gap: 6px; padding: 5px; color: var(--muted); border: 0; background: none; font-size: 11px; cursor: pointer; }
.btn-link:hover { color: var(--fg); text-decoration: underline; text-underline-offset: 4px; }
.actions { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }

.badge { display: inline-flex; min-height: 28px; align-items: center; gap: 7px; padding: 0 10px; color: var(--muted); border: 1px solid var(--border-strong); border-radius: 999px; font: 550 10px/1 var(--mono); }
.badge.on { color: var(--on-accent); border-color: var(--accent); background: var(--accent); }
.badge .dot { width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.status { display: none; margin-top: 18px; padding: 13px 15px; color: var(--muted); border: 1px solid var(--border-strong); border-radius: 9px; background: var(--surface); font-size: 12px; }
.status.show { display: block; animation: reveal .45s cubic-bezier(.16,1,.3,1) both; }
.status.ok { color: var(--fg); border-color: #5b5b61; }
.status.err { color: var(--fg); border-style: dashed; }
.status.err::before { content: "Error / "; color: var(--muted); font-family: var(--mono); }

.overlay { position: fixed; inset: 0; z-index: 100; display: none; align-items: center; justify-content: center; padding: 20px; background: rgba(5,5,6,.78); backdrop-filter: blur(10px); }
.overlay.show { display: flex; }
.modal { width: min(680px,100%); overflow: hidden; border: 1px solid var(--border-strong); border-radius: var(--radius); background: var(--surface); box-shadow: 0 28px 80px rgba(0,0,0,.48); }
.modal .mh { display: flex; min-height: 56px; align-items: center; gap: 8px; padding: 0 20px; border-bottom: 1px solid var(--border); font-size: 13px; font-weight: 650; }
.modal .mb { padding: 20px; }
pre { margin: 0; padding: 16px; overflow: auto; color: var(--fg); border: 1px solid var(--border); border-radius: 10px; background: #080809; font: 500 11px/1.6 var(--mono); white-space: pre; }

:focus-visible { outline: 2px solid var(--ring); outline-offset: 3px; }
.skip { position: fixed; top: 8px; left: 8px; z-index: 200; padding: 9px 14px; color: var(--on-accent); border-radius: 8px; background: var(--accent); transform: translateY(-160%); transition: transform .2s ease; }
.skip:focus { transform: translateY(0); }
@keyframes reveal { from { opacity: 0; transform: translateY(9px); } to { opacity: 1; transform: translateY(0); } }
main > * { animation: reveal .65s cubic-bezier(.16,1,.3,1) both; }

@media (max-width: 760px) {
  .hdr-in, main { width: calc(100% - 28px); }
  .hdr-in { grid-template-columns: 1fr; padding: 12px 0; gap: 9px; }
  .nav { width: 100%; justify-self: stretch; justify-content: center; }
  .nav a { min-width: 52px; min-height: 44px; justify-content: center; }
  .nav-labels { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  main { padding: 34px 0 64px; }
  .grid.cols-2, .grid.cols-3, .field-row { grid-template-columns: 1fr; }
  .page-head h1 { font-size: clamp(2.5rem, 13vw, 4.25rem); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { scroll-behavior: auto !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; transition-duration: .01ms !important; }
}
`;


/**
 * Build the top navigation, marking the active item.
 * @param {string} active - key of the active nav item
 */
function nav(active) {
    const items = [
        { key: 'dashboard', href: '/', label: 'Dashboard', icon: ICONS.dashboard },
        { key: 'signin', href: '/oauth/kiro', label: 'Sign in', icon: ICONS.key },
        { key: 'config', href: '/config/claude', label: 'Claude Config', icon: ICONS.sliders }
    ];
    return items.map(i =>
        `<a href="${i.href}" aria-label="${i.label}"${i.key === active ? ' class="active" aria-current="page"' : ''}>${i.icon}<span class="nav-labels">${i.label}</span></a>`
    ).join('');
}

/**
 * Render a full HTML page with the shared shell.
 * @param {Object} opts
 * @param {string} opts.title - page <title>
 * @param {string} opts.active - active nav key (dashboard|signin|config)
 * @param {string} opts.body - main content HTML
 * @param {string} [opts.script] - page JS (without <script> tags)
 * @param {string} [opts.head] - extra head HTML (page-specific CSS)
 * @returns {string}
 */
export function renderPage({ title, active, body, script = '', head = '' }) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23fafafa'/%3E%3Cpath d='M16 6v20M6 16h20M9 9l14 14M23 9L9 23' stroke='%23000' stroke-width='2' stroke-linecap='round'/%3E%3C/svg%3E" />
<style>${THEME_CSS}</style>
${head}
</head>
<body>
<a href="#main" class="skip">Skip to content</a>
<header class="hdr">
  <div class="hdr-in">
    <a class="brand" href="/">
      <span class="mark">${ICONS.logo}</span>
      <span>Kiro to Claude<small>Anthropic-compatible gateway</small></span>
    </a>
    <nav class="nav" aria-label="Primary">${nav(active)}</nav>
  </div>
</header>
<main id="main">
${body}
</main>
${script ? `<script>${script}</script>` : ''}
</body>
</html>`;
}

export default { THEME_CSS, ICONS, renderPage };

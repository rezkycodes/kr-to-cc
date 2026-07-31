import { THEME_CSS } from './theme.js';

const TELEMETRY_CSS = /* css */ `
:root {
  --ok: #f5f5f3;
  --fail: #b8b8bb;
  --warn: #8c8c90;
  --info: #d2d2d4;
}
body { min-height: 0; padding: 18px; background: #0b0b0c; font-size: 14px; }
body::before { display: none; }
.telemetry { max-width: 1180px; margin: 0 auto; }
.telemetry-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 20px; margin-bottom: 16px; }
.eyebrow { color: var(--muted-2); font: 600 10px/1.2 var(--mono); letter-spacing: .13em; text-transform: uppercase; }
.telemetry-head h1 { margin: 5px 0 4px; font-size: 20px; line-height: 1.2; letter-spacing: -.025em; }
.telemetry-head p { margin: 0; color: var(--muted); font-size: 12px; }
.controls { display: flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 8px; }
.live { display: inline-flex; align-items: center; gap: 7px; min-height: 32px; padding: 0 10px; color: var(--muted); border: 1px solid var(--border); border-radius: 6px; font: 500 11px/1 var(--mono); }
.live::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--muted-2); }
.live.on::before { background: var(--ok); box-shadow: 0 0 0 4px rgba(255,255,255,.09); }
.window-select { width: auto; min-width: 105px; height: 32px; font: 500 11px/1 var(--mono); }
.refresh { height: 32px; padding: 0 11px; font-size: 12px; }
.alert { display: none; margin-bottom: 12px; padding: 10px 12px; border: 1px dashed var(--border-strong); border-radius: 7px; color: var(--fg); background: var(--surface); font-size: 12px; }
.alert.show { display: block; }
.metrics { display: grid; grid-template-columns: 1.25fr repeat(4, minmax(0, 1fr)); gap: 0; margin-bottom: 10px; border-block: 1px solid var(--border); }
.metric { min-width: 0; padding: 16px 14px; border-right: 1px solid var(--border); background: transparent; }
.metric:last-child { border-right: 0; }
.metric-label { display: flex; justify-content: space-between; gap: 8px; color: var(--muted-2); font: 600 10px/1.2 var(--mono); letter-spacing: .06em; text-transform: uppercase; }
.metric-value { margin-top: 9px; color: var(--fg); font: 600 25px/1 var(--mono); letter-spacing: -.04em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.metric-value.ok { color: var(--fg); }
.metric-value.fail { color: var(--muted); }
.metric-sub { margin-top: 7px; color: var(--muted-2); font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.panel { border: 1px solid var(--border); border-radius: 8px; background: var(--surface); overflow: hidden; }
.panel-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; padding: 10px 13px; border-bottom: 1px solid var(--border); }
.panel-title { margin: 0; font-size: 12px; font-weight: 600; letter-spacing: -.01em; }
.panel-meta { color: var(--muted-2); font: 500 10px/1 var(--mono); }
.legend { display: flex; align-items: center; gap: 13px; color: var(--muted); font-size: 10px; }
.legend span { display: inline-flex; align-items: center; gap: 6px; }
.legend i { width: 8px; height: 8px; border-radius: 2px; background: currentColor; }
.legend .success { color: var(--ok); }
.legend .failed { color: var(--fail); }
.chart-wrap { position: relative; min-height: 224px; padding: 9px 8px 2px; }
#requestChart { display: block; width: 100%; height: 210px; overflow: visible; }
.chart-empty { display: none; position: absolute; inset: 0; place-items: center; color: var(--muted-2); font-size: 12px; pointer-events: none; }
.chart-empty.show { display: grid; }
.details { display: grid; grid-template-columns: minmax(0, 1.35fr) minmax(250px, .65fr); gap: 10px; margin-top: 10px; }
.data-list { min-height: 156px; max-height: 220px; overflow: auto; }
.model-row { display: grid; grid-template-columns: minmax(130px, 1fr) 64px 64px 72px; gap: 10px; align-items: center; min-height: 39px; padding: 8px 13px; border-bottom: 1px solid var(--border); }
.model-row:last-child { border-bottom: 0; }
.model-main { min-width: 0; }
.model-name { color: var(--fg); font: 500 11px/1.3 var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.model-bar { height: 3px; margin-top: 6px; overflow: hidden; border-radius: 99px; background: var(--surface-3); }
.model-bar > span { display: block; height: 100%; background: var(--fg); }
.model-stat { color: var(--muted); font: 500 10px/1 var(--mono); text-align: right; white-space: nowrap; }
.model-stat.bad { color: var(--fail); }
.error-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; min-height: 38px; padding: 8px 13px; border-bottom: 1px solid var(--border); }
.error-row:last-child { border-bottom: 0; }
.error-name { min-width: 0; color: var(--muted); font: 500 10px/1.3 var(--mono); overflow-wrap: anywhere; }
.error-count { color: var(--fg); font: 600 12px/1 var(--mono); }
.empty { display: grid; place-items: center; min-height: 130px; padding: 18px; color: var(--muted-2); font-size: 11px; text-align: center; }
.failures { margin-top: 10px; }
.table-wrap { overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 11px; }
th { padding: 8px 10px; color: var(--muted-2); font: 600 9px/1 var(--mono); letter-spacing: .05em; text-align: left; text-transform: uppercase; border-bottom: 1px solid var(--border); }
td { padding: 9px 10px; color: var(--muted); border-bottom: 1px solid var(--border); white-space: nowrap; }
tbody tr:last-child td { border-bottom: 0; }
td code { color: var(--fg); font: 500 10px/1 var(--mono); }
.outcome { display: inline-flex; align-items: center; gap: 5px; color: var(--fg); font: 600 10px/1 var(--mono); }
.outcome.canceled { color: var(--muted); }
.outcome::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.privacy { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 10px; padding: 9px 2px 0; color: var(--muted-2); font-size: 10px; }
.privacy strong { color: var(--muted); font-weight: 500; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 820px) {
  .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .metrics .metric:first-child { grid-column: span 2; }
  .details { grid-template-columns: 1fr; }
}
@media (max-width: 560px) {
  body { padding: 12px; }
  .telemetry-head { flex-direction: column; }
  .controls { justify-content: flex-start; width: 100%; }
  .live, .window-select, .refresh { min-height: 44px; height: 44px; }
  .metrics { grid-template-columns: 1fr 1fr; }
  .model-row { grid-template-columns: minmax(120px, 1fr) 58px 58px; }
  .model-row .latency { display: none; }
  th:nth-child(4), td:nth-child(4), th:nth-child(6), td:nth-child(6) { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .live.on::before { box-shadow: none; }
}
`;

const TELEMETRY_BODY = /* html */ `
<div class="telemetry">
  <header class="telemetry-head">
    <div>
      <div class="eyebrow">Local observability / memory only</div>
      <h1>Request telemetry</h1>
      <p>Anthropic Messages traffic, upstream health, and latency in one view.</p>
    </div>
    <div class="controls">
      <span class="live" id="liveState" aria-live="polite">Connecting</span>
      <label class="sr-only" for="windowSelect">Telemetry time range</label>
      <select class="window-select" id="windowSelect">
        <option value="15">Last 15m</option>
        <option value="60" selected>Last 1h</option>
        <option value="360">Last 6h</option>
      </select>
      <button class="btn refresh" id="refreshButton" type="button">Refresh</button>
    </div>
  </header>

  <div class="alert" id="errorBanner" role="alert"></div>

  <section class="metrics" aria-label="Request metrics">
    <article class="metric">
      <div class="metric-label"><span>Requests</span><span>Σ</span></div>
      <div class="metric-value" id="metricRequests">—</div>
      <div class="metric-sub" id="metricRequestsSub">Waiting for traffic</div>
    </article>
    <article class="metric">
      <div class="metric-label"><span>Success rate</span><span>%</span></div>
      <div class="metric-value ok" id="metricSuccessRate">—</div>
      <div class="metric-sub" id="metricSuccessSub">No measured requests</div>
    </article>
    <article class="metric">
      <div class="metric-label"><span>Failed</span><span>!</span></div>
      <div class="metric-value fail" id="metricFailed">—</div>
      <div class="metric-sub" id="metricFailedSub">No failures</div>
    </article>
    <article class="metric">
      <div class="metric-label"><span>In flight</span><span>↗</span></div>
      <div class="metric-value" id="metricInFlight">—</div>
      <div class="metric-sub">Active requests now</div>
    </article>
    <article class="metric">
      <div class="metric-label"><span>P95 latency</span><span>ms</span></div>
      <div class="metric-value" id="metricP95">—</div>
      <div class="metric-sub" id="metricLatencySub">P50 — · P99 —</div>
    </article>
  </section>

  <section class="panel" aria-labelledby="chartTitle">
    <div class="panel-head">
      <div>
        <h2 class="panel-title" id="chartTitle">Request outcomes per minute</h2>
        <span class="panel-meta" id="chartRange">Last 1 hour</span>
      </div>
      <div class="legend" aria-label="Chart legend">
        <span class="success"><i></i>Success</span>
        <span class="failed"><i></i>Failed</span>
      </div>
    </div>
    <div class="chart-wrap">
      <svg id="requestChart" viewBox="0 0 900 220" role="img" aria-label="Success and failed requests per minute"></svg>
      <div class="chart-empty" id="chartEmpty">No completed requests in this time range.</div>
    </div>
  </section>

  <div class="details">
    <section class="panel" aria-labelledby="modelTitle">
      <div class="panel-head">
        <h2 class="panel-title" id="modelTitle">Model health</h2>
        <span class="panel-meta">volume · success · p95</span>
      </div>
      <div class="data-list" id="modelList"><div class="empty">Waiting for model traffic.</div></div>
    </section>

    <section class="panel" aria-labelledby="errorTitle">
      <div class="panel-head">
        <h2 class="panel-title" id="errorTitle">Failure categories</h2>
        <span class="panel-meta">bounded labels</span>
      </div>
      <div class="data-list" id="errorList"><div class="empty">No failures in range.</div></div>
    </section>
  </div>

  <section class="panel failures" aria-labelledby="failureTitle">
    <div class="panel-head">
      <h2 class="panel-title" id="failureTitle">Recent failures</h2>
      <span class="panel-meta">latest 20</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Time</th><th>Request</th><th>Model</th><th>Mode</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead>
        <tbody id="failureRows"><tr><td colspan="7"><div class="empty">No failed or canceled requests.</div></td></tr></tbody>
      </table>
    </div>
  </section>

  <footer class="privacy">
    <span><strong>Privacy:</strong> no prompts, tools, headers, tokens, or response bodies are stored.</span>
    <time id="updatedAt" aria-live="polite">Not updated yet</time>
  </footer>
</div>
`;

const TELEMETRY_SCRIPT = /* js */ `
(function () {
  var SVG_NS = 'http://www.w3.org/2000/svg';
  var refreshTimer;
  var loading = false;
  var elements = {
    live: document.getElementById('liveState'),
    select: document.getElementById('windowSelect'),
    refresh: document.getElementById('refreshButton'),
    error: document.getElementById('errorBanner'),
    requests: document.getElementById('metricRequests'),
    requestsSub: document.getElementById('metricRequestsSub'),
    successRate: document.getElementById('metricSuccessRate'),
    successSub: document.getElementById('metricSuccessSub'),
    failed: document.getElementById('metricFailed'),
    failedSub: document.getElementById('metricFailedSub'),
    inFlight: document.getElementById('metricInFlight'),
    p95: document.getElementById('metricP95'),
    latencySub: document.getElementById('metricLatencySub'),
    chart: document.getElementById('requestChart'),
    chartEmpty: document.getElementById('chartEmpty'),
    chartRange: document.getElementById('chartRange'),
    models: document.getElementById('modelList'),
    errors: document.getElementById('errorList'),
    failures: document.getElementById('failureRows'),
    updated: document.getElementById('updatedAt')
  };

  function number(value) {
    return new Intl.NumberFormat().format(Number(value) || 0);
  }

  function latency(value) {
    if (value === null || value === undefined) return '—';
    var numeric = Number(value);
    if (numeric >= 1000) return (numeric / 1000).toFixed(numeric >= 10000 ? 0 : 1) + 's';
    return Math.round(numeric) + 'ms';
  }

  function localTime(value) {
    return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }

  function svg(name, attrs, text) {
    var node = document.createElementNS(SVG_NS, name);
    Object.keys(attrs || {}).forEach(function (key) { node.setAttribute(key, String(attrs[key])); });
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function renderMetrics(data) {
    var totals = data.totals;
    elements.requests.textContent = number(totals.requests);
    elements.requestsSub.textContent = number(totals.success) + ' success · ' + number(totals.canceled) + ' canceled';
    elements.successRate.textContent = totals.success_rate === null ? '—' : totals.success_rate.toFixed(1) + '%';
    elements.successRate.className = 'metric-value ' + (totals.success_rate !== null && totals.success_rate < 95 ? 'fail' : 'ok');
    elements.successSub.textContent = totals.success_rate === null ? 'No measured requests' : number(totals.success) + ' of ' + number(totals.success + totals.failed) + ' measured';
    elements.failed.textContent = number(totals.failed);
    elements.failedSub.textContent = totals.failed ? number(data.by_error.length) + ' error categories' : 'No failures';
    elements.inFlight.textContent = number(totals.in_flight);
    elements.p95.textContent = latency(data.latency_ms.p95);
    elements.latencySub.textContent = 'P50 ' + latency(data.latency_ms.p50) + ' · P99 ' + latency(data.latency_ms.p99);
    elements.chartRange.textContent = data.window_minutes === 60 ? 'Last 1 hour' : 'Last ' + data.window_minutes + ' minutes';
  }

  function renderChart(series) {
    var chart = elements.chart;
    chart.replaceChildren();
    var width = 900, height = 220, left = 36, right = 10, top = 12, bottom = 28;
    var plotWidth = width - left - right, plotHeight = height - top - bottom;
    var values = series.map(function (item) { return item.success + item.failed; });
    var maxValue = Math.max.apply(null, [1].concat(values));
    var total = values.reduce(function (sum, value) { return sum + value; }, 0);

    for (var line = 0; line <= 4; line++) {
      var y = top + (plotHeight * line / 4);
      var labelValue = Math.round(maxValue * (1 - line / 4));
      chart.appendChild(svg('line', { x1: left, y1: y, x2: width - right, y2: y, stroke: '#29292d', 'stroke-width': 1 }));
      chart.appendChild(svg('text', { x: left - 7, y: y + 3, fill: '#747477', 'font-size': 9, 'text-anchor': 'end', 'font-family': 'ui-monospace, monospace' }, labelValue));
    }

    function pathFor(key) {
      return series.map(function (item, index) {
        var x = left + (series.length <= 1 ? 0 : plotWidth * index / (series.length - 1));
        var y = top + plotHeight - (Number(item[key]) / maxValue * plotHeight);
        return (index ? 'L' : 'M') + x.toFixed(2) + ' ' + y.toFixed(2);
      }).join(' ');
    }

    if (series.length) {
      chart.appendChild(svg('path', { d: pathFor('success'), fill: 'none', stroke: '#f5f5f3', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
      chart.appendChild(svg('path', { d: pathFor('failed'), fill: 'none', stroke: '#8c8c90', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' }));
      series.forEach(function (item, index) {
        if (!item.failed) return;
        var x = left + (series.length <= 1 ? 0 : plotWidth * index / (series.length - 1));
        var y = top + plotHeight - (Number(item.failed) / maxValue * plotHeight);
        chart.appendChild(svg('circle', { cx: x, cy: y, r: 2.5, fill: '#8c8c90' }));
      });
      [0, Math.floor((series.length - 1) / 2), series.length - 1].forEach(function (index) {
        if (index < 0 || !series[index]) return;
        var x = left + (series.length <= 1 ? 0 : plotWidth * index / (series.length - 1));
        chart.appendChild(svg('text', { x: x, y: height - 7, fill: '#747477', 'font-size': 9, 'text-anchor': index === 0 ? 'start' : (index === series.length - 1 ? 'end' : 'middle'), 'font-family': 'ui-monospace, monospace' }, localTime(series[index].timestamp).slice(0, 5)));
      });
    }
    elements.chartEmpty.classList.toggle('show', total === 0);
  }

  function renderModels(models) {
    elements.models.replaceChildren();
    if (!models.length) {
      var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'Waiting for model traffic.'; elements.models.appendChild(empty); return;
    }
    var maxRequests = Math.max.apply(null, models.map(function (item) { return item.requests; }));
    models.forEach(function (item) {
      var row = document.createElement('div'); row.className = 'model-row';
      var main = document.createElement('div'); main.className = 'model-main';
      var name = document.createElement('div'); name.className = 'model-name'; name.textContent = item.model; name.title = item.model;
      var bar = document.createElement('div'); bar.className = 'model-bar';
      var fill = document.createElement('span'); fill.style.width = Math.max(3, item.requests / maxRequests * 100) + '%';
      if (item.failed > 0) fill.style.background = '#8c8c90';
      bar.appendChild(fill); main.append(name, bar);
      var volume = document.createElement('div'); volume.className = 'model-stat'; volume.textContent = number(item.requests) + ' req';
      var rate = document.createElement('div'); rate.className = 'model-stat' + (item.success_rate !== null && item.success_rate < 95 ? ' bad' : ''); rate.textContent = item.success_rate === null ? '—' : item.success_rate.toFixed(1) + '%';
      var p95 = document.createElement('div'); p95.className = 'model-stat latency'; p95.textContent = latency(item.p95_latency_ms);
      row.append(main, volume, rate, p95); elements.models.appendChild(row);
    });
  }

  function renderErrors(errors) {
    elements.errors.replaceChildren();
    if (!errors.length) {
      var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No failures in range.'; elements.errors.appendChild(empty); return;
    }
    errors.forEach(function (item) {
      var row = document.createElement('div'); row.className = 'error-row';
      var name = document.createElement('span'); name.className = 'error-name'; name.textContent = item.type;
      var count = document.createElement('span'); count.className = 'error-count'; count.textContent = number(item.count);
      row.append(name, count); elements.errors.appendChild(row);
    });
  }

  function cell(row, text, className) {
    var td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = text;
    row.appendChild(td);
    return td;
  }

  function renderFailures(failures) {
    elements.failures.replaceChildren();
    if (!failures.length) {
      var row = document.createElement('tr');
      var td = document.createElement('td'); td.colSpan = 7;
      var empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = 'No failed or canceled requests.';
      td.appendChild(empty); row.appendChild(td); elements.failures.appendChild(row); return;
    }
    failures.forEach(function (item) {
      var row = document.createElement('tr');
      cell(row, localTime(item.timestamp));
      var requestCell = document.createElement('td'); var code = document.createElement('code'); code.textContent = item.request_id.slice(0, 8); code.title = item.request_id; requestCell.appendChild(code); row.appendChild(requestCell);
      cell(row, item.model);
      cell(row, item.stream ? 'stream' : 'sync');
      var statusCell = cell(row, String(item.status));
      var outcome = document.createElement('span'); outcome.className = 'outcome ' + item.outcome; outcome.textContent = item.outcome; statusCell.textContent = ''; statusCell.appendChild(outcome);
      cell(row, latency(item.duration_ms));
      cell(row, item.error_type || 'unknown');
      elements.failures.appendChild(row);
    });
  }

  function render(data) {
    renderMetrics(data);
    renderChart(data.series || []);
    renderModels(data.by_model || []);
    renderErrors(data.by_error || []);
    renderFailures(data.recent_failures || []);
    elements.updated.textContent = 'Updated ' + localTime(data.generated_at);
    elements.live.textContent = 'Live · 3s';
    elements.live.classList.add('on');
    elements.error.classList.remove('show');
  }

  async function refresh() {
    if (loading) return;
    loading = true; elements.refresh.disabled = true;
    try {
      var response = await fetch('/ui/telemetry/data?window=' + encodeURIComponent(elements.select.value), { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      render(await response.json());
    } catch (error) {
      elements.live.textContent = 'Disconnected'; elements.live.classList.remove('on');
      elements.error.textContent = 'Telemetry unavailable: ' + error.message;
      elements.error.classList.add('show');
    } finally {
      loading = false; elements.refresh.disabled = false;
    }
  }

  elements.select.addEventListener('change', refresh);
  elements.refresh.addEventListener('click', refresh);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
  refresh();
  refreshTimer = setInterval(function () { if (!document.hidden) refresh(); }, 3000);
  window.addEventListener('pagehide', function () { clearInterval(refreshTimer); }, { once: true });
}());
`;

export function renderTelemetryPage() {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Request telemetry</title>
<style>${THEME_CSS}${TELEMETRY_CSS}</style>
</head>
<body>
${TELEMETRY_BODY}
<script>${TELEMETRY_SCRIPT}</script>
</body>
</html>`;
}

export default renderTelemetryPage;

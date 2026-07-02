// Fixmart Sales Orders — charts tab

const $ = id => document.getElementById(id);
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtGBP = n => (n == null ? '—' : '£' + Math.round(n).toLocaleString('en-GB'));
function shortGBP(n) { if (n == null) return '—'; const a = Math.abs(n); if (a >= 1e6) return '£' + (n / 1e6).toFixed(2) + 'm'; if (a >= 1e3) return '£' + Math.round(n / 1e3) + 'k'; return '£' + Math.round(n); }
function shortNum(n) { if (n == null) return '—'; const a = Math.abs(n); if (a >= 1e6) return (n / 1e6).toFixed(2) + 'm'; if (a >= 1e3) return Math.round(n / 1e3) + 'k'; return Math.round(n).toString(); }
const pctDelta = (cy, py) => (py ? Math.round(((cy - py) / py) * 1000) / 10 : null);

// ── State / nav ────────────────────────────────────────────────────────────────
let SMOOTH = false;
function persist() { FilterState.set({ from: $('date-from').value, to: $('date-to').value, rep: $('rep-select').value, smooth: SMOOTH }); syncNav(); }
function syncNav() { const t = $('nav-table'); if (t) t.href = FilterState.href('/index.html');
  const g = $('nav-germany'); if (g) g.href = FilterState.href('/germany.html'); const c = $('nav-charts'); if (c) c.href = FilterState.href('/charts.html'); }
function clearPresets() { document.querySelectorAll('.toggle:first-of-type .toggle-btn, #preset-mtd, #preset-ytd').forEach(b => b.classList.remove('active')); }
function setMTD() { clearPresets(); $('preset-mtd').classList.add('active'); const m = FilterState.mtd(); $('date-from').value = m.from; $('date-to').value = m.to; persist(); loadCharts(); }
function setYTD() { clearPresets(); $('preset-ytd').classList.add('active'); const n = new Date(); $('date-from').value = iso(new Date(n.getFullYear(), 0, 1)); $('date-to').value = iso(n); persist(); loadCharts(); }
function setPreset(w) { clearPresets(); document.querySelectorAll('.toggle-btn').forEach(b => { if (b.textContent.trim() === w + 'w') b.classList.add('active'); }); const n = new Date(); const s = new Date(n); s.setDate(n.getDate() - w * 7); $('date-from').value = iso(s); $('date-to').value = iso(n); persist(); loadCharts(); }
function onDateChange() { clearPresets(); persist(); loadCharts(); }
function onRepChange() { persist(); loadCharts(); }
function toggleSmooth() { SMOOTH = !SMOOTH; const b = $('smooth-btn'); b.textContent = SMOOTH ? 'On' : 'Off'; b.classList.toggle('active', SMOOTH); persist(); loadCharts(); }

// ── Maths ───────────────────────────────────────────────────────────────────────
function rolling(vals, w) {
  if (!w || w < 2) return vals.slice();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    let s = 0, c = 0;
    for (let k = Math.max(0, i - w + 1); k <= i; k++) { if (vals[k] != null) { s += vals[k]; c++; } }
    out.push(c ? s / c : null);
  }
  return out;
}

// ── Chart primitives (Tufte: zero baseline, one max gridline, direct labels) ─────
const W = 620, H = 230, PADT = 16, PADB = 24;
function xLabels(dates, x) {
  const idx = [0, Math.floor((dates.length - 1) / 2), dates.length - 1].filter((v, i, a) => a.indexOf(v) === i);
  return idx.map(i => { const p = dates[i].split('-'); return `<text x="${x(i).toFixed(1)}" y="${H - 6}" font-size="10" fill="#999" text-anchor="middle" font-family="'DM Mono',monospace">${p[2]}/${p[1]}</text>`; }).join('');
}
function pathFrom(arr, x, y) {
  let d = '', started = false;
  arr.forEach((v, i) => { if (v == null) { started = false; return; } d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `; started = true; });
  return d.trim();
}

// CY vs PY single-axis line chart
function yoyChart(dates, cy, pyByMD, fmtShort, colorCY) {
  const padL = 8, padR = 42;
  const n = dates.length;
  const pyA = dates.map(d => { const md = d.slice(5); return pyByMD.has(md) ? pyByMD.get(md) : null; });
  let cyP = cy.slice(), pyP = pyA.slice();
  if (SMOOTH) { cyP = rolling(cyP, 7); pyP = rolling(pyP, 7); }
  const vals = cyP.concat(pyP).filter(v => v != null).map(Number);
  const max = Math.max(...vals, 1);
  const x = i => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const y = v => H - PADB - (v / max) * (H - PADT - PADB);
  const zeroY = (H - PADB).toFixed(1);
  const cyYearL = dates.length ? dates[dates.length - 1].slice(0, 4) : '';
  const pyYearL = cyYearL ? String(Number(cyYearL) - 1) : '';
  const lastCyI = cyP.reduce((acc, v, i) => v != null ? i : acc, 0);
  const lastPyI = pyP.reduce((acc, v, i) => v != null ? i : acc, 0);
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="#e6e6e6" stroke-width="1"/>
    <line x1="${padL}" y1="${y(max).toFixed(1)}" x2="${W - padR}" y2="${y(max).toFixed(1)}" stroke="#f0f0f0" stroke-width="1"/>
    <text x="${padL}" y="${(y(max) - 3).toFixed(1)}" font-size="10" fill="#bbb" font-family="'DM Mono',monospace">${fmtShort(max)}</text>
    <path d="${pathFrom(pyP, x, y)}" fill="none" stroke="#b3b3b3" stroke-width="1.4"/>
    <path d="${pathFrom(cyP, x, y)}" fill="none" stroke="${colorCY}" stroke-width="2"/>
    ${cyP[lastCyI] != null ? `<text x="${(x(lastCyI) + 4).toFixed(1)}" y="${(y(cyP[lastCyI]) + 3).toFixed(1)}" font-size="10" fill="${colorCY}" font-weight="700" font-family="'Barlow Condensed',sans-serif">${cyYearL}</text>` : ''}
    ${pyP[lastPyI] != null ? `<text x="${(x(lastPyI) + 4).toFixed(1)}" y="${(y(pyP[lastPyI]) + 3).toFixed(1)}" font-size="10" fill="#9a9a9a" font-weight="700" font-family="'Barlow Condensed',sans-serif">${pyYearL}</text>` : ''}
    ${xLabels(dates, x)}
  </svg>`;
}

// Value vs Units dual axis (sales £ left, units right)
function dualChart(dates, sales, units) {
  const padL = 8, padR = 8;
  const n = dates.length;
  let s = sales.slice(), u = units.slice();
  if (SMOOTH) { s = rolling(s, 7); u = rolling(u, 7); }
  const maxS = Math.max(...s.filter(v => v != null), 1);
  const maxU = Math.max(...u.filter(v => v != null), 1);
  const x = i => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const yS = v => H - PADB - (v / maxS) * (H - PADT - PADB);
  const yU = v => H - PADB - (v / maxU) * (H - PADT - PADB);
  const zeroY = (H - PADB).toFixed(1);
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="#e6e6e6" stroke-width="1"/>
    <text x="${padL}" y="12" font-size="10" fill="#9ACD00" font-family="'DM Mono',monospace">£ ${shortGBP(maxS).replace('£','')}</text>
    <text x="${W - padR}" y="12" font-size="10" fill="#3a3a3a" text-anchor="end" font-family="'DM Mono',monospace">${shortNum(maxU)} u</text>
    <path d="${pathFrom(u, x, yU)}" fill="none" stroke="#3a3a3a" stroke-width="1.6"/>
    <path d="${pathFrom(s, x, yS)}" fill="none" stroke="#9ACD00" stroke-width="2"/>
    ${xLabels(dates, x)}
  </svg>`;
}

function card(title, headlineHTML, svg, legendHTML) {
  return `<div class="chart-card">
    <div class="chart-head"><div class="chart-title">${title}</div><div class="chart-headline">${headlineHTML}</div></div>
    ${svg}${legendHTML || ''}</div>`;
}
function yoyHeadline(cyTot, pyTot, fmt) {
  const d = pctDelta(cyTot, pyTot);
  const cls = d == null ? '' : (d >= 0 ? 'up' : 'down');
  const arrow = d == null ? '' : (d >= 0 ? '▲' : '▼');
  return `<span class="cy">${fmt(cyTot)}</span> &nbsp; <span class="${cls}">${d == null ? '' : arrow + ' ' + Math.abs(d) + '% vs PY'}</span>`;
}
const legendYoY = (cyYear, pyYear) => `<div class="legend"><span><i style="background:#9ACD00"></i>${cyYear}</span><span><i style="background:#b3b3b3"></i>${pyYear}</span></div>`;

// ── Load ─────────────────────────────────────────────────────────────────────────
async function loadCharts() {
  const from = $('date-from').value, to = $('date-to').value, rep = $('rep-select').value;
  if (!from || !to) return;
  $('content').innerHTML = '<div class="loading"><div class="spinner"></div> Loading from BigQuery…</div>';
  try {
    const r = await fetch(`/api/daily?startDate=${from}&endDate=${to}&rep=${encodeURIComponent(rep)}&compare=1`);
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Query failed');

    const cyRows = (j.rows || []).filter(x => Number(x.orders) > 1);
    const pyRows = (j.pyRows || []);
    const dates = cyRows.map(x => x.order_date);
    const cyYear = dates.length ? dates[dates.length - 1].slice(0, 4) : '';
    const pyYear = cyYear ? String(Number(cyYear) - 1) : '';

    const byMD = (rows, field) => { const m = new Map(); rows.forEach(x => m.set(x.order_date.slice(5), Number(x[field]) || 0)); return m; };
    const col = f => cyRows.map(x => Number(x[f]) || 0);

    const t = j.totals || {}, pt = j.pyTotals || {};

    const panels = [
      card('Sales', yoyHeadline(t.sales, pt.sales, shortGBP),
        yoyChart(dates, col('sales'), byMD(pyRows, 'sales'), shortGBP, '#9ACD00'), legendYoY(cyYear, pyYear)),
      card('Value vs Units',
        `<span class="cy">${shortGBP(t.sales)}</span> &nbsp; <span style="color:#3a3a3a">${shortNum(t.units)} u</span>`,
        dualChart(dates, col('sales'), col('units')),
        `<div class="legend"><span><i style="background:#9ACD00"></i>Sales £ (L)</span><span><i style="background:#3a3a3a"></i>Units (R)</span></div>`),
      card('Gross Profit', yoyHeadline(t.gp, pt.gp, shortGBP),
        yoyChart(dates, col('gp'), byMD(pyRows, 'gp'), shortGBP, '#9ACD00'), legendYoY(cyYear, pyYear)),
      card('GP %',
        `<span class="cy">${t.gp_pct == null ? '—' : t.gp_pct.toFixed(1) + '%'}</span> &nbsp; <span style="color:#999">PY ${pt.gp_pct == null ? '—' : pt.gp_pct.toFixed(1) + '%'}</span>`,
        yoyChart(dates, col('gp_pct'), byMD(pyRows, 'gp_pct'), v => v.toFixed(0) + '%', '#9ACD00'), legendYoY(cyYear, pyYear))
    ];
    $('content').innerHTML = `<div class="chart-grid">${panels.join('')}</div>`;
  } catch (e) {
    $('content').innerHTML = `<div class="err">Error: ${e.message}</div>`;
  }
}

async function loadReps() {
  try { const r = await fetch('/api/reps'); const j = await r.json(); if (!j.success) return;
    const sel = $('rep-select'); j.reps.forEach(rep => { const o = document.createElement('option'); o.value = rep; o.textContent = rep; sel.appendChild(o); });
    sel.value = FilterState.get().rep;
  } catch (e) {}
}
async function loadFreshness() {
  try { const r = await fetch('/api/freshness'); const j = await r.json();
    if (j.success && j.last_load) { const d = new Date(j.last_load); $('freshness').textContent = 'Data as of ' + d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }); }
    else { $('freshness').textContent = ''; }
  } catch (e) { $('freshness').textContent = ''; }
}

(async function init() {
  const s = FilterState.get();
  $('date-from').value = s.from; $('date-to').value = s.to;
  SMOOTH = !!s.smooth; if (SMOOTH) { $('smooth-btn').textContent = 'On'; $('smooth-btn').classList.add('active'); }
  await loadReps();
  clearPresets();
  if (FilterState.isMTD()) $('preset-mtd').classList.add('active');
  syncNav();
  loadFreshness();
  loadCharts();
})();

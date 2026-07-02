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
  const g = $('nav-germany'); if (g) g.href = FilterState.href('/germany.html');
  const b = $('nav-combined'); if (b) b.href = FilterState.href('/combined.html'); const c = $('nav-charts'); if (c) c.href = FilterState.href('/charts.html'); }
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

// ── Chart primitives (Tufte: labelled gridlines, monthly x-ticks) ────────────────
const W = 620, H = 230, PADT = 16, PADB = 26;
const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

// Monthly x-axis ticks (month abbrev; year shown on January). Short ranges (<40
// days) fall back to ~5 evenly spaced dd/mm labels so it never crowds.
function xLabels(dates, x, padL) {
  if (!dates.length) return '';
  const out = [];
  if (dates.length < 40) {
    const n = Math.min(5, dates.length);
    for (let k = 0; k < n; k++) {
      const i = Math.round(k * (dates.length - 1) / (n - 1 || 1));
      const p = dates[i].split('-');
      out.push(`<text x="${x(i).toFixed(1)}" y="${H - 7}" font-size="10" fill="#999" text-anchor="middle" font-family="'DM Mono',monospace">${p[2]}/${p[1]}</text>`);
    }
  } else {
    let last = '';
    dates.forEach((d, i) => {
      const parts = d.split('-');
      const key = parts[0] + '-' + parts[1];
      if (key !== last) {
        last = key;
        const label = parts[1] === '01' ? `${MON[0]} ${parts[0]}` : MON[Number(parts[1]) - 1];
        out.push(`<line x1="${x(i).toFixed(1)}" y1="${H - PADB}" x2="${x(i).toFixed(1)}" y2="${H - PADB + 3}" stroke="#ccc" stroke-width="1"/>`);
        out.push(`<text x="${x(i).toFixed(1)}" y="${H - 7}" font-size="9.5" fill="#999" text-anchor="middle" font-family="'DM Mono',monospace">${label}</text>`);
      }
    });
  }
  return out.join('');
}

// Round tick values spanning [min,max].
function niceTicks(min, max, count) {
  const span = (max - min) || 1;
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 5 : norm >= 2 ? 2 : 1) * mag;
  const ticks = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-6; v += step) ticks.push(v);
  return ticks;
}

function pathFrom(arr, x, y) {
  let d = '', started = false;
  arr.forEach((v, i) => { if (v == null) { started = false; return; } d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `; started = true; });
  return d.trim();
}

// CY vs PY single-axis line chart. opts { yMin, yMax, ticks } fixes the band
// (used for GP% at 25-55, values clamped to the band); otherwise anchored at
// zero with the top at the data max.
function yoyChart(dates, cy, pyByMD, fmtShort, colorCY, opts) {
  opts = opts || {};
  const padL = 40, padR = 42;
  const n = dates.length;
  const pyA = dates.map(d => { const md = d.slice(5); return pyByMD.has(md) ? pyByMD.get(md) : null; });
  let cyP = cy.slice(), pyP = pyA.slice();
  if (SMOOTH) { cyP = rolling(cyP, 7); pyP = rolling(pyP, 7); }
  const dataMax = Math.max(...cyP.concat(pyP).filter(v => v != null).map(Number), 1);
  const yMin = opts.yMin != null ? opts.yMin : 0;
  const yMax = opts.yMax != null ? opts.yMax : dataMax * 1.05;
  const fixed = opts.yMin != null || opts.yMax != null;
  if (fixed) {
    const clamp = v => v == null ? null : Math.max(yMin, Math.min(yMax, v));
    cyP = cyP.map(clamp); pyP = pyP.map(clamp);
  }
  const x = i => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const y = v => H - PADB - ((v - yMin) / (yMax - yMin)) * (H - PADT - PADB);
  const ticks = opts.ticks || niceTicks(yMin, yMax, 4);
  const grid = ticks.map(tv => `<line x1="${padL}" y1="${y(tv).toFixed(1)}" x2="${W - padR}" y2="${y(tv).toFixed(1)}" stroke="#f0f0f0" stroke-width="1"/><text x="${padL - 5}" y="${(y(tv) + 3).toFixed(1)}" font-size="9.5" fill="#bbb" text-anchor="end" font-family="'DM Mono',monospace">${fmtShort(tv)}</text>`).join('');
  const cyYearL = dates.length ? dates[dates.length - 1].slice(0, 4) : '';
  const pyYearL = cyYearL ? String(Number(cyYearL) - 1) : '';
  const lastCyI = cyP.reduce((acc, v, i) => v != null ? i : acc, 0);
  const lastPyI = pyP.reduce((acc, v, i) => v != null ? i : acc, 0);
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${grid}
    <path d="${pathFrom(pyP, x, y)}" fill="none" stroke="#b3b3b3" stroke-width="1.4"/>
    <path d="${pathFrom(cyP, x, y)}" fill="none" stroke="${colorCY}" stroke-width="2"/>
    ${cyP[lastCyI] != null ? `<text x="${(x(lastCyI) + 4).toFixed(1)}" y="${(y(cyP[lastCyI]) + 3).toFixed(1)}" font-size="10" fill="${colorCY}" font-weight="700" font-family="'Barlow Condensed',sans-serif">${cyYearL}</text>` : ''}
    ${pyP[lastPyI] != null ? `<text x="${(x(lastPyI) + 4).toFixed(1)}" y="${(y(pyP[lastPyI]) + 3).toFixed(1)}" font-size="10" fill="#9a9a9a" font-weight="700" font-family="'Barlow Condensed',sans-serif">${pyYearL}</text>` : ''}
    ${xLabels(dates, x, padL)}
  </svg>`;
}

// Value vs Units dual axis: sales £ on the left (with gridlines), units on the right.
function dualChart(dates, sales, units) {
  const padL = 40, padR = 42;
  const n = dates.length;
  let s = sales.slice(), u = units.slice();
  if (SMOOTH) { s = rolling(s, 7); u = rolling(u, 7); }
  const maxS = Math.max(...s.filter(v => v != null), 1) * 1.05;
  const maxU = Math.max(...u.filter(v => v != null), 1) * 1.05;
  const x = i => padL + (n <= 1 ? 0 : (i / (n - 1)) * (W - padL - padR));
  const yS = v => H - PADB - (v / maxS) * (H - PADT - PADB);
  const yU = v => H - PADB - (v / maxU) * (H - PADT - PADB);
  const grid = niceTicks(0, maxS, 4).map(tv => `<line x1="${padL}" y1="${yS(tv).toFixed(1)}" x2="${W - padR}" y2="${yS(tv).toFixed(1)}" stroke="#f0f0f0" stroke-width="1"/><text x="${padL - 5}" y="${(yS(tv) + 3).toFixed(1)}" font-size="9.5" fill="#9ACD00" text-anchor="end" font-family="'DM Mono',monospace">${shortGBP(tv).replace('£','')}</text>`).join('');
  const uLabels = niceTicks(0, maxU, 4).map(tv => `<text x="${W - padR + 4}" y="${(yU(tv) + 3).toFixed(1)}" font-size="9.5" fill="#3a3a3a" font-family="'DM Mono',monospace">${shortNum(tv)}</text>`).join('');
  return `<svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    ${grid}${uLabels}
    <text x="${padL - 5}" y="11" font-size="9" fill="#9ACD00" text-anchor="end" font-family="'DM Mono',monospace">£</text>
    <text x="${W - padR + 4}" y="11" font-size="9" fill="#3a3a3a" font-family="'DM Mono',monospace">u</text>
    <path d="${pathFrom(u, x, yU)}" fill="none" stroke="#3a3a3a" stroke-width="1.6"/>
    <path d="${pathFrom(s, x, yS)}" fill="none" stroke="#9ACD00" stroke-width="2"/>
    ${xLabels(dates, x, padL)}
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
        yoyChart(dates, col('gp_pct'), byMD(pyRows, 'gp_pct'), v => v.toFixed(0) + '%', '#9ACD00', { yMin: 25, yMax: 55, ticks: [25, 35, 45, 55] }), legendYoY(cyYear, pyYear))
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

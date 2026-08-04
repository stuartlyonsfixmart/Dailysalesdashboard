// Fixmart Sales Orders — Combined (UK + GmbH) tab.
// UK sales/GP, Germany sales/GP, and the combined sales/GP/GP% per day.

const $ = id => document.getElementById(id);
const fmtGBP = n => (n == null ? '—' : '£' + Math.round(n).toLocaleString('en-GB'));
const fmtPct = n => (n == null ? '—' : Number(n).toFixed(1) + '%');
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function shortGBP(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return '£' + (n / 1e6).toFixed(2) + 'm';
  if (a >= 1e3) return '£' + Math.round(n / 1e3) + 'k';
  return '£' + Math.round(n);
}

// ── State / nav ────────────────────────────────────────────────────────────────
function syncNav() {
  const t = $('nav-table'); if (t) t.href = FilterState.href('/index.html');
  const g = $('nav-germany'); if (g) g.href = FilterState.href('/germany.html');
  const b = $('nav-combined'); if (b) b.href = FilterState.href('/combined.html');
}
// One control: the month. A past month runs 1st to last day; the current month
// runs 1st to today.
function rangeForMonth(v) {
  const [y, m] = v.split('-').map(Number);
  const lastDom = new Date(y, m, 0).getDate();
  const last = `${v}-${String(lastDom).padStart(2, '0')}`;
  const todayStr = iso(new Date());
  return { from: `${v}-01`, to: last > todayStr ? todayStr : last };
}
function onMonthChange() {
  const v = $('month-select').value;
  if (!v) return;
  FilterState.set(rangeForMonth(v));
  syncNav(); load();
}

// ── Sparklines ──────────────────────────────────────────────────────────────────
function sparkline(values) {
  const W = 220, H = 46, pad = 2;
  const vals = values.map(v => Number(v) || 0);
  if (!vals.length) return '';
  const max = Math.max(...vals, 1), min = Math.min(...vals, 0), range = max - min || 1;
  const stepX = (W - pad * 2) / Math.max(vals.length - 1, 1);
  const y = v => H - pad - ((v - min) / range) * (H - pad * 2);
  const pts = vals.map((v, i) => `${(pad + i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zeroY = y(0).toFixed(1);
  const lastX = (pad + (vals.length - 1) * stepX).toFixed(1), lastY = y(vals[vals.length - 1]).toFixed(1);
  return `<svg class="spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="#e0e0e0" stroke-width="1"/>
    <polyline fill="none" stroke="#9ACD00" stroke-width="1.6" points="${pts}"/>
    <circle cx="${lastX}" cy="${lastY}" r="2.2" fill="#9ACD00"/></svg>`;
}
function workingDaysCard(wd, note) {
  if (!wd) return '';
  const pct = wd.total ? Math.round((wd.elapsed / wd.total) * 100) : 0;
  const parts = wd.month.split('-');
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(parts[1]) - 1];
  return `<div class="spark-card">
    <div class="spark-title">Working Days · ${mon} ${parts[0]}</div>
    <div class="spark-val">${wd.elapsed} <small>/ ${wd.total}</small></div>
    <div style="font-size:10px;color:var(--muted);margin-top:4px;">elapsed / total · ${note}</div>
    <div style="margin-top:8px;height:6px;background:#ececec;border-radius:3px;overflow:hidden;">
      <div style="height:100%;width:${pct}%;background:#9ACD00;"></div>
    </div>
  </div>`;
}
function renderSparks(rows, totals, wd) {
  const d = rows;
  const cards = [
    { t: 'Combined Sales', v: shortGBP(totals.sales), s: d.map(r => Number(r.sales) || 0) },
    { t: 'Combined GP', v: shortGBP(totals.gp) + ' <small>' + fmtPct(totals.gp_pct) + '</small>', s: d.map(r => Number(r.gp) || 0) }
  ];
  $('sparks').innerHTML = workingDaysCard(wd, 'excl. E&W bank hols') + cards.map(c => `
    <div class="spark-card"><div class="spark-title">${c.t}</div>
      <div class="spark-val">${c.v}</div>${sparkline(c.s)}</div>`).join('');
}

function renderWarnings(zeroDays) {
  const el = $('warnings');
  if (!el) return;
  if (!zeroDays.length) { el.innerHTML = ''; el.style.display = 'none'; return; }
  const shown = zeroDays.map(d => { const p = d.split('-'); return p[2] + '/' + p[1]; });
  const label = shown.length === 1 ? 'weekday has' : 'weekdays have';
  el.innerHTML = '<strong>Data may be incomplete.</strong> ' + shown.length + ' ' + label +
    ' zero sales (' + shown.join(', ') + '). A trading day with no sales usually means that day did not load.';
  el.style.display = 'block';
}

// ── Table ──────────────────────────────────────────────────────────────────────
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const fmtDate = s => { const p = s.split('-'); return `${p[2]}/${p[1]}/${p[0]}`; };

function renderTable(rows, totals, zeroDays) {
  const zero = new Set(zeroDays || []);
  if (!rows.length) { $('content').innerHTML = '<div class="err">No sales in this range.</div>'; return; }
  const body = rows.map(r => {
    const dow = new Date(r.order_date + 'T00:00:00').getDay();
    const weekend = (dow === 0 || dow === 6) ? ' weekend' : '';
    const missing = zero.has(r.order_date) ? ' missing-day' : '';
    return `<tr class="${weekend}${missing}">
      <td class="date">${fmtDate(r.order_date)} <span class="dow">${DOW[dow]}</span></td>
      <td class="right mono">${fmtGBP(r.uk_sales)}</td>
      <td class="right mono">${fmtGBP(r.uk_gp)}</td>
      <td class="right mono sep">${fmtGBP(r.de_sales)}</td>
      <td class="right mono">${fmtGBP(r.de_gp)}</td>
      <td class="right mono sep">${fmtGBP(r.sales)}</td>
      <td class="right mono">${fmtGBP(r.gp)}</td>
      <td class="right mono">${fmtPct(r.gp_pct)}</td></tr>`;
  }).join('');
  $('content').innerHTML = `<div class="table-scroll"><table class="data-table">
    <thead>
      <tr class="grp-row">
        <th rowspan="2">Date</th>
        <th colspan="2" class="grp">UK</th>
        <th colspan="2" class="grp sep">Germany (GmbH)</th>
        <th colspan="3" class="grp sep">Combined</th>
      </tr>
      <tr>
        <th class="right">Sales</th><th class="right">GP</th>
        <th class="right sep">Sales</th><th class="right">GP</th>
        <th class="right sep">Sales</th><th class="right">GP</th><th class="right">GP %</th>
      </tr>
    </thead>
    <tbody>${body}</tbody>
    <tfoot><tr class="total-row"><td>Total</td>
      <td class="right">${fmtGBP(totals.uk_sales)}</td><td class="right">${fmtGBP(totals.uk_gp)}</td>
      <td class="right sep">${fmtGBP(totals.de_sales)}</td><td class="right">${fmtGBP(totals.de_gp)}</td>
      <td class="right lime sep">${fmtGBP(totals.sales)}</td><td class="right lime">${fmtGBP(totals.gp)}</td>
      <td class="right lime">${fmtPct(totals.gp_pct)}</td></tr></tfoot></table></div>`;
}

async function load() {
  const s = FilterState.get();
  const from = s.from, to = s.to;
  if (!from || !to) return;
  $('content').innerHTML = '<div class="loading"><div class="spinner"></div> Loading from BigQuery…</div>';
  $('table-count').textContent = 'Loading…';
  try {
    const r = await fetch(`/api/combined?startDate=${from}&endDate=${to}`);
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Query failed');
    renderSparks(j.rows, j.totals, j.workingDays);
    renderWarnings(j.zeroWeekdays || []);
    renderTable(j.rows, j.totals, j.zeroWeekdays || []);
    $('table-count').textContent = `${j.rows.length} days · UK + GmbH`;
  } catch (e) {
    $('content').innerHTML = `<div class="err">Error: ${e.message}</div>`;
    $('table-count').textContent = 'Error';
  }
}

async function loadFreshness() {
  try {
    const r = await fetch('/api/freshness'); const j = await r.json();
    if (j.success && j.last_load) {
      const d = new Date(j.last_load);
      $('freshness').textContent = 'Data as of ' + d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    } else { $('freshness').textContent = ''; }
  } catch (e) { $('freshness').textContent = ''; }
}

(async function init() {
  const s = FilterState.get();
  const ms = $('month-select');
  ms.max = iso(new Date()).slice(0, 7); // no future months
  ms.value = s.from.slice(0, 7);
  syncNav();
  loadFreshness();
  load();
})();

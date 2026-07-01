// Fixmart Sales Orders — client

const $ = id => document.getElementById(id);
const fmtInt = n => (n == null ? '—' : Math.round(n).toLocaleString('en-GB'));
const fmtGBP = n => (n == null ? '—' : '£' + Math.round(n).toLocaleString('en-GB'));
const fmtPct = n => (n == null ? '—' : Number(n).toFixed(1) + '%');
const iso = d => d.toISOString().slice(0, 10);

function shortGBP(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return '£' + (n / 1e6).toFixed(2) + 'm';
  if (a >= 1e3) return '£' + Math.round(n / 1e3) + 'k';
  return '£' + Math.round(n);
}
function shortNum(n) {
  if (n == null) return '—';
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'm';
  if (a >= 1e3) return Math.round(n / 1e3) + 'k';
  return Math.round(n).toString();
}

// ── Date controls ─────────────────────────────────────────────────────────────
function clearPresets() { document.querySelectorAll('.toggle-btn').forEach(b => b.classList.remove('active')); }

function setMTD() {
  clearPresets(); $('preset-mtd').classList.add('active');
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  $('date-from').value = iso(first); $('date-to').value = iso(now);
  load();
}
function setYTD() {
  clearPresets(); $('preset-ytd').classList.add('active');
  const now = new Date();
  const first = new Date(now.getFullYear(), 0, 1);
  $('date-from').value = iso(first); $('date-to').value = iso(now);
  load();
}
function setPreset(weeks) {
  clearPresets();
  document.querySelectorAll('.toggle-btn').forEach(b => { if (b.textContent.trim() === weeks + 'w') b.classList.add('active'); });
  const now = new Date();
  const start = new Date(now); start.setDate(now.getDate() - weeks * 7);
  $('date-from').value = iso(start); $('date-to').value = iso(now);
  load();
}
function onDateChange() { clearPresets(); load(); }

// ── Sparkline (Tufte small multiple: zero baseline, grey axis, lime line) ──────
function sparkline(values) {
  const W = 220, H = 46, pad = 2;
  const vals = values.map(v => Number(v) || 0);
  if (!vals.length) return '';
  const max = Math.max(...vals, 1);
  const min = Math.min(...vals, 0);
  const range = max - min || 1;
  const stepX = (W - pad * 2) / Math.max(vals.length - 1, 1);
  const y = v => H - pad - ((v - min) / range) * (H - pad * 2);
  const pts = vals.map((v, i) => `${(pad + i * stepX).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const zeroY = y(0).toFixed(1);
  const lastX = (pad + (vals.length - 1) * stepX).toFixed(1);
  const lastY = y(vals[vals.length - 1]).toFixed(1);
  return `<svg class="spark-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
    <line x1="0" y1="${zeroY}" x2="${W}" y2="${zeroY}" stroke="#e0e0e0" stroke-width="1"/>
    <polyline fill="none" stroke="#9ACD00" stroke-width="1.6" points="${pts}"/>
    <circle cx="${lastX}" cy="${lastY}" r="2.2" fill="#9ACD00"/>
  </svg>`;
}

function renderSparks(rows, totals) {
  const dailyRows = rows.filter(r => Number(r.orders) > 1); // drop the stray weekend singletons from the shape
  const series = {
    sales: dailyRows.map(r => Number(r.sales) || 0),
    gp: dailyRows.map(r => Number(r.gp) || 0),
    units: dailyRows.map(r => Number(r.units) || 0),
    weight: dailyRows.map(r => Number(r.weight_kg) || 0)
  };
  const cards = [
    { t: 'Sales', v: shortGBP(totals.sales), s: series.sales },
    { t: 'Gross Profit', v: shortGBP(totals.gp) + ' <small>' + fmtPct(totals.gp_pct) + '</small>', s: series.gp },
    { t: 'Units', v: shortNum(totals.units), s: series.units },
    { t: 'Weight', v: shortNum(totals.weight_kg) + ' <small>kg</small>', s: series.weight }
  ];
  $('sparks').innerHTML = cards.map(c => `
    <div class="spark-card">
      <div class="spark-title">${c.t}</div>
      <div class="spark-val">${c.v}</div>
      ${sparkline(c.s)}
    </div>`).join('');
}

// ── Table ─────────────────────────────────────────────────────────────────────
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
function fmtDate(isoStr) {
  const p = isoStr.split('-');
  return `${p[2]}/${p[1]}/${p[0]}`;
}

function renderTable(rows, totals) {
  if (!rows.length) {
    $('content').innerHTML = '<div class="err">No orders in this range.</div>';
    return;
  }
  const body = rows.map(r => {
    const d = new Date(r.order_date + 'T00:00:00');
    const dow = d.getDay();
    const weekend = (dow === 0 || dow === 6) ? ' weekend' : '';
    return `<tr class="${weekend}">
      <td class="date">${fmtDate(r.order_date)} <span class="dow">${DOW[dow]}</span></td>
      <td class="right mono">${fmtInt(r.orders)}</td>
      <td class="right mono">${fmtInt(r.order_lines)}</td>
      <td class="right mono">${fmtInt(r.units)}</td>
      <td class="right mono">${fmtInt(r.weight_kg)}</td>
      <td class="right mono">${fmtGBP(r.sales)}</td>
      <td class="right mono">${fmtGBP(r.gp)}</td>
      <td class="right mono">${fmtPct(r.gp_pct)}</td>
    </tr>`;
  }).join('');

  $('content').innerHTML = `
    <div class="table-scroll">
      <table class="data-table">
        <thead>
          <tr>
            <th>Date</th>
            <th class="right">Orders</th>
            <th class="right">Order Lines</th>
            <th class="right">Units</th>
            <th class="right">Weight kg</th>
            <th class="right">Sales</th>
            <th class="right">GP</th>
            <th class="right">GP %</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
        <tfoot>
          <tr class="total-row">
            <td>Total</td>
            <td class="right">${fmtInt(totals.orders)}</td>
            <td class="right">${fmtInt(totals.order_lines)}</td>
            <td class="right">${fmtInt(totals.units)}</td>
            <td class="right">${fmtInt(totals.weight_kg)}</td>
            <td class="right lime">${fmtGBP(totals.sales)}</td>
            <td class="right lime">${fmtGBP(totals.gp)}</td>
            <td class="right lime">${fmtPct(totals.gp_pct)}</td>
          </tr>
        </tfoot>
      </table>
    </div>`;
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function load() {
  const from = $('date-from').value, to = $('date-to').value;
  const rep = $('rep-select').value;
  if (!from || !to) return;
  $('content').innerHTML = '<div class="loading"><div class="spinner"></div> Loading from BigQuery…</div>';
  $('table-count').textContent = 'Loading…';
  try {
    const r = await fetch(`/api/daily?startDate=${from}&endDate=${to}&rep=${encodeURIComponent(rep)}`);
    const j = await r.json();
    if (!j.success) throw new Error(j.error || 'Query failed');
    renderSparks(j.rows, j.totals);
    renderTable(j.rows, j.totals);
    const repLabel = rep === 'all' ? 'all reps' : rep;
    $('table-count').textContent = `${j.rows.length} days · ${repLabel}`;
  } catch (e) {
    $('content').innerHTML = `<div class="err">Error: ${e.message}</div>`;
    $('table-count').textContent = 'Error';
  }
}

async function loadReps() {
  try {
    const r = await fetch('/api/reps');
    const j = await r.json();
    if (!j.success) return;
    const sel = $('rep-select');
    j.reps.forEach(rep => {
      const o = document.createElement('option');
      o.value = rep; o.textContent = rep;
      sel.appendChild(o);
    });
  } catch (e) { /* dropdown stays at All */ }
}

async function loadFreshness() {
  try {
    const r = await fetch('/api/freshness');
    const j = await r.json();
    if (j.success && j.last_load) {
      const d = new Date(j.last_load);
      $('freshness').textContent = 'Data as of ' + d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    } else { $('freshness').textContent = ''; }
  } catch (e) { $('freshness').textContent = ''; }
}

// init
loadReps();
loadFreshness();
setMTD();

// Fixmart Sales Orders Board — Cloud Run Server
// Orders taken (by order date), OrderWise. GP is order-book basis and will read
// below the management accounts because of the sleeve — this is expected.

const express = require('express');
const session = require('express-session');
const { BigQuery } = require('@google-cloud/bigquery');
const NodeCache = require('node-cache');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);
app.use(session({
  secret: process.env.SESSION_SECRET || 'fixmart-sales-orders-2026',
  resave: true,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000, secure: false, sameSite: 'lax' }
}));

const USERS = {
  fixmart: { password: 'tothemoon' }
};

app.get('/login.html', (req, res) => { res.sendFile(path.join(__dirname, 'public', 'login.html')); });

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = USERS[username];
  if (user && user.password === password) {
    req.session.user = username;
    req.session.save(() => res.redirect('/'));
  } else { res.redirect('/login.html?error=1'); }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login.html'); });

function requireAuth(req, res, next) {
  if (req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1') return next();
  if (req.session && req.session.user) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ success: false, error: 'Unauthorised' });
  res.redirect('/login.html');
}

app.get('/api/session', requireAuth, (req, res) => { res.json({ user: req.session.user }); });

app.use((req, res, next) => {
  if (req.path === '/login.html' || req.path === '/login') return next();
  requireAuth(req, res, next);
});

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 8080;
const PROJECT_ID = process.env.BQ_PROJECT_ID || 'project-aa7ee149-5e29-4eb4-8bc';
const P = PROJECT_ID;
const bigquery = new BigQuery({ projectId: PROJECT_ID });
const cache = new NodeCache({ stdTTL: 900 }); // 15 min; OrderWise loads nightly anyway

// Valid sales order types — matches the OrderWise "Top N Customers by Sales Net"
// report (10-0028-001). Type 11 is deliberately excluded, as per the report.
const SOT = '1,4,8,9';

// Sign flip for credits — the report negates both sot 4 and sot 9.
const SIGN = 'CASE WHEN oh.oh_sot_id IN (4, 9) THEN -1 ELSE 1 END';

// Public holidays (date-only). uk = England & Wales; de = Hesse (Frankfurt/GmbH).
// Germany has no substitute-day rule, so weekend holidays are simply listed as-is.
const HOLIDAYS = {
  uk: new Set([
    '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-05', '2025-05-26', '2025-08-25', '2025-12-25', '2025-12-26',
    '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31', '2026-12-25', '2026-12-28'
  ]),
  de: new Set([
    '2025-01-01', '2025-04-18', '2025-04-21', '2025-05-01', '2025-05-29', '2025-06-09', '2025-06-19', '2025-10-03', '2025-12-25', '2025-12-26',
    '2026-01-01', '2026-04-03', '2026-04-06', '2026-05-01', '2026-05-14', '2026-05-25', '2026-06-04', '2026-10-03', '2026-12-25', '2026-12-26'
  ])
};

const isoLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// Working days in the month of endDate: elapsed (to endDate, capped at today) and total.
// Working day = Mon-Fri minus the relevant country's public holidays.
function workingDaysTile(endDate, country) {
  const hol = HOLIDAYS[country] || HOLIDAYS.uk;
  const end = new Date(endDate + 'T00:00:00');
  const y = end.getFullYear(), m = end.getMonth();
  const todayStr = isoLocal(new Date());
  const lastDay = new Date(y, m + 1, 0).getDate();
  let total = 0, elapsed = 0;
  for (let day = 1; day <= lastDay; day++) {
    const d = new Date(y, m, day);
    const dow = d.getDay();
    const ds = isoLocal(d);
    if (dow !== 0 && dow !== 6 && !hol.has(ds)) {
      total++;
      if (ds <= endDate && ds <= todayStr) elapsed++;
    }
  }
  return { elapsed, total, month: `${y}-${String(m + 1).padStart(2, '0')}` };
}

// Show every weekday in [start,end] as a row (zero-filled where no orders);
// keep weekends only when they actually carry orders. Totals are unaffected.
function scaffoldDays(rows, startDate, endDate) {
  const byDate = new Map(rows.map(r => [r.order_date, r]));
  const out = [];
  const cur = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (cur <= end) {
    const ds = isoLocal(cur);
    const dow = cur.getDay();
    if (byDate.has(ds)) out.push(byDate.get(ds));
    else if (dow !== 0 && dow !== 6) out.push({ order_date: ds, orders: 0, order_lines: 0, units: 0, weight_kg: 0, sales: 0, gp: 0, gp_pct: null });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// Flag weekdays in range that have zero orders and aren't bank holidays — these
// are the "silently missing day" case (e.g. a load that didn't run). Today is
// excluded, since the nightly load means the current day is legitimately partial.
function zeroWeekdayFlags(rows, startDate, endDate, country) {
  const hol = HOLIDAYS[country] || HOLIDAYS.uk;
  const hasOrders = new Set(rows.filter(r => Number(r.orders) > 0 || Number(r.sales) !== 0).map(r => r.order_date));
  const todayStr = isoLocal(new Date());
  const out = [];
  const cur = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (cur <= end) {
    const ds = isoLocal(cur);
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6 && !hol.has(ds) && ds < todayStr && !hasOrders.has(ds)) out.push(ds);
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// ── Sales rep dropdown ──────────────────────────────────────────────────────
app.get('/api/reps', async (req, res) => {
  const cacheKey = 'reps';
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, reps: cached, cached: true });
  const query = [
    'SELECT DISTINCT COALESCE(ud.ud_username, \'Unknown\') AS sales_rep',
    'FROM `' + P + '.fixmart_bi.order_header` oh',
    'LEFT JOIN `' + P + '.fixmart_bi.customer_detail` cd ON cd.cd_id = oh.oh_cd_id',
    'LEFT JOIN `' + P + '.fixmart_bi.customer_profile` cp ON cp.cp_customer_id = cd.cd_id',
    'LEFT JOIN `' + P + '.fixmart_bi.user_detail` ud ON ud.ud_id = cp.cp_sales_rep',
    'WHERE oh.oh_datetime >= DATE_SUB(CURRENT_DATE(), INTERVAL 365 DAY)',
    '  AND oh.oh_sot_id IN (' + SOT + ')',
    'ORDER BY 1'
  ].join('\n');
  try {
    const [rows] = await bigquery.query({ query, location: 'europe-west2' });
    const reps = rows.map(r => r.sales_rep);
    cache.set(cacheKey, reps);
    res.json({ success: true, reps, cached: false });
  } catch (err) { console.error('Reps error:', err); res.status(500).json({ success: false, error: err.message }); }
});

// ── Daily board ─────────────────────────────────────────────────────────────
// Returns one row per order date over the requested range, optionally filtered
// to a single sales rep. Orders taken by order date, not invoiced.
app.get('/api/daily', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 8) + '01';
  const startDate = req.query.startDate || firstOfMonth;
  const endDate = req.query.endDate || today;
  const rep = req.query.rep && req.query.rep !== 'all' ? req.query.rep : null;
  const compare = req.query.compare === '1'; // also return same span, prior year

  const cacheKey = `daily_${startDate}_${endDate}_${rep || 'all'}_${compare ? 'cmp' : 'no'}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, ...cached, cached: true });

  // Rep filter joins the customer -> profile -> user chain and filters on username.
  const repJoin = rep ? [
    'LEFT JOIN `' + P + '.fixmart_bi.customer_detail` cd ON cd.cd_id = oh.oh_cd_id',
    'LEFT JOIN `' + P + '.fixmart_bi.customer_profile` cp ON cp.cp_customer_id = cd.cd_id',
    'LEFT JOIN `' + P + '.fixmart_bi.user_detail` ud ON ud.ud_id = cp.cp_sales_rep'
  ].join('\n') : '';
  const repWhere = rep ? "AND COALESCE(ud.ud_username, 'Unknown') = @rep" : '';

  const query = [
    'WITH oh AS (',
    '  SELECT oh_id, oh_datetime, oh_sot_id, oh_cd_id',
    '  FROM `' + P + '.fixmart_bi.order_header` oh',
    '  WHERE oh_datetime BETWEEN @startDate AND @endDate',
    '    AND oh_sot_id IN (' + SOT + ')',
    '),',
    'lines AS (',
    '  SELECT oli.oli_oh_id, COUNT(*) AS order_lines, SUM(oli.oli_qty_required) AS units',
    '  FROM `' + P + '.fixmart_bi.order_line_item` oli',
    '  JOIN oh ON oh.oh_id = oli.oli_oh_id',
    '  GROUP BY 1',
    ')',
    'SELECT',
    '  FORMAT_DATE(\'%Y-%m-%d\', oh.oh_datetime) AS order_date',
    ', COUNT(DISTINCT oh.oh_id) AS orders',
    ', SUM(l.order_lines) AS order_lines',
    ', CAST(ROUND(SUM(l.units),0) AS INT64) AS units',
    ', CAST(ROUND(SUM(' + SIGN + ' * oht.oht_weight),0) AS INT64) AS weight_kg',
    ', ROUND(SUM(' + SIGN + ' * oht.oht_net),0) AS sales',
    ', ROUND(SUM(' + SIGN + ' * oht.oht_total_margin),0) AS gp',
    ', ROUND(SAFE_DIVIDE(SUM(' + SIGN + ' * oht.oht_total_margin), SUM(' + SIGN + ' * oht.oht_net)) * 100, 2) AS gp_pct',
    'FROM oh',
    'JOIN `' + P + '.fixmart_bi.Order_Header_Total` oht ON oht.oht_oh_id = oh.oh_id',
    'JOIN lines l ON l.oli_oh_id = oh.oh_id',
    repJoin,
    'WHERE 1 = 1 ' + repWhere,
    'GROUP BY 1',
    'ORDER BY 1'
  ].join('\n');

  const runOne = async (qStart, qEnd) => {
    const params = { startDate: qStart, endDate: qEnd };
    if (rep) params.rep = rep;
    const [rows] = await bigquery.query({ query, params, location: 'europe-west2' });
    const totals = rows.reduce((t, r) => {
      t.orders += Number(r.orders) || 0;
      t.order_lines += Number(r.order_lines) || 0;
      t.units += Number(r.units) || 0;
      t.weight_kg += Number(r.weight_kg) || 0;
      t.sales += Number(r.sales) || 0;
      t.gp += Number(r.gp) || 0;
      return t;
    }, { orders: 0, order_lines: 0, units: 0, weight_kg: 0, sales: 0, gp: 0 });
    totals.gp_pct = totals.sales ? Math.round((totals.gp / totals.sales) * 10000) / 100 : null;
    return { rows, totals };
  };

  const shiftYear = d => { const x = new Date(d + 'T00:00:00'); x.setFullYear(x.getFullYear() - 1); return x.toISOString().slice(0, 10); };

  try {
    const cy = await runOne(startDate, endDate);
    const scaffolded = scaffoldDays(cy.rows, startDate, endDate);
    const payload = { rows: scaffolded, totals: cy.totals, workingDays: workingDaysTile(endDate, 'uk'), zeroWeekdays: zeroWeekdayFlags(cy.rows, startDate, endDate, 'uk'), startDate, endDate, rep: rep || 'all' };
    if (compare) {
      const pyStart = shiftYear(startDate), pyEnd = shiftYear(endDate);
      const py = await runOne(pyStart, pyEnd);
      payload.pyRows = py.rows; payload.pyTotals = py.totals; payload.pyStart = pyStart; payload.pyEnd = pyEnd;
    }
    cache.set(cacheKey, payload);
    res.json({ success: true, ...payload, cached: false });
  } catch (err) { console.error('Daily error:', err); res.status(500).json({ success: false, error: err.message }); }
});

// ── Germany (GmbH) daily board ──────────────────────────────────────────────
// Cin7 invoiced orders, converted to GBP via v_cin7_sale_profit_summary_gbp.
// Keyed on invoice_date (the invoiced-orders basis). Header-level source, so
// order_lines / units / weight are not available and come back as 0 (gaps
// filled with zero). Fills in automatically as the Cin7 load backfills.
app.get('/api/germany', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 8) + '01';
  const startDate = req.query.startDate || firstOfMonth;
  const endDate = req.query.endDate || today;

  const cacheKey = `germany_${startDate}_${endDate}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, ...cached, cached: true });

  const query = [
    'SELECT',
    '  FORMAT_DATE(\'%Y-%m-%d\', DATE(invoice_date)) AS order_date',
    ', COUNT(DISTINCT sale_id) AS orders',
    ', 0 AS order_lines',
    ', 0 AS units',
    ', 0 AS weight_kg',
    ', ROUND(SUM(sale_value_gbp), 0) AS sales',
    ', ROUND(SUM(profit_amount_gbp), 0) AS gp',
    ', ROUND(SAFE_DIVIDE(SUM(profit_amount_gbp), SUM(sale_value_gbp)) * 100, 2) AS gp_pct',
    'FROM `' + P + '.cin7.v_cin7_sale_profit_summary_gbp`',
    'WHERE DATE(invoice_date) BETWEEN @startDate AND @endDate',
    'GROUP BY 1',
    'ORDER BY 1'
  ].join('\n');

  try {
    const [rows] = await bigquery.query({ query, params: { startDate, endDate }, location: 'europe-west2' });
    const totals = rows.reduce((t, r) => {
      t.orders += Number(r.orders) || 0;
      t.order_lines += Number(r.order_lines) || 0;
      t.units += Number(r.units) || 0;
      t.weight_kg += Number(r.weight_kg) || 0;
      t.sales += Number(r.sales) || 0;
      t.gp += Number(r.gp) || 0;
      return t;
    }, { orders: 0, order_lines: 0, units: 0, weight_kg: 0, sales: 0, gp: 0 });
    totals.gp_pct = totals.sales ? Math.round((totals.gp / totals.sales) * 10000) / 100 : null;
    const payload = { rows: scaffoldDays(rows, startDate, endDate), totals, workingDays: workingDaysTile(endDate, 'de'), startDate, endDate };
    cache.set(cacheKey, payload);
    res.json({ success: true, ...payload, cached: false });
  } catch (err) { console.error('Germany error:', err); res.status(500).json({ success: false, error: err.message }); }
});

// ── Combined (UK + GmbH) daily board ────────────────────────────────────────
// UK OrderWise (order date, order-book) plus GmbH Cin7 (invoice date), summed by
// day. Sales / GP / GP% only. Bases differ (UK orders-taken vs GmbH invoiced) —
// this is flagged on the tab. Working-days tile uses the UK (E&W) calendar.
app.get('/api/combined', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 8) + '01';
  const startDate = req.query.startDate || firstOfMonth;
  const endDate = req.query.endDate || today;

  const cacheKey = `combined_${startDate}_${endDate}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, ...cached, cached: true });

  const query = [
    'WITH uk AS (',
    '  SELECT FORMAT_DATE(\'%Y-%m-%d\', oh.oh_datetime) AS d,',
    '    SUM(' + SIGN + ' * oht.oht_net) AS sales,',
    '    SUM(' + SIGN + ' * oht.oht_total_margin) AS gp',
    '  FROM `' + P + '.fixmart_bi.order_header` oh',
    '  JOIN `' + P + '.fixmart_bi.Order_Header_Total` oht ON oht.oht_oh_id = oh.oh_id',
    '  WHERE oh.oh_datetime BETWEEN @startDate AND @endDate',
    '    AND oh.oh_sot_id IN (' + SOT + ')',
    '  GROUP BY 1',
    '),',
    'de AS (',
    '  SELECT FORMAT_DATE(\'%Y-%m-%d\', DATE(invoice_date)) AS d,',
    '    SUM(sale_value_gbp) AS sales,',
    '    SUM(profit_amount_gbp) AS gp',
    '  FROM `' + P + '.cin7.v_cin7_sale_profit_summary_gbp`',
    '  WHERE DATE(invoice_date) BETWEEN @startDate AND @endDate',
    '  GROUP BY 1',
    ')',
    'SELECT d AS order_date,',
    '  ROUND(SUM(sales), 0) AS sales,',
    '  ROUND(SUM(gp), 0) AS gp,',
    '  ROUND(SAFE_DIVIDE(SUM(gp), SUM(sales)) * 100, 2) AS gp_pct',
    'FROM (SELECT * FROM uk UNION ALL SELECT * FROM de)',
    'GROUP BY 1 ORDER BY 1'
  ].join('\n');

  try {
    const [rows] = await bigquery.query({ query, params: { startDate, endDate }, location: 'europe-west2' });
    const totals = rows.reduce((t, r) => { t.sales += Number(r.sales) || 0; t.gp += Number(r.gp) || 0; return t; }, { sales: 0, gp: 0 });
    totals.gp_pct = totals.sales ? Math.round((totals.gp / totals.sales) * 10000) / 100 : null;
    const payload = { rows: scaffoldDays(rows, startDate, endDate), totals, workingDays: workingDaysTile(endDate, 'uk'), zeroWeekdays: zeroWeekdayFlags(rows, startDate, endDate, 'uk'), startDate, endDate };
    cache.set(cacheKey, payload);
    res.json({ success: true, ...payload, cached: false });
  } catch (err) { console.error('Combined error:', err); res.status(500).json({ success: false, error: err.message }); }
});

// Freshness — last order_header load, so the header can show "data as of".
app.get('/api/freshness', async (req, res) => {
  const cacheKey = 'freshness';
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, ...cached, cached: true });
  const query = 'SELECT TIMESTAMP_MILLIS(last_modified_time) AS last_load '
    + 'FROM `' + P + '.fixmart_bi.__TABLES__` WHERE table_id = \'order_header\'';
  try {
    const [rows] = await bigquery.query({ query, location: 'europe-west2' });
    const last_load = rows[0] && rows[0].last_load ? (rows[0].last_load.value || String(rows[0].last_load)) : null;
    const payload = { last_load };
    cache.set(cacheKey, payload);
    res.json({ success: true, ...payload, cached: false });
  } catch (err) { console.error('Freshness error:', err); res.status(500).json({ success: false, error: err.message }); }
});

app.listen(PORT, () => console.log(`Sales Orders board running on port ${PORT}`));

// Fixmart Sales Orders Board — Cloud Run Server
// Orders taken (by order date), OrderWise. GP is order-book basis and will read
// below the management accounts because of the sleeve — this is expected.

const express = require('express');
const session = require('express-session');
const { BigQuery } = require('@google-cloud/bigquery');
const { google } = require('googleapis');
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

// Manually-recorded KPIs (MSIs, visits, ...) live in a Google Sheet owned by the
// team, read via the Cloud Run service account. The sheet must be shared with
// that account as Viewer. Read-only by construction: this app never writes to it.
const KPI_SHEET_ID = process.env.KPI_SHEET_ID || '1PqCNvSr8SE_pHTessBveOaVhz2XTl3wVbAjsMprJUvQ';

// Valid sales order types — matches the OrderWise "Top N Customers by Sales Net"
// report (10-0028-001). Type 11 is deliberately excluded, as per the report.
const SOT = '1,4,8,9';

// Sign flip for credits — the report negates both sot 4 and sot 9.
// Parenthesised because it is now nested inside other CASE expressions.
const SIGN = '(CASE WHEN oh.oh_sot_id IN (4, 9) THEN -1 ELSE 1 END)';

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

// Account-manager lookup, guaranteed one row per customer.
// OrderWise report 10-0028-001 (the daily sales report Cariss circulates) inner
// joins customer_detail -> customer_profile -> user_detail, so any customer with
// no sales rep assigned is excluded from its figures. In practice that is exactly
// the internal Fixmart accounts (Ltd, Engineering, Subcontract, GmbH), which carry
// cost transfers at nil or negative margin. Reproducing the join rather than
// hardcoding an account list means a new internal account is excluded on day one.
// Validated Aug 2026: July agreed with the report to £1,178 on £2.0m (0.06%).
const REP_LOOKUP = [
  '  SELECT cd.cd_id AS cd_id, ANY_VALUE(ud.ud_username) AS sales_rep',
  '  FROM `' + PROJECT_ID + '.fixmart_bi.customer_detail` cd',
  '  JOIN `' + PROJECT_ID + '.fixmart_bi.customer_profile` cp ON cp.cp_customer_id = cd.cd_id',
  '  JOIN `' + PROJECT_ID + '.fixmart_bi.user_detail` ud ON ud.ud_id = cp.cp_sales_rep',
  '  GROUP BY 1'
].join('\n');

// Working days (Mon-Fri minus public holidays) inside the selected range, never
// counting past today. Used as the denominator for the per-day averages, so a
// 13-week view divides by its own working days rather than the month's.
function workingDaysInRange(startDate, endDate, country) {
  const hol = HOLIDAYS[country] || HOLIDAYS.uk;
  const todayStr = isoLocal(new Date());
  const cur = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  let n = 0;
  while (cur <= end) {
    const ds = isoLocal(cur), dow = cur.getDay();
    if (dow !== 0 && dow !== 6 && !hol.has(ds) && ds <= todayStr) n++;
    cur.setDate(cur.getDate() + 1);
  }
  return n;
}

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
    else if (dow !== 0 && dow !== 6) out.push({ order_date: ds, orders: 0, order_lines: 0, units: 0, weight_kg: 0, sales: 0, gp: 0, gp_pct: null, excluded_sales: 0 });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

// Running totals and cumulative averages, matching the finance sheet's layout.
// Ave/Day is the running total divided by working days elapsed so far, not a
// rolling window: on day one it equals that day, by month end it equals the
// period average. Weekend rows carry the running total forward without
// incrementing the day count, so a Saturday order cannot dilute the average.
// Av Ord Val is that day's own sales over that day's own orders.
function addRunningTotals(rows, country) {
  const hol = HOLIDAYS[country] || HOLIDAYS.uk;
  let cumSales = 0, cumGp = 0, wd = 0;
  return rows.map(r => {
    cumSales += Number(r.sales) || 0;
    cumGp += Number(r.gp) || 0;
    const dow = new Date(r.order_date + 'T00:00:00').getDay();
    const isWd = dow !== 0 && dow !== 6 && !hol.has(r.order_date);
    if (isWd) wd++;
    const orders = Number(r.orders) || 0;
    return Object.assign({}, r, {
      day_no: isWd ? wd : null, // working-day number within the range; blank on weekends/hols
      sales_rtotal: Math.round(cumSales),
      gp_rtotal: Math.round(cumGp),
      sales_avg_day: wd ? Math.round(cumSales / wd) : null,
      gp_avg_day: wd ? Math.round(cumGp / wd) : null,
      aov: orders ? Math.round((Number(r.sales) || 0) / orders) : null
    });
  });
}

// Zero-fill weekdays for the combined board (UK/DE/combined split shape).
function scaffoldCombined(rows, startDate, endDate) {
  const byDate = new Map(rows.map(r => [r.order_date, r]));
  const out = [];
  const cur = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  while (cur <= end) {
    const ds = isoLocal(cur);
    const dow = cur.getDay();
    if (byDate.has(ds)) out.push(byDate.get(ds));
    else if (dow !== 0 && dow !== 6) out.push({ order_date: ds, uk_sales: 0, uk_gp: 0, de_sales: 0, de_gp: 0, sales: 0, gp: 0, gp_pct: null });
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
  // Only reps that actually hold trading customers. No 'Unknown' bucket: customers
  // with no rep are internal accounts and are out of scope for the sales figures.
  const query = [
    'WITH reps AS (',
    REP_LOOKUP,
    ')',
    'SELECT DISTINCT r.sales_rep',
    'FROM `' + P + '.fixmart_bi.order_header` oh',
    'JOIN reps r ON r.cd_id = oh.oh_cd_id',
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

  // Internal accounts (no sales rep) are excluded from every figure, matching the
  // OrderWise report. Their value is still returned as excluded_sales so the
  // exclusion is visible on screen rather than silent.
  const repWhere = rep ? 'AND r.sales_rep = @rep' : '';
  const IN_SCOPE = 'r.cd_id IS NOT NULL';

  const query = [
    'WITH reps AS (',
    REP_LOOKUP,
    '),',
    'oh AS (',
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
    ', COUNT(DISTINCT CASE WHEN ' + IN_SCOPE + ' THEN oh.oh_id END) AS orders',
    ', IFNULL(SUM(CASE WHEN ' + IN_SCOPE + ' THEN l.order_lines END),0) AS order_lines',
    ', CAST(ROUND(IFNULL(SUM(CASE WHEN ' + IN_SCOPE + ' THEN l.units END),0),0) AS INT64) AS units',
    ', CAST(ROUND(SUM(CASE WHEN ' + IN_SCOPE + ' THEN ' + SIGN + ' * oht.oht_weight ELSE 0 END),0) AS INT64) AS weight_kg',
    ', ROUND(SUM(CASE WHEN ' + IN_SCOPE + ' THEN ' + SIGN + ' * oht.oht_net ELSE 0 END),0) AS sales',
    ', ROUND(SUM(CASE WHEN ' + IN_SCOPE + ' THEN ' + SIGN + ' * oht.oht_total_margin ELSE 0 END),0) AS gp',
    ', ROUND(SAFE_DIVIDE(',
    '    SUM(CASE WHEN ' + IN_SCOPE + ' THEN ' + SIGN + ' * oht.oht_total_margin ELSE 0 END),',
    '    SUM(CASE WHEN ' + IN_SCOPE + ' THEN ' + SIGN + ' * oht.oht_net ELSE 0 END)) * 100, 2) AS gp_pct',
    ', ROUND(SUM(CASE WHEN r.cd_id IS NULL THEN ' + SIGN + ' * oht.oht_net ELSE 0 END),0) AS excluded_sales',
    'FROM oh',
    'JOIN `' + P + '.fixmart_bi.Order_Header_Total` oht ON oht.oht_oh_id = oh.oh_id',
    // LEFT, not INNER: an order with no line items still counts as a sale.
    'LEFT JOIN lines l ON l.oli_oh_id = oh.oh_id',
    'LEFT JOIN reps r ON r.cd_id = oh.oh_cd_id',
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
      t.excluded_sales += Number(r.excluded_sales) || 0;
      return t;
    }, { orders: 0, order_lines: 0, units: 0, weight_kg: 0, sales: 0, gp: 0, excluded_sales: 0 });
    totals.gp_pct = totals.sales ? Math.round((totals.gp / totals.sales) * 10000) / 100 : null;
    // Average order value, and lines per order, on the same order-book basis.
    totals.aov = totals.orders ? Math.round(totals.sales / totals.orders) : null;
    totals.lines_per_order = totals.orders ? Math.round((totals.order_lines / totals.orders) * 10) / 10 : null;
    // Per working day across the requested range (not the calendar month).
    const wdRange = workingDaysInRange(qStart, qEnd, 'uk');
    totals.working_days_in_range = wdRange;
    const per = n => (wdRange ? Math.round(n / wdRange) : null);
    totals.per_day = wdRange ? {
      sales: per(totals.sales), gp: per(totals.gp), orders: per(totals.orders),
      order_lines: per(totals.order_lines), units: per(totals.units), weight_kg: per(totals.weight_kg)
    } : null;
    return { rows, totals };
  };

  const shiftYear = d => { const x = new Date(d + 'T00:00:00'); x.setFullYear(x.getFullYear() - 1); return x.toISOString().slice(0, 10); };

  try {
    const cy = await runOne(startDate, endDate);
    const scaffolded = addRunningTotals(scaffoldDays(cy.rows, startDate, endDate), 'uk');
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
// UK OrderWise (order date, order-book) and GmbH Cin7 (invoice date), shown side
// by side per day: UK sales/GP, Germany sales/GP, and the combined sales/GP/GP%.
// Bases differ (UK orders-taken vs GmbH invoiced) — flagged on the tab. The
// working-days tile uses the UK (E&W) calendar.
app.get('/api/combined', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 8) + '01';
  const startDate = req.query.startDate || firstOfMonth;
  const endDate = req.query.endDate || today;

  const cacheKey = `combined_${startDate}_${endDate}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, ...cached, cached: true });

  const query = [
    'WITH reps AS (',
    REP_LOOKUP,
    '),',
    'uk AS (',
    '  SELECT FORMAT_DATE(\'%Y-%m-%d\', oh.oh_datetime) AS d,',
    '    SUM(' + SIGN + ' * oht.oht_net) AS sales,',
    '    SUM(' + SIGN + ' * oht.oht_total_margin) AS gp',
    '  FROM `' + P + '.fixmart_bi.order_header` oh',
    '  JOIN `' + P + '.fixmart_bi.Order_Header_Total` oht ON oht.oht_oh_id = oh.oh_id',
    // INNER JOIN: drops internal Fixmart accounts, matching the UK daily board.
    '  JOIN reps r ON r.cd_id = oh.oh_cd_id',
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
    'SELECT COALESCE(uk.d, de.d) AS order_date,',
    '  ROUND(COALESCE(uk.sales, 0), 0) AS uk_sales,',
    '  ROUND(COALESCE(uk.gp, 0), 0) AS uk_gp,',
    '  ROUND(COALESCE(de.sales, 0), 0) AS de_sales,',
    '  ROUND(COALESCE(de.gp, 0), 0) AS de_gp,',
    '  ROUND(COALESCE(uk.sales, 0) + COALESCE(de.sales, 0), 0) AS sales,',
    '  ROUND(COALESCE(uk.gp, 0) + COALESCE(de.gp, 0), 0) AS gp,',
    '  ROUND(SAFE_DIVIDE(COALESCE(uk.gp, 0) + COALESCE(de.gp, 0), COALESCE(uk.sales, 0) + COALESCE(de.sales, 0)) * 100, 2) AS gp_pct',
    'FROM uk FULL OUTER JOIN de ON uk.d = de.d',
    'ORDER BY 1'
  ].join('\n');

  try {
    const [rows] = await bigquery.query({ query, params: { startDate, endDate }, location: 'europe-west2' });
    const totals = rows.reduce((t, r) => {
      t.uk_sales += Number(r.uk_sales) || 0;
      t.uk_gp += Number(r.uk_gp) || 0;
      t.de_sales += Number(r.de_sales) || 0;
      t.de_gp += Number(r.de_gp) || 0;
      t.sales += Number(r.sales) || 0;
      t.gp += Number(r.gp) || 0;
      return t;
    }, { uk_sales: 0, uk_gp: 0, de_sales: 0, de_gp: 0, sales: 0, gp: 0 });
    totals.gp_pct = totals.sales ? Math.round((totals.gp / totals.sales) * 10000) / 100 : null;
    const payload = { rows: scaffoldCombined(rows, startDate, endDate), totals, workingDays: workingDaysTile(endDate, 'uk'), zeroWeekdays: zeroWeekdayFlags(rows, startDate, endDate, 'uk'), startDate, endDate };
    cache.set(cacheKey, payload);
    res.json({ success: true, ...payload, cached: false });
  } catch (err) { console.error('Combined error:', err); res.status(500).json({ success: false, error: err.message }); }
});

// ── KPI tracker (manual entry, Google Sheet) ────────────────────────────────
// Two tabs. "KPIs" defines what exists: Name | Unit | Monthly Target |
// Active From | Active To (blank = still active). "Daily" holds the numbers:
// Date in column A, one column per KPI, headers matching the Name column.
// Values are read UNFORMATTED with dates as serial numbers, so on-screen
// formatting in the sheet cannot mislead the parsing. KPI names are matched
// ignoring case, spaces and punctuation, so "MSI's" and "MSIs" line up.

// Google Sheets serial day 0 is 30 Dec 1899.
const SHEET_EPOCH = Date.UTC(1899, 11, 30);
function serialToISO(n) {
  return new Date(SHEET_EPOCH + Math.floor(n + 1e-7) * 86400000).toISOString().slice(0, 10);
}
// Accepts a serial number, a dd/mm/yyyy string (UK locale) or yyyy-mm-dd.
function parseSheetDate(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number' && isFinite(v)) return serialToISO(v);
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  return null;
}
const normKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function parseUnit(u) {
  const s = String(u || '').toLowerCase();
  if (s.startsWith('c') || s.includes('£') || s.includes('gbp')) return 'currency';
  if (s.startsWith('p') || s.includes('%')) return 'percent';
  return 'number';
}
// Total working days (Mon-Fri less E&W hols) in the month containing dateStr.
const wdMonthCache = new Map();
function workingDaysInMonthOf(dateStr) {
  const key = dateStr.slice(0, 7);
  if (wdMonthCache.has(key)) return wdMonthCache.get(key);
  const y = Number(key.slice(0, 4)), m = Number(key.slice(5, 7)) - 1;
  const last = new Date(y, m + 1, 0).getDate();
  let n = 0;
  for (let d = 1; d <= last; d++) {
    const dt = new Date(y, m, d), ds = isoLocal(dt), dow = dt.getDay();
    if (dow !== 0 && dow !== 6 && !HOLIDAYS.uk.has(ds)) n++;
  }
  wdMonthCache.set(key, n);
  return n;
}

app.get('/api/kpis', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const firstOfMonth = today.slice(0, 8) + '01';
  const startDate = req.query.startDate || firstOfMonth;
  const endDate = req.query.endDate || today;

  const cacheKey = `kpis_${startDate}_${endDate}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ success: true, ...cached, cached: true });

  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  let saEmail = '';
  try { const c = await auth.getCredentials(); saEmail = c && c.client_email ? c.client_email : ''; } catch (e) { /* metadata only */ }

  try {
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const resp = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: KPI_SHEET_ID,
      ranges: ['KPIs!A1:E200', 'Daily!A1:AZ2000'],
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'SERIAL_NUMBER'
    });
    const [defTab, dailyTab] = resp.data.valueRanges.map(v => v.values || []);

    // Definitions: skip header, keep rows with a name. Active window filtering:
    // a KPI appears if its active window overlaps the requested range at all.
    const kpis = defTab.slice(1)
      .filter(r => r && r[0])
      .map(r => ({
        key: normKey(r[0]),
        name: String(r[0]).trim(),
        unit: parseUnit(r[1]),
        target: (r[2] == null || r[2] === '') ? null : Number(r[2]),
        activeFrom: parseSheetDate(r[3]),
        activeTo: parseSheetDate(r[4])
      }))
      .filter(k => (!k.activeFrom || k.activeFrom <= endDate) && (!k.activeTo || k.activeTo >= startDate));

    // Daily tab: header row maps columns to KPI keys; body maps date -> values.
    const header = (dailyTab[0] || []).map(normKey);
    const colFor = {};
    kpis.forEach(k => { const i = header.indexOf(k.key); if (i > 0) colFor[k.key] = i; });
    const byDate = new Map();
    dailyTab.slice(1).forEach(r => {
      const d = parseSheetDate(r && r[0]);
      if (d) byDate.set(d, r);
    });

    // Walk the range like the sales table does: every weekday is a row, weekend
    // rows only when they carry data. Accrual (running totals, pro-rata target,
    // working-day count) stops at today, so pre-filled future rows are inert.
    const rows = [];
    const cum = {}, tgt = {};
    kpis.forEach(k => { cum[k.key] = 0; tgt[k.key] = 0; });
    let wd = 0;
    const cur = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');
    while (cur <= end) {
      const ds = isoLocal(cur);
      const dow = cur.getDay();
      const sheetRow = byDate.get(ds);
      const isWeekday = dow !== 0 && dow !== 6;
      const isWd = isWeekday && !HOLIDAYS.uk.has(ds) && ds <= today;
      const hasData = sheetRow && kpis.some(k => {
        const v = colFor[k.key] != null ? sheetRow[colFor[k.key]] : null;
        return v !== '' && v != null;
      });
      if (isWeekday || hasData) {
        if (isWd) wd++;
        const cells = {};
        kpis.forEach(k => {
          const raw = sheetRow && colFor[k.key] != null ? sheetRow[colFor[k.key]] : null;
          const v = (raw === '' || raw == null || isNaN(Number(raw))) ? null : Number(raw);
          if (v != null && ds <= today) cum[k.key] += v;
          if (isWd && k.target != null) tgt[k.key] += k.target / workingDaysInMonthOf(ds);
          cells[k.key] = {
            v,
            rtotal: ds <= today ? Math.round(cum[k.key] * 100) / 100 : null,
            rtarget: (isWd || ds <= today) && k.target != null ? Math.round(tgt[k.key] * 10) / 10 : null,
            aveday: wd && ds <= today ? Math.round((cum[k.key] / wd) * 10) / 10 : null
          };
        });
        rows.push({ order_date: ds, day_no: isWd ? wd : null, cells });
      }
      cur.setDate(cur.getDate() + 1);
    }

    const totals = {};
    kpis.forEach(k => {
      totals[k.key] = {
        total: Math.round(cum[k.key] * 100) / 100,
        rtarget: k.target != null ? Math.round(tgt[k.key]) : null,
        aveday: wd ? Math.round((cum[k.key] / wd) * 10) / 10 : null
      };
    });

    const payload = { available: true, kpis: kpis.map(k => ({ key: k.key, name: k.name, unit: k.unit, target: k.target })), rows, totals, workingDays: wd, startDate, endDate };
    cache.set(cacheKey, payload, 60); // sheet edits show within a minute
    res.json({ success: true, ...payload, cached: false });
  } catch (err) {
    console.error('KPI sheet error:', err.message);
    const msg = String(err.message || err);
    let reason;
    if (/permission|403|insufficient/i.test(msg)) {
      reason = 'The KPI sheet is not accessible. Share it as Viewer with ' + (saEmail || 'the Cloud Run service account') + ' and check the Google Sheets API is enabled.';
    } else if (/404|not found|requested entity/i.test(msg)) {
      reason = 'KPI sheet not found. Check KPI_SHEET_ID.';
    } else if (/default credentials/i.test(msg)) {
      reason = 'No Google credentials in this environment (expected when running outside Cloud Run).';
    } else {
      reason = msg.slice(0, 140);
    }
    // Available:false is a soft state, not an error: the board hides the section
    // and shows the reason quietly so misconfiguration is visible, not silent.
    res.json({ success: true, available: false, reason });
  }
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

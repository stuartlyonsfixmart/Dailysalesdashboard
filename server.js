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

// Valid sales order types (matches transport-mi and the management orders board)
const SOT = '1,4,8,9,11';

// Sign flip for credits (sot 4), same as commercials_header_vw
const SIGN = 'CASE WHEN oh.oh_sot_id = 4 THEN -1 ELSE 1 END';

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
    const payload = { rows: cy.rows, totals: cy.totals, startDate, endDate, rep: rep || 'all' };
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
// Header-level source, so order_lines / units / weight are not available and
// come back as 0 (gaps filled with zero). Fills in automatically as the Cin7
// load backfills the order book.
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
    '  FORMAT_DATE(\'%Y-%m-%d\', DATE(order_date)) AS order_date',
    ', COUNT(DISTINCT sale_id) AS orders',
    ', 0 AS order_lines',
    ', 0 AS units',
    ', 0 AS weight_kg',
    ', ROUND(SUM(sale_value_gbp), 0) AS sales',
    ', ROUND(SUM(profit_amount_gbp), 0) AS gp',
    ', ROUND(SAFE_DIVIDE(SUM(profit_amount_gbp), SUM(sale_value_gbp)) * 100, 2) AS gp_pct',
    'FROM `' + P + '.cin7.v_cin7_sale_profit_summary_gbp`',
    'WHERE DATE(order_date) BETWEEN @startDate AND @endDate',
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
    const payload = { rows, totals, startDate, endDate };
    cache.set(cacheKey, payload);
    res.json({ success: true, ...payload, cached: false });
  } catch (err) { console.error('Germany error:', err); res.status(500).json({ success: false, error: err.message }); }
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

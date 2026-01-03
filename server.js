const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const path = require('path');
const { OAuth2Client } = require('google-auth-library');
const { initDb } = require('./db');

try { require('dotenv').config(); } catch (_) {}

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-please';
const ADMIN_SETUP_KEY = process.env.ADMIN_SETUP_KEY || 'setup-me-please';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

const db = initDb(path.join(__dirname, 'loyalty.sqlite'));

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

function now() { return Math.floor(Date.now() / 1000); } // seconds
function id(prefix='') { return prefix + crypto.randomBytes(16).toString('hex'); }
function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function shortCode(len=4) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i=0;i<len;i++) out += alphabet[Math.floor(Math.random()*alphabet.length)];
  return out;
}

function signJwt(payload, ttlSeconds) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: ttlSeconds });
}
function verifyJwt(token) {
  return jwt.verify(token, JWT_SECRET);
}

function auth(role) {
  return (req, res, next) => {
    const token = req.cookies.session || (req.headers.authorization || '').replace('Bearer ', '');
    if (!token) return res.status(401).json({ error: 'not_authenticated' });
    try {
      const payload = verifyJwt(token);
      if (role && payload.role !== role) return res.status(403).json({ error: 'forbidden' });
      req.auth = payload;
      next();
    } catch (e) {
      return res.status(401).json({ error: 'invalid_session' });
    }
  };
}

// --- Rate limiting helpers ---
function rateLimit(key, maxCount, windowSeconds) {
  if (!maxCount || maxCount <= 0) return { ok: true };
  const t = now();
  const row = db.prepare('SELECT key, count, window_start, window_seconds FROM rate_limits WHERE key=?').get(key);
  if (!row) {
    db.prepare('INSERT INTO rate_limits(key, count, window_start, window_seconds) VALUES (?,?,?,?)')
      .run(key, 1, t, windowSeconds);
    return { ok: true };
  }
  const elapsed = t - row.window_start;
  if (elapsed >= row.window_seconds) {
    db.prepare('UPDATE rate_limits SET count=?, window_start=?, window_seconds=? WHERE key=?')
      .run(1, t, windowSeconds, key);
    return { ok: true };
  }
  if (row.count >= maxCount) return { ok: false, retryAfter: row.window_seconds - elapsed };
  db.prepare('UPDATE rate_limits SET count=count+1 WHERE key=?').run(key);
  return { ok: true };
}

// --- Point lots: true expiry + FIFO consumption ---
function getProgram(merchant_id) {
  return db.prepare('SELECT * FROM loyalty_programs WHERE merchant_id=? AND active=1').get(merchant_id);
}

function getBalance(merchant_id, customer_id) {
  const t = now();
  const row = db.prepare(`
    SELECT COALESCE(SUM(points_remaining),0) as bal
    FROM point_lots
    WHERE merchant_id=? AND customer_id=? AND points_remaining!=0
      AND (expires_at IS NULL OR expires_at > ?)
  `).get(merchant_id, customer_id, t);
  return row ? row.bal : 0;
}

function addEarnLot({ merchant_id, customer_id, points, expires_at, source_token_id, note }) {
  const lot_id = id('lot_');
  db.prepare(`
    INSERT INTO point_lots(lot_id, merchant_id, customer_id, points_remaining, created_at, expires_at, source_token_id, note)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(lot_id, merchant_id, customer_id, points, now(), expires_at ?? null, source_token_id ?? null, note ?? null);
  return lot_id;
}

function consumePointsFIFO({ merchant_id, customer_id, points_needed, redemption_id }) {
  // Returns array of {lot_id, used}
  let remaining = points_needed;
  const t = now();

  const lots = db.prepare(`
    SELECT lot_id, points_remaining, expires_at, created_at
    FROM point_lots
    WHERE merchant_id=? AND customer_id=?
      AND points_remaining>0
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY
      CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END ASC,
      expires_at ASC,
      created_at ASC
  `).all(merchant_id, customer_id, t);

  const used = [];
  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.points_remaining, remaining);
    db.prepare('UPDATE point_lots SET points_remaining=points_remaining-? WHERE lot_id=?').run(take, lot.lot_id);
    used.push({ lot_id: lot.lot_id, used: take });
    remaining -= take;
  }

  if (remaining > 0) {
    throw new Error('insufficient_points');
  }

  if (redemption_id) {
    const ins = db.prepare('INSERT INTO redemption_consumptions(redemption_id, lot_id, points_used) VALUES (?,?,?)');
    for (const u of used) ins.run(redemption_id, u.lot_id, u.used);
  }

  return used;
}

function removePoints({ merchant_id, customer_id, points_to_remove }) {
  // Used for VOID_EARN: remove from available lots FIFO (like negative earn).
  // If still remaining after consuming all, create a negative lot (debt) so accounting remains correct.
  let remaining = points_to_remove;
  const t = now();

  const lots = db.prepare(`
    SELECT lot_id, points_remaining, expires_at, created_at
    FROM point_lots
    WHERE merchant_id=? AND customer_id=?
      AND points_remaining>0
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY
      CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END ASC,
      expires_at ASC,
      created_at ASC
  `).all(merchant_id, customer_id, t);

  for (const lot of lots) {
    if (remaining <= 0) break;
    const take = Math.min(lot.points_remaining, remaining);
    db.prepare('UPDATE point_lots SET points_remaining=points_remaining-? WHERE lot_id=?').run(take, lot.lot_id);
    remaining -= take;
  }

  if (remaining > 0) {
    // Create a "debt" lot (negative). Customer balance may show negative; UI clamps to 0.
    const lot_id = id('lot_');
    db.prepare(`
      INSERT INTO point_lots(lot_id, merchant_id, customer_id, points_remaining, created_at, expires_at, source_token_id, note)
      VALUES (?,?,?,?,?,?,?,?)
    `).run(lot_id, merchant_id, customer_id, -remaining, now(), null, null, 'Debt from void (insufficient points)');
  }
}

// --- Admin setup to seed demo merchant/store/program ---
app.get('/admin/setup', (req, res) => {
  if (req.query.key !== ADMIN_SETUP_KEY) return res.status(403).send('Forbidden (bad key). Set ADMIN_SETUP_KEY in .env');
  const t = now();

  const merchant_id = 'morgany';
  const store_id = 'morgany-main';
  const program_id = 'morgany-program';

  const merchant = db.prepare('SELECT * FROM merchants WHERE merchant_id=?').get(merchant_id);
  if (!merchant) {
    db.prepare('INSERT INTO merchants(merchant_id, name, status, created_at) VALUES (?,?,?,?)')
      .run(merchant_id, 'Morgany Bakery (Demo)', 'active', t);
  }

  const store = db.prepare('SELECT * FROM stores WHERE store_id=?').get(store_id);
  if (!store) {
    db.prepare('INSERT INTO stores(store_id, merchant_id, name, address, timezone, created_at) VALUES (?,?,?,?,?,?)')
      .run(store_id, merchant_id, 'Morgany Bakery - Middlesbrough', 'Middlesbrough, UK', 'Europe/London', t);
  }

  const program = db.prepare('SELECT * FROM loyalty_programs WHERE program_id=?').get(program_id);
  if (!program) {
    db.prepare(`INSERT INTO loyalty_programs(program_id, merchant_id, points_per_earn, token_expiry_minutes, points_expire_days, max_earns_per_day, max_earns_per_10min, created_at, active)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(program_id, merchant_id, 1, 120, 180, 0, 0, t, 1);
  }

  const reward = db.prepare('SELECT * FROM rewards WHERE reward_id=?').get('morgany-reward-1');
  if (!reward) {
    db.prepare('INSERT INTO rewards(reward_id, program_id, name, points_cost, active, created_at) VALUES (?,?,?,?,?,?)')
      .run('morgany-reward-1', program_id, 'Free hot drink (demo)', 8, 1, t);
  }

  const staff = db.prepare('SELECT * FROM staff WHERE staff_id=?').get('morgany-staff-1');
  if (!staff) {
    db.prepare('INSERT INTO staff(staff_id, store_id, email, pin_hash, role, status, created_at) VALUES (?,?,?,?,?,?,?)')
      .run('morgany-staff-1', store_id, 'demo@morgany.local', sha256('1234'), 'manager', 'active', t);
  }

  res.send(`✅ Setup complete.
- Merchant: Morgany Bakery (Demo)
- Vendor PIN: 1234
Open vendor kiosk: ${BASE_URL}/vendor
Open customer: ${BASE_URL}/`);
});

// --- Config for front-end ---
app.get('/api/config', (req, res) => {
  res.json({ baseUrl: BASE_URL, googleClientId: GOOGLE_CLIENT_ID });
});

// --- Auth endpoints ---
app.post('/api/vendor/login', (req, res) => {
  const { store_id, pin } = req.body || {};
  if (!store_id || !pin) return res.status(400).json({ error: 'missing_store_or_pin' });
  const staff = db.prepare('SELECT * FROM staff WHERE store_id=? AND status="active"').get(store_id);
  if (!staff) return res.status(404).json({ error: 'no_staff_for_store' });
  if (staff.pin_hash !== sha256(String(pin))) return res.status(401).json({ error: 'bad_pin' });

  db.prepare('UPDATE staff SET last_login_at=? WHERE staff_id=?').run(now(), staff.staff_id);
  const token = signJwt({ role: 'vendor', staff_id: staff.staff_id, store_id: staff.store_id }, 60*60*24*7);
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
});

// Google sign-in (recommended)
app.post('/api/customer/google', async (req, res) => {
  const { credential } = req.body || {};
  if (!googleClient) return res.status(400).json({ error: 'google_not_configured' });
  if (!credential) return res.status(400).json({ error: 'missing_credential' });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken: credential,
      audience: GOOGLE_CLIENT_ID
    });
    const payload = ticket.getPayload();
    if (!payload) return res.status(400).json({ error: 'bad_google_token' });

    const google_sub = payload.sub;
    const email = String(payload.email || '').toLowerCase();
    const email_verified = payload.email_verified ? 1 : 0;

    if (!email) return res.status(400).json({ error: 'google_missing_email' });

    const t = now();
    let customer = db.prepare('SELECT * FROM customers WHERE google_sub=?').get(google_sub);
    if (!customer) {
      // Also merge if email exists (optional)
      const existingByEmail = db.prepare('SELECT * FROM customers WHERE email=?').get(email);
      if (existingByEmail && !existingByEmail.google_sub) {
        db.prepare('UPDATE customers SET google_sub=?, email_verified=?, last_seen_at=? WHERE customer_id=?')
          .run(google_sub, email_verified, t, existingByEmail.customer_id);
        customer = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(existingByEmail.customer_id);
      } else {
        const customer_id = id('c_');
        db.prepare('INSERT INTO customers(customer_id, google_sub, email, email_verified, created_at, last_seen_at) VALUES (?,?,?,?,?,?)')
          .run(customer_id, google_sub, email, email_verified, t, t);
        customer = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(customer_id);
      }
    } else {
      db.prepare('UPDATE customers SET email=?, email_verified=?, last_seen_at=? WHERE customer_id=?')
        .run(email, email_verified, t, customer.customer_id);
    }

    const token = signJwt({ role: 'customer', customer_id: customer.customer_id }, 60*60*24*30);
    res.cookie('session', token, { httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(401).json({ error: 'google_verify_failed' });
  }
});

// Email fallback (for quick testing)
app.post('/api/customer/login', (req, res) => {
  const { email } = req.body || {};
  if (!email || !String(email).includes('@')) return res.status(400).json({ error: 'bad_email' });
  const norm = String(email).trim().toLowerCase();
  let customer = db.prepare('SELECT * FROM customers WHERE email=?').get(norm);
  const t = now();
  if (!customer) {
    const customer_id = id('c_');
    db.prepare('INSERT INTO customers(customer_id, google_sub, email, email_verified, created_at, last_seen_at) VALUES (?,?,?,?,?,?)')
      .run(customer_id, null, norm, 0, t, t);
    customer = db.prepare('SELECT * FROM customers WHERE customer_id=?').get(customer_id);
  } else {
    db.prepare('UPDATE customers SET last_seen_at=? WHERE customer_id=?').run(t, customer.customer_id);
  }

  const token = signJwt({ role: 'customer', customer_id: customer.customer_id }, 60*60*24*30);
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax' });
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ ok: true });
});

// --- Vendor: store/program settings ---
app.get('/api/vendor/store', auth('vendor'), (req, res) => {
  const store = db.prepare('SELECT * FROM stores WHERE store_id=?').get(req.auth.store_id);
  const program = db.prepare('SELECT * FROM loyalty_programs WHERE merchant_id=? AND active=1').get(store.merchant_id);
  const rewards = db.prepare('SELECT * FROM rewards WHERE program_id=? AND active=1').all(program.program_id);
  res.json({ store, program, rewards });
});

app.post('/api/vendor/program', auth('vendor'), (req, res) => {
  const { points_per_earn, token_expiry_minutes, points_expire_days, max_earns_per_day, max_earns_per_10min } = req.body || {};
  const store = db.prepare('SELECT * FROM stores WHERE store_id=?').get(req.auth.store_id);
  const program = db.prepare('SELECT * FROM loyalty_programs WHERE merchant_id=? AND active=1').get(store.merchant_id);

  db.prepare(`UPDATE loyalty_programs
              SET points_per_earn=?,
                  token_expiry_minutes=?,
                  points_expire_days=?,
                  max_earns_per_day=?,
                  max_earns_per_10min=?
              WHERE program_id=?`)
    .run(
      Math.max(1, parseInt(points_per_earn || program.points_per_earn, 10)),
      Math.max(5, parseInt(token_expiry_minutes || program.token_expiry_minutes, 10)),
      points_expire_days === '' || points_expire_days === null || typeof points_expire_days === 'undefined'
        ? null
        : Math.max(1, parseInt(points_expire_days, 10)),
      Math.max(0, parseInt(max_earns_per_day || program.max_earns_per_day, 10)),
      Math.max(0, parseInt(max_earns_per_10min || program.max_earns_per_10min, 10)),
      program.program_id
    );

  res.json({ ok: true });
});

app.post('/api/vendor/reward', auth('vendor'), (req, res) => {
  const { name, points_cost } = req.body || {};
  if (!name || !points_cost) return res.status(400).json({ error: 'missing_fields' });
  const store = db.prepare('SELECT * FROM stores WHERE store_id=?').get(req.auth.store_id);
  const program = db.prepare('SELECT * FROM loyalty_programs WHERE merchant_id=? AND active=1').get(store.merchant_id);

  const reward_id = id('r_');
  db.prepare('INSERT INTO rewards(reward_id, program_id, name, points_cost, active, created_at) VALUES (?,?,?,?,?,?)')
    .run(reward_id, program.program_id, String(name).trim(), Math.max(1, parseInt(points_cost, 10)), 1, now());
  res.json({ ok: true });
});

// --- Vendor: create earn token (QR) ---
app.post('/api/vendor/token', auth('vendor'), (req, res) => {
  const { transaction_ref } = req.body || {};
  const store = db.prepare('SELECT * FROM stores WHERE store_id=?').get(req.auth.store_id);
  const program = getProgram(store.merchant_id);

  const rl = rateLimit(`issue:${req.auth.staff_id}`, 120, 60);
  if (!rl.ok) return res.status(429).json({ error: 'rate_limited', retryAfter: rl.retryAfter });

  const token_id = id('t_');
  const t = now();
  const expires_at = t + (program.token_expiry_minutes * 60);
  const receipt_code = shortCode(4);

  db.prepare(`INSERT INTO earn_tokens(token_id, merchant_id, store_id, issued_by_staff_id, issued_at, expires_at, status, receipt_code, transaction_ref, ip_issued)
              VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(token_id, store.merchant_id, store.store_id, req.auth.staff_id, t, expires_at, 'ISSUED', receipt_code, transaction_ref || null, req.ip);

  const claimUrl = `${BASE_URL}/claim?token=${encodeURIComponent(token_id)}`;
  res.json({ token_id, claimUrl, expires_at, receipt_code });
});

// --- Customer: wallet + shop info ---
app.get('/api/customer/wallet', auth('customer'), (req, res) => {
  const merchants = db.prepare(`
    SELECT m.merchant_id, m.name, s.store_id, s.name as store_name
    FROM merchants m
    JOIN stores s ON s.merchant_id = m.merchant_id
    WHERE m.status='active'
    ORDER BY m.name ASC
  `).all();

  const out = merchants.map(x => ({
    merchant_id: x.merchant_id,
    merchant_name: x.name,
    store_id: x.store_id,
    store_name: x.store_name,
    balance: Math.max(0, getBalance(x.merchant_id, req.auth.customer_id))
  }));

  res.json({ accounts: out });
});

app.get('/api/customer/shop/:merchant_id', auth('customer'), (req, res) => {
  const merchant_id = req.params.merchant_id;
  const merchant = db.prepare('SELECT * FROM merchants WHERE merchant_id=? AND status="active"').get(merchant_id);
  if (!merchant) return res.status(404).json({ error: 'merchant_not_found' });

  const store = db.prepare('SELECT * FROM stores WHERE merchant_id=? ORDER BY created_at LIMIT 1').get(merchant_id);
  const program = getProgram(merchant_id);
  const rewards = db.prepare('SELECT * FROM rewards WHERE program_id=? AND active=1 ORDER BY points_cost ASC').all(program.program_id);

  res.json({
    merchant,
    store,
    program,
    rewards,
    balance: Math.max(0, getBalance(merchant_id, req.auth.customer_id))
  });
});

// --- Customer: claim earn token (adds an expiring lot) ---
app.post('/api/customer/claim', auth('customer'), (req, res) => {
  const { token_id, receipt_code } = req.body || {};
  if (!token_id) return res.status(400).json({ error: 'missing_token' });

  const token = db.prepare('SELECT * FROM earn_tokens WHERE token_id=?').get(token_id);
  if (!token) return res.status(404).json({ error: 'token_not_found' });
  if (token.status !== 'ISSUED') return res.status(400).json({ error: 'token_not_issued', status: token.status });
  if (now() > token.expires_at) return res.status(400).json({ error: 'token_expired' });

  if (receipt_code && String(receipt_code).trim().toUpperCase() !== String(token.receipt_code).toUpperCase()) {
    return res.status(400).json({ error: 'bad_receipt_code' });
  }

  const program = getProgram(token.merchant_id);

  if (program.max_earns_per_10min && program.max_earns_per_10min > 0) {
    const rl = rateLimit(`earn10:${token.merchant_id}:${req.auth.customer_id}`, program.max_earns_per_10min, 600);
    if (!rl.ok) return res.status(429).json({ error: 'rate_limited', retryAfter: rl.retryAfter });
  }
  if (program.max_earns_per_day && program.max_earns_per_day > 0) {
    const dayKey = new Date().toISOString().slice(0,10);
    const rl = rateLimit(`earnday:${token.merchant_id}:${req.auth.customer_id}:${dayKey}`, program.max_earns_per_day, 86400);
    if (!rl.ok) return res.status(429).json({ error: 'rate_limited', retryAfter: rl.retryAfter });
  }

  const t = now();
  const points = program.points_per_earn || 1;
  const expires_at = program.points_expire_days ? t + (program.points_expire_days * 86400) : null;

  const tx = db.transaction(() => {
    const fresh = db.prepare('SELECT * FROM earn_tokens WHERE token_id=?').get(token_id);
    if (fresh.status !== 'ISSUED') throw new Error('already_used');

    db.prepare(`UPDATE earn_tokens
                SET status='REDEEMED', redeemed_at=?, redeemed_by_customer_id=?, ip_redeemed=?, ua_redeemed=?
                WHERE token_id=?`)
      .run(t, req.auth.customer_id, req.ip, req.headers['user-agent'] || '', token_id);

    // Create the expiring lot (this is the real balance)
    addEarnLot({
      merchant_id: fresh.merchant_id,
      customer_id: req.auth.customer_id,
      points,
      expires_at,
      source_token_id: token_id,
      note: 'Earned point'
    });

    // Ledger for audit
    const ledger_id = id('l_');
    db.prepare(`INSERT INTO point_ledger(ledger_id, merchant_id, customer_id, event_type, points_delta, token_id, created_at, note)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(ledger_id, fresh.merchant_id, req.auth.customer_id, 'EARN', points, token_id, t, expires_at ? `Expires at ${expires_at}` : 'No expiry');

    const newBal = Math.max(0, getBalance(fresh.merchant_id, req.auth.customer_id));
    return { newBal, points };
  });

  try {
    const result = tx();
    res.json({ ok: true, merchant_id: token.merchant_id, points_added: result.points, new_balance: result.newBal });
  } catch (e) {
    if (String(e.message).includes('already_used')) return res.status(400).json({ error: 'token_already_used' });
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Customer: start redemption (creates pending redemption token + returns QR URL) ---
app.post('/api/customer/redeem/start', auth('customer'), (req, res) => {
  const { merchant_id, reward_id } = req.body || {};
  if (!merchant_id || !reward_id) return res.status(400).json({ error: 'missing_fields' });

  const merchant = db.prepare('SELECT * FROM merchants WHERE merchant_id=? AND status="active"').get(merchant_id);
  if (!merchant) return res.status(404).json({ error: 'merchant_not_found' });

  const program = getProgram(merchant_id);
  const reward = db.prepare('SELECT * FROM rewards WHERE reward_id=? AND active=1').get(reward_id);
  if (!program || !reward) return res.status(404).json({ error: 'not_found' });

  const bal = getBalance(merchant_id, req.auth.customer_id);
  if (bal < reward.points_cost) return res.status(400).json({ error: 'insufficient_points', balance: Math.max(0, bal) });

  // Create a redeem token (short-lived)
  const redeem_token = id('rt_');
  const redemption_id = id('x_');
  const t = now();
  const redeem_expires_at = t + 300; // 5 minutes

  db.prepare(`INSERT INTO redemptions(redemption_id, merchant_id, customer_id, reward_id, created_at, status, redeem_token, redeem_expires_at)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(redemption_id, merchant_id, req.auth.customer_id, reward_id, t, 'PENDING', redeem_token, redeem_expires_at);

  const redeemUrl = `${BASE_URL}/redeem?rt=${encodeURIComponent(redeem_token)}`;
  res.json({ ok: true, redeem_token, redeemUrl, redeem_expires_at, reward_name: reward.name, points_cost: reward.points_cost });
});

// Customer: check redemption status (for the "show QR" page)
app.get('/api/customer/redeem/status/:redeem_token', auth('customer'), (req, res) => {
  const redeem_token = req.params.redeem_token;
  const r = db.prepare('SELECT * FROM redemptions WHERE redeem_token=?').get(redeem_token);
  if (!r) return res.status(404).json({ error: 'not_found' });
  if (r.customer_id !== req.auth.customer_id) return res.status(403).json({ error: 'forbidden' });
  res.json({ status: r.status, redeem_expires_at: r.redeem_expires_at, completed_at: r.completed_at });
});

// --- Vendor: complete redemption (scan QR, validate, then deduct points + mark complete) ---
app.post('/api/vendor/redeem/complete', auth('vendor'), (req, res) => {
  const { redeem_token } = req.body || {};
  if (!redeem_token) return res.status(400).json({ error: 'missing_redeem_token' });

  const store = db.prepare('SELECT * FROM stores WHERE store_id=?').get(req.auth.store_id);
  const staff = db.prepare('SELECT * FROM staff WHERE staff_id=?').get(req.auth.staff_id);

  const redemption = db.prepare('SELECT * FROM redemptions WHERE redeem_token=?').get(redeem_token);
  if (!redemption) return res.status(404).json({ error: 'redemption_not_found' });
  if (redemption.status !== 'PENDING') return res.status(400).json({ error: 'not_pending', status: redemption.status });
  if (redemption.redeem_expires_at && now() > redemption.redeem_expires_at) return res.status(400).json({ error: 'redeem_token_expired' });
  if (redemption.merchant_id !== store.merchant_id) return res.status(403).json({ error: 'wrong_merchant' });

  const reward = db.prepare('SELECT * FROM rewards WHERE reward_id=? AND active=1').get(redemption.reward_id);
  if (!reward) return res.status(404).json({ error: 'reward_not_found' });

  const tx = db.transaction(() => {
    // Re-check inside tx
    const fresh = db.prepare('SELECT * FROM redemptions WHERE redeem_token=?').get(redeem_token);
    if (fresh.status !== 'PENDING') throw new Error('not_pending');

    // Deduct points FIFO from lots
    consumePointsFIFO({
      merchant_id: fresh.merchant_id,
      customer_id: fresh.customer_id,
      points_needed: reward.points_cost,
      redemption_id: fresh.redemption_id
    });

    // Mark complete
    const t = now();
    db.prepare(`UPDATE redemptions
                SET status='COMPLETED', completed_at=?, completed_by_staff_id=?, store_id=?
                WHERE redemption_id=?`)
      .run(t, req.auth.staff_id, store.store_id, fresh.redemption_id);

    // Ledger (audit)
    const ledger_id = id('l_');
    db.prepare(`INSERT INTO point_ledger(ledger_id, merchant_id, customer_id, event_type, points_delta, redemption_id, created_at, created_by_staff_id, note)
                VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(ledger_id, fresh.merchant_id, fresh.customer_id, 'REDEEM', -reward.points_cost, fresh.redemption_id, t, req.auth.staff_id, `Reward: ${reward.name}`);

    return { t, customer_id: fresh.customer_id };
  });

  try {
    const out = tx();
    const newBal = Math.max(0, getBalance(store.merchant_id, out.customer_id));
    res.json({ ok: true, reward_name: reward.name, new_balance: newBal });
  } catch (e) {
    if (String(e.message).includes('insufficient_points')) return res.status(400).json({ error: 'insufficient_points' });
    if (String(e.message).includes('not_pending')) return res.status(400).json({ error: 'not_pending' });
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Vendor: void earn token (refund/mistake) ---
app.post('/api/vendor/token/void', auth('vendor'), (req, res) => {
  const { token_id } = req.body || {};
  if (!token_id) return res.status(400).json({ error: 'missing_token' });

  const token = db.prepare('SELECT * FROM earn_tokens WHERE token_id=?').get(token_id);
  if (!token) return res.status(404).json({ error: 'token_not_found' });
  if (token.store_id !== req.auth.store_id) return res.status(403).json({ error: 'wrong_store' });
  if (token.status === 'VOIDED') return res.json({ ok: true });

  const program = getProgram(token.merchant_id);
  const points = program.points_per_earn || 1;

  const tx = db.transaction(() => {
    const fresh = db.prepare('SELECT * FROM earn_tokens WHERE token_id=?').get(token_id);
    if (fresh.status === 'VOIDED') return { ok: true };

    db.prepare(`UPDATE earn_tokens SET status='VOIDED' WHERE token_id=?`).run(token_id);

    if (fresh.status === 'REDEEMED' && fresh.redeemed_by_customer_id) {
      // Remove points from customer's available lots (FIFO), creating debt if needed
      removePoints({ merchant_id: fresh.merchant_id, customer_id: fresh.redeemed_by_customer_id, points_to_remove: points });

      const ledger_id = id('l_');
      db.prepare(`INSERT INTO point_ledger(ledger_id, merchant_id, customer_id, event_type, points_delta, token_id, created_at, created_by_staff_id, note)
                  VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(ledger_id, fresh.merchant_id, fresh.redeemed_by_customer_id, 'VOID_EARN', -points, token_id, now(), req.auth.staff_id, 'Voided by vendor');
    }

    return { ok: true };
  });

  try {
    const result = tx();
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- Pages shortcuts ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'customer.html')));
app.get('/vendor', (req, res) => res.sendFile(path.join(__dirname, 'public', 'vendor.html')));
app.get('/wallet', (req, res) => res.sendFile(path.join(__dirname, 'public', 'customer.html')));
app.get('/shop', (req, res) => res.sendFile(path.join(__dirname, 'public', 'shop.html')));
app.get('/claim', (req, res) => res.sendFile(path.join(__dirname, 'public', 'claim.html')));
app.get('/redeem', (req, res) => res.sendFile(path.join(__dirname, 'public', 'redeem.html')));
app.get('/receipt', (req, res) => res.sendFile(path.join(__dirname, 'public', 'receipt.html')));

app.listen(PORT, () => {
  console.log(`Loyalty MVP v0.2 running on ${BASE_URL}`);
  console.log(`Run setup once: ${BASE_URL}/admin/setup?key=${ADMIN_SETUP_KEY}`);
});

const Database = require('better-sqlite3');

function initDb(dbPath = 'loyalty.sqlite') {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS merchants (
      merchant_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS stores (
      store_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      name TEXT NOT NULL,
      address TEXT,
      timezone TEXT DEFAULT 'Europe/London',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
    );

    CREATE TABLE IF NOT EXISTS staff (
      staff_id TEXT PRIMARY KEY,
      store_id TEXT NOT NULL,
      email TEXT,
      pin_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'cashier',
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      last_login_at INTEGER,
      FOREIGN KEY (store_id) REFERENCES stores(store_id)
    );

    CREATE TABLE IF NOT EXISTS customers (
      customer_id TEXT PRIMARY KEY,
      google_sub TEXT UNIQUE,
      email TEXT NOT NULL,
      email_verified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS loyalty_programs (
      program_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      points_per_earn INTEGER NOT NULL DEFAULT 1,
      token_expiry_minutes INTEGER NOT NULL DEFAULT 120,
      points_expire_days INTEGER, -- NULL = never
      max_earns_per_day INTEGER DEFAULT 0, -- 0 = unlimited
      max_earns_per_10min INTEGER DEFAULT 0, -- 0 = unlimited
      created_at INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id)
    );

    CREATE TABLE IF NOT EXISTS rewards (
      reward_id TEXT PRIMARY KEY,
      program_id TEXT NOT NULL,
      name TEXT NOT NULL,
      points_cost INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (program_id) REFERENCES loyalty_programs(program_id)
    );

    -- EARN tokens shown as QR by vendor
    CREATE TABLE IF NOT EXISTS earn_tokens (
      token_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      store_id TEXT NOT NULL,
      issued_by_staff_id TEXT NOT NULL,
      issued_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL, -- ISSUED, REDEEMED, VOIDED
      redeemed_at INTEGER,
      redeemed_by_customer_id TEXT,
      receipt_code TEXT,
      transaction_ref TEXT,
      ip_issued TEXT,
      ip_redeemed TEXT,
      ua_redeemed TEXT,
      FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id),
      FOREIGN KEY (store_id) REFERENCES stores(store_id)
    );
    CREATE INDEX IF NOT EXISTS idx_tokens_store_status ON earn_tokens(store_id, status);

    -- Points stored as "lots" so expiry is real and redemption consumes the oldest lots first.
    CREATE TABLE IF NOT EXISTS point_lots (
      lot_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      points_remaining INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER, -- NULL = never
      source_token_id TEXT,
      note TEXT,
      FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id),
      FOREIGN KEY (customer_id) REFERENCES customers(customer_id)
    );
    CREATE INDEX IF NOT EXISTS idx_lots_customer ON point_lots(merchant_id, customer_id, expires_at, created_at);

    -- Ledger for audit (human readable history)
    CREATE TABLE IF NOT EXISTS point_ledger (
      ledger_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      event_type TEXT NOT NULL, -- EARN, REDEEM, VOID_EARN, ADJUST
      points_delta INTEGER NOT NULL,
      token_id TEXT,
      redemption_id TEXT,
      created_at INTEGER NOT NULL,
      created_by_staff_id TEXT,
      note TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ledger_customer ON point_ledger(customer_id, merchant_id, created_at);

    -- Redemption flow: customer creates PENDING redemption + redeem_token; vendor completes it.
    CREATE TABLE IF NOT EXISTS redemptions (
      redemption_id TEXT PRIMARY KEY,
      merchant_id TEXT NOT NULL,
      customer_id TEXT NOT NULL,
      reward_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL, -- PENDING, COMPLETED, VOIDED, EXPIRED
      redeem_token TEXT UNIQUE,
      redeem_expires_at INTEGER,
      completed_at INTEGER,
      completed_by_staff_id TEXT,
      store_id TEXT,
      FOREIGN KEY (merchant_id) REFERENCES merchants(merchant_id),
      FOREIGN KEY (customer_id) REFERENCES customers(customer_id),
      FOREIGN KEY (reward_id) REFERENCES rewards(reward_id)
    );
    CREATE INDEX IF NOT EXISTS idx_redemption_token ON redemptions(redeem_token);

    -- How redemptions consumed lots (for audit/debug)
    CREATE TABLE IF NOT EXISTS redemption_consumptions (
      redemption_id TEXT NOT NULL,
      lot_id TEXT NOT NULL,
      points_used INTEGER NOT NULL,
      PRIMARY KEY (redemption_id, lot_id),
      FOREIGN KEY (redemption_id) REFERENCES redemptions(redemption_id),
      FOREIGN KEY (lot_id) REFERENCES point_lots(lot_id)
    );

    CREATE TABLE IF NOT EXISTS rate_limits (
      key TEXT PRIMARY KEY,
      count INTEGER NOT NULL,
      window_start INTEGER NOT NULL,
      window_seconds INTEGER NOT NULL
    );
  `);

  return db;
}

module.exports = { initDb };

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_SETTINGS = {
  sacco_name: 'Umoja SACCO',
  currency: 'UGX',
  share_price: '20000',          // price of one share
  registration_fee: '20000',
  min_shares: '5',               // shares needed before borrowing
  savings_multiplier: '3',       // loan limit = savings x this
  min_savings_months: '3',       // must have saved this long before borrowing
  min_guarantors: '2',
  penalty_rate: '2',             // % of the overdue installment
  penalty_frequency: 'once',     // 'once' per missed installment, or 'weekly' while overdue
  board_threshold: '5000000',    // loans above this need board approval
  reminder_days: '3',            // SMS reminder this many days before due date
  session_hours: '8',
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY,
  member_no TEXT UNIQUE,
  full_name TEXT NOT NULL,
  nin TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  email TEXT, address TEXT, date_of_birth TEXT, gender TEXT, occupation TEXT,
  next_of_kin_name TEXT, next_of_kin_phone TEXT, next_of_kin_relation TEXT,
  photo TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','dormant','exited')),
  joined_at TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','manager','board','loan_officer','cashier','member')),
  member_id INTEGER UNIQUE REFERENCES members(id),
  password_hash TEXT NOT NULL,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS loan_types (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  interest_rate REAL NOT NULL,   -- flat % per month on the principal
  max_months INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY,
  loan_no TEXT UNIQUE,
  member_id INTEGER NOT NULL REFERENCES members(id),
  loan_type_id INTEGER NOT NULL REFERENCES loan_types(id),
  principal INTEGER NOT NULL CHECK (principal > 0),
  interest_rate REAL NOT NULL,
  months INTEGER NOT NULL CHECK (months > 0),
  total_interest INTEGER NOT NULL,
  total_payable INTEGER NOT NULL,
  installment INTEGER NOT NULL,
  purpose TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending','officer_approved','manager_approved','approved','rejected','active','closed')),
  applied_by INTEGER REFERENCES users(id),
  applied_at TEXT NOT NULL,
  disbursed_at TEXT, disburse_method TEXT, disburse_reference TEXT, disbursed_by INTEGER,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS loan_guarantors (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  responded_at TEXT,
  recorded_by INTEGER,
  UNIQUE (loan_id, member_id)
);

CREATE TABLE IF NOT EXISTS loan_approvals (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  level TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('approved','rejected')),
  comment TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS loan_schedule (
  id INTEGER PRIMARY KEY,
  loan_id INTEGER NOT NULL REFERENCES loans(id),
  installment_no INTEGER NOT NULL,
  due_date TEXT NOT NULL,
  principal_due INTEGER NOT NULL,
  interest_due INTEGER NOT NULL,
  amount_due INTEGER NOT NULL,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  penalty INTEGER NOT NULL DEFAULT 0,
  penalty_paid INTEGER NOT NULL DEFAULT 0,
  penalty_periods INTEGER NOT NULL DEFAULT 0,
  reminder_sent INTEGER NOT NULL DEFAULT 0,
  UNIQUE (loan_id, installment_no)
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  type TEXT NOT NULL CHECK (type IN ('deposit','withdrawal','share_purchase','share_refund','registration_fee',
                                     'loan_disbursement','loan_repayment','dividend','reversal')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  units INTEGER,
  method TEXT,
  reference TEXT,
  narration TEXT,
  loan_id INTEGER REFERENCES loans(id),
  reversal_of INTEGER REFERENCES transactions(id),
  reversed INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_txn_member ON transactions(member_id, created_at);
CREATE INDEX IF NOT EXISTS ix_txn_date ON transactions(created_at);
CREATE INDEX IF NOT EXISTS ix_txn_loan ON transactions(loan_id);

CREATE TABLE IF NOT EXISTS reversal_requests (
  id INTEGER PRIMARY KEY,
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at TEXT NOT NULL,
  decided_by INTEGER REFERENCES users(id),
  decided_at TEXT,
  decision_comment TEXT
);

CREATE TABLE IF NOT EXISTS dividends (
  id INTEGER PRIMARY KEY,
  year INTEGER NOT NULL UNIQUE,
  total_profit INTEGER NOT NULL,
  share_pct REAL NOT NULL,
  rate_per_share REAL NOT NULL,
  savings_rate REAL NOT NULL,
  total_paid INTEGER NOT NULL,
  declared_by INTEGER NOT NULL REFERENCES users(id),
  declared_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dividend_payouts (
  id INTEGER PRIMARY KEY,
  dividend_id INTEGER NOT NULL REFERENCES dividends(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  share_units INTEGER NOT NULL,
  savings_balance INTEGER NOT NULL,
  share_amount INTEGER NOT NULL,
  savings_amount INTEGER NOT NULL,
  total INTEGER NOT NULL,
  transaction_id INTEGER REFERENCES transactions(id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  member_id INTEGER REFERENCES members(id),
  phone TEXT,
  channel TEXT NOT NULL DEFAULT 'sms',
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL,
  sent_at TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id INTEGER,
  details TEXT,
  ip TEXT,
  created_at TEXT NOT NULL
);

-- Fraud controls enforced by the database itself
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
  BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS txn_no_delete BEFORE DELETE ON transactions
  BEGIN SELECT RAISE(ABORT, 'transactions cannot be deleted; post a reversal instead'); END;
CREATE TRIGGER IF NOT EXISTS txn_immutable BEFORE UPDATE ON transactions
  WHEN NEW.amount <> OLD.amount OR NEW.member_id <> OLD.member_id OR NEW.type <> OLD.type
    OR NEW.created_at <> OLD.created_at OR IFNULL(NEW.units,0) <> IFNULL(OLD.units,0)
    OR IFNULL(NEW.loan_id,0) <> IFNULL(OLD.loan_id,0) OR (OLD.reversed = 1 AND NEW.reversed = 0)
  BEGIN SELECT RAISE(ABORT, 'transactions are immutable; post a reversal instead'); END;
`;

const DEFAULT_LOAN_TYPES = [
  ['School Fees', 1.0, 12],
  ['Business', 1.0, 18],
  ['Emergency', 1.0, 6],
  ['Agriculture', 1.0, 12],
  ['Asset', 1.5, 24],
];

export function openDb(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  if (db.prepare('SELECT COUNT(*) n FROM loan_types').get().n === 0) {
    const lt = db.prepare('INSERT INTO loan_types (name, interest_rate, max_months) VALUES (?, ?, ?)');
    for (const t of DEFAULT_LOAN_TYPES) lt.run(...t);
  }
  return db;
}

let depth = 0;
export function transaction(db, fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

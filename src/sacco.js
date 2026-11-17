import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { transaction } from './db.js';
import { today, now, addMonths, addDays, daysBetween } from './util.js';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = (message, status = 400) => { throw new HttpError(status, message); };

export const ROLES = ['admin', 'manager', 'board', 'loan_officer', 'cashier', 'member'];
export const METHODS = ['cash', 'mobile_money', 'bank'];
const OPEN_LOAN = ['pending', 'officer_approved', 'manager_approved', 'approved', 'active'];
const IN_OPEN = `(${OPEN_LOAN.map((s) => `'${s}'`).join(',')})`;
const LEVEL_ROLES = { officer: ['loan_officer', 'manager'], manager: ['manager'], board: ['board'] };
const NEXT_LEVEL = { pending: 'officer', officer_approved: 'manager', manager_approved: 'board' };

// Effect of each transaction type on member savings and on the cash drawer.
const SAVINGS_EFFECT = { deposit: 1, withdrawal: -1, dividend: 1 };
export const CASH_EFFECT = {
  deposit: 1, withdrawal: -1, share_purchase: 1, share_refund: -1, registration_fee: 1,
  loan_disbursement: -1, loan_repayment: 1, dividend: 0,
};
const TELLER_TYPES = ['deposit', 'withdrawal', 'share_purchase', 'registration_fee'];

// SQL fragments for balances (reversed transactions and reversal rows cancel out, so both are skipped)
const SAVINGS_SQL = `SUM(CASE WHEN type IN ('deposit','dividend') THEN amount WHEN type='withdrawal' THEN -amount ELSE 0 END)`;
const UNITS_SQL = `SUM(CASE WHEN type='share_purchase' THEN units WHEN type='share_refund' THEN -units ELSE 0 END)`;
const SHARE_VALUE_SQL = `SUM(CASE WHEN type='share_purchase' THEN amount WHEN type='share_refund' THEN -amount ELSE 0 END)`;
const LIVE = `reversed=0 AND type<>'reversal'`;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString('hex')}:${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const calc = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(calc, Buffer.from(hash, 'hex'));
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

function int(v, name, { min = 1, max = 1e13 } = {}) {
  const n = typeof v === 'string' ? Number(v.replace(/,/g, '').trim()) : Number(v);
  if (v === '' || v == null || !Number.isInteger(n)) fail(`${name} must be a whole number`);
  if (n < min) fail(`${name} must be at least ${min.toLocaleString('en-US')}`);
  if (n > max) fail(`${name} must be at most ${max.toLocaleString('en-US')}`);
  return n;
}
function str(v, name, { required = false, max = 200 } = {}) {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) fail(`${name} is required`);
  if (s.length > max) fail(`${name} is too long (max ${max} characters)`);
  return s || null;
}
function validatePassword(p) {
  if (typeof p !== 'string' || p.length < 8) fail('Password must be at least 8 characters');
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) fail('Password must contain both letters and numbers');
}

export function createSacco(db, { backupDir = 'backups' } = {}) {
  const cache = new Map();
  const st = (sql) => { let s = cache.get(sql); if (!s) { s = db.prepare(sql); cache.set(sql, s); } return s; };
  const get = (sql, ...p) => st(sql).get(...p);
  const all = (sql, ...p) => st(sql).all(...p);
  const run = (sql, ...p) => st(sql).run(...p);
  const tx = (fn) => transaction(db, fn);

  // ---------------------------------------------------------------- settings
  function settings() {
    const o = {};
    for (const r of all('SELECT key, value FROM settings')) o[r.key] = r.value;
    return o;
  }
  const setting = (k) => settings()[k];
  const numSetting = (k) => Number(settings()[k]);
  const money = (n) => `${setting('currency')} ${Math.round(n).toLocaleString('en-US')}`;
  const firstName = (m) => String(m.full_name).split(/\s+/)[0];

  const SETTING_RULES = {
    sacco_name: 'text', currency: 'text', share_price: 'int', registration_fee: 'int0',
    min_shares: 'int0', savings_multiplier: 'num', min_savings_months: 'int0', min_guarantors: 'int0',
    penalty_rate: 'num', penalty_frequency: ['once', 'weekly'], board_threshold: 'int',
    reminder_days: 'int0', session_hours: 'int',
  };

  function updateSettings(body, actor, ip) {
    const old = settings();
    const changed = {};
    for (const [k, v] of Object.entries(body || {})) {
      const rule = SETTING_RULES[k];
      if (!rule) continue;
      let val;
      if (Array.isArray(rule)) { if (!rule.includes(v)) fail(`${k} must be one of ${rule.join(', ')}`); val = v; }
      else if (rule === 'text') val = str(v, k, { required: true, max: 80 });
      else if (rule === 'int') val = String(int(v, k, { min: 1 }));
      else if (rule === 'int0') val = String(int(v, k, { min: 0 }));
      else { const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 100) fail(`${k} must be a number between 0 and 100`); val = String(n); }
      if (val !== old[k]) changed[k] = { from: old[k], to: val };
    }
    tx(() => {
      for (const [k, c] of Object.entries(changed)) run('UPDATE settings SET value=? WHERE key=?', c.to, k);
      if (Object.keys(changed).length) audit(actor, 'settings_updated', 'settings', null, changed, ip);
    });
    return settings();
  }

  // ---------------------------------------------------------------- audit & notifications
  function audit(user, action, entity, entityId, details, ip) {
    run(`INSERT INTO audit_log (user_id, username, action, entity, entity_id, details, ip, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      user?.id ?? null, user?.username ?? 'system', action, entity ?? null, entityId ?? null,
      details ? JSON.stringify(details) : null, ip ?? null, now());
  }

  function notify(memberId, message) {
    const m = get('SELECT phone FROM members WHERE id=?', memberId);
    const id = run(`INSERT INTO notifications (member_id, phone, channel, message, status, created_at) VALUES (?,?,?,?,?,?)`,
      memberId, m?.phone ?? null, 'sms', message, 'queued', now()).lastInsertRowid;
    // SMS / WhatsApp gateway hook: connect a provider here (e.g. Africa's Talking, Twilio, MTN).
    // Without a gateway configured, delivery is simulated and the message stays visible in the outbox.
    run(`UPDATE notifications SET status='simulated', sent_at=? WHERE id=?`, now(), id);
  }

  function listNotifications(user) {
    if (user.role === 'member') {
      return all('SELECT * FROM notifications WHERE member_id=? ORDER BY id DESC LIMIT 200', user.member_id);
    }
    return all(`SELECT n.*, m.member_no, m.full_name FROM notifications n LEFT JOIN members m ON m.id=n.member_id
                ORDER BY n.id DESC LIMIT 300`);
  }

  // ---------------------------------------------------------------- auth & users
  const failures = new Map();
  const publicUser = (u) => ({
    id: u.id, username: u.username, full_name: u.full_name, role: u.role,
    member_id: u.member_id, must_change_password: !!u.must_change_password,
  });

  function login(username, password, ip) {
    const key = `${String(username ?? '').toLowerCase()}|${ip}`;
    const f = failures.get(key);
    const recent = f && Date.now() - f.last < 5 * 60 * 1000;
    if (recent && f.count >= 5) fail('Too many failed attempts. Try again in 5 minutes.', 429);
    const u = get('SELECT * FROM users WHERE username=?', String(username ?? ''));
    if (!u || !u.active || !verifyPassword(String(password ?? ''), u.password_hash)) {
      failures.set(key, { count: (recent ? f.count : 0) + 1, last: Date.now() });
      audit(u ? publicUser(u) : null, 'login_failed', 'user', u?.id, { username: String(username ?? '').slice(0, 40) }, ip);
      fail('Invalid username or password', 401);
    }
    failures.delete(key);
    if (u.member_id && get('SELECT status FROM members WHERE id=?', u.member_id)?.status === 'exited') {
      fail('This membership has been closed', 403);
    }
    const token = crypto.randomBytes(32).toString('hex');
    const hours = numSetting('session_hours') || 8;
    run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?,?,?)', sha(token), u.id, Date.now() + hours * 3600e3);
    run('UPDATE users SET last_login_at=? WHERE id=?', now(), u.id);
    audit(publicUser(u), 'login', 'user', u.id, null, ip);
    return { token, maxAge: hours * 3600, user: publicUser(u) };
  }

  function sessionUser(token) {
    if (!token) return null;
    const r = get(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`, sha(token));
    if (!r || r.expires_at < Date.now() || !r.active) return null;
    return publicUser(r);
  }

  function logout(token) { if (token) run('DELETE FROM sessions WHERE token_hash=?', sha(token)); }

  function changePassword(user, current, next, ip) {
    const u = get('SELECT * FROM users WHERE id=?', user.id);
    if (!verifyPassword(String(current ?? ''), u.password_hash)) fail('Current password is incorrect');
    validatePassword(next);
    if (current === next) fail('New password must be different');
    run('UPDATE users SET password_hash=?, must_change_password=0 WHERE id=?', hashPassword(next), user.id);
    audit(user, 'password_changed', 'user', user.id, null, ip);
    return { ok: true };
  }

  function ensureAdmin() {
    if (get('SELECT COUNT(*) n FROM users').n > 0) return null;
    const password = process.env.SACCO_ADMIN_PASSWORD || `Sacco-${crypto.randomBytes(4).toString('hex')}1`;
    run(`INSERT INTO users (username, full_name, role, password_hash, must_change_password, created_at)
         VALUES ('admin','System Administrator','admin',?,1,?)`, hashPassword(password), now());
    return password;
  }

  function listUsers() {
    return all(`SELECT u.id, u.username, u.full_name, u.role, u.member_id, u.active, u.created_at, u.last_login_at, m.member_no
                FROM users u LEFT JOIN members m ON m.id=u.member_id ORDER BY u.role='member', u.role, u.username`);
  }

  function createUser(b, actor, ip) {
    const username = str(b.username, 'Username', { required: true, max: 40 });
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) fail('Username: 3-40 letters, numbers, dot, dash or underscore');
    if (!ROLES.includes(b.role) || b.role === 'member') fail('Choose a staff role (member logins are created from the member profile)');
    validatePassword(b.password);
    if (get('SELECT 1 FROM users WHERE username=?', username)) fail('Username already taken');
    const id = Number(run(`INSERT INTO users (username, full_name, role, password_hash, must_change_password, created_at)
                           VALUES (?,?,?,?,1,?)`,
      username, str(b.full_name, 'Full name', { required: true }), b.role, hashPassword(b.password), now()).lastInsertRowid);
    audit(actor, 'user_created', 'user', id, { username, role: b.role }, ip);
    return { id };
  }

  function updateUser(id, b, actor, ip) {
    const u = get('SELECT * FROM users WHERE id=?', id) || fail('User not found', 404);
    const changes = {};
    if (b.full_name !== undefined) changes.full_name = str(b.full_name, 'Full name', { required: true });
    if (b.role !== undefined && u.role !== 'member') {
      if (!ROLES.includes(b.role) || b.role === 'member') fail('Invalid role');
      if (u.id === actor.id && b.role !== 'admin') fail('You cannot remove your own admin role');
      changes.role = b.role;
    }
    if (b.active !== undefined) {
      const a = b.active ? 1 : 0;
      if (u.id === actor.id && !a) fail('You cannot deactivate your own account');
      changes.active = a;
    }
    if (b.password) { validatePassword(b.password); changes.password_hash = hashPassword(b.password); changes.must_change_password = 1; }
    tx(() => {
      for (const [k, v] of Object.entries(changes)) db.prepare(`UPDATE users SET ${k}=? WHERE id=?`).run(v, id);
      if (changes.active === 0 || changes.password_hash) run('DELETE FROM sessions WHERE user_id=?', id);
      const logged = { ...changes };
      if (logged.password_hash) { logged.password = 'reset'; delete logged.password_hash; }
      audit(actor, 'user_updated', 'user', id, logged, ip);
    });
    return { ok: true };
  }

  // ---------------------------------------------------------------- loan types
  const listLoanTypes = () => all('SELECT * FROM loan_types ORDER BY active DESC, name');

  function saveLoanType(id, b, actor, ip) {
    const name = str(b.name, 'Name', { required: true, max: 60 });
    const rate = Number(b.interest_rate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 20) fail('Interest rate must be between 0 and 20 % per month');
    const maxMonths = int(b.max_months, 'Maximum months', { min: 1, max: 120 });
    const active = b.active === undefined ? 1 : (b.active ? 1 : 0);
    if (get('SELECT 1 FROM loan_types WHERE name=? AND id<>?', name, id ?? 0)) fail('A loan type with that name exists');
    if (id) {
      get('SELECT 1 FROM loan_types WHERE id=?', id) || fail('Loan type not found', 404);
      run('UPDATE loan_types SET name=?, interest_rate=?, max_months=?, active=? WHERE id=?', name, rate, maxMonths, active, id);
    } else {
      id = Number(run('INSERT INTO loan_types (name, interest_rate, max_months, active) VALUES (?,?,?,?)', name, rate, maxMonths, active).lastInsertRowid);
    }
    audit(actor, 'loan_type_saved', 'loan_type', id, { name, rate, maxMonths, active }, ip);
    return { id };
  }

  // ---------------------------------------------------------------- members
  const memberRow = (id) => get('SELECT * FROM members WHERE id=?', Number(id)) || fail('Member not found', 404);
  const memberByNo = (no) => get('SELECT * FROM members WHERE member_no=?', String(no ?? '').trim().toUpperCase());

  function resolveMember(b) {
    if (b.member_id) return memberRow(b.member_id);
    if (b.member_no) return memberByNo(b.member_no) || fail(`Member ${b.member_no} not found`, 404);
    return fail('Select a member');
  }

  function balances(memberId) {
    const b = get(`SELECT COALESCE(${SAVINGS_SQL},0) savings, COALESCE(${UNITS_SQL},0) share_units,
                          COALESCE(${SHARE_VALUE_SQL},0) share_value
                   FROM transactions WHERE member_id=? AND ${LIVE}`, memberId);
    const loan = get(`SELECT COALESCE(SUM(s.amount_due + s.penalty - s.amount_paid - s.penalty_paid),0) bal,
                             COALESCE(SUM(DISTINCT l.principal),0) principal
                      FROM loans l JOIN loan_schedule s ON s.loan_id=l.id
                      WHERE l.member_id=? AND l.status='active'`, memberId);
    const mult = numSetting('savings_multiplier') || 1;
    const locked = loan.bal > 0 ? Math.min(b.savings, Math.ceil(loan.principal / mult)) : 0;
    return {
      savings: b.savings, share_units: b.share_units, share_value: b.share_value,
      loan_balance: loan.bal, locked_savings: locked,
      loan_limit: Math.floor(b.savings * mult),
    };
  }

  const MEMBER_FIELDS = ['full_name', 'nin', 'phone', 'email', 'address', 'date_of_birth', 'gender', 'occupation',
    'next_of_kin_name', 'next_of_kin_phone', 'next_of_kin_relation', 'photo'];

  function cleanMember(b) {
    const m = {
      full_name: str(b.full_name, 'Full name', { required: true, max: 120 }),
      nin: str(b.nin, 'NIN', { required: true, max: 20 })?.toUpperCase(),
      phone: str(b.phone, 'Phone', { required: true, max: 20 })?.replace(/\s+/g, ''),
      email: str(b.email, 'Email', { max: 120 }),
      address: str(b.address, 'Address', { max: 200 }),
      date_of_birth: str(b.date_of_birth, 'Date of birth', { max: 10 }),
      gender: str(b.gender, 'Gender', { max: 10 }),
      occupation: str(b.occupation, 'Occupation', { max: 80 }),
      next_of_kin_name: str(b.next_of_kin_name, 'Next of kin name', { required: true, max: 120 }),
      next_of_kin_phone: str(b.next_of_kin_phone, 'Next of kin phone', { required: true, max: 20 })?.replace(/\s+/g, ''),
      next_of_kin_relation: str(b.next_of_kin_relation, 'Next of kin relationship', { max: 40 }),
      photo: b.photo ? String(b.photo) : null,
    };
    if (!/^[A-Z0-9]{8,20}$/.test(m.nin)) fail('NIN should be 8-20 letters/numbers (e.g. CM90012345ABCD)');
    if (!/^\+?\d{9,13}$/.test(m.phone)) fail('Phone should be 9-13 digits, e.g. 0772123456 or +256772123456');
    if (!/^\+?\d{9,13}$/.test(m.next_of_kin_phone)) fail('Next of kin phone should be 9-13 digits');
    if (m.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(m.email)) fail('Email address is not valid');
    if (m.date_of_birth && !/^\d{4}-\d{2}-\d{2}$/.test(m.date_of_birth)) fail('Date of birth must be YYYY-MM-DD');
    if (m.photo && (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(m.photo) || m.photo.length > 600000)) {
      fail('Photo must be a PNG/JPEG image under ~400 KB');
    }
    return m;
  }

  function createMember(b, user, ip) {
    const m = cleanMember(b);
    if (get('SELECT 1 FROM members WHERE nin=?', m.nin)) fail('A member with that NIN is already registered');
    const initialShares = b.initial_shares ? int(b.initial_shares, 'Initial shares', { min: 0 }) : 0;
    const initialDeposit = b.initial_deposit ? int(b.initial_deposit, 'Initial deposit', { min: 0 }) : 0;
    const method = b.method || 'cash';
    if (b.create_login) validatePassword(b.password);
    return tx(() => {
      const id = Number(run(`INSERT INTO members (${MEMBER_FIELDS.join(',')}, status, joined_at, created_by, created_at)
                             VALUES (${MEMBER_FIELDS.map(() => '?').join(',')}, 'active', ?, ?, ?)`,
        ...MEMBER_FIELDS.map((f) => m[f]), today(), user.id, now()).lastInsertRowid);
      const memberNo = `M${String(id).padStart(5, '0')}`;
      run('UPDATE members SET member_no=? WHERE id=?', memberNo, id);
      audit(user, 'member_registered', 'member', id, { member_no: memberNo, full_name: m.full_name, nin: m.nin }, ip);
      notify(id, `Welcome to ${setting('sacco_name')}, ${m.full_name.split(/\s+/)[0]}! Your member number is ${memberNo}.`);
      const common = { member_id: id, method, reference: b.reference };
      if (b.pay_registration_fee && numSetting('registration_fee') > 0) {
        teller({ ...common, type: 'registration_fee', amount: numSetting('registration_fee') }, user, ip);
      }
      if (initialShares > 0) teller({ ...common, type: 'share_purchase', units: initialShares }, user, ip);
      if (initialDeposit > 0) teller({ ...common, type: 'deposit', amount: initialDeposit }, user, ip);
      if (b.create_login) createMemberLogin(id, b.password, user, ip);
      return { id, member_no: memberNo };
    });
  }

  function updateMember(id, b, user, ip) {
    const old = memberRow(id);
    const m = cleanMember({ ...old, ...b, photo: b.photo === undefined ? old.photo : b.photo });
    if (get('SELECT 1 FROM members WHERE nin=? AND id<>?', m.nin, old.id)) fail('Another member has that NIN');
    const changed = {};
    for (const f of MEMBER_FIELDS) if ((old[f] ?? null) !== (m[f] ?? null)) changed[f] = f === 'photo' ? '(photo changed)' : { from: old[f], to: m[f] };
    tx(() => {
      run(`UPDATE members SET ${MEMBER_FIELDS.map((f) => `${f}=?`).join(', ')} WHERE id=?`, ...MEMBER_FIELDS.map((f) => m[f]), old.id);
      audit(user, 'member_updated', 'member', old.id, changed, ip);
    });
    return { ok: true };
  }

  function setMemberStatus(id, b, user, ip) {
    const m = memberRow(id);
    const status = b.status;
    if (!['active', 'dormant', 'exited'].includes(status)) fail('Invalid status');
    if (m.status === 'exited') fail('An exited member cannot be reactivated; register them again');
    if (status === m.status) fail(`Member is already ${status}`);
    const reason = str(b.reason, 'Reason', { required: true, max: 300 });
    return tx(() => {
      if (status === 'exited') {
        const open = get(`SELECT loan_no FROM loans WHERE member_id=? AND status IN ${IN_OPEN}`, m.id);
        if (open) fail(`Member has an open loan (${open.loan_no}). Clear it before exiting.`);
        const guar = get(`SELECT l.loan_no FROM loan_guarantors g JOIN loans l ON l.id=g.loan_id
                          WHERE g.member_id=? AND g.status<>'declined' AND l.status IN ${IN_OPEN}`, m.id);
        if (guar) fail(`Member is guaranteeing open loan ${guar.loan_no}. Replace the guarantor first.`);
        const bal = balances(m.id);
        if (bal.savings > 0) fail(`Withdraw the remaining savings (${money(bal.savings)}) before exiting.`);
        if (bal.share_units > 0) {
          const method = METHODS.includes(b.method) ? b.method : 'cash';
          insertTxn({ member_id: m.id, type: 'share_refund', amount: bal.share_value, units: bal.share_units, method,
            reference: str(b.reference, 'Reference', { max: 60 }), narration: 'Share refund on exit' }, user);
        }
        run('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE member_id=?)', m.id);
        run('UPDATE users SET active=0 WHERE member_id=?', m.id);
      }
      run('UPDATE members SET status=? WHERE id=?', status, m.id);
      audit(user, 'member_status_changed', 'member', m.id, { from: m.status, to: status, reason }, ip);
      notify(m.id, `Dear ${firstName(m)}, your ${setting('sacco_name')} membership status is now ${status.toUpperCase()}.`);
      return { ok: true };
    });
  }

  function createMemberLogin(memberId, password, user, ip) {
    const m = memberRow(memberId);
    if (get('SELECT 1 FROM users WHERE member_id=?', m.id)) fail('This member already has a portal login');
    validatePassword(password);
    run(`INSERT INTO users (username, full_name, role, member_id, password_hash, must_change_password, created_at)
         VALUES (?,?,'member',?,?,1,?)`, m.member_no, m.full_name, m.id, hashPassword(password), now());
    audit(user, 'member_login_created', 'member', m.id, { username: m.member_no }, ip);
    notify(m.id, `Your member portal login is ready. Username: ${m.member_no}. You will be asked to change your password on first login.`);
    return { username: m.member_no };
  }

  function listMembers({ q = '', status = '' } = {}) {
    const like = `%${q}%`;
    return all(`SELECT m.id, m.member_no, m.full_name, m.phone, m.nin, m.status, m.joined_at,
                  COALESCE(b.savings,0) savings, COALESCE(b.units,0) share_units, COALESCE(b.share_value,0) share_value,
                  COALESCE((SELECT SUM(s.amount_due+s.penalty-s.amount_paid-s.penalty_paid) FROM loan_schedule s
                            JOIN loans l ON l.id=s.loan_id WHERE l.member_id=m.id AND l.status='active'),0) loan_balance
                FROM members m
                LEFT JOIN (SELECT member_id, ${SAVINGS_SQL} savings, ${UNITS_SQL} units, ${SHARE_VALUE_SQL} share_value
                           FROM transactions WHERE ${LIVE} GROUP BY member_id) b ON b.member_id=m.id
                WHERE (?='' OR m.full_name LIKE ? OR m.member_no LIKE ? OR m.phone LIKE ? OR m.nin LIKE ?)
                  AND (?='' OR m.status=?)
                ORDER BY m.id DESC LIMIT 1000`, q, like, like, like, like, status, status);
  }

  function memberDetail(id) {
    const member = memberRow(id);
    const login = get('SELECT username, active, last_login_at FROM users WHERE member_id=?', member.id) ?? null;
    return {
      member, login,
      balances: balances(member.id),
      loans: listLoans({ member_id: member.id }),
      guarantees: myGuarantees(member.id),
      recent: all(`SELECT t.*, u.username created_by_name, o.type orig_type FROM transactions t
                   LEFT JOIN users u ON u.id=t.created_by LEFT JOIN transactions o ON o.id=t.reversal_of
                   WHERE t.member_id=? ORDER BY t.created_at DESC, t.id DESC LIMIT 15`, member.id),
    };
  }

  function lookup(no) {
    const m = memberByNo(no) || fail(`No member with number ${no}`, 404);
    return { id: m.id, member_no: m.member_no, full_name: m.full_name, status: m.status };
  }

  // ---------------------------------------------------------------- transactions
  function insertTxn(t, user) {
    return Number(run(`INSERT INTO transactions (member_id, type, amount, units, method, reference, narration, loan_id, reversal_of, created_by, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      t.member_id, t.type, t.amount, t.units ?? null, t.method ?? null, t.reference ?? null, t.narration ?? null,
      t.loan_id ?? null, t.reversal_of ?? null, user?.id ?? null, now()).lastInsertRowid);
  }

  function teller(b, user, ip) {
    const type = b.type;
    if (!TELLER_TYPES.includes(type)) fail('Choose a transaction type');
    const member = resolveMember(b);
    if (member.status === 'exited') fail('This member has exited the SACCO');
    if (!METHODS.includes(b.method)) fail('Choose a payment method');
    const reference = str(b.reference, 'Reference', { max: 60 });
    if (b.method !== 'cash' && !reference) fail('Enter the Mobile Money / bank transaction reference');
    let amount, units = null;
    if (type === 'share_purchase') {
      units = int(b.units, 'Number of shares', { min: 1, max: 100000 });
      amount = units * numSetting('share_price');
    } else {
      amount = int(b.amount, 'Amount', { min: 500 });
    }
    return tx(() => {
      if (type === 'withdrawal') {
        const bal = balances(member.id);
        const available = bal.savings - bal.locked_savings;
        if (amount > available) {
          fail(`Insufficient withdrawable savings. Available: ${money(Math.max(available, 0))}` +
            (bal.locked_savings ? ` (${money(bal.locked_savings)} is held as security for a running loan)` : ''));
        }
      }
      if (type === 'deposit' && member.status === 'dormant') {
        run(`UPDATE members SET status='active' WHERE id=?`, member.id);
        audit(user, 'member_status_changed', 'member', member.id, { from: 'dormant', to: 'active', reason: 'Deposit received' }, ip);
      }
      const id = insertTxn({ member_id: member.id, type, amount, units, method: b.method, reference,
        narration: str(b.narration, 'Narration', { max: 200 }) }, user);
      const nb = balances(member.id);
      const name = firstName(member);
      const messages = {
        deposit: `Dear ${name}, you saved ${money(amount)}. Savings balance: ${money(nb.savings)}. Ref TX${id}.`,
        withdrawal: `Dear ${name}, you withdrew ${money(amount)}. Savings balance: ${money(nb.savings)}. Ref TX${id}.`,
        share_purchase: `Dear ${name}, you bought ${units} share(s) worth ${money(amount)}. Total shares: ${nb.share_units}. Ref TX${id}.`,
        registration_fee: `Dear ${name}, registration fee of ${money(amount)} received. Ref TX${id}.`,
      };
      notify(member.id, messages[type]);
      audit(user, `txn_${type}`, 'transaction', id, { member_no: member.member_no, amount, units, method: b.method, reference }, ip);
      return { id, balances: nb };
    });
  }

  function listTransactions({ date, from, to, member_id, type, q } = {}) {
    const where = []; const p = [];
    if (date) { where.push('substr(t.created_at,1,10)=?'); p.push(date); }
    if (from) { where.push('substr(t.created_at,1,10)>=?'); p.push(from); }
    if (to) { where.push('substr(t.created_at,1,10)<=?'); p.push(to); }
    if (member_id) { where.push('t.member_id=?'); p.push(Number(member_id)); }
    if (type) { where.push('t.type=?'); p.push(type); }
    if (q) { where.push('(m.member_no LIKE ? OR m.full_name LIKE ? OR t.reference LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    return db.prepare(`SELECT t.*, m.member_no, m.full_name, u.username created_by_name, o.type orig_type, l.loan_no,
              (SELECT status FROM reversal_requests r WHERE r.transaction_id=t.id ORDER BY r.id DESC LIMIT 1) reversal_status
            FROM transactions t JOIN members m ON m.id=t.member_id LEFT JOIN users u ON u.id=t.created_by
            LEFT JOIN transactions o ON o.id=t.reversal_of LEFT JOIN loans l ON l.id=t.loan_id
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC, t.id DESC LIMIT 500`).all(...p);
  }

  // ---------------------------------------------------------------- reversals (no deletion, only approved reversal)
  function requestReversal(txnId, reason, user, ip) {
    const t = get('SELECT * FROM transactions WHERE id=?', Number(txnId)) || fail('Transaction not found', 404);
    if (t.type === 'reversal') fail('A reversal cannot itself be reversed');
    if (t.reversed) fail('This transaction is already reversed');
    if (get(`SELECT 1 FROM reversal_requests WHERE transaction_id=? AND status='pending'`, t.id)) fail('A reversal request is already pending');
    reason = str(reason, 'Reason', { required: true, max: 300 });
    const id = Number(run(`INSERT INTO reversal_requests (transaction_id, reason, requested_by, requested_at) VALUES (?,?,?,?)`,
      t.id, reason, user.id, now()).lastInsertRowid);
    audit(user, 'reversal_requested', 'transaction', t.id, { request_id: id, reason }, ip);
    return { id };
  }

  function listReversals(status) {
    return all(`SELECT r.*, t.type, t.amount, t.units, t.method, t.reference, t.created_at txn_date, t.member_id,
                  m.member_no, m.full_name, ru.username requested_by_name, du.username decided_by_name
                FROM reversal_requests r JOIN transactions t ON t.id=r.transaction_id JOIN members m ON m.id=t.member_id
                JOIN users ru ON ru.id=r.requested_by LEFT JOIN users du ON du.id=r.decided_by
                WHERE (?='' OR r.status=?) ORDER BY r.id DESC LIMIT 300`, status || '', status || '');
  }

  function decideReversal(reqId, decision, comment, user, ip) {
    if (!['approved', 'rejected'].includes(decision)) fail('Invalid decision');
    const r = get('SELECT * FROM reversal_requests WHERE id=?', Number(reqId)) || fail('Request not found', 404);
    if (r.status !== 'pending') fail('This request has already been decided');
    if (r.requested_by === user.id) fail('You cannot approve a reversal you requested (four-eyes rule)', 403);
    comment = str(comment, 'Comment', { max: 300 });
    return tx(() => {
      const t = get('SELECT * FROM transactions WHERE id=?', r.transaction_id);
      if (decision === 'approved') {
        if (t.reversed) fail('Transaction already reversed');
        const bal = balances(t.member_id);
        if ((SAVINGS_EFFECT[t.type] ?? 0) > 0 && bal.savings - t.amount < 0) {
          fail(`Cannot reverse: savings would become negative (${money(bal.savings - t.amount)}). Reverse the later withdrawal first.`);
        }
        if (t.type === 'share_purchase' && bal.share_units - t.units < 0) fail('Cannot reverse: share balance would become negative');
        if (t.type === 'loan_disbursement') {
          const paid = get(`SELECT COUNT(*) n FROM transactions WHERE loan_id=? AND type='loan_repayment' AND reversed=0`, t.loan_id).n;
          if (paid) fail('Reverse the repayments on this loan before reversing its disbursement');
        }
        const revId = insertTxn({ member_id: t.member_id, type: 'reversal', amount: t.amount, units: t.units, method: t.method,
          reference: t.reference, narration: `Reversal of TX${t.id}: ${r.reason}`, loan_id: t.loan_id, reversal_of: t.id }, user);
        run('UPDATE transactions SET reversed=1 WHERE id=?', t.id);
        if (t.type === 'loan_repayment') reallocate(t.loan_id);
        if (t.type === 'loan_disbursement') {
          run('DELETE FROM loan_schedule WHERE loan_id=?', t.loan_id);
          run(`UPDATE loans SET status='approved', disbursed_at=NULL, disburse_method=NULL, disburse_reference=NULL, disbursed_by=NULL WHERE id=?`, t.loan_id);
        }
        notify(t.member_id, `Transaction TX${t.id} (${t.type.replace(/_/g, ' ')} of ${money(t.amount)}) has been reversed. Reason: ${r.reason}`);
        audit(user, 'reversal_approved', 'transaction', t.id, { request_id: r.id, reversal_txn: revId, comment }, ip);
      } else {
        audit(user, 'reversal_rejected', 'transaction', t.id, { request_id: r.id, comment }, ip);
      }
      run('UPDATE reversal_requests SET status=?, decided_by=?, decided_at=?, decision_comment=? WHERE id=?',
        decision, user.id, now(), comment, r.id);
      return { ok: true };
    });
  }

  // ---------------------------------------------------------------- loans
  function quote(principal, rate, months) {
    const total_interest = Math.round(principal * rate / 100 * months);
    const total_payable = principal + total_interest;
    const installment = Math.round(total_payable / months);
    return { principal, interest_rate: rate, months, total_interest, total_payable, installment };
  }

  function scheduleRows(q, startDate) {
    const rows = [];
    const pBase = Math.round(q.principal / q.months);
    for (let i = 1; i <= q.months; i++) {
      const last = i === q.months;
      const amount = last ? q.total_payable - q.installment * (q.months - 1) : q.installment;
      const principal = last ? q.principal - pBase * (q.months - 1) : pBase;
      rows.push({ installment_no: i, due_date: addMonths(startDate, i), principal_due: principal, interest_due: amount - principal, amount_due: amount });
    }
    return rows;
  }

  function calculator(b) {
    const type = get('SELECT * FROM loan_types WHERE id=?', Number(b.loan_type_id));
    const rate = type ? type.interest_rate : Number(b.rate);
    if (!Number.isFinite(rate) || rate < 0) fail('Choose a loan type');
    const principal = int(b.principal, 'Loan amount', { min: 1000 });
    const months = int(b.months, 'Months', { min: 1, max: type?.max_months ?? 120 });
    const q = quote(principal, rate, months);
    return { ...q, schedule: scheduleRows(q, today()) };
  }

  function loanTotals(loanId) {
    const t = get(`SELECT COALESCE(SUM(amount_due),0) due, COALESCE(SUM(amount_paid),0) paid, COALESCE(SUM(penalty),0) penalty,
                          COALESCE(SUM(penalty_paid),0) penalty_paid,
                          COALESCE(SUM(CASE WHEN due_date < ? THEN amount_due - amount_paid ELSE 0 END),0) arrears
                   FROM loan_schedule WHERE loan_id=?`, today(), loanId);
    return { ...t, balance: t.due + t.penalty - t.paid - t.penalty_paid };
  }

  // Applies all (non-reversed) repayments to the schedule from scratch: penalty first, then the installment, oldest first.
  function reallocate(loanId) {
    let pool = get(`SELECT COALESCE(SUM(amount),0) s FROM transactions WHERE loan_id=? AND type='loan_repayment' AND reversed=0`, loanId).s;
    for (const r of all('SELECT * FROM loan_schedule WHERE loan_id=? ORDER BY installment_no', loanId)) {
      const pp = Math.min(pool, r.penalty); pool -= pp;
      const ap = Math.min(pool, r.amount_due); pool -= ap;
      if (pp !== r.penalty_paid || ap !== r.amount_paid) run('UPDATE loan_schedule SET penalty_paid=?, amount_paid=? WHERE id=?', pp, ap, r.id);
    }
    const bal = loanTotals(loanId).balance;
    const loan = get('SELECT status FROM loans WHERE id=?', loanId);
    if (bal <= 0 && loan.status === 'active') run(`UPDATE loans SET status='closed', closed_at=? WHERE id=?`, now(), loanId);
    if (bal > 0 && loan.status === 'closed') run(`UPDATE loans SET status='active', closed_at=NULL WHERE id=?`, loanId);
    return bal;
  }

  function loanRow(id) {
    return get(`SELECT l.*, m.full_name, m.member_no, m.phone, m.status member_status, t.name type_name
                FROM loans l JOIN members m ON m.id=l.member_id JOIN loan_types t ON t.id=l.loan_type_id WHERE l.id=?`, Number(id))
      || fail('Loan not found', 404);
  }

  function parseGuarantors(list, applicantId) {
    const nos = [...new Set((Array.isArray(list) ? list : String(list ?? '').split(/[\s,;]+/))
      .map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
    return nos.map((no) => {
      const g = memberByNo(no) || fail(`Guarantor ${no} not found`);
      if (g.id === applicantId) fail('A member cannot guarantee their own loan');
      if (g.status !== 'active') fail(`Guarantor ${no} is not an active member`);
      return g;
    });
  }

  function applyLoan(b, user, ip) {
    const member = user.role === 'member' ? memberRow(user.member_id) : resolveMember(b);
    if (member.status !== 'active') fail('Only active members can apply for loans');
    const type = get('SELECT * FROM loan_types WHERE id=? AND active=1', Number(b.loan_type_id)) || fail('Choose a loan type');
    const principal = int(b.principal, 'Loan amount', { min: 10000 });
    const months = int(b.months, `Repayment period for ${type.name} loans`, { min: 1, max: type.max_months });
    const purpose = str(b.purpose, 'Purpose', { required: true, max: 500 });
    const open = get(`SELECT loan_no, status FROM loans WHERE member_id=? AND status IN ${IN_OPEN}`, member.id);
    if (open) fail(`${member.full_name} already has loan ${open.loan_no} (${open.status.replace(/_/g, ' ')}). Clear it first.`);
    const guarantors = parseGuarantors(b.guarantors, member.id);
    const q = quote(principal, type.interest_rate, months);
    return tx(() => {
      const id = Number(run(`INSERT INTO loans (member_id, loan_type_id, principal, interest_rate, months, total_interest, total_payable,
                               installment, purpose, status, applied_by, applied_at) VALUES (?,?,?,?,?,?,?,?,?,'pending',?,?)`,
        member.id, type.id, principal, q.interest_rate, months, q.total_interest, q.total_payable, q.installment, purpose, user.id, now()).lastInsertRowid);
      const loanNo = `LN${String(id).padStart(5, '0')}`;
      run('UPDATE loans SET loan_no=? WHERE id=?', loanNo, id);
      for (const g of guarantors) {
        run('INSERT INTO loan_guarantors (loan_id, member_id) VALUES (?,?)', id, g.id);
        notify(g.id, `${member.full_name} (${member.member_no}) has asked you to guarantee loan ${loanNo} of ${money(principal)}. Log in or visit the SACCO office to accept or decline.`);
      }
      notify(member.id, `Your ${type.name} loan application ${loanNo} for ${money(principal)} has been received. Monthly installment will be ${money(q.installment)} for ${months} months.`);
      audit(user, 'loan_applied', 'loan', id, { loan_no: loanNo, member_no: member.member_no, principal, months, type: type.name, guarantors: guarantors.map((g) => g.member_no) }, ip);
      return { id, loan_no: loanNo };
    });
  }

  function addGuarantor(loanId, memberNo, user, ip) {
    const loan = loanRow(loanId);
    if (user.role === 'member' && loan.member_id !== user.member_id) fail('Not your loan', 403);
    if (loan.status !== 'pending') fail('Guarantors can only be added while the loan is pending');
    const [g] = parseGuarantors([memberNo], loan.member_id);
    if (!g) fail('Enter a member number');
    if (get('SELECT 1 FROM loan_guarantors WHERE loan_id=? AND member_id=?', loan.id, g.id)) fail('Already a guarantor on this loan');
    return tx(() => {
      run('INSERT INTO loan_guarantors (loan_id, member_id) VALUES (?,?)', loan.id, g.id);
      notify(g.id, `${loan.full_name} (${loan.member_no}) has asked you to guarantee loan ${loan.loan_no} of ${money(loan.principal)}. Log in or visit the SACCO office to respond.`);
      audit(user, 'guarantor_added', 'loan', loan.id, { guarantor: g.member_no }, ip);
      return { ok: true };
    });
  }

  function respondGuarantee(gid, decision, user, ip) {
    if (!['accepted', 'declined'].includes(decision)) fail('Invalid decision');
    const g = get(`SELECT g.*, l.status loan_status, l.loan_no, l.member_id applicant_id, m.full_name guarantor_name, m.member_no guarantor_no
                   FROM loan_guarantors g JOIN loans l ON l.id=g.loan_id JOIN members m ON m.id=g.member_id WHERE g.id=?`, Number(gid))
      || fail('Guarantee request not found', 404);
    if (user.role === 'member' && g.member_id !== user.member_id) fail('This guarantee request is not addressed to you', 403);
    if (g.loan_status !== 'pending') fail('This loan is no longer waiting for guarantors');
    if (g.status !== 'pending') fail(`Already ${g.status}`);
    return tx(() => {
      run('UPDATE loan_guarantors SET status=?, responded_at=?, recorded_by=? WHERE id=?', decision, now(), user.id, g.id);
      notify(g.applicant_id, `${g.guarantor_name} has ${decision} to guarantee your loan ${g.loan_no}.`);
      audit(user, `guarantee_${decision}`, 'loan', g.loan_id, { guarantor: g.guarantor_no, on_behalf: user.role !== 'member' }, ip);
      return { ok: true };
    });
  }

  function myGuarantees(memberId) {
    return all(`SELECT g.*, l.loan_no, l.principal, l.status loan_status, l.months, l.purpose, m.full_name applicant_name, m.member_no applicant_no
                FROM loan_guarantors g JOIN loans l ON l.id=g.loan_id JOIN members m ON m.id=l.member_id
                WHERE g.member_id=? ORDER BY g.id DESC`, memberId);
  }

  function appraise(loan) {
    const s = settings();
    const bal = balances(loan.member_id);
    const member = memberRow(loan.member_id);
    const first = get(`SELECT MIN(created_at) d FROM transactions WHERE member_id=? AND type='deposit' AND reversed=0`, loan.member_id).d;
    const months = Number(s.min_savings_months), mult = Number(s.savings_multiplier);
    const minG = Number(s.min_guarantors), minS = Math.max(1, Number(s.min_shares));
    const accepted = get(`SELECT COUNT(*) n FROM loan_guarantors WHERE loan_id=? AND status='accepted'`, loan.id).n;
    const other = get(`SELECT loan_no FROM loans WHERE member_id=? AND id<>? AND status IN ${IN_OPEN}`, loan.member_id, loan.id);
    const limit = Math.floor(bal.savings * mult);
    const checks = [
      { label: 'Member is active', pass: member.status === 'active', detail: member.status },
      { label: `Has saved for at least ${months} months`, pass: !!first && addMonths(first, months) <= today(),
        detail: first ? `Saving since ${first.slice(0, 10)}` : 'No deposits yet' },
      { label: `Owns at least ${minS} share(s)`, pass: bal.share_units >= minS, detail: `${bal.share_units} shares (${money(bal.share_value)})` },
      { label: `At least ${minG} guarantor(s) accepted`, pass: accepted >= minG, detail: `${accepted} accepted` },
      { label: 'No other running loan', pass: !other, detail: other ? `Has ${other.loan_no}` : 'None' },
      { label: `Amount within ${mult}× savings`, pass: loan.principal <= limit, detail: `Limit ${money(limit)} on savings of ${money(bal.savings)}` },
    ];
    return { checks, passed: checks.every((c) => c.pass), limit, savings: bal.savings };
  }

  function canView(loan, user) {
    if (user.role !== 'member') return true;
    if (loan.member_id === user.member_id) return true;
    return !!get('SELECT 1 FROM loan_guarantors WHERE loan_id=? AND member_id=?', loan.id, user.member_id);
  }

  function loanDetail(id, user) {
    const loan = loanRow(id);
    if (!canView(loan, user)) fail('You can only view your own loans', 403);
    const level = NEXT_LEVEL[loan.status] ?? null;
    const approvals = all(`SELECT a.*, u.full_name user_name, u.role user_role FROM loan_approvals a JOIN users u ON u.id=a.user_id
                           WHERE a.loan_id=? ORDER BY a.id`, loan.id);
    const alreadyActed = approvals.some((a) => a.user_id === user.id);
    return {
      loan,
      guarantors: all(`SELECT g.*, m.full_name, m.member_no, m.phone FROM loan_guarantors g JOIN members m ON m.id=g.member_id
                       WHERE g.loan_id=? ORDER BY g.id`, loan.id),
      approvals,
      schedule: all('SELECT * FROM loan_schedule WHERE loan_id=? ORDER BY installment_no', loan.id),
      payments: all(`SELECT t.*, u.username created_by_name, o.type orig_type FROM transactions t
                     LEFT JOIN users u ON u.id=t.created_by LEFT JOIN transactions o ON o.id=t.reversal_of
                     WHERE t.loan_id=? ORDER BY t.created_at, t.id`, loan.id),
      totals: loanTotals(loan.id),
      appraisal: ['pending', 'officer_approved', 'manager_approved', 'approved'].includes(loan.status) ? appraise(loan) : null,
      next_level: level,
      needs_board: loan.principal > numSetting('board_threshold'),
      can_decide: !!level && LEVEL_ROLES[level].includes(user.role) && !alreadyActed && loan.applied_by !== user.id,
      already_acted: alreadyActed,
    };
  }

  function decideLoan(id, b, user, ip) {
    const loan = loanRow(id);
    const level = NEXT_LEVEL[loan.status] || fail(`Loan is ${loan.status.replace(/_/g, ' ')} — nothing to approve`);
    if (!LEVEL_ROLES[level].includes(user.role)) fail(`This loan is waiting for ${level} approval`, 403);
    if (get('SELECT 1 FROM loan_approvals WHERE loan_id=? AND user_id=?', loan.id, user.id)) fail('You have already acted on this loan; another person must approve the next level', 403);
    if (loan.applied_by === user.id) fail('You cannot approve a loan you captured (four-eyes rule)', 403);
    const decision = b.decision;
    if (!['approved', 'rejected'].includes(decision)) fail('Choose approve or reject');
    const comment = str(b.comment, 'Comment', { required: decision === 'rejected', max: 500 });
    if (decision === 'approved') {
      const a = appraise(loan);
      if (!a.passed) fail(`Appraisal failed: ${a.checks.filter((c) => !c.pass).map((c) => c.label).join('; ')}`);
    }
    return tx(() => {
      run('INSERT INTO loan_approvals (loan_id, level, decision, comment, user_id, created_at) VALUES (?,?,?,?,?,?)',
        loan.id, level, decision, comment, user.id, now());
      let status;
      if (decision === 'rejected') status = 'rejected';
      else if (level === 'officer') status = 'officer_approved';
      else if (level === 'manager') status = loan.principal > numSetting('board_threshold') ? 'manager_approved' : 'approved';
      else status = 'approved';
      run('UPDATE loans SET status=? WHERE id=?', status, loan.id);
      if (status === 'approved') notify(loan.member_id, `Congratulations! Your loan ${loan.loan_no} of ${money(loan.principal)} has been approved and will be disbursed shortly.`);
      if (status === 'rejected') notify(loan.member_id, `Sorry, your loan ${loan.loan_no} of ${money(loan.principal)} was not approved. Reason: ${comment}`);
      audit(user, `loan_${level}_${decision}`, 'loan', loan.id, { loan_no: loan.loan_no, comment, new_status: status }, ip);
      return { status };
    });
  }

  function disburse(id, b, user, ip) {
    const loan = loanRow(id);
    if (loan.status !== 'approved') fail('Only fully approved loans can be disbursed');
    if (!METHODS.includes(b.method)) fail('Choose how the money is sent');
    const reference = str(b.reference, 'Reference', { max: 60 });
    if (b.method !== 'cash' && !reference) fail('Enter the Mobile Money / bank transaction reference');
    return tx(() => {
      const txnId = insertTxn({ member_id: loan.member_id, type: 'loan_disbursement', amount: loan.principal, method: b.method,
        reference, narration: `Disbursement of ${loan.loan_no}`, loan_id: loan.id }, user);
      const q = quote(loan.principal, loan.interest_rate, loan.months);
      for (const r of scheduleRows(q, today())) {
        run(`INSERT INTO loan_schedule (loan_id, installment_no, due_date, principal_due, interest_due, amount_due) VALUES (?,?,?,?,?,?)`,
          loan.id, r.installment_no, r.due_date, r.principal_due, r.interest_due, r.amount_due);
      }
      run(`UPDATE loans SET status='active', disbursed_at=?, disburse_method=?, disburse_reference=?, disbursed_by=? WHERE id=?`,
        now(), b.method, reference, user.id, loan.id);
      notify(loan.member_id, `Your loan ${loan.loan_no} of ${money(loan.principal)} has been sent via ${b.method.replace('_', ' ')}. Repay ${money(q.installment)} monthly from ${addMonths(today(), 1)}.`);
      audit(user, 'loan_disbursed', 'loan', loan.id, { loan_no: loan.loan_no, amount: loan.principal, method: b.method, reference, txn: txnId }, ip);
      return { txn_id: txnId };
    });
  }

  function repay(id, b, user, ip) {
    const loan = loanRow(id);
    if (loan.status !== 'active') fail('Repayments can only be posted to active loans');
    if (!METHODS.includes(b.method)) fail('Choose a payment method');
    const reference = str(b.reference, 'Reference', { max: 60 });
    if (b.method !== 'cash' && !reference) fail('Enter the Mobile Money / bank transaction reference');
    const amount = int(b.amount, 'Amount', { min: 500 });
    return tx(() => {
      const before = loanTotals(loan.id).balance;
      if (amount > before) fail(`Amount exceeds the loan balance of ${money(before)}`);
      const txnId = insertTxn({ member_id: loan.member_id, type: 'loan_repayment', amount, method: b.method, reference,
        narration: `Repayment of ${loan.loan_no}`, loan_id: loan.id }, user);
      const bal = reallocate(loan.id);
      notify(loan.member_id, bal > 0
        ? `Dear ${loan.full_name.split(/\s+/)[0]}, repayment of ${money(amount)} received for ${loan.loan_no}. Loan balance: ${money(bal)}. Ref TX${txnId}.`
        : `Dear ${loan.full_name.split(/\s+/)[0]}, repayment of ${money(amount)} received. Loan ${loan.loan_no} is fully paid. Thank you!`);
      audit(user, 'loan_repayment', 'loan', loan.id, { loan_no: loan.loan_no, amount, method: b.method, reference, txn: txnId, balance: bal }, ip);
      return { txn_id: txnId, balance: bal };
    });
  }

  function listLoans({ status, member_id, q } = {}) {
    const where = []; const p = [today()];
    if (status) { const s = String(status).split(','); where.push(`l.status IN (${s.map(() => '?').join(',')})`); p.push(...s); }
    if (member_id) { where.push('l.member_id=?'); p.push(Number(member_id)); }
    if (q) { where.push('(m.full_name LIKE ? OR m.member_no LIKE ? OR l.loan_no LIKE ?)'); p.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    return db.prepare(`SELECT l.*, m.full_name, m.member_no, m.phone, t.name type_name,
              COALESCE(s.due,0)+COALESCE(s.pen,0)-COALESCE(s.paid,0)-COALESCE(s.penpaid,0) balance,
              COALESCE(s.arrears,0) arrears, s.next_due
            FROM loans l JOIN members m ON m.id=l.member_id JOIN loan_types t ON t.id=l.loan_type_id
            LEFT JOIN (SELECT loan_id, SUM(amount_due) due, SUM(penalty) pen, SUM(amount_paid) paid, SUM(penalty_paid) penpaid,
                         SUM(CASE WHEN due_date < ? THEN amount_due-amount_paid ELSE 0 END) arrears,
                         MIN(CASE WHEN amount_paid < amount_due THEN due_date END) next_due
                       FROM loan_schedule GROUP BY loan_id) s ON s.loan_id=l.id
            ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.id DESC LIMIT 1000`).all(...p);
  }

  function pendingApprovals(user) {
    const statuses = Object.entries(NEXT_LEVEL).filter(([, lvl]) => LEVEL_ROLES[lvl].includes(user.role)).map(([s]) => s);
    const loans = statuses.length ? listLoans({ status: statuses.join(',') }) : [];
    const acted = new Set(all('SELECT loan_id FROM loan_approvals WHERE user_id=?', user.id).map((r) => r.loan_id));
    return {
      loans: loans.map((l) => ({ ...l, already_acted: acted.has(l.id) || l.applied_by === user.id })),
      reversals: user.role === 'manager' ? listReversals('pending') : [],
      to_disburse: ['cashier', 'manager'].includes(user.role) ? listLoans({ status: 'approved' }) : [],
    };
  }

  // ---------------------------------------------------------------- due dates: penalties & SMS reminders
  function processDue() {
    const t = today();
    const rate = numSetting('penalty_rate');
    const weekly = setting('penalty_frequency') === 'weekly';
    const remindDays = numSetting('reminder_days');
    let penalties = 0, reminders = 0;
    tx(() => {
      const overdue = all(`SELECT s.*, l.member_id, l.loan_no FROM loan_schedule s JOIN loans l ON l.id=s.loan_id
                           WHERE l.status='active' AND s.due_date < ? AND s.amount_paid < s.amount_due`, t);
      const touched = new Set();
      for (const s of overdue) {
        const days = daysBetween(s.due_date, t);
        const periods = weekly ? Math.floor((days - 1) / 7) + 1 : 1;
        if (rate > 0 && periods > s.penalty_periods) {
          const unpaid = s.amount_due - s.amount_paid;
          const add = Math.round(unpaid * rate / 100) * (periods - s.penalty_periods);
          run('UPDATE loan_schedule SET penalty=penalty+?, penalty_periods=? WHERE id=?', add, periods, s.id);
          touched.add(s.loan_id);
          penalties++;
          notify(s.member_id, `Loan ${s.loan_no}: installment ${s.installment_no} of ${money(unpaid)} due ${s.due_date} is overdue. A late penalty of ${money(add)} (${rate}%) has been added. Please pay to avoid further charges.`);
          audit(null, 'penalty_applied', 'loan', s.loan_id, { installment: s.installment_no, unpaid, penalty: add }, null);
        }
      }
      for (const id of touched) reallocate(id);
      const upcoming = all(`SELECT s.*, l.member_id, l.loan_no FROM loan_schedule s JOIN loans l ON l.id=s.loan_id
                            WHERE l.status='active' AND s.reminder_sent=0 AND s.amount_paid < s.amount_due
                              AND s.due_date >= ? AND s.due_date <= ?`, t, addDays(t, remindDays));
      for (const s of upcoming) {
        const d = daysBetween(t, s.due_date);
        const when = d === 0 ? 'today' : d === 1 ? 'tomorrow' : `on ${s.due_date}`;
        notify(s.member_id, `Reminder: your loan repayment of ${money(s.amount_due - s.amount_paid)} for ${s.loan_no} is due ${when}.`);
        run('UPDATE loan_schedule SET reminder_sent=1 WHERE id=?', s.id);
        reminders++;
      }
    });
    return { penalties, reminders };
  }

  // ---------------------------------------------------------------- dividends
  function dividendBasis(year) {
    const asOf = `${year}-12-31 23:59:59`;
    return all(`SELECT m.id member_id, m.member_no, m.full_name,
                  COALESCE(${UNITS_SQL.replace(/\btype\b/g, 't.type').replace(/\bunits\b/g, 't.units')},0) share_units,
                  COALESCE(${SAVINGS_SQL.replace(/\btype\b/g, 't.type').replace(/\bamount\b/g, 't.amount')},0) savings_balance
                FROM members m LEFT JOIN transactions t ON t.member_id=m.id AND t.reversed=0 AND t.type<>'reversal' AND t.created_at<=?
                WHERE m.status<>'exited' GROUP BY m.id ORDER BY m.id`, asOf);
  }

  function previewDividend(b) {
    const year = int(b.year, 'Year', { min: 2000, max: Number(today().slice(0, 4)) });
    const profit = int(b.total_profit, 'Profit to share', { min: 1 });
    const sharePct = Number(b.share_pct ?? 100);
    if (!Number.isFinite(sharePct) || sharePct < 0 || sharePct > 100) fail('Share portion must be 0-100 %');
    const rows = dividendBasis(year);
    const totalUnits = rows.reduce((s, r) => s + Math.max(0, r.share_units), 0);
    const totalSavings = rows.reduce((s, r) => s + Math.max(0, r.savings_balance), 0);
    const sharePool = profit * sharePct / 100;
    const savingsPool = profit - sharePool;
    const ratePerShare = totalUnits ? sharePool / totalUnits : 0;
    const savingsRate = totalSavings ? savingsPool / totalSavings : 0;
    const payouts = rows.map((r) => {
      const share_amount = Math.floor(Math.max(0, r.share_units) * ratePerShare);
      const savings_amount = Math.floor(Math.max(0, r.savings_balance) * savingsRate);
      return { ...r, share_amount, savings_amount, total: share_amount + savings_amount };
    }).filter((r) => r.total > 0);
    const totalPaid = payouts.reduce((s, r) => s + r.total, 0);
    return {
      year, total_profit: profit, share_pct: sharePct, total_units: totalUnits, total_savings: totalSavings,
      rate_per_share: ratePerShare, savings_rate: savingsRate, total_paid: totalPaid, retained: profit - totalPaid,
      already_declared: !!get('SELECT 1 FROM dividends WHERE year=?', year), payouts,
    };
  }

  function declareDividend(b, user, ip) {
    const p = previewDividend(b);
    if (p.already_declared) fail(`Dividends for ${p.year} have already been declared`);
    if (!p.payouts.length) fail('No member qualifies (no shares or savings at year end)');
    return tx(() => {
      const id = Number(run(`INSERT INTO dividends (year, total_profit, share_pct, rate_per_share, savings_rate, total_paid, declared_by, declared_at)
                             VALUES (?,?,?,?,?,?,?,?)`, p.year, p.total_profit, p.share_pct, p.rate_per_share, p.savings_rate, p.total_paid, user.id, now()).lastInsertRowid);
      for (const r of p.payouts) {
        const txnId = insertTxn({ member_id: r.member_id, type: 'dividend', amount: r.total, method: 'internal', narration: `Dividend ${p.year}` }, user);
        run(`INSERT INTO dividend_payouts (dividend_id, member_id, share_units, savings_balance, share_amount, savings_amount, total, transaction_id)
             VALUES (?,?,?,?,?,?,?,?)`, id, r.member_id, r.share_units, r.savings_balance, r.share_amount, r.savings_amount, r.total, txnId);
        notify(r.member_id, `Dear ${r.full_name.split(/\s+/)[0]}, your ${p.year} dividend of ${money(r.total)} has been credited to your savings.`);
      }
      audit(user, 'dividend_declared', 'dividend', id, { year: p.year, profit: p.total_profit, paid: p.total_paid, members: p.payouts.length }, ip);
      return { id, total_paid: p.total_paid, members: p.payouts.length };
    });
  }

  function listDividends() {
    return all(`SELECT d.*, u.username declared_by_name, (SELECT COUNT(*) FROM dividend_payouts p WHERE p.dividend_id=d.id) members
                FROM dividends d JOIN users u ON u.id=d.declared_by ORDER BY d.year DESC`);
  }
  function dividendPayouts(id) {
    return all(`SELECT p.*, m.member_no, m.full_name FROM dividend_payouts p JOIN members m ON m.id=p.member_id
                WHERE p.dividend_id=? ORDER BY p.total DESC`, Number(id));
  }

  // ---------------------------------------------------------------- statements & reports
  function statement(memberId, from, to) {
    const member = memberRow(memberId);
    const rows = all(`SELECT t.*, u.username created_by_name, o.type orig_type, l.loan_no FROM transactions t
                      LEFT JOIN users u ON u.id=t.created_by LEFT JOIN transactions o ON o.id=t.reversal_of
                      LEFT JOIN loans l ON l.id=t.loan_id WHERE t.member_id=? ORDER BY t.created_at, t.id`, member.id);
    let running = 0, units = 0, opening = 0, openingUnits = 0;
    const out = [];
    for (const r of rows) {
      const base = r.type === 'reversal' ? r.orig_type : r.type;
      const sign = r.type === 'reversal' ? -1 : 1;
      const se = (SAVINGS_EFFECT[base] ?? 0) * sign * r.amount;
      const ue = base === 'share_purchase' ? sign * r.units : base === 'share_refund' ? -sign * r.units : 0;
      running += se; units += ue;
      const d = r.created_at.slice(0, 10);
      if (from && d < from) { opening = running; openingUnits = units; continue; }
      if (to && d > to) continue;
      out.push({ ...r, savings_effect: se, savings_balance: running, units_effect: ue, share_units: units });
    }
    const { photo, ...memberInfo } = member;
    return {
      member: memberInfo, from: from || null, to: to || null, opening_balance: opening, opening_units: openingUnits,
      balances: balances(member.id), transactions: out, loans: listLoans({ member_id: member.id }),
      sacco_name: setting('sacco_name'), generated_at: now(),
    };
  }

  function cashReport(date) {
    date = /^\d{4}-\d{2}-\d{2}$/.test(date || '') ? date : today();
    const rows = all(`SELECT t.*, m.member_no, m.full_name, u.username created_by_name, o.type orig_type FROM transactions t
                      JOIN members m ON m.id=t.member_id LEFT JOIN users u ON u.id=t.created_by
                      LEFT JOIN transactions o ON o.id=t.reversal_of
                      WHERE substr(t.created_at,1,10)=? ORDER BY t.created_at, t.id`, date);
    const totals = { cash_in: 0, cash_out: 0, net: 0 };
    const byMethod = {}; const byType = {};
    for (const r of rows) {
      const base = r.type === 'reversal' ? r.orig_type : r.type;
      r.cash_effect = (CASH_EFFECT[base] ?? 0) * (r.type === 'reversal' ? -1 : 1) * r.amount;
      if (r.cash_effect > 0) totals.cash_in += r.cash_effect; else totals.cash_out -= r.cash_effect;
      const m = byMethod[r.method || 'internal'] ??= { cash_in: 0, cash_out: 0 };
      if (r.cash_effect > 0) m.cash_in += r.cash_effect; else m.cash_out -= r.cash_effect;
      const key = r.type === 'reversal' ? `reversal of ${base}` : base;
      const ty = byType[key] ??= { count: 0, amount: 0 };
      ty.count++; ty.amount += r.amount;
    }
    totals.net = totals.cash_in - totals.cash_out;
    return { date, rows, totals, by_method: byMethod, by_type: byType };
  }

  function defaulters() {
    const t = today();
    return all(`SELECT l.id loan_id, l.loan_no, l.principal, m.id member_id, m.member_no, m.full_name, m.phone,
                  MIN(s.due_date) oldest_due, COUNT(*) missed, SUM(s.amount_due - s.amount_paid) overdue_amount,
                  SUM(s.penalty - s.penalty_paid) penalty_due
                FROM loan_schedule s JOIN loans l ON l.id=s.loan_id JOIN members m ON m.id=l.member_id
                WHERE l.status='active' AND s.due_date < ? AND s.amount_paid < s.amount_due
                GROUP BY l.id ORDER BY oldest_due`, t)
      .map((r) => ({ ...r, days_overdue: daysBetween(r.oldest_due, t), balance: loanTotals(r.loan_id).balance }));
  }

  function dashboard() {
    const t = today();
    const totals = get(`SELECT COALESCE(${SAVINGS_SQL},0) savings, COALESCE(${UNITS_SQL},0) units, COALESCE(${SHARE_VALUE_SQL},0) share_capital
                        FROM transactions WHERE ${LIVE}`);
    const loans = get(`SELECT COUNT(DISTINCT l.id) active, COALESCE(SUM(s.amount_due+s.penalty-s.amount_paid-s.penalty_paid),0) outstanding,
                         COALESCE(SUM(CASE WHEN s.due_date < ? THEN s.amount_due-s.amount_paid ELSE 0 END),0) arrears
                       FROM loans l JOIN loan_schedule s ON s.loan_id=l.id WHERE l.status='active'`, t);
    const atRisk = get(`SELECT COALESCE(SUM(s.amount_due+s.penalty-s.amount_paid-s.penalty_paid),0) v FROM loan_schedule s
                        WHERE s.loan_id IN (SELECT DISTINCT s2.loan_id FROM loan_schedule s2 JOIN loans l ON l.id=s2.loan_id
                                            WHERE l.status='active' AND s2.due_date < ? AND s2.amount_paid < s2.amount_due)`, t).v;
    return {
      date: t,
      members: all('SELECT status, COUNT(*) n FROM members GROUP BY status'),
      totals,
      loans: { ...loans, at_risk: atRisk, par: loans.outstanding ? atRisk / loans.outstanding : 0 },
      defaulters: defaulters().length,
      pipeline: all(`SELECT status, COUNT(*) n, SUM(principal) amount FROM loans
                     WHERE status IN ('pending','officer_approved','manager_approved','approved') GROUP BY status`),
      pending_reversals: get(`SELECT COUNT(*) n FROM reversal_requests WHERE status='pending'`).n,
      cash: cashReport(t).totals,
      recent: listTransactions({}).slice(0, 10),
    };
  }

  function memberSummary(memberId) {
    const member = memberRow(memberId);
    const { photo, ...info } = member;
    const loans = listLoans({ member_id: member.id });
    const active = loans.find((l) => l.status === 'active');
    const next = active ? get(`SELECT * FROM loan_schedule WHERE loan_id=? AND amount_paid < amount_due ORDER BY installment_no LIMIT 1`, active.id) : null;
    return {
      member: info, photo, balances: balances(member.id), loans, next_installment: next,
      pending_guarantees: myGuarantees(member.id).filter((g) => g.status === 'pending' && g.loan_status === 'pending'),
      recent: all(`SELECT t.*, o.type orig_type FROM transactions t LEFT JOIN transactions o ON o.id=t.reversal_of
                   WHERE t.member_id=? ORDER BY t.created_at DESC, t.id DESC LIMIT 8`, member.id),
      eligibility: { min_savings_months: numSetting('min_savings_months'), min_shares: numSetting('min_shares'), min_guarantors: numSetting('min_guarantors') },
    };
  }

  function auditLog({ q, action, from, to } = {}) {
    const where = []; const p = [];
    if (q) { where.push('(username LIKE ? OR details LIKE ?)'); p.push(`%${q}%`, `%${q}%`); }
    if (action) { where.push('action LIKE ?'); p.push(`%${action}%`); }
    if (from) { where.push('substr(created_at,1,10)>=?'); p.push(from); }
    if (to) { where.push('substr(created_at,1,10)<=?'); p.push(to); }
    return db.prepare(`SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 1000`).all(...p);
  }

  // ---------------------------------------------------------------- backups
  function backup(actor, ip) {
    fs.mkdirSync(backupDir, { recursive: true });
    const stamp = now().replace(/[: ]/g, '-');
    const file = path.join(backupDir, `sacco-${stamp}.db`);
    if (fs.existsSync(file)) fail('A backup was just taken; try again in a second');
    db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    audit(actor, 'backup_created', 'backup', null, { file: path.basename(file) }, ip);
    return { name: path.basename(file), size: fs.statSync(file).size };
  }
  function listBackups() {
    if (!fs.existsSync(backupDir)) return [];
    return fs.readdirSync(backupDir).filter((f) => f.endsWith('.db'))
      .map((f) => { const s = fs.statSync(path.join(backupDir, f)); return { name: f, size: s.size, created_at: s.mtime.toISOString() }; })
      .sort((a, b) => b.name.localeCompare(a.name));
  }
  function autoBackup() {
    const prefix = `sacco-${today()}`;
    if (listBackups().some((b) => b.name.startsWith(prefix))) return null;
    return backup(null, null);
  }

  return {
    settings, updateSettings, audit, notify, listNotifications,
    login, sessionUser, logout, changePassword, ensureAdmin, listUsers, createUser, updateUser,
    listLoanTypes, saveLoanType,
    listMembers, memberDetail, createMember, updateMember, setMemberStatus, createMemberLogin, lookup, balances,
    teller, listTransactions, requestReversal, listReversals, decideReversal,
    calculator, applyLoan, addGuarantor, respondGuarantee, myGuarantees, loanDetail, decideLoan, disburse, repay, listLoans, pendingApprovals,
    processDue, previewDividend, declareDividend, listDividends, dividendPayouts,
    statement, cashReport, defaulters, dashboard, memberSummary, auditLog,
    backup, listBackups, autoBackup,
  };
}

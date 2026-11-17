import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './src/db.js';
import { createSacco, HttpError } from './src/sacco.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.SACCO_DB || path.join(ROOT, 'data', 'sacco.db');

const db = openDb(DB_FILE);
const sacco = createSacco(db, { backupDir: path.join(ROOT, 'backups') });

const adminPassword = sacco.ensureAdmin();
if (adminPassword) {
  console.log(`\n  First run: created user "admin" with password: ${adminPassword}`);
  console.log('  You will be asked to change it on first login.\n');
}
const housekeeping = () => {
  try { sacco.processDue(); sacco.autoBackup(); } catch (e) { console.error('Housekeeping failed:', e); }
};
housekeeping();
setInterval(housekeeping, 60 * 60 * 1000).unref();

// ------------------------------------------------------------------ roles
const STAFF = ['admin', 'manager', 'board', 'loan_officer', 'cashier'];
const ALL = [...STAFF, 'member'];
const REGISTRARS = ['admin', 'manager', 'loan_officer', 'cashier'];
const TELLERS = ['cashier', 'manager'];
const APPROVERS = ['loan_officer', 'manager', 'board'];
const AUDITORS = ['admin', 'manager', 'board'];
const ADMIN = ['admin'];

// ------------------------------------------------------------------ routing
const routes = [];
function route(method, pattern, roles, handler) {
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  routes.push({ method, re, keys, roles, handler });
}
const ownOrStaff = (user, memberId) => {
  if (user.role === 'member' && Number(memberId) !== user.member_id) throw new HttpError(403, 'You can only view your own records');
};

// auth
route('GET', '/api/public-settings', null, () => ({ sacco_name: sacco.settings().sacco_name }));
route('POST', '/api/login', null, ({ body, ip, res }) => {
  const r = sacco.login(body.username, body.password, ip);
  setCookie(res, r.token, r.maxAge);
  return { user: r.user };
});
route('POST', '/api/logout', ALL, ({ token, res }) => { sacco.logout(token); setCookie(res, '', 0); return { ok: true }; });
route('GET', '/api/me', ALL, ({ user }) => ({ user, settings: sacco.settings() }));
route('POST', '/api/me/password', ALL, ({ user, body, ip }) => sacco.changePassword(user, body.current_password, body.new_password, ip));

// admin
route('GET', '/api/settings', ALL, () => sacco.settings());
route('PUT', '/api/settings', ADMIN, ({ body, user, ip }) => sacco.updateSettings(body, user, ip));
route('GET', '/api/loan-types', ALL, () => sacco.listLoanTypes());
route('POST', '/api/loan-types', ADMIN, ({ body, user, ip }) => sacco.saveLoanType(null, body, user, ip));
route('PUT', '/api/loan-types/:id', ADMIN, ({ params, body, user, ip }) => sacco.saveLoanType(Number(params.id), body, user, ip));
route('GET', '/api/users', ADMIN, () => sacco.listUsers());
route('POST', '/api/users', ADMIN, ({ body, user, ip }) => sacco.createUser(body, user, ip));
route('PUT', '/api/users/:id', ADMIN, ({ params, body, user, ip }) => sacco.updateUser(Number(params.id), body, user, ip));
route('POST', '/api/admin/backup', ADMIN, ({ user, ip }) => sacco.backup(user, ip));
route('GET', '/api/admin/backups', ADMIN, () => sacco.listBackups());
route('GET', '/api/audit', AUDITORS, ({ query }) => sacco.auditLog(query));

// members
route('GET', '/api/members', STAFF, ({ query }) => sacco.listMembers(query));
route('POST', '/api/members', REGISTRARS, ({ body, user, ip }) => sacco.createMember(body, user, ip));
route('GET', '/api/members/lookup', ALL, ({ query }) => sacco.lookup(query.no));
route('GET', '/api/members/:id', ALL, ({ params, user }) => { ownOrStaff(user, params.id); return sacco.memberDetail(params.id); });
route('PUT', '/api/members/:id', REGISTRARS, ({ params, body, user, ip }) => sacco.updateMember(params.id, body, user, ip));
route('POST', '/api/members/:id/status', ['admin', 'manager'], ({ params, body, user, ip }) => sacco.setMemberStatus(params.id, body, user, ip));
route('POST', '/api/members/:id/login', REGISTRARS, ({ params, body, user, ip }) => sacco.createMemberLogin(params.id, body.password, user, ip));
route('GET', '/api/members/:id/statement', ALL, ({ params, query, user }) => {
  ownOrStaff(user, params.id);
  return sacco.statement(params.id, query.from, query.to);
});
route('GET', '/api/my/summary', ['member'], ({ user }) => sacco.memberSummary(user.member_id));
route('GET', '/api/my/guarantees', ['member'], ({ user }) => sacco.myGuarantees(user.member_id));

// transactions & reversals
route('POST', '/api/transactions', TELLERS, ({ body, user, ip }) => sacco.teller(body, user, ip));
route('GET', '/api/transactions', STAFF, ({ query }) => sacco.listTransactions(query));
route('POST', '/api/transactions/:id/reverse', TELLERS, ({ params, body, user, ip }) => sacco.requestReversal(params.id, body.reason, user, ip));
route('GET', '/api/reversals', STAFF, ({ query }) => sacco.listReversals(query.status));
route('POST', '/api/reversals/:id/decide', ['manager'], ({ params, body, user, ip }) => sacco.decideReversal(params.id, body.decision, body.comment, user, ip));

// loans
route('GET', '/api/calculator', ALL, ({ query }) => sacco.calculator(query));
route('GET', '/api/loans', ALL, ({ query, user }) => sacco.listLoans(user.role === 'member' ? { ...query, member_id: user.member_id } : query));
route('POST', '/api/loans', ['member', 'loan_officer', 'manager'], ({ body, user, ip }) => sacco.applyLoan(body, user, ip));
route('GET', '/api/loans/:id', ALL, ({ params, user }) => sacco.loanDetail(params.id, user));
route('POST', '/api/loans/:id/guarantors', ['member', 'loan_officer', 'manager'], ({ params, body, user, ip }) => sacco.addGuarantor(params.id, body.member_no, user, ip));
route('POST', '/api/guarantors/:id/respond', ['member', 'loan_officer', 'manager'], ({ params, body, user, ip }) => sacco.respondGuarantee(params.id, body.decision, user, ip));
route('POST', '/api/loans/:id/decide', APPROVERS, ({ params, body, user, ip }) => sacco.decideLoan(params.id, body, user, ip));
route('POST', '/api/loans/:id/disburse', TELLERS, ({ params, body, user, ip }) => sacco.disburse(params.id, body, user, ip));
route('POST', '/api/loans/:id/repay', TELLERS, ({ params, body, user, ip }) => sacco.repay(params.id, body, user, ip));
route('GET', '/api/approvals', [...APPROVERS, 'cashier'], ({ user }) => sacco.pendingApprovals(user));

// dividends
route('GET', '/api/dividends', AUDITORS, () => sacco.listDividends());
route('GET', '/api/dividends/:id', AUDITORS, ({ params }) => sacco.dividendPayouts(params.id));
route('POST', '/api/dividends/preview', ['manager', 'board'], ({ body }) => sacco.previewDividend(body));
route('POST', '/api/dividends', ['manager', 'board'], ({ body, user, ip }) => sacco.declareDividend(body, user, ip));

// reports & notifications
route('GET', '/api/reports/dashboard', STAFF, () => sacco.dashboard());
route('GET', '/api/reports/cash', STAFF, ({ query }) => sacco.cashReport(query.date));
route('GET', '/api/reports/defaulters', STAFF, () => sacco.defaulters());
route('GET', '/api/reports/portfolio', STAFF, ({ query }) => sacco.listLoans(query));
route('GET', '/api/reports/savings', STAFF, ({ query }) => sacco.listMembers(query));
route('GET', '/api/notifications', ALL, ({ user }) => sacco.listNotifications(user));
route('POST', '/api/notifications/run', ['admin', 'manager', 'loan_officer'], ({ user, ip }) => {
  const r = sacco.processDue();
  sacco.audit(user, 'due_check_run', null, null, r, ip);
  return r;
});

// ------------------------------------------------------------------ http plumbing
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-ancestors 'none'",
};

function setCookie(res, token, maxAge) {
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`);
}
function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((c) => c.trim().split('=')).filter(([k]) => k).map(([k, ...v]) => [k, v.join('=')]));
}
function send(res, status, data) {
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!size) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const ip = req.socket.remoteAddress;
  const match = routes.map((r) => ({ r, m: req.method === r.method && url.pathname.match(r.re) })).find((x) => x.m);
  if (!match) throw new HttpError(404, 'Not found');
  const { r, m } = match;
  const token = parseCookies(req.headers.cookie).sid || null;
  let user = null;
  if (r.roles) {
    user = sacco.sessionUser(token);
    if (!user) throw new HttpError(401, 'Please log in');
    if (!r.roles.includes(user.role)) throw new HttpError(403, 'Your role is not allowed to do this');
    const allowedWhilePending = ['/api/me', '/api/me/password', '/api/logout', '/api/settings'];
    if (user.must_change_password && !allowedWhilePending.includes(url.pathname)) throw new HttpError(403, 'Please change your password first');
  }
  let body = {};
  if (req.method !== 'GET') {
    // JSON-only bodies + SameSite=Strict cookie protect against CSRF
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Expected JSON');
    body = await readBody(req);
  }
  const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  const query = Object.fromEntries(url.searchParams);
  const result = await r.handler({ req, res, user, token, params, query, body, ip });
  send(res, 200, result ?? { ok: true });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, SECURITY_HEADERS); res.end('Not found'); return;
  }
  res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url.pathname);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    if (/UNIQUE constraint/.test(err?.message)) return send(res, 409, { error: 'That record already exists' });
    console.error(err);
    send(res, 500, { error: 'Something went wrong. The error has been logged.' });
  }
});

server.listen(PORT, () => console.log(`SACCO Management System running at http://localhost:${PORT}`));

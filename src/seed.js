// Loads demo data. Usage: node src/seed.js --reset   (deletes data/sacco.db first)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createSacco, hashPassword } from './sacco.js';
import { setClock, today, addMonths, addDays, now } from './util.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DB_FILE = process.env.SACCO_DB || path.join(ROOT, 'data', 'sacco.db');

if (process.argv.includes('--reset')) {
  for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
}
const db = openDb(DB_FILE);
if (db.prepare('SELECT COUNT(*) n FROM members').get().n > 0) {
  console.error('Database already has members. Run with --reset to wipe it and load demo data.');
  process.exit(1);
}
const s = createSacco(db, { backupDir: path.join(ROOT, 'backups') });
const T = today();
const at = (d) => setClock(`${d} 10:00:00`);

// ---- staff
at(addMonths(T, -12));
const staff = {};
for (const [username, full_name, role, password] of [
  ['admin', 'System Administrator', 'admin', 'Admin@123'],
  ['manager', 'Ruth Akello (Manager)', 'manager', 'Manager@123'],
  ['board', 'Samuel Ochieng (Board Chair)', 'board', 'Board@123'],
  ['officer', 'Brian Tumusiime (Loan Officer)', 'loan_officer', 'Officer@123'],
  ['cashier', 'Esther Nansubuga (Cashier)', 'cashier', 'Cashier@123'],
]) {
  db.prepare(`INSERT OR IGNORE INTO users (username, full_name, role, password_hash, created_at) VALUES (?,?,?,?,?)`)
    .run(username, full_name, role, hashPassword(password), now());
  db.prepare(`UPDATE users SET role=?, full_name=?, password_hash=?, must_change_password=0 WHERE username=?`)
    .run(role, full_name, hashPassword(password), username);
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  staff[username] = { id: u.id, username, full_name, role };
}
const { cashier, officer, manager } = staff;

// ---- members
const people = [
  ['Divine Nakato', 'CF90052114KLMA', '0772100001', 'Female', 'Tailor', 'Paul Nakato', '0772200001', 'Husband'],
  ['John Okello', 'CM88011234ABCD', '0772100002', 'Male', 'Teacher', 'Mary Okello', '0772200002', 'Wife'],
  ['Grace Atim', 'CF85020345EFGH', '0772100003', 'Female', 'Shop owner', 'James Atim', '0772200003', 'Brother'],
  ['Peter Mugisha', 'CM80030456IJKL', '0772100004', 'Male', 'Farmer', 'Ruth Mugisha', '0772200004', 'Wife'],
  ['Sarah Namuli', 'CF92040567MNOP', '0772100005', 'Female', 'Nurse', 'Joseph Namuli', '0772200005', 'Father'],
  ['Moses Kato', 'CM95050678QRST', '0772100006', 'Male', 'Boda boda rider', 'Agnes Kato', '0772200006', 'Mother'],
];
const M = {};
const joined = addMonths(T, -8);
at(joined);
for (const [full_name, nin, phone, gender, occupation, nok, nokPhone, rel] of people) {
  const r = s.createMember({ full_name, nin, phone, gender, occupation, address: 'Kampala', next_of_kin_name: nok,
    next_of_kin_phone: nokPhone, next_of_kin_relation: rel, pay_registration_fee: true, method: 'cash',
    create_login: true, password: 'Member@123' }, cashier, '127.0.0.1');
  M[full_name.split(' ')[0]] = r;
}
db.prepare(`UPDATE users SET must_change_password=0 WHERE role='member'`).run();
db.prepare(`UPDATE members SET joined_at=?`).run(joined);

const pay = (who, type, extra) => s.teller({ member_id: M[who].id, type, method: 'cash', ...extra }, cashier, '127.0.0.1');

// shares + monthly savings
const plan = { Divine: [20, 100000, 5], John: [10, 50000, 6], Grace: [50, 150000, 8], Peter: [40, 300000, 8], Sarah: [15, 100000, 8], Moses: [2, 25000, 2] };
for (const [who, [units, monthly, months]] of Object.entries(plan)) {
  at(addDays(joined, 1));
  pay(who, 'share_purchase', { units });
  for (let i = 0; i < months; i++) { at(addDays(addMonths(joined, i), 2)); pay(who, 'deposit', { amount: monthly }); }
}

const memberUser = (who) => {
  const u = db.prepare('SELECT * FROM users WHERE member_id=?').get(M[who].id);
  return { id: u.id, username: u.username, full_name: u.full_name, role: 'member', member_id: u.member_id };
};
const types = Object.fromEntries(s.listLoanTypes().map((t) => [t.name, t.id]));
const ip = '127.0.0.1';
const accept = (loanId) => {
  for (const g of db.prepare('SELECT id FROM loan_guarantors WHERE loan_id=?').all(loanId)) s.respondGuarantee(g.id, 'accepted', officer, ip);
};

// Sarah: emergency loan taken and fully repaid
let d = addDays(addMonths(T, -5), 5);
at(d);
const sl = s.applyLoan({ loan_type_id: types.Emergency, principal: 600000, months: 3, purpose: 'Medical bills',
  guarantors: [M.Grace.member_no, M.Peter.member_no] }, memberUser('Sarah'), ip);
accept(sl.id);
s.decideLoan(sl.id, { decision: 'approved', comment: 'Consistent saver' }, officer, ip);
s.decideLoan(sl.id, { decision: 'approved' }, manager, ip);
at(addDays(d, 1)); s.disburse(sl.id, { method: 'mobile_money', reference: 'MP240001' }, cashier, ip);
for (let i = 1; i <= 3; i++) { at(addDays(addMonths(addDays(d, 1), i), -1)); s.repay(sl.id, { amount: 206000, method: 'mobile_money', reference: `MP2400${10 + i}` }, cashier, ip); }

// Divine: the worked example — 1,500,000 business loan, 10 months, 1%/month flat = 165,000/month.
// Two installments paid, the third is overdue -> 2% penalty (3,300) when the due-date check runs.
d = addDays(addMonths(T, -3), -5);
at(addDays(d, -3));
const dl = s.applyLoan({ loan_type_id: types.Business, principal: 1500000, months: 10, purpose: 'Buy a second sewing machine and fabric',
  guarantors: [M.Grace.member_no, M.Peter.member_no] }, memberUser('Divine'), ip);
accept(dl.id);
s.decideLoan(dl.id, { decision: 'approved', comment: 'Appraisal passed' }, officer, ip);
s.decideLoan(dl.id, { decision: 'approved' }, manager, ip);
at(d); s.disburse(dl.id, { method: 'mobile_money', reference: 'MP240100' }, cashier, ip);
at(addDays(addMonths(d, 1), -1)); s.repay(dl.id, { amount: 165000, method: 'mobile_money', reference: 'MP240101' }, cashier, ip);
at(addDays(addMonths(d, 2), -2)); s.repay(dl.id, { amount: 165000, method: 'cash' }, cashier, ip);

// Peter: big asset loan above the board threshold — officer + manager approved, waiting for the board
at(addDays(T, -6));
const pl = s.applyLoan({ loan_type_id: types.Asset, principal: 6000000, months: 24, purpose: 'Buy a pickup truck for produce',
  guarantors: [M.Grace.member_no, M.Sarah.member_no] }, memberUser('Peter'), ip);
accept(pl.id);
at(addDays(T, -4)); s.decideLoan(pl.id, { decision: 'approved', comment: 'Strong savings history' }, officer, ip);
at(addDays(T, -3)); s.decideLoan(pl.id, { decision: 'approved', comment: 'Recommend to board' }, manager, ip);

// John: fresh school-fees application, one guarantor accepted, one still pending
at(addDays(T, -1));
const jl = s.applyLoan({ loan_type_id: types['School Fees'], principal: 800000, months: 8, purpose: 'Term 1 school fees for 2 children',
  guarantors: [M.Grace.member_no, M.Sarah.member_no] }, memberUser('John'), ip);
const jg = db.prepare('SELECT g.id FROM loan_guarantors g JOIN members m ON m.id=g.member_id WHERE g.loan_id=? AND m.full_name LIKE ?').get(jl.id, 'Grace%');
s.respondGuarantee(jg.id, 'accepted', memberUser('Grace'), ip);

// Grace: a mistyped deposit that the cashier asked to reverse and the manager approved
at(addDays(T, -2));
const wrong = pay('Grace', 'deposit', { amount: 500000, narration: 'Typed 500,000 instead of 50,000' });
const rr = s.requestReversal(wrong.id, 'Wrong amount keyed (should be 50,000)', cashier, ip);
s.decideReversal(rr.id, 'approved', 'Verified with receipt book', manager, ip);
pay('Grace', 'deposit', { amount: 50000 });

// Moses: stopped saving -> dormant
at(addMonths(T, -1));
s.setMemberStatus(M.Moses.id, { status: 'dormant', reason: 'No savings for 6 months' }, manager, ip);

// Today
setClock(null);
const due = s.processDue();
console.log(`Demo data loaded. Penalties applied: ${due.penalties}, reminders sent: ${due.reminders}.`);
console.log(`
Logins (password):
  admin    / Admin@123     manager / Manager@123    board  / Board@123
  officer  / Officer@123   cashier / Cashier@123
  Members: M00001 (Divine) ... M00006 / Member@123
`);

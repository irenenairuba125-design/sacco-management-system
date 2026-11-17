// SACCO Management System — single-page frontend (no build step, no dependencies)

// ------------------------------------------------------------------ helpers
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const val = (v) => (v instanceof Raw ? v.s : Array.isArray(v) ? v.map(val).join('') : v == null || v === false ? '' : esc(v));
function html(strings, ...vals) { let out = ''; strings.forEach((s, i) => { out += s; if (i < vals.length) out += val(vals[i]); }); return raw(out); }

let ME = null;
let SETTINGS = {};
let LOAN_TYPES = [];

const STAFF = ['admin', 'manager', 'board', 'loan_officer', 'cashier'];
const ALL = [...STAFF, 'member'];
const REGISTRARS = ['admin', 'manager', 'loan_officer', 'cashier'];
const TELLERS = ['cashier', 'manager'];
const APPROVERS = ['loan_officer', 'manager', 'board'];
const AUDITORS = ['admin', 'manager', 'board'];
const has = (...roles) => !!ME && roles.flat().includes(ME.role);

const ROLE_LABEL = { admin: 'Administrator', manager: 'Manager', board: 'Board member', loan_officer: 'Loan officer', cashier: 'Cashier', member: 'Member' };
const LOAN_STATUS = { pending: 'Pending officer review', officer_approved: 'Awaiting manager', manager_approved: 'Awaiting board', approved: 'Approved – to disburse', rejected: 'Rejected', active: 'Active', closed: 'Paid off' };
const TXN_LABEL = { deposit: 'Deposit', withdrawal: 'Withdrawal', share_purchase: 'Share purchase', share_refund: 'Share refund', registration_fee: 'Registration fee', loan_disbursement: 'Loan disbursement', loan_repayment: 'Loan repayment', dividend: 'Dividend', reversal: 'Reversal' };
const METHOD_LABEL = { cash: 'Cash', mobile_money: 'Mobile Money', bank: 'Bank', internal: 'Internal' };

const fmtNum = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const money = (n) => `${SETTINGS.currency || 'UGX'} ${fmtNum(n)}`;
const pct = (n, d = 1) => `${(Number(n || 0) * 100).toFixed(d)}%`;
const date = (s) => (s ? String(s).slice(0, 10) : '');
const dt = (s) => (s ? String(s).slice(0, 16) : '');
const todayStr = () => new Date().toLocaleDateString('en-CA');
const initials = (n) => String(n || '?').split(/\s+/).map((p) => p[0]).slice(0, 2).join('').toUpperCase();
const txnLabel = (t) => (t.type === 'reversal' ? `Reversal of ${TXN_LABEL[t.orig_type] || t.orig_type}` : TXN_LABEL[t.type] || t.type);

function badge(status) {
  const color = { active: 'green', closed: 'blue', approved: 'green', accepted: 'green', simulated: 'blue', sent: 'green',
    dormant: 'amber', pending: 'amber', officer_approved: 'amber', manager_approved: 'amber',
    exited: 'red', rejected: 'red', declined: 'red' }[status] || '';
  return html`<span class="badge ${color}">${LOAN_STATUS[status] && !['active', 'pending'].includes(status) ? LOAN_STATUS[status] : status.replace(/_/g, ' ')}</span>`;
}
const card = (label, value, sub = '', cls = '') => html`<div class="card ${cls}"><div class="label">${label}</div><div class="value">${value}</div>${sub ? html`<div class="sub">${sub}</div>` : ''}</div>`;
const empty = (msg) => html`<p class="empty">${msg}</p>`;
const methodOptions = (sel = 'cash') => Object.entries(METHOD_LABEL).filter(([k]) => k !== 'internal').map(([k, v]) => html`<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`);

async function api(method, url, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && ME) { ME = null; boot(); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== '' && v != null)).toString();

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg; el.className = `toast${isError ? ' error' : ''}`; el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 3500);
}

function parseHash() {
  const h = location.hash.slice(1) || '/';
  const [p, q = ''] = h.split('?');
  return { path: p, query: Object.fromEntries(new URLSearchParams(q)) };
}
const go = (hash) => { if (location.hash === hash) render(); else location.hash = hash; };

// ------------------------------------------------------------------ shared fragments
function txTable(rows, { member = true, actions = false } = {}) {
  if (!rows?.length) return empty('No transactions.');
  return html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Ref</th>${member ? html`<th>Member</th>` : ''}<th>Type</th><th>Method</th><th class="num">Amount</th><th>By</th>${actions ? html`<th></th>` : ''}</tr></thead><tbody>
  ${rows.map((t) => html`<tr class="${t.reversed ? 'reversed' : ''}">
    <td>${dt(t.created_at)}</td><td>TX${t.id}${t.reference ? html`<div class="small muted">${t.reference}</div>` : ''}</td>
    ${member ? html`<td><a href="#/members/${t.member_id}">${t.member_no}</a> ${t.full_name}</td>` : ''}
    <td>${txnLabel(t)}${t.units ? ` (${t.units} sh)` : ''}${t.loan_no ? html` <a href="#/loans/${t.loan_id}">${t.loan_no}</a>` : ''}${t.reversed ? html` <span class="badge red">reversed</span>` : ''}${t.reversal_status === 'pending' ? html` <span class="badge amber">reversal pending</span>` : ''}</td>
    <td>${METHOD_LABEL[t.method] || t.method || ''}</td><td class="num">${fmtNum(t.amount)}</td><td class="small">${t.created_by_name || 'system'}</td>
    ${actions ? html`<td>${!t.reversed && t.type !== 'reversal' && t.reversal_status !== 'pending' ? html`<button class="btn small" data-action="request-reversal" data-id="${t.id}">Reverse…</button>` : ''}</td>` : ''}
  </tr>`)}</tbody></table></div>`;
}

function loansTable(rows, { member = true } = {}) {
  if (!rows?.length) return empty('No loans.');
  return html`<div class="table-wrap"><table><thead><tr><th>Loan</th>${member ? html`<th>Member</th>` : ''}<th>Type</th><th class="num">Principal</th><th class="num">Monthly</th><th class="num">Balance</th><th class="num">Arrears</th><th>Status</th><th>Applied</th></tr></thead><tbody>
  ${rows.map((l) => html`<tr class="${l.status === 'active' && l.arrears > 0 ? 'overdue' : ''}">
    <td><a href="#/loans/${l.id}">${l.loan_no}</a></td>
    ${member ? html`<td>${l.member_no} ${l.full_name}</td>` : ''}
    <td>${l.type_name}</td><td class="num">${fmtNum(l.principal)}</td><td class="num">${fmtNum(l.installment)}</td>
    <td class="num">${['active', 'closed'].includes(l.status) ? fmtNum(l.balance) : '—'}</td>
    <td class="num ${l.arrears > 0 ? 'neg' : ''}">${l.status === 'active' ? fmtNum(l.arrears) : '—'}</td>
    <td>${badge(l.status)}</td><td>${date(l.applied_at)}</td></tr>`)}</tbody></table></div>`;
}

function memberLookupField(name = 'member_no', label = 'Member No.', value = '') {
  return html`<label>${label}<input name="${name}" value="${value}" required data-lookup placeholder="e.g. M00001" autocomplete="off"><span class="lookup"></span></label>`;
}

// ------------------------------------------------------------------ pages: dashboard
async function pageDashboard() {
  const d = await api('GET', '/api/reports/dashboard');
  const mc = Object.fromEntries(d.members.map((r) => [r.status, r.n]));
  const pipe = Object.fromEntries(d.pipeline.map((r) => [r.status, r]));
  return html`<div class="page-head"><div><h1>Dashboard</h1><p class="muted">${SETTINGS.sacco_name} · ${d.date}</p></div>
    <div class="actions">${has(TELLERS) ? html`<a class="btn primary" href="#/transactions">Post transaction</a>` : ''}${has(REGISTRARS) ? html`<a class="btn" href="#/members/new">Register member</a>` : ''}</div></div>
  <div class="cards">
    ${card('Members', fmtNum((mc.active || 0) + (mc.dormant || 0)), `${mc.active || 0} active · ${mc.dormant || 0} dormant · ${mc.exited || 0} exited`)}
    ${card('Total savings', money(d.totals.savings))}
    ${card('Share capital', money(d.totals.share_capital), `${fmtNum(d.totals.units)} shares`)}
    ${card('Loans outstanding', money(d.loans.outstanding), `${d.loans.active} active loans`)}
    ${card('In arrears', money(d.loans.arrears), `${d.defaulters} defaulter(s) · Portfolio at risk ${pct(d.loans.par)}`, d.defaulters ? 'warn' : '')}
    ${card("Today's cash (net)", money(d.cash.net), `In ${fmtNum(d.cash.cash_in)} · Out ${fmtNum(d.cash.cash_out)}`)}
  </div>
  <div class="grid2">
    <section class="panel"><h2>Loan approval pipeline</h2>
      <table><tbody>
        ${['pending', 'officer_approved', 'manager_approved', 'approved'].map((s) => html`<tr><td>${LOAN_STATUS[s]}</td><td class="num">${pipe[s]?.n || 0}</td><td class="num">${money(pipe[s]?.amount || 0)}</td></tr>`)}
        <tr><td>Reversal requests waiting</td><td class="num">${d.pending_reversals}</td><td></td></tr>
      </tbody></table>
      <p><a href="#/approvals">Open approvals →</a> · <a href="#/reports?tab=defaulters">Defaulters list →</a></p>
    </section>
    <section class="panel"><h2>Recent transactions</h2>${txTable(d.recent.slice(0, 8))}</section>
  </div>`;
}

// ------------------------------------------------------------------ pages: member portal
async function pageMy() {
  const d = await api('GET', '/api/my/summary');
  const b = d.balances; const m = d.member; const ni = d.next_installment;
  const active = d.loans.find((l) => l.status === 'active');
  return html`<div class="page-head"><div class="who">${d.photo ? html`<img class="avatar" src="${d.photo}" alt="">` : html`<div class="avatar">${initials(m.full_name)}</div>`}
      <div><h1>Hello, ${m.full_name.split(' ')[0]}</h1><p class="muted">Member ${m.member_no} · ${badge(m.status)}</p></div></div>
    <div class="actions"><a class="btn" href="#/statement">My statement</a>${!d.loans.some((l) => ['pending', 'officer_approved', 'manager_approved', 'approved', 'active'].includes(l.status)) ? html`<a class="btn primary" href="#/loans/new">Apply for a loan</a>` : ''}</div></div>
  ${d.pending_guarantees.length ? html`<div class="callout warn">${d.pending_guarantees.length} member(s) asked you to guarantee their loan. <a href="#/guarantees">Respond now →</a></div>` : ''}
  <div class="cards">
    ${card('My savings', money(b.savings), b.locked_savings ? `${money(b.locked_savings)} held as loan security` : 'Available to withdraw')}
    ${card('My shares', `${fmtNum(b.share_units)} shares`, money(b.share_value))}
    ${card('Loan balance', money(b.loan_balance), active ? `${active.loan_no} · ${fmtNum(active.installment)} / month` : 'No running loan')}
    ${card('I can borrow up to', money(b.loan_limit), `${SETTINGS.savings_multiplier}× my savings`)}
  </div>
  ${ni ? html`<div class="callout ${ni.due_date < todayStr() ? 'bad' : ''}">Next repayment: <b>${money(ni.amount_due - ni.amount_paid + ni.penalty - ni.penalty_paid)}</b> due <b>${ni.due_date}</b>${ni.penalty ? html` (includes penalty ${money(ni.penalty - ni.penalty_paid)})` : ''}. <a href="#/loans/${active.id}">View schedule →</a></div>` : ''}
  <div class="grid2">
    <section class="panel"><h2>Recent transactions</h2>${txTable(d.recent, { member: false })}</section>
    <section class="panel"><h2>My loans</h2>${loansTable(d.loans, { member: false })}
      <h3>Before you apply</h3><ul class="small muted"><li>Save for at least ${d.eligibility.min_savings_months} months</li><li>Own at least ${d.eligibility.min_shares} shares</li><li>Get ${d.eligibility.min_guarantors} members to guarantee you</li><li>Borrow up to ${SETTINGS.savings_multiplier}× your savings</li></ul>
    </section>
  </div>`;
}

async function pageGuarantees() {
  const rows = await api('GET', '/api/my/guarantees');
  return html`<h1>Guarantee requests</h1><p class="muted">When you guarantee a loan, you promise to help repay it if the borrower fails.</p>
  <section class="panel">${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Loan</th><th>Borrower</th><th class="num">Amount</th><th>Purpose</th><th>Loan status</th><th>Your answer</th><th></th></tr></thead><tbody>
  ${rows.map((g) => html`<tr><td><a href="#/loans/${g.loan_id}">${g.loan_no}</a></td><td>${g.applicant_no} ${g.applicant_name}</td><td class="num">${fmtNum(g.principal)}</td><td>${g.purpose}</td><td>${badge(g.loan_status)}</td><td>${badge(g.status)}</td>
    <td>${g.status === 'pending' && g.loan_status === 'pending' ? html`<div class="actions"><button class="btn small primary" data-action="guarantee" data-id="${g.id}" data-decision="accepted">Accept</button><button class="btn small danger" data-action="guarantee" data-id="${g.id}" data-decision="declined">Decline</button></div>` : ''}</td></tr>`)}
  </tbody></table></div>` : empty('Nobody has asked you to guarantee a loan.')}</section>`;
}

// ------------------------------------------------------------------ pages: members
async function pageMembers({ query }) {
  const rows = await api('GET', `/api/members?${qs({ q: query.q, status: query.status })}`);
  return html`<div class="page-head"><h1>Members</h1>${has(REGISTRARS) ? html`<a class="btn primary" href="#/members/new">+ Register member</a>` : ''}</div>
  <section class="panel">
    <form class="inline-form" data-form="filter" data-path="/members">
      <label>Search<input name="q" value="${query.q || ''}" placeholder="Name, member no., phone or NIN"></label>
      <label>Status<select name="status"><option value="">All</option>${['active', 'dormant', 'exited'].map((s) => html`<option ${query.status === s ? 'selected' : ''}>${s}</option>`)}</select></label>
      <button class="btn">Search</button></form>
    ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>No.</th><th>Name</th><th>Phone</th><th>Status</th><th class="num">Savings</th><th class="num">Shares</th><th class="num">Loan balance</th><th>Joined</th></tr></thead><tbody>
    ${rows.map((m) => html`<tr><td><a href="#/members/${m.id}">${m.member_no}</a></td><td><a href="#/members/${m.id}">${m.full_name}</a></td><td>${m.phone}</td><td>${badge(m.status)}</td>
      <td class="num">${fmtNum(m.savings)}</td><td class="num">${fmtNum(m.share_units)}</td><td class="num">${fmtNum(m.loan_balance)}</td><td>${m.joined_at}</td></tr>`)}
    </tbody><tfoot><tr><td colspan="4">${rows.length} member(s)</td><td class="num">${fmtNum(rows.reduce((s, r) => s + r.savings, 0))}</td><td class="num">${fmtNum(rows.reduce((s, r) => s + r.share_units, 0))}</td><td class="num">${fmtNum(rows.reduce((s, r) => s + r.loan_balance, 0))}</td><td></td></tr></tfoot></table></div>` : empty('No members found.')}
  </section>`;
}

async function pageMemberForm({ params }) {
  const id = params[0];
  const m = id ? (await api('GET', `/api/members/${id}`)).member : {};
  const f = (name, label, opts = '') => html`<label>${label}<input name="${name}" value="${m[name] || ''}" ${raw(opts)}></label>`;
  return html`<h1>${id ? `Edit ${m.full_name}` : 'Register a new member'}</h1>
  <form class="panel stack" data-form="member" data-id="${id || ''}">
    <fieldset><legend>Personal details</legend><div class="form-grid">
      ${f('full_name', 'Full name *', 'required maxlength="120"')}${f('nin', 'National ID (NIN) *', 'required maxlength="20"')}
      ${f('phone', 'Phone *', 'required placeholder="0772123456"')}${f('email', 'Email', 'type="email"')}
      ${f('date_of_birth', 'Date of birth', 'type="date"')}
      <label>Gender<select name="gender"><option value=""></option>${['Female', 'Male'].map((g) => html`<option ${m.gender === g ? 'selected' : ''}>${g}</option>`)}</select></label>
      ${f('occupation', 'Occupation')}${f('address', 'Address / village')}
    </div></fieldset>
    <fieldset><legend>Next of kin</legend><div class="form-grid">
      ${f('next_of_kin_name', 'Name *', 'required')}${f('next_of_kin_phone', 'Phone *', 'required')}${f('next_of_kin_relation', 'Relationship')}
    </div></fieldset>
    <fieldset><legend>Photo</legend><div class="actions">
      <img class="photo-preview" alt="" ${m.photo ? raw(`src="${esc(m.photo)}"`) : raw('hidden')}>
      <label>Upload passport photo<input type="file" accept="image/png,image/jpeg" data-photo></label>
      <input type="hidden" name="photo" value="${m.photo || ''}">
    </div></fieldset>
    ${id ? '' : html`<fieldset><legend>Opening payments (optional)</legend><div class="form-grid">
      <label class="check"><input type="checkbox" name="pay_registration_fee" checked> Registration fee paid (${money(SETTINGS.registration_fee)})</label>
      <label>Initial shares (@ ${money(SETTINGS.share_price)})<input type="number" name="initial_shares" min="0" step="1" value="${SETTINGS.min_shares}"></label>
      <label>Initial savings deposit<input type="number" name="initial_deposit" min="0" step="1"></label>
      <label>Paid by<select name="method">${methodOptions()}</select></label>
      <label>Reference (MoMo/bank)<input name="reference" maxlength="60"></label>
    </div></fieldset>
    <fieldset><legend>Member portal login</legend><div class="form-grid">
      <label class="check"><input type="checkbox" name="create_login"> Create a login (username = member number)</label>
      <label>Temporary password<input name="password" type="text" placeholder="min 8 chars, letters + numbers"></label>
    </div></fieldset>`}
    <div class="actions"><button class="btn primary">${id ? 'Save changes' : 'Register member'}</button><a class="btn" href="${id ? `#/members/${id}` : '#/members'}">Cancel</a></div>
  </form>`;
}

async function pageMember({ params }) {
  const id = params[0];
  const d = await api('GET', `/api/members/${id}`);
  const m = d.member; const b = d.balances;
  const open = d.loans.find((l) => ['pending', 'officer_approved', 'manager_approved', 'approved', 'active'].includes(l.status));
  return html`<div class="page-head"><div class="who">${m.photo ? html`<img class="avatar" src="${m.photo}" alt="">` : html`<div class="avatar">${initials(m.full_name)}</div>`}
      <div><h1>${m.full_name}</h1><p class="muted">${m.member_no} · ${badge(m.status)} · joined ${m.joined_at}</p></div></div>
    <div class="actions">${has(REGISTRARS) && m.status !== 'exited' ? html`<a class="btn" href="#/members/${id}/edit">Edit</a>` : ''}
      <a class="btn" href="#/members/${id}/statement">Statement</a>
      ${has('loan_officer', 'manager') && m.status === 'active' && !open ? html`<a class="btn primary" href="#/loans/new?member=${m.member_no}">New loan</a>` : ''}</div></div>
  <div class="cards">
    ${card('Savings', money(b.savings), b.locked_savings ? `${money(b.locked_savings)} held as loan security` : '')}
    ${card('Shares', `${fmtNum(b.share_units)} shares`, money(b.share_value))}
    ${card('Loan balance', money(b.loan_balance), open ? `${open.loan_no} · ${LOAN_STATUS[open.status]}` : 'No open loan')}
    ${card('Loan limit', money(b.loan_limit), `${SETTINGS.savings_multiplier}× savings`)}
  </div>
  <div class="grid2">
    <section class="panel"><h2>Details</h2><dl class="dl">
      <dt>NIN</dt><dd>${m.nin}</dd><dt>Phone</dt><dd>${m.phone}</dd><dt>Email</dt><dd>${m.email || '—'}</dd>
      <dt>Date of birth</dt><dd>${m.date_of_birth || '—'}</dd><dt>Gender</dt><dd>${m.gender || '—'}</dd>
      <dt>Occupation</dt><dd>${m.occupation || '—'}</dd><dt>Address</dt><dd>${m.address || '—'}</dd>
      <dt>Next of kin</dt><dd>${m.next_of_kin_name} (${m.next_of_kin_relation || '—'}) · ${m.next_of_kin_phone}</dd>
      <dt>Portal login</dt><dd>${d.login ? html`${d.login.username} ${d.login.active ? '' : html`<span class="badge red">disabled</span>`} <span class="muted small">last login ${dt(d.login.last_login_at) || 'never'}</span>` : 'None'}</dd>
    </dl>
    ${!d.login && has(REGISTRARS) && m.status !== 'exited' ? html`<h3>Create portal login</h3><form class="inline-form" data-form="member-login" data-id="${id}"><label>Temporary password<input name="password" required minlength="8"></label><button class="btn">Create login</button></form>` : ''}
    ${has('admin', 'manager') && m.status !== 'exited' ? html`<h3>Change status</h3><form class="inline-form" data-form="member-status" data-id="${id}">
      <label>New status<select name="status">${['active', 'dormant', 'exited'].filter((s) => s !== m.status).map((s) => html`<option>${s}</option>`)}</select></label>
      <label>Reason<input name="reason" required></label><label>Refund shares via<select name="method">${methodOptions()}</select></label><button class="btn">Update</button></form>
      <p class="small muted">Exiting requires no open loan, no active guarantees and zero savings. Shares are refunded automatically.</p>` : ''}
    </section>
    ${has(TELLERS) && m.status !== 'exited' ? html`<section class="panel"><h2>Post a transaction</h2>${tellerForm(m.member_no)}</section>` : ''}
  </div>
  <section class="panel"><h2>Loans</h2>${loansTable(d.loans, { member: false })}</section>
  ${d.guarantees.length ? html`<section class="panel"><h2>Loans this member guarantees</h2><table><thead><tr><th>Loan</th><th>Borrower</th><th class="num">Amount</th><th>Loan status</th><th>Guarantee</th><th></th></tr></thead><tbody>
    ${d.guarantees.map((g) => html`<tr><td><a href="#/loans/${g.loan_id}">${g.loan_no}</a></td><td>${g.applicant_no} ${g.applicant_name}</td><td class="num">${fmtNum(g.principal)}</td><td>${badge(g.loan_status)}</td><td>${badge(g.status)}</td><td></td></tr>`)}</tbody></table></section>` : ''}
  <section class="panel"><h2>Recent transactions</h2>${txTable(d.recent, { member: false, actions: has(TELLERS) })}</section>`;
}

function tellerForm(memberNo) {
  return html`<form class="stack" data-form="teller">
    ${memberNo ? html`<input type="hidden" name="member_no" value="${memberNo}">` : memberLookupField()}
    <div class="form-grid">
      <label>Transaction<select name="type" data-toggle-units>
        <option value="deposit">Savings deposit</option><option value="withdrawal">Savings withdrawal</option>
        <option value="share_purchase">Buy shares</option><option value="registration_fee">Registration fee</option></select></label>
      <label data-amount>Amount (${SETTINGS.currency})<input type="number" name="amount" min="500" step="1"></label>
      <label data-units hidden>Number of shares (${money(SETTINGS.share_price)} each)<input type="number" name="units" min="1" step="1"></label>
      <label>Method<select name="method">${methodOptions()}</select></label>
      <label>Reference (MoMo / bank)<input name="reference" maxlength="60"></label>
      <label>Narration<input name="narration" maxlength="200"></label>
    </div>
    <div><button class="btn primary">Post transaction</button></div></form>`;
}

async function pageStatement({ params, query }) {
  const id = params[0] || ME.member_id;
  const d = await api('GET', `/api/members/${id}/statement?${qs({ from: query.from, to: query.to })}`);
  const m = d.member;
  const back = ME.role === 'member' ? '#/my' : `#/members/${id}`;
  return html`<div class="page-head no-print"><h1>Member statement</h1><div class="actions"><a class="btn" href="${back}">← Back</a><button class="btn primary" data-action="print">Print / Save PDF</button></div></div>
  <section class="panel">
    <form class="inline-form" data-form="filter" data-path="${location.hash.slice(1).split('?')[0]}">
      <label>From<input type="date" name="from" value="${query.from || ''}"></label><label>To<input type="date" name="to" value="${query.to || ''}"></label><button class="btn">Show</button></form>
    <h2>${d.sacco_name} — Statement of account</h2>
    <dl class="dl"><dt>Member</dt><dd>${m.member_no} · ${m.full_name}</dd><dt>Phone</dt><dd>${m.phone}</dd>
      <dt>Period</dt><dd>${d.from || 'start'} to ${d.to || 'today'}</dd><dt>Generated</dt><dd>${d.generated_at}</dd></dl>
    <div class="cards" style="margin-top:12px">${card('Savings', money(d.balances.savings))}${card('Shares', `${fmtNum(d.balances.share_units)} (${money(d.balances.share_value)})`)}${card('Loan balance', money(d.balances.loan_balance))}</div>
    <h3>Savings & shares</h3>
    <div class="table-wrap"><table><thead><tr><th>Date</th><th>Ref</th><th>Description</th><th class="num">Savings in</th><th class="num">Savings out</th><th class="num">Savings balance</th><th class="num">Shares</th><th class="num">Other</th></tr></thead><tbody>
      <tr><td>${d.from || ''}</td><td></td><td><i>Opening balance</i></td><td></td><td></td><td class="num">${fmtNum(d.opening_balance)}</td><td class="num">${fmtNum(d.opening_units)}</td><td></td></tr>
      ${d.transactions.map((t) => html`<tr><td>${date(t.created_at)}</td><td>TX${t.id}</td><td>${txnLabel(t)}${t.loan_no ? ` ${t.loan_no}` : ''}${t.narration ? html`<div class="small muted">${t.narration}</div>` : ''}</td>
        <td class="num">${t.savings_effect > 0 ? fmtNum(t.savings_effect) : ''}</td><td class="num">${t.savings_effect < 0 ? fmtNum(-t.savings_effect) : ''}</td>
        <td class="num">${fmtNum(t.savings_balance)}</td><td class="num">${t.units_effect ? `${t.units_effect > 0 ? '+' : ''}${t.units_effect} → ${t.share_units}` : ''}</td>
        <td class="num">${!t.savings_effect && !t.units_effect ? fmtNum(t.amount) : ''}</td></tr>`)}
    </tbody></table></div>
    <h3>Loans</h3>${loansTable(d.loans, { member: false })}
  </section>`;
}

// ------------------------------------------------------------------ pages: transactions
async function pageTransactions({ query }) {
  const day = query.date || todayStr();
  const [rows, reversals] = await Promise.all([
    api('GET', `/api/transactions?${qs({ date: query.q ? '' : day, q: query.q, type: query.type })}`),
    api('GET', '/api/reversals?status=pending'),
  ]);
  return html`<h1>Transactions</h1>
  <div class="grid2">
    ${has(TELLERS) ? html`<section class="panel"><h2>Post deposit / withdrawal / shares</h2>${tellerForm()}</section>` : ''}
    <section class="panel"><h2>Reversal requests</h2>
      <p class="small muted">Transactions are never deleted. A cashier requests a reversal; a manager (a different person) approves it.</p>
      ${reversals.length ? html`<table><thead><tr><th>Txn</th><th>Member</th><th class="num">Amount</th><th>Reason</th><th></th></tr></thead><tbody>
      ${reversals.map((r) => html`<tr><td>TX${r.transaction_id}<div class="small muted">${TXN_LABEL[r.type]}</div></td><td>${r.member_no} ${r.full_name}</td><td class="num">${fmtNum(r.amount)}</td><td>${r.reason}<div class="small muted">by ${r.requested_by_name}</div></td>
        <td>${has('manager') && r.requested_by !== ME.id ? html`<div class="actions"><button class="btn small primary" data-action="decide-reversal" data-id="${r.id}" data-decision="approved">Approve</button><button class="btn small danger" data-action="decide-reversal" data-id="${r.id}" data-decision="rejected">Reject</button></div>` : html`<span class="badge amber">waiting for manager</span>`}</td></tr>`)}</tbody></table>` : empty('No pending reversal requests.')}
    </section>
  </div>
  <section class="panel"><h2>Transaction register</h2>
    <form class="inline-form" data-form="filter" data-path="/transactions">
      <label>Date<input type="date" name="date" value="${day}"></label>
      <label>Search all dates<input name="q" value="${query.q || ''}" placeholder="Member no, name or reference"></label>
      <label>Type<select name="type"><option value="">All</option>${Object.entries(TXN_LABEL).map(([k, v]) => html`<option value="${k}" ${query.type === k ? 'selected' : ''}>${v}</option>`)}</select></label>
      <button class="btn">Show</button></form>
    ${txTable(rows, { actions: has(TELLERS) })}
  </section>`;
}

// ------------------------------------------------------------------ pages: loans
async function pageLoans({ query }) {
  const status = query.status ?? (ME.role === 'member' ? '' : 'active');
  const rows = await api('GET', `/api/loans?${qs({ status, q: query.q })}`);
  const tabs = [['active', 'Active'], ['pending,officer_approved,manager_approved', 'In approval'], ['approved', 'To disburse'], ['closed', 'Paid off'], ['rejected', 'Rejected'], ['', 'All']];
  return html`<div class="page-head"><h1>${ME.role === 'member' ? 'My loans' : 'Loans'}</h1><div class="actions"><a class="btn" href="#/calculator">Calculator</a>${has('member', 'loan_officer', 'manager') ? html`<a class="btn primary" href="#/loans/new">+ New application</a>` : ''}</div></div>
  <section class="panel">
    ${ME.role !== 'member' ? html`<nav class="tabs">${tabs.map(([s, l]) => html`<a href="#/loans?status=${s}" class="${status === s ? 'active' : ''}">${l}</a>`)}</nav>
    <form class="inline-form" data-form="filter" data-path="/loans"><input type="hidden" name="status" value="${status}"><label>Search<input name="q" value="${query.q || ''}" placeholder="Loan no, member no or name"></label><button class="btn">Search</button></form>` : ''}
    ${loansTable(rows, { member: ME.role !== 'member' })}
  </section>`;
}

async function pageLoanNew({ query }) {
  LOAN_TYPES = await api('GET', '/api/loan-types');
  const types = LOAN_TYPES.filter((t) => t.active);
  let info = '';
  if (ME.role === 'member') {
    const s = await api('GET', '/api/my/summary');
    info = html`<div class="callout">Your savings: <b>${money(s.balances.savings)}</b> · Shares: <b>${s.balances.share_units}</b> · You can borrow up to <b>${money(s.balances.loan_limit)}</b>. You need ${SETTINGS.min_guarantors} guarantor(s) who are active members.</div>`;
  }
  return html`<h1>Loan application</h1>${info}
  <form class="panel stack" data-form="apply-loan" data-quote>
    <div class="form-grid">
      ${ME.role === 'member' ? '' : memberLookupField('member_no', 'Applicant member no. *', query.member || '')}
      <label>Loan type *<select name="loan_type_id" required>${types.map((t) => html`<option value="${t.id}" data-rate="${t.interest_rate}" data-max="${t.max_months}">${t.name} — ${t.interest_rate}% / month, up to ${t.max_months} months</option>`)}</select></label>
      <label>Amount (${SETTINGS.currency}) *<input type="number" name="principal" min="10000" step="1000" required></label>
      <label>Repayment period (months) *<input type="number" name="months" min="1" step="1" value="10" required></label>
    </div>
    <label>Purpose *<textarea name="purpose" required maxlength="500" placeholder="What will the money be used for?"></textarea></label>
    <label>Guarantors (member numbers, separated by commas)<input name="guarantors" data-lookup placeholder="e.g. M00003, M00004"><span class="lookup"></span></label>
    <div class="quote" data-quote-out>Enter an amount to see the repayment.</div>
    <div class="actions"><button class="btn primary">Submit application</button><a class="btn" href="#/loans">Cancel</a></div>
  </form>`;
}

function steps(d) {
  const l = d.loan;
  const order = ['applied', 'officer', 'manager', ...(d.needs_board ? ['board'] : []), 'disbursed', 'repaid'];
  const done = new Set(['applied', ...d.approvals.filter((a) => a.decision === 'approved').map((a) => a.level)]);
  if (['active', 'closed'].includes(l.status)) done.add('disbursed');
  if (l.status === 'closed') done.add('repaid');
  const failed = d.approvals.find((a) => a.decision === 'rejected')?.level;
  const current = d.next_level || (l.status === 'approved' ? 'disbursed' : l.status === 'active' ? 'repaid' : null);
  return html`<div class="steps">${order.map((s) => html`<span class="${s === failed ? 'failed' : done.has(s) ? 'done' : s === current ? 'current' : ''}">${{ applied: 'Applied', officer: 'Loan officer', manager: 'Manager', board: 'Board', disbursed: 'Disbursed', repaid: 'Repaid' }[s]}</span>`)}</div>`;
}

async function pageLoan({ params }) {
  const d = await api('GET', `/api/loans/${params[0]}`);
  const l = d.loan; const t = d.totals;
  const today = todayStr();
  const isOwner = ME.role === 'member' && ME.member_id === l.member_id;
  return html`<div class="page-head"><div><h1>Loan ${l.loan_no} ${badge(l.status)}</h1>
      <p class="muted">${ME.role === 'member' ? l.full_name : html`<a href="#/members/${l.member_id}">${l.member_no} ${l.full_name}</a>`} · ${l.type_name} · applied ${date(l.applied_at)}</p></div>
    <div class="actions"><button class="btn" data-action="print">Print</button></div></div>
  ${steps(d)}
  <div class="cards">
    ${card('Principal', money(l.principal), `${l.interest_rate}% flat per month × ${l.months} months`)}
    ${card('Interest', money(l.total_interest), `Total to pay ${money(l.total_payable)}`)}
    ${card('Monthly installment', money(l.installment))}
    ${['active', 'closed'].includes(l.status) ? card('Balance', money(t.balance), `Paid ${money(t.paid + t.penalty_paid)}${t.penalty ? ` · penalties ${money(t.penalty)}` : ''}`, t.arrears > 0 ? 'bad' : '') : ''}
    ${l.status === 'active' && t.arrears > 0 ? card('In arrears', money(t.arrears), 'Overdue installments', 'bad') : ''}
  </div>
  <div class="grid2">
    <section class="panel"><h2>Application</h2><dl class="dl"><dt>Purpose</dt><dd>${l.purpose}</dd><dt>Phone</dt><dd>${l.phone}</dd>
      ${l.disbursed_at ? html`<dt>Disbursed</dt><dd>${dt(l.disbursed_at)} via ${METHOD_LABEL[l.disburse_method]} ${l.disburse_reference || ''}</dd>` : ''}
      ${l.closed_at ? html`<dt>Paid off</dt><dd>${dt(l.closed_at)}</dd>` : ''}
      ${d.needs_board ? html`<dt>Board</dt><dd>Above ${money(SETTINGS.board_threshold)} — board approval required</dd>` : ''}</dl>
      ${d.appraisal ? html`<h3>Appraisal ${d.appraisal.passed ? html`<span class="badge green">passed</span>` : html`<span class="badge red">not yet passed</span>`}</h3>
        <ul class="checks">${d.appraisal.checks.map((c) => html`<li class="${c.pass ? 'ok' : 'no'}"><span class="mark">${c.pass ? '✓' : '✗'}</span><span>${c.label}<div class="small muted">${c.detail}</div></span></li>`)}</ul>` : ''}
    </section>
    <section class="panel"><h2>Guarantors</h2>
      ${d.guarantors.length ? html`<table><tbody>${d.guarantors.map((g) => html`<tr><td>${g.member_no} ${g.full_name}<div class="small muted">${g.phone}</div></td><td>${badge(g.status)}</td>
        <td>${l.status === 'pending' && g.status === 'pending' && (has('loan_officer', 'manager') || (ME.role === 'member' && ME.member_id === g.member_id)) ? html`<div class="actions"><button class="btn small primary" data-action="guarantee" data-id="${g.id}" data-decision="accepted">${ME.role === 'member' ? 'Accept' : 'Record accepted'}</button><button class="btn small danger" data-action="guarantee" data-id="${g.id}" data-decision="declined">Declined</button></div>` : ''}</td></tr>`)}</tbody></table>` : empty('No guarantors yet.')}
      ${l.status === 'pending' && (isOwner || has('loan_officer', 'manager')) ? html`<form class="inline-form" data-form="add-guarantor" data-id="${l.id}"><label>Add guarantor<input name="member_no" data-lookup placeholder="Member no."><span class="lookup"></span></label><button class="btn">Add</button></form>` : ''}
      <h3>Approvals</h3>
      ${d.approvals.length ? html`<table><tbody>${d.approvals.map((a) => html`<tr><td>${a.level}</td><td>${badge(a.decision)}</td><td>${a.user_name}<div class="small muted">${dt(a.created_at)}</div></td><td>${a.comment || ''}</td></tr>`)}</tbody></table>` : empty('No decisions yet.')}
      ${d.can_decide ? html`<form class="stack" data-form="decide-loan" data-id="${l.id}"><h3>Your decision (${d.next_level} level)</h3>
        <label>Comment<textarea name="comment" placeholder="Required when rejecting"></textarea></label>
        <div class="actions"><button class="btn primary" name="decision" value="approved" ${d.appraisal?.passed ? '' : raw('disabled title="Appraisal must pass first"')}>Approve</button><button class="btn danger" name="decision" value="rejected">Reject</button></div></form>` : ''}
      ${d.next_level && !d.can_decide && STAFF.includes(ME.role) ? html`<p class="small muted">Waiting for ${d.next_level} approval${d.already_acted ? ' — you already acted on this loan, so another person must approve this level' : ''}.</p>` : ''}
      ${l.status === 'approved' && has(TELLERS) ? html`<form class="stack" data-form="disburse" data-id="${l.id}"><h3>Disburse ${money(l.principal)}</h3><div class="form-grid">
        <label>Send via<select name="method">${methodOptions('mobile_money')}</select></label><label>MoMo / bank reference<input name="reference"></label></div>
        <div><button class="btn primary">Disburse loan</button></div></form>` : ''}
      ${l.status === 'active' && has(TELLERS) ? html`<form class="stack" data-form="repay" data-id="${l.id}"><h3>Record repayment</h3><div class="form-grid">
        <label>Amount<input type="number" name="amount" min="500" max="${t.balance}" value="${Math.min(l.installment, t.balance)}" required></label>
        <label>Method<select name="method">${methodOptions()}</select></label><label>Reference<input name="reference"></label></div>
        <div><button class="btn primary">Post repayment</button></div></form>` : ''}
    </section>
  </div>
  ${d.schedule.length ? html`<section class="panel"><h2>Repayment schedule</h2><div class="table-wrap"><table><thead><tr><th>#</th><th>Due date</th><th class="num">Principal</th><th class="num">Interest</th><th class="num">Installment</th><th class="num">Penalty</th><th class="num">Paid</th><th class="num">Outstanding</th><th>Status</th></tr></thead><tbody>
    ${d.schedule.map((s) => { const out = s.amount_due + s.penalty - s.amount_paid - s.penalty_paid; const overdue = out > 0 && s.amount_paid < s.amount_due && s.due_date < today;
      return html`<tr class="${overdue ? 'overdue' : out === 0 ? 'paid' : ''}"><td>${s.installment_no}</td><td>${s.due_date}</td><td class="num">${fmtNum(s.principal_due)}</td><td class="num">${fmtNum(s.interest_due)}</td><td class="num">${fmtNum(s.amount_due)}</td><td class="num">${s.penalty ? fmtNum(s.penalty) : ''}</td><td class="num">${fmtNum(s.amount_paid + s.penalty_paid)}</td><td class="num">${fmtNum(out)}</td><td>${out === 0 ? html`<span class="badge green">paid</span>` : overdue ? html`<span class="badge red">overdue</span>` : s.amount_paid ? html`<span class="badge amber">part paid</span>` : ''}</td></tr>`; })}
    </tbody><tfoot><tr><td colspan="2">Total</td><td class="num">${fmtNum(l.principal)}</td><td class="num">${fmtNum(l.total_interest)}</td><td class="num">${fmtNum(t.due)}</td><td class="num">${fmtNum(t.penalty)}</td><td class="num">${fmtNum(t.paid + t.penalty_paid)}</td><td class="num">${fmtNum(t.balance)}</td><td></td></tr></tfoot></table></div></section>` : ''}
  ${d.payments.length ? html`<section class="panel"><h2>Disbursement & repayments</h2>${txTable(d.payments, { member: false, actions: has(TELLERS) })}</section>` : ''}`;
}

async function pageApprovals() {
  const d = await api('GET', '/api/approvals');
  const mine = d.loans.filter((l) => !l.already_acted);
  return html`<h1>Approvals</h1>
  <section class="panel"><h2>Loans waiting for you (${mine.length})</h2>${loansTable(mine)}
    ${d.loans.length > mine.length ? html`<p class="small muted">${d.loans.length - mine.length} more loan(s) at this level need someone else (you captured or already approved them).</p>` : ''}</section>
  ${d.to_disburse.length || has(TELLERS) ? html`<section class="panel"><h2>Approved — ready to disburse</h2>${loansTable(d.to_disburse)}</section>` : ''}
  ${has('manager') ? html`<section class="panel"><h2>Reversal requests</h2>${d.reversals.length ? html`<table><thead><tr><th>Txn</th><th>Member</th><th class="num">Amount</th><th>Reason</th><th></th></tr></thead><tbody>
    ${d.reversals.map((r) => html`<tr><td>TX${r.transaction_id} · ${TXN_LABEL[r.type]}<div class="small muted">${dt(r.txn_date)}</div></td><td>${r.member_no} ${r.full_name}</td><td class="num">${fmtNum(r.amount)}</td><td>${r.reason}<div class="small muted">requested by ${r.requested_by_name}</div></td>
      <td>${r.requested_by !== ME.id ? html`<div class="actions"><button class="btn small primary" data-action="decide-reversal" data-id="${r.id}" data-decision="approved">Approve</button><button class="btn small danger" data-action="decide-reversal" data-id="${r.id}" data-decision="rejected">Reject</button></div>` : 'Your request'}</td></tr>`)}</tbody></table>` : empty('None pending.')}</section>` : ''}`;
}

async function pageCalculator({ query }) {
  LOAN_TYPES = await api('GET', '/api/loan-types');
  const types = LOAN_TYPES.filter((t) => t.active);
  let result = '';
  if (query.principal) {
    try {
      const r = await api('GET', `/api/calculator?${qs(query)}`);
      result = html`<div class="cards">${card('Interest', money(r.total_interest), `${r.interest_rate}% × ${r.months} months`)}${card('Total to pay', money(r.total_payable))}${card('Monthly installment', money(r.installment))}</div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Due (if taken today)</th><th class="num">Principal</th><th class="num">Interest</th><th class="num">Installment</th></tr></thead><tbody>
      ${r.schedule.map((s) => html`<tr><td>${s.installment_no}</td><td>${s.due_date}</td><td class="num">${fmtNum(s.principal_due)}</td><td class="num">${fmtNum(s.interest_due)}</td><td class="num">${fmtNum(s.amount_due)}</td></tr>`)}</tbody></table></div>
      <p class="small muted">Late payment penalty: ${SETTINGS.penalty_rate}% of the overdue installment (${SETTINGS.penalty_frequency === 'weekly' ? 'every week it stays unpaid' : 'once per missed installment'}), e.g. ${money(r.installment * SETTINGS.penalty_rate / 100)} on one missed installment.</p>`;
    } catch (e) { result = html`<div class="callout bad">${e.message}</div>`; }
  }
  return html`<h1>Loan calculator</h1><section class="panel">
    <form class="inline-form" data-form="filter" data-path="/calculator">
      <label>Loan type<select name="loan_type_id">${types.map((t) => html`<option value="${t.id}" ${String(t.id) === query.loan_type_id ? 'selected' : ''}>${t.name} (${t.interest_rate}%/month)</option>`)}</select></label>
      <label>Amount<input type="number" name="principal" value="${query.principal || 1000000}" min="1000"></label>
      <label>Months<input type="number" name="months" value="${query.months || 10}" min="1"></label><button class="btn primary">Calculate</button></form>
    ${result}</section>`;
}

// ------------------------------------------------------------------ pages: dividends
let dividendPreview = null;
async function pageDividends({ query }) {
  const list = await api('GET', '/api/dividends');
  const payouts = query.id ? await api('GET', `/api/dividends/${query.id}`) : null;
  const p = dividendPreview;
  return html`<h1>Dividends</h1>
  ${has('manager', 'board') ? html`<section class="panel"><h2>Declare year-end dividend</h2>
    <p class="small muted">Profit is shared by shares held at 31 December (and optionally by savings balance). Each member's payout is credited to their savings and an SMS is sent.</p>
    <form class="inline-form" data-form="dividend-preview">
      <label>Year<input type="number" name="year" value="${p?.year || new Date().getFullYear()}" required></label>
      <label>Profit to share (${SETTINGS.currency})<input type="number" name="total_profit" value="${p?.total_profit || ''}" required min="1"></label>
      <label>% shared by shares (rest by savings)<input type="number" name="share_pct" value="${p?.share_pct ?? 100}" min="0" max="100"></label>
      <button class="btn">Preview</button></form>
    ${p ? html`<div class="cards" style="margin-top:12px">${card('Per share', money(p.rate_per_share), `${fmtNum(p.total_units)} shares in total`)}${card('On savings', pct(p.savings_rate, 2), `of ${money(p.total_savings)}`)}${card('To pay', money(p.total_paid), `${p.payouts.length} members · ${money(p.retained)} rounding retained`)}</div>
      ${p.already_declared ? html`<div class="callout bad">Dividends for ${p.year} were already declared.</div>` : ''}
      <div class="table-wrap"><table><thead><tr><th>Member</th><th class="num">Shares</th><th class="num">Savings 31 Dec</th><th class="num">On shares</th><th class="num">On savings</th><th class="num">Total</th></tr></thead><tbody>
      ${p.payouts.map((r) => html`<tr><td>${r.member_no} ${r.full_name}</td><td class="num">${fmtNum(r.share_units)}</td><td class="num">${fmtNum(r.savings_balance)}</td><td class="num">${fmtNum(r.share_amount)}</td><td class="num">${fmtNum(r.savings_amount)}</td><td class="num">${fmtNum(r.total)}</td></tr>`)}</tbody></table></div>
      ${!p.already_declared && p.payouts.length ? html`<p><button class="btn primary" data-action="declare-dividend">Declare & credit ${money(p.total_paid)} to members</button></p>` : ''}` : ''}
  </section>` : ''}
  <section class="panel"><h2>Declared dividends</h2>${list.length ? html`<table><thead><tr><th>Year</th><th class="num">Profit</th><th class="num">Per share</th><th class="num">Paid</th><th class="num">Members</th><th>Declared</th></tr></thead><tbody>
    ${list.map((x) => html`<tr><td><a href="#/dividends?id=${x.id}">${x.year}</a></td><td class="num">${fmtNum(x.total_profit)}</td><td class="num">${fmtNum(x.rate_per_share)}</td><td class="num">${fmtNum(x.total_paid)}</td><td class="num">${x.members}</td><td>${dt(x.declared_at)} by ${x.declared_by_name}</td></tr>`)}</tbody></table>` : empty('No dividends declared yet.')}
    ${payouts ? html`<h3>Payouts</h3><table><thead><tr><th>Member</th><th class="num">Shares</th><th class="num">Total</th></tr></thead><tbody>${payouts.map((r) => html`<tr><td>${r.member_no} ${r.full_name}</td><td class="num">${r.share_units}</td><td class="num">${fmtNum(r.total)}</td></tr>`)}</tbody></table>` : ''}
  </section>`;
}

// ------------------------------------------------------------------ pages: reports
async function pageReports({ query }) {
  const tab = query.tab || 'cash';
  const tabs = [['cash', 'Daily cash report'], ['defaulters', 'Defaulters'], ['portfolio', 'Loan portfolio'], ['savings', 'Savings & shares']];
  let body;
  if (tab === 'cash') {
    const r = await api('GET', `/api/reports/cash?${qs({ date: query.date })}`);
    body = html`<form class="inline-form" data-form="filter" data-path="/reports"><input type="hidden" name="tab" value="cash"><label>Date<input type="date" name="date" value="${r.date}"></label><button class="btn">Show</button></form>
      <h2>Daily cash report — ${r.date}</h2>
      <div class="cards">${card('Cash in', money(r.totals.cash_in))}${card('Cash out', money(r.totals.cash_out))}${card('Net', money(r.totals.net))}</div>
      <div class="grid2"><div><h3>By method</h3><table><thead><tr><th>Method</th><th class="num">In</th><th class="num">Out</th><th class="num">Net</th></tr></thead><tbody>${Object.entries(r.by_method).map(([k, v]) => html`<tr><td>${METHOD_LABEL[k] || k}</td><td class="num">${fmtNum(v.cash_in)}</td><td class="num">${fmtNum(v.cash_out)}</td><td class="num">${fmtNum(v.cash_in - v.cash_out)}</td></tr>`)}</tbody></table></div>
      <div><h3>By type</h3><table><thead><tr><th>Type</th><th class="num">Count</th><th class="num">Amount</th></tr></thead><tbody>${Object.entries(r.by_type).map(([k, v]) => html`<tr><td>${k.replace(/_/g, ' ')}</td><td class="num">${v.count}</td><td class="num">${fmtNum(v.amount)}</td></tr>`)}</tbody></table></div></div>
      <h3>Transactions</h3>${r.rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Time</th><th>Ref</th><th>Member</th><th>Type</th><th>Method</th><th class="num">Cash in</th><th class="num">Cash out</th><th>By</th></tr></thead><tbody>
      ${r.rows.map((t) => html`<tr><td>${String(t.created_at).slice(11, 16)}</td><td>TX${t.id}</td><td>${t.member_no} ${t.full_name}</td><td>${txnLabel(t)}</td><td>${METHOD_LABEL[t.method] || ''}</td><td class="num">${t.cash_effect > 0 ? fmtNum(t.cash_effect) : ''}</td><td class="num">${t.cash_effect < 0 ? fmtNum(-t.cash_effect) : ''}</td><td>${t.created_by_name || ''}</td></tr>`)}
      </tbody></table></div>` : empty('No transactions on this date.')}`;
  } else if (tab === 'defaulters') {
    const rows = await api('GET', '/api/reports/defaulters');
    body = html`<h2>Loan defaulters (${rows.length})</h2>
      ${has('admin', 'manager', 'loan_officer') ? html`<p class="no-print"><button class="btn" data-action="run-due">Run due-date check now (penalties + SMS reminders)</button></p>` : ''}
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Loan</th><th>Member</th><th>Phone</th><th>Oldest due</th><th class="num">Days late</th><th class="num">Missed</th><th class="num">Overdue</th><th class="num">Penalty due</th><th class="num">Total balance</th></tr></thead><tbody>
      ${rows.map((r) => html`<tr class="overdue"><td><a href="#/loans/${r.loan_id}">${r.loan_no}</a></td><td><a href="#/members/${r.member_id}">${r.member_no}</a> ${r.full_name}</td><td>${r.phone}</td><td>${r.oldest_due}</td><td class="num">${r.days_overdue}</td><td class="num">${r.missed}</td><td class="num">${fmtNum(r.overdue_amount)}</td><td class="num">${fmtNum(r.penalty_due)}</td><td class="num">${fmtNum(r.balance)}</td></tr>`)}
      </tbody><tfoot><tr><td colspan="6">Total</td><td class="num">${fmtNum(rows.reduce((s, r) => s + r.overdue_amount, 0))}</td><td class="num">${fmtNum(rows.reduce((s, r) => s + r.penalty_due, 0))}</td><td class="num">${fmtNum(rows.reduce((s, r) => s + r.balance, 0))}</td></tr></tfoot></table></div>` : empty('No defaulters. Every loan is up to date.')}`;
  } else if (tab === 'portfolio') {
    const rows = await api('GET', '/api/reports/portfolio?status=active,closed,approved');
    const act = rows.filter((r) => r.status === 'active');
    body = html`<h2>Loan portfolio</h2><div class="cards">${card('Active loans', act.length)}${card('Disbursed (active)', money(act.reduce((s, r) => s + r.principal, 0)))}${card('Outstanding', money(act.reduce((s, r) => s + r.balance, 0)))}${card('Arrears', money(act.reduce((s, r) => s + r.arrears, 0)))}</div>${loansTable(rows)}`;
  } else {
    const rows = await api('GET', '/api/reports/savings');
    body = html`<h2>Savings & shares by member</h2><div class="table-wrap"><table><thead><tr><th>Member</th><th>Status</th><th class="num">Savings</th><th class="num">Shares</th><th class="num">Share capital</th><th class="num">Loan balance</th></tr></thead><tbody>
      ${rows.map((m) => html`<tr><td><a href="#/members/${m.id}">${m.member_no}</a> ${m.full_name}</td><td>${badge(m.status)}</td><td class="num">${fmtNum(m.savings)}</td><td class="num">${fmtNum(m.share_units)}</td><td class="num">${fmtNum(m.share_value)}</td><td class="num">${fmtNum(m.loan_balance)}</td></tr>`)}
      </tbody><tfoot><tr><td colspan="2">Total (${rows.length})</td><td class="num">${fmtNum(rows.reduce((s, r) => s + r.savings, 0))}</td><td class="num">${fmtNum(rows.reduce((s, r) => s + r.share_units, 0))}</td><td class="num">${fmtNum(rows.reduce((s, r) => s + r.share_value, 0))}</td><td class="num">${fmtNum(rows.reduce((s, r) => s + r.loan_balance, 0))}</td></tr></tfoot></table></div>`;
  }
  return html`<div class="page-head"><h1>Reports</h1><button class="btn" data-action="print">Print / Save PDF</button></div>
  <p class="print-only">${SETTINGS.sacco_name} · printed ${new Date().toLocaleString()}</p>
  <nav class="tabs">${tabs.map(([k, l]) => html`<a href="#/reports?tab=${k}" class="${tab === k ? 'active' : ''}">${l}</a>`)}</nav>
  <section class="panel">${body}</section>`;
}

// ------------------------------------------------------------------ pages: notifications, audit, admin, password
async function pageNotifications() {
  const rows = await api('GET', '/api/notifications');
  return html`<div class="page-head"><h1>${ME.role === 'member' ? 'My messages' : 'SMS / notification outbox'}</h1>
    ${has('admin', 'manager', 'loan_officer') ? html`<button class="btn" data-action="run-due">Send due-date reminders now</button>` : ''}</div>
  ${ME.role !== 'member' ? html`<div class="callout small">No SMS gateway is connected, so messages are logged here as <b>simulated</b>. Connect a provider in <code>notify()</code> in <code>src/sacco.js</code> to send real SMS or WhatsApp messages.</div>` : ''}
  <section class="panel">${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Time</th>${ME.role !== 'member' ? html`<th>To</th>` : ''}<th>Message</th><th>Status</th></tr></thead><tbody>
  ${rows.map((n) => html`<tr><td>${dt(n.created_at)}</td>${ME.role !== 'member' ? html`<td>${n.member_no || ''} ${n.full_name || ''}<div class="small muted">${n.phone || ''}</div></td>` : ''}<td>${n.message}</td><td>${badge(n.status)}</td></tr>`)}</tbody></table></div>` : empty('No messages yet.')}</section>`;
}

async function pageAudit({ query }) {
  const rows = await api('GET', `/api/audit?${qs(query)}`);
  return html`<h1>Audit trail</h1><p class="muted">Every action is recorded with who, when and what. The log cannot be edited or deleted.</p>
  <section class="panel"><form class="inline-form" data-form="filter" data-path="/audit">
    <label>User / detail<input name="q" value="${query.q || ''}"></label><label>Action<input name="action" value="${query.action || ''}" placeholder="e.g. loan, reversal, login"></label>
    <label>From<input type="date" name="from" value="${query.from || ''}"></label><label>To<input type="date" name="to" value="${query.to || ''}"></label><button class="btn">Filter</button></form>
  <div class="table-wrap"><table><thead><tr><th>Time</th><th>User</th><th>Action</th><th>Record</th><th>Details</th><th>IP</th></tr></thead><tbody>
  ${rows.map((a) => html`<tr><td>${a.created_at}</td><td>${a.username}</td><td>${a.action.replace(/_/g, ' ')}</td><td>${a.entity || ''}${a.entity_id ? ` #${a.entity_id}` : ''}</td><td class="small"><code>${a.details || ''}</code></td><td class="small muted">${a.ip || ''}</td></tr>`)}
  </tbody></table></div></section>`;
}

async function pageAdmin() {
  const [settings, types, users, backups] = await Promise.all([api('GET', '/api/settings'), api('GET', '/api/loan-types'), api('GET', '/api/users'), api('GET', '/api/admin/backups')]);
  const s = (k, label, type = 'number', extra = '') => html`<label>${label}<input type="${type}" name="${k}" value="${settings[k]}" ${raw(extra)} required></label>`;
  return html`<h1>Administration</h1>
  <section class="panel"><h2>SACCO rules & rates</h2><form class="stack" data-form="settings"><div class="form-grid">
    ${s('sacco_name', 'SACCO name', 'text')}${s('currency', 'Currency', 'text')}
    ${s('share_price', 'Price per share')}${s('registration_fee', 'Registration fee')}${s('min_shares', 'Min. shares to borrow')}
    ${s('savings_multiplier', 'Loan limit (× savings)', 'number', 'step="0.5"')}${s('min_savings_months', 'Min. months saving before loan')}${s('min_guarantors', 'Guarantors required')}
    ${s('penalty_rate', 'Late penalty (% of installment)', 'number', 'step="0.1"')}
    <label>Penalty charged<select name="penalty_frequency"><option value="once" ${settings.penalty_frequency === 'once' ? 'selected' : ''}>Once per missed installment</option><option value="weekly" ${settings.penalty_frequency === 'weekly' ? 'selected' : ''}>Every week while overdue</option></select></label>
    ${s('board_threshold', 'Board approval above')}${s('reminder_days', 'SMS reminder days before due')}${s('session_hours', 'Login session length (hours)')}
  </div><div><button class="btn primary">Save settings</button></div></form></section>

  <section class="panel"><h2>Loan products</h2><p class="small muted">Interest is flat per month on the original amount: e.g. 1% × 10 months = 10% of the loan.</p>
    <div class="table-wrap"><table><thead><tr><th>Name</th><th>Interest % / month</th><th>Max months</th><th>Active</th><th></th></tr></thead><tbody>
    ${types.map((t) => html`<tr><td colspan="5"><form class="inline-form" data-form="loan-type" data-id="${t.id}"><label>Name<input name="name" value="${t.name}"></label><label>% / month<input type="number" step="0.1" name="interest_rate" value="${t.interest_rate}"></label><label>Max months<input type="number" name="max_months" value="${t.max_months}"></label><label class="check"><input type="checkbox" name="active" ${t.active ? 'checked' : ''}> Active</label><button class="btn small">Save</button></form></td></tr>`)}
    <tr><td colspan="5"><form class="inline-form" data-form="loan-type"><label>New product<input name="name" required></label><label>% / month<input type="number" step="0.1" name="interest_rate" required></label><label>Max months<input type="number" name="max_months" required></label><input type="hidden" name="active" value="1"><button class="btn small primary">Add</button></form></td></tr>
    </tbody></table></div></section>

  <section class="panel"><h2>Staff & users</h2>
    <div class="table-wrap"><table><thead><tr><th>Username</th><th>Name</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead><tbody>
    ${users.map((u) => html`<tr><td>${u.username}</td><td>${u.full_name}</td><td>${ROLE_LABEL[u.role]}</td><td>${u.active ? badge('active') : html`<span class="badge red">disabled</span>`}</td><td>${dt(u.last_login_at) || 'never'}</td>
      <td><div class="actions">${u.id !== ME.id ? html`<button class="btn small" data-action="toggle-user" data-id="${u.id}" data-active="${u.active ? 0 : 1}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}<button class="btn small" data-action="reset-password" data-id="${u.id}">Reset password</button></div></td></tr>`)}
    </tbody></table></div>
    <h3>Add staff user</h3><form class="inline-form" data-form="user">
      <label>Username<input name="username" required></label><label>Full name<input name="full_name" required></label>
      <label>Role<select name="role">${Object.entries(ROLE_LABEL).filter(([k]) => k !== 'member').map(([k, v]) => html`<option value="${k}">${v}</option>`)}</select></label>
      <label>Temporary password<input name="password" required minlength="8"></label><button class="btn primary">Create</button></form></section>

  <section class="panel"><h2>Backups</h2><p class="small muted">A backup is taken automatically once a day when the server runs. Copy the <code>backups/</code> folder to another disk or cloud storage regularly.</p>
    <p><button class="btn primary" data-action="backup">Back up now</button></p>
    ${backups.length ? html`<table><thead><tr><th>File</th><th class="num">Size</th></tr></thead><tbody>${backups.slice(0, 15).map((b) => html`<tr><td>${b.name}</td><td class="num">${fmtNum(b.size / 1024)} KB</td></tr>`)}</tbody></table>` : empty('No backups yet.')}</section>`;
}

function pagePassword() {
  return html`<h1>Change password</h1>${ME.must_change_password ? html`<div class="callout warn">Please set a new password before continuing.</div>` : ''}
  <form class="panel stack" data-form="password">
    <label>Current password<input type="password" name="current_password" required autocomplete="current-password"></label>
    <label>New password (min 8 characters, letters and numbers)<input type="password" name="new_password" required minlength="8" autocomplete="new-password"></label>
    <label>Repeat new password<input type="password" name="repeat" required autocomplete="new-password"></label>
    <div><button class="btn primary">Change password</button></div></form>`;
}

// ------------------------------------------------------------------ routing & shell
const ROUTES = [
  [/^\/dashboard$/, pageDashboard, STAFF],
  [/^\/my$/, pageMy, ['member']],
  [/^\/statement$/, pageStatement, ['member']],
  [/^\/guarantees$/, pageGuarantees, ['member']],
  [/^\/members$/, pageMembers, STAFF],
  [/^\/members\/new$/, pageMemberForm, REGISTRARS],
  [/^\/members\/(\d+)$/, pageMember, STAFF],
  [/^\/members\/(\d+)\/edit$/, pageMemberForm, REGISTRARS],
  [/^\/members\/(\d+)\/statement$/, pageStatement, STAFF],
  [/^\/transactions$/, pageTransactions, STAFF],
  [/^\/loans$/, pageLoans, ALL],
  [/^\/loans\/new$/, pageLoanNew, ['member', 'loan_officer', 'manager']],
  [/^\/loans\/(\d+)$/, pageLoan, ALL],
  [/^\/approvals$/, pageApprovals, [...APPROVERS, 'cashier']],
  [/^\/calculator$/, pageCalculator, ALL],
  [/^\/dividends$/, pageDividends, AUDITORS],
  [/^\/reports$/, pageReports, STAFF],
  [/^\/notifications$/, pageNotifications, ALL],
  [/^\/audit$/, pageAudit, AUDITORS],
  [/^\/admin$/, pageAdmin, ['admin']],
  [/^\/password$/, pagePassword, ALL],
];

const NAV = [
  ['#/dashboard', 'Dashboard', STAFF], ['#/my', 'My account', ['member']], ['#/statement', 'My statement', ['member']],
  ['#/members', 'Members', STAFF], ['#/transactions', 'Transactions', STAFF],
  ['#/loans', 'Loans', ALL], ['#/loans/new', 'Apply for a loan', ['member']], ['#/guarantees', 'Guarantee requests', ['member']],
  ['#/approvals', 'Approvals', [...APPROVERS, 'cashier']], ['#/calculator', 'Loan calculator', ALL],
  ['#/dividends', 'Dividends', AUDITORS], ['#/reports', 'Reports', STAFF], ['#/notifications', 'SMS / messages', ALL],
  ['#/audit', 'Audit trail', AUDITORS], ['#/admin', 'Administration', ['admin']], ['#/password', 'Change password', ALL],
];

function renderShell() {
  document.getElementById('app').innerHTML = html`<div class="shell">
    <aside class="side" id="side"><div class="brand">${SETTINGS.sacco_name}<small>SACCO Management System</small></div>
      <nav class="nav">${NAV.filter(([, , r]) => r.includes(ME.role)).map(([h, l]) => html`<a href="${h}" data-nav="${h}">${l}</a>`)}</nav></aside>
    <div class="main"><div class="topbar"><button class="btn menu-btn" data-action="menu">☰ Menu</button><span></span>
      <div class="actions"><span class="user">${ME.full_name} · ${ROLE_LABEL[ME.role]}</span><button class="btn small" data-action="logout">Log out</button></div></div>
      <main id="view"></main></div></div>`.s;
}

let renderSeq = 0;
async function render() {
  if (!ME) return;
  const { path, query } = parseHash();
  if (ME.must_change_password && path !== '/password') { location.hash = '#/password'; return; }
  if (path === '/' || path === '') { location.hash = ME.role === 'member' ? '#/my' : '#/dashboard'; return; }
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', `#${path}` === a.dataset.nav));
  document.getElementById('side')?.classList.remove('open');
  const view = document.getElementById('view');
  const match = ROUTES.map(([re, fn, roles]) => ({ m: path.match(re), fn, roles })).find((x) => x.m);
  if (!match) { view.innerHTML = html`<h1>Page not found</h1>`.s; return; }
  if (!match.roles.includes(ME.role)) { view.innerHTML = html`<h1>Not allowed</h1><p>Your role (${ROLE_LABEL[ME.role]}) cannot open this page.</p>`.s; return; }
  const seq = ++renderSeq;
  view.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const out = await match.fn({ params: match.m.slice(1), query });
    if (seq === renderSeq) { view.innerHTML = val(out); window.scrollTo(0, 0); }
  } catch (e) {
    if (seq === renderSeq) view.innerHTML = html`<div class="callout bad">${e.message}</div>`.s;
  }
}

async function renderLogin() {
  let name = 'SACCO';
  try { name = (await api('GET', '/api/public-settings')).sacco_name; } catch { /* offline */ }
  document.getElementById('app').innerHTML = html`<div class="login"><form class="panel stack" data-form="login">
    <h1>${name}</h1><p class="muted">SACCO Management System — sign in</p>
    <label>Username or member number<input name="username" required autocomplete="username" autofocus></label>
    <label>Password<input type="password" name="password" required autocomplete="current-password"></label>
    <button class="btn primary">Sign in</button>
    <p class="demo-logins">Staff: admin, manager, board, officer, cashier. Members log in with their member number (e.g. M00001).</p>
  </form></div>`.s;
}

async function boot() {
  try {
    const r = await api('GET', '/api/me');
    ME = r.user; SETTINGS = r.settings;
    renderShell();
    render();
  } catch {
    ME = null;
    renderLogin();
  }
}

// ------------------------------------------------------------------ form handlers
const FORMS = {
  async login(d) { await api('POST', '/api/login', d); location.hash = '#/'; await boot(); },
  filter(d, form) { location.hash = `#${form.dataset.path}?${qs(d)}`; },
  async password(d) {
    if (d.new_password !== d.repeat) throw new Error('The new passwords do not match');
    await api('POST', '/api/me/password', d); toast('Password changed'); await boot(); location.hash = '#/';
  },
  async member(d, form) {
    const id = form.dataset.id;
    if (id) { await api('PUT', `/api/members/${id}`, d); toast('Member updated'); go(`#/members/${id}`); }
    else { const r = await api('POST', '/api/members', d); toast(`Registered ${r.member_no}`); go(`#/members/${r.id}`); }
  },
  async 'member-login'(d, form) { const r = await api('POST', `/api/members/${form.dataset.id}/login`, d); toast(`Login created: ${r.username}`); render(); },
  async 'member-status'(d, form) {
    if (d.status === 'exited' && !confirm('Exit this member? Their shares will be refunded and their login disabled. This cannot be undone.')) return;
    await api('POST', `/api/members/${form.dataset.id}/status`, d); toast('Status updated'); render();
  },
  async teller(d, form) {
    if (d.type !== 'share_purchase') delete d.units; else delete d.amount;
    const r = await api('POST', '/api/transactions', d);
    toast(`Posted TX${r.id}. Savings: ${money(r.balances.savings)} · Shares: ${r.balances.share_units}`);
    form.reset(); render();
  },
  async 'apply-loan'(d) { const r = await api('POST', '/api/loans', d); toast(`Application ${r.loan_no} submitted`); go(`#/loans/${r.id}`); },
  async 'add-guarantor'(d, form) { await api('POST', `/api/loans/${form.dataset.id}/guarantors`, d); toast('Guarantor added and notified'); render(); },
  async 'decide-loan'(d, form) { const r = await api('POST', `/api/loans/${form.dataset.id}/decide`, d); toast(`Loan ${LOAN_STATUS[r.status].toLowerCase()}`); render(); },
  async disburse(d, form) {
    if (!confirm('Disburse this loan now? The repayment schedule starts today.')) return;
    await api('POST', `/api/loans/${form.dataset.id}/disburse`, d); toast('Loan disbursed; member notified'); render();
  },
  async repay(d, form) { const r = await api('POST', `/api/loans/${form.dataset.id}/repay`, d); toast(r.balance > 0 ? `Repayment posted. Balance ${money(r.balance)}` : 'Loan fully paid!'); render(); },
  async 'dividend-preview'(d) { dividendPreview = await api('POST', '/api/dividends/preview', d); render(); },
  async settings(d) { SETTINGS = await api('PUT', '/api/settings', d); toast('Settings saved'); renderShell(); render(); },
  async 'loan-type'(d, form) {
    d.active = form.dataset.id ? d.active : true;
    if (form.dataset.id) await api('PUT', `/api/loan-types/${form.dataset.id}`, d); else await api('POST', '/api/loan-types', d);
    toast('Loan product saved'); render();
  },
  async user(d) { await api('POST', '/api/users', d); toast('User created'); render(); },
};

const ACTIONS = {
  async logout() { await api('POST', '/api/logout', {}).catch(() => {}); ME = null; location.hash = ''; renderLogin(); },
  menu() { document.getElementById('side').classList.toggle('open'); },
  print() { window.print(); },
  async 'request-reversal'(el) {
    const reason = prompt(`Why should TX${el.dataset.id} be reversed? A manager must approve.`);
    if (!reason) return;
    await api('POST', `/api/transactions/${el.dataset.id}/reverse`, { reason }); toast('Reversal requested — waiting for manager approval'); render();
  },
  async 'decide-reversal'(el) {
    const comment = prompt(el.dataset.decision === 'approved' ? 'Approval comment (optional)' : 'Why is this rejected?');
    if (comment === null) return;
    await api('POST', `/api/reversals/${el.dataset.id}/decide`, { decision: el.dataset.decision, comment }); toast(`Reversal ${el.dataset.decision}`); render();
  },
  async guarantee(el) {
    if (!confirm(el.dataset.decision === 'accepted' ? 'Confirm: guarantee this loan?' : 'Decline to guarantee this loan?')) return;
    await api('POST', `/api/guarantors/${el.dataset.id}/respond`, { decision: el.dataset.decision }); toast('Response recorded'); render();
  },
  async 'run-due'() { const r = await api('POST', '/api/notifications/run', {}); toast(`${r.penalties} penalty(ies) applied, ${r.reminders} reminder(s) sent`); render(); },
  async 'declare-dividend'() {
    const p = dividendPreview;
    if (!confirm(`Credit ${money(p.total_paid)} to ${p.payouts.length} members for ${p.year}? This cannot be undone except by reversals.`)) return;
    await api('POST', '/api/dividends', { year: p.year, total_profit: p.total_profit, share_pct: p.share_pct });
    dividendPreview = null; toast('Dividend declared and credited'); render();
  },
  async 'toggle-user'(el) { await api('PUT', `/api/users/${el.dataset.id}`, { active: el.dataset.active === '1' }); render(); },
  async 'reset-password'(el) {
    const password = prompt('New temporary password (min 8 chars, letters + numbers). The user must change it at next login.');
    if (!password) return;
    await api('PUT', `/api/users/${el.dataset.id}`, { password }); toast('Password reset');
  },
  async backup() { const r = await api('POST', '/api/admin/backup', {}); toast(`Backup saved: ${r.name}`); render(); },
};

// ------------------------------------------------------------------ events
function formData(form, submitter) {
  const o = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled || el.tagName === 'BUTTON') continue;
    if (el.type === 'checkbox') o[el.name] = el.checked;
    else if (el.type === 'radio') { if (el.checked) o[el.name] = el.value; }
    else if (el.type !== 'file') o[el.name] = el.value;
  }
  if (submitter?.name) o[submitter.name] = submitter.value;
  return o;
}

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = FORMS[form.dataset.form];
  if (!fn) return;
  const buttons = [...form.querySelectorAll('button')];
  buttons.forEach((b) => { b.dataset.wasDisabled = b.disabled; b.disabled = true; });
  try { await fn(formData(form, e.submitter), form); } catch (err) { toast(err.message, true); } finally {
    buttons.forEach((b) => { b.disabled = b.dataset.wasDisabled === 'true'; });
  }
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  e.preventDefault();
  try { await ACTIONS[el.dataset.action]?.(el); } catch (err) { toast(err.message, true); }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.matches('[data-toggle-units]')) {
    const form = t.closest('form');
    const shares = t.value === 'share_purchase';
    form.querySelector('[data-units]').hidden = !shares;
    form.querySelector('[data-amount]').hidden = shares;
    if (t.value === 'registration_fee') form.querySelector('[name=amount]').value = SETTINGS.registration_fee;
  }
  if (t.matches('[data-lookup]')) {
    const out = t.parentElement.querySelector('.lookup');
    const nos = t.value.split(/[\s,;]+/).filter(Boolean);
    if (!nos.length) { out.textContent = ''; return; }
    const results = await Promise.all(nos.map((no) => api('GET', `/api/members/lookup?no=${encodeURIComponent(no)}`).then((m) => ({ ok: m.status === 'active', text: `${m.member_no}: ${m.full_name}${m.status !== 'active' ? ` (${m.status})` : ''}` })).catch((err) => ({ ok: false, text: err.message }))));
    out.textContent = results.map((r) => r.text).join(' · ');
    out.className = `lookup ${results.every((r) => r.ok) ? 'ok' : 'bad'}`;
  }
  if (t.matches('[data-photo]') && t.files[0]) {
    const img = await createImageBitmap(t.files[0]).catch(() => null);
    if (!img) { toast('Could not read that image', true); return; }
    const size = 240; const scale = Math.min(1, size / Math.max(img.width, img.height));
    const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', 0.85);
    const fs = t.closest('fieldset');
    fs.querySelector('[name=photo]').value = url;
    const prev = fs.querySelector('.photo-preview'); prev.src = url; prev.hidden = false;
  }
});

document.addEventListener('input', (e) => {
  const form = e.target.closest('form[data-quote]');
  if (!form) return;
  const opt = form.querySelector('[name=loan_type_id]').selectedOptions[0];
  const p = Number(form.querySelector('[name=principal]').value);
  const m = Number(form.querySelector('[name=months]').value);
  const out = form.querySelector('[data-quote-out]');
  if (!opt || !p || !m) { out.textContent = 'Enter an amount to see the repayment.'; return; }
  const rate = Number(opt.dataset.rate);
  const interest = Math.round(p * rate / 100 * m);
  const tooLong = m > Number(opt.dataset.max);
  out.innerHTML = html`Interest <b>${money(interest)}</b> (${rate}% × ${m} months) · Total <b>${money(p + interest)}</b> · Monthly <b>${money(Math.round((p + interest) / m))}</b>${tooLong ? html` <span class="badge red">max ${opt.dataset.max} months</span>` : ''}`.s;
});

window.addEventListener('hashchange', render);
boot();

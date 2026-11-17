# SACCO Management System

A working web system for a Savings and Credit Cooperative (SACCO). It handles members, savings, shares, loans
(application, appraisal, multi-level approval, disbursement, schedule, repayment, penalties), dividends, reports,
SMS notifications and a tamper-proof audit trail.

Built with **Node.js and its built-in SQLite**, so there is nothing to install apart from Node.js 22.13 or newer.

## Run it

```bash
npm run demo     # wipes data/sacco.db, loads demo data, starts the server
npm start        # starts the server with the existing data
```

Then open http://localhost:3000. Use `PORT=8080 npm start` to change the port.

On a fresh install with no demo data, the first start creates an `admin` user and prints its password in the
terminal. You must change it at first login.

### Demo logins

| Role | Username | Password |
|---|---|---|
| Administrator | admin | Admin@123 |
| Manager | manager | Manager@123 |
| Board member | board | Board@123 |
| Loan officer | officer | Officer@123 |
| Cashier | cashier | Cashier@123 |
| Members | M00001 (Divine) … M00006 | Member@123 |

### What the demo data shows

- **Divine (M00001)**: the worked example. Her savings are 500,000 and she holds 20 shares. She took a 1,500,000
  business loan at 1% a month flat for 10 months, which comes to 165,000 a month. She paid 2 installments and
  missed the 3rd, so a **3,300 penalty** (2%) has been charged and she appears on the defaulters list.
- **Peter (M00004)**: a 6,000,000 asset loan. That is above the 5,000,000 board limit, so after the officer and
  the manager approve it, it still **waits for the board**. Log in as `board` to approve it.
- **John (M00002)**: a new school-fees application with one guarantor accepted and one still pending. The
  appraisal blocks approval until the second guarantor accepts.
- **Sarah (M00005)**: an emergency loan that is fully paid off.
- **Grace (M00003)**: a mistyped deposit that was reversed. The cashier requested the reversal and the manager
  approved it.
- **Moses (M00006)**: marked dormant.

## Features and how they map to the spec

| Module | What is implemented |
|---|---|
| Members | Register with name, NIN, phone, next of kin and photo. Each member gets an automatic member number (M00001) and a status of active, dormant or exited. Exiting refunds shares and blocks the login. |
| Savings | Deposits and withdrawals by cash, Mobile Money or bank, with a reference. Savings that secure a running loan cannot be withdrawn. |
| Shares | Bought at the configured price per share. Share count affects loan eligibility and dividends. |
| Loans | Five loan types (School Fees, Business, Emergency, Agriculture, Asset), all editable. **Appraisal checks:** at least 3 months of saving, minimum shares, guarantors accepted, no other running loan, and amount at most 3× savings. **Approval chain:** loan officer, then manager, then the board if the loan is above the threshold. One person cannot approve two levels or approve a loan they captured. Disbursement generates the repayment schedule automatically. |
| Repayment & penalties | Payments go to penalties first, then installments, oldest first. The late penalty is a configurable percentage, charged once per missed installment or weekly. An SMS reminder goes out 3 days before each due date. The due-date check runs hourly and can also be triggered by hand. |
| Dividends | Year-end profit is shared by shares (and optionally by savings), using balances as at 31 December. You preview first, then declare, which credits every member's savings and sends each an SMS. |
| Reports | Dashboard (portfolio at risk, arrears, pipeline), daily cash report by method and type, defaulters list, loan portfolio, savings and shares register, member statement with running balance. All of them print to PDF. |
| SMS / WhatsApp | Every event writes a message to the outbox: deposits, withdrawals, approvals, disbursements, reminders, penalties and dividends. |
| Security & audit | Role-based access for 6 roles, scrypt-hashed passwords, forced password change, login lockout after 5 failures, HttpOnly SameSite cookies, CSP headers. **Transactions cannot be deleted or edited** (database triggers enforce it). Mistakes are corrected only by a reversal that a different person (a manager) approves. The audit log is append-only. A backup runs automatically each day, and admins can also take one manually. |
| Member portal | A member sees their own balances, statement, loan schedule and messages. They can apply for a loan and accept or decline requests to act as a guarantor. |

## Connecting real SMS / Mobile Money

- **SMS / WhatsApp**: in `src/sacco.js`, the `notify()` function has a marked hook. Call your provider (Africa's
  Talking, Twilio, etc.) there. Until then, messages are marked `simulated` and stay visible under *SMS / messages*.
- **MTN MoMo / Airtel Money**: disbursements and payments currently record the MoMo or bank reference that the
  cashier enters. To send money automatically, call the provider's API in `disburse()` before the transaction is
  recorded.

## Project layout

```
server.js          HTTP server, routes and role permissions
src/db.js          database schema, triggers, default settings and loan types
src/sacco.js       all business rules (members, savings, loans, penalties, dividends, reports, audit)
src/seed.js        demo data
src/util.js        date helpers
public/            web interface (index.html, app.js, style.css)
data/sacco.db      the database (created automatically)
backups/           daily and manual backups
```

## Database tables

`members`, `users`, `sessions`, `transactions` (savings, shares, fees, loan disbursements, repayments, dividends,
reversals: one ledger), `loan_types`, `loans`, `loan_guarantors`, `loan_approvals`, `loan_schedule`,
`reversal_requests`, `dividends`, `dividend_payouts`, `notifications`, `audit_log`, `settings`.

All rules (share price, loan limit multiplier, penalty %, board threshold, reminder days, etc.) can be changed under
**Administration** without touching code.

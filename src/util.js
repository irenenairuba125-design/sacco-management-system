// Date helpers. All dates are local 'YYYY-MM-DD'; timestamps are 'YYYY-MM-DD HH:MM:SS'.
let clock = null; // used by the demo seeder to back-date records

export function setClock(value) { clock = value; }

const pad = (n) => String(n).padStart(2, '0');

export function localDate(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function today() {
  if (clock) return clock.slice(0, 10);
  return process.env.SACCO_TODAY || localDate();
}

export function now() {
  if (clock) return clock.length === 10 ? `${clock} 09:00:00` : clock;
  const d = new Date();
  return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function addMonths(dateStr, n) {
  const [y, m, d] = dateStr.slice(0, 10).split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1 + n, 1));
  const lastDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  first.setUTCDate(Math.min(d, lastDay));
  return first.toISOString().slice(0, 10);
}

export function addDays(dateStr, n) {
  const t = new Date(`${dateStr.slice(0, 10)}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
}

export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b.slice(0, 10)}T00:00:00Z`) - Date.parse(`${a.slice(0, 10)}T00:00:00Z`)) / 86400000);
}

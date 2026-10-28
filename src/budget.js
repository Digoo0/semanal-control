export const MAX_CENTS = 100_000_000_000;
export const MAX_SCHEDULE_DAYS = 3650;
export function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
export function parseDate(key) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) throw new Error('Data inválida.');
  const date = new Date(`${key}T12:00:00`);
  if (!Number.isFinite(+date) || dateKey(date) !== key) throw new Error('Data inválida.');
  return date;
}
export function addDays(key, days) { const date = parseDate(key); date.setDate(date.getDate() + days); return dateKey(date); }
export function paydayForMonth(year, month, overrides = {}) {
  const first = new Date(year, month, 1, 12);
  const monthKey = dateKey(first).slice(0, 7);
  if (overrides[monthKey]) { parseDate(overrides[monthKey]); return overrides[monthKey]; }
  while ([0, 6].includes(first.getDay())) first.setDate(first.getDate() + 1);
  return dateKey(first);
}
export function nextPayday(today, overrides = {}) {
  const date = parseDate(today);
  const current = paydayForMonth(date.getFullYear(), date.getMonth(), overrides);
  return current > today ? current : paydayForMonth(date.getFullYear(), date.getMonth() + 1, overrides);
}
export function periodsBetween(today, payday) {
  const periods = [];
  let start = today;
  while (start < payday) {
    const day = parseDate(start).getDay();
    const nextMonday = addDays(start, day === 0 ? 1 : 8 - day);
    const endExclusive = nextMonday < payday ? nextMonday : payday;
    periods.push({start, end: addDays(endExclusive, -1)});
    start = endExclusive;
  }
  return periods;
}
export function distribute(total, count) {
  if (!count) return [];
  if (total < 0) return [total, ...Array(count - 1).fill(0)];
  const base = Math.floor(total / count), rest = total % count;
  return Array.from({length: count}, (_, i) => base + (i < rest ? 1 : 0));
}
export function newState(today = dateKey()) {
  return {version: 1, startedOn: today, initialBalance: 0, transactions: [], paydayOverrides: {}, initialized: false};
}
export function validateState(state, today = dateKey()) {
  if (!state || state.version !== 1 || typeof state.initialized !== 'boolean') throw new Error('Arquivo de dados incompatível.');
  parseDate(state.startedOn);
  if (state.startedOn > today || state.startedOn < addDays(today, -36525)) throw new Error('Data inicial inválida.');
  if (!Number.isSafeInteger(state.initialBalance) || Math.abs(state.initialBalance) > MAX_CENTS) throw new Error('Saldo inválido.');
  if (!Array.isArray(state.transactions) || state.transactions.length > 10000) throw new Error('Lançamentos inválidos.');
  const ids = new Set();
  for (const t of state.transactions) {
    if (typeof t.id !== 'string' || !t.id || ids.has(t.id)) throw new Error('Identificador inválido.');
    ids.add(t.id); parseDate(t.date);
    if (t.date < state.startedOn || t.date > addDays(today, MAX_SCHEDULE_DAYS) || !['income', 'expense'].includes(t.type) || !Number.isSafeInteger(t.amount) || t.amount <= 0 || t.amount > MAX_CENTS || typeof t.description !== 'string' || !t.description.trim() || t.description.length > 100 || !['Alimentação', 'Transporte', 'Casa', 'Lazer', 'Saúde', 'Salário', 'Outros'].includes(t.category)) throw new Error('Lançamento inválido.');
    if (t.reservedFrom !== undefined) {
      parseDate(t.reservedFrom);
      if (t.type !== 'expense' || t.reservedFrom < state.startedOn || t.reservedFrom >= t.date) throw new Error('Reserva inválida.');
    }
  }
  if (!state.paydayOverrides || typeof state.paydayOverrides !== 'object' || Array.isArray(state.paydayOverrides)) throw new Error('Recebimento inválido.');
  for (const [month, day] of Object.entries(state.paydayOverrides)) {
    parseDate(day);
    if (day.slice(0, 7) !== month) throw new Error('O recebimento deve ocorrer no mês escolhido.');
  }
  return state;
}
export function prepareReservations(state, today = dateKey()) {
  let changed = false;
  const transactions = state.transactions.map(t => {
    if (t.type !== 'expense' || t.date <= today || t.reservedFrom) return t;
    changed = true;
    return {...t, reservedFrom:today};
  });
  return changed ? {...state, transactions} : state;
}
export function calculate(state, today = dateKey()) {
  validateState(state, today);
  let total = state.initialBalance, reserved = 0, allocated = [];
  const events = new Map(), reservationStarts = new Map();
  for (const t of state.transactions) {
    if (!events.has(t.date)) events.set(t.date, []);
    events.get(t.date).push(t);
    const start = t.type === 'expense' ? t.reservedFrom ?? (t.date > today ? today : undefined) : undefined;
    if (start && start <= today) reservationStarts.set(start, (reservationStarts.get(start) || 0) + t.amount);
  }
  const distributable = () => reserved > 0 ? Math.max(0, total - reserved) : total;
  for (let day = state.startedOn; day <= today; day = addDays(day, 1)) {
    const date = parseDate(day);
    const isPayday = paydayForMonth(date.getFullYear(), date.getMonth(), state.paydayOverrides) === day;
    reserved += reservationStarts.get(day) || 0;
    if (day === state.startedOn || date.getDay() === 1 || isPayday || reservationStarts.has(day)) allocated = distribute(distributable(), periodsBetween(day, nextPayday(day, state.paydayOverrides)).length);
    for (const t of events.get(day) || []) {
      total += t.type === 'income' ? t.amount : -t.amount;
      if (t.type === 'income') allocated = distribute(distributable(), allocated.length);
      else if (t.reservedFrom && t.reservedFrom < t.date) reserved -= t.amount;
      else allocated[0] -= t.amount;
    }
  }
  const payday = nextPayday(today, state.paydayOverrides);
  const periods = periodsBetween(today, payday).map((period, i) => ({...period, amount: allocated[i] ?? 0}));
  const month = today.slice(0, 7);
  const monthEntries = state.transactions.filter(t => t.date.startsWith(month) && t.date <= today);
  return {total, reserved, available:Math.max(0, total - reserved), shortfall:reserved > 0 ? Math.max(0, reserved - total) : 0, payday, periods, income: monthEntries.filter(t => t.type === 'income').reduce((sum, t) => sum + t.amount, 0), expense: monthEntries.filter(t => t.type === 'expense').reduce((sum, t) => sum + t.amount, 0)};
}

// Project only registered transactions after today; today's movements are already in the balance.
export function projectPeriods(state, today = dateKey(), unit = 'weeks', currentTotal) {
  if (!['weeks', 'months'].includes(unit)) throw new Error('Período de previsão inválido.');
  if (currentTotal === undefined) currentTotal = calculate(state, today).total;
  const scheduled = state.transactions.filter(t => t.date > today).slice().sort((a, b) => a.date.localeCompare(b.date));
  const count = unit === 'weeks' ? 8 : 6;
  const periods = [];
  let start = today, balance = currentTotal, index = 0;
  for (let i = 0; i < count; i++) {
    const date = parseDate(start);
    const next = unit === 'weeks'
      ? addDays(start, date.getDay() === 0 ? 1 : 8 - date.getDay())
      : dateKey(new Date(date.getFullYear(), date.getMonth() + 1, 1, 12));
    const end = addDays(next, -1);
    let income = 0, expense = 0, entries = 0;
    while (index < scheduled.length && scheduled[index].date <= end) {
      const transaction = scheduled[index++];
      if (transaction.type === 'income') income += transaction.amount;
      else expense += transaction.amount;
      entries++;
    }
    const opening = balance;
    balance += income - expense;
    periods.push({start, end, opening, income, expense, balance, entries});
    start = next;
  }
  return periods;
}

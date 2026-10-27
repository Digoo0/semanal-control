import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate, distribute, nextPayday, newState, paydayForMonth, periodsBetween, validateState, addDays, MAX_SCHEDULE_DAYS} from '../src/budget.js';

function fixture() { return {...newState('2026-01-05'), initialBalance:40000, initialized:true}; }
function transaction(amount, type = 'expense', date = '2026-01-06', id = '1') { return {id, amount, type, date, description:'Teste', category:'Outros'}; }
test('R$ 400 em quatro semanas e R$ 50 de gasto reduzem só a semana atual', () => {
  const state = fixture();
  assert.deepEqual(calculate(state, '2026-01-05').periods.map(w => w.amount), [10000,10000,10000,10000]);
  state.transactions.push(transaction(5000));
  const result = calculate(state, '2026-01-06');
  assert.equal(result.total, 35000);
  assert.deepEqual(result.periods.map(w => w.amount), [5000,10000,10000,10000]);
});
test('virada da semana redistribui R$ 350 sem perder centavos', () => {
  const state = fixture(); state.transactions.push(transaction(5000));
  assert.deepEqual(calculate(state, '2026-01-12').periods.map(w => w.amount), [11667,11667,11666]);
});
test('uma entrada redistribui o saldo positivo entre as semanas restantes', () => {
  const state = fixture(); state.transactions.push(transaction(5000), transaction(5000, 'income', '2026-01-07', '2'));
  assert.deepEqual(calculate(state, '2026-01-07').periods.map(w => w.amount), [10000,10000,10000,10000]);
});
test('fechar o app por duas semanas preserva o mesmo cálculo', () => {
  const state = fixture(); state.transactions.push(transaction(5000));
  assert.deepEqual(calculate(state, '2026-01-19').periods.map(w => w.amount), [17500,17500]);
});
test('limite semanal pode ficar negativo sem tirar imediatamente das próximas', () => {
  const state = fixture(); state.transactions.push(transaction(15000));
  assert.deepEqual(calculate(state, '2026-01-06').periods.map(w => w.amount), [-5000,10000,10000,10000]);
  assert.deepEqual(calculate(state, '2026-01-12').periods.map(w => w.amount), [8334,8333,8333]);
});
test('saldo negativo não cria reservas positivas e volta ao normal com entrada', () => {
  const state = fixture(); state.transactions.push(transaction(45000));
  assert.deepEqual(calculate(state, '2026-01-12').periods.map(w => w.amount), [-5000,0,0]);
  state.transactions.push(transaction(11000, 'income', '2026-01-13', '2'));
  assert.deepEqual(calculate(state, '2026-01-13').periods.map(w => w.amount), [2000,2000,2000]);
});
test('primeiro dia de segunda a sexta, dezembro e ano novo', () => {
  assert.equal(paydayForMonth(2026, 7), '2026-08-03');
  assert.equal(paydayForMonth(2026, 10), '2026-11-02');
  assert.equal(nextPayday('2026-12-31'), '2027-01-01');
  assert.equal(nextPayday('2026-11-02'), '2026-12-01');
});
test('ajuste manual cobre feriados e é mantido no histórico', () => {
  const state = fixture(); state.paydayOverrides = {'2026-02':'2026-02-03'};
  assert.equal(nextPayday('2026-02-02', state.paydayOverrides), '2026-02-03');
  assert.equal(calculate(state, '2026-02-03').payday, '2026-03-02');
});
test('recebimento não credita salário automaticamente', () => {
  const result = calculate(fixture(), '2026-02-02');
  assert.equal(result.total, 40000);
  assert.equal(result.income, 0);
});
test('semanas parciais terminam antes do próximo recebimento', () => {
  assert.deepEqual(periodsBetween('2026-10-27', '2026-11-03'), [{start:'2026-10-27',end:'2026-11-01'}, {start:'2026-11-02',end:'2026-11-02'}]);
});
test('centavos conservados para vários saldos e números de semanas', () => {
  for (let count = 1; count <= 6; count++) for (const balance of [-1000,0,1,2,100,35000,999999]) {
    assert.equal(distribute(balance, count).reduce((s, n) => s + n, 0), balance);
  }
});
test('saldo total é conservado em todo o histórico, mesmo com semanas e meses diferentes', () => {
  const state = fixture();
  for (let i = 0; i < 90; i++) {
    const day = addDays(state.startedOn, i);
    state.transactions.push(transaction(257, 'expense', day, `expense-${i}`));
    if (i % 14 === 0) state.transactions.push(transaction(10001, 'income', day, `income-${i}`));
    const result = calculate(state, day);
    const expected = state.initialBalance + state.transactions.reduce((sum, t) => sum + (t.type === 'income' ? t.amount : -t.amount), 0);
    assert.equal(result.total, expected);
    assert.equal(result.periods.reduce((sum, w) => sum + w.amount, 0), expected);
  }
});
test('excluir um lançamento reconstitui o saldo sem carregar cálculos antigos', () => {
  const state = fixture(); state.transactions.push(transaction(5000));
  assert.equal(calculate(state, '2026-01-12').total, 35000);
  state.transactions = [];
  assert.equal(calculate(state, '2026-01-12').total, 40000);
});
test('importação rejeita valores fracionários em centavos, datas inválidas e IDs duplicados', () => {
  const state = fixture();
  state.transactions = [transaction(1.5)]; assert.throws(() => validateState(state, '2026-01-12'));
  state.transactions = [transaction(100, 'expense', '2026-02-30')]; assert.throws(() => validateState(state, '2026-03-01'));
  state.transactions = [transaction(100), transaction(100)]; assert.throws(() => validateState(state, '2026-01-12'));
  state.transactions = [transaction(100, 'expense', '2026-01-13')]; assert.doesNotThrow(() => validateState(state, '2026-01-12'));
  state.transactions = [transaction(100, 'expense', addDays('2026-01-12', MAX_SCHEDULE_DAYS + 1))]; assert.throws(() => validateState(state, '2026-01-12'));
});

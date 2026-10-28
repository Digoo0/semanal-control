import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate, newState, validateState, prepareReservations} from '../src/budget.js';

const entry = (id, date, type, amount, reservedFrom) => ({id, date, type, amount, description:'Teste', category:'Outros', ...(reservedFrom ? {reservedFrom} : {})});
const fixture = transactions => ({...newState('2026-01-05'), initialized:true, initialBalance:40000, transactions});

test('despesas agendadas ficam reservadas antes de dividir o saldo livre', () => {
  const state = fixture([entry('rent','2026-01-26','expense',15000,'2026-01-05')]);
  let result = calculate(state, '2026-01-05');
  assert.deepEqual([result.total,result.reserved,result.available,result.shortfall], [40000,15000,25000,0]);
  assert.deepEqual(result.periods.map(p => p.amount), [6250,6250,6250,6250]);
  state.transactions.push(entry('market','2026-01-06','expense',5000));
  result = calculate(state, '2026-01-06');
  assert.deepEqual([result.total,result.reserved,result.available], [35000,15000,20000]);
  assert.deepEqual(result.periods.map(p => p.amount), [1250,6250,6250,6250]);
  assert.deepEqual(calculate(state, '2026-01-12').periods.map(p => p.amount), [6667,6667,6666]);
});

test('vencimento libera a reserva e desconta somente uma vez', () => {
  const state = fixture([entry('rent','2026-01-26','expense',15000,'2026-01-05'), entry('market','2026-01-06','expense',5000)]);
  const dayBefore = calculate(state, '2026-01-25');
  const dueDay = calculate(state, '2026-01-26');
  assert.deepEqual([dayBefore.total,dayBefore.reserved,dayBefore.available], [35000,15000,20000]);
  assert.deepEqual([dueDay.total,dueDay.reserved,dueDay.available], [20000,0,20000]);
  assert.deepEqual(dueDay.periods.map(p => p.amount), [20000]);
});

test('conta que vence no meio da semana não reduz o limite livre novamente', () => {
  const state = fixture([entry('card','2026-01-20','expense',15000,'2026-01-05')]);
  assert.deepEqual(calculate(state, '2026-01-19').periods.map(p => p.amount), [12500,12500]);
  const result = calculate(state, '2026-01-20');
  assert.deepEqual([result.total,result.reserved,result.available], [25000,0,25000]);
  assert.deepEqual(result.periods.map(p => p.amount), [12500,12500]);
});

test('o déficit continua visível ao vencer uma das várias contas', () => {
  const state = fixture([entry('a','2026-01-10','expense',10000,'2026-01-05'), entry('b','2026-01-20','expense',35000,'2026-01-05')]);
  const afterFirst = calculate(state, '2026-01-10');
  assert.deepEqual([afterFirst.total,afterFirst.reserved,afterFirst.available,afterFirst.shortfall], [30000,35000,0,5000]);
});

test('entradas futuras não liberam dinheiro antes da data', () => {
  const state = fixture([entry('rent','2026-01-26','expense',15000,'2026-01-05'), entry('pay','2026-01-14','income',10000)]);
  assert.deepEqual([calculate(state,'2026-01-13').total,calculate(state,'2026-01-13').available], [40000,25000]);
  assert.deepEqual([calculate(state,'2026-01-14').total,calculate(state,'2026-01-14').available], [50000,35000]);
});

test('contas acima do saldo mostram insuficiência e não criam verba livre', () => {
  const state = fixture([entry('card','2026-02-09','expense',45000,'2026-01-05')]);
  const result = calculate(state, '2026-01-05');
  assert.deepEqual([result.total,result.reserved,result.available,result.shortfall], [40000,45000,0,5000]);
  assert.deepEqual(result.periods.map(p => p.amount), [0,0,0,0]);
});

test('lançamentos futuros antigos são reservados e a remoção libera o valor', () => {
  const state = fixture([entry('old','2026-01-20','expense',10000)]);
  assert.deepEqual([calculate(state,'2026-01-06').reserved,calculate(state,'2026-01-06').available], [10000,30000]);
  const migrated = prepareReservations(state, '2026-01-06');
  assert.equal(migrated.transactions[0].reservedFrom, '2026-01-06');
  assert.equal(prepareReservations(migrated, '2026-01-06'), migrated);
  assert.equal(state.transactions[0].reservedFrom, undefined);
  assert.equal(calculate(migrated, '2026-01-20').available, 30000);
  state.transactions = [];
  assert.deepEqual([calculate(state,'2026-01-06').reserved,calculate(state,'2026-01-06').available], [0,40000]);
});

test('reservas devem ter data válida anterior ao vencimento e ser despesas', () => {
  const state = fixture([entry('bad','2026-01-20','expense',100,'2026-01-20')]);
  assert.throws(() => validateState(state,'2026-01-05'));
  state.transactions = [entry('bad','2026-01-20','income',100,'2026-01-05')];
  assert.throws(() => validateState(state,'2026-01-05'));
});

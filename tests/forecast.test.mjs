import test from 'node:test';
import assert from 'node:assert/strict';
import {calculate, newState, projectPeriods} from '../src/budget.js';

const entry = (id, date, type, amount) => ({id, date, type, amount, description:'Teste', category:'Outros'});

test('previsões acumulam lançamentos futuros sem somar novamente os de hoje', () => {
  const state = {...newState('2026-01-05'), initialized:true, initialBalance:40000, transactions:[
    entry('today', '2026-01-05', 'expense', 5000),
    entry('expense', '2026-01-10', 'expense', 1000),
    entry('income', '2026-01-12', 'income', 10000),
    entry('feb', '2026-02-05', 'expense', 4000),
    entry('apr', '2026-04-01', 'income', 10000)
  ]};
  const weeks = projectPeriods(state, '2026-01-05', 'weeks');
  assert.equal(calculate(state, '2026-01-05').total, 35000);
  assert.deepEqual(weeks[0], {start:'2026-01-05', end:'2026-01-11', opening:35000, income:0, expense:1000, balance:34000, entries:1});
  assert.deepEqual(weeks[1], {start:'2026-01-12', end:'2026-01-18', opening:34000, income:10000, expense:0, balance:44000, entries:1});
  assert.equal(weeks[4].balance, 40000);
  const months = projectPeriods(state, '2026-01-05', 'months');
  assert.equal(months.length, 6);
  assert.deepEqual(months.map(p => p.balance), [44000,40000,40000,50000,50000,50000]);
  assert.equal(months[0].entries, 2);
  assert.equal(months[1].expense, 4000);
});

test('previsão atravessa ano novo e fevereiro bissexto sem inventar salário', () => {
  const state = {...newState('2027-12-31'), initialized:true, initialBalance:1000, transactions:[
    entry('jan', '2028-01-01', 'expense', 2000),
    entry('leap', '2028-02-29', 'income', 500)
  ]};
  const weeks = projectPeriods(state, '2027-12-31', 'weeks');
  assert.equal(weeks[0].end, '2028-01-02');
  assert.equal(weeks[0].balance, -1000);
  const months = projectPeriods(state, '2027-12-31', 'months');
  assert.equal(months[0].end, '2027-12-31');
  assert.equal(months[1].balance, -1000);
  assert.equal(months[2].end, '2028-02-29');
  assert.equal(months[2].balance, -500);
  assert.equal(months[3].balance, -500);
});

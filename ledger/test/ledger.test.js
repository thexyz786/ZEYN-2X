import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Assistant } from '../src/assistant.js';
import { MemoryStore } from '../src/store.js';
import { allocate, parseAmount } from '../src/money.js';
import { ME } from '../src/ledger.js';

const clock = (iso = '2026-10-09T12:00:00') => {
  const c = { t: new Date(iso) };
  c.now = () => c.t;
  return c;
};
const make = (opts = {}) => {
  const c = clock(opts.at);
  const a = new Assistant(new MemoryStore(), { now: c.now, translate: opts.translate ?? null });
  return { a, c, L: a.ledger };
};
const run = async (a, ...cmds) => {
  let last;
  for (const cmd of cmds) last = await a.handle(cmd);
  return last;
};
const id = (L, name) => L.findPerson(name).id;
const zeroSum = (L) => Object.values(L.netBalances()).reduce((a, b) => a + b, 0);

test('money: parsing and exact allocation', () => {
  assert.equal(parseAmount('$1,234.56'), 123456);
  assert.equal(parseAmount('1.2k'), 120000);
  assert.equal(parseAmount('20 bucks'), 2000);
  assert.equal(parseAmount('abc'), null);
  assert.deepEqual(allocate(10000, [1, 1, 1]), [3334, 3333, 3333]);
  assert.equal(allocate(9999, [3, 2, 2]).reduce((a, b) => a + b), 9999);
});

test('equal split with friends, payer included via "with"', async () => {
  const { a, L } = make();
  await run(a, 'I paid 120 for dinner with Ali and Sara');
  assert.equal(L.balanceWith(id(L, 'Ali')), 4000);
  assert.equal(L.balanceWith(id(L, 'Sara')), 4000);
  assert.equal(L.state.expenses[0].category, 'food');
  assert.equal(zeroSum(L), 0);
});

test('"for X and Y" excludes the payer; friend-paid expense', async () => {
  const { a, L } = make();
  await run(a, 'add friends Ali and Sara', 'Ali paid 90 for groceries for me and Sara');
  const e = L.state.expenses[0];
  assert.deepEqual(Object.keys(e.paidBy), [id(L, 'Ali')]);
  assert.equal(e.owed[ME], 4500);
  assert.equal(L.balanceWith(id(L, 'Ali')), -4500);
});

test('exact, percent, ratio and multi-payer splits', async () => {
  const { a, L } = make();
  await run(a, 'rent 3000 split me 1500, Ali 1000, Sara 500');
  assert.equal(L.state.expenses[0].description, 'Rent');
  assert.equal(L.balanceWith(id(L, 'Ali')), 100000);
  await run(a, 'I paid 200 for tickets split Ali 25%, me 75%');
  assert.equal(L.state.expenses[1].owed[id(L, 'Ali')], 5000);
  await run(a, 'split 60/40 with Ali for gas 50');
  assert.equal(L.state.expenses[2].owed[id(L, 'Ali')], 2000);
  await run(a, 'Ali paid 60 and I paid 40 for dinner with Sara');
  const e = L.state.expenses[3];
  assert.equal(e.amount, 10000);
  assert.equal(Object.values(e.owed).reduce((x, y) => x + y), 10000);
  assert.equal(zeroSum(L), 0);
});

test('transfers, loans, IOUs and settle up', async () => {
  const { a, L } = make();
  await run(a, 'I paid 100 for dinner with Ali');
  const ali = id(L, 'Ali');
  await run(a, 'Ali paid me back 20');
  assert.equal(L.balanceWith(ali), 3000);
  await run(a, 'I lent Ali 50');
  assert.equal(L.balanceWith(ali), 8000);
  await run(a, 'I owe Ali 15');
  assert.equal(L.balanceWith(ali), 6500);
  await run(a, 'I paid Comcast 80'); // unknown payee → personal expense, not a new friend
  assert.equal(L.findPerson('Comcast'), null);
  const r = await run(a, 'settle up with Ali');
  assert.match(r.reply, /square/);
  assert.equal(L.balanceWith(ali), 0);
});

test('simplify produces the minimal transfer plan', async () => {
  const { a, L } = make();
  await run(a, 'create group Trip with Ali and Sara', 'I paid 300 for hotel in Trip', 'Ali paid 90 for food in Trip');
  const plan = L.simplify(L.netBalances({ groupId: Object.keys(L.state.groups)[0] }));
  assert.ok(plan.length <= 2);
  assert.equal(plan.reduce((s, p) => s + p.amount, 0), 17000); // you are owed 300-100-30
  const r = await run(a, 'who pays next in Trip');
  assert.match(r.reply, /Sara/);
});

test('dates, method, explicit category', async () => {
  const { a, L } = make();
  await run(a, 'I paid 80 for gas yesterday via Venmo #car');
  const e = L.state.expenses[0];
  assert.equal(e.date, '2026-10-08');
  assert.equal(e.method, 'Venmo');
  assert.equal(e.category, 'car');
});

test('recurring items post when due and drive the forecast', async () => {
  const { a, L, c } = make();
  await run(a, 'salary 5000 every month on the 1st', 'rent 2000 every month on the 1st split with Ali', 'netflix 15 monthly');
  assert.equal(L.state.income.length, 0); // next 1st is in November
  assert.equal(L.state.expenses.length, 1); // netflix posts today
  c.t = new Date('2026-12-02T09:00:00');
  await run(a, 'balances');
  assert.equal(L.state.income.length, 2);
  assert.equal(L.state.expenses.filter((e) => e.description === 'Rent').length, 2);
  assert.equal(L.balanceWith(id(L, 'Ali')), 200000);
});

test('budgets, goals, cash, forecast and affordability', async () => {
  const { a, L } = make();
  await run(a, 'salary 5000 every month on the 1st', 'I have 8000 in the bank', 'budget 400 for food', 'save 6000 for a car by March 2027', 'add 1000 to car');
  const g = a.planner.goalNeeds()[0];
  assert.equal(g.saved, 100000);
  assert.equal(g.perMonth, Math.ceil(500000 / 6));
  const f = a.planner.forecast(6);
  assert.equal(f.rows.length, 6);
  assert.equal(f.rows[1].income, 500000);
  assert.match((await run(a, 'can I afford a 1500 laptop in February?')).reply, /Yes|Tight/);
  assert.match((await run(a, 'can I afford 90000 for a boat next month')).reply, /Not yet/);
  assert.match((await run(a, 'budgets')).reply, /food/);
});

test('forecast calibration learns from a month that overshot', async () => {
  const { a, L, c } = make({ at: '2026-08-15T12:00:00' });
  for (let d = 1; d <= 28; d += 3) await run(a, `I paid 30 for lunch on 2026-08-${String(d).padStart(2, '0')}`);
  c.t = new Date('2026-09-20T12:00:00');
  a.planner.forecast(3); // records a prediction for October
  const predicted = L.state.brain.calibration.history.find((h) => h.month === '2026-10').predicted;
  for (let d = 1; d <= 28; d++) await run(a, `I paid 30 for lunch on 2026-10-${String(d).padStart(2, '0')}`);
  c.t = new Date('2026-11-03T12:00:00');
  a.planner.forecast(3);
  const h = L.state.brain.calibration.history.find((x) => x.month === '2026-10');
  assert.ok(h.actual > predicted);
  assert.ok(L.state.brain.calibration.factor > 1, 'factor should rise after under-forecasting');
});

test('self-improvement: aliases, categories, taught phrasings', async () => {
  const { a, L } = make();
  await run(a, 'I paid 10 for coffee with Ali', 'Al is also called Ali');
  await run(a, 'I paid 20 for lunch with Al');
  assert.equal(L.balanceWith(id(L, 'Ali')), 1500);

  await run(a, 'categorize chipotle as food');
  await run(a, 'chipotle 14');
  assert.equal(L.state.expenses.at(-1).category, 'food');

  const miss = await run(a, 'snagged boba via Sara 12');
  await run(a, 'add friend Sara');
  await run(a, 'teach "snagged boba via Sara 12" = "Sara paid 12 for boba with me"');
  const before = L.state.expenses.length;
  const r = await run(a, 'snagged ramen night via Sara 30');
  assert.equal(L.state.expenses.length, before + 1);
  const e = L.state.expenses.at(-1);
  assert.equal(e.description, 'Ramen night');
  assert.equal(e.paidBy[id(L, 'Sara')], 3000);
  assert.match(r.reply, /learned earlier/);
  assert.ok(miss);
});

test('AI fallback is learned, then never needed again for that shape', async () => {
  let calls = 0;
  const translate = async (text) => {
    calls++;
    const m = text.match(/^(\w+) got me (\w+), (\d+)$/i);
    return m ? { commands: [`${m[1]} paid ${m[3]} for "${m[2]}" for me`], clarification: '' } : { commands: [], clarification: 'Who paid?' };
  };
  const { a, L } = make({ translate });
  await run(a, 'add friend Ali', 'add friend Sara');
  // The rules alone would misread this as an even split; the leftover "me"
  // marks the parse as shaky, so the AI is consulted first.
  const r1 = await run(a, 'Ali got me sushi, 40');
  assert.equal(calls, 1);
  assert.match(r1.reply, /learned it/);
  assert.equal(L.balanceWith(id(L, 'Ali')), -4000);
  await run(a, 'Sara got me tacos, 18');
  assert.equal(calls, 1, 'second sentence of the same shape must not call the AI');
  assert.equal(L.balanceWith(id(L, 'Sara')), -1800);
  assert.equal(L.state.expenses.at(-1).description, 'Tacos');
  assert.equal(L.state.brain.stats.templateHits, 1);
  const q = await run(a, 'Ali and me, 5, you know');
  assert.equal(q.reply, 'Who paid?');
});

test('undo restores money but keeps what was learned', async () => {
  const { a, L } = make();
  await run(a, 'I paid 50 for dinner with Ali', 'categorize boba as food', 'I paid 30 for boba with Ali');
  assert.equal(L.state.expenses.length, 2);
  await run(a, 'undo');
  assert.equal(L.state.expenses.length, 1);
  assert.ok(L.state.brain.categoryWords.boba?.food > 0);
  await run(a, 'delete last');
  assert.equal(L.state.expenses.length, 0);
});

test('queries do not mutate and unknown text is logged as a miss', async () => {
  const { a, L } = make();
  await run(a, 'I paid 60 for dinner with Ali');
  for (const q of ['balances', 'how much do I owe Ali?', 'how much did I spend this month', 'forecast', 'how am I doing', 'history', 'what have you learned', 'help'])
    assert.ok((await a.handle(q)).reply.length > 0, q);
  assert.equal(L.state.expenses.length, 1);
  await a.handle('blorp the flibbertigibbet');
  assert.equal(L.state.brain.misses.at(-1).text, 'blorp the flibbertigibbet');
});

test('file store round-trips', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { FileStore } = await import('../src/store.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const file = path.join(dir, 'l.json');
  const a1 = new Assistant(new FileStore(file), { translate: null });
  await a1.handle('I paid 42 for pizza with Ali');
  const a2 = new Assistant(new FileStore(file), { translate: null });
  assert.equal(a2.ledger.state.expenses.length, 1);
  await a2.handle('undo');
  assert.equal(new Assistant(new FileStore(file), { translate: null }).ledger.state.expenses.length, 0);
});

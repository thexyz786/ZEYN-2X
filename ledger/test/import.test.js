import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Assistant } from '../src/assistant.js';
import { MemoryStore } from '../src/store.js';
import { cleanMerchant, looksLikeStatement, parseStatement } from '../src/importer.js';

const make = (iso = '2026-10-12T12:00:00') => {
  const c = { t: new Date(iso) };
  return { a: new Assistant(new MemoryStore(), { now: () => c.t, translate: null }), c };
};

// Synthetic Chase-style checking export (format only; values invented).
const CHASE = `Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,07/01/2026,"ZELLE PAYMENT TO LANDLORD JUL",-900.00,QUICKPAY_DEBIT,2100.00,,
DEBIT,07/03/2026,"SPOTIFY USA 877-778-1161 NY",-11.99,DEBIT_CARD,2088.01,,
DEBIT,07/05/2026,"TRADER JOE S #123 LOS ANGELES CA",-54.20,DEBIT_CARD,2033.81,,
CREDIT,07/15/2026,"PAYROLL ACME INC PPD ID: 9988",1500.00,ACH_CREDIT,3533.81,,
DEBIT,07/20/2026,"CHASE CREDIT CRD AUTOPAY PPD ID: 4760",-300.00,ACH_DEBIT,3233.81,,
DEBIT,08/01/2026,"ZELLE PAYMENT TO LANDLORD AUG",-900.00,QUICKPAY_DEBIT,2333.81,,
DEBIT,08/03/2026,"SPOTIFY USA 877-778-1161 NY",-11.99,DEBIT_CARD,2321.82,,
CREDIT,08/15/2026,"PAYROLL ACME INC PPD ID: 9988",1500.00,ACH_CREDIT,3821.82,,
DEBIT,08/16/2026,"STARBUCKS STORE 01234 LOS ANGELES CA",-6.45,DEBIT_CARD,3815.37,,
DEBIT,08/16/2026,"STARBUCKS STORE 01234 LOS ANGELES CA",-6.45,DEBIT_CARD,3808.92,,
DEBIT,09/03/2026,"SPOTIFY USA 877-778-1161 NY",-11.99,DEBIT_CARD,3796.93,,
CREDIT,09/15/2026,"PAYROLL ACME INC PPD ID: 9988",1500.00,ACH_CREDIT,5296.93,,
DEBIT,09/20/2026,"AMAZON MKTPL RETURN REFUND",25.00,DEBIT_CARD,5321.93,,
DEBIT,10/03/2026,"SPOTIFY USA 877-778-1161 NY",-11.99,DEBIT_CARD,5309.94,,
`;

const MD = `# Ledger import
account: Chase Checking 0078
currency: USD
closing_balance: 4210.55
balance_date: 2026-10-08

## Transactions
| date | description | amount | category | kind | note |
|---|---|---|---|---|---|
| 2026-10-01 | Rent October | -900.00 | housing | expense | |
| 2026-10-02 | Groceries with Ali | -80.00 | groceries | split:Ali | |
| 2026-10-04 | Zelle from Ali | 25.00 | | transfer:Ali | his share of utilities |
| 2026-10-05 | Card payment | -200.00 | | internal | |
| 2026-10-06 | LACC refund | 1200.00 | aid | income | |

## Recurring
| name | amount | frequency | day | kind | category |
|---|---|---|---|---|---|
| Rent | 900 | monthly | 1 | expense | housing |

## Budgets
| category | monthly |
|---|---|
| food | 250 |

## Goals
| name | target | deadline | saved |
|---|---|---|---|
| Mumbai ticket | 1400 | 2026-12-15 | 300 |
`;

test('merchant names are cleaned', () => {
  assert.equal(cleanMerchant('TRADER JOE S #123 LOS ANGELES CA'), 'Trader Joe S');
  assert.equal(cleanMerchant('SPOTIFY USA 877-778-1161 NY'), 'Spotify Usa');
  assert.equal(cleanMerchant('PAYROLL ACME INC PPD ID: 9988'), 'Payroll Acme Inc');
  assert.ok(looksLikeStatement(CHASE));
  assert.ok(looksLikeStatement(MD));
  assert.ok(!looksLikeStatement('I paid 20 for lunch'));
});

test('bank CSV: imports, skips internal, detects recurring, sets cash', async () => {
  const { a } = make();
  const r = await a.handle(CHASE);
  const s = a.ledger.state;
  assert.match(r.reply, /Imported/);
  // 10 debits − 1 card autopay = 9; plus Spotify's Oct 3 is the last seen, next due Nov 3.
  assert.equal(s.expenses.length, 9);
  assert.equal(s.income.length, 4); // 3 payroll + 1 refund
  assert.ok(s.income.some((i) => /^Refund/.test(i.source)));
  assert.equal(s.cash.amount, 530994);
  assert.equal(s.cash.date, '2026-10-03');
  const labels = s.recurring.map((x) => x.label);
  assert.ok(labels.some((l) => /Spotify/.test(l)), 'spotify detected');
  assert.ok(labels.some((l) => /Payroll/.test(l)), 'payroll detected');
  // Both identical Starbucks rows on one day survive (occurrence-aware fingerprints).
  assert.equal(s.expenses.filter((e) => /Starbucks/.test(e.description)).length, 2);
});

test('re-importing the same statement adds nothing', async () => {
  const { a } = make();
  await a.handle(CHASE);
  const before = JSON.stringify([a.ledger.state.expenses.length, a.ledger.state.income.length]);
  const r = await a.handle(CHASE);
  assert.match(r.reply, /already in the ledger/);
  assert.equal(JSON.stringify([a.ledger.state.expenses.length, a.ledger.state.income.length]), before);
});

test('next statement reconciles a scheduled bill instead of duplicating it', async () => {
  const { a, c } = make('2026-10-12T12:00:00');
  await a.handle(CHASE);
  c.t = new Date('2026-11-05T12:00:00');
  await a.handle('balances'); // Spotify's Nov 3 estimate posts
  const est = a.ledger.state.expenses.filter((e) => /Spotify/.test(e.description) && e.date >= '2026-11-01');
  assert.equal(est.length, 1);
  await a.handle(`Details,Posting Date,Description,Amount,Type,Balance,Check or Slip #
DEBIT,11/04/2026,"SPOTIFY USA 877-778-1161 NY",-12.99,DEBIT_CARD,5000.00,,`);
  const after = a.ledger.state.expenses.filter((e) => /Spotify/.test(e.description) && e.date >= '2026-11-01');
  assert.equal(after.length, 1);
  assert.equal(after[0].amount, 1299);
  assert.equal(after[0].date, '2026-11-04');
});

test('markdown import file: splits, transfers, internal, recurring, budgets, goals, cash', async () => {
  const { a } = make();
  const r = await a.handle(MD);
  const s = a.ledger.state;
  const ali = a.ledger.findPerson('Ali').id;
  assert.equal(a.ledger.balanceWith(ali), 4000 - 2500);
  assert.equal(s.expenses.length, 2);
  assert.equal(s.income[0].amount, 120000);
  assert.equal(s.cash.amount, 421055);
  assert.equal(s.cash.date, '2026-10-08');
  assert.equal(s.budgets.food, 25000);
  assert.equal(s.goals[0].saved, 30000);
  assert.ok(s.recurring.some((x) => x.label === 'Rent' && x.next === '2026-11-01'));
  assert.match(r.reply, /Skipped .*1 card payments/);
  await a.handle('undo');
  assert.equal(a.ledger.state.expenses.length, 0);
  assert.equal(parseStatement(MD).transactions.length, 5);
});

test('budget questions answer without recording anything', async () => {
  const { a } = make();
  await a.handle(MD);
  const n = a.ledger.state.expenses.length;
  for (const q of ['can I budget for a 300 jacket?', 'do I have room for a 300 jacket next month', 'is a 1200 flight in december doable'])
    assert.match((await a.handle(q)).reply, /Yes|Tight|Not yet/, q);
  assert.equal(a.ledger.state.expenses.length, n, 'questions must not log expenses');

  const next = await a.handle('how much money do I have left for next month');
  assert.match(next.reply, /free to spend\*\* in Nov 2026/);
  const lo = a.planner.leftover(1);
  const af = a.planner.afford(30000, '2026-11-30');
  assert.equal(af.free, lo.free, '"what\'s left" and "can I afford" use the same number');
  assert.match((await a.handle('how much do I have left for food')).reply, /left\*\* in your food budget/);
});

test('expected income counts in plans; days after the last statement are estimated', async () => {
  const { a } = make('2026-10-12T12:00:00');
  await a.handle(`# Ledger import
account: Test Checking
closing_balance: 3000
balance_date: 2026-09-18

## Transactions
| date | description | amount | category | kind |
|---|---|---|---|---|
| 2026-09-02 | Coffee | -15.00 | food | expense |
| 2026-09-06 | Groceries | -60.00 | groceries | expense |
| 2026-09-10 | Lunch | -30.00 | food | expense |
| 2026-09-15 | Books | -45.00 | education | expense |`);
  // 150 over 18 days → ~250/month everyday; 24 uncovered days since Sep 18 are estimated.
  const ct = a.planner.cashToday();
  assert.ok(ct.gap > 15000 && ct.gap < 25000, `gap ${ct.gap}`);
  assert.equal(ct.cash, 300000 - ct.gap);
  const before = a.planner.leftover(3).free;
  const r = await a.handle('expect 1849 Pell Grant on Jan 12');
  assert.match(r.reply, /Expecting \$1,849\.00 from Pell Grant on 2027-01-12/);
  assert.equal(a.planner.leftover(3).free - before, 184900);
  assert.equal(a.ledger.state.income.length, 0, 'not recorded until it arrives');
  assert.equal((await a.handle("I'll get 500 from freelance in November")).results[0].intents[0].type, 'expect');
});

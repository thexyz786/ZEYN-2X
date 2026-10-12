import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Assistant } from '../src/assistant.js';
import { MemoryStore } from '../src/store.js';
import { Copilot } from '../src/copilot.js';

const make = () => {
  const c = { t: new Date('2026-10-12T12:00:00') };
  return { a: new Assistant(new MemoryStore(), { now: () => c.t, translate: null }), c };
};

// Invented figures in the foundation-file format the project prompt produces.
const FOUNDATION = `# Ledger import
mode: replace
currency: USD
as_of: 2026-10-08

## Profile
You are a student in Los Angeles. Your rent of $850 is due on the 1st.
Your aid arrives in two disbursements a semester.

## Accounts
| name | type | balance | as of | spendable | note |
|---|---|---|---|---|---|
| Chase Checking 0078 | checking | 3000.00 | 2026-10-08 | yes | |
| Chase Card 0742 | credit | 200.00 | 2026-10-06 | | owed |
| BQHC Savings | savings | 420.00 | 2026-10-08 | no | |

## Transactions
| date | account | description | amount | category | kind | note |
|---|---|---|---|---|---|---|
| 2026-09-01 | Chase Checking 0078 | Rent | -850.00 | housing | expense | |
| 2026-09-05 | Chase Checking 0078 | Pell Grant disbursement 1 of 2 | 1849.00 | aid | income | |
| 2026-09-08 | Chase Checking 0078 | BQHC weekly saving | -21.00 | | | |
| 2026-09-12 | Chase Card 0742 | Trader Joe's | -60.00 | groceries | expense | |
| 2026-09-20 | Chase Card 0742 | Chipotle | -14.00 | food | expense | |
| 2026-09-25 | Chase Checking 0078 | Chase card payment | -74.00 | | internal | |
| 2026-09-25 | Chase Card 0742 | Payment from checking | 74.00 | | internal | |
| 2026-10-01 | Chase Checking 0078 | Rent | -850.00 | housing | expense | |
| 2026-10-03 | Chase Card 0742 | Trader Joe's | -40.00 | groceries | expense | |

## Recurring
| name | amount | frequency | day | kind | category | next |
|---|---|---|---|---|---|---|
| Rent | 850 | monthly | 1 | expense | housing | 2026-11-01 |
| BQHC weekly saving | 21 | weekly | | expense | savings | 2026-10-13 |

## Expected
| name | amount | date | kind | category |
|---|---|---|---|---|
| Pell Grant disbursement 2 of 2 | 1849 | 2027-01-20 | income | aid |
| Mumbai ticket | 1150 | 2026-12-01 | expense | travel |

## Payees
| payee | category | kind | note |
|---|---|---|---|
| BQHC | savings | expense | own savings |

## People
| name | aliases | note |
|---|---|---|
| Ali | 803 | roommate |

## Rules
- BQHC is my own savings; transfers to it are savings, not spending.

## Open questions
- Who is the $84 Zelle on Sep 1 to "803" for?
`;

test('foundation file: every section lands where the app uses it', async () => {
  const { a } = make();
  await a.handle('I paid 30 for dinner with Sara'); // typed in chat: must survive a replace
  await a.handle('I paid 999 for "old import row" #misc'); // stand-in for an earlier import:
  a.ledger.state.expenses.at(-1).origin = 'import';
  const r = await a.handle(FOUNDATION);
  const s = a.ledger.state;
  assert.match(r.reply, /Replaced the earlier imported baseline \(1 entries/);
  assert.ok(s.expenses.some((e) => e.description === 'Dinner'), 'chat entry kept');
  assert.ok(!s.expenses.some((e) => e.description === 'Old import row'), 'old import removed');

  // Accounts: cash = checking − card owed (card purchases are listed).
  assert.equal(s.cash.amount, 300000 - 20000);
  assert.equal(s.cash.date, '2026-10-08');
  assert.equal(s.accounts.length, 3);
  assert.match(r.reply, /Chase Card 0742 \$200\.00 owed/);

  // Internal card payment skipped on both sides; payee rule filed BQHC.
  assert.ok(!s.expenses.some((e) => /payment/i.test(e.description)));
  assert.equal(s.expenses.find((e) => /Bqhc|BQHC/.test(e.description)).category, 'savings');

  // Expected: Mumbai ticket counts in December, Pell in January.
  const dec = a.planner.leftover(2);
  assert.equal(dec.label, 'Dec 2026');
  assert.ok(dec.billsAhead >= 115000 + 85000, 'ticket and rent both due in December');
  const jan = a.planner.leftover(3);
  assert.ok(jan.incomeAhead >= 184900);

  // Profile, rules, questions, people.
  assert.match(s.profile, /student in Los Angeles/);
  assert.equal(s.brain.copilot.lessons[0].text, 'BQHC is my own savings; transfers to it are savings, not spending.');
  assert.deepEqual(s.openQuestions, ['Who is the $84 Zelle on Sep 1 to "803" for?']);
  assert.equal(a.ledger.findPerson('803').id, a.ledger.findPerson('Ali').id);
  assert.match(r.reply, /Open questions/);

  // Claude sees all of it.
  const co = new Copilot(a, { json: async () => ({}) });
  const prompt = co.instructions('hi');
  for (const want of [/student in Los Angeles/, /Chase Card 0742 \(credit\) \$200\.00 owed/, /Mumbai ticket \$1,150\.00 expected 2026-12-01/, /1\. Who is the \$84 Zelle/, /BQHC is my own savings/])
    assert.match(prompt, want);
});

test('re-importing the foundation is idempotent; an update adds on top', async () => {
  const { a, c } = make();
  await a.handle(FOUNDATION);
  const n = a.ledger.state.expenses.length;
  await a.handle(FOUNDATION);
  assert.equal(a.ledger.state.expenses.length, n, 'replace + same file = same ledger');
  assert.equal(a.ledger.state.recurring.length, 4);

  c.t = new Date('2026-11-05T12:00:00');
  await a.handle('balances'); // Nov 1 rent estimate posts
  const r = await a.handle(`# Ledger import
mode: add
as_of: 2026-11-04

## Accounts
| name | type | balance | as of | spendable |
|---|---|---|---|---|
| Chase Checking 0078 | checking | 2100.00 | 2026-11-04 | yes |
| Chase Card 0742 | credit | 90.00 | 2026-11-03 | |

## Transactions
| date | account | description | amount | category | kind |
|---|---|---|---|---|---|
| 2026-10-03 | Chase Card 0742 | Trader Joe's | -40.00 | groceries | expense |
| 2026-11-01 | Chase Checking 0078 | Rent | -850.00 | housing | expense |
| 2026-11-02 | Chase Card 0742 | BQHC transfer | -21.00 | | |
`);
  const s = a.ledger.state;
  assert.match(r.reply, /1 already in the ledger/);
  assert.match(r.reply, /Matched 2 scheduled bills/); // rent, and the BQHC transfer to that week's savings estimate
  assert.match(r.reply, /Imported Chase Card 0742, Chase Checking 0078/);
  assert.equal(s.expenses.filter((e) => e.description === 'Rent' && e.date === '2026-11-01').length, 1);
  assert.equal(s.cash.amount, 210000 - 9000);
  const bqhc = s.expenses.find((e) => e.date === '2026-11-02');
  assert.equal(bqhc.category, 'savings', 'payee rule / schedule filed the new BQHC row');
  assert.equal(bqhc.reconciled, true);
});

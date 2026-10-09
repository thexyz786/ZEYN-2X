# Ledger

A Splitwise-style shared-expense ledger and personal financial planner. You
run it by talking to it. Tell it what happened ("I paid 120 for dinner with Ali
and Sara"), who paid, who shares, and where the money went. Then ask it what
you owe, what you can afford, and where you will be in six months. It learns how
you phrase things and how you actually spend.

```
› Ali paid 90 for groceries for me and Sara
✓ Groceries $90.00 — Ali paid; split equally between You, Sara ($45.00 each).
→ You owe Ali $45.00.

› can I afford a 1500 laptop in March?
✅ Yes — you'd have $11,076.79 of free cash (after goal set-asides) in Mar 2027, leaving $9,576.79.
```

## Run it

Requires Node 20+. The core has no dependencies.

```bash
cd ledger
npm start                 # web app → http://127.0.0.1:4747
npm run cli               # chat in the terminal
node bin/ledger.js "I paid 60 for dinner with Ali"   # one-shot
npm test
```

Data is stored in `ledger/data/ledger.json`, with an undo history beside it.
Set `LEDGER_DATA=/path/file.json` to keep it somewhere else, such as a synced
folder. `data/` is git-ignored, so your finances never end up in the repo.

To let other devices reach the server, set `HOST=0.0.0.0`. Do this only on a
network you trust: the server has no login.

## What it understands

| You say | It does |
|---|---|
| `I paid 120 for dinner with Ali and Sara` | Splits equally between you and the people listed |
| `Ali paid 90 for groceries for me and Sara` | Only the people after "for" owe |
| `rent 3000 split me 1500, Ali 1000, Sara 500` | Exact split. Also `25%` splits, `2 shares`, and `split 60/40 with Ali` |
| `Ali paid 60 and I paid 40 for dinner with Sara` | Several payers |
| `… yesterday` · `on oct 3` · `in Trip` · `#food` · `via Venmo` | Date, group, category, payment method |
| `I paid Ali 30` · `Ali paid me back 20` · `I lent Sara 50` · `I owe Ali 15` | Transfers, loans, IOUs |
| `settle up with Ali` · `simplify` · `who pays next in Trip` | Settling up, the fewest-payments plan, and whose turn it is |
| `I earned 5200 salary` · `salary 5200 every month on the 1st` | Income, one-off or recurring |
| `netflix 15 monthly` · `rent 2400 every month on the 1st split with Ali` | Recurring bills, posted automatically when due |
| `budget 400 for food` · `I have 8000 in the bank` | Budgets and a starting cash balance |
| `save 10000 for a car by June 2027` · `add 500 to car` | Savings goals and the monthly amount each one needs |
| `forecast 12 months` · `can I afford a 1500 laptop in March?` | Cash-flow forecast and an affordability verdict |
| `how am I doing` · `how much did I spend last month` · `budgets` | Insights and spending breakdowns |
| `balances` · `how much do I owe Ali?` · `history` · `undo` · `delete e12` | Balances and corrections |

Separate statements with `;` or new lines to send several at once.

## How it improves itself

1. **Learned phrasings.** The first time it sees a sentence shape it can't
   parse, it can learn it. You teach it explicitly
   (`teach "grabbed tacos w/ Ali 30" = "Ali paid 30 for tacos with me"`), or the
   AI fallback works it out. Either way the sentence is turned into a template:
   amounts, names and descriptions become slots. After that, any sentence of the
   same shape is handled locally, instantly and offline, with no AI call. Learned
   phrasings are checked before the built-in rules, so your own wording takes
   priority.
2. **Knowing when it isn't sure.** If the built-in rules leave a name or a
   pronoun unaccounted for, the parse is marked low-confidence. When the AI
   fallback is on, it gets a look first, and its answer becomes a new template.
3. **Category sense.** `categorize chipotle as food` also re-files past
   expenses. Every expense you categorise explicitly adds word→category weight,
   and those weights outrank the built-in keyword list.
4. **Nicknames and typos.** `Al is also called Ali` adds a nickname. A name that
   is one typo away from a known person is matched to them and remembered.
5. **Forecasts that correct themselves.** Each month's spending prediction is
   checked against what you actually spent. A bias factor moves toward the
   observed ratio, so a forecast that keeps coming in low stops doing so.

`what have you learned` shows all of the above, along with the phrases it
missed so you can teach them. `undo` reverses money changes but keeps what it
learned about your language.

## AI fallback (optional)

```bash
npm install                     # installs the optional @anthropic-ai/sdk
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

The model never touches a balance. It only rewrites your sentence into the
ledger's own command language. Those commands then go through the same
deterministic parser and validation as everything else, and the result is
learned as a template. `LEDGER_AI=off` forces offline mode. `LEDGER_MODEL`
overrides the model (default `claude-opus-5-5`).

## Design notes

- **Money is integer cents.** Splits use largest-remainder allocation, so the
  shares always add up to the total and every balance sums to zero.
- **Balances come from history.** Nothing is stored as a running total. Your
  balance with each friend is the pairwise debt, with each person's share owed
  to the payers in proportion to what they paid. `simplify` uses greedy
  largest-creditor/largest-debtor matching, which settles in at most n−1
  payments.
- **Your spending is your share** of each expense, not what you paid at the
  till. Budgets, insights and forecasts all use this number.
- **The forecast is explainable.** It is scheduled income, minus your share of
  recurring bills, minus your recent everyday spending (one-off purchases are
  not extrapolated) times the learned bias factor, minus goal contributions.

## Layout

```
src/money.js      cents, parsing, exact allocation
src/dates.js      calendar math and date phrases
src/ledger.js     people, groups, entries, balances, simplify, recurring, undo
src/parser.js     natural language → typed intents (pure)
src/brain.js      learned templates, category sense, miss log
src/planner.js    budgets, goals, forecast, affordability, calibration
src/ai.js         optional Claude fallback (canonical-command rewriting)
src/assistant.js  orchestration and replies
src/server.js     HTTP API + web UI     bin/ledger.js  CLI
```

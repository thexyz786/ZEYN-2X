# Ledger import format

Ledger reads two kinds of statement:

1. **Your bank's CSV export**, as downloaded. Chase checking and credit-card
   activity files work as they are. Any CSV with a date, a description and
   either an amount or debit/credit columns works too.
2. **A Ledger import file (`.md`)**, described below. Use it when you want to
   bring in several accounts at once, mark shared expenses, or include
   budgets, goals and bills. The prompt in `PROJECT_PROMPT.md` produces this
   file from a folder of statements.

You can import as often as you like. Rows that are already in the ledger are
skipped, and a scheduled bill is replaced by the real charge when that charge
arrives in a statement.

## File layout

```markdown
# Ledger import
account: Chase Checking 0078
currency: USD
period: 2026-07-01 to 2026-10-08
closing_balance: 4210.55
balance_date: 2026-10-08

## Transactions
| date | account | description | amount | category | kind | note |
|---|---|---|---|---|---|---|
| 2026-10-01 | Chase Checking 0078 | Rent October | -900.00 | housing | expense | |
| 2026-10-02 | Chase Checking 0078 | Trader Joe's | -80.00 | groceries | split:Ali | shared with roommate |
| 2026-10-04 | Chase Checking 0078 | Zelle from Ali | 25.00 | | transfer:Ali | his utilities share |
| 2026-10-05 | Chase Checking 0078 | Payment to Chase card | -200.00 | | internal | |
| 2026-10-06 | Chase Checking 0078 | LACC refund | 1200.00 | aid | income | |

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
```

## Header lines

All header lines are optional.

| Line | Meaning |
|---|---|
| `account:` | Default account name for rows that have no `account` cell. |
| `closing_balance:` | The account's balance at the end of the statement. It becomes the starting cash for forecasts. Give it for your main checking account only. |
| `balance_date:` | The date that balance is from, as YYYY-MM-DD. |

## Transactions table

- **date**: YYYY-MM-DD. US dates (MM/DD/YYYY) are also accepted.
- **amount**: negative for money out, positive for money in. Leave out
  currency symbols and thousands separators.
- **description**: the payee, cleaned up (for example "Trader Joe's", not
  "POS DEBIT 10/03 TRADER JOE S #123").
- **category**: optional. Use one of: food, groceries, transport, housing,
  utilities, subscriptions, entertainment, travel, shopping, health,
  education, personal, fees, gifts, services, aid. Categories you give teach
  the app, so later rows from the same payee are filed the same way.
- **kind**: optional. If you leave it out, the app works it out from the sign
  and the description.

| kind | Use it for |
|---|---|
| `expense` | Your own spending. |
| `income` | Pay, aid, refunds, interest. |
| `internal` | Credit-card payments and moves between your own accounts. These are skipped, so nothing is counted twice. |
| `transfer:Name` | Money sent to (negative) or received from (positive) a person, such as a loan or repayment. It changes your balance with that person, not your spending. |
| `split:Name1,Name2` | A bill you paid that is shared equally with those people. Your share counts as spending, and theirs is recorded as owed to you. |
| `skip` | Ignore this row. |

## Optional sections

- **Recurring** (`name, amount, frequency, day, kind, category, next`): bills and
  pay you already know about. `frequency` is one of weekly, biweekly, monthly
  or yearly. Bills that repeat in your history are detected without being
  listed here.
- **Expected** (`name, amount, date`): one-off money that's coming, such as
  the second disbursement of a grant. Plans count it until the deposit
  arrives in a statement, which then replaces it.
- **Budgets** (`category, monthly`).
- **Goals** (`name, target, deadline, saved`).

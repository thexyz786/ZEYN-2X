# Ledger import format

Zeyn Ledger reads three kinds of file:

1. **A foundation file** (`mode: replace`): the complete picture from your
   project files. Importing it replaces everything imported earlier. What you
   entered in the chat is kept.
2. **An update file** (`mode: add`, the default): new statements on top of
   the foundation. Rows the ledger already has are skipped, and scheduled
   bills are replaced by the real charges.
3. **A bank CSV export as downloaded**, such as Chase checking or card
   activity. It's read like an update.

`PROJECT_PROMPT.md` has the prompts that produce the first two from the USA
ACCOUNT BUDGET project.

## Layout

```markdown
# Ledger import
mode: replace
currency: USD
as_of: 2026-10-08

## Profile
You are a student at … Your rent of $850 is due on the 1st …

## Accounts
| name | type | balance | as of | spendable | note |
|---|---|---|---|---|---|
| Chase Checking 0078 | checking | 3253.48 | 2026-10-08 | yes | |
| Chase Card 0742 | credit | 240.47 | 2026-10-05 | | owed |
| BQHC Savings | savings | 420.00 | 2026-10-08 | no | |

## Transactions
| date | account | description | amount | category | kind | note |
|---|---|---|---|---|---|---|
| 2026-10-01 | Chase Checking 0078 | Rent | -850.00 | housing | expense | |
| 2026-10-03 | Chase Card 0742 | Trader Joe's | -34.50 | groceries | expense | |
| 2026-10-05 | Chase Checking 0078 | Chase card payment | -240.47 | | internal | |
| 2026-10-05 | Chase Card 0742 | Payment from checking | 240.47 | | internal | |

## Recurring
| name | amount | frequency | day | kind | category | next |
|---|---|---|---|---|---|---|
| Rent | 850 | monthly | 1 | expense | housing | 2026-11-01 |

## Expected
| name | amount | date | kind | category |
|---|---|---|---|---|
| Pell Grant disbursement 2 of 2 | 1849 | 2027-01-20 | income | aid |
| Mumbai ticket | 1150 | 2026-12-01 | expense | travel |

## Budgets
| category | monthly |
|---|---|
| food | 250 |

## Goals
| name | target | deadline | saved |
|---|---|---|---|
| Emergency fund | 1000 | 2027-05-31 | 200 |

## Payees
| payee | category | kind | note |
|---|---|---|---|
| BQHC | savings | expense | own savings |
| Xoom | transfers-abroad | expense | to own Axis account |

## People
| name | aliases | note |
|---|---|---|
| Ali | Ali R, 803 | roommate |

## Rules
- BQHC is my own savings; transfers to it are savings, not spending.

## Open questions
- Who is the $84 Zelle on Sep 1 to "803" for?
```

## Sections

| Section | Columns | What the app does with it |
|---|---|---|
| Profile | free text | Claude reads it before every answer. |
| Accounts | name, type (checking, savings, credit, cash, foreign), balance (for credit: amount owed), as of, spendable (yes/no), note | Cash for planning = spendable balances − balances owed on cards whose purchases are listed. |
| Transactions | date, account, description, amount (negative = out), category, kind, note | History, spending pace, balances with people. |
| Recurring | name, amount, frequency, day, kind, category, next | Scheduled into future months; estimates are matched to the real charge later. |
| Expected | name, amount, date, kind (income/expense), category | One-off money in or out, counted in the month it lands. |
| Budgets | category, monthly | Budget status. |
| Goals | name, target, deadline, saved | Monthly set-aside toward each goal. |
| Payees | payee, category, kind, note | Files future rows from that payee automatically. |
| People | name, aliases, note | Names and nicknames. |
| Rules | bulleted lines | Standing instructions Claude follows in the chat. |
| Open questions | bulleted lines | Shown when you open the app; answers become rules. |

### Transaction kinds

| kind | Use it for |
|---|---|
| `expense` | Your spending, including savings at another bank, transfers abroad, and card payments when the card's purchases aren't listed. |
| `income` | Aid, grants, pay, refunds, interest. |
| `internal` | A move between two accounts that both appear in the file. Both sides are skipped. |
| `transfer:Name` | Money sent to (negative) or received from (positive) a person. |
| `split:Name1,Name2` | A bill you paid that is shared equally with those people. |
| `skip` | Ignore the row. |

Categories: food, groceries, transport, housing, utilities, subscriptions,
entertainment, travel, shopping, health, education, personal, fees, gifts,
services, aid, income, savings, transfers-abroad, card.

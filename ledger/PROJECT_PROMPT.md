# Prompts for the USA ACCOUNT BUDGET project

Zeyn Ledger gets everything it knows about your money from one file,
`ledger-foundation.md`, which Claude writes from your project files. There
are two prompts:

1. **Foundation**, run once now and again whenever you want a clean
   rebuild. It reads every file in the project and writes the complete
   picture. Importing it replaces anything imported before. What you typed in
   the app's chat is kept.
2. **Monthly update**, run each time you add a new statement to the
   project. It writes only what's new, and importing it adds to the ledger.

How to run either one: open a new chat **inside the USA ACCOUNT BUDGET
project**, paste the prompt (everything between the lines), and send. Save
the file it produces, then in Zeyn Ledger press **Import** and choose it.

---

## 1. Foundation prompt

````
I use an app called Zeyn Ledger to answer one kind of question: "can I afford
this?" and "how much do I have left this month / next month?". It also tracks
what I owe and am owed. It can only answer well if it knows everything in this
project. Your job is to turn ALL the files in this project into one complete,
accurate file the app imports.

Work in four steps and show me only the result of step 4.

STEP 1: Inventory. Open every file in this project: bank and card CSVs,
statements (PDF or text), budget and aid plans, notes, earlier analyses and
dashboards. Note which accounts exist (checking, savings, credit cards, cash,
accounts abroad), what dates each file covers, and which plans or upcoming
events the files mention (aid disbursements, tuition, rent changes, trips,
planned purchases, money sent home).

STEP 2: Extract. Build the sections below from the files. Rules for every
section:
- Use only what the files say. Never invent, round or estimate an amount or a
  date. When something is unclear, say so in an Open question; don't guess.
- Account names: use one short name per account, ending in its last 4 digits
  ("Chase Checking 0078", "Chase Card 0742"). Never write a full account
  number, a routing number, or any ID number about me.
- Dates are YYYY-MM-DD. Amounts are plain numbers with no $ sign or commas.

STEP 3: Check your work before writing anything:
- For each account that has a starting and ending balance in the files, check
  that the starting balance plus its transactions equals the ending balance.
  If it doesn't, find the missing or duplicated rows. If you still can't
  make it match, write the gap as an Open question.
- Every real transaction appears exactly once, even when two files overlap.
- A payment from checking to a credit card appears on both accounts as
  `internal` only if that card's purchases are also listed. Otherwise the
  checking side is `expense` with category `card`.
- Every expense and income row has a category from the list below.

STEP 4: Output. Give me ONE downloadable Markdown file named
`ledger-foundation.md` with exactly these sections, in this order, and
nothing else in the file. After the file, write at most six short lines:
which files you read, the dates covered per account, the balance checks
(passed, or which failed and by how much), and how many open questions there
are.

# Ledger import
mode: replace
currency: USD
as_of: <the latest date any statement covers>

## Profile
Five to twelve short sentences, written about me in the second person ("You
are…"), using only facts from the files: my situation (for example student,
school, where I live), where my money comes from and when (aid, grants, work,
family), my big fixed costs, what I regularly send abroad or save, upcoming
events that cost money, and the priorities or worries the files state. No
account numbers or ID numbers.

## Accounts
| name | type | balance | as of | spendable | note |
- type: checking, savings, credit, cash or foreign.
- balance: the latest balance the files show. For a credit card, the amount
  I owe, as a positive number.
- spendable: yes for money I spend day to day (checking, cash); no for
  savings, money set aside, and accounts abroad.
- Include every account the files mention, even if a balance is missing. In
  that case leave balance empty and add an Open question.

## Transactions
| date | account | description | amount | category | kind | note |
- One row per real transaction on every account, from the earliest file to
  the latest.
- description: the payee in plain words ("Trader Joe's", "Rent", "Pell Grant
  disbursement 1 of 2"), without card numbers, store numbers, cities or
  reference codes.
- amount: negative = money left the account, positive = money came in. On a
  credit card, a purchase is negative and a payment to the card is positive.
- category: food, groceries, transport, housing, utilities, subscriptions,
  entertainment, travel, shopping, health, education, personal, fees, gifts,
  services, aid, income, savings, transfers-abroad or card.
- kind:
  - expense: my spending. This includes money that leaves for good: savings
    at another bank (category savings), money sent abroad even to my own
    account (category transfers-abroad), and card payments when the card's
    purchases aren't listed (category card).
  - income: aid, grants, pay, refunds, interest.
  - internal: a move between two accounts that both appear in this
    Transactions table. Mark both sides.
  - transfer:<FirstName>: money sent to or received from a person to settle a
    debt or as a loan, only when the files say so.
  - split:<Name1>,<Name2>: a bill I paid that is shared with those people,
    only when the files say so.
- note: anything uncertain about this row (an unknown payee, a guessed
  category). Every such row also gets an Open question.

## Recurring
| name | amount | frequency | day | kind | category | next |
Every bill, subscription, saving or income that repeats and is still
active: rent, phone, subscriptions, regular savings transfers, regular money
sent home, pay. frequency is weekly, biweekly, monthly or yearly. next is
the first date it's due after as_of. Include rent and anything the budget
plan calls recurring, even if it appears only once in the statements.

## Expected
| name | amount | date | kind | category |
One-off money coming in or going out after as_of that the files mention:
remaining aid or grant disbursements, refunds, tuition or fees due, planned
trips or tickets, deposits, planned large purchases. kind is income or
expense. If the files give an amount but no exact date, use the date they
imply and add an Open question. If they give no amount, leave the item out
and add an Open question.

## Budgets
| category | monthly |
The monthly limits from my budget plan, mapped to the categories above. Leave
this section out if the files set none.

## Goals
| name | target | deadline | saved |
Savings goals or big planned purchases with a target amount, from the files.

## Payees
| payee | category | kind | note |
Every payee that appears more than once, every Zelle/Venmo recipient and
every transfer service, with how it should be filed from now on. For
example: BQHC → savings, expense; Xoom → transfers-abroad, expense; a
roommate's Zelle → kind transfer:<Name> if the files say so. The app uses
these to file future statements automatically.

## People
| name | aliases | note |
People who appear in my transactions or notes (roommates, family, friends I
split costs with), with any nicknames or how their name shows on statements.

## Rules
- One line per standing preference about how my money should be counted, taken
  from the files or clear from how I've organised them. For example: "BQHC is
  my own savings account; transfers to it are savings, not spending." or "Xoom
  transfers to Axis Bank go to my own account in India; count them as
  transfers-abroad." Only include rules the files support.

## Open questions
- One line per thing you couldn't settle from the files: an unknown payee, a
  missing balance, a guessed date, an amount that didn't reconcile. Each
  should be answerable in one sentence.
````

---

## 2. Monthly update prompt

Add the new statement(s) to the project first, then send this in a new chat
inside the project:

````
Zeyn Ledger already has my foundation file. Make an update file named
`ledger-update.md` for the statement(s) I just added, using the same rules,
account names, categories, kinds and payee rules as the foundation, and the
same check-your-work step (balances must reconcile per account).

The file must start with:

# Ledger import
mode: add
currency: USD
as_of: <the latest date the new statements cover>

Then include only:
- ## Accounts: every account's latest balance.
- ## Transactions: only rows dated after the previous statement's end date.
  Overlap is harmless, since the app skips rows it already has.
- ## Recurring, ## Expected, ## Budgets, ## Goals, ## Payees, ## People,
  ## Rules: only rows that are new or changed. Leave a section out if nothing
  changed.
- ## Open questions: anything new you couldn't settle.

After the file, write at most four short lines: the dates covered, whether
the balances reconciled, what changed in bills or expected money, and any
open questions.
````

---

### What the app does with each section

| Section | In the app |
|---|---|
| Profile | Claude reads it before every answer, so advice fits your situation. |
| Accounts | **Free cash today** = spendable balances − card balances owed (when the card's purchases are listed). |
| Transactions | Your history: spending by category, your usual pace, balances with people. |
| Recurring | Bills and income scheduled into every future month. Each estimate is replaced by the real amount when the statement arrives. |
| Expected | One-off money in or out, counted in "what's left" and "can I afford" for the month it lands in. |
| Budgets, Goals | Budget status, and money set aside each month toward goals. |
| Payees | Future statements are filed automatically. |
| People | Names and nicknames, for shared costs and IOUs. |
| Rules | Standing instructions Claude follows in the chat. |
| Open questions | Shown when you open the app. Answer them in the chat and they're remembered as rules. |

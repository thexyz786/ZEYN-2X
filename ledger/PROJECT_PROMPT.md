# Prompt: build a Ledger import file from the USA ACCOUNT BUDGET project

Paste everything between the lines into a new chat **inside the USA ACCOUNT
BUDGET project** on claude.ai. It reads the project's files and produces one
`ledger-import.md`. Import that file into Zeyn Ledger (press **Import**, or
paste it into the chat).

For each later statement, run the second, shorter prompt with the new
statement attached.

---

You are preparing my bank history for import into my ledger app. Read every
file in this project: Chase CSV exports, statements, budget sheets, notes and
earlier analyses. Produce **one Markdown file named `ledger-import.md`** in
exactly the format below, and nothing else. If you can create files, make it
a downloadable file. Otherwise, output it as a single fenced code block I can
copy.

**Scope**
- Include every transaction from the start of the data through the latest
  date in any statement, for each US account: checking, savings and every
  credit card.
- Use only what the files contain. Never invent, round or estimate a
  transaction. If two files overlap, list each real transaction once.

**Header** (first lines of the file)
```
# Ledger import
account: <main checking account name, e.g. Chase Checking 0078>
currency: USD
period: <first date> to <last date>
closing_balance: <checking balance on the last date, from the Balance column or statement>
balance_date: <that date, YYYY-MM-DD>
```
Leave out `closing_balance` and `balance_date` if the files don't state a
checking balance. Never compute a balance yourself.

**`## Transactions`**: one pipe table with the columns
`| date | account | description | amount | category | kind | note |`
- `date`: YYYY-MM-DD, the posting date.
- `account`: a short account name such as "Chase Checking 0078" or "Chase
  Freedom 4760". Use the same name for an account in every row.
- `description`: the payee in plain words ("Trader Joe's", "Spotify",
  "LACC refund"). Remove card numbers, store numbers, cities, "POS DEBIT",
  phone numbers and reference IDs.
- `amount`: signed, with no $ sign or commas. Negative means money left the
  account; positive means money came in. On credit cards, a purchase is
  negative and a payment to the card is positive.
- `category`: exactly one of: food, groceries, transport, housing, utilities,
  subscriptions, entertainment, travel, shopping, health, education,
  personal, fees, gifts, services, aid. Leave it empty for `internal` and
  `transfer` rows.
- `kind`: one of the following.
  - `expense`: my own spending.
  - `income`: pay, financial aid, scholarships, refunds from merchants,
    interest.
  - `internal`: a credit-card payment, autopay, or a transfer between my own
    accounts. Mark both sides (the checking debit and the card credit). These
    are skipped on import so nothing is counted twice.
  - `transfer:<FirstName>`: Zelle, Venmo or cash sent to or received from a
    person when it settles a debt or is a loan, not a purchase. Use this only
    when the files or notes make that clear.
  - `split:<Name1>,<Name2>`: a bill I paid that I share equally with those
    people. Use this only when the files or notes say it was shared.
  - Zelle payments to a landlord, or other payments for a service, are
    `expense` with the right category (for example housing).
- `note`: optional. Use it for anything I should check, such as "unclear
  payee" or "possible duplicate across files".

**`## Recurring`**: `| name | amount | frequency | day | kind | category |`
List each bill, subscription or paycheck that appears in at least two
separate months with a steady amount and is still active in the latest
month. `frequency` is weekly, biweekly, monthly or yearly. `day` is the
usual day of the month. `kind` is expense or income. Leave out anything
that has stopped.

**`## Budgets`**: `| category | monthly |`
Include this only if the project's budget files set monthly limits. Use their
numbers and categories, mapped to the category list above.

**`## Goals`**: `| name | target | deadline | saved |`
Include this only if the project's files name savings goals or planned big
purchases with an amount. `deadline` is YYYY-MM-DD; `saved` may be 0.

**After the file**, write at most five short lines:
1. Which files you read and the date range covered.
2. How many transactions and accounts the file contains.
3. Rows marked internal, transfer or split, and why.
4. Anything you were unsure about (also flagged in `note`).

---

## For each new statement

Attach the new statement (Chase CSV or PDF) to a chat in the project and
send:

> Make a `ledger-import.md` for the attached statement only, in the same
> format and with the same account names, categories and kinds as before.
> Include the closing balance if the statement shows one. Don't include the
> Recurring, Budgets or Goals sections unless something changed.

Re-importing overlapping dates is safe: the ledger skips rows it already has
and replaces scheduled bills with their real amounts. A Chase CSV can also be
imported directly with no prompt; the `.md` route adds better payee names,
categories, and shared or person-to-person rows.

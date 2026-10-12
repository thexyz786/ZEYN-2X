// Statement import. Reads either
//   • a Ledger import file (.md) — the format in IMPORT_FORMAT.md, which the
//     project prompt produces from bank statements, or
//   • a raw bank export (.csv), e.g. Chase checking or credit-card activity,
// and folds it into the ledger so each new statement keeps everything current:
//   – rows already in the ledger are skipped (fingerprints survive re-imports
//     and overlapping statements),
//   – a row matching a scheduled bill the app already posted replaces that
//     estimate with the real amount and date (reconciliation),
//   – card payments and moves between your own accounts are skipped so money
//     is never counted twice,
//   – bills and paychecks that repeat are detected and scheduled, which feeds
//     the forecast,
//   – the closing balance becomes the cash anchor for projections, and
//   – every categorised row teaches the category sense for later rows.

import { ME, norm, advance } from './ledger.js';
import { parseAmount } from './money.js';
import { addDays, fromISO } from './dates.js';

// Transfers between your own accounts / card payments: never spending.
const INTERNAL_RE =
  /\b(payment thank you|autopay|auto[- ]?pymt|credit crd|crd epay|card payment|epay|online transfer (?:to|from)|transfer (?:to|from) (?:chk|sav|checking|savings)|from savings|to savings|book transfer|internal transfer)\b/i;
const REFUND_RE = /\b(refund|return(?:ed)?|reversal|credit adjustment|chargeback)\b/i;

const BANK_CATEGORIES = {
  'food & drink': 'food', groceries: 'groceries', gas: 'transport', automotive: 'transport', travel: 'travel',
  shopping: 'shopping', 'bills & utilities': 'utilities', entertainment: 'entertainment', 'health & wellness': 'health',
  personal: 'personal', education: 'education', home: 'housing', 'fees & adjustments': 'fees', 'gifts & donations': 'gifts',
  'professional services': 'services',
};

// ── parsing (pure) ─────────────────────────────────────────────────────────
export function looksLikeStatement(text) {
  const t = String(text || '');
  if (/^\s*#\s*ledger import\b/im.test(t)) return true;
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return false;
  if (/^\s*\|.*\bdate\b.*\|/im.test(t) && /^\s*\|\s*:?-{3,}/m.test(t)) return true;
  const head = lines[0].toLowerCase();
  return /,/.test(head) && /date/.test(head) && /(amount|debit|credit|withdrawal|deposit)/.test(head);
}

export function parseStatement(text, { filename = '' } = {}) {
  const src = String(text || '').replace(/\r\n?/g, '\n');
  const meta = {};
  // Header lines only (before the first section), so "account:" inside a
  // profile paragraph is never mistaken for the file's default account.
  const head = src.split(/^\s*##\s/m)[0];
  for (const m of head.matchAll(/^\s*[-*]?\s*(account|currency|period|mode|as[_ ]of|opening[_ ]balance|closing[_ ]balance|balance[_ ]date|closing[_ ]date)\s*:\s*(.+?)\s*$/gim))
    meta[m[1].toLowerCase().replace(/ /g, '_')] = m[2];
  const tables = /^\s*\|/m.test(src) ? mdTables(src) : [{ heading: 'transactions', rows: csvRows(src) }];
  const out = {
    meta, transactions: [], recurring: [], budgets: [], goals: [], expected: [],
    accounts: [], people: [], payees: [], rules: [], profile: '', questions: [],
  };
  for (const t of tables) {
    const kind = sectionKind(t.heading);
    if (kind === 'transactions') out.transactions.push(...t.rows.map(normalizeTxn).filter(Boolean));
    else if (kind === 'rules' || kind === 'questions') out[kind].push(...t.rows.map((r) => Object.values(r).filter(Boolean).join(' — ')));
    else if (kind !== 'profile') out[kind].push(...t.rows);
  }
  // Prose sections: the profile is kept as written; rules and open questions
  // are one item per bullet or numbered line.
  for (const sec of textSections(src)) {
    const kind = sectionKind(sec.heading);
    if (kind === 'profile') out.profile = sec.body.replace(/^\s*\|.*$/gm, '').trim().slice(0, 4000);
    if (kind === 'rules' || kind === 'questions')
      for (const line of sec.body.split('\n')) {
        const m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.+)$/);
        if (m) out[kind].push(m[1].trim());
      }
  }
  if (!meta.account && filename) meta.account = filename.replace(/\.[a-z]+$/i, '').replace(/_activity.*$/i, '');
  return out;
}

function sectionKind(heading) {
  const h = String(heading).toLowerCase();
  if (/recurr|bills?\b|subscription/.test(h)) return 'recurring';
  if (/budget/.test(h)) return 'budgets';
  if (/goal/.test(h)) return 'goals';
  if (/expect|upcoming|planned|future/.test(h)) return 'expected';
  if (/account/.test(h)) return 'accounts';
  if (/people|contacts|who/.test(h)) return 'people';
  if (/payee|merchant/.test(h)) return 'payees';
  if (/rule|preference|instruction/.test(h)) return 'rules';
  if (/profile|about me|about|situation|context/.test(h)) return 'profile';
  if (/question|unclear|to confirm/.test(h)) return 'questions';
  return 'transactions';
}

/** Each "## heading" with the text under it. */
function textSections(src) {
  const out = [];
  let cur = null;
  for (const line of src.split('\n')) {
    const hm = line.match(/^\s*#{2,6}\s+(.+)$/);
    if (hm) {
      cur = { heading: hm[1], body: '' };
      out.push(cur);
    } else if (cur) cur.body += line + '\n';
  }
  return out;
}

/** Every pipe table, tagged with the nearest heading above it. */
function mdTables(src) {
  const tables = [];
  let heading = 'transactions', cur = null;
  for (const line of src.split('\n')) {
    const hm = line.match(/^\s*#{1,6}\s+(.+)$/);
    if (hm) {
      heading = hm[1];
      cur = null;
      continue;
    }
    if (!/^\s*\|/.test(line)) {
      cur = null;
      continue;
    }
    const cells = line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue;
    if (!cur) {
      cur = { heading, cols: cells.map(key), rows: [] };
      tables.push(cur);
    } else cur.rows.push(Object.fromEntries(cur.cols.map((c, i) => [c, cells[i] ?? ''])));
  }
  return tables;
}

/** RFC-4180-ish CSV: quoted fields, embedded commas and doubled quotes. */
function csvRows(src) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (q) {
      if (ch === '"' && src[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') row.push(field), (field = '');
    else if (ch === '\n') row.push(field), rows.push(row), (row = []), (field = '');
    else field += ch;
  }
  if (field || row.length) row.push(field), rows.push(row);
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  const cols = head.map(key);
  return body.map((r) => Object.fromEntries(cols.map((c, i) => [c, (r[i] ?? '').trim()])));
}
const key = (h) => h.toLowerCase().replace(/[^a-z0-9#]+/g, ' ').trim();

function pick(row, ...names) {
  for (const n of names) for (const k of Object.keys(row)) if (k === n || k.startsWith(n)) if (row[k] !== '') return row[k];
  return '';
}

function toISODate(s) {
  const t = String(s || '').trim();
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/); // US banks: MM/DD/YYYY
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return `${y}-${String(m[1]).padStart(2, '0')}-${String(m[2]).padStart(2, '0')}`;
  }
  return null;
}

/** Signed cents: negative = money out. */
function signedAmount(row) {
  const amt = pick(row, 'amount');
  if (amt) {
    const neg = /^\s*-|^\s*\(.*\)\s*$/.test(amt);
    const c = parseAmount(amt.replace(/[()\-\s]/g, ''));
    if (c == null) return null;
    let v = neg ? -c : c;
    const type = pick(row, 'type', 'details', 'kind').toLowerCase();
    if (!neg && /^(debit|withdrawal|dr)$/.test(type)) v = -c;
    return v;
  }
  const out = parseAmount(pick(row, 'debit', 'withdrawal', 'money out'));
  const inn = parseAmount(pick(row, 'credit', 'deposit', 'money in'));
  if (out) return -out;
  if (inn) return inn;
  return null;
}

function normalizeTxn(row) {
  const date = toISODate(pick(row, 'date', 'posting date', 'transaction date', 'post date'));
  const amount = signedAmount(row);
  const raw = pick(row, 'description', 'merchant', 'payee', 'name', 'memo');
  if (!date || amount == null || amount === 0 || !raw) return null;
  return {
    date,
    amount,
    raw,
    description: cleanMerchant(raw),
    category: mapCategory(pick(row, 'category')),
    kind: pick(row, 'kind').toLowerCase() || null,
    balance: (() => {
      const b = pick(row, 'balance');
      if (!b) return null;
      const c = parseAmount(b.replace(/^-/, ''));
      return c == null ? null : /^-/.test(b) ? -c : c;
    })(),
    note: pick(row, 'note', 'notes') || null,
    account: pick(row, 'account') || null,
  };
}

function mapCategory(c) {
  const k = norm(c);
  if (!k) return null;
  return BANK_CATEGORIES[k] || k.replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** "POS DEBIT 10/03 STARBUCKS STORE #1234 LOS ANGELES CA" → "Starbucks Store". */
export function cleanMerchant(raw) {
  let s = String(raw)
    .replace(/\b(?:ppd|web|ccd)?\s*id:\s*\S*/gi, ' ')
    .replace(/\b(?:pos|debit card|card|recurring|purchase|debit|ach|ppd|web|withdrawal|payment to|orig co name|co entry descr)\b:?/gi, ' ')
    .replace(/\b(?:sq|tst|sp|pp|paypal|dd)\s*\*\s*/gi, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    .replace(/\+?\d[\d-]{6,}\d/g, ' ') // phone numbers, reference numbers
    .replace(/\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/gi, ' ') // "RENT OCT" and "RENT NOV" are one payee
    .replace(/#\s?\d+|\b\d{4,}\b|x{2,}\d+/gi, ' ')
    .replace(/\s+[A-Z]{2}\s*$/, ' ') // trailing state code
    .replace(/[*_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(/\s+(?:los angeles|san francisco|new york|houston|chicago|seattle|ca|tx|ny|wa)$/i, '').trim();
  if (!s) s = String(raw).trim();
  return s
    .toLowerCase()
    .split(' ')
    .slice(0, 5)
    .join(' ')
    .replace(/\b([a-z])/g, (c) => c.toUpperCase());
}

export const merchantKey = (d) => norm(d).replace(/[^a-z ]/g, '').split(' ').filter((w) => w.length > 1).slice(0, 3).join(' ');

// ── applying ───────────────────────────────────────────────────────────────
/**
 * Fold a parsed statement into the ledger. `ctx` = { ledger, brain, findPerson }.
 * Mutates the ledger (call inside a transaction). Returns a report.
 */
export function applyStatement(parsed, { ledger, brain }) {
  const s = ledger.state;
  const rowAccounts = [...new Set(parsed.transactions.map((t) => t.account).filter(Boolean))];
  const account = parsed.meta.account || (rowAccounts.length ? rowAccounts.slice(0, 3).join(', ') : 'Bank');
  const rep = {
    account, added: 0, income: 0, spent: 0, earned: 0, internal: 0, duplicates: 0, reconciled: 0, transfers: 0, people: [], recurring: [], cash: null,
    from: null, to: null, budgets: 0, goals: 0, replaced: null, accounts: [], payees: 0, rules: 0, profile: false, questions: [],
  };
  if (/^replace/i.test(parsed.meta.mode || '')) rep.replaced = resetImported(ledger);

  // Payee rules first, so the rows below are categorised by them.
  s.payees ??= {};
  for (const p of parsed.payees) {
    const name = pick(p, 'payee', 'name', 'merchant', 'description');
    const category = mapCategory(pick(p, 'category'));
    const kind = pick(p, 'kind').toLowerCase() || null;
    if (!name || (!category && !kind)) continue;
    s.payees[merchantKey(cleanMerchant(name))] = { name, category, kind, note: pick(p, 'note', 'notes') || null };
    if (category) brain.learnCategory(cleanMerchant(name), category, 5);
    rep.payees++;
  }
  for (const p of parsed.people) {
    const name = pick(p, 'name');
    if (!name) continue;
    const id = ensurePerson(ledger, name, rep);
    for (const a of pick(p, 'aliases', 'alias', 'aka').split(/\s*[,;/]\s*/).filter(Boolean)) ledger.addAlias(id, a);
  }

  // Fingerprints of what is already in the ledger.
  const seen = new Set([...s.expenses, ...s.income, ...s.transfers].map((x) => x.fp).filter(Boolean));
  const occurrences = new Map();
  const fpOf = (t) => {
    const base = `${t.account || account}|${t.date}|${t.amount}|${merchantKey(t.raw)}`;
    const n = (occurrences.get(base) || 0) + 1;
    occurrences.set(base, n);
    return `${base}#${n}`;
  };

  const txns = [...parsed.transactions].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const t of txns) {
    rep.from = rep.from && rep.from < t.date ? rep.from : t.date;
    rep.to = rep.to && rep.to > t.date ? rep.to : t.date;
    const fp = fpOf(t);
    if (seen.has(fp)) {
      rep.duplicates++;
      continue;
    }
    const extra = { origin: 'import', account: t.account || account, fp };
    const rule = payeeRule(s, t);
    if (rule && !t.category && rule.category) t.category = rule.category;
    if (rule && !t.kind && rule.kind) t.kind = rule.kind;
    const kind = t.kind || (INTERNAL_RE.test(t.raw) ? 'internal' : t.amount > 0 && REFUND_RE.test(t.raw) ? 'refund' : t.amount < 0 ? 'expense' : 'income');
    if (kind === 'internal' || kind === 'skip') {
      rep.internal++;
      continue;
    }
    const cents = Math.abs(t.amount);
    let m;
    if ((m = kind.match(/^transfer\s*:\s*(.+)$/))) {
      const pid = ensurePerson(ledger, m[1], rep);
      const tr = ledger.addTransfer({ from: t.amount < 0 ? ME : pid, to: t.amount < 0 ? pid : ME, amount: cents, date: t.date, note: t.note || t.description });
      Object.assign(tr, extra);
      rep.transfers++;
      rep.added++;
      continue;
    }
    if (kind === 'income' || kind === 'refund') {
      if (reconcile(ledger, 'income', t, extra)) {
        rep.reconciled++;
        continue;
      }
      ledger.addIncome({ amount: cents, source: kind === 'refund' ? `Refund: ${t.description}` : t.description, date: t.date, extra });
      rep.income++;
      rep.earned += cents;
      rep.added++;
      continue;
    }
    // Expense (optionally shared: "split:Ali,Sara").
    let category = t.category;
    if (category) brain.learnCategory(t.description, category, 2);
    else category = brain.predictCategory(t.description).category;
    if (reconcile(ledger, 'expense', t, extra)) {
      rep.reconciled++;
      continue;
    }
    let owed = { [ME]: cents };
    if ((m = kind.match(/^split\s*:\s*(.+)$/))) {
      const ids = [ME, ...m[1].split(/\s*,\s*|\s+and\s+/i).filter(Boolean).map((n) => ensurePerson(ledger, n, rep))];
      owed = ledger.shares(cents, ids);
    }
    ledger.addExpense({ description: t.description, amount: cents, paidBy: { [ME]: cents }, owed, date: t.date, category, method: t.account || account, extra });
    rep.spent += owed[ME] || 0;
    rep.added++;
  }

  // Closing balance → cash anchor (only if newer than the current anchor).
  const last = [...txns].reverse().find((t) => t.balance != null);
  const closing = parsed.meta.closing_balance ? parseSigned(parsed.meta.closing_balance) : null;
  const closingDate = toISODate(parsed.meta.balance_date || parsed.meta.closing_date || '') || rep.to;
  const anchor = closing != null ? { amount: closing, date: closingDate } : last ? { amount: last.balance, date: last.date } : null;
  // A statement covers through its balance date even if its last row is earlier.
  if (closing != null && closingDate && (!rep.to || closingDate > rep.to)) rep.to = closingDate;
  if (anchor && anchor.date && (!s.cash || anchor.date >= s.cash.date)) {
    s.cash = anchor;
    rep.cash = anchor;
  }

  // Accounts: balances per account. Cash for planning = spendable balances
  // (checking, cash) − what is owed on credit cards whose purchases are
  // itemised here. A card whose purchases are NOT itemised has its payments
  // counted as spending instead, so its balance is not subtracted again.
  if (parsed.accounts.length) {
    s.accounts ??= [];
    const itemised = new Set(parsed.transactions.map((t) => t.account).filter(Boolean));
    for (const a of parsed.accounts) {
      const name = pick(a, 'name', 'account');
      const bal = pick(a, 'balance');
      if (!name || bal === '') continue;
      const type = (pick(a, 'type') || 'checking').toLowerCase();
      const spendableCell = pick(a, 'spendable', 'counts as spendable').toLowerCase();
      const acct = {
        name, type,
        balance: parseSigned(bal),
        asOf: toISODate(pick(a, 'as of', 'as_of', 'date')) || rep.to || ledger.today(),
        spendable: spendableCell ? /^(y|yes|true)/.test(spendableCell) : /checking|cash/.test(type),
        itemised: itemised.has(name),
        note: pick(a, 'note', 'notes') || null,
      };
      const i = s.accounts.findIndex((x) => norm(x.name) === norm(name));
      if (i >= 0) s.accounts[i] = acct;
      else s.accounts.push(acct);
      rep.accounts.push(acct);
    }
    const cashAccts = s.accounts.filter((a) => a.spendable && !/credit/.test(a.type) && a.balance != null);
    if (cashAccts.length) {
      const date = cashAccts.map((a) => a.asOf).sort().at(-1);
      const owed = s.accounts.filter((a) => /credit/.test(a.type) && a.itemised && a.balance != null).reduce((x, a) => x + Math.abs(a.balance), 0);
      const amount = cashAccts.reduce((x, a) => x + a.balance, 0) - owed;
      if (!s.cash || date >= s.cash.date || rep.replaced) {
        s.cash = { amount, date, owedOnCards: owed };
        rep.cash = s.cash;
      }
      if (!rep.to || date > rep.to) rep.to = date;
    }
  }

  // Standing rules become lessons Claude follows; the profile is the context
  // it reads first; open questions are put to you in the chat.
  const co = (s.brain.copilot ??= { examples: [], lessons: [], stats: {} });
  for (const r of parsed.rules) {
    const text = r.replace(/\s+/g, ' ').trim();
    if (!text || co.lessons.some((l) => l.text.toLowerCase() === text.toLowerCase())) continue;
    co.lessons.push({ text, from: 'import', at: ledger.today() });
    rep.rules++;
  }
  if (co.lessons.length > 60) co.lessons.splice(0, co.lessons.length - 60);
  if (parsed.profile) (s.profile = parsed.profile), (rep.profile = true);
  if (parsed.questions.length) {
    s.openQuestions = [...new Set([...(rep.replaced ? [] : s.openQuestions || []), ...parsed.questions])].slice(-30);
    rep.questions = parsed.questions;
  }

  // Optional sections from an import file.
  for (const b of parsed.budgets) {
    const cat = mapCategory(pick(b, 'category'));
    const amt = parseAmount(pick(b, 'monthly', 'amount', 'budget'));
    if (cat && amt) (s.budgets[cat] = amt), rep.budgets++;
  }
  for (const g of parsed.goals) {
    const name = pick(g, 'name', 'goal');
    const target = parseAmount(pick(g, 'target', 'amount'));
    if (!name || !target) continue;
    const existing = s.goals.find((x) => norm(x.name) === norm(name));
    if (existing) {
      existing.target = target;
      existing.deadline = toISODate(pick(g, 'deadline', 'by')) || existing.deadline;
      const saved = parseAmount(pick(g, 'saved'));
      if (saved != null) existing.saved = saved;
      rep.goals++;
      continue;
    }
    s.goals.push({ id: ledger.nextId('G'), name, target, saved: parseAmount(pick(g, 'saved')) || 0, deadline: toISODate(pick(g, 'deadline', 'by')), createdAt: new Date().toISOString() });
    rep.goals++;
  }
  for (const r of parsed.recurring) addListedRecurring(ledger, brain, r, rep);
  // Expected one-off income ("Pell Grant disbursement 2 of 2"), counted by
  // plans until it arrives and is matched to the real deposit.
  for (const e of parsed.expected) {
    const name = pick(e, 'name', 'description', 'source');
    const amount = parseAmount(pick(e, 'amount'));
    const date = toISODate(pick(e, 'date', 'expected', 'on'));
    if (!name || !amount || !date) continue;
    if (s.recurring.some((r) => r.active && r.freq === 'once' && norm(r.label) === norm(name))) continue;
    const kind = /expense|spend|purchase|pay|bill|cost|out/.test(pick(e, 'kind', 'type').toLowerCase()) ? 'expense' : 'income';
    const start = date < ledger.today() ? ledger.today() : date;
    const category = mapCategory(pick(e, 'category')) || (kind === 'expense' ? brain.predictCategory(name).category : null);
    const payload = kind === 'income' ? { amount, source: name } : { description: name, amount, paidBy: { [ME]: amount }, owed: { [ME]: amount }, category, groupId: null, method: null };
    const rec = ledger.addRecurring({ kind, freq: 'once', day: null, start, payload, label: name });
    rec.origin = 'import';
    rep.recurring.push({ label: name, amount, freq: 'once', next: date, kind });
  }
  detectRecurring(ledger, rep);

  s.imports.push({ at: new Date().toISOString(), account, from: rep.from, to: rep.to, added: rep.added, duplicates: rep.duplicates });
  if (s.imports.length > 100) s.imports.shift();
  return rep;
}

function payeeRule(s, t) {
  if (!s.payees) return null;
  const k = merchantKey(t.description);
  if (s.payees[k]) return s.payees[k];
  for (const [key, rule] of Object.entries(s.payees)) if (key && k.startsWith(key)) return rule;
  return null;
}

/**
 * "mode: replace" — the file is the new complete baseline. Remove everything
 * earlier imports created (entries, schedules and the estimates they posted,
 * accounts, imported rules); keep what you typed in chat and what was learned.
 */
function resetImported(ledger) {
  const s = ledger.state;
  const dropRec = new Set(s.recurring.filter((r) => r.origin !== 'chat').map((r) => r.id));
  const before = s.expenses.length + s.income.length + s.transfers.length;
  const keep = (x) => x.origin !== 'import' && !(x.recurringId && dropRec.has(x.recurringId));
  s.expenses = s.expenses.filter(keep);
  s.income = s.income.filter(keep);
  s.transfers = s.transfers.filter(keep);
  s.recurring = s.recurring.filter((r) => !dropRec.has(r.id));
  s.accounts = [];
  s.cash = null;
  s.imports = [];
  s.openQuestions = [];
  const co = s.brain.copilot;
  if (co) co.lessons = co.lessons.filter((l) => l.from !== 'import');
  return { entries: before - (s.expenses.length + s.income.length + s.transfers.length), schedules: dropRec.size };
}

function parseSigned(v) {
  const neg = /^\s*-/.test(v);
  const c = parseAmount(String(v).replace(/^\s*-/, ''));
  return c == null ? null : neg ? -c : c;
}

function ensurePerson(ledger, name, rep) {
  const found = ledger.findPerson(name.trim());
  if (found) return found.id;
  const id = ledger.addPerson(name.trim());
  rep.people.push(ledger.name(id));
  return id;
}

/** Replace a scheduled estimate with the real statement row. */
function reconcile(ledger, kind, t, extra) {
  const list = kind === 'income' ? ledger.state.income : ledger.state.expenses;
  const cents = Math.abs(t.amount);
  const mk = merchantKey(t.description);
  const hit = list.find((x) => {
    if (!x.recurringId || x.reconciled) return false;
    const days = Math.abs((fromISO(x.date) - fromISO(t.date)) / 864e5);
    const once = ledger.state.recurring.find((r) => r.id === x.recurringId)?.freq === 'once';
    if (days > (once ? 21 : 6)) return false; // an expected one-off can land weeks off its date
    if (Math.abs(x.amount - cents) > Math.max(100, 0.2 * x.amount)) return false;
    const label = kind === 'income' ? x.source : x.description;
    const lk = merchantKey(label);
    return lk && mk && (lk.split(' ')[0] === mk.split(' ')[0] || mk.includes(lk) || lk.includes(mk));
  });
  if (!hit) return false;
  if (kind === 'expense' && cents !== hit.amount) {
    const ids = Object.keys(hit.owed);
    const scaled = ledger.shares(cents, ids, { type: 'shares', values: hit.owed });
    hit.owed = scaled;
    hit.paidBy = Object.fromEntries(Object.keys(hit.paidBy).map((k) => [k, cents]));
  }
  hit.amount = cents;
  hit.date = t.date;
  hit.reconciled = true;
  Object.assign(hit, extra);
  return true;
}

function addListedRecurring(ledger, brain, r, rep) {
  const name = pick(r, 'name', 'description');
  const amount = parseAmount(pick(r, 'amount'));
  if (!name || !amount) return;
  const existing = ledger.state.recurring.find((x) => x.active && norm(x.label) === norm(name));
  if (existing) {
    // A newer statement can change a bill's amount; keep the schedule, update the amount.
    existing.payload.amount = amount;
    if (existing.kind === 'expense') {
      const ids = Object.keys(existing.payload.owed);
      existing.payload.owed = ids.length === 1 ? { [ids[0]]: amount } : ledger.shares(amount, ids, { type: 'shares', values: existing.payload.owed });
      existing.payload.paidBy = { [Object.keys(existing.payload.paidBy)[0]]: amount };
    }
    return;
  }
  const freqWord = pick(r, 'frequency', 'every').toLowerCase();
  const freq = /week/.test(freqWord) ? (/bi|two|2/.test(freqWord) ? 'biweek' : 'week') : /year|annual/.test(freqWord) ? 'year' : 'month';
  const kind = /income/.test(pick(r, 'kind', 'type').toLowerCase()) ? 'income' : 'expense';
  const day = Number(pick(r, 'day')) || null;
  const next = toISODate(pick(r, 'next', 'next date')) || nextDate(ledger.today(), freq, day);
  const category = mapCategory(pick(r, 'category')) || brain.predictCategory(name).category;
  const payload = kind === 'income' ? { amount, source: name } : { description: name, amount, paidBy: { [ME]: amount }, owed: { [ME]: amount }, category, groupId: null, method: null };
  const rec = ledger.addRecurring({ kind, freq, day: freq === 'month' ? day || Number(next.slice(8)) : null, start: next, payload, label: name });
  rec.origin = 'import';
  // Past rows of this bill belong to it: they are fixed costs, not everyday
  // spending, and must not be counted again by the everyday-spending average.
  const key = merchantKey(name);
  const list = kind === 'income' ? ledger.state.income : ledger.state.expenses;
  for (const x of list) {
    const label = kind === 'income' ? x.source : x.description;
    if (x.recurringId || x.date >= next || merchantKey(label) !== key) continue;
    if (Math.abs(x.amount - amount) > Math.max(200, 0.2 * amount)) continue;
    x.recurringId = rec.id;
    x.reconciled = true;
  }
  rep.recurring.push({ label: name, amount, freq, next, kind });
}

function nextDate(today, freq, day) {
  if (freq === 'month' && day) {
    let d = `${today.slice(0, 8)}${String(Math.min(day, 28)).padStart(2, '0')}`;
    if (d <= today) d = advance({ freq: 'month', day }, d);
    return d;
  }
  return advance({ freq }, today);
}

/**
 * Find charges and deposits that repeat on a steady rhythm with a steady
 * amount and schedule them. Only patterns still alive at the end of the
 * imported data are scheduled, so a cancelled subscription is not projected.
 */
function detectRecurring(ledger, rep) {
  const s = ledger.state;
  const end = rep.to || ledger.today();
  const groups = new Map();
  for (const [kind, list] of [['expense', s.expenses], ['income', s.income]])
    for (const x of list) {
      if (x.origin !== 'import' || x.recurringId) continue;
      if (kind === 'expense' && Object.keys(x.owed).length > 1) continue;
      const k = `${kind}|${merchantKey(kind === 'income' ? x.source : x.description)}`;
      if (!k.split('|')[1]) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(x);
    }
  for (const [k, xs] of groups) {
    if (xs.length < 3) continue;
    const kind = k.split('|')[0];
    xs.sort((a, b) => (a.date < b.date ? -1 : 1));
    const gaps = xs.slice(1).map((x, i) => (fromISO(x.date) - fromISO(xs[i].date)) / 864e5);
    const gap = median(gaps);
    const freq = gap >= 26 && gap <= 35 ? 'month' : gap >= 6 && gap <= 8 ? 'week' : gap >= 13 && gap <= 16 ? 'biweek' : null;
    if (!freq) continue;
    if (gaps.some((g) => Math.abs(g - gap) > (freq === 'month' ? 6 : 3))) continue;
    const amounts = xs.map((x) => x.amount);
    const amt = median(amounts);
    if (amounts.some((a) => Math.abs(a - amt) > Math.max(200, 0.15 * amt))) continue;
    const lastX = xs.at(-1);
    if ((fromISO(end) - fromISO(lastX.date)) / 864e5 > gap * 1.5) continue; // stopped
    const label = kind === 'income' ? lastX.source : lastX.description;
    if (s.recurring.some((r) => r.active && merchantKey(r.label) === merchantKey(label))) continue;
    const day = freq === 'month' ? Number(lastX.date.slice(8)) : null;
    const next = advance({ freq, day }, lastX.date);
    const payload = kind === 'income' ? { amount: amt, source: label } : { description: label, amount: amt, paidBy: { [ME]: amt }, owed: { [ME]: amt }, category: lastX.category, groupId: null, method: lastX.method };
    const r = ledger.addRecurring({ kind, freq, day, start: next, payload, label });
    r.origin = 'import';
    for (const x of xs) x.recurringId = r.id, (x.reconciled = true);
    rep.recurring.push({ label, amount: amt, freq, next, kind, detected: true });
  }
}

const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  return a.length ? a[Math.floor((a.length - 1) / 2)] : 0;
};

export const _test = { cleanMerchant, normalizeTxn, toISODate, addDays };

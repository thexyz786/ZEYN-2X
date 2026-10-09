import { allocate, sumValues } from './money.js';
import { addDays, addMonths, localToday } from './dates.js';

const UNDO_DEPTH = 25;
export const ME = 'me';

/**
 * The domain core: people, groups, expenses, transfers, income, and every
 * balance derived from them. It knows nothing about language; the parser and
 * assistant translate text into calls on this class.
 *
 * Sign convention for balances: positive = that person is OWED money.
 */
export class Ledger {
  constructor(store, { now = () => new Date() } = {}) {
    this.store = store;
    this.now = now;
    this.state = store.load();
    this.undoStack = store.loadUndo();
  }

  today() {
    return localToday(this.now());
  }
  get currency() {
    return this.state.currency;
  }
  nextId(prefix) {
    this.state.seq += 1;
    return `${prefix}${this.state.seq}`;
  }

  // ── transactions & undo ────────────────────────────────────────────────
  /** Run `fn` as one undoable unit. Throws roll the state back untouched. */
  transact(label, fn) {
    const snapshot = JSON.stringify(this.state);
    try {
      const result = fn();
      this.undoStack.push({ label, at: new Date().toISOString(), snapshot });
      if (this.undoStack.length > UNDO_DEPTH) this.undoStack.shift();
      this.persist();
      return result;
    } catch (err) {
      this.state = JSON.parse(snapshot);
      throw err;
    }
  }
  undo() {
    const last = this.undoStack.pop();
    if (!last) return null;
    // The brain survives an undo: what was learned about language is kept,
    // only the money is rolled back.
    const brain = this.state.brain;
    this.state = JSON.parse(last.snapshot);
    this.state.brain = brain;
    this.state.brain.stats.undos += 1;
    this.persist();
    return last.label;
  }
  persist() {
    this.store.save(this.state);
    this.store.saveUndo(this.undoStack);
  }

  // ── people & groups ────────────────────────────────────────────────────
  people() {
    return Object.values(this.state.people);
  }
  name(id) {
    return id === ME ? 'You' : this.state.people[id]?.name ?? id;
  }
  /** Resolve a name or alias to a person id. Exact first, then 1-edit fuzzy. */
  findPerson(raw, { fuzzy = true } = {}) {
    const q = norm(raw);
    if (!q) return null;
    if (['me', 'i', 'myself', 'you', 'mine', 'my'].includes(q)) return { id: ME, exact: true };
    for (const p of this.people()) {
      if (p.id === ME) continue;
      if (norm(p.name) === q || p.aliases.some((a) => norm(a) === q)) return { id: p.id, exact: true };
    }
    if (!fuzzy || q.length < 4) return null;
    const close = this.people().filter(
      (p) => p.id !== ME && [p.name, ...p.aliases].some((n) => editDistance(norm(n), q) <= 1),
    );
    return close.length === 1 ? { id: close[0].id, exact: false } : null;
  }
  addPerson(name) {
    const clean = titleCase(name.trim());
    const existing = this.findPerson(clean, { fuzzy: false });
    if (existing) return existing.id;
    const id = this.nextId('p');
    this.state.people[id] = { id, name: clean, aliases: [] };
    return id;
  }
  addAlias(personId, alias) {
    const p = this.state.people[personId];
    if (p && !p.aliases.some((a) => norm(a) === norm(alias)) && norm(p.name) !== norm(alias)) p.aliases.push(alias.trim());
  }
  findGroup(raw) {
    const q = norm(raw).replace(/^the\s+/, '').replace(/\s+group$/, '');
    return Object.values(this.state.groups).find((g) => norm(g.name) === q) ?? null;
  }
  addGroup(name, memberIds = []) {
    const existing = this.findGroup(name);
    if (existing) {
      for (const m of memberIds) if (!existing.members.includes(m)) existing.members.push(m);
      return existing;
    }
    const id = this.nextId('g');
    const members = [ME, ...memberIds.filter((m) => m !== ME)];
    this.state.groups[id] = { id, name: name.trim(), members };
    return this.state.groups[id];
  }

  // ── entries ────────────────────────────────────────────────────────────
  /**
   * paidBy / owed are { personId: cents }. Both must sum to `amount` — the
   * invariant that keeps every balance in the system summing to zero.
   */
  addExpense({ description, amount, paidBy, owed, date, category = 'general', groupId = null, method = null, recurringId = null }) {
    if (!(amount > 0)) throw new Error('Amount must be greater than zero');
    if (sumValues(paidBy) !== amount) throw new Error('Payers must add up to the total');
    if (sumValues(owed) !== amount) throw new Error('Shares must add up to the total');
    const e = {
      id: this.nextId('e'),
      date: date || this.today(),
      description: description || 'Expense',
      category,
      amount,
      paidBy,
      owed,
      groupId,
      method,
      recurringId,
      createdAt: this.now().toISOString(),
    };
    this.state.expenses.push(e);
    return e;
  }
  addTransfer({ from, to, amount, date, groupId = null, note = null }) {
    if (!(amount > 0)) throw new Error('Amount must be greater than zero');
    if (from === to) throw new Error('A payment needs two different people');
    const t = { id: this.nextId('t'), date: date || this.today(), from, to, amount, groupId, note, createdAt: this.now().toISOString() };
    this.state.transfers.push(t);
    return t;
  }
  addIncome({ amount, source = 'Income', date, recurringId = null }) {
    if (!(amount > 0)) throw new Error('Amount must be greater than zero');
    const i = { id: this.nextId('i'), date: date || this.today(), amount, source, recurringId, createdAt: this.now().toISOString() };
    this.state.income.push(i);
    return i;
  }
  deleteEntry(id) {
    for (const key of ['expenses', 'transfers', 'income']) {
      const idx = this.state[key].findIndex((x) => x.id === id);
      if (idx >= 0) return this.state[key].splice(idx, 1)[0];
    }
    return null;
  }
  lastEntry() {
    const all = [...this.state.expenses, ...this.state.transfers, ...this.state.income];
    return all.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
  }

  /** Build an expense's share map from a split specification. */
  shares(amount, participants, split = { type: 'equal' }) {
    const ids = [...new Set(participants)];
    if (!ids.length) throw new Error('Nobody to split with');
    let parts;
    if (split.type === 'equal') parts = allocate(amount, ids.map(() => 1));
    else if (split.type === 'exact') {
      parts = ids.map((id) => split.values[id] ?? 0);
      const total = parts.reduce((a, b) => a + b, 0);
      if (total !== amount) throw new Error(`Exact shares add up to ${total / 100}, not ${amount / 100}`);
    } else if (split.type === 'percent') {
      const pct = ids.map((id) => split.values[id] ?? 0);
      const total = pct.reduce((a, b) => a + b, 0);
      if (Math.abs(total - 100) > 0.01) throw new Error(`Percentages add up to ${total}%, not 100%`);
      parts = allocate(amount, pct);
    } else if (split.type === 'shares') parts = allocate(amount, ids.map((id) => split.values[id] ?? 0));
    else throw new Error(`Unknown split type ${split.type}`);
    return Object.fromEntries(ids.map((id, i) => [id, parts[i]]).filter(([, v]) => v > 0));
  }

  // ── balances ───────────────────────────────────────────────────────────
  /** Net position per person (positive = owed money). Optionally one group. */
  netBalances({ groupId } = {}) {
    const net = {};
    const add = (id, v) => (net[id] = (net[id] || 0) + v);
    for (const e of this.state.expenses) {
      if (groupId !== undefined && e.groupId !== groupId) continue;
      for (const [id, v] of Object.entries(e.paidBy)) add(id, v);
      for (const [id, v] of Object.entries(e.owed)) add(id, -v);
    }
    for (const t of this.state.transfers) {
      if (groupId !== undefined && t.groupId !== groupId) continue;
      add(t.from, t.amount);
      add(t.to, -t.amount);
    }
    return net;
  }

  /**
   * Pairwise debts: debt[a][b] = what a owes b, after netting. Each person's
   * share of an expense is owed to the payers in proportion to what they paid.
   */
  pairwise() {
    const raw = {};
    const add = (a, b, v) => {
      if (a === b || !v) return;
      raw[a] ??= {};
      raw[a][b] = (raw[a][b] || 0) + v;
    };
    for (const e of this.state.expenses) {
      const payers = Object.entries(e.paidBy);
      for (const [debtor, share] of Object.entries(e.owed)) {
        const parts = allocate(share, payers.map(([, p]) => p));
        payers.forEach(([payer], i) => add(debtor, payer, parts[i]));
      }
    }
    // A transfer from→to means `from` gave money, so `to` now owes `from` it.
    for (const t of this.state.transfers) add(t.to, t.from, t.amount);
    const debt = {};
    const ids = new Set([...Object.keys(raw), ...Object.values(raw).flatMap(Object.keys)]);
    for (const a of ids)
      for (const b of ids) {
        if (a >= b) continue;
        const ab = (raw[a]?.[b] || 0) - (raw[b]?.[a] || 0);
        if (ab > 0) (debt[a] ??= {})[b] = ab;
        if (ab < 0) (debt[b] ??= {})[a] = -ab;
      }
    return debt;
  }

  /** Your balance with one friend: positive = they owe you. */
  balanceWith(id) {
    const d = this.pairwise();
    return (d[id]?.[ME] || 0) - (d[ME]?.[id] || 0);
  }
  friendBalances() {
    const d = this.pairwise();
    return this.people()
      .filter((p) => p.id !== ME)
      .map((p) => ({ id: p.id, name: p.name, amount: (d[p.id]?.[ME] || 0) - (d[ME]?.[p.id] || 0) }));
  }

  /**
   * Minimum-transfer settlement plan: repeatedly match the largest creditor
   * with the largest debtor. Produces at most n-1 payments.
   */
  simplify(net) {
    const cred = [], debt = [];
    for (const [id, v] of Object.entries(net)) {
      if (v > 0) cred.push({ id, v });
      if (v < 0) debt.push({ id, v: -v });
    }
    const plan = [];
    while (cred.length && debt.length) {
      cred.sort((a, b) => b.v - a.v);
      debt.sort((a, b) => b.v - a.v);
      const c = cred[0], d = debt[0];
      const x = Math.min(c.v, d.v);
      plan.push({ from: d.id, to: c.id, amount: x });
      c.v -= x;
      d.v -= x;
      if (!c.v) cred.shift();
      if (!d.v) debt.shift();
    }
    return plan;
  }

  // ── personal finance views ─────────────────────────────────────────────
  /** Your true consumption: your share of every expense, by category. */
  mySpending(from, to, { excludeRecurring = false } = {}) {
    const byCategory = {};
    let total = 0;
    for (const e of this.state.expenses) {
      if (e.date < from || e.date > to) continue;
      if (excludeRecurring && e.recurringId) continue;
      const mine = e.owed[ME] || 0;
      if (!mine) continue;
      byCategory[e.category] = (byCategory[e.category] || 0) + mine;
      total += mine;
    }
    return { total, byCategory };
  }
  myIncome(from, to) {
    return this.state.income.filter((i) => i.date >= from && i.date <= to).reduce((a, i) => a + i.amount, 0);
  }

  /** Cash anchor rolled forward by every movement of your own money since. */
  estimatedCash() {
    const c = this.state.cash;
    if (!c) return null;
    let cash = c.amount;
    for (const e of this.state.expenses) if (e.date > c.date) cash -= e.paidBy[ME] || 0;
    for (const i of this.state.income) if (i.date > c.date) cash += i.amount;
    for (const t of this.state.transfers) {
      if (t.date <= c.date) continue;
      if (t.from === ME) cash -= t.amount;
      if (t.to === ME) cash += t.amount;
    }
    return cash;
  }

  // ── recurring ──────────────────────────────────────────────────────────
  addRecurring({ kind, freq, day = null, start, payload, label }) {
    const r = { id: this.nextId('r'), kind, freq, day, next: start, payload, label, active: true, createdAt: this.now().toISOString() };
    this.state.recurring.push(r);
    return r;
  }
  /** Post every recurring occurrence that has come due. Returns entries made. */
  materializeRecurring() {
    const today = this.today();
    const made = [];
    for (const r of this.state.recurring) {
      let guard = 0;
      while (r.active && r.next <= today && guard++ < 400) {
        made.push(this.postRecurring(r, r.next));
        r.next = advance(r, r.next);
      }
    }
    return made;
  }
  postRecurring(r, date) {
    const p = r.payload;
    if (r.kind === 'income') return this.addIncome({ amount: p.amount, source: p.source, date, recurringId: r.id });
    return this.addExpense({ ...p, date, recurringId: r.id });
  }
  /** Every date a recurring item falls on within [from, to]. */
  occurrences(r, from, to) {
    const out = [];
    let d = r.next;
    let guard = 0;
    while (d <= to && guard++ < 1000) {
      if (d >= from) out.push(d);
      d = advance(r, d);
    }
    return out;
  }
}

export function advance(r, date) {
  if (r.freq === 'week') return addDays(date, 7);
  if (r.freq === 'biweek') return addDays(date, 14);
  if (r.freq === 'year') return addMonths(date, 12, r.day);
  return addMonths(date, 1, r.day);
}

export const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
export const titleCase = (s) => s.replace(/\b([a-z])/g, (c) => c.toUpperCase());

export function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 99;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

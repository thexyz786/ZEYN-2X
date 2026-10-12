// Forward-looking finance: budgets, goals, cash-flow forecasts, affordability.
//
// The forecast is deliberately simple and explainable:
//   income     = scheduled recurring income
//   fixed      = your share of scheduled recurring expenses
//   variable   = your recent average non-recurring spend × a learned bias factor
//   goals      = what each goal needs per month to land on its deadline
// The bias factor is the self-correcting part: each month the prediction made
// for it is compared with what you actually spent, and the factor moves toward
// the observed ratio. A forecast that keeps undershooting learns to stop.

import { ME } from './ledger.js';
import {
  addDays, addMonths, daysInMonth, monthEnd, monthKey, monthLabel, monthStart, monthsBetween,
} from './dates.js';

const LEARN_RATE = 0.35;

export class Planner {
  constructor(ledger) {
    this.l = ledger;
  }
  get s() {
    return this.l.state;
  }

  // ── baselines ─────────────────────────────────────────────────────────
  dataStart() {
    const dates = [...this.s.expenses, ...this.s.income].map((x) => x.date).sort();
    return dates[0] ?? null;
  }
  /**
   * The last day the history is known to be complete. After an import that
   * is the newest statement's end date: days after it have spending the
   * ledger hasn't seen yet. Without imports, everything typed in is the
   * record, so it is today.
   */
  dataEnd() {
    const today = this.l.today();
    const last = this.s.imports.map((x) => x.to).filter(Boolean).sort().at(-1);
    return last && last < today ? last : today;
  }

  /**
   * Usual monthly everyday (non-recurring) spending, your share. Each of the
   * last few months is scaled up by how many of its days the history covers
   * (Sep 1–18 of data counts as 18/30 of September). Lumpy one-offs — far
   * above the typical purchase — are counted once rather than scaled, so a
   * single big purchase doesn't become a monthly habit.
   */
  variableBaseline() {
    const today = this.l.today();
    const start = this.dataStart();
    if (!start) return { amount: this.budgetTotal(), basis: this.budgetTotal() ? 'your budgets' : 'no data yet' };
    const end = this.dataEnd();
    const samples = [];
    for (let i = 0; i <= 6 && samples.length < 3; i++) {
      const first = monthStart(addMonths(monthStart(today), -i));
      const from = first > start ? first : start;
      const to = monthEnd(first) < end ? monthEnd(first) : end;
      if (to < from) continue;
      const covered = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
      if (covered < 7) continue;
      const shares = this.s.expenses
        .filter((e) => e.date >= from && e.date <= to && !e.recurringId && e.owed[ME])
        .map((e) => e.owed[ME])
        .sort((x, y) => x - y);
      const total = shares.reduce((x, y) => x + y, 0);
      const median = shares[Math.floor(shares.length / 2)] || 0;
      const lumpy = shares.filter((v) => shares.length >= 3 && v > 4 * median).reduce((x, y) => x + y, 0);
      const [y, m] = first.split('-').map(Number);
      const dim = daysInMonth(y, m);
      samples.push({ est: ((total - lumpy) * dim) / covered + lumpy, covered, full: covered >= dim });
    }
    if (samples.length) {
      const days = samples.reduce((x, s) => x + s.covered, 0);
      const amount = Math.round(samples.reduce((x, s) => x + s.est * s.covered, 0) / days);
      const basis = samples.every((s) => s.full) ? `your last ${samples.length} month${samples.length > 1 ? 's' : ''}` : `${days} days of history`;
      return { amount, basis };
    }
    const b = this.budgetTotal();
    const soFar = this.l.mySpending(monthStart(today), today, { excludeRecurring: true }).total;
    return { amount: Math.max(b, soFar), basis: b ? 'your budgets' : 'too little data yet' };
  }

  /**
   * Cash today. The balance from the last statement, rolled forward by every
   * entry since, less an estimate of everyday spending on days no statement
   * covers yet (minus anything you logged for those days). The estimate goes
   * away when the next statement is imported.
   */
  cashToday() {
    const c = this.l.estimatedCash();
    if (c == null) return { cash: null, gap: 0, since: null };
    const today = this.l.today();
    const covered = this.s.cash.date > this.dataEnd() ? this.s.cash.date : this.dataEnd();
    const since = addDays(covered, 1);
    if (since > today) return { cash: c, gap: 0, since: null };
    const days = Math.round((Date.parse(today) - Date.parse(since)) / 864e5) + 1;
    const daily = (this.variableBaseline().amount * this.s.brain.calibration.factor) / 30.44;
    const logged = this.l.mySpending(since, today, { excludeRecurring: true }).total;
    const gap = Math.max(0, Math.round(daily * days - logged));
    return { cash: c - gap, gap, since };
  }

  budgetTotal() {
    const recurringCats = new Set(this.s.recurring.filter((r) => r.active && r.kind === 'expense').map((r) => r.payload.category));
    return Object.entries(this.s.budgets).filter(([c]) => !recurringCats.has(c)).reduce((a, [, v]) => a + v, 0);
  }

  // ── calibration (learning from forecast error) ─────────────────────────
  calibrate() {
    const cal = this.s.brain.calibration;
    const thisMonth = monthKey(this.l.today());
    for (const h of cal.history) {
      if (h.actual != null || h.month >= thisMonth) continue;
      const first = `${h.month}-01`;
      h.actual = this.l.mySpending(first, monthEnd(first), { excludeRecurring: true }).total;
      if (h.predicted > 0 && h.actual > 0) {
        const ratio = Math.min(2, Math.max(0.5, h.actual / h.predicted));
        cal.factor = +(cal.factor * (1 - LEARN_RATE) + cal.factor * ratio * LEARN_RATE).toFixed(4);
        h.error = +((h.actual - h.predicted) / h.predicted).toFixed(3);
      }
    }
    return cal;
  }
  recordPrediction(month, predicted) {
    const cal = this.s.brain.calibration;
    if (predicted > 0 && !cal.history.some((h) => h.month === month)) {
      cal.history.push({ month, predicted, actual: null });
      if (cal.history.length > 36) cal.history.shift();
    }
  }

  // ── recurring projections ─────────────────────────────────────────────
  scheduled(from, to) {
    let income = 0, fixed = 0, outflow = 0;
    for (const r of this.s.recurring) {
      if (!r.active) continue;
      const n = this.l.occurrences(r, from, to).length;
      if (!n) continue;
      if (r.kind === 'income') income += n * r.payload.amount;
      else {
        fixed += n * (r.payload.owed[ME] || 0);
        outflow += n * (r.payload.paidBy[ME] || 0);
      }
    }
    return { income, fixed, outflow };
  }

  // ── goals ─────────────────────────────────────────────────────────────
  goalNeeds() {
    const today = this.l.today();
    return this.s.goals.map((g) => {
      const remaining = Math.max(0, g.target - g.saved);
      // Contributions are planned for every month from this one through the deadline month.
      const monthsLeft = g.deadline ? Math.max(1, monthsBetween(today, g.deadline) + 1) : null;
      const perMonth = remaining && monthsLeft ? Math.ceil(remaining / monthsLeft) : 0;
      return { ...g, remaining, monthsLeft, perMonth, pct: g.target ? Math.min(100, Math.round((100 * g.saved) / g.target)) : 0 };
    });
  }

  // ── forecast ──────────────────────────────────────────────────────────
  forecast(months = 6) {
    const today = this.l.today();
    const cal = this.calibrate();
    const base = this.variableBaseline();
    const variablePerMonth = Math.round(base.amount * cal.factor);
    const goals = this.goalNeeds();
    const ct = this.cashToday();
    const cashNow = ct.cash;
    let cash = cashNow ?? 0;
    let reserved = goals.reduce((a, g) => a + g.saved, 0);
    const rows = [];
    for (let i = 0; i < months; i++) {
      const first = monthStart(addMonths(monthStart(today), i));
      const last = monthEnd(first);
      const from = i === 0 ? addDays(today, 1) : first;
      const sched = this.scheduled(from, last);
      let variable = variablePerMonth;
      let actualSoFar = null;
      if (i === 0) {
        const [y, m] = today.split('-').map(Number);
        const remainingFrac = (daysInMonth(y, m) - Number(today.slice(8))) / daysInMonth(y, m);
        variable = Math.round(variablePerMonth * remainingFrac);
        actualSoFar = {
          income: this.l.myIncome(first, today),
          spend: this.l.mySpending(first, today).total,
        };
      } else if (i === 1) this.recordPrediction(monthKey(first), variablePerMonth);
      const goalContrib = goals.reduce((a, g) => a + (g.deadline && g.deadline >= first && g.remaining ? g.perMonth : 0), 0);
      const net = sched.income - sched.fixed - variable;
      cash += net;
      reserved += goalContrib;
      rows.push({
        month: monthKey(first),
        label: monthLabel(monthKey(first)),
        income: sched.income + (actualSoFar?.income ?? 0),
        fixed: sched.fixed,
        variable: variable + (actualSoFar?.spend ?? 0),
        projectedOnly: { income: sched.income, spend: sched.fixed + variable },
        goals: goalContrib,
        net: sched.income + (actualSoFar?.income ?? 0) - sched.fixed - variable - (actualSoFar?.spend ?? 0),
        cashEnd: cashNow == null ? null : cash,
        freeCash: cashNow == null ? null : cash - reserved,
        cumulative: cash - (cashNow ?? 0),
      });
    }
    return { rows, cashNow, cashGap: ct.gap, cashGapSince: ct.since, variablePerMonth, basis: base.basis, factor: cal.factor, goals };
  }

  /**
   * "Can I afford X (in month M)?" — measured against what is free that month
   * after bills and goal savings (the same number "what's left" reports):
   *   yes   — it fits beside your usual everyday spending
   *   tight — it fits only if everyday spending that month is cut
   *   no    — it doesn't fit; `fitsBy` names the first month it would
   * With a known balance it must also not push any later month's free cash
   * below zero.
   */
  afford(amount, date) {
    const today = this.l.today();
    const offset = date ? Math.max(0, monthsBetween(today, date)) : 0;
    const lo = this.leftover(offset);
    const spare = lo.free - lo.usual;
    const f = this.forecast(offset + 7);
    const hasCash = f.cashNow != null;
    const later = hasCash ? f.rows.slice(offset + 1) : [];
    const lowRow = later.reduce((lowest, r) => (!lowest || r.freeCash < lowest.freeCash ? r : lowest), null);
    const laterOk = !lowRow || lowRow.freeCash - amount >= 0;
    let verdict = spare - amount >= 0 && laterOk ? 'yes' : lo.free - amount >= 0 && laterOk ? 'tight' : 'no';
    let fitsBy = null;
    if (verdict !== 'yes')
      for (let k = offset + 1; k <= offset + 6; k++) {
        const x = this.leftover(k);
        if (x.free - x.usual - amount >= 0) {
          fitsBy = x.label;
          break;
        }
      }
    return { verdict, amount, month: lo.label, current: lo.current, free: lo.free, usual: lo.usual, spare, after: spare - amount, fitsBy, hasCash, laterOk, lowMonth: lowRow?.label ?? null };
  }

  /**
   * What's left to spend in a month (0 = this month, 1 = next…), after
   * bills and goal savings. Two views:
   *   flow — that month's income − bills − goal savings − what's already spent
   *   cash — cash you'll actually hold, when a balance is known: today's cash
   *          (or the forecast's cash at the month's start) + income − bills −
   *          goal savings due by the month's end
   * `usual` is your normal everyday spend for that span, so the answer can say
   * whether the month closes with money to spare.
   */
  leftover(offset = 0, category = null) {
    const today = this.l.today();
    const first = monthStart(addMonths(monthStart(today), offset));
    const last = monthEnd(first);
    const current = offset === 0;
    const [y, m] = first.split('-').map(Number);
    const dim = daysInMonth(y, m);
    const daysLeft = current ? dim - Number(today.slice(8)) + 1 : dim;
    const sched = this.scheduled(current ? addDays(today, 1) : first, last);
    const spentAll = current ? this.l.mySpending(first, today) : { total: 0, byCategory: {} };
    const spentVar = current ? this.l.mySpending(first, today, { excludeRecurring: true }).total : 0;
    const income = (current ? this.l.myIncome(first, today) : 0) + sched.income;
    const bills = spentAll.total - spentVar + sched.fixed;
    const goals = this.goalNeeds().reduce((a, g) => a + (g.deadline && g.deadline >= first && g.remaining ? g.perMonth : 0), 0);
    const f = this.forecast(offset + 1);
    const usualMonth = f.variablePerMonth;
    const usual = current ? Math.round((usualMonth * daysLeft) / dim) : usualMonth;
    const flow = income - bills - goals - spentVar;

    // Cash view: what you hold at the month's start, less money already set
    // aside for goals, plus expected income, less bills and this month's goal
    // saving. Equals the forecast's free cash for the month before everyday
    // spending, so this answer and the forecast always agree.
    let cash = null, start = null, reservedBefore = null;
    if (f.cashNow != null) {
      start = current ? f.cashNow : f.rows[offset - 1].cashEnd;
      reservedBefore = this.s.goals.reduce((a, g) => a + g.saved, 0) + f.rows.slice(0, offset).reduce((a, r) => a + r.goals, 0);
      cash = start - reservedBefore + sched.income - sched.fixed - goals;
    }
    const free = cash ?? flow;
    // A typical full month's outgoings, for "how long would this last".
    const nm = monthStart(addMonths(first, 1));
    const burn = usualMonth + this.scheduled(nm, monthEnd(nm)).fixed;
    const out = {
      label: monthLabel(monthKey(first)), current, income, bills, goals, spent: spentVar, flow, cash, free,
      incomeAhead: sched.income, billsAhead: sched.fixed, start, reservedBefore, cashGap: f.cashGap, cashGapSince: f.cashGapSince, dataEnd: this.dataEnd(),
      perDay: Math.floor(free / Math.max(1, daysLeft)), daysLeft, usual, usualMonth,
      afterUsual: free - usual,
      runwayMonths: cash != null && burn > 0 ? Math.max(0, cash) / burn : null,
    };
    if (category) {
      const budget = this.s.budgets[category] ?? null;
      const used = current ? spentAll.byCategory[category] || 0 : 0;
      out.category = { name: category, budget, used, left: budget != null ? budget - used : null };
    }
    return out;
  }

  budgetStatus() {
    const today = this.l.today();
    const [y, m] = today.split('-').map(Number);
    const frac = Number(today.slice(8)) / daysInMonth(y, m);
    const spent = this.l.mySpending(monthStart(today), today).byCategory;
    return Object.entries(this.s.budgets).map(([category, budget]) => {
      const used = spent[category] || 0;
      const projected = frac > 0 ? Math.round(used / frac) : used;
      return { category, budget, used, left: budget - used, pct: budget ? Math.round((100 * used) / budget) : 0, projected, onPace: projected <= budget };
    });
  }

  /** Plain-language observations, most important first. */
  insights() {
    const today = this.l.today();
    const first = monthStart(today);
    const prevFirst = monthStart(addMonths(first, -1));
    const sameDayPrev = addMonths(today, -1);
    const out = [];
    // Month-to-date comparisons only mean something when the history reaches
    // today; otherwise the missing days read as a spending drop.
    const end = this.dataEnd();
    const upToDate = end >= addDays(today, -3);
    if (!upToDate) out.push({ level: 'info', text: `Your latest statement ends ${end}; anything after that is estimated until you import the next one.` });
    const now = this.l.mySpending(first, today);
    const prevPace = this.l.mySpending(prevFirst, sameDayPrev).total;
    if (upToDate && prevPace > 0) {
      const d = (now.total - prevPace) / prevPace;
      if (Math.abs(d) >= 0.1) out.push({ level: d > 0 ? 'warn' : 'good', text: `Spending is ${Math.abs(Math.round(d * 100))}% ${d > 0 ? 'higher' : 'lower'} than at this point last month.` });
    }
    for (const b of upToDate ? this.budgetStatus() : []) {
      if (b.used > b.budget) out.push({ level: 'bad', text: `Over the ${b.category} budget by ${this.money(b.used - b.budget)}.` });
      else if (!b.onPace) out.push({ level: 'warn', text: `On pace to spend ${this.money(b.projected)} on ${b.category} against a ${this.money(b.budget)} budget.` });
    }
    const inc = this.l.myIncome(prevFirst, monthEnd(prevFirst));
    const spentPrev = this.l.mySpending(prevFirst, monthEnd(prevFirst)).total;
    if (inc > 0 && end >= monthEnd(prevFirst)) {
      const rate = (inc - spentPrev) / inc;
      out.push({ level: rate >= 0.2 ? 'good' : rate >= 0 ? 'warn' : 'bad', text: `Last month you saved ${Math.round(rate * 100)}% of income${rate < 0.2 ? ' — 20% is a sound floor' : ''}.` });
    }
    const f = this.forecast(6);
    const surplus = Math.round(f.rows.slice(1).reduce((a, r) => a + r.net, 0) / Math.max(1, f.rows.length - 1));
    for (const g of f.goals) {
      if (!g.remaining) continue;
      if (g.perMonth && surplus < g.perMonth)
        out.push({ level: 'warn', text: `"${g.name}" needs ${this.money(g.perMonth)}/month; projected surplus is ${this.money(Math.max(0, surplus))}/month.` });
      else if (g.perMonth) out.push({ level: 'good', text: `"${g.name}" is fundable: ${this.money(g.perMonth)}/month of a projected ${this.money(surplus)} surplus.` });
    }
    const low = f.rows.find((r) => r.cashEnd != null && r.cashEnd < 0);
    if (low) out.push({ level: 'bad', text: `Projected cash goes negative in ${low.label}.` });
    const subs = this.s.recurring.filter((r) => r.active && r.kind === 'expense');
    if (subs.length) {
      const monthly = subs.reduce((a, r) => a + (r.payload.owed[ME] || 0) * (r.freq === 'week' ? 52 / 12 : r.freq === 'biweek' ? 26 / 12 : r.freq === 'year' ? 1 / 12 : 1), 0);
      out.push({ level: 'info', text: `Fixed commitments: ${this.money(Math.round(monthly))}/month across ${subs.length} recurring item${subs.length > 1 ? 's' : ''}.` });
    }
    const owedToMe = this.l.friendBalances().filter((b) => b.amount > 0).reduce((a, b) => a + b.amount, 0);
    if (owedToMe > 0) out.push({ level: 'info', text: `Friends owe you ${this.money(owedToMe)} in total — collecting it is the cheapest money you'll find.` });
    if (this.s.cash == null) out.push({ level: 'info', text: 'Tell me your current balance ("I have 8,000 in the bank") and forecasts will show real cash, not just surplus.' });
    return out;
  }

  money(c) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: this.s.currency }).format(c / 100);
  }
}

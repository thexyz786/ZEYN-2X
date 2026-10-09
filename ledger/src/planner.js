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
  /** Average monthly non-recurring spend (your share) over recent full months. */
  variableBaseline() {
    const today = this.l.today();
    const start = this.dataStart();
    if (!start) return { amount: this.budgetTotal(), basis: this.budgetTotal() ? 'your budgets' : 'no data yet' };
    const months = [];
    for (let i = 1; i <= 3; i++) {
      const first = monthStart(addMonths(monthStart(today), -i));
      if (monthEnd(first) < start) break;
      months.push(this.l.mySpending(first, monthEnd(first), { excludeRecurring: true }).total);
    }
    if (months.length) {
      const avg = Math.round(months.reduce((a, b) => a + b, 0) / months.length);
      return { amount: avg, basis: `your last ${months.length} month${months.length > 1 ? 's' : ''}` };
    }
    // Only the current month exists: extrapolate once there is a week of data.
    const from = start > monthStart(today) ? start : monthStart(today);
    const elapsed = Math.max(1, (Date.parse(today) - Date.parse(from)) / 864e5 + 1);
    const soFar = this.l.mySpending(monthStart(today), today, { excludeRecurring: true }).total;
    if (elapsed >= 7) {
      // Extrapolate everyday spending only. Lumpy one-offs (a deposit, a
      // flight) are counted once — scaling them by 30/7 would invent a
      // spending habit out of a single purchase.
      const shares = this.s.expenses
        .filter((e) => e.date >= monthStart(today) && e.date <= today && !e.recurringId && e.owed[ME])
        .map((e) => e.owed[ME])
        .sort((a, b) => a - b);
      const median = shares[Math.floor(shares.length / 2)] || 0;
      const lumpy = shares.filter((v) => shares.length >= 3 && v > 4 * median).reduce((a, b) => a + b, 0);
      const [y, m] = today.split('-').map(Number);
      const amount = Math.round(((soFar - lumpy) / elapsed) * daysInMonth(y, m) + lumpy);
      return { amount, basis: `${Math.round(elapsed)} days of this month` };
    }
    const b = this.budgetTotal();
    return { amount: Math.max(b, soFar), basis: b ? 'your budgets' : 'too little data yet' };
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
    const cashNow = this.l.estimatedCash();
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
    return { rows, cashNow, variablePerMonth, basis: base.basis, factor: cal.factor, goals };
  }

  /** "Can I afford X (by date)?" — a verdict with the numbers behind it. */
  afford(amount, date) {
    const today = this.l.today();
    const target = date ?? today;
    const monthsAhead = Math.max(0, monthsBetween(today, target));
    const f = this.forecast(monthsAhead + 7);
    const idx = Math.min(monthsAhead, f.rows.length - 1);
    const row = f.rows[idx];
    const monthlyBurn = Math.round(f.rows.slice(1, 4).reduce((a, r) => a + r.projectedOnly.spend, 0) / 3) || f.variablePerMonth;
    const buffer = monthlyBurn; // keep one month of spending in reserve
    const hasCash = f.cashNow != null;
    const available = hasCash ? row.freeCash : row.cumulative - f.rows.slice(0, idx + 1).reduce((a, r) => a + r.goals, 0);
    const after = available - amount;
    // The purchase must also not push any LATER month below zero free cash.
    const laterLow = Math.min(after, ...f.rows.slice(idx + 1).map((r) => (hasCash ? r.freeCash : r.cumulative) - amount));
    let verdict;
    if (after >= buffer && laterLow >= 0) verdict = 'yes';
    else if (after >= 0 && laterLow >= 0) verdict = 'tight';
    else verdict = 'no';
    let fitsBy = null;
    if (verdict !== 'yes') {
      for (let j = idx + 1; j < f.rows.length; j++) {
        const avail = hasCash ? f.rows[j].freeCash : f.rows[j].cumulative;
        if (avail - amount >= buffer) {
          fitsBy = f.rows[j].label;
          break;
        }
      }
    }
    return { verdict, amount, month: row.label, available, after, buffer, laterLow, fitsBy, hasCash, forecast: f };
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
    const now = this.l.mySpending(first, today);
    const prevPace = this.l.mySpending(prevFirst, sameDayPrev).total;
    if (prevPace > 0) {
      const d = (now.total - prevPace) / prevPace;
      if (Math.abs(d) >= 0.1) out.push({ level: d > 0 ? 'warn' : 'good', text: `Spending is ${Math.abs(Math.round(d * 100))}% ${d > 0 ? 'higher' : 'lower'} than at this point last month.` });
    }
    for (const b of this.budgetStatus()) {
      if (b.used > b.budget) out.push({ level: 'bad', text: `Over the ${b.category} budget by ${this.money(b.used - b.budget)}.` });
      else if (!b.onPace) out.push({ level: 'warn', text: `On pace to spend ${this.money(b.projected)} on ${b.category} against a ${this.money(b.budget)} budget.` });
    }
    const inc = this.l.myIncome(prevFirst, monthEnd(prevFirst));
    const spentPrev = this.l.mySpending(prevFirst, monthEnd(prevFirst)).total;
    if (inc > 0) {
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

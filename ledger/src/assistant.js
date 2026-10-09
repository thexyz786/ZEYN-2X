import { Ledger, ME, norm } from './ledger.js';
import { Brain } from './brain.js';
import { Planner } from './planner.js';
import { parse } from './parser.js';
import { translate as aiTranslate, aiEnabled } from './ai.js';
import { fmt } from './money.js';
import { addDays, addMonths, monthEnd, monthStart, monthLabel, monthKey } from './dates.js';

const MUTATING = new Set([
  'expense', 'transfer', 'income', 'recurring', 'settle', 'delete', 'budget', 'goal', 'contribute',
  'cash', 'currency', 'group', 'friends', 'alias', 'teachCategory', 'stopRecurring',
]);

/**
 * The conversational front door. Every message flows:
 *   rules parser → learned templates → AI translator (optional) → miss log
 * and whichever layer understood it, execution is the same deterministic code.
 */
export class Assistant {
  constructor(store, { now, translate = aiTranslate } = {}) {
    this.ledger = new Ledger(store, { now });
    this.brain = new Brain(this.ledger.state);
    this.planner = new Planner(this.ledger);
    this.translate = translate;
  }
  // Ledger.undo() swaps the state object; keep helpers pointed at the live one.
  refresh() {
    this.brain = new Brain(this.ledger.state);
  }
  get s() {
    return this.ledger.state;
  }
  m(c) {
    return fmt(c, this.s.currency);
  }

  // ── entry point ────────────────────────────────────────────────────────
  async handle(text) {
    const input = String(text || '').trim();
    if (!input) return { reply: 'Say something like "I paid 60 for dinner with Ali".', results: [] };
    const posted = this.ledger.materializeRecurring();
    if (posted.length) this.ledger.persist();
    this.s.brain.stats.messages += 1;

    const statements = /^teach\b/i.test(input) ? [input] : input.split(/\s*(?:\n|;)\s*/).filter(Boolean);
    const results = [];
    for (const st of statements) results.push(await this.handleOne(st));
    this.ledger.persist();

    let reply = results.map((r) => r.reply).join('\n\n');
    if (posted.length) reply = `_Posted ${posted.length} scheduled item${posted.length > 1 ? 's' : ''} that came due._\n\n${reply}`;
    return { reply, results };
  }

  async handleOne(text) {
    let intents = null;
    let source = 'template';
    // Learned phrasings go first: they are exact-shape matches the user (or
    // the AI on their behalf) has already confirmed, so they outrank the
    // generic rules that might otherwise half-understand the sentence.
    {
      const t = this.brain.applyTemplates(text);
      if (t) {
        const parsed = t.outputs.map((o) => parse(o, this.ctx()));
        const ok = parsed.every((p) => p && p.type !== 'error');
        this.brain.scoreTemplate(t.template, ok);
        if (ok) intents = parsed;
      }
    }

    let shaky = null;
    this.lastAiError = null;
    if (!intents) {
      const direct = parse(text, this.ctx());
      if (direct?.lowConfidence && this.translate && aiAvailable(this.translate)) shaky = direct;
      else if (direct) {
        intents = [direct];
        source = 'rules';
      }
    }

    if (!intents && this.translate) {
      let tr = null;
      try {
        tr = await this.translate(text, this.aiContext());
        this.lastAiError = null;
      } catch (err) {
        tr = null;
        this.lastAiError = err.message.slice(0, 160);
      }
      if (tr?.clarification && !tr.commands.length) return { source: 'ai', reply: tr.clarification };
      if (tr?.commands?.length) {
        const parsed = tr.commands.map((o) => parse(o, this.ctx()));
        if (parsed.every((p) => p && p.type !== 'error')) {
          intents = parsed;
          source = 'ai';
          const names = this.ledger.people().filter((p) => p.id !== ME).flatMap((p) => [p.name, ...p.aliases]);
          this.brain.learnTemplate(text, tr.commands, names, 'ai', freeTexts(parsed));
          this.brain.forgetMiss(text);
        }
      }
    }

    if (!intents && shaky) {
      intents = [shaky]; // the AI had nothing better; the rules' reading stands
      source = 'rules';
    }
    if (!intents) {
      this.brain.recordMiss(text);
      const aiNote = this.lastAiError ? `\n_(AI fallback failed: ${this.lastAiError})_` : '';
      return { source: 'miss', reply: this.missReply(text) + aiNote };
    }
    if (source === 'rules') this.s.brain.stats.ruleHits += 1;
    if (source === 'template') this.s.brain.stats.templateHits += 1;
    if (source === 'ai') this.s.brain.stats.aiHits += 1;

    const replies = [];
    for (const intent of intents) {
      try {
        const run = () => this.execute(intent, text);
        replies.push(MUTATING.has(intent.type) ? this.ledger.transact(intent.type, run) : run());
      } catch (err) {
        replies.push(`⚠️ ${err.message}`);
      }
    }
    const tag = source === 'template' ? '\n_(understood from a phrasing I learned earlier)_' : source === 'ai' ? '\n_(new phrasing — learned it, next time I’ll handle it instantly)_' : '';
    return { source, intents, reply: replies.join('\n\n') + tag };
  }

  ctx() {
    return {
      today: this.ledger.today(),
      people: this.ledger.people(),
      groups: Object.values(this.s.groups),
      goals: this.s.goals,
      categories: [...new Set([...this.s.expenses.map((e) => e.category), ...Object.keys(this.s.budgets)])],
      findPerson: (w) => this.ledger.findPerson(w),
      predictCategory: (d) => this.brain.predictCategory(d),
    };
  }
  aiContext() {
    return {
      today: this.ledger.today(),
      currency: this.s.currency,
      people: this.ledger.people().filter((p) => p.id !== ME).map((p) => (p.aliases.length ? `${p.name} (aka ${p.aliases.join(', ')})` : p.name)),
      groups: Object.values(this.s.groups).map((g) => g.name),
      goals: this.s.goals.map((g) => g.name),
    };
  }

  // ── execution ──────────────────────────────────────────────────────────
  execute(i, text) {
    const L = this.ledger;
    const created = [];
    const rid = (id) => {
      if (id && id.startsWith('new:')) {
        const name = id.slice(4);
        const existed = L.findPerson(name, { fuzzy: false });
        const pid = L.addPerson(name);
        if (!existed) created.push(L.name(pid));
        return pid;
      }
      return id;
    };
    const fuzzyNote = (list = []) =>
      list.map((f) => {
        L.addAlias(f.id, f.from);
        return `_(read “${f.from}” as ${L.name(f.id)} — I’ll remember that; say “undo” if wrong)_`;
      });
    const withCreated = (s) => (created.length ? `${s}\n_Added ${created.join(', ')} to your people._` : s);

    switch (i.type) {
      case 'help':
        return HELP;
      case 'undo': {
        const label = L.undo();
        this.refresh();
        return label ? `↩️ Undid the last change (${label}).` : 'Nothing to undo.';
      }
      case 'error':
        return `⚠️ ${i.message}`;

      case 'expense': {
        const { paidBy, owed, category } = this.buildExpense(i, rid);
        const e = L.addExpense({ description: i.description, amount: i.amount, paidBy, owed, date: i.date, category, groupId: i.group, method: i.method });
        if (i.group) L.addGroup(this.s.groups[i.group].name, Object.keys(owed));
        return withCreated([this.describeExpense(e), ...fuzzyNote(i.fuzzy)].join('\n'));
      }
      case 'transfer': {
        const t = L.addTransfer({ from: rid(i.from), to: rid(i.to), amount: i.amount, date: i.date, groupId: i.group, note: i.note });
        const verb = t.note === 'Loan' ? 'lent' : 'paid';
        const line = t.note === 'IOU'
          ? `✓ Noted: ${t.to === ME ? 'you owe' : L.name(t.to) + ' owes'} ${t.from === ME ? 'you' : L.name(t.from)} ${this.m(t.amount)}. \`${t.id}\``
          : `✓ ${L.name(t.from)} ${verb} ${t.to === ME ? 'you' : L.name(t.to)} ${this.m(t.amount)}${t.note && t.note !== 'Loan' ? ` (${t.note})` : ''}. \`${t.id}\``;
        const others = [t.from, t.to].filter((x) => x !== ME);
        const bal = others.length === 1 ? [this.balanceLine(others[0])] : [];
        return withCreated([line, ...bal, ...fuzzyNote(i.fuzzy)].join('\n'));
      }
      case 'income': {
        const inc = L.addIncome({ amount: i.amount, source: i.source, date: i.date });
        return `✓ Income: ${this.m(inc.amount)} from ${inc.source}${inc.date !== L.today() ? ` on ${inc.date}` : ''}. \`${inc.id}\``;
      }
      case 'recurring': {
        const inner = i.inner;
        let payload, label;
        if (inner.type === 'income') {
          payload = { amount: inner.amount, source: inner.source };
          label = inner.source;
        } else {
          const { paidBy, owed, category } = this.buildExpense(inner, rid);
          payload = { description: inner.description, amount: inner.amount, paidBy, owed, category, groupId: inner.group, method: inner.method };
          label = inner.description;
        }
        const r = L.addRecurring({ kind: inner.type, freq: i.freq, day: i.day, start: i.start, payload, label });
        const posted = L.materializeRecurring();
        const every = { month: 'month', week: 'week', biweek: 'two weeks', year: 'year' }[i.freq];
        const share = inner.type === 'expense' && payload.owed[ME] !== payload.amount ? ` · your share ${this.m(payload.owed[ME] || 0)}` : '';
        return withCreated(
          `🔁 ${inner.type === 'income' ? 'Recurring income' : 'Recurring'}: **${label}** ${this.m(payload.amount)} every ${every}${i.freq === 'month' && i.day ? ` on day ${i.day}` : ''}${share}.\n` +
            (posted.length ? `Posted today’s occurrence; next on ${r.next}.` : `First one posts on ${r.next}.`) + ` \`${r.id}\``,
        );
      }
      case 'settle': {
        const bal = L.balanceWith(i.who);
        if (!bal) return `You and ${L.name(i.who)} are already settled up. ✅`;
        const t = bal > 0 ? L.addTransfer({ from: i.who, to: ME, amount: bal, note: 'Settle up' }) : L.addTransfer({ from: ME, to: i.who, amount: -bal, note: 'Settle up' });
        return `🤝 Settled: ${t.from === ME ? 'you paid ' + L.name(t.to) : L.name(t.from) + ' paid you'} ${this.m(t.amount)}. You and ${L.name(i.who)} are square. \`${t.id}\``;
      }
      case 'delete': {
        const target = i.target === 'last' ? L.lastEntry()?.id : i.target;
        const gone = target && L.deleteEntry(target);
        return gone ? `🗑️ Deleted ${gone.id} (${gone.description || gone.source || gone.note || 'payment'}, ${this.m(gone.amount)}).` : `I couldn’t find ${i.target}.`;
      }

      case 'group': {
        const g = L.addGroup(i.name, i.members.map(rid));
        return withCreated(`👥 Group **${g.name}**: ${g.members.map((m) => L.name(m)).join(', ')}.`);
      }
      case 'friends': {
        const list = i.people.map(rid).filter((x) => x !== ME);
        return created.length ? withCreated('✓ Done.') : `Already know ${list.map((x) => L.name(x)).join(', ')}.`;
      }
      case 'alias': {
        L.addAlias(i.who, i.alias);
        return `🧠 Got it — “${i.alias}” means ${L.name(i.who)}.`;
      }
      case 'teachCategory': {
        this.brain.learnCategory(i.word, i.category, 5);
        let n = 0;
        for (const e of this.s.expenses) if (norm(e.description).includes(norm(i.word)) && e.category !== i.category) (e.category = i.category), n++;
        return `🧠 “${i.word}” → **${i.category}** from now on${n ? `; re-filed ${n} past expense${n > 1 ? 's' : ''}` : ''}.`;
      }
      case 'teach':
        return this.teach(i);
      case 'currency':
        this.s.currency = i.code;
        return `Currency set to ${i.code}.`;
      case 'cash':
        this.s.cash = { amount: i.amount, date: L.today() };
        return `🏦 Cash on hand set to ${this.m(i.amount)} as of today. Forecasts now project real balances.`;

      case 'budget': {
        this.s.budgets[i.category] = i.amount;
        const used = L.mySpending(monthStart(L.today()), L.today()).byCategory[i.category] || 0;
        return `📊 Budget: ${this.m(i.amount)}/month for **${i.category}** (${this.m(used)} used so far this month).`;
      }
      case 'goal': {
        const g = { id: L.nextId('G'), name: i.name, target: i.target, saved: 0, deadline: i.deadline, createdAt: new Date().toISOString() };
        this.s.goals.push(g);
        const need = this.planner.goalNeeds().find((x) => x.id === g.id);
        return `🎯 Goal **${g.name}**: ${this.m(g.target)}${g.deadline ? ` by ${g.deadline}` : ''}.` + (need.perMonth ? ` That’s ${this.m(need.perMonth)}/month for ${need.monthsLeft} months.` : ' Add a deadline (“by June 2027”) and I’ll plan the monthly amount.');
      }
      case 'contribute': {
        const g = this.s.goals.find((x) => x.id === i.goal);
        g.saved += i.amount;
        const pct = Math.min(100, Math.round((100 * g.saved) / g.target));
        return `🎯 ${this.m(i.amount)} → **${g.name}**: ${this.m(g.saved)} of ${this.m(g.target)} (${pct}%).${g.saved >= g.target ? ' Goal reached! 🎉' : ''}`;
      }
      case 'stopRecurring': {
        const q = norm(i.query);
        const r = this.s.recurring.find((x) => x.active && (x.id === q || norm(x.label).includes(q) || q.includes(norm(x.label))));
        if (!r) return `No active recurring item matches “${i.query}”. Say “recurring” to list them.`;
        r.active = false;
        return `⏹️ Stopped recurring **${r.label}**.`;
      }

      // ── queries ──
      case 'balances':
        return this.balancesReply();
      case 'balanceWith':
        return i.who.map((id) => this.balanceLine(id, true)).join('\n');
      case 'groupBalances':
        return this.groupReply(i.group);
      case 'simplify':
        return this.simplifyReply(i.group);
      case 'whoPays':
        return this.whoPaysReply(i);
      case 'history':
        return this.historyReply(i.limit);
      case 'spending':
        return this.spendingReply(i);
      case 'budgetStatus':
        return this.budgetReply();
      case 'goals':
        return this.goalsReply();
      case 'forecast':
        return this.forecastReply(i.months);
      case 'afford':
        return this.affordReply(i);
      case 'insights':
        return this.insightsReply();
      case 'recurringList':
        return this.recurringReply();
      case 'brain':
        return this.brainReply();
      default:
        return `I understood “${text}” but can’t act on ${i.type} yet.`;
    }
  }

  buildExpense(i, rid) {
    const L = this.ledger;
    const paidBy = {};
    for (const p of i.payers) {
      const id = rid(p.id);
      paidBy[id] = (paidBy[id] || 0) + p.amount;
    }
    const parts = i.participants.map(rid);
    const split = i.split.type === 'equal' ? i.split : { type: i.split.type, values: Object.fromEntries(Object.entries(i.split.values).map(([k, v]) => [rid(k), v])) };
    const owed = L.shares(i.amount, parts, split);
    let category = i.category;
    if (category) this.brain.learnCategory(i.description, category, 2);
    else category = this.brain.predictCategory(i.description).category;
    return { paidBy, owed, category };
  }

  // ── reply builders ─────────────────────────────────────────────────────
  describeExpense(e) {
    const L = this.ledger;
    const payers = Object.keys(e.paidBy);
    const owers = Object.keys(e.owed);
    const who = payers.length === 1 ? (payers[0] === ME ? 'You paid' : `${L.name(payers[0])} paid`) : `Paid by ${payers.map((p) => `${L.name(p)} ${this.m(e.paidBy[p])}`).join(', ')}`;
    const vals = Object.values(e.owed);
    const equal = vals.every((v) => Math.abs(v - vals[0]) <= 1);
    let split;
    if (owers.length === 1 && owers[0] === ME && payers[0] === ME) split = 'personal expense';
    else if (owers.length === 1) split = `all on ${L.name(owers[0])}`;
    else if (equal) split = `split equally between ${owers.map((o) => L.name(o)).join(', ')} (${this.m(vals[0])} each)`;
    else split = `split ${owers.map((o) => `${L.name(o)} ${this.m(e.owed[o])}`).join(', ')}`;
    const meta = [e.category, e.date !== L.today() ? e.date : null, e.groupId ? this.s.groups[e.groupId]?.name : null, e.method].filter(Boolean).join(' · ');
    const lines = [`✓ **${e.description}** ${this.m(e.amount)} — ${who}; ${split}. _${meta}_ \`${e.id}\``];
    const involved = [...new Set([...payers, ...owers])].filter((p) => p !== ME);
    if (payers.includes(ME) || owers.includes(ME)) for (const p of involved) lines.push(this.balanceLine(p));
    return lines.join('\n');
  }
  balanceLine(id, verbose = false) {
    if (!id || id === ME) return '';
    const b = this.ledger.balanceWith(id);
    const n = this.ledger.name(id);
    if (b > 0) return `→ ${n} owes you **${this.m(b)}**${verbose ? ' overall' : ''}.`;
    if (b < 0) return `→ You owe ${n} **${this.m(-b)}**${verbose ? ' overall' : ''}.`;
    return `→ You and ${n} are settled up.`;
  }
  balancesReply() {
    const rows = this.ledger.friendBalances().filter((b) => b.amount).sort((a, b) => b.amount - a.amount);
    if (!rows.length) return 'Everyone is settled up. ✅';
    const owed = rows.filter((r) => r.amount > 0), owe = rows.filter((r) => r.amount < 0);
    const tot = (xs) => xs.reduce((a, r) => a + Math.abs(r.amount), 0);
    const out = [];
    if (owed.length) out.push(`**Owed to you — ${this.m(tot(owed))}**`, ...owed.map((r) => `• ${r.name}: ${this.m(r.amount)}`));
    if (owe.length) out.push(`**You owe — ${this.m(tot(owe))}**`, ...owe.map((r) => `• ${r.name}: ${this.m(-r.amount)}`));
    const net = tot(owed) - tot(owe);
    out.push(`Net: ${net >= 0 ? '+' : '−'}${this.m(Math.abs(net))}`);
    return out.join('\n');
  }
  groupReply(gid) {
    const g = this.s.groups[gid];
    const net = this.ledger.netBalances({ groupId: gid });
    const lines = g.members.map((m) => `• ${this.ledger.name(m)}: ${net[m] > 0 ? 'is owed ' + this.m(net[m]) : net[m] < 0 ? 'owes ' + this.m(-net[m]) : 'settled'}`);
    return `**${g.name}**\n${lines.join('\n')}\n\n${this.simplifyReply(gid)}`;
  }
  simplifyReply(gid) {
    const net = gid ? this.ledger.netBalances({ groupId: gid }) : this.ledger.netBalances();
    const plan = this.ledger.simplify(net);
    if (!plan.length) return 'Nothing to settle. ✅';
    return `**Fewest payments to settle${gid ? ` ${this.s.groups[gid].name}` : ' everything'}** (${plan.length}):\n` + plan.map((p) => `• ${this.ledger.name(p.from)} → ${this.ledger.name(p.to)}: ${this.m(p.amount)}`).join('\n');
  }
  whoPaysReply(i) {
    const L = this.ledger;
    let pool = i.group ? this.s.groups[i.group].members : i.among.length ? [ME, ...i.among] : null;
    const net = i.group ? L.netBalances({ groupId: i.group }) : L.netBalances();
    if (!pool) pool = Object.keys(net).filter((k) => net[k]).concat(ME);
    pool = [...new Set(pool)];
    pool.sort((a, b) => (net[a] || 0) - (net[b] || 0));
    const next = pool[0];
    return `💳 **${L.name(next)}** should pay next — ${next === ME ? 'you are' : 'they are'} furthest behind (${(net[next] || 0) < 0 ? 'owes ' + this.m(-(net[next] || 0)) : 'even'}${i.group ? ` in ${this.s.groups[i.group].name}` : ''}).`;
  }
  historyReply(limit) {
    const L = this.ledger;
    const all = [
      ...this.s.expenses.map((e) => ({ ...e, line: `${e.description} ${this.m(e.amount)} — ${Object.keys(e.paidBy).map((p) => L.name(p)).join(' & ')} paid · ${e.category}` })),
      ...this.s.transfers.map((t) => ({ ...t, line: `${L.name(t.from)} → ${L.name(t.to)} ${this.m(t.amount)}${t.note ? ` (${t.note})` : ''}` })),
      ...this.s.income.map((x) => ({ ...x, line: `Income ${this.m(x.amount)} · ${x.source}` })),
    ].sort((a, b) => (a.date === b.date ? (a.createdAt < b.createdAt ? 1 : -1) : a.date < b.date ? 1 : -1));
    if (!all.length) return 'No activity yet.';
    return all.slice(0, limit).map((x) => `\`${x.id}\` ${x.date} · ${x.line}`).join('\n');
  }
  spendingReply(i) {
    const L = this.ledger;
    const today = L.today();
    const ranges = {
      'this month': [monthStart(today), today],
      'last month': [monthStart(addMonths(monthStart(today), -1)), monthEnd(addMonths(monthStart(today), -1))],
      'this year': [`${today.slice(0, 4)}-01-01`, today],
      'last year': [`${Number(today.slice(0, 4)) - 1}-01-01`, `${Number(today.slice(0, 4)) - 1}-12-31`],
      'this week': [addDays(today, -6), today],
      'last week': [addDays(today, -13), addDays(today, -7)],
      today: [today, today],
      'all time': ['0000-01-01', today],
      ever: ['0000-01-01', today],
    };
    const dm = i.period.match(/last (\d+) days/);
    const [from, to] = dm ? [addDays(today, -Number(dm[1]) + 1), today] : ranges[i.period] || ranges['this month'];
    const s = L.mySpending(from, to);
    if (i.category) return `You spent **${this.m(s.byCategory[i.category] || 0)}** on ${i.category} ${i.period} (your share).`;
    if (!s.total) return `No spending recorded ${i.period}.`;
    const rows = Object.entries(s.byCategory).sort((a, b) => b[1] - a[1]);
    return `**${this.m(s.total)} spent ${i.period}** (your share):\n` + rows.map(([c, v]) => `• ${c}: ${this.m(v)} (${Math.round((100 * v) / s.total)}%)`).join('\n');
  }
  budgetReply() {
    const rows = this.planner.budgetStatus();
    if (!rows.length) return 'No budgets yet. Try “budget 400 for food”.';
    return `**Budgets — ${monthLabel(monthKey(this.ledger.today()))}**\n` + rows.map((b) => `• ${b.category}: ${this.m(b.used)} / ${this.m(b.budget)} (${b.pct}%)${b.used > b.budget ? ' 🔴 over' : !b.onPace ? ` 🟡 on pace for ${this.m(b.projected)}` : ' 🟢'}`).join('\n');
  }
  goalsReply() {
    const gs = this.planner.goalNeeds();
    if (!gs.length) return 'No goals yet. Try “save 10000 for a car by June 2027”.';
    return '**Goals**\n' + gs.map((g) => `• ${g.name}: ${this.m(g.saved)} / ${this.m(g.target)} (${g.pct}%)${g.deadline ? ` · by ${g.deadline} · ${this.m(g.perMonth)}/mo needed` : ''}`).join('\n');
  }
  forecastReply(months) {
    const f = this.planner.forecast(months);
    const head = `**${months}-month forecast** · variable spend ${this.m(f.variablePerMonth)}/mo from ${f.basis}${Math.abs(f.factor - 1) > 0.01 ? `, self-corrected ×${f.factor.toFixed(2)}` : ''}`;
    const lines = f.rows.map((r) => `• ${r.label}: in ${this.m(r.income)} · out ${this.m(r.fixed + r.variable)} · net ${r.net >= 0 ? '+' : '−'}${this.m(Math.abs(r.net))}` + (r.cashEnd != null ? ` · cash ${this.m(r.cashEnd)}` : '') + (r.goals ? ` · goals ${this.m(r.goals)}` : ''));
    const end = f.rows.at(-1);
    const tail = f.cashNow == null
      ? `\nCumulative surplus by ${end.label}: ${this.m(end.cumulative)}. Set your balance (“I have 8000 in the bank”) to project real cash.`
      : `\nFree cash after goal set-asides by ${end.label}: **${this.m(end.freeCash)}**.`;
    return `${head}\n${lines.join('\n')}${tail}`;
  }
  affordReply(i) {
    const a = this.planner.afford(i.amount, i.date);
    const what = i.what ? ` ${i.what}` : '';
    const v = { yes: '✅ **Yes**', tight: '🟡 **Tight**', no: '🔴 **Not yet**' }[a.verdict];
    const basis = a.hasCash ? `free cash (after goal set-asides) in ${a.month}` : `projected surplus by ${a.month}`;
    const lines = [`${v} — ${this.m(i.amount)}${what}: you’d have ${this.m(a.available)} of ${basis}, leaving ${this.m(a.after)}.`];
    if (a.verdict === 'tight') lines.push(`That leaves less than one month of spending (${this.m(a.buffer)}) as a cushion.`);
    if (a.verdict !== 'yes') lines.push(a.fitsBy ? `It fits comfortably by **${a.fitsBy}**.` : 'It doesn’t fit comfortably in the next several months at the current pace.');
    if (!a.hasCash) lines.push('_Tip: tell me your bank balance for a sharper answer._');
    return lines.join('\n');
  }
  insightsReply() {
    const items = this.planner.insights();
    const icon = { good: '🟢', warn: '🟡', bad: '🔴', info: '•' };
    const today = this.ledger.today();
    const s = this.ledger.mySpending(monthStart(today), today);
    const inc = this.ledger.myIncome(monthStart(today), today);
    const head = `**${monthLabel(monthKey(today))} so far:** spent ${this.m(s.total)}, earned ${this.m(inc)}.`;
    return items.length ? `${head}\n${items.map((x) => `${icon[x.level]} ${x.text}`).join('\n')}` : `${head}\nNot enough history for insights yet — keep logging.`;
  }
  recurringReply() {
    const rs = this.s.recurring.filter((r) => r.active);
    if (!rs.length) return 'No recurring items. Try “netflix 15 monthly” or “salary 5000 every month on the 1st”.';
    return '**Recurring**\n' + rs.map((r) => `• \`${r.id}\` ${r.kind === 'income' ? '💰' : '🔁'} ${r.label} ${this.m(r.payload.amount)} / ${r.freq} · next ${r.next}`).join('\n');
  }
  brainReply() {
    const b = this.s.brain;
    const st = b.stats;
    const understood = st.ruleHits + st.templateHits + st.aiHits;
    const rate = understood + st.misses ? Math.round((100 * understood) / (understood + st.misses)) : 100;
    const learnedWords = Object.entries(b.categoryWords).map(([w, cats]) => [w, Object.entries(cats).sort((x, y) => y[1] - x[1])[0]]).sort((x, y) => y[1][1] - x[1][1]).slice(0, 8);
    const aliases = this.ledger.people().filter((p) => p.aliases.length).map((p) => `${p.aliases.join('/')} → ${p.name}`);
    const lines = [
      `**What I’ve learned**`,
      `• Understood ${rate}% of ${understood + st.misses} statements (rules ${st.ruleHits}, learned phrasings ${st.templateHits}, AI ${st.aiHits}, missed ${st.misses}).`,
      `• Phrasings learned: ${b.templates.length}${b.templates.length ? ' — e.g. ' + b.templates.slice(-3).map((t) => `“${t.example}”`).join(', ') : ''}.`,
      `• Category sense: ${Object.keys(b.categoryWords).length} words${learnedWords.length ? ' — ' + learnedWords.map(([w, [c]]) => `${w}→${c}`).join(', ') : ''}.`,
      aliases.length ? `• Nicknames: ${aliases.join(', ')}.` : null,
      `• Forecast self-correction: ×${b.calibration.factor.toFixed(2)} from ${b.calibration.history.filter((h) => h.actual != null).length} scored month(s).`,
      `• AI fallback: ${aiEnabled() ? 'on' : 'off (set ANTHROPIC_API_KEY to enable)'}.`,
      b.misses.length ? `• Recent misses (teach me with: teach "phrase" = "command"):\n${b.misses.slice(-5).map((m) => `   – “${m.text}”`).join('\n')}` : null,
    ];
    return lines.filter(Boolean).join('\n');
  }

  teach(i) {
    const parsed = i.canonical.map((c) => parse(c, this.ctx()));
    const bad = i.canonical.find((c, k) => !parsed[k] || parsed[k].type === 'error');
    if (bad) return `I don’t understand the command “${bad}” myself yet, so I can’t map anything onto it. Try one of the forms in “help”.`;
    const names = this.ledger.people().filter((p) => p.id !== ME).flatMap((p) => [p.name, ...p.aliases]);
    const t = this.brain.learnTemplate(i.phrase, i.canonical, names, 'taught', freeTexts(parsed));
    this.brain.forgetMiss(i.phrase);
    if (!t) return `🧠 I can’t generalise “${i.phrase}” safely (it needs at least one number or name plus a keyword). Try a fuller example.`;
    return `🧠 Learned: sentences shaped like “${t.example}” now mean ${i.canonical.map((c) => `“${c}”`).join(' + ')}, with ${t.slots.map((s) => s.kind).join(', ')} filled from what you say.`;
  }

  missReply(text) {
    const tips = [];
    if (/\d/.test(text)) tips.push('“I paid 60 for dinner with Ali”', '“Ali paid me 20”', '“budget 300 for food”');
    else tips.push('“balances”', '“forecast”', '“how am I doing”');
    const ai = aiEnabled() ? '' : '\n_Set ANTHROPIC_API_KEY and I’ll learn new phrasings automatically._';
    return `🤔 I didn’t catch that. Try ${tips.join(', ')} — or teach me: teach "${text.replace(/"/g, "'")}" = "<command>".${ai}`;
  }

  // ── dashboard (web UI) ─────────────────────────────────────────────────
  dashboard() {
    this.ledger.materializeRecurring();
    const L = this.ledger;
    const today = L.today();
    const f = this.planner.forecast(6);
    const spend = L.mySpending(monthStart(today), today);
    return {
      today,
      currency: this.s.currency,
      balances: L.friendBalances().sort((a, b) => b.amount - a.amount),
      groups: Object.values(this.s.groups).map((g) => ({ ...g, memberNames: g.members.map((m) => L.name(m)), plan: L.simplify(L.netBalances({ groupId: g.id })).map((p) => ({ ...p, fromName: L.name(p.from), toName: L.name(p.to) })) })),
      month: { label: monthLabel(monthKey(today)), spent: spend.total, byCategory: spend.byCategory, income: L.myIncome(monthStart(today), today) },
      budgets: this.planner.budgetStatus(),
      goals: this.planner.goalNeeds(),
      forecast: f,
      cash: L.estimatedCash(),
      recurring: this.s.recurring.filter((r) => r.active),
      insights: this.planner.insights(),
      activity: this.historyReply(12),
      brain: { stats: this.s.brain.stats, templates: this.s.brain.templates.length, words: Object.keys(this.s.brain.categoryWords).length, factor: this.s.brain.calibration.factor, ai: aiEnabled() },
    };
  }
}

// The bundled translator is only "available" when credentials are configured;
// an injected translator (tests, embedding) always is.
const aiAvailable = (fn) => fn !== aiTranslate || aiEnabled();

/** Free-text fields of parsed intents — candidates for template text slots. */
const freeTexts = (intents) =>
  intents.flatMap((p) => [p.description, p.source, p.name, p.what, p.inner?.description, p.inner?.source]).filter(Boolean);

export const HELP = `**Tell me what happened, in plain words.** Examples:

**Shared expenses**
• I paid 120 for dinner with Ali and Sara
• Ali paid 90 for groceries for me and Sara
• rent 3000 split me 1500, Ali 1000, Sara 500 · split 60/40 with Ali
• Ali paid 60 and I paid 40 for dinner with Sara
• add “yesterday”, “in Trip”, “#food”, or “via Venmo” to any expense

**Paying back**
• I paid Ali 30 · Ali paid me back 20 · I lent Sara 50 · I owe Ali 15
• settle up with Ali · simplify · who pays next in Trip

**Your money & the future**
• I earned 5200 salary · salary 5200 every month on the 1st
• netflix 15 monthly · rent 2000 every month on the 1st split with Ali
• budget 400 for food · I have 8000 in the bank
• save 10000 for a car by June 2027 · add 500 to car
• forecast 12 months · can I afford a 1500 laptop in March?
• how am I doing · how much did I spend last month · budgets

**Teach me**
• Al is also called Ali · categorize chipotle as food
• teach "grabbed tacos w/ Ali 30" = "Ali paid 30 for tacos with me"
• what have you learned · undo · history · delete e12`;

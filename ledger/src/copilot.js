// Claude-first chat. Every message goes to Claude with the user's real
// numbers. Claude either answers a question from those numbers (calling the
// app for any exact figure it doesn't have), or proposes ledger commands and
// echoes back exactly what it understood: amount, what, who, when, category.
// Nothing is written until the user confirms. The ledger's own deterministic
// parser executes the confirmed commands; Claude never touches a balance.
//
// Self-improvement, all kept in state.brain.copilot and visible under
// "what have you learned":
//   • examples — every confirmed message and the commands it became; the
//     most similar ones are shown to Claude next time, so it reads this
//     user's shorthand the way they meant it before;
//   • lessons  — durable rules distilled from corrections and stated
//     preferences ("BQHC transfers are savings"), shown to Claude every time;
//   • the offline engine learns the same phrasing as a template, so it can
//     still read it when Claude is unavailable;
//   • stats    — how often the first reading was right, so improvement shows.

import { parse } from './parser.js';
import { GRAMMAR } from './ai.js';
import { ME } from './ledger.js';
import { fmt } from './money.js';
import { tokens } from './brain.js';
import { MUTATING, freeTexts } from './assistant.js';

const MAX_EXAMPLES = 60;
const MAX_LESSONS = 40;
const HISTORY_TURNS = 6;

export class Copilot {
  /** sampler: the page's `sample` function (has `.json`), or a test double. */
  constructor(assistant, sampler) {
    this.a = assistant;
    this.sampler = sampler;
    this.turns = []; // recent conversation, for follow-ups ("make it 40")
    this.pending = null; // { text, corrections, actions, lesson }
  }
  get mem() {
    const b = this.a.s.brain;
    b.copilot ??= { examples: [], lessons: [], stats: {} };
    for (const k of ['proposals', 'confirmed', 'firstTry', 'corrected', 'cancelled', 'questions']) b.copilot.stats[k] ??= 0;
    return b.copilot;
  }
  m(c) {
    return fmt(c, this.a.s.currency);
  }

  // ── the user's numbers, as Claude sees them ────────────────────────────
  facts() {
    const a = this.a, L = a.ledger, P = a.planner, s = a.s;
    const today = L.today();
    const lines = [`Today: ${today}. Currency: ${s.currency}.`];
    const ct = P.cashToday();
    if (ct.cash != null)
      lines.push(`Cash today (estimated): ${this.m(ct.cash)}${ct.gap ? ` — includes ${this.m(ct.gap)} of estimated everyday spending since the last statement (${P.dataEnd()})` : ''}.`);
    else lines.push('Cash: unknown (no balance given yet).');
    for (const k of [0, 1]) {
      const r = P.leftover(k);
      lines.push(`Free to spend ${k ? `in ${r.label}` : `rest of ${r.label}`} after bills and goal saving: ${this.m(r.free)} (usual everyday spending for that span ${this.m(r.usual)}).`);
    }
    const rec = s.recurring.filter((r) => r.active);
    if (rec.length)
      lines.push('Scheduled: ' + rec.map((r) => `${r.label} ${this.m(r.payload.amount)} ${r.freq === 'once' ? `expected ${r.next}` : `/${r.freq}, next ${r.next}`}${r.kind === 'income' ? ' (income)' : ''}`).join('; ') + '.');
    const budgets = P.budgetStatus();
    if (budgets.length) lines.push('Budgets this month: ' + budgets.map((b) => `${b.category} ${this.m(b.used)} of ${this.m(b.budget)}`).join('; ') + '.');
    const goals = P.goalNeeds();
    if (goals.length) lines.push('Goals: ' + goals.map((g) => `${g.name} ${this.m(g.saved)}/${this.m(g.target)}${g.deadline ? ` by ${g.deadline}` : ''}`).join('; ') + '.');
    const people = L.people().filter((p) => p.id !== ME);
    if (people.length) {
      const bal = L.friendBalances().filter((b) => b.amount);
      lines.push('People: ' + people.map((p) => p.name + (p.aliases.length ? ` (aka ${p.aliases.join(', ')})` : '')).join(', ') + '.');
      if (bal.length) lines.push('Balances: ' + bal.map((b) => (b.amount > 0 ? `${b.name} owes you ${this.m(b.amount)}` : `you owe ${b.name} ${this.m(-b.amount)}`)).join('; ') + '.');
    }
    const groups = Object.values(s.groups);
    if (groups.length) lines.push('Groups: ' + groups.map((g) => g.name).join(', ') + '.');
    const cats = [...new Set(s.expenses.map((e) => e.category))];
    if (cats.length) lines.push('Categories in use: ' + cats.join(', ') + '.');
    const recent = [
      ...s.expenses.map((e) => ({ d: e.date, t: `${e.description} ${this.m(e.amount)} [${e.category}]${Object.keys(e.paidBy)[0] !== ME ? ` paid by ${L.name(Object.keys(e.paidBy)[0])}` : ''}${e.recurringId && !e.reconciled ? ' (scheduled estimate)' : ''}` })),
      ...s.income.map((i) => ({ d: i.date, t: `income ${i.source} ${this.m(i.amount)}` })),
      ...s.transfers.map((t) => ({ d: t.date, t: `${L.name(t.from)} → ${L.name(t.to)} ${this.m(t.amount)}` })),
    ]
      .sort((x, y) => (x.d < y.d ? 1 : -1))
      .slice(0, 25);
    if (recent.length) lines.push('Recent entries (newest first):\n' + recent.map((r) => `  ${r.d} ${r.t}`).join('\n'));
    return lines.join('\n');
  }

  /** The confirmed examples most like this message, plus the latest few. */
  examplesFor(text) {
    const ex = this.mem.examples;
    if (!ex.length) return [];
    const q = new Set(tokens(text));
    const scored = ex.map((e, i) => ({ e, i, score: tokens(e.text).filter((w) => q.has(w)).length }));
    const best = scored.filter((x) => x.score > 0).sort((a, b) => b.score - a.score || b.i - a.i).slice(0, 6);
    const recent = scored.slice(-3);
    const seen = new Set();
    return [...best, ...recent].filter((x) => !seen.has(x.i) && seen.add(x.i)).map((x) => x.e);
  }

  instructions(text) {
    const lessons = this.mem.lessons;
    const examples = this.examplesFor(text);
    return `You are the assistant inside Zeyn Ledger, the user's own app for personal finances and shared expenses. Read their message and work out exactly what they mean, using their real data below.

If they are telling you about money (something bought, paid, received, lent, owed, a bill, income, money they expect, a budget or goal, a correction to an entry):
- propose the ledger commands that record it, and in "summary" echo back the specifics they will confirm: exact amount, what it was, who paid, who shares, date, category, account if known. Example summary: "$34.50 · Trader Joe's · groceries · you paid · today".
- never invent an amount, a person or a date. If the amount or who paid is genuinely unclear, propose nothing and ask one short question.
- use a category from "Categories in use" when one fits.

If they are asking a question (can I afford, what's left, how much did I spend, who owes what, how am I doing):
- answer with their actual numbers. The facts below cover the common ones; for anything else call the ledger_query tool with a command such as "can I afford 300 for jacket in December", "how much did I spend on food last month", "how much do I owe Ali", "forecast 6 months".
- lead with the number, then one or two sentences on why. No generic advice.

Always: under 90 words, plain text, **bold** allowed. Speak to them as "you".

Ledger commands you can propose (one command per action; quote multi-word descriptions):
${GRAMMAR}
Corrections: "delete e12" removes an entry (ids appear in the app); to change one, delete it and record the corrected version.

${lessons.length ? `What you have learned about this user — follow these:\n${lessons.map((l, i) => `${i + 1}. ${l.text}`).join('\n')}\n\n` : ''}${examples.length ? `How this user's earlier messages were confirmed:\n${examples.map((e) => `- "${e.text}" → ${e.commands.map((c) => `"${c}"`).join(' + ')}`).join('\n')}\n\n` : ''}Their data:
${this.facts()}

Reply with only a JSON object:
{"reply": "what you say to them", "actions": [{"command": "a ledger command", "summary": "the one-line echo they confirm"}], "question": "", "lesson": ""}
- "actions": [] for questions and when you need to ask something.
- "question": a short clarifying question, or "".
- "lesson": when this message (or their correction of your earlier reading) teaches something durable about how they talk or want things recorded — a nickname, a merchant's category, a preference — state it as one short rule. Otherwise "".`;
  }

  buildTurns(text) {
    const turns = [{ role: 'user', content: this.instructions(text) }, ...this.turns.slice(-HISTORY_TURNS)];
    let msg = text;
    if (this.pending)
      msg = `My earlier message was: "${this.pending.text}". You proposed: ${this.pending.actions.map((x) => `"${x.summary}" (${x.command})`).join('; ')}. I have not confirmed it. My correction: ${text}`;
    turns.push({ role: 'user', content: msg });
    return turns;
  }

  queryTool() {
    return {
      name: 'ledger_query',
      description:
        'Ask the ledger app a read-only question in plain words and get its exact answer as text, e.g. "can I afford 300 for jacket in December", "how much did I spend on food last month", "what\'s left next month", "how much do I owe Ali", "forecast 6 months", "history". It cannot record anything.',
      inputSchema: { type: 'object', properties: { command: { type: 'string', description: 'The question, as the app understands it.' } }, required: ['command'] },
      execute: (input) => {
        const command = String(input?.command || '').trim();
        const intent = parse(command, this.a.ctx());
        if (!intent || intent.type === 'error') throw new Error(`The app didn't understand "${command}". Try a simpler phrasing.`);
        if (MUTATING.has(intent.type)) throw new Error('That would record something. Propose it as an action for the user to confirm instead.');
        return plain(this.a.execute(intent, command));
      },
    };
  }

  /**
   * Send one message to Claude. Returns
   *   { reply, actions: [{command, summary}], question, queries: [replies of read-only actions] }
   * and keeps any proposal pending until confirm() or cancel().
   */
  async ask(text, { signal } = {}) {
    const correcting = this.pending;
    const turns = this.buildTurns(text);
    let out = await this.call(turns, signal);
    // One repair round if a proposed command isn't valid ledger language.
    const invalid = (o) => o.actions.filter((x) => !validCommand(x.command, this.a));
    if (invalid(out).length) {
      const bad = invalid(out).map((x) => x.command);
      turns.push({ role: 'assistant', content: JSON.stringify(out) });
      turns.push({ role: 'user', content: `The app could not read these commands: ${bad.map((b) => `"${b}"`).join(', ')}. Rewrite them using exactly the command forms listed, and reply with the same JSON shape.` });
      out = await this.call(turns, signal);
      out.actions = out.actions.filter((x) => validCommand(x.command, this.a));
    }

    // Read-only commands Claude put in actions just run; they need no confirmation.
    const queries = [];
    const records = [];
    for (const x of out.actions) {
      const intent = parse(x.command, this.a.ctx());
      if (MUTATING.has(intent.type)) records.push(x);
      else queries.push(plain(this.a.execute(intent, x.command)));
    }
    out.actions = records;

    this.turns.push({ role: 'user', content: text });
    this.turns.push({ role: 'assistant', content: out.reply + (records.length ? ` [proposed: ${records.map((x) => x.summary).join('; ')}]` : '') });
    this.turns = this.turns.slice(-HISTORY_TURNS);

    if (records.length) {
      this.pending = {
        text: correcting ? correcting.text : text,
        corrections: correcting ? [...correcting.corrections, text] : [],
        actions: records,
        lesson: out.lesson || correcting?.lesson || '',
      };
      this.mem.stats.proposals++;
    } else {
      if (!correcting) this.mem.stats.questions++;
      this.pending = correcting && !out.question ? null : this.pending;
      if (out.lesson) this.addLesson(out.lesson, text); // a stated preference, no record needed
    }
    this.a.ledger.persist();
    return { reply: out.reply, actions: records, question: out.question, queries };
  }

  async call(turns, signal) {
    const opts = { signal, modelTier: 'default', effort: 'low', tools: [this.queryTool()] };
    let raw;
    try {
      raw = await this.sampler.json(turns, opts);
    } catch (e) {
      if (e?.code === 'tools_unavailable') raw = await this.sampler.json(turns, { signal, modelTier: 'default', effort: 'low' });
      else throw e;
    }
    return {
      reply: String(raw?.reply || '').trim() || 'Done.',
      actions: (Array.isArray(raw?.actions) ? raw.actions : [])
        .map((x) => ({ command: String(x?.command || '').trim(), summary: String(x?.summary || x?.command || '').trim() }))
        .filter((x) => x.command)
        .slice(0, 8),
      question: String(raw?.question || '').trim(),
      lesson: String(raw?.lesson || '').trim().slice(0, 240),
    };
  }

  /** Record the pending proposal. Returns the app's replies for each entry. */
  confirm() {
    const p = this.pending;
    if (!p) return null;
    const commands = p.actions.map((x) => x.command);
    const { intents, replies } = this.a.runCommands(commands);
    const st = this.mem.stats;
    st.confirmed++;
    if (p.corrections.length) st.corrected++;
    else st.firstTry++;
    this.mem.examples.push({ text: p.text, commands, at: this.a.ledger.today(), corrected: p.corrections.length > 0 });
    if (this.mem.examples.length > MAX_EXAMPLES) this.mem.examples.shift();
    if (p.lesson) this.addLesson(p.lesson, p.text);
    // Teach the offline engine the same phrasing, for when Claude isn't available.
    const names = this.a.ledger.people().filter((x) => x.id !== ME).flatMap((x) => [x.name, ...x.aliases]);
    this.a.brain.learnTemplate(p.text, commands, names, 'claude', freeTexts(intents));
    this.pending = null;
    this.a.ledger.persist();
    return replies;
  }

  cancel() {
    if (!this.pending) return;
    this.mem.stats.cancelled++;
    this.pending = null;
    this.a.ledger.persist();
  }

  addLesson(text, from) {
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return;
    const lessons = this.mem.lessons;
    const dupe = lessons.findIndex((l) => l.text.toLowerCase() === t.toLowerCase());
    if (dupe >= 0) lessons.splice(dupe, 1);
    lessons.push({ text: t, from, at: this.a.ledger.today() });
    if (lessons.length > MAX_LESSONS) lessons.shift();
  }
}

function validCommand(command, assistant) {
  const intent = parse(command, assistant.ctx());
  return Boolean(intent && intent.type !== 'error');
}

/** App replies use light markdown and emoji; Claude reads plain text. */
const plain = (s) => String(s).replace(/\*\*/g, '').replace(/`/g, '').replace(/(^|\s)_(.+?)_(?=\s|$)/gm, '$1$2');

// Deterministic natural-language parser. Text in, a typed intent out, nothing
// mutated. Anything it cannot read falls through to learned templates and then
// to the optional AI translator (see assistant.js), whose answers are fed back
// into the brain so this parser's effective coverage grows with use.

import { AMOUNT_RE_SRC, parseAmount } from './money.js';
import { findTxnDate, findFutureDate, addDays, daysInMonth } from './dates.js';
import { SEED_CATEGORIES } from './brain.js';
import { norm } from './ledger.js';
import { normalize } from './text.js';

const AMT = AMOUNT_RE_SRC;
const P = String.raw`(?:@p\d+|me|myself|i\b|[A-Za-z][\w'-]*)`; // one person token
const LIST = String.raw`(?:${P}(?:\s*(?:,\s*(?:and\s+)?|\s+and\s+|\s*&\s*|\s*\+\s*)${P})*)`;

const NOT_NAMES = new Set(
  `a an the and or but for to with on in at by from of my our your his her their it its this that these those
   some all any every each both everyone everybody group us we you they them him he she me i myself
   today yesterday tomorrow tonight week month year day last next this split equally evenly paid pay pays
   dinner lunch breakfast rent food cash card venmo zelle paypal bank account bill bills fee tip tax total
   just also back off up down out over half rest remainder ways way`.split(/\s+/),
);
const CATEGORY_WORDS = new Set(Object.values(SEED_CATEGORIES).join(' ').split(' '));

/**
 * ctx: { today, people: [{id,name,aliases}], groups: [{id,name,members}],
 *        findPerson(word) -> {id, exact} | null, predictCategory(desc) }
 */
export function parse(input, ctx) {
  const raw = normalize(input);
  if (!raw) return null;
  const { text, tokens } = tokenizePeople(raw, ctx);
  const c = { ...ctx, tokens, raw };
  for (const rule of RULES) {
    const r = rule(text, c);
    if (r) return r;
  }
  return null;
}

/** Replace every known name/alias with a stable @pN token (longest first). */
function tokenizePeople(raw, ctx) {
  const names = [];
  for (const p of ctx.people) {
    if (p.id === 'me') continue;
    for (const n of [p.name, ...p.aliases]) names.push({ n, id: p.id });
  }
  names.sort((a, b) => b.n.length - a.n.length);
  let text = raw;
  const tokens = {};
  for (const { n, id } of names) {
    const re = new RegExp(`(?<![\\w@])${escapeRe(n)}(?:'s)?(?![\\w])`, 'gi');
    text = text.replace(re, () => {
      tokens[`@${id}`] = id;
      return `@${id}`;
    });
  }
  return { text, tokens };
}

// ── person helpers ─────────────────────────────────────────────────────────
/** Resolve one person word. strict: unknown names must be Capitalised. */
function person(word, c, { strict = false } = {}) {
  const w = word.trim().replace(/^(?:the|my|our)\s+/i, '');
  if (/^@p\d+$/.test(w)) return c.tokens[w] ? { id: c.tokens[w] } : null;
  if (/^(?:me|myself|i)$/i.test(w)) return { id: 'me' };
  if (/^(?:us|we|both of us|the two of us|us two)$/i.test(w)) return { id: 'us' };
  if (/^(?:everyone|everybody|all|all of us|us all|the group|the whole group|whole group|the gang)$/i.test(w)) return { id: 'all' };
  if (!/^[A-Za-z][\w'-]*$/.test(w)) return null;
  const lower = w.toLowerCase();
  if (NOT_NAMES.has(lower) || CATEGORY_WORDS.has(lower)) return null;
  const found = c.findPerson(w);
  if (found) return { id: found.id, fuzzyFrom: found.exact ? null : w };
  if (strict && !/^[A-Z]/.test(w)) return null;
  return { id: `new:${w[0].toUpperCase()}${w.slice(1)}` };
}
function personList(str, c, opts) {
  const items = str
    .split(/\s*(?:,\s*(?:and\s+)?|\s+and\s+|&|\+)\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) return null;
  const out = [];
  for (const it of items) {
    const p = person(it, c, opts);
    if (!p) return null;
    out.push(p);
  }
  return out;
}
const ids = (list) => list.map((p) => p.id);
const fuzzyNotes = (list) => list.filter((p) => p.fuzzyFrom).map((p) => ({ from: p.fuzzyFrom, id: p.id }));

function amountIn(s) {
  const m = s.match(new RegExp(`(?<![\\w@])${AMT}`, 'i'));
  return m ? { cents: parseAmount(m[0]), match: m[0] } : null;
}
const hasAmount = (s) => !!amountIn(s);
const strip = (s, part) => (part ? s.replace(part, ' ').replace(/\s+/g, ' ').trim() : s);

// ── rules (order matters: specific before general) ────────────────────────
const RULES = [
  (t) => (/^(?:help|\?|commands|what can you do|how do i use (?:this|you))\b/i.test(t) ? { type: 'help' } : null),
  (t) => (/^(?:undo|oops|scratch that|wrong|that'?s wrong|no,? that'?s wrong|revert)\b/i.test(t) ? { type: 'undo' } : null),
  (t) => {
    const m = t.match(/^(?:delete|remove|cancel)\s+(?:entry\s+|expense\s+|payment\s+)?#?([etir]\d+|last(?:\s+(?:one|expense|entry|payment))?)$/i);
    return m ? { type: 'delete', target: /^last/i.test(m[1]) ? 'last' : m[1].toLowerCase() } : null;
  },
  (t) => {
    const m = t.match(/^(?:history|activity|recent|show (?:me )?(?:my )?(?:recent |last )?(?:(\d+) )?(?:expenses|transactions|activity|entries))\b/i);
    return m ? { type: 'history', limit: Number(m[1]) || 15 } : null;
  },
  (t) =>
    /^(?:what (?:have you|did you) learn(?:ed|t)?|brain|memory|learning|show (?:your )?(?:brain|memory|learning))\b/i.test(t)
      ? { type: 'brain' }
      : null,

  // teach "phrase" = "command"  — explicit phrasing lesson
  (t, c) => {
    const m = c.raw.match(/^teach(?: me)?:?\s+"(.+?)"\s*(?:=|means|->|=>|is)\s*"?(.+?)"?$/i);
    return m ? { type: 'teach', phrase: m[1], canonical: m[2].split(/\s*;\s*/) } : null;
  },
  // aliases: "Al is Ali", "call Ali Al", "Ali is also called Al", "alias Al = Ali"
  (t, c) => {
    let m = c.raw.match(/^(?:alias|nickname)\s+(\S+(?:\s\S+)?)\s*(?:=|for|->|is)\s*(.+)$/i);
    if (m) return aliasIntent(m[2], m[1], c);
    m = c.raw.match(/^(.+?)\s+(?:is also (?:called|known as)|aka|goes by|is also)\s+(.+)$/i);
    if (m) return aliasIntent(m[1], m[2], c);
    m = c.raw.match(/^call\s+(\S+(?:\s\S+)?)\s+"?([^"]+?)"?$/i);
    if (m && c.findPerson(m[1])) return aliasIntent(m[1], m[2], c);
    m = c.raw.match(/^(\S+)\s+(?:is|means)\s+(\S+(?:\s\S+)?)$/i);
    if (m && !c.findPerson(m[1]) && c.findPerson(m[2])?.exact) return aliasIntent(m[2], m[1], c);
    return null;
  },
  // categorise: "uber is transport", "categorize starbucks as food"
  (t, c) => {
    const m = c.raw.match(/^(?:categori[sz]e|classify|file|tag)\s+(.+?)\s+(?:as|under|in|into)\s+([\w &-]+)$/i) ||
      c.raw.match(/^(.+?)\s+(?:is|are|counts as|goes under|should be)\s+(?:a |an )?(?:category\s+)?([\w &-]+?)(?:\s+category)?$/i);
    if (!m || hasAmount(m[1])) return null;
    const cat = norm(m[2]).replace(/\s+/g, '-');
    if (!cat || cat.length > 24) return null;
    // Only accept "X is Y" when Y is a category we know of, to avoid swallowing chat.
    if (!/^(?:categori|classify|file|tag)/i.test(c.raw) && !(cat in SEED_CATEGORIES) && !c.categories.includes(cat)) return null;
    return { type: 'teachCategory', word: m[1].trim(), category: cat };
  },
  (t) => {
    const m = t.match(/^(?:set\s+)?(?:my\s+)?(?:default\s+)?currency(?:\s+to|\s+is|:)?\s+([a-z]{3})$/i);
    return m ? { type: 'currency', code: m[1].toUpperCase() } : null;
  },
  // cash on hand anchor
  (t) => {
    const m = t.match(
      new RegExp(String.raw`^(?:i\s+(?:have|got)|i'?ve\s+got|my\s+(?:cash|bank|checking|savings|account|net cash)(?:\s+(?:balance|account))?\s+is|set\s+(?:my\s+)?cash(?:\s+to)?|cash(?:\s+on\s+hand)?\s+(?:is|=))\s+(${AMT})(?:\s+(?:in\s+(?:the\s+)?bank|in\s+cash|in\s+savings|total|saved))?$`, 'i'),
    );
    return m ? { type: 'cash', amount: parseAmount(m[1]) } : null;
  },

  // groups
  (t, c) => {
    const m = t.match(/^(?:create|make|new|start|add)\s+(?:a\s+)?(?:new\s+)?group\s+(?:called\s+|named\s+)?(.+?)(?:\s+with\s+(.+))?$/i);
    if (!m) return null;
    const members = m[2] ? personList(m[2], c) : [];
    if (m[2] && !members) return { type: 'error', message: `I couldn't read the member list "${m[2]}".` };
    return { type: 'group', name: unTokenize(m[1], c).trim(), members: ids(members) };
  },
  (t, c) => {
    const m = t.match(new RegExp(`^add\\s+(${LIST})\\s+to\\s+(?:the\\s+)?(?:group\\s+)?(.+?)(?:\\s+group)?$`, 'i'));
    if (!m || hasAmount(m[1])) return null;
    const g = c.groups.find((x) => norm(x.name) === norm(unTokenize(m[2], c)));
    if (!g) return null;
    const members = personList(m[1], c);
    return members ? { type: 'group', name: g.name, members: ids(members) } : null;
  },
  (t, c) => {
    const m = t.match(new RegExp(`^(?:add|new)\\s+(?:a\\s+)?(?:friends?|people|person|contacts?)?\\s*:?\\s*(${LIST})$`, 'i'));
    if (!m || hasAmount(t) || !/^(?:add|new)\s+(?:a\s+)?(?:friends?|people|person|contacts?)\b|^add\s+[A-Z@]/i.test(t)) return null;
    const list = personList(m[1], c);
    return list ? { type: 'friends', people: ids(list) } : null;
  },

  // budgets
  (t) => {
    const m =
      t.match(new RegExp(String.raw`^(?:set\s+)?(?:a\s+|my\s+)?(?:monthly\s+)?budget(?:\s+of)?\s+(${AMT})\s+(?:for|on)\s+([\w &-]+?)(?:\s+(?:per|a|each|every)\s+month|\s+monthly)?$`, 'i')) ||
      t.match(new RegExp(String.raw`^(?:set\s+)?(?:my\s+)?([\w &-]+?)\s+budget\s+(?:to|at|is|=|of)?\s*(${AMT})(?:\s+(?:per|a|each|every)\s+month|\s+monthly)?$`, 'i')) ||
      t.match(new RegExp(String.raw`^(?:limit|cap)\s+(?:my\s+)?([\w &-]+?)\s+(?:spending\s+)?(?:to|at)\s+(${AMT})(?:\s+(?:per|a|each|every)\s+month|\s+monthly)?$`, 'i')) ||
      t.match(new RegExp(String.raw`^(?:spend|i want to spend)\s+(?:at most|no more than|max|up to)\s+(${AMT})\s+(?:a month\s+|per month\s+|monthly\s+)?on\s+([\w &-]+?)(?:\s+(?:per|a|each|every)\s+month|\s+monthly)?$`, 'i'));
    if (!m) return null;
    const [a, b] = hasAmount(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    return { type: 'budget', category: norm(b).replace(/\s+/g, '-'), amount: parseAmount(a) };
  },
  (t) =>
    /^budgets?(?:\s+(?:status|check|report))?\??$|\bbudgets?\b.*(?:status|left|remaining|how|check|\?)|how am i doing (?:on|with) (?:my )?budgets?/i.test(t)
      ? { type: 'budgetStatus' }
      : null,

  // goals
  (t, c) => {
    const m = t.match(new RegExp(String.raw`^(?:add|put|move|save|saved|contribute|transfer|set aside)\s+(${AMT})\s+(?:to|toward|towards|into|in|for)\s+(?:my\s+|the\s+)?(.+?)(?:\s+(?:goal|fund|savings))?$`, 'i'));
    if (!m) return null;
    const g = c.goals.find((x) => norm(x.name) === norm(m[2]) || norm(m[2]).includes(norm(x.name)));
    return g ? { type: 'contribute', goal: g.id, amount: parseAmount(m[1]) } : null;
  },
  (t, c) => {
    const m = t.match(/^(?:new\s+)?(?:savings\s+)?goal[:\s]+(.+)$|^(?:i\s+)?(?:want|need|plan|would like)\s+to\s+(?:save|put away|set aside|have)\s+(.+)$|^save\s+(?:up\s+)?(.+)$/i);
    if (!m) return null;
    let body = m[1] || m[2] || m[3];
    const amt = amountIn(body);
    if (!amt) return null;
    body = strip(body, amt.match);
    const when = findFutureDate(body, c.today);
    if (when) body = strip(body, when.match);
    const name = body.replace(/^(?:up\s+)?(?:for|towards?|to buy|to get|on)\s+/i, '').replace(/\b(?:for|by|before|a|an|the|my)\b/gi, ' ').replace(/\s+/g, ' ').trim();
    return { type: 'goal', name: cap(unTokenize(name.replace(/"/g, '') || 'Savings', c)), target: amt.cents, deadline: when?.date ?? null };
  },
  (t) => (/^(?:goals?|show (?:my )?goals|my goals|savings goals)\??$/i.test(t) ? { type: 'goals' } : null),

  // planning
  (t, c) => {
    const m = t.match(/\bcan i (?:afford|buy|get|spend)\b(.*)$|\bis it ok(?:ay)? to (?:buy|spend)\b(.*)$|\bshould i buy\b(.*)$/i);
    if (!m) return null;
    let body = m[1] ?? m[2] ?? m[3] ?? '';
    const amt = amountIn(body);
    if (!amt) return { type: 'error', message: 'How much would it cost? e.g. "can I afford a 1,500 laptop in March?"' };
    body = strip(body, amt.match);
    const when = findFutureDate(body, c.today);
    if (when) body = strip(body, when.match);
    const what = body.replace(/^(?:a|an|the|to|for|on)\s+/i, '').replace(/\b(?:a|an|the|for|on|right now|now|today)\b/gi, ' ').replace(/[?]/g, '').replace(/\s+/g, ' ').trim();
    return { type: 'afford', amount: amt.cents, what: what.replace(/"/g, '') || null, date: when?.date ?? null };
  },
  (t) => {
    if (!/\b(?:forecast|projection|project(?:ed)?|outlook|cash ?flow|financial plan|plan ahead|plan for|the plan|future|runway|where will i be|next \d+ months)\b/i.test(t)) return null;
    const m = t.match(/(\d{1,2})\s+months?/i) || t.match(/(\d)\s+years?/i);
    let months = /\b(?:next|a|the|this|coming)\s+year\b|\byear ahead\b/i.test(t) ? 12 : 6;
    if (m) months = /year/i.test(m[0]) ? Number(m[1]) * 12 : Number(m[1]);
    return { type: 'forecast', months: Math.min(Math.max(months, 1), 36) };
  },
  (t) =>
    /^(?:how am i doing|how'?s my money|insights?|report|summary|overview|status|dashboard|advice|tips|analy[sz]e(?: my)?(?: spending| finances)?|health check|financial health)\b/i.test(t)
      ? { type: 'insights' }
      : null,
  (t, c) => {
    if (!/\b(?:how much|what)\b.*\b(?:spen[dt]|spending)\b|\bspending\b|\bwhere\b.*\bmoney\b.*\bgo|\bbreakdown\b/i.test(t)) return null;
    let period = 'this month';
    for (const p of ['last month', 'this year', 'last year', 'this week', 'last week', 'all time', 'ever', 'today']) if (t.toLowerCase().includes(p)) period = p;
    const dm = t.match(/(?:last|past)\s+(\d+)\s+days/i);
    if (dm) period = `last ${dm[1]} days`;
    const cm = t.match(/\bon\s+([a-z][\w-]*)/i);
    const category = cm ? (c.categories.includes(cm[1].toLowerCase()) || cm[1].toLowerCase() in SEED_CATEGORIES ? cm[1].toLowerCase() : c.predictCategory(cm[1]).category) : null;
    return { type: 'spending', period, category };
  },

  // balances & settling
  (t, c) => {
    if (!/\bsimplif|\bsettle (?:everything|all|everyone)\b|\bwho (?:should )?pays? (?:who|whom)\b|\bhow (?:do|should) we settle\b|\bsettlement plan\b/i.test(t)) return null;
    return { type: 'simplify', group: groupIn(t, c)?.id ?? null };
  },
  (t, c) => {
    if (!/\bwho(?:'s| is| should| will)? (?:pay|pays|paying|cover|get)(?: for [\w ]+?)? (?:next|this|the next)|\bwhose turn\b|\bwho pays\??$/i.test(t)) return null;
    const pool = Object.keys(c.tokens).map((k) => c.tokens[k]);
    return { type: 'whoPays', group: groupIn(t, c)?.id ?? null, among: pool };
  },
  (t, c) => {
    let m = t.match(new RegExp(`^(?:settle(?:d)?(?:\\s+up)?|square(?:d)?\\s+up|clear|zero out)\\s+(?:with\\s+|my debt with\\s+|up with\\s+)?(${P})(?:\\s+in full)?$`, 'i'));
    if (!m) m = t.match(new RegExp(`^(${P})\\s+(?:and\\s+i\\s+)?(?:settled|squared)(?:\\s+up)?(?:\\s+with me)?$`, 'i'));
    if (!m) return null;
    const p = person(m[1], c);
    if (!p || p.id === 'me' || p.id.startsWith('new:')) return { type: 'error', message: `I don't know anyone called "${unTokenize(m[1], c)}".` };
    return { type: 'settle', who: p.id };
  },
  (t, c) => {
    const question = /\?$|^(?:how much|what|who|whom|do|does|did|show|list|tell|check|am i|is)\b/i.test(t);
    if (/^(?:show\s+)?(?:my\s+|all\s+)?balances?\??$|^(?:who owes (?:me|what)|what do i owe|whom? do i owe|how much do i owe|how much am i owed|what am i owed|where do i stand|tally)\b/i.test(t) && !Object.keys(c.tokens).length)
      return { type: 'balances' };
    if (!question || !/\bowes?\b|\bowed\b|\bbalance\b|\bstand\b|\bdebt\b|\bsquare\b/i.test(t)) return null;
    const who = Object.values(c.tokens);
    const g = groupIn(t, c);
    if (g) return { type: 'groupBalances', group: g.id };
    return who.length ? { type: 'balanceWith', who } : { type: 'balances' };
  },

  // recurring management
  (t) => (/^(?:recurring|bills|subscriptions|(?:show|list) (?:my )?(?:recurring|bills|subscriptions|repeating)(?: (?:bills|expenses|payments))?)\??$/i.test(t) ? { type: 'recurringList' } : null),
  (t, c) => {
    const m = t.match(/^(?:stop|cancel|end|pause)\s+(?:the\s+|my\s+)?(?:recurring\s+)?(.+?)(?:\s+(?:subscription|bill|recurring|payment))?$/i);
    if (!m) return null;
    return { type: 'stopRecurring', query: unTokenize(m[1], c) };
  },

  // recurring wrapper: "rent 2000 every month on the 1st split with Ali"
  (t, c) => {
    const fm = t.match(/\b(?:every|each)\s+(other\s+week|two\s+weeks|2\s+weeks|week|month|year)\b|\b(weekly|biweekly|fortnightly|monthly|yearly|annually|a\s+month|per\s+month|a\s+year|per\s+year|a\s+week|per\s+week)\b/i);
    if (!fm || !hasAmount(t)) return null;
    const word = (fm[1] || fm[2]).toLowerCase();
    const freq = /other|two|2 weeks|biweekly|fortnight/.test(word) ? 'biweek' : /week/.test(word) ? 'week' : /year|annual/.test(word) ? 'year' : 'month';
    let rest = strip(t, fm[0]);
    let day = null;
    const dm = rest.match(/\b(?:on\s+)?(?:the\s+)?(\d{1,2})(?:st|nd|rd|th)(?:\s+of\s+(?:the|each|every)\s+month)?\b/i);
    if (dm) {
      day = Number(dm[1]);
      rest = strip(rest, dm[0]);
    }
    let start = null;
    const sm = rest.match(/\bstarting\s+(?:on\s+|from\s+)?(.+?)(?=$|,|\s+(?:split|with|for|between)\b)/i);
    if (sm) {
      start = findTxnDate(`on ${sm[1]}`, c.today)?.date ?? findFutureDate(sm[1], c.today)?.date ?? null;
      rest = strip(rest, sm[0]);
    }
    if (!start) {
      if (day && freq === 'month') {
        const [y, m] = c.today.split('-').map(Number);
        const pad = (n) => String(n).padStart(2, '0');
        let cand = `${y}-${pad(m)}-${pad(Math.min(day, daysInMonth(y, m)))}`;
        if (cand < c.today) {
          const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
          cand = `${ny}-${pad(nm)}-${pad(Math.min(day, daysInMonth(ny, nm)))}`;
        }
        start = cand;
      } else start = c.today;
    }
    const inner = incomeRule(rest, c) || expenseRule(rest, c);
    if (!inner || inner.type === 'error') return inner;
    if (inner.type !== 'expense' && inner.type !== 'income') return null;
    if (inner.type === 'expense' && inner.date) delete inner.date;
    return { type: 'recurring', freq, day: freq === 'month' ? day ?? Number(start.slice(8)) : null, start, inner };
  },

  // transfers / loans / IOUs
  (t, c) => transferRule(t, c),
  (t, c) => incomeRule(t, c),
  (t, c) => expenseRule(t, c),
];

/** Whichever side names a known person is the target; the other is the alias. */
function aliasIntent(nameWord, aliasWord, c) {
  const a = unTokenize(nameWord, c).replace(/["']/g, '').trim();
  const b = unTokenize(aliasWord, c).replace(/["']/g, '').trim();
  const ta = c.findPerson(a), tb = c.findPerson(b);
  const [target, alias] =
    ta?.exact && tb?.exact && ta.id === tb.id ? [ta, b] : ta?.exact && !tb?.exact ? [ta, b] : tb?.exact && !ta?.exact ? [tb, a] : [null, null];
  if (!target || target.id === 'me' || !/^[A-Za-z][\w'.-]*(?: [A-Za-z][\w'.-]*)?$/.test(alias)) return null;
  return { type: 'alias', who: target.id, alias };
}

function groupIn(t, c) {
  const groups = [...c.groups].sort((a, b) => b.name.length - a.name.length);
  for (const g of groups) {
    const re = new RegExp(`(?:\\b(?:in|for|on|to|from|within)\\s+(?:the\\s+|our\\s+|my\\s+)?(?:group\\s+)?|#)${escapeRe(g.name)}(?:\\s+group)?\\b`, 'i');
    const m = t.match(re);
    if (m) return { ...g, match: m[0] };
  }
  return null;
}

// ── transfers ──────────────────────────────────────────────────────────────
function transferRule(t, c) {
  const forDesc = (s) => {
    const m = s.match(/\bfor\s+(.+)$/i);
    return m ? m[1].trim() : null;
  };
  const dateOf = (s) => findTxnDate(s, c.today);
  const mk = (fromW, toW, amt, rest, extra = {}) => {
    const from = person(fromW, c), to = person(toW, c);
    if (!from || !to || from.id === to.id || ['us', 'all'].includes(from.id) || ['us', 'all'].includes(to.id)) return null;
    const date = dateOf(rest)?.date ?? null;
    const g = groupIn(rest, c);
    return { type: 'transfer', from: from.id, to: to.id, amount: parseAmount(amt), date, group: g?.id ?? null, note: extra.note ?? null, fuzzy: fuzzyNotes([from, to]) };
  };
  let m;
  // "I owe Ali 20 (for lunch)" — with a reason it is an expense Ali covered for me.
  m = t.match(new RegExp(`^(?:i\\s+)?owe\\s+(${P})\\s+(${AMT})(.*)$`, 'i'));
  if (m) {
    const d = forDesc(m[3]);
    if (d) return expenseRule(`${m[1]} paid ${m[2]} for ${d} for me`, c);
    return mk(m[1], 'me', m[2], m[3], { note: 'IOU' });
  }
  m = t.match(new RegExp(`^(${P})\\s+owes\\s+(me|${P})\\s+(${AMT})(.*)$`, 'i'));
  if (m) {
    const d = forDesc(m[4]);
    if (d) return expenseRule(`${m[2]} paid ${m[3]} for ${d} for ${m[1]}`, c);
    return mk(m[2], m[1], m[3], m[4], { note: 'IOU' });
  }
  // Loans: lender gives money to borrower.
  m = t.match(new RegExp(`^(?:i\\s+)?(?:lent|loaned|fronted|advanced)\\s+(${P})\\s+(${AMT})(.*)$`, 'i'));
  if (m) return mk('me', m[1], m[2], m[3], { note: forDesc(m[3]) || 'Loan' });
  m = t.match(new RegExp(`^(${P})\\s+(?:lent|loaned|fronted|advanced)\\s+(me|${P})\\s+(${AMT})(.*)$`, 'i'));
  if (m) return mk(m[1], m[2], m[3], m[4], { note: forDesc(m[4]) || 'Loan' });
  m = t.match(new RegExp(`^(?:i\\s+)?(?:borrowed)\\s+(${AMT})\\s+from\\s+(${P})(.*)$`, 'i'));
  if (m) return mk(m[2], 'me', m[1], m[3], { note: forDesc(m[3]) || 'Loan' });
  // Repayments: "I paid Ali 30", "I sent Ali 30 back", "Ali paid me back 20", "Ali venmoed Sara 15"
  const VERB = String.raw`(?:paid(?:\s+back)?|repaid|sent|venmoed|zelled|transferred|gave|reimbursed|paid off|returned)`;
  // Repayments only move money between people already in the ledger, so
  // "I paid Comcast 80" stays an expense rather than inventing a friend.
  const known = (w) => person(w, c) && !person(w, c).id.startsWith('new:');
  m = t.match(new RegExp(`^(${P})\\s+${VERB}\\s+(${P})\\s+(?:back\\s+)?(${AMT})(?:\\s+back)?(.*)$`, 'i'));
  if (m && known(m[1]) && known(m[2])) {
    const r = mk(m[1], m[2], m[3], m[4], { note: forDesc(m[4]) });
    if (r) return r;
  }
  m = t.match(new RegExp(`^(${P})\\s+${VERB}\\s+(${AMT})\\s+(?:back\\s+)?to\\s+(${P})(.*)$`, 'i'));
  if (m && known(m[1]) && known(m[3])) {
    const r = mk(m[1], m[3], m[2], m[4], { note: forDesc(m[4]) });
    if (r) return r;
  }
  m = t.match(new RegExp(`^(?:i\\s+)?(?:got|received)\\s+(${AMT})\\s+(?:back\\s+)?from\\s+(${P})(.*)$`, 'i'));
  if (m && known(m[2])) return mk(m[2], 'me', m[1], m[3], { note: forDesc(m[3]) });
  return null;
}

// ── income ─────────────────────────────────────────────────────────────────
function incomeRule(t, c) {
  if (!/\b(?:earned|earn|salary|paycheck|pay ?check|income|got paid|get paid|was paid|i made|i make|received|receive|bonus|dividends?|interest|refund|cashback|freelance|wages?|side hustle|revenue|commission|tips? earned|stipend|allowance)\b/i.test(t))
    return null;
  if (/\b(?:@p\d+)\b/.test(t) && /\bfrom\s+@p\d+/.test(t)) return null; // money from a friend is a transfer
  const amt = amountIn(t);
  if (!amt) return null;
  let rest = strip(t, amt.match);
  const date = findTxnDate(rest, c.today);
  if (date) rest = strip(rest, date.match);
  const src =
    rest.match(/\bfrom\s+(?:my\s+|the\s+)?(.+?)$/i)?.[1] ||
    (/\b(?:get|got|was|getting) paid\b/i.test(rest) ? 'paycheck' : null) ||
    rest.match(/\b(salary|paycheck|bonus|dividends?|interest|refund|cashback|freelance(?: work)?|commission|stipend|allowance|wages?|side hustle)\b/i)?.[1] ||
    'Income';
  return { type: 'income', amount: amt.cents, source: cap(unTokenize(src.replace(/\b(?:i|got|paid|earned|received|a|an|the|my)\b/gi, '').trim() || 'Income', c)), date: date?.date ?? null };
}

// ── expenses ───────────────────────────────────────────────────────────────
function expenseRule(input, c) {
  let w = ` ${input} `;
  // A quoted description is taken verbatim (this is how canonical commands and
  // learned templates carry free text that contains numbers or names).
  let quoted = null;
  const q = w.match(/"([^"]+)"/);
  if (q) {
    quoted = q[1].trim();
    w = strip(w, q[0]);
  }
  if (!hasAmount(w)) return null;
  const notes = [];

  // 1. Meta: date, group, category, payment method.
  const date = findTxnDate(w, c.today);
  if (date) w = strip(` ${w} `, date.match);
  const group = groupIn(w, c);
  if (group) w = strip(w, group.match);
  let category = null;
  const cm = w.match(/#([a-z][\w-]*)\b/i) || w.match(/\b(?:category|cat|categori[sz]ed? as|under)\s*[:=]?\s*([a-z][\w-]*)\b/i);
  if (cm) {
    category = cm[1].toLowerCase();
    w = strip(w, cm[0]);
  }
  let method = null;
  const mm =
    w.match(/\b(?:via|using|through|by)\s+(?:my\s+)?(venmo|zelle|paypal|cash ?app|apple pay|google pay|cash|check|bank transfer|wire|[\w-]+\s+(?:card|account))\b/i) ||
    w.match(/\b(?:with|on|from)\s+(?:my\s+)?([\w-]+(?:\s+[\w-]+)?\s+(?:card|account|credit card|debit card))\b/i) ||
    w.match(/\b(?:with|in)\s+(cash|venmo|zelle|paypal)\b/i);
  if (mm) {
    method = mm[1].replace(/\b\w/g, (x) => x.toUpperCase());
    w = strip(w, mm[0]);
  }

  // 2. Explicit split values: "me 150, Ali 100, Sara 50" / "Ali 30%, me 70%".
  const pairRe = new RegExp(String.raw`(?<![\w@])(${P})\s*(?:[:=-]|owes|gets|pays)?\s*(${AMT})\s*(%|percent|shares?|parts?)?`, 'gi');
  const pairs = [];
  if (/\bsplit\b|:|%|\bshares?\b|\bowes\b|,/.test(w)) {
    for (const m of w.matchAll(pairRe)) {
      if (/^(?:paid|spent|for|on|of|is|was|split|by|and|with|it|total)$/i.test(m[1])) continue;
      const p = person(m[1], c);
      if (!p || ['us', 'all'].includes(p.id)) continue;
      pairs.push({ p, raw: m[0].trim(), value: m[3] ? parseFloat(m[2].replace(/[^\d.]/g, '')) : parseAmount(m[2]), unit: m[3] ? (/%|percent/i.test(m[3]) ? 'percent' : 'shares') : 'exact' });
    }
  }
  let split = { type: 'equal' };
  let pairParticipants = null;
  if (pairs.length >= 2) {
    const unit = pairs.some((x) => x.unit === 'percent') ? 'percent' : pairs.some((x) => x.unit === 'shares') || /\bshares?\b/i.test(w) ? 'shares' : 'exact';
    split = { type: unit, values: Object.fromEntries(pairs.map((x) => [x.p.id, unit === 'shares' && x.unit === 'exact' ? x.value / 100 : x.value])) };
    pairParticipants = pairs.map((x) => x.p);
    for (const x of pairs) w = strip(w, x.raw);
    w = w.replace(/\bsplit(?:\s+(?:it|as|like|by))?(?:\s+(?:follows|shares|this))?\s*:?/i, ' ').replace(/\s*,\s*(?=,|$)/g, ' ');
  }
  const ratio = w.match(/\bsplit\s+(?:it\s+)?(\d{1,3}(?:\s*\/\s*\d{1,3})+)\b/i);
  if (ratio) w = strip(w, ratio[0]).replace(/^\s*/, ' split ');

  // "Ali and I split a 30 cab" — the people before "split" share it.
  let leadSplit = null;
  const ls = w.match(new RegExp(String.raw`^\s*(${LIST})\s+split\b`, 'i'));
  if (ls && !pairParticipants) {
    const list = personList(ls[1], c);
    if (list && list.length > 1) {
      leadSplit = list;
      w = strip(w, ls[0]);
    }
  }
  w = w.replace(/\b(?:split\s+)?\d+\s+ways?\b/i, ' split ');
  // "lunch with Ali 30, he paid" — resolve the pronoun after participants.
  let pronounPaid = false;
  const pp = w.match(/(?:^|,)\s*(?:he|she|they)\s+(?:paid|covered|got it|picked it up)\b/i);
  if (pp) {
    pronounPaid = true;
    w = strip(w, pp[0]);
  }

  // 3. Payers. Several "X paid N" clauses = a multi-payer bill.
  const multi = [...w.matchAll(new RegExp(`(?<![\\w@])(${P})\\s+(?:paid|put in|covered|chipped in)\\s+(${AMT})`, 'gi'))];
  let payers = null;
  if (multi.length >= 2) {
    payers = [];
    for (const m of multi) {
      const p = person(m[1], c);
      if (!p || ['us', 'all'].includes(p.id)) return { type: 'error', message: `Who is "${m[1]}"?` };
      payers.push({ p, amount: parseAmount(m[2]) });
      w = strip(w, m[0]);
    }
  }
  let payer = { id: 'me' };
  if (!payers) {
    const PAY = String.raw`(?:just\s+)?(?:paid|spent|covered|bought|got|grabbed|picked up|put down|dropped|ordered|booked|purchased|treated (?:us|everyone)?(?:\s+to)?|is paying|will pay|pays|paying|paid for|footed)`;
    let m = w.match(new RegExp(`^\\s*(${P})\\s+${PAY}\\b`, 'i'));
    if (m) {
      const p = person(m[1], c, { strict: true });
      if (p && !['us', 'all'].includes(p.id)) {
        payer = p;
        w = strip(w, m[0]);
      } else if (/^i$/i.test(m[1])) w = strip(w, m[0]);
    } else if ((m = w.match(new RegExp(`\\b(?:paid|covered|bought|booked|picked up|footed)\\s+by\\s+(${P})`, 'i')))) {
      const p = person(m[1], c);
      if (p && !['us', 'all'].includes(p.id)) {
        payer = p;
        w = strip(w, m[0]);
      }
    } else if ((m = w.match(/(?:^|,|\s)(@p\d+)\s+(?:paid|covered|got it|is paying|will pay|pays|picked it up)\b/i))) {
      payer = person(m[1], c);
      w = strip(w, m[0]);
    } else if ((m = w.match(/(?:^|,)\s*(?:i|me)\s+(?:paid|covered|got it)\b/i))) w = strip(w, m[0]);
  }

  // 4. Participants.
  let participants = null;
  let mode = null;
  const tryList = (re, kind, opts) => {
    for (const m of w.matchAll(re)) {
      const list = personList(m[2] ?? m[1], c, opts);
      if (list) {
        w = strip(w, m[0]);
        return { list, kind: m[2] ? m[1].toLowerCase() : kind };
      }
    }
    return null;
  };
  if (leadSplit) participants = leadSplit;
  else if (!pairParticipants) {
    const found =
      tryList(new RegExp(String.raw`\bsplit\s+(?:it\s+|that\s+|this\s+|the bill\s+)?(?:equally\s+|evenly\s+|50\/50\s+)?(with|between|among|amongst)\s+(${LIST})`, 'gi')) ||
      tryList(new RegExp(String.raw`\b(between|among|amongst)\s+(${LIST})`, 'gi')) ||
      tryList(new RegExp(String.raw`\b(with)\s+(${LIST})`, 'gi')) ||
      tryList(new RegExp(String.raw`\b(for)\s+(${LIST})(?=\s*(?:$|,|\s+(?:split|equally|evenly|and|on)\b))`, 'gi'), 'for', { strict: true });
    if (found) {
      participants = found.list;
      mode = found.kind;
    }
  } else participants = pairParticipants;

  // 5. Amount.
  let amount = null;
  const am = amountIn(w);
  if (am) {
    amount = am.cents;
    w = strip(w, am.match);
  }
  if (payers) {
    const paidTotal = payers.reduce((a, x) => a + x.amount, 0);
    if (amount && amount !== paidTotal) return { type: 'error', message: `The payers add up to ${paidTotal / 100}, but the total says ${amount / 100}.` };
    amount = paidTotal;
  }
  if (split.type === 'exact') {
    const s = Object.values(split.values).reduce((a, b) => a + b, 0);
    if (!amount) amount = s;
    else if (s !== amount) {
      // One person left out of an exact list takes the remainder.
      return { type: 'error', message: `The shares add up to ${s / 100} but the total is ${amount / 100}.` };
    }
  }
  if (!amount) return null;

  // 6. Resolve participant set.
  const payerIds = payers ? payers.map((x) => x.p.id) : [payer.id];
  let set;
  if (participants) {
    set = [];
    for (const p of participants) {
      if (p.id === 'us') set.push('me', ...payerIds);
      else if (p.id === 'all') {
        if (!group) return { type: 'error', message: 'Which group is "everyone"? Add "in <group name>".' };
        set.push(...group.members);
      } else set.push(p.id);
    }
    if (mode === 'with') set.unshift(...payerIds); // payer first: "split 60/40 with Ali" = you 60
  } else if (group) set = [...group.members];
  else if (payerIds.length > 1 || payer.id !== 'me') set = [...payerIds, 'me'];
  else set = ['me'];
  set = [...new Set(set)];
  if (pronounPaid) {
    const others = set.filter((x) => x !== 'me');
    if (others.length !== 1) return { type: 'error', message: 'Who is “he/she/they”? Name who paid, e.g. “Ali paid”.' };
    payer = { id: others[0] };
  }
  if (ratio) {
    const nums = ratio[1].split('/').map((x) => Number(x.trim()));
    if (nums.length !== set.length) return { type: 'error', message: `A ${ratio[1]} split needs ${nums.length} people; I count ${set.length}.` };
    const total = nums.reduce((a, b) => a + b, 0);
    split = { type: total === 100 ? 'percent' : 'shares', values: Object.fromEntries(set.map((id, i) => [id, nums[i]])) };
  }

  // 7. Description = whatever meaningful words remain. A person or pronoun
  // left over means some clause went unread — flag the parse as low
  // confidence so a smarter reader (the AI fallback) gets a look first.
  const lowConfidence = !quoted && (/@p\d+|\b(?:me|him|her|them|you|us)\b/i.test(w) || w.trim().split(/\s+/).length > 7);
  let desc = unTokenize(w, c)
    .replace(/\b(?:i|we|paid|pay|spent|spend|split|it|equally|evenly|for|on|at|the|a|an|some|our|my|total|of|and|was|cost|costs|bill|in)\b/gi, ' ')
    .replace(/[,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (quoted) desc = cap(quoted);
  if (!desc) desc = category ? cap(category) : 'Expense';
  const fuzzy = fuzzyNotes([payer, ...(payers || []).map((x) => x.p), ...(participants || [])]);
  if (fuzzy.length) notes.push(...fuzzy);

  return {
    type: 'expense',
    amount,
    description: cap(desc),
    category,
    payers: payers ? payers.map((x) => ({ id: x.p.id, amount: x.amount })) : [{ id: payer.id, amount }],
    participants: set,
    split,
    date: date?.date ?? null,
    group: group?.id ?? null,
    method,
    fuzzy: notes,
    lowConfidence,
  };
}

function unTokenize(s, c) {
  return s.replace(/@(p\d+)/g, (_, id) => c.people.find((p) => p.id === id)?.name ?? id);
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const _internal = { tokenizePeople, personList, expenseRule, addDays };

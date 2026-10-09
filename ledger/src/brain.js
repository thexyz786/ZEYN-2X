// The self-improving layer. Three things are learned, all persisted in
// state.brain and all inspectable with "what have you learned":
//
//   1. Category sense — every categorised expense teaches word→category
//      weights; uncategorised expenses are then predicted from them.
//   2. Phrasing — when a sentence is understood only via the AI fallback or an
//      explicit `teach`, it is generalised into a template (numbers, names and
//      quoted text become slots). The next sentence of that shape is handled
//      locally: instantly, offline, at zero cost.
//   3. Forecast calibration — see planner.js; predictions are scored against
//      what actually happened and a correction factor is learned.

import { AMOUNT_RE_SRC } from './money.js';
import { normalize } from './text.js';

const STOP = new Set(
  'a an the and or of for to with on in at by from my our me i we us some this that it is was paid pay split'.split(' '),
);

export const SEED_CATEGORIES = {
  food: 'dinner lunch breakfast brunch restaurant pizza tacos sushi burger burgers cafe coffee starbucks takeout doordash ubereats meal food drinks bar beer snacks dessert',
  groceries: 'grocery groceries costco walmart trader joes supermarket market wholefoods aldi kroger safeway produce',
  transport: 'uber lyft taxi cab gas fuel petrol parking metro train bus toll tolls car carwash',
  housing: 'rent mortgage deposit landlord lease furniture repairs',
  utilities: 'electricity electric power water internet wifi phone utilities gas-bill trash sewer cable',
  entertainment: 'movie movies cinema netflix spotify hulu disney concert tickets game games bowling show subscription',
  travel: 'hotel flight flights airbnb trip vacation airfare luggage resort',
  shopping: 'amazon clothes shoes target mall gift gifts electronics laptop phone-case',
  health: 'doctor dentist pharmacy gym medicine medical insurance therapy clinic',
  education: 'books course tuition school class',
};

export class Brain {
  constructor(state) {
    this.b = state.brain;
  }
  get stats() {
    return this.b.stats;
  }

  // ── 1. categories ──────────────────────────────────────────────────────
  predictCategory(description) {
    const words = tokens(description);
    if (!words.length) return { category: 'general', confidence: 0 };
    const score = {};
    for (const w of words) {
      for (const [cat, list] of Object.entries(SEED_CATEGORIES)) if (list.split(' ').includes(w)) score[cat] = (score[cat] || 0) + 1;
      // Learned evidence outweighs the seed list: it is this user's own usage.
      for (const [cat, n] of Object.entries(this.b.categoryWords[w] || {})) score[cat] = (score[cat] || 0) + 3 * n;
    }
    const ranked = Object.entries(score).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) return { category: 'general', confidence: 0 };
    const total = ranked.reduce((a, [, v]) => a + v, 0);
    return { category: ranked[0][0], confidence: ranked[0][1] / total };
  }
  learnCategory(description, category, weight = 1) {
    for (const w of tokens(description)) {
      const row = (this.b.categoryWords[w] ??= {});
      row[category] = (row[category] || 0) + weight;
    }
  }

  // ── 2. phrasing templates ─────────────────────────────────────────────
  /**
   * Generalise (phrase → canonical commands) into a reusable template.
   * `names` are the person names/aliases the ledger knows, so they can become
   * slots. Returns the template, or null if the phrase was too specific or
   * too generic to be safe to reuse.
   */
  learnTemplate(phrase, canonicals, names, source, texts = []) {
    const slots = [];
    let pattern = escapeRe(collapse(phrase));
    let outputs = canonicals.map(collapse);

    const slot = (literal, kind, quoteOut = false) => {
      const lit = escapeRe(escapeRe(literal)); // pattern text is already escaped once
      const re = new RegExp(`(^|[^\\w])${lit}(?=$|[^\\w])`, 'i');
      if (!re.test(pattern)) return;
      if (!outputs.some((o) => o.toLowerCase().includes(literal.toLowerCase()))) return;
      const key = `s${slots.length}`;
      slots.push({ key, kind });
      pattern = pattern.replace(re, `$1@@${key}@@`);
      const outRe = new RegExp(`(^|[^\\w])${escapeRe(literal)}(?=$|[^\\w])`, 'gi');
      // Unquoted free text is re-emitted quoted so a longer description that
      // happens to contain "with" or a number cannot be misread later.
      outputs = outputs.map((o) =>
        o.replace(outRe, (all, pre, off, str) => (quoteOut && str[off + all.length] !== '"' && pre !== '"' ? `${pre}"{${key}}"` : `${pre}{${key}}`)),
      );
    };

    // Quoted descriptions in the canonical form become free-text slots.
    for (const c of canonicals) for (const m of c.matchAll(/"([^"]+)"/g)) slot(m[1], 'text');
    // Descriptions the parser extracted (unquoted in the canonical form).
    for (const t of texts) if (t && !/^(expense|income|savings)$/i.test(t)) slot(t, 'text', true);
    // Amounts: the number as it appears in the phrase.
    for (const m of collapse(phrase).matchAll(new RegExp(AMOUNT_RE_SRC, 'gi'))) {
      const num = m[0].replace(/[^\d.]/g, '');
      if (num && outputs.some((o) => o.includes(num))) slotNumber(m[0], num);
    }
    // People.
    for (const n of [...names].sort((a, b) => b.length - a.length)) slot(n, 'name');

    function slotNumber(asWritten, num) {
      const key = `s${slots.length}`;
      const lit = escapeRe(escapeRe(asWritten)); // pattern is already escaped once
      const re = new RegExp(lit);
      if (!re.test(pattern)) return;
      slots.push({ key, kind: 'amount' });
      pattern = pattern.replace(re, `@@${key}@@`);
      outputs = outputs.map((o) => o.replace(new RegExp(`(?<![\\d.])${escapeRe(num)}(?![\\d.])`), `{${key}}`));
    }

    const literalWords = pattern.replace(/@@s\d+@@/g, ' ').replace(/\\/g, '').match(/[a-z]{3,}/gi) || [];
    if (!slots.length || !literalWords.length) return null; // nothing general, or nothing anchoring

    const regexSrc =
      '^' +
      pattern.replace(/@@(s\d+)@@/g, (_, k) => {
        const kind = slots.find((s) => s.key === k).kind;
        if (kind === 'amount') return `(?<${k}>${AMOUNT_RE_SRC})`;
        if (kind === 'name') return `(?<${k}>[A-Za-z][\\w'.-]*(?: [A-Z][\\w'.-]*)?)`;
        return `(?<${k}>.+?)`;
      }) +
      '[.!]?$';

    const existing = this.b.templates.find((t) => t.regex === regexSrc);
    if (existing) return existing;
    const t = { regex: regexSrc, outputs, slots, example: phrase, source, hits: 0, fails: 0, createdAt: new Date().toISOString() };
    this.b.templates.push(t);
    this.b.stats.learned += 1;
    return t;
  }

  /** Rewrite text through the best matching learned template, if any. */
  applyTemplates(text) {
    const s = collapse(text);
    const live = this.b.templates.filter((t) => t.fails < 3).sort((a, b) => b.hits - a.hits);
    for (const t of live) {
      let m;
      try {
        m = s.match(new RegExp(t.regex, 'i'));
      } catch {
        continue;
      }
      if (!m) continue;
      const outputs = t.outputs.map((o) => o.replace(/\{(s\d+)\}/g, (_, k) => {
        const v = m.groups?.[k] ?? '';
        const kind = t.slots.find((x) => x.key === k)?.kind;
        return kind === 'amount' ? v.replace(/[^\d.k]/gi, '') : v;
      }));
      return { template: t, outputs };
    }
    return null;
  }
  scoreTemplate(t, ok) {
    if (ok) t.hits += 1;
    else t.fails += 1;
  }

  recordMiss(text) {
    this.b.stats.misses += 1;
    this.b.misses.push({ text, at: new Date().toISOString() });
    if (this.b.misses.length > 200) this.b.misses.shift();
  }
  forgetMiss(text) {
    this.b.misses = this.b.misses.filter((m) => m.text !== text);
  }
}

export const tokens = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/'s$/, ''))
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d/.test(w));

const collapse = (s) => normalize(s);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

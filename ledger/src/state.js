// The shape of a ledger, shared by the Node file store and the web page.

export const SCHEMA_VERSION = 1;

export function emptyState() {
  return {
    version: SCHEMA_VERSION,
    currency: 'USD',
    seq: 0,
    people: { me: { id: 'me', name: 'You', aliases: [] } },
    groups: {},
    expenses: [],
    transfers: [],
    income: [],
    budgets: {}, // category -> monthly cents
    recurring: [],
    goals: [],
    imports: [], // one summary per imported statement: { at, account, from, to, added, skipped }
    cash: null, // { amount, date } — an anchor the planner rolls forward
    brain: {
      categoryWords: {}, // word -> { category: weight }
      templates: [], // learned phrase -> canonical command rewrites
      misses: [], // phrases nothing understood (for review / teaching)
      calibration: { factor: 1, history: [] }, // forecast vs. actual
      stats: { messages: 0, ruleHits: 0, templateHits: 0, aiHits: 0, learned: 0, misses: 0, undos: 0 },
    },
  };
}

/** Fill in anything a file written by an older build is missing. */
export function migrate(state) {
  const base = emptyState();
  for (const k of Object.keys(base)) if (state[k] === undefined) state[k] = base[k];
  for (const k of Object.keys(base.brain)) if (state.brain[k] === undefined) state.brain[k] = base.brain[k];
  for (const k of Object.keys(base.brain.stats)) state.brain.stats[k] ??= 0;
  state.version = SCHEMA_VERSION;
  return state;
}

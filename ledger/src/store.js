import fs from 'node:fs';
import path from 'node:path';

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

/** JSON-file persistence with atomic writes and a bounded undo stack beside it. */
export class FileStore {
  constructor(file) {
    this.file = path.resolve(file);
    this.undoFile = this.file.replace(/\.json$/, '') + '.undo.json';
  }
  load() {
    if (!fs.existsSync(this.file)) return emptyState();
    const state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    return migrate(state);
  }
  save(state) {
    writeAtomic(this.file, JSON.stringify(state, null, 2));
  }
  loadUndo() {
    try {
      return JSON.parse(fs.readFileSync(this.undoFile, 'utf8'));
    } catch {
      return [];
    }
  }
  saveUndo(stack) {
    writeAtomic(this.undoFile, JSON.stringify(stack));
  }
}

/** In-memory store for tests and embedding. */
export class MemoryStore {
  constructor(state = emptyState()) {
    this.state = JSON.parse(JSON.stringify(state));
    this.undo = [];
  }
  load() {
    return JSON.parse(JSON.stringify(this.state));
  }
  save(state) {
    this.state = JSON.parse(JSON.stringify(state));
  }
  loadUndo() {
    return this.undo;
  }
  saveUndo(stack) {
    this.undo = stack;
  }
}

function writeAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Fill in anything a file written by an older build is missing. */
function migrate(state) {
  const base = emptyState();
  for (const k of Object.keys(base)) if (state[k] === undefined) state[k] = base[k];
  for (const k of Object.keys(base.brain)) if (state.brain[k] === undefined) state.brain[k] = base.brain[k];
  for (const k of Object.keys(base.brain.stats)) state.brain.stats[k] ??= 0;
  state.version = SCHEMA_VERSION;
  return state;
}

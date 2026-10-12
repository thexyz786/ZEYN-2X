import fs from 'node:fs';
import path from 'node:path';
import { emptyState, migrate } from './state.js';

export { emptyState };

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

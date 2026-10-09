#!/usr/bin/env node
// Usage:
//   ledger                      interactive chat in the terminal
//   ledger "I paid 60 for dinner with Ali"   one command, then exit
//   ledger serve [--port 4747]  web app at http://localhost:4747
// Data lives in ./data/ledger.json unless LEDGER_DATA points elsewhere.

import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Assistant } from '../src/assistant.js';
import { FileStore } from '../src/store.js';
import { createServer } from '../src/server.js';
import { aiEnabled } from '../src/ai.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataFile = process.env.LEDGER_DATA || path.join(root, 'data', 'ledger.json');
const assistant = new Assistant(new FileStore(dataFile));
const args = process.argv.slice(2);

const plain = (s) => s.replace(/\*\*(.+?)\*\*/g, '\x1b[1m$1\x1b[0m').replace(/(^|\s)_(.+?)_(?=\s|$)/gm, '$1\x1b[2m$2\x1b[0m').replace(/`([^`]+)`/g, '\x1b[36m$1\x1b[0m');

if (args[0] === 'serve') {
  const pi = args.indexOf('--port');
  const port = Number(pi >= 0 ? args[pi + 1] : process.env.PORT || 4747);
  const host = process.env.HOST || '127.0.0.1';
  createServer(assistant).listen(port, host, () => {
    console.log(`Ledger running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`Data: ${dataFile} · AI fallback: ${aiEnabled() ? 'on' : 'off'}`);
  });
} else if (args.length) {
  const r = await assistant.handle(args.join(' '));
  console.log(plain(r.reply));
} else {
  console.log(plain(`**Ledger** — tell me what happened. "help" for examples, Ctrl+D to quit.\n_Data: ${dataFile}_`));
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '› ' });
  rl.prompt();
  rl.on('line', async (line) => {
    rl.pause();
    if (line.trim()) console.log(plain((await assistant.handle(line)).reply) + '\n');
    rl.resume();
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
}

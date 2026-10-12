// Bundle the ledger engine into one self-contained HTML page (web/app.html →
// dist/ledger.html) for publishing as a claude.ai Artifact. The engine source
// is used unchanged; only src/ai.js is swapped for web/ai-browser.js.
//   node scripts/build-web.mjs [outFile]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const grammar = read('src/ai.js').match(/export const GRAMMAR = (`[\s\S]*?`);/)[1];

// Dependency order (no cycles).
const MODULES = [
  ['./text.js', 'src/text.js'],
  ['./state.js', 'src/state.js'],
  ['./money.js', 'src/money.js'],
  ['./dates.js', 'src/dates.js'],
  ['./ledger.js', 'src/ledger.js'],
  ['./brain.js', 'src/brain.js'],
  ['./parser.js', 'src/parser.js'],
  ['./planner.js', 'src/planner.js'],
  ['./importer.js', 'src/importer.js'],
  ['./ai.js', 'web/ai-browser.js'],
  ['./assistant.js', 'src/assistant.js'],
];

function wrap(spec, file) {
  let src = read(file);
  if (file.endsWith('ai-browser.js')) src = src.replace('__GRAMMAR__', grammar);
  src = src.replace(/import\s*\{([^}]*)\}\s*from\s*'([^']+)';/g, (_, names, from) => {
    const binds = names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => n.replace(/\s+as\s+/, ': '));
    return `const { ${binds.join(', ')} } = __mods[${JSON.stringify(from)}];`;
  });
  const exported = [];
  src = src.replace(/^export\s+(const|let|function|class|async function)\s+([A-Za-z_$][\w$]*)/gm, (_, kind, name) => {
    exported.push(name);
    return `${kind} ${name}`;
  });
  if (/^\s*(import|export)\b/m.test(src)) throw new Error(`Unhandled import/export in ${file}`);
  return `__mods[${JSON.stringify(spec)}] = (() => {\n${src}\nreturn { ${exported.join(', ')} };\n})();`;
}

const bundle = `const __mods = {};\n${MODULES.map(([s, f]) => wrap(s, f)).join('\n\n')}\nconst Engine = __mods['./assistant.js'];\nconst AI = __mods['./ai.js'];
const State = __mods['./state.js'];`;
const html = read('web/app.html').replace('/*__ENGINE__*/', () => bundle);
const out = process.argv[2] || path.join(root, 'dist', 'ledger.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`Wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);

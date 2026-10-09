import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_BODY = 64 * 1024;

/**
 * Local HTTP server: the web UI plus a two-endpoint JSON API.
 *   GET  /api/dashboard           → everything the UI renders
 *   POST /api/command {text}      → { reply, dashboard }
 * Commands are serialised through one queue so two quick messages can never
 * interleave their reads and writes of the ledger file.
 */
export function createServer(assistant) {
  let queue = Promise.resolve();
  const serial = (fn) => (queue = queue.then(fn, fn));

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/dashboard') {
        return json(res, 200, await serial(() => assistant.dashboard()));
      }
      if (req.method === 'POST' && url.pathname === '/api/command') {
        const body = JSON.parse((await readBody(req)) || '{}');
        if (typeof body.text !== 'string' || !body.text.trim()) return json(res, 400, { error: 'text is required' });
        const out = await serial(async () => {
          const r = await assistant.handle(body.text.slice(0, 4000));
          return { reply: r.reply, sources: r.results.map((x) => x.source), dashboard: assistant.dashboard() };
        });
        return json(res, 200, out);
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(path.join(PUBLIC, 'index.html')));
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  });
}

function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('request too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

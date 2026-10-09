// Money is stored as integer minor units (cents) everywhere. Floats never touch
// a balance; they appear only at the parse boundary and the display boundary.

export const AMOUNT_RE_SRC =
  String.raw`(?:[$€£₹]\s?)?\d[\d,]*(?:\.\d{1,2})?(?:\s?k\b)?(?:\s?(?:usd|dollars?|bucks|eur|euros?|gbp|pounds|inr|rupees|rs)\b)?`;

/** "$1,234.50" | "1.2k" | "20 bucks" -> cents (integer), or null. */
export function parseAmount(raw) {
  if (raw == null) return null;
  let t = String(raw).toLowerCase().trim();
  t = t.replace(/\s?(usd|dollars?|bucks|eur|euros?|gbp|pounds|inr|rupees|rs)$/, '');
  t = t.replace(/[$€£₹,\s]/g, '');
  let mult = 1;
  if (t.endsWith('k')) {
    mult = 1000;
    t = t.slice(0, -1);
  }
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(t)) return null;
  const cents = Math.round(parseFloat(t) * 100 * mult);
  return Number.isFinite(cents) ? cents : null;
}

/**
 * Split `total` cents across `weights` so the parts sum exactly to `total`.
 * Largest-remainder method; ties go to the earlier index, so results are
 * deterministic (the same expense always splits the same way).
 */
export function allocate(total, weights) {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) throw new Error('Split weights must be positive');
  const raw = weights.map((w) => (total * w) / sum);
  const parts = raw.map((r) => Math.floor(r));
  let rest = total - parts.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, frac: r - Math.floor(r) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (let k = 0; rest > 0; k = (k + 1) % order.length, rest--) parts[order[k].i]++;
  return parts;
}

const formatters = new Map();
export function fmt(cents, currency = 'USD') {
  if (!formatters.has(currency)) {
    let f;
    try {
      f = new Intl.NumberFormat('en-US', { style: 'currency', currency });
    } catch {
      f = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    formatters.set(currency, f);
  }
  return formatters.get(currency).format((cents || 0) / 100);
}

export const sumValues = (obj) => Object.values(obj || {}).reduce((a, b) => a + b, 0);

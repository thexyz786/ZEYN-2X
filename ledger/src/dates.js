// Calendar dates are plain 'YYYY-MM-DD' strings. All arithmetic runs in UTC so
// a date never drifts across a timezone or DST boundary.

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const MONTH_RE_SRC =
  String.raw`(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)`;
const WEEKDAY_RE_SRC = String.raw`(?:sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|rsday|urday|sday)?`;

const pad = (n) => String(n).padStart(2, '0');
export const toISO = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
export const fromISO = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
export const localToday = (now = new Date()) =>
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

export function addDays(iso, n) {
  const d = fromISO(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toISO(d);
}
export const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-based

/** Add months, clamping the day (Jan 31 + 1 month = Feb 28/29). */
export function addMonths(iso, n, preferredDay) {
  const [y, m, d] = iso.split('-').map(Number);
  const idx = y * 12 + (m - 1) + n;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  const day = Math.min(preferredDay || d, daysInMonth(ny, nm));
  return `${ny}-${pad(nm)}-${pad(day)}`;
}
export const monthKey = (iso) => iso.slice(0, 7);
export const monthStart = (iso) => `${iso.slice(0, 7)}-01`;
export function monthEnd(iso) {
  const [y, m] = iso.split('-').map(Number);
  return `${y}-${pad(m)}-${pad(daysInMonth(y, m))}`;
}
export function monthsBetween(fromIso, toIso) {
  const [y1, m1] = fromIso.split('-').map(Number);
  const [y2, m2] = toIso.split('-').map(Number);
  return (y2 - y1) * 12 + (m2 - m1);
}
export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1][0].toUpperCase()}${MONTHS[m - 1].slice(1)} ${y}`;
}
const monthIndex = (word) => MONTHS.indexOf(word.toLowerCase().slice(0, 3));

/**
 * Find a past/present transaction date inside free text.
 * Returns { date, match } where `match` is the exact substring consumed.
 */
export function findTxnDate(text, today) {
  const rules = [
    [/\b(?:on\s+)?(\d{4}-\d{2}-\d{2})\b/i, (m) => m[1]],
    [/\b(?:on\s+)?today\b/i, () => today],
    [/\b(?:on\s+)?yesterday\b/i, () => addDays(today, -1)],
    [/\b(?:on\s+)?the\s+day\s+before\s+yesterday\b/i, () => addDays(today, -2)],
    [/\b(\d{1,3})\s+days?\s+ago\b/i, (m) => addDays(today, -Number(m[1]))],
    [/\b(?:a|one)\s+week\s+ago\b|\blast\s+week\b/i, () => addDays(today, -7)],
    [
      new RegExp(String.raw`\b(?:on\s+|last\s+)(${WEEKDAY_RE_SRC})\b`, 'i'),
      (m) => {
        const target = WEEKDAYS.indexOf(m[1].toLowerCase().slice(0, 3));
        const cur = fromISO(today).getUTCDay();
        const back = (cur - target + 7) % 7 || 7;
        return addDays(today, -back);
      },
    ],
    [
      new RegExp(String.raw`\b(?:on\s+)?(${MONTH_RE_SRC})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b`, 'i'),
      (m) => pastDate(today, monthIndex(m[1]) + 1, Number(m[2]), m[3] && Number(m[3])),
    ],
    [
      new RegExp(String.raw`\b(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_RE_SRC})\b(?:,?\s+(\d{4}))?`, 'i'),
      (m) => pastDate(today, monthIndex(m[2]) + 1, Number(m[1]), m[3] && Number(m[3])),
    ],
    [
      /\bon\s+(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i,
      (m) => pastDate(today, Number(m[1]), Number(m[2]), m[3] && (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]))),
    ],
  ];
  for (const [re, fn] of rules) {
    const m = text.match(re);
    if (m) {
      const date = fn(m);
      if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return { date, match: m[0] };
    }
  }
  return null;
}

function pastDate(today, month, day, year) {
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31)) return null;
  let y = year || Number(today.slice(0, 4));
  let iso = `${y}-${pad(month)}-${pad(Math.min(day, daysInMonth(y, month)))}`;
  if (!year && iso > today) iso = `${y - 1}-${pad(month)}-${pad(Math.min(day, daysInMonth(y - 1, month)))}`;
  return iso;
}

/**
 * Find a future target date ("by June 2027", "in March", "in 3 months",
 * "next month", "by end of year"). Returns { date, match } with `date` set to
 * the END of the target month — a plan "by June" means by the end of June.
 */
export function findFutureDate(text, today) {
  const rules = [
    [/\b(?:by|before|on|in)?\s*(\d{4})-(\d{2})(?:-(\d{2}))?\b/i, (m) => m[3] ? `${m[1]}-${m[2]}-${m[3]}` : monthEnd(`${m[1]}-${m[2]}-01`)],
    [/\b(?:in|within)\s+(\d{1,3})\s+months?\b/i, (m) => monthEnd(addMonths(today, Number(m[1])))],
    [/\b(?:in|within)\s+(\d{1,2})\s+years?\b/i, (m) => monthEnd(addMonths(today, 12 * Number(m[1])))],
    [/\b(?:in|within)\s+a\s+year\b/i, () => monthEnd(addMonths(today, 12))],
    [/\bnext\s+month\b/i, () => monthEnd(addMonths(monthStart(today), 1))],
    [/\b(?:this\s+month|end\s+of\s+(?:the\s+)?month)\b/i, () => monthEnd(today)],
    [
      /\b(?:by|before|in|for|until)?\s*(?:the\s+)?(next\s+|this\s+)?(summer|fall|autumn|winter|spring)\b/i,
      (m) => {
        // A season deadline means by the end of its first month: money in hand as it begins.
        const md = { spring: '03-31', summer: '06-30', fall: '09-30', autumn: '09-30', winter: '12-31' }[m[2].toLowerCase()];
        let y = Number(today.slice(0, 4));
        if (/next/i.test(m[1] || '') || `${y}-${md}` < today) y += 1;
        return `${y}-${md}`;
      },
    ],
    [/\bnext\s+year\b/i, () => `${Number(today.slice(0, 4)) + 1}-12-31`],
    [/\b(?:by\s+)?(?:the\s+)?end\s+of\s+(?:the\s+|this\s+)?year\b/i, () => `${today.slice(0, 4)}-12-31`],
    [
      new RegExp(String.raw`\b(?:by|before|in|on|for|until)?\s*(${MONTH_RE_SRC})\.?(?:\s+(\d{1,2})(?:st|nd|rd|th)?)?(?:,?\s+(\d{4}))?\b`, 'i'),
      (m) => {
        const mon = monthIndex(m[1]) + 1;
        let y = m[3] ? Number(m[3]) : Number(today.slice(0, 4));
        if (!m[3] && `${y}-${pad(mon)}` < today.slice(0, 7)) y += 1;
        const base = `${y}-${pad(mon)}-01`;
        return m[2] ? `${y}-${pad(mon)}-${pad(Math.min(Number(m[2]), daysInMonth(y, mon)))}` : monthEnd(base);
      },
    ],
  ];
  for (const [re, fn] of rules) {
    const m = text.match(re);
    if (m && m[0].trim()) {
      // A bare month word must be a real month mention, not "may" the verb.
      if (/^\s*may\s*$/i.test(m[0])) continue;
      const date = fn(m);
      if (date) return { date, match: m[0].trim() };
    }
  }
  return null;
}

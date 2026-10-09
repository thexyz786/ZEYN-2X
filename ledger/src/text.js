/** One normalisation for everything that reads user text, so a phrase that is
 *  learned and a phrase that is later matched are compared like for like. */
export function normalize(input) {
  return String(input || '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!]+$/, '')
    .replace(/(^|\s)w\/\s*/gi, '$1with ');
}

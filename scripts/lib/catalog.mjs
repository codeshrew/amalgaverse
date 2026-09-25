// Rule-based cataloguing of a new beat, used when no generative model is available
// (e.g. in CI without an Anthropic key). It recognises the shapes Mallozzi uses:
//   "<Name> suggests/pitches/favors … "  → one option per advocate
//   "CONTACT ONE - … (The Ghost Ship)"   → one option per contact
//   "Pick a row, A through D"            → lettered rows
//   "Yes/No"                             → yes / no
// A later run with an LLM replaces these entries (they are marked "heuristic").

const VERBS = 'suggests|pitches|offers|favors|favours|considers|proposes|recommends|argues|wants|advises|urges|insists|thinks|believes|prefers|votes|would rather|isn[’\']t a fan|is not a fan|points out';
const TITLES = '(?:Captain|Commander|Colonel|Major|Dr\\.|Doctor|Lieutenant|Ambassador|Constable|Chief|Mr\\.|Ms\\.)\\s+';
const ADVOCATE = new RegExp(`^(?:${TITLES})?([A-Z][\\w’'.-]+(?:\\s[A-Z][\\w’'-]+)?)\\s+(?:${VERBS})\\b`);
const slug = (s) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const firstSentence = (p) => (p.match(/^.*?[.!?](?=\s|$)/)?.[0] || p).slice(0, 220);
const ORD = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'];

export function heuristicCatalog(text) {
  const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  const question = [...paras].reverse().find((p) => /\?\s*$/.test(p) && p.length < 200) || null;
  let options = [];

  const rows = text.match(/\b(?:pick|choose|select)\s+a\s+row,?\s+([A-H])\s+(?:through|to|-)\s+([A-H])\b/i);
  if (rows) {
    const [a, z] = [rows[1].toUpperCase().charCodeAt(0), rows[2].toUpperCase().charCodeAt(0)];
    for (let c = a; c <= z; c++) {
      const L = String.fromCharCode(c);
      options.push({ key: L, letter: L, label: `Row ${L}`, summary: '', keywords: [`row ${L.toLowerCase()}`, `option ${L.toLowerCase()}`] });
    }
  }
  if (!options.length && /\byes\s*\/\s*no\b/i.test(text)) {
    options = [
      { key: 'yes', label: 'Yes', summary: '', keywords: ['yes', 'yep', 'yeah', 'aye', 'absolutely', 'engage'] },
      { key: 'no', label: 'No', summary: '', keywords: ['no', 'nope', 'nah'] },
    ];
  }
  if (!options.length) {
    for (const p of paras) {
      const m = p.match(/^CONTACT\s+(\w+)\s*[-–—:]/i);
      if (!m) continue;
      const name = p.match(/\(([^)]+)\)\s*$/)?.[1];
      const n = ORD.indexOf(m[1].toLowerCase()) + 1;
      options.push({
        key: slug(name || `contact-${m[1]}`),
        label: `Contact ${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()}${name ? ` — ${name}` : ''}`,
        summary: firstSentence(p.replace(/^CONTACT\s+\w+\s*[-–—:]\s*/i, '')),
        keywords: [name?.toLowerCase(), `contact ${m[1].toLowerCase()}`, n ? `contact ${n}` : null, n ? String(n) : null].filter(Boolean),
      });
    }
  }
  if (!options.length) {
    for (const p of paras) {
      const m = p.match(ADVOCATE);
      if (!m) continue;
      const name = m[1].replace(/[’']s$/, '');
      const key = slug(name.split(' ').pop());
      if (options.some((o) => o.key === key)) continue;
      options.push({ key, label: name, summary: firstSentence(p), keywords: [name.toLowerCase(), name.split(' ').pop().toLowerCase()] });
    }
  }
  return { question, options: options.length >= 2 ? options : [] };
}

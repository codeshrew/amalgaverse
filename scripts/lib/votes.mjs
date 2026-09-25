// Turn a pile of replies into a vote tally. Two classifiers:
//  - heuristic: keyword/letter matching from the beat's option definitions (always available)
//  - llm: the local `claude` CLI reads each reply against the options (much better with
//         free-form "I'd go with the big guy because..." answers)
// Only aggregate numbers + a short reasoning summary leave this module; individual
// replies stay in the local cache.
import { askJson, llmAvailable } from './llm.mjs';

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function cleanText(text) {
  return text
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^(\s*@\w+)+/g, ' ') // leading @mentions from the reply chain
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export function heuristicVote(rawText, options) {
  const s = cleanText(rawText).toLowerCase();
  if (!s) return null;
  const scores = Object.fromEntries(options.map((o) => [o.key, 0]));

  for (const o of options) {
    if (o.letter) {
      const L = o.letter.toLowerCase();
      const lead = L === 'a' ? '(?=[.!,:;)\\-]|$)' : '(?=[\\s.!,:;)\\-]|$)';
      if (new RegExp(`^(?:row|option|team|line)?\\s*[("']?${L}[)"']?${lead}`).test(s)) scores[o.key] += 5;
      if (new RegExp(`(?:^|\\s)${o.letter}[.!)]*$`).test(cleanText(rawText))) scores[o.key] += 3;
      if (new RegExp(`\\b(?:row|option|team|line)\\s*[("']?${L}\\b`).test(s)) scores[o.key] += 4;
    }
    for (const kwRaw of o.keywords || []) {
      const kw = kwRaw.toLowerCase().replace(/[’‘]/g, "'");
      const short = kw.length <= 3 || /^\d+$/.test(kw);
      if (short) {
        if (new RegExp(`^${esc(kw)}(?![\\w'])`).test(s)) scores[o.key] += 3;
        continue;
      }
      const re = new RegExp(`(?<![\\w])${esc(kw)}(?![\\w])`);
      const m = re.exec(s);
      if (m) scores[o.key] += m.index < 50 ? 2 : 1;
    }
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] === 0) return null;
  if (ranked[1] && ranked[1][1] === ranked[0][1]) return null; // ambiguous
  return ranked[0][0];
}

/** One vote per account: keep each voter's most recent reply that expresses a choice. */
export function dedupeVoters(replies, author) {
  const byUser = new Map();
  const sorted = [...replies].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  for (const r of sorted) {
    if (!r.author_screen_name || r.author_screen_name.toLowerCase() === author.toLowerCase()) continue;
    const prev = byUser.get(r.author_screen_name);
    byUser.set(r.author_screen_name, prev ? { ...r, earlier: [...(prev.earlier || []), prev] } : r);
  }
  return [...byUser.values()];
}

function optionBlock(beat) {
  return beat.options.map((o) => `- ${o.key}: ${o.label} — ${o.summary}`).join('\n');
}

async function llmClassify(beat, replies) {
  const out = {};
  const CHUNK = 120;
  for (let i = 0; i < replies.length; i += CHUNK) {
    const chunk = replies.slice(i, i + CHUNK);
    const lines = chunk.map((r, j) => `${j}\t${cleanText(r.text).slice(0, 350).replace(/\t/g, ' ')}`).join('\n');
    const prompt = `You are tallying votes for an interactive choose-your-own-adventure story on X (Twitter). Fans vote by replying.

THE DECISION: ${beat.question}
OPTIONS:
${optionBlock(beat)}

Story text for context (abridged):
"""${beat.text.slice(0, 2500)}"""

Below are fan replies, one per line as "<index>\\t<text>". For each reply decide which option key it votes for.
Use "none" if the reply doesn't clearly choose (jokes, questions, off-topic, or explicitly split votes). If someone proposes a creative alternative that is closest to one option, pick that option; if it matches none, use "other".

REPLIES:
${lines}

Respond with ONLY a JSON object mapping each index to an option key, e.g. {"0":"${beat.options[0]?.key}","1":"none"}.`;
    const res = await askJson(prompt, { model: 'haiku' });
    chunk.forEach((r, j) => {
      const v = res[String(j)];
      out[r.id] = beat.options.some((o) => o.key === v) ? v : v === 'other' ? 'other' : null;
    });
  }
  return out;
}

async function llmSummarize(beat, voters, votes, tally) {
  const sample = {};
  for (const r of voters) {
    const v = votes[r.id];
    if (!v || v === 'other') continue;
    (sample[v] ||= []).push(cleanText(r.text).slice(0, 220));
  }
  const blocks = beat.options
    .map((o) => `### ${o.key} (${tally[o.key] || 0} votes) — ${o.label}\n${(sample[o.key] || []).slice(0, 40).map((t) => `- ${t}`).join('\n') || '(no votes)'}`)
    .join('\n\n');
  const prompt = `Fans voted by reply on this choose-your-own-adventure decision: "${beat.question}"

Here are the vote counts and a sample of the replies, grouped by the option they chose:

${blocks}

Write a spoiler-free "fleet sentiment" readout in the voice of a ship's computer briefing (crisp, a little wry, no emojis, never quote anyone or name any account).
Respond with ONLY JSON:
{"headline": "<max 14 words summarising where the vote stands>",
 "reasons": {"<option key>": "<one sentence: the main reasoning of people who picked it; omit keys with no votes>"},
 "wildcards": "<one sentence on notable alternative ideas or recurring jokes, or empty string>"}`;
  return askJson(prompt, { model: 'sonnet' });
}

/**
 * @returns {{total:number, counted:number, unclear:number, other:number,
 *   tally:Record<string,number>, method:string, leader:string|null, margin:number,
 *   headline?:string, reasons?:Record<string,string>, wildcards?:string}}
 */
export async function tallyVotes(beat, replies, { author, cache = {} } = {}) {
  const voters = dedupeVoters(replies, author);
  let votes = {};
  let method = 'keywords';

  if (llmAvailable() && voters.length) {
    try {
      const known = cache.votes || {};
      const todo = voters.filter((r) => !(r.id in known));
      const fresh = todo.length ? await llmClassify(beat, todo) : {};
      votes = { ...known, ...fresh };
      method = 'ai';
    } catch (err) {
      console.warn(`  ! AI vote classification failed (${err.message}); falling back to keywords`);
      votes = {};
    }
  }
  if (method === 'keywords') {
    for (const r of voters) votes[r.id] = heuristicVote(r.text, beat.options);
  }

  // A voter's earlier reply might hold the actual vote if the latest is chatter.
  const tally = Object.fromEntries(beat.options.map((o) => [o.key, 0]));
  let unclear = 0;
  let other = 0;
  for (const r of voters) {
    let v = votes[r.id];
    if (!v && method === 'keywords') {
      for (const e of [...(r.earlier || [])].reverse()) {
        v = heuristicVote(e.text, beat.options);
        if (v) break;
      }
    }
    if (v === 'other') other++;
    else if (v && v in tally) tally[v]++;
    else unclear++;
  }
  const counted = Object.values(tally).reduce((a, b) => a + b, 0);
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  const result = {
    total: replies.length,
    voters: voters.length,
    counted,
    unclear,
    other,
    tally,
    method,
    leader: ranked[0]?.[1] > 0 ? ranked[0][0] : null,
    margin: ranked.length > 1 ? ranked[0][1] - ranked[1][1] : ranked[0]?.[1] || 0,
  };

  if (method === 'ai' && counted >= 5) {
    const prev = cache.summary;
    const stale = !prev || !prev.counted || counted >= prev.counted * 1.08 || (beat.closed && !prev.final);
    if (stale) {
      try {
        const s = await llmSummarize(beat, voters, votes, tally);
        cache.summary = { ...s, counted, final: !!beat.closed };
      } catch (err) {
        console.warn(`  ! summary failed: ${err.message}`);
      }
    }
    if (cache.summary) Object.assign(result, { headline: cache.summary.headline, reasons: cache.summary.reasons, wildcards: cache.summary.wildcards });
  }
  cache.votes = votes;
  return result;
}

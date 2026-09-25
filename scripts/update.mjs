#!/usr/bin/env node
// Pulls the latest #Amalgaverse posts, replies (votes) and recaps, tallies the
// votes, and writes site/data/story.json (+ story.js so index.html also works
// straight from disk).
//
//   node scripts/update.mjs            # full update (uses local `claude` CLI for vote reading if present)
//   node scripts/update.mjs --no-llm   # keyword-only vote counting
//   node scripts/update.mjs --all      # re-fetch replies for every beat, not just recent ones
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { AUTHOR, fetchTweet, fetchTimeline, sleep } from './lib/x.mjs';
import { fetchReplies } from './lib/replies.mjs';
import { tallyVotes } from './lib/votes.mjs';
import { askJson, llmAvailable } from './lib/llm.mjs';

const root = new URL('../', import.meta.url).pathname;
const P = {
  curation: root + 'data/curation.json',
  crew: root + 'data/crew.json',
  story: root + 'site/data/story.json',
  storyJs: root + 'site/data/story.js',
  cache: root + '.cache/',
};
const ALL = process.argv.includes('--all');
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2) + '\n');
mkdirSync(P.cache + 'replies', { recursive: true });
mkdirSync(P.cache + 'votes', { recursive: true });
mkdirSync(root + 'site/data', { recursive: true });

const log = (...a) => console.log('›', ...a);
const HOUR = 3600_000;

const curation = readJson(P.curation, { beats: {} });
const crew = readJson(P.crew, { crew: [] });
const prevStory = readJson(P.story, { beats: [], dispatches: [] });
const tweetCache = readJson(P.cache + 'tweets.json', {});

// ---------------------------------------------------------------- discovery
log('Scanning @' + AUTHOR + ' timeline…');
let timeline = [];
try {
  timeline = await fetchTimeline(AUTHOR, 3);
} catch (e) {
  console.warn('  ! timeline unavailable:', e.message);
}
log(`  ${timeline.length} recent posts`);
for (const t of timeline) tweetCache[t.id] = { ...t, fetchedAt: Date.now() };

const beatIds = new Set(Object.keys(curation.beats));

// A new beat is a full #Amalgaverse installment by the author that quotes a known
// beat. Side chatter ("the vote is close…") can quote a beat too, so require the
// installment shape: a long post with a visual. Walk forward so missed days link up.
const looksLikeInstallment = (t) => t.media?.length > 0 && t.text.length > 300;
let grew = true;
while (grew) {
  grew = false;
  for (const t of timeline) {
    if (beatIds.has(t.id) || t.replyingTo || t.author?.toLowerCase() !== AUTHOR.toLowerCase()) continue;
    if (t.quoteId && beatIds.has(t.quoteId) && /#amalgaverse/i.test(t.text) && looksLikeInstallment(t)) {
      beatIds.add(t.id);
      grew = true;
      log('New beat discovered:', t.id, t.text.split('\n')[0]);
    }
  }
}

// Fetch/refresh beat posts. Old posts rarely change; refresh recent ones.
async function getTweet(id, maxAgeMs) {
  const c = tweetCache[id];
  if (c && Date.now() - (c.fetchedAt || 0) < maxAgeMs) return c;
  try {
    const t = await fetchTweet(id);
    tweetCache[id] = { ...t, fetchedAt: Date.now() };
    await sleep(250);
    return tweetCache[id];
  } catch (e) {
    console.warn(`  ! could not fetch ${id}: ${e.message}`);
    return c || null;
  }
}

// Also walk the quote chain backwards from every beat so nothing is skipped.
const queue = [...beatIds];
const beatsRaw = {};
while (queue.length) {
  const id = queue.shift();
  if (beatsRaw[id]) continue;
  const recent = tweetCache[id] && Date.now() - new Date(tweetCache[id].createdAt) < 4 * 24 * HOUR;
  const t = await getTweet(id, recent || !tweetCache[id] ? 20 * 60_000 : 7 * 24 * HOUR);
  if (!t) continue;
  beatsRaw[id] = t;
  if (t.quoteId && !beatIds.has(t.quoteId) && /#amalgaverse|amalgaverse/i.test(tweetCache[t.quoteId]?.text || t.text)) {
    // quoted post is part of the chain (every beat quotes its predecessor)
    beatIds.add(t.quoteId);
    queue.push(t.quoteId);
  }
}

const ordered = Object.values(beatsRaw).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
const successor = {};
for (const t of ordered) if (t.quoteId && beatsRaw[t.quoteId]) successor[t.quoteId] = t.id;
const newest = ordered.at(-1);

// Author's self-replies ("PREVIOUSLY ON…", crew manifest) and other #Amalgaverse chatter.
const recaps = {};
const dispatches = [];
const byId = Object.fromEntries(timeline.map((t) => [t.id, t]));
for (const t of timeline) {
  if (t.author?.toLowerCase() !== AUTHOR.toLowerCase() || beatIds.has(t.id)) continue;
  if (t.replyingTo && beatIds.has(t.replyingTo)) {
    (recaps[t.replyingTo] ||= []).push(t);
  } else if (t.replyingTo && byId[t.replyingTo]?.replyingTo && beatIds.has(byId[t.replyingTo].replyingTo)) {
    (recaps[byId[t.replyingTo].replyingTo] ||= []).push(t); // reply-to-recap (manifest)
  } else if (!t.replyingTo && /amalgaverse/i.test(t.text)) {
    dispatches.push({ id: t.id, url: t.url, createdAt: t.createdAt, text: t.text, media: t.media, stats: t.stats });
  }
}
// keep older dispatches we saw on previous runs
for (const d of prevStory.dispatches || []) if (!dispatches.some((x) => x.id === d.id)) dispatches.push(d);
dispatches.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

// ------------------------------------------------------------ curation (AI)
const ORD = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10, eleventh: 11, twelfth: 12 };
function parseHeader(text) {
  const first = text.split('\n')[0].replace(/#\w+/g, '').trim();
  const m = first.match(/^(\w+)\s+Mission:\s*(.+?)(?:\s*\((?:Part|Act)\s*(\d+)\))?\s*$/i);
  if (m) return { mission: m[2].trim(), missionNumber: ORD[m[1].toLowerCase()] ?? null, part: m[3] ? +m[3] : null, headline: first };
  return { mission: null, missionNumber: null, part: null, headline: first };
}

async function autoCurate(t, prevBeat) {
  const h = parseHeader(t.text);
  const base = { auto: true, kind: 'decision', mission: h.mission || prevBeat?.mission || 'Unknown', missionNumber: h.missionNumber ?? prevBeat?.missionNumber ?? null, part: h.part ?? prevBeat?.part ?? null, title: h.headline, question: null, options: [], canon: null };
  if (!llmAvailable()) return { base, previousCanon: null };
  const prevBlock = prevBeat?.options?.length
    ? `The PREVIOUS post asked: "${prevBeat.question}" with options:\n${prevBeat.options.map((o) => `- ${o.key}: ${o.label} — ${o.summary}`).join('\n')}\nFrom the NEW post's opening, determine which previous option the story actually followed.`
    : 'There is no previous decision to resolve; set previousCanon to null.';
  const prompt = `You are cataloguing an interactive choose-your-own-adventure story that runs as daily posts on X. Each post describes a situation and ends with a decision for fans ("Choose!").

NEW POST:
"""${t.text}"""

${prevBlock}

Return ONLY JSON:
{"kind": "decision" or "briefing" (briefing = no choice asked),
 "title": "<evocative 2-5 word chapter title for this beat, e.g. 'The Hangar Doors'>",
 "question": "<the decision fans are asked, one sentence>",
 "options": [{"key": "<short lowercase slug, e.g. the advocate's name or 'a'>", "label": "<Who/what — short action, max 7 words>", "summary": "<one sentence: what it means and the risk>", "keywords": ["<6-12 lowercase words/phrases a fan might use in a reply to pick this option>"], "letter": "<A/B/C/D only if fans are asked to pick a lettered row/option, else omit>"}],
 "previousCanon": "<key of the previous option the story followed, or null>",
 "awayTeam": ["<short names of characters currently on the away team, if stated or clearly implied; else empty>"],
 "missionName": "<mission name without the ordinal, e.g. 'The Ghost Ship', or null>"}`;
  try {
    const r = await askJson(prompt, { model: 'sonnet' });
    return {
      base: { ...base, kind: r.kind || 'decision', title: r.title || base.title, question: r.question || null, options: r.options || [], awayTeam: r.awayTeam?.length ? r.awayTeam : undefined, mission: h.mission || r.missionName || base.mission },
      previousCanon: r.previousCanon ?? null,
    };
  } catch (e) {
    console.warn('  ! auto-curation failed:', e.message);
    return { base, previousCanon: null };
  }
}

let prevCur = null;
for (const t of ordered) {
  let cur = curation.beats[t.id];
  if (!cur || (cur.auto && !cur.options?.length && llmAvailable())) {
    log('Cataloguing new beat', t.id, '…');
    const { base, previousCanon } = await autoCurate(t, prevCur);
    cur = curation.beats[t.id] = base;
    const match = prevCur?.options?.find((o) => String(o.key).toLowerCase() === String(previousCanon).toLowerCase());
    if (match && (prevCur.auto || !prevCur.canon)) prevCur.canon = match.key;
  }
  prevCur = cur;
}
curation.head = newest?.id ?? curation.head;
writeJson(P.curation, curation);

// ------------------------------------------------------------------- votes
const beats = [];
let missionBeatCounter = {};
for (const t of ordered) {
  const cur = curation.beats[t.id] || {};
  const next = successor[t.id] || null;
  const isDecision = cur.kind !== 'briefing';
  const status = !isDecision ? 'briefing' : next ? 'closed' : 'open';
  const mkey = cur.mission || 'Unknown';
  missionBeatCounter[mkey] = (missionBeatCounter[mkey] || 0) + 1;

  const beat = {
    id: t.id,
    url: t.url,
    createdAt: t.createdAt,
    closesAt: status === 'open' ? new Date(new Date(t.createdAt).getTime() + 24 * HOUR).toISOString() : null,
    kind: cur.kind || 'decision',
    status,
    mission: mkey,
    missionNumber: cur.missionNumber ?? null,
    part: cur.part ?? null,
    beatInMission: missionBeatCounter[mkey],
    title: cur.title || parseHeader(t.text).headline,
    headline: parseHeader(t.text).headline,
    question: cur.question || null,
    options: (cur.options || []).map(({ keywords, ...o }) => o),
    canon: cur.canon ?? null,
    awayTeam: cur.awayTeam || null,
    text: t.text,
    media: t.media,
    stats: t.stats,
    prev: t.quoteId && beatsRaw[t.quoteId] ? t.quoteId : null,
    next,
    recap: (recaps[t.id] || []).map((r) => ({ id: r.id, url: r.url, text: r.text, media: r.media })),
    votes: null,
  };
  if (!beat.recap.length) beat.recap = prevStory.beats?.find((b) => b.id === t.id)?.recap || [];

  if (isDecision && cur.options?.length) {
    const replyFile = `${P.cache}replies/${t.id}.json`;
    const voteFile = `${P.cache}votes/${t.id}.json`;
    const stored = readJson(replyFile, { fetchedAt: 0, replies: [] });
    const ageH = (Date.now() - new Date(t.createdAt)) / HOUR;
    const needFetch = ALL || !stored.fetchedAt || (ageH < 50 && Date.now() - stored.fetchedAt > 15 * 60_000) || (ageH >= 50 && !stored.final);
    if (needFetch) {
      log(`Fetching replies for "${beat.title}" (${t.stats.replies} reported)…`);
      try {
        const fresh = await fetchReplies(t.id);
        if (fresh.meta?.nitterErrors?.length && !fresh.meta.nitterInstance) console.warn("  ! nitter unavailable:", fresh.meta.nitterErrors.slice(0, 2).join("; "));
        const merged = new Map(stored.replies.map((r) => [r.id, r]));
        for (const r of fresh) merged.set(r.id, r);
        stored.replies = [...merged.values()];
        stored.fetchedAt = Date.now();
        stored.final = ageH >= 50;
        writeJson(replyFile, stored);
        log(`  ${fresh.length} fetched, ${stored.replies.length} cached`);
      } catch (e) {
        console.warn('  ! reply fetch failed:', e.message);
      }
    }
    if (stored.replies.length) {
      const vcache = readJson(voteFile, {});
      beat.votes = await tallyVotes({ ...cur, id: t.id, text: t.text, closed: status === 'closed', canon: cur.canon }, stored.replies, { author: AUTHOR, cache: vcache });
      beat.votes.reported = t.stats.replies;
      beat.votes.asOf = new Date(stored.fetchedAt).toISOString();
      writeJson(voteFile, vcache);
    } else {
      beat.votes = prevStory.beats?.find((b) => b.id === t.id)?.votes || null;
    }
  }
  beats.push(beat);
}

// ------------------------------------------------------------------ output
const missions = [];
for (const b of beats) {
  let m = missions.at(-1);
  if (!m || m.name !== b.mission) missions.push((m = { name: b.mission, number: b.missionNumber, beats: [] }));
  m.beats.push(b.id);
}

const story = {
  generatedAt: new Date().toISOString(),
  series: {
    title: 'The Amalgaverse',
    showrunner: 'Joseph Mallozzi',
    handle: AUTHOR,
    profile: `https://x.com/${AUTHOR}`,
    schedule: 'New beat daily at 12:01 PM ET · 24 hours to vote · majority rules',
    ship: crew.ship?.name,
  },
  missions,
  beats,
  dispatches: dispatches.slice(0, 30),
  crew: crew.crew,
  assets: crew.ship?.assets || [],
  manifestImage: crew.manifestImage,
};
writeJson(P.story, story);
writeFileSync(P.storyJs, `window.AMALGAVERSE = ${JSON.stringify(story)};\n`);
writeJson(P.cache + 'tweets.json', tweetCache);
log(`Wrote ${beats.length} beats across ${missions.length} missions → site/data/story.json`);

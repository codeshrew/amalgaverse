#!/usr/bin/env node
// Work packets for the Claude cloud routine (see AGENT_TASKS.md).
//
// GitHub Actions does the mechanical work (fetching, Jev vote reading, deploying).
// The routine does the parts that need a generative model, as Claude itself:
//   - catalogue new beats properly (title, question, options, away team)
//   - write the "fleet sentiment" readout for each vote
//
//   node scripts/agent-tasks.mjs prepare   # → .cache/agent/tasks.json (+ reply samples)
//   node scripts/agent-tasks.mjs apply     # validates .cache/agent/out/*.json → data/*.json
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { fetchReplies } from './lib/replies.mjs';
import { dedupeVoters, cleanText } from './lib/votes.mjs';

const root = new URL('../', import.meta.url).pathname;
const DIR = root + '.cache/agent/';
const OUT = DIR + 'out/';
const PAGES = process.env.AMALGA_PAGES || 'https://codeshrew.github.io/amalgaverse/';
const AUTHOR = 'BaronDestructo';
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2) + '\n');

async function prepare() {
  mkdirSync(OUT, { recursive: true });
  const res = await fetch(`${PAGES}data/story.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`published story.json: HTTP ${res.status}`);
  const story = await res.json();
  const curation = readJson(root + 'data/curation.json', { beats: {} });
  const summaries = readJson(root + 'data/summaries.json', {});
  const byId = Object.fromEntries(story.beats.map((b) => [b.id, b]));
  const tasks = [];

  for (const b of story.beats) {
    const cur = curation.beats[b.id];
    if (cur && cur.auto && (cur.heuristic || !cur.options?.length)) {
      const prev = b.prev && byId[b.prev];
      tasks.push({
        type: 'catalog',
        id: b.id,
        output: `.cache/agent/out/${b.id}.catalog.json`,
        post_text: b.text,
        current_rule_based_entry: { title: cur.title, question: cur.question, options: cur.options },
        previous_decision: prev ? { question: prev.question, options: prev.options.map(({ key, label }) => ({ key, label })), canon: prev.canon } : null,
      });
    }
  }

  for (const b of story.beats) {
    const v = b.votes;
    if (b.kind === 'briefing' || !v?.counted || v.counted < 5) continue;
    const s = summaries[b.id];
    const stale =
      !s || s.leader !== v.leader || (b.status === 'closed' && !s.final) || (b.status === 'open' && v.counted >= (s.counted || 0) * 1.08);
    if (!stale) continue;
    let replies = [];
    try {
      replies = dedupeVoters(await fetchReplies(b.id), AUTHOR, b.id);
    } catch (e) {
      console.warn(`  ! replies for ${b.id}: ${e.message}`);
    }
    if (!replies.length) continue;
    const sampleFile = `.cache/agent/replies-${b.id}.txt`;
    const lines = replies
      .sort((a, c) => (c.likes || 0) - (a.likes || 0))
      .slice(0, 180)
      .map((r) => `- ${cleanText(r.text).slice(0, 240)}`);
    writeFileSync(root + sampleFile, lines.join('\n') + '\n');
    const ranked = Object.entries(v.tally).sort((a, c) => c[1] - a[1]);
    tasks.push({
      type: 'summary',
      id: b.id,
      output: `.cache/agent/out/${b.id}.summary.json`,
      question: b.question,
      options: b.options.map(({ key, label, summary }) => ({ key, label, summary })),
      official_tally: v.tally,
      ranking: ranked.map(([k, n]) => `${k}=${n}`).join(', '),
      leader: v.leader,
      status: b.status,
      canon: b.canon,
      reply_sample_file: sampleFile,
      reply_sample_size: lines.length,
      counted: v.counted,
    });
  }

  writeJson(DIR + 'tasks.json', { generatedAt: new Date().toISOString(), tasks });
  console.log(`${tasks.length} task(s): ${tasks.map((t) => `${t.type}:${t.id}`).join(', ') || 'nothing to do'}`);
}

function apply() {
  const tasks = readJson(DIR + 'tasks.json', { tasks: [] }).tasks;
  const curation = readJson(root + 'data/curation.json', { beats: {} });
  const summaries = readJson(root + 'data/summaries.json', {});
  let changed = 0;
  for (const t of tasks) {
    const file = root + t.output;
    if (!existsSync(file)) {
      console.warn(`  - no output for ${t.type}:${t.id}`);
      continue;
    }
    const o = JSON.parse(readFileSync(file, 'utf8'));
    if (t.type === 'catalog') {
      const opts = (o.options || []).filter((x) => x.key && x.label);
      if (opts.length < 2 || !o.title || !o.question) throw new Error(`catalog ${t.id}: needs title, question and ≥2 options`);
      const prev = curation.beats[t.id] || {};
      curation.beats[t.id] = {
        ...prev,
        auto: true,
        heuristic: false,
        catalogedBy: 'claude-routine',
        title: o.title,
        question: o.question,
        options: opts.map(({ key, label, summary, keywords, letter }) => ({ key: String(key), label, summary: summary || '', keywords: keywords || [], ...(letter ? { letter } : {}) })),
        ...(o.awayTeam?.length ? { awayTeam: o.awayTeam } : {}),
      };
      changed++;
    } else if (t.type === 'summary') {
      if (!o.headline) throw new Error(`summary ${t.id}: missing headline`);
      const keys = new Set(t.options.map((x) => x.key));
      const reasons = Object.fromEntries(Object.entries(o.reasons || {}).filter(([k]) => keys.has(k)));
      summaries[t.id] = { headline: o.headline, reasons, wildcards: o.wildcards || '', counted: t.counted, final: t.status === 'closed', leader: t.leader, method: 'jev', by: 'claude-routine' };
      changed++;
    }
  }
  writeJson(root + 'data/curation.json', curation);
  writeJson(root + 'data/summaries.json', summaries);
  console.log(`applied ${changed} result(s)`);
}

const cmd = process.argv[2];
if (cmd === 'prepare') await prepare();
else if (cmd === 'apply') apply();
else {
  console.error('usage: node scripts/agent-tasks.mjs prepare|apply');
  process.exit(1);
}

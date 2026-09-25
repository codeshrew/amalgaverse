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
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fetchReplies } from './lib/replies.mjs';
import { dedupeVoters, cleanText } from './lib/votes.mjs';

const root = new URL('../', import.meta.url).pathname;
const DIR = root + '.cache/agent/';
const OUT = DIR + 'out/';
const PAGES = process.env.AMALGA_PAGES || 'https://codeshrew.github.io/amalgaverse/';
const AUTHOR = 'BaronDestructo';
const readJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
const writeJson = (f, v) => writeFileSync(f, JSON.stringify(v, null, 2) + '\n');

const LOCAL = process.argv.includes('--local');

async function loadStory() {
  if (LOCAL) return readJson(root + 'site/data/story.json', null);
  const res = await fetch(`${PAGES}data/story.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`published story.json: HTTP ${res.status}`);
  return res.json();
}

// --local (CI, right after update.mjs): use the replies already cached on disk.
async function loadReplies(id) {
  if (LOCAL) return readJson(root + `.cache/replies/${id}.json`, { replies: [] }).replies;
  return fetchReplies(id);
}

async function prepare() {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const story = await loadStory();
  if (!story) throw new Error('no story data');
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
      replies = dedupeVoters(await loadReplies(b.id), AUTHOR, b.id);
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

// The cloud routine's sandbox can only reach github.com, so CI ships the work packet
// on the `agent-packets` branch. It's encrypted (AES-256-GCM, key in the
// AGENT_PACKET_KEY secret and the routine prompt) because it holds reply text,
// which this public repo never publishes.
function key() {
  const k = process.env.AGENT_PACKET_KEY;
  if (!k || !/^[0-9a-f]{64}$/i.test(k)) throw new Error('AGENT_PACKET_KEY (64 hex chars) is required');
  return Buffer.from(k, 'hex');
}

function pack(outFile) {
  const files = {};
  for (const name of readdirSync(DIR)) if (/^(tasks\.json|replies-\d+\.txt)$/.test(name)) files[name] = readFileSync(DIR + name, 'utf8');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([c.update(JSON.stringify(files)), c.final()]);
  writeJson(outFile, { v: 1, createdAt: new Date().toISOString(), iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') });
  console.log(`packed ${Object.keys(files).length} file(s) → ${outFile}`);
}

function unpack() {
  const raw = execFileSync('git', ['show', 'FETCH_HEAD:packet.json'], { cwd: root, encoding: 'utf8' });
  const p = JSON.parse(raw);
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(p.iv, 'base64'));
  d.setAuthTag(Buffer.from(p.tag, 'base64'));
  const files = JSON.parse(Buffer.concat([d.update(Buffer.from(p.data, 'base64')), d.final()]).toString('utf8'));
  mkdirSync(OUT, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(DIR + name, body);
  const tasks = JSON.parse(files['tasks.json'] || '{"tasks":[]}').tasks;
  console.log(`packet from ${p.createdAt}: ${tasks.length} task(s): ${tasks.map((t) => `${t.type}:${t.id}`).join(', ') || 'nothing to do'}`);
}

const cmd = process.argv[2];
if (cmd === 'prepare') await prepare();
else if (cmd === 'apply') apply();
else if (cmd === 'pack') pack(process.argv[3] || DIR + 'packet.json');
else if (cmd === 'unpack') unpack();
else {
  console.error('usage: node scripts/agent-tasks.mjs prepare [--local] | apply | pack [file] | unpack   (unpack expects: git fetch origin agent-packets)');
  process.exit(1);
}

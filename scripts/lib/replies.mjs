#!/usr/bin/env node
// replies.mjs - fetch replies to an X/Twitter post without the paid X API.
//
// Strategy (in order):
//   1. Nitter HTML (paginated via ?cursor=...), trying a list of instances. As of
//      2026-09-25, nitter.click serves pages without a bot wall; most others are
//      dead, Cloudflare/Anubis-walled, or rate-limited.
//   2. FxTwitter /2/conversation/<id> (JSON). Its own cursor pagination is broken
//      (the cursor page returns 404), so only the first page (~35 replies) is
//      available. The script fetches it in both ranking modes (likes + recency)
//      and merges them. It also always runs as a supplement to Nitter, because it
//      gives exact in_reply_to ids and ISO timestamps.
//
// Usage:  node scripts/lib/replies.mjs <tweetId> [--out file.json]
// Import: import { fetchReplies } from './replies.mjs'
//
// Returned items: { id, author_screen_name, author_name, text, created_at, likes,
//   is_author, in_reply_to_id, media: [urls], source }
// The focal tweet is not included. Replies from the author (self-replies such as
// "Previously On" and the crew manifest) are included with is_author: true.

const AUTHOR = 'BaronDestructo';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

export const NITTER_INSTANCES = [
  'https://nitter.click',
  // Healthy on status.d420.de, but they either sit behind a bot wall or were down when tested:
  'https://nitter.tiekoetter.com',
  'https://nitter.privacyredirect.com',
  'https://nitter.xitter.cc',
  'https://nitter.meowing.monster',
  'https://nitter.jaydenha.uk',
  'https://nitter.net'
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url, { timeout = 30000, retries = 2 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow'
      });
      const body = await res.text();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        await sleep(2000 * (attempt + 1));
        continue;
      }
      return { status: res.status, body };
    } catch (e) {
      lastErr = e;
      await sleep(1500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// ---------- HTML helpers ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const stripTags = s => decode(s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function parseNitterDate(t) {
  // "Sep 22, 2026 · 4:18 PM UTC"
  const m = t && t.match(/(\w{3}) (\d{1,2}), (\d{4}) · (\d{1,2}):(\d{2}) (AM|PM)/);
  if (!m) return null;
  let h = +m[4] % 12;
  if (m[6] === 'PM') h += 12;
  return new Date(Date.UTC(+m[3], MONTHS[m[1]], +m[2], h, +m[5])).toISOString();
}

// Parse a single .timeline-item chunk.
function parseItem(chunk, base) {
  const link = chunk.match(/class="tweet-link" href="\/([^/"]+)\/status\/(\d+)/);
  if (!link) return null;
  const username = chunk.match(/class="username" href="[^"]*" title="@([^"]+)"/)?.[1] ?? link[1];
  const fullname = chunk.match(/class="fullname" href="[^"]*" title="([^"]*)"/)?.[1] ?? '';
  const date = chunk.match(/class="tweet-date"><a [^>]*title="([^"]+)"/)?.[1];
  const content = chunk.match(/class="tweet-content media-body"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '';
  const likes = chunk.match(/icon-heart"[^>]*><\/span>\s*([\d,]*)/)?.[1];
  const media = [...chunk.matchAll(/class="still-image" href="([^"]+)"/g)].map(m => {
    // /pic/orig/media%2FHSw0HS5XkAABOid.jpg -> https://pbs.twimg.com/media/HSw0HS5XkAABOid.jpg?name=orig
    const p = decodeURIComponent(m[1]);
    const mm = p.match(/media\/([^.?]+)\.(\w+)/);
    return mm ? `https://pbs.twimg.com/media/${mm[1]}.${mm[2]}?name=orig` : base + p;
  });
  return {
    id: link[2],
    author_screen_name: username,
    author_name: decode(fullname),
    text: stripTags(content),
    created_at: parseNitterDate(date ? decode(date) : null),
    likes: likes ? parseInt(likes.replace(/,/g, ''), 10) || 0 : 0,
    is_author: username.toLowerCase() === AUTHOR.toLowerCase(),
    in_reply_to_id: null,
    media,
    source: 'nitter'
  };
}

// Parse one Nitter status page -> { items, cursor }
function parseNitterPage(html, focalId, base) {
  const items = [];
  // Author continuation (after-tweet) + reply threads. Split by timeline-item boundaries
  // while tracking which "reply thread" group each item belongs to.
  const afterIdx = html.indexOf('class="after-tweet');
  const repliesIdx = html.indexOf('class="replies"');
  const regions = [];
  if (afterIdx >= 0) regions.push({ start: afterIdx, end: repliesIdx >= 0 ? repliesIdx : html.length, kind: 'after' });
  if (repliesIdx >= 0) regions.push({ start: repliesIdx, end: html.length, kind: 'replies' });

  for (const reg of regions) {
    const seg = html.slice(reg.start, reg.end);
    // groups: after-tweet is one chain; replies split on 'class="reply thread'
    const groups = reg.kind === 'after' ? [seg] : seg.split(/class="reply thread[^"]*"/).slice(1);
    for (const g of groups) {
      let prev = focalId;
      const parts = g.split(/<div class="timeline-item/).slice(1);
      for (const p of parts) {
        if (p.startsWith(' more-replies')) continue;
        const it = parseItem(p, base);
        if (!it || it.id === focalId) continue;
        it.in_reply_to_id = prev; // best effort: chain order within a thread group
        prev = it.id;
        items.push(it);
      }
    }
  }
  const cursors = [...html.matchAll(/class="show-more"><a href="\?cursor=([^"#]+)/g)].map(m => decode(m[1]));
  return { items, cursor: cursors.length ? decodeURIComponent(cursors[cursors.length - 1]) : null };
}

const looksLikeNitter = html => /class="main-tweet"|class="timeline-item/.test(html);

export async function fetchRepliesNitter(tweetId, { maxPages = 100, delayMs = 800, log = () => {} } = {}) {
  const errors = [];
  for (const base of NITTER_INSTANCES) {
    const out = new Map();
    let cursor = null;
    let ok = false;
    try {
      for (let page = 0; page < maxPages; page++) {
        const url = `${base}/${AUTHOR}/status/${tweetId}` + (cursor ? `?cursor=${encodeURIComponent(cursor)}` : '');
        const { status, body } = await get(url);
        if (status !== 200 || !looksLikeNitter(body)) {
          if (page === 0) throw new Error(`HTTP ${status}${looksLikeNitter(body) ? '' : ' (no nitter markup: bot wall / error page)'}`);
          log(`[nitter ${base}] page ${page} failed: HTTP ${status}; stopping with partial results`);
          break;
        }
        ok = true;
        const { items, cursor: next } = parseNitterPage(body, tweetId, base);
        let added = 0;
        for (const it of items) if (!out.has(it.id)) (out.set(it.id, it), added++);
        log(`[nitter ${base}] page ${page}: ${items.length} items, +${added}, total ${out.size}`);
        if (!next || next === cursor || added === 0) break;
        cursor = next;
        await sleep(delayMs);
      }
    } catch (e) {
      errors.push(`${base}: ${e.message}`);
      log(`[nitter ${base}] failed: ${e.message}`);
      continue;
    }
    if (ok) return { replies: [...out.values()], instance: base, errors };
  }
  return { replies: null, instance: null, errors };
}

// ---------- FxTwitter ----------
function fromFx(r) {
  const media = (r.media?.all ?? []).map(m => m.url).filter(Boolean);
  return {
    id: r.id,
    author_screen_name: r.author?.screen_name ?? '',
    author_name: r.author?.name ?? '',
    text: (r.raw_text?.text ?? r.text ?? '').replace(/^(@\w+\s+)+/, '').trim(),
    created_at: r.created_timestamp ? new Date(r.created_timestamp * 1000).toISOString() : r.created_at,
    likes: r.likes ?? 0,
    is_author: (r.author?.screen_name ?? '').toLowerCase() === AUTHOR.toLowerCase(),
    in_reply_to_id: r.replying_to?.status ?? null,
    media,
    source: 'fxtwitter'
  };
}

export async function fetchRepliesFx(tweetId, { log = () => {} } = {}) {
  const out = new Map();
  for (const mode of ['likes', 'recency']) {
    let cursor = null;
    for (let page = 0; page < 30; page++) {
      const url =
        `https://api.fxtwitter.com/2/conversation/${tweetId}?ranking_mode=${mode}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
      let j;
      try {
        const { status, body } = await get(url, { retries: 1 });
        j = JSON.parse(body);
        if (status !== 200 || j.code !== 200) {
          log(`[fx ${mode}] page ${page}: HTTP ${status} code ${j.code}`);
          break;
        }
      } catch (e) {
        log(`[fx ${mode}] page ${page}: ${e.message}`);
        break;
      }
      // Thread entries after the focal tweet (author continuations) + replies
      const thread = (j.thread ?? []).filter(t => t && t.id !== tweetId && BigInt(t.id) > BigInt(tweetId));
      let added = 0;
      for (const r of [...thread, ...(j.replies ?? [])]) if (r?.id && !out.has(r.id)) (out.set(r.id, fromFx(r)), added++);
      log(`[fx ${mode}] page ${page}: +${added}, total ${out.size}`);
      cursor = j.cursor?.bottom;
      if (!cursor || added === 0) break;
    }
  }
  return [...out.values()];
}

// ---------- main entry ----------
// ---------- optional paid fallbacks (only used if a key is set and Nitter failed) ----------
// Both cost cents/month at this volume. Endpoint shapes per their public docs.
function fromPaid(r, source) {
  const user = r.user ?? r.author ?? {};
  return {
    id: String(r.id_str ?? r.id),
    author_screen_name: user.screen_name ?? user.userName ?? '',
    author_name: user.name ?? '',
    text: (r.full_text ?? r.text ?? '').replace(/^(@\w+\s+)+/, '').trim(),
    created_at: new Date(r.tweet_created_at ?? r.createdAt ?? r.created_at).toISOString(),
    likes: r.favorite_count ?? r.likeCount ?? 0,
    is_author: (user.screen_name ?? user.userName ?? '').toLowerCase() === AUTHOR.toLowerCase(),
    in_reply_to_id: String(r.in_reply_to_status_id_str ?? r.inReplyToId ?? ''),
    media: [],
    source
  };
}

async function fetchRepliesPaid(tweetId, log) {
  const out = new Map();
  if (process.env.SOCIALDATA_API_KEY) {
    let cursor = '';
    for (let page = 0; page < 60; page++) {
      const res = await fetch(`https://api.socialdata.tools/twitter/tweets/${tweetId}/comments${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`, {
        headers: { authorization: `Bearer ${process.env.SOCIALDATA_API_KEY}`, accept: 'application/json' }
      });
      if (!res.ok) { log(`[socialdata] HTTP ${res.status}`); break; }
      const j = await res.json();
      for (const r of j.tweets ?? []) out.set(String(r.id_str ?? r.id), fromPaid(r, 'socialdata'));
      if (!j.next_cursor || !(j.tweets ?? []).length) break;
      cursor = j.next_cursor;
    }
  } else if (process.env.TWITTERAPI_IO_KEY) {
    let cursor = '';
    for (let page = 0; page < 60; page++) {
      const res = await fetch(`https://api.twitterapi.io/twitter/tweet/replies?tweetId=${tweetId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, {
        headers: { 'x-api-key': process.env.TWITTERAPI_IO_KEY }
      });
      if (!res.ok) { log(`[twitterapi.io] HTTP ${res.status}`); break; }
      const j = await res.json();
      for (const r of j.tweets ?? j.replies ?? []) out.set(String(r.id), fromPaid(r, 'twitterapi.io'));
      if (!j.has_next_page || !j.next_cursor) break;
      cursor = j.next_cursor;
    }
  }
  return [...out.values()];
}

export async function fetchReplies(tweetId, opts = {}) {
  const log = opts.log ?? (() => {});
  const [nit, fx] = await Promise.all([
    fetchRepliesNitter(tweetId, opts).catch(e => ({ replies: null, errors: [e.message] })),
    fetchRepliesFx(tweetId, { log }).catch(() => [])
  ]);
  if (!nit.replies?.length && (process.env.SOCIALDATA_API_KEY || process.env.TWITTERAPI_IO_KEY)) {
    try {
      nit.replies = await fetchRepliesPaid(tweetId, log);
      nit.instance = 'paid-api';
    } catch (e) {
      log(`[paid] ${e.message}`);
    }
  }
  const merged = new Map();
  for (const r of nit.replies ?? []) merged.set(r.id, r);
  for (const r of fx) {
    const ex = merged.get(r.id);
    if (!ex) merged.set(r.id, r);
    else {
      // FxTwitter has exact reply parent, precise timestamp and full-res media
      ex.in_reply_to_id = r.in_reply_to_id ?? ex.in_reply_to_id;
      ex.created_at = r.created_at ?? ex.created_at;
      if (r.media.length) ex.media = r.media;
      ex.likes = Math.max(ex.likes, r.likes);
      ex.source = 'nitter+fxtwitter';
    }
  }
  const replies = [...merged.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  Object.defineProperty(replies, 'meta', {
    value: { nitterInstance: nit.instance ?? null, nitterErrors: nit.errors ?? [], nitterCount: nit.replies?.length ?? 0, fxCount: fx.length },
    enumerable: false
  });
  return replies;
}

// ---------- CLI ----------
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('replies.mjs');
if (isMain) {
  const id = process.argv[2];
  if (!id || !/^\d+$/.test(id)) {
    console.error('usage: node scripts/lib/replies.mjs <tweetId> [--out file.json]');
    process.exit(1);
  }
  const outIdx = process.argv.indexOf('--out');
  const t0 = Date.now();
  const replies = await fetchReplies(id, { log: m => console.error(m) });
  if (outIdx > 0) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(process.argv[outIdx + 1], JSON.stringify(replies, null, 2));
  }
  const direct = replies.filter(r => r.in_reply_to_id === id);
  console.log(
    JSON.stringify(
      {
        tweetId: id,
        count: replies.length,
        direct_replies: direct.length,
        author_replies: replies.filter(r => r.is_author).length,
        meta: replies.meta,
        seconds: (Date.now() - t0) / 1000,
        author_self_replies_to_focal: replies
          .filter(r => r.is_author && r.in_reply_to_id === id)
          .map(r => ({ id: r.id, text: r.text.slice(0, 200), media: r.media })),
        samples: replies.filter(r => !r.is_author).slice(0, 5)
      },
      null,
      2
    )
  );
}

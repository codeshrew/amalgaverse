// Read-only access to public X posts via the FxTwitter API (api.fxtwitter.com).
// No auth, no official-API quota. We only ever read public posts.

const FX = 'https://api.fxtwitter.com';
const UA = 'amalgaverse-tracker/0.1 (personal fan site; read-only)';

export const AUTHOR = 'BaronDestructo';

async function getJson(url, { retries = 3 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' } });
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      return body;
    } catch (err) {
      lastErr = err;
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(`fetch failed ${url}: ${lastErr?.message}`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normalise an FxTwitter status into the shape the site uses. */
export function normalizeTweet(t) {
  const media = (t.media?.all || []).map((m) => ({
    type: m.type === 'gif' ? 'gif' : m.type,
    url: m.url,
    thumb: m.thumbnail_url || (m.type === 'photo' ? m.url : null),
    width: m.width,
    height: m.height,
    duration: m.duration ?? null,
  }));
  return {
    id: t.id,
    url: `https://x.com/${t.author?.screen_name || AUTHOR}/status/${t.id}`,
    author: t.author?.screen_name,
    text: t.raw_text?.text ?? t.text ?? '',
    createdAt: new Date(t.created_timestamp * 1000).toISOString(),
    stats: {
      replies: t.replies ?? 0,
      reposts: t.retweets ?? t.reposts ?? 0,
      likes: t.likes ?? 0,
      quotes: t.quotes ?? 0,
      views: t.views ?? null,
      bookmarks: t.bookmarks ?? 0,
    },
    media,
    quoteId: t.quote?.id ?? null,
    replyingTo: t.replying_to_status ?? t.replying_to?.status ?? null,
  };
}

export async function fetchTweet(id) {
  const body = await getJson(`${FX}/i/status/${id}`);
  if (body.code !== 200 || !body.tweet) throw new Error(`tweet ${id}: ${body.message}`);
  return normalizeTweet(body.tweet);
}

/** Recent statuses from the author's timeline (newest first). Best-effort. */
export async function fetchTimeline(screenName = AUTHOR, pages = 2) {
  const out = [];
  let cursor = null;
  for (let p = 0; p < pages; p++) {
    const url = `${FX}/2/profile/${screenName}/statuses${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
    let body;
    try {
      body = await getJson(url, { retries: 1 });
    } catch {
      break;
    }
    for (const t of body.results || []) out.push(normalizeTweet(t));
    cursor = body.cursor?.bottom;
    if (!cursor) break;
  }
  return out;
}

export const isAmalgaversePost = (t) =>
  t.author?.toLowerCase() === AUTHOR.toLowerCase() && /#amalgaverse/i.test(t.text) && !t.replyingTo;

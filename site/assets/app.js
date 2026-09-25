// Amalgaverse Console — renders site/data/story.json. No build step, no deps.

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
let S = window.AMALGAVERSE || null;

// ------------------------------------------------------------------ helpers
const esc = (s = '') => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const norm = (s = '') => s.replace(/[’‘]/g, "'").toLowerCase();
const fmtDate = (iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) => new Date(iso).toLocaleDateString(undefined, opts);
const fmtTime = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
function dur(ms) {
  if (ms <= 0) return '00:00:00';
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}
const OPT_COLORS = ['var(--cyan)', 'var(--amber)', 'var(--rose)', 'var(--violet)', 'var(--green)', '#7fa7ff'];
const ICON_X = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M18.9 2H22l-6.8 7.8L23 22h-6.2l-4.8-6.3L6.4 22H3.3l7.3-8.3L1 2h6.3l4.4 5.8L18.9 2zm-1.1 18h1.7L6.3 3.9H4.5L17.8 20z"/></svg>';

const beatById = () => Object.fromEntries(S.beats.map((b) => [b.id, b]));
const decisions = () => S.beats.filter((b) => b.kind !== 'briefing');
const currentBeat = () => [...S.beats].reverse().find((b) => b.status === 'open') || S.beats.at(-1);
const optByKey = (b, k) => b.options.find((o) => o.key === k);

function missionLabel(b) {
  if (b.mission === 'Prologue') return 'Prologue';
  const n = b.missionNumber ? `Mission ${b.missionNumber}` : 'Mission';
  return `${n} · ${b.mission}`;
}
function beatLabel(b) {
  const parts = [missionLabel(b)];
  if (b.part) parts.push(`Part ${b.part}`);
  parts.push(`Beat ${b.beatInMission}`);
  return parts.join(' · ');
}
function share(b, key) {
  const v = b.votes;
  if (!v || !v.counted) return null;
  return (v.tally[key] || 0) / v.counted;
}
const pctTxt = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);

// crew portraits come from the official manifest image (5×4 grid)
function crewIndex(short) {
  const n = norm(short);
  return S.crew.findIndex((c) => norm(c.short) === n || norm(c.name).includes(n));
}
function portrait(i, cls = 'portrait') {
  if (i < 0 || !S.manifestImage) return `<div class="${cls}"></div>`;
  const col = i % 5, row = Math.floor(i / 5);
  return `<div class="${cls}" role="img" aria-label="${esc(S.crew[i].name)}" style="background-image:url('${S.manifestImage}');background-position:${col * 25}% ${(row * 100) / 3}%"></div>`;
}
function currentAwayTeam() {
  const withTeam = [...S.beats].reverse().find((b) => b.awayTeam?.length);
  if (withTeam) return withTeam.awayTeam;
  return S.crew.filter((c) => c.awayTeam).map((c) => c.short);
}

// seen/new tracking (per browser)
const SEEN_KEY = 'amalgaverse.seen';
function loadSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || 'null') || []); } catch { return null; }
}
let seen = loadSeen();
function markSeen(ids) {
  try {
    seen = seen || new Set();
    ids.forEach((id) => seen.add(id));
    localStorage.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch { /* storage unavailable */ }
}
const isNew = (b) => seen && seen.size && !seen.has(b.id);

// ------------------------------------------------------------ text render
function renderProse(text, { dropHeadline = false, dropAside = false, headline = true } = {}) {
  const paras = text.replace(/\r/g, '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  return paras
    .map((p, i) => {
      if (headline && i === 0 && /#amalgaverse|mission:/i.test(p) && p.length < 120) {
        return dropHeadline ? '' : `<p class="headline">${esc(p.replace(/#\w+/g, '').trim())}</p>`;
      }
      if (/^\[.*\]$/s.test(p)) return dropAside ? '' : `<p class="aside">${esc(p.slice(1, -1))}</p>`;
      if (/^choose!?$/i.test(p)) return `<p class="choose">CHOOSE!</p>`;
      let h = esc(p).replace(/\n/g, '<br>');
      h = h.replace(/“[^”]*”/g, (m) => `<span class="dlg">${m}</span>`);
      h = h.replace(/(^|[\s(])(&quot;|")([^"<]{2,}?)(&quot;|")/g, (m, pre, _a, body) => `${pre}<span class="dlg">"${body}"</span>`);
      h = h.replace(/^(CONTACT \w+|Captain(?:&#39;|'|’)s Log[^:.]*[:.]?)/, '<span class="contact">$1</span>');
      h = h.replace(/(^|\s)(#\w+)/g, '$1<span class="dim">$2</span>');
      return `<p>${h}</p>`;
    })
    .join('');
}

function renderMedia(media, { max = 4, autoplay = false } = {}) {
  return (media || [])
    .slice(0, max)
    .map((m) =>
      m.type === 'video' || m.type === 'gif'
        ? `<video src="${esc(m.url)}" ${m.thumb ? `poster="${esc(m.thumb)}"` : ''} controls playsinline preload="none" ${autoplay || m.type === 'gif' ? 'muted loop autoplay' : ''}></video>`
        : `<a href="${esc(m.url)}" target="_blank" rel="noopener"><img src="${esc(m.url)}" alt="" loading="lazy"></a>`
    )
    .join('');
}

// ------------------------------------------------------------ vote blocks
function renderOptions(b, { reasons = true } = {}) {
  const v = b.votes;
  const leader = v?.leader;
  const out = b.options.map((o, i) => {
    const sh = share(b, o.key);
    const isCanon = b.canon === o.key;
    const cls = ['opt', leader === o.key && b.status === 'open' ? 'leader' : '', isCanon ? 'canon' : '', b.canon && !isCanon ? 'untaken' : ''].join(' ');
    const tags = [
      isCanon ? '<span class="badge canon">Path taken</span>' : '',
      b.status === 'open' && leader === o.key && v?.counted ? '<span class="badge live">Leading</span>' : '',
      b.status === 'closed' && leader === o.key && !isCanon && b.canon ? '<span class="badge">Most replies</span>' : '',
    ].join('');
    const reason = reasons && v?.reasons?.[o.key] ? `<div class="opt-reason">${esc(v.reasons[o.key])}</div>` : '';
    return `<div class="${cls}">
      <div class="opt-bar" data-w="${sh == null ? 0 : sh * 100}" style="${b.status === 'closed' ? '' : ''}"></div>
      <div class="opt-head">
        <div class="opt-label"><span class="opt-key">${esc(o.letter || String.fromCharCode(65 + i))}</span>${esc(o.label)}</div>
        <div class="opt-pct">${pctTxt(sh)}</div>
      </div>
      <div class="opt-summary">${esc(o.summary || '')}</div>
      ${v?.counted ? `<div class="opt-votes">${v.tally[o.key] || 0} votes</div>` : ''}
      ${reason}
      ${tags.trim() ? `<div class="opt-tags">${tags}</div>` : ''}
    </div>`;
  });
  return `<div class="options">${out.join('')}</div>`;
}

function renderVoteMeta(b) {
  const v = b.votes;
  if (!v) return `<div class="no-votes mono">No vote data yet — run <code>npm run update</code> to pull replies.</div>`;
  const method = v.method === 'ai' ? 'read by AI' : 'keyword-matched';
  return `<div class="vote-meta">
    <span>${v.counted} votes counted</span>
    <span>${v.voters} voters · ${v.unclear} unclear${v.other ? ` · ${v.other} write-ins` : ''}</span>
    <span>${v.total} of ${v.reported ?? v.total} replies scanned (${method})</span>
    ${v.asOf ? `<span>sync ${ago(v.asOf)}</span>` : ''}
  </div>`;
}

function renderSentiment(b) {
  const v = b.votes;
  if (!v?.headline) return '';
  return `<div class="sentiment">
    <div class="eyebrow">◈ Fleet sentiment analysis</div>
    <p>${esc(v.headline)}</p>
    ${v.wildcards ? `<p class="dim" style="font-size:15px">${esc(v.wildcards)}</p>` : ''}
  </div>`;
}

function miniSplit(b) {
  const v = b.votes;
  if (!v?.counted) return '';
  return `<div class="mini-split" title="${b.options.map((o) => `${o.label}: ${pctTxt(share(b, o.key))}`).join(' · ')}">${b.options
    .map((o, i) => `<span style="width:${share(b, o.key) * 100}%;background:${OPT_COLORS[i % OPT_COLORS.length]}"></span>`)
    .join('')}</div>`;
}

function animateBars(root = view) {
  requestAnimationFrame(() => root.querySelectorAll('.opt-bar').forEach((el) => (el.style.width = el.dataset.w + '%')));
}

// ------------------------------------------------------------ views
function viewBridge() {
  const b = currentBeat();
  const closesAt = b.closesAt ? new Date(b.closesAt) : null;
  const path = decisions().filter((d) => d.canon);
  const away = currentAwayTeam();
  const missionBeats = S.beats.filter((x) => x.mission === b.mission);
  const missionsDone = new Set(S.beats.filter((x) => x.missionNumber).map((x) => x.missionNumber));
  const latestDispatch = S.dispatches?.[0];
  const recent = decisions().filter((d) => d.status === 'closed').slice(-3).reverse();

  return `<div class="bridge-grid fade-in">
    <section class="panel amber hero" aria-labelledby="cur-title">
      <div class="eyebrow">${b.status === 'open' ? '<span class="badge live">Voting open</span>' : '<span class="badge closed">Standing by</span>'}<span>${esc(beatLabel(b))}</span></div>
      <div class="hero-top">
        <div>
          <h1 id="cur-title">${esc(b.title)}</h1>
          ${b.question ? `<p class="question">${esc(b.question)}</p>` : ''}
          ${closesAt ? `<div class="vote-clock">
              <svg class="progress-ring" viewBox="0 0 44 44"><circle cx="22" cy="22" r="18" stroke="rgba(255,255,255,.08)"/><circle id="ring" cx="22" cy="22" r="18" stroke="var(--cyan)" stroke-dasharray="113.1" stroke-dashoffset="113.1" stroke-linecap="round"/></svg>
              <div><div class="tele-k">Vote window closes</div><div class="mono" id="vote-left" data-close="${closesAt.toISOString()}" data-open="${b.createdAt}">—</div></div>
            </div>` : ''}
        </div>
        <div class="hero-media">${renderMedia(b.media, { max: 1 })}</div>
      </div>
      ${renderOptions(b)}
      ${renderSentiment(b)}
      ${renderVoteMeta(b)}
      <div class="btn-row">
        <a class="btn primary" href="${esc(b.url)}" target="_blank" rel="noopener">${ICON_X} Cast your vote on X</a>
        <a class="btn" href="#/beat/${b.id}">Read full transmission →</a>
      </div>
    </section>

    <div class="side-stack">
      <section class="panel">
        <h3>The path so far</h3>
        <div class="path-chips">
          ${path.map((d) => `<a class="chip" href="#/beat/${d.id}" title="${esc(d.title)}">${esc(shortChoice(d))}</a><span class="chip-arrow">▸</span>`).join('')}
          <a class="chip pending" href="#/beat/${b.id}">${b.status === 'open' ? '? awaiting you' : '…'}</a>
        </div>
        <p class="dim" style="margin:12px 0 0;font-size:14px">Every choice below was made by fan vote. Branches not taken are on the <a href="#/map">Timeline Map</a>.</p>
      </section>

      <section class="panel">
        <h3>Mission progress</h3>
        <div class="stat-row">
          <div class="stat"><div class="stat-v">${b.missionNumber || 0}<span class="dim" style="font-size:14px">/20</span></div><div class="stat-k">Mission</div></div>
          <div class="stat"><div class="stat-v">${decisions().length}</div><div class="stat-k">Decisions</div></div>
          <div class="stat"><div class="stat-v">${fmtNum(totalVotes())}</div><div class="stat-k">Votes counted</div></div>
        </div>
        ${b.missionNumber ? `<div class="meter" aria-hidden="true"><span style="width:${Math.min(100, (missionBeats.length / 25) * 100)}%"></span></div>
        <div class="meter-cap"><span>${esc(b.mission)}: beat ${missionBeats.length} of ~25</span><span>5 acts</span></div>` : ''}
        <p class="dim" style="margin:10px 0 0;font-size:14px">Season 1: 20 missions (10, a short hiatus, then 10 more). Each runs 3–4 weeks.${missionsDone.size ? '' : ''}</p>
      </section>

      ${away.length ? `<section class="panel">
        <h3>Away team</h3>
        <div class="away-strip">${away.map((n) => `<a href="#/crew" title="${esc(n)}">${portrait(crewIndex(n))}</a>`).join('')}</div>
      </section>` : ''}

      ${latestDispatch ? `<section class="panel">
        <h3>Latest from the showrunner</h3>
        <div class="prose" style="font-size:16px;margin-top:10px">${renderProse(latestDispatch.text.replace(/https:\/\/t\.co\/\S+/g, ''), { headline: false })}</div>
        <a class="dim mono" style="font-size:12px" href="${esc(latestDispatch.url)}" target="_blank" rel="noopener">${fmtDate(latestDispatch.createdAt)} · open on X ↗</a>
      </section>` : ''}
    </div>
  </div>

  ${recent.length ? `<div class="section-title"><h2>Recent log entries</h2></div>
  <div class="beats">${recent.map(beatRow).join('')}</div>` : ''}`;
}

const fmtNum = (n) => n.toLocaleString();
const totalVotes = () => S.beats.reduce((a, b) => a + (b.votes?.counted || 0), 0);
function shortChoice(d) {
  const o = optByKey(d, d.canon);
  if (!o) return d.canon;
  return o.label.split(/\s[—-]\s/).pop().replace(/^Contact \w+ — /, '');
}

function beatRow(b) {
  const o = b.canon ? optByKey(b, b.canon) : null;
  const leader = b.votes?.leader ? optByKey(b, b.votes.leader) : null;
  let result = '';
  if (b.kind === 'briefing') result = '<span class="badge">Briefing</span>';
  else if (b.status === 'open') result = `<span class="badge live">Voting</span>${leader ? `<span class="beat-sub">leading: ${esc(leader.label.split(/\s[—-]\s/)[0])} ${pctTxt(share(b, leader.key))}</span>` : ''}`;
  else if (o) result = `<span class="badge canon">${esc(o.label.split(/\s[—-]\s/)[0])}</span>${b.votes?.counted ? `<span class="beat-sub">${pctTxt(share(b, o.key))} of ${b.votes.counted} votes</span>` : ''}`;
  else result = '<span class="badge closed">Closed</span>';
  return `<a class="beat-row ${b.status}" href="#/beat/${b.id}">
    <div class="beat-no">${String(b.beatInMission).padStart(2, '0')}</div>
    <div>
      <div class="beat-title">${esc(b.title)} ${isNew(b) ? '<span class="badge new">New</span>' : ''}</div>
      <div class="beat-sub">${fmtDate(b.createdAt)} · ${b.question ? esc(b.question) : 'Pre-launch briefing'}</div>
    </div>
    <div class="beat-result">${result}${miniSplit(b)}</div>
  </a>`;
}

function viewLog() {
  const byId = beatById();
  return `<div class="fade-in">
    <p class="eyebrow">Season 1 · Episode guide</p>
    <h1 style="margin:8px 0 24px">Mission Log</h1>
    ${[...S.missions].reverse().map((m) => {
      const beats = m.beats.map((id) => byId[id]);
      const first = beats[0], last = beats.at(-1);
      return `<section class="mission">
        <div class="mission-head">
          <div>
            <div class="mission-num">${m.name === 'Prologue' ? 'Prologue' : `Mission ${m.number ?? '?'}`}</div>
            <h2>${esc(m.name === 'Prologue' ? 'Stranded in the Amalgaverse' : m.name)}</h2>
          </div>
          <div class="mono dim" style="font-size:13px">${fmtDate(first.createdAt)} – ${fmtDate(last.createdAt)} · ${beats.length} beat${beats.length === 1 ? '' : 's'}</div>
        </div>
        <div class="beats">${beats.map(beatRow).join('')}</div>
      </section>`;
    }).join('')}
  </div>`;
}

function viewBeat(id) {
  const byId = beatById();
  const b = byId[id];
  if (!b) return `<div class="boot mono">Transmission ${esc(id)} not found in the log.</div>`;
  markSeen([b.id]);
  const prev = b.prev && byId[b.prev];
  const next = b.next && byId[b.next];
  const recaps = (b.recap || []).filter((r) => r.text || r.media?.length);
  return `<div class="fade-in">
    <div class="crumbs"><a href="#/log">Mission Log</a> / ${esc(missionLabel(b))} / Beat ${b.beatInMission}</div>
    <div class="detail">
      <article class="panel">
        <div class="eyebrow">${b.status === 'open' ? '<span class="badge live">Voting open</span>' : b.kind === 'briefing' ? '<span class="badge">Briefing</span>' : '<span class="badge closed">Decided</span>'}
          <span>${fmtDate(b.createdAt, { weekday: 'long', month: 'long', day: 'numeric' })} · ${fmtTime(b.createdAt)}</span></div>
        <h1 style="margin:10px 0 20px">${esc(b.title)}</h1>
        <div class="media-stack">${renderMedia(b.media)}</div>
        <div class="prose">${renderProse(b.text)}</div>
        <div class="x-stats"><span><b>${fmtNum(b.stats.replies)}</b> replies</span><span><b>${fmtNum(b.stats.likes)}</b> likes</span><span><b>${fmtNum(b.stats.reposts)}</b> reposts</span><span><b>${fmtNum(b.stats.quotes)}</b> quotes</span>${b.stats.views ? `<span><b>${fmtNum(b.stats.views)}</b> views</span>` : ''}</div>
        ${recaps.length ? `<details class="recap"><summary>◈ Previously on… (showrunner's recap)</summary>
          ${recaps.map((r) => `<div class="prose">${renderProse(r.text.replace(/https:\/\/t\.co\/\S+/g, ''))}</div>${renderMedia(r.media, { max: 1 })}`).join('')}
        </details>` : ''}
        <div class="btn-row"><a class="btn" href="${esc(b.url)}" target="_blank" rel="noopener">${ICON_X} ${b.status === 'open' ? 'Reply with your vote' : 'Open on X'}</a></div>
      </article>
      <aside class="${b.options.length ? 'panel amber sticky' : ''}">
        ${b.options.length ? `
          <div class="eyebrow">${b.status === 'open' ? 'Live tally' : 'Final tally'}</div>
          <h2 style="margin:8px 0 16px;font-size:20px">${esc(b.question || 'The decision')}</h2>
          ${renderOptions(b)}
          ${renderSentiment(b)}
          ${renderVoteMeta(b)}
          ${b.canon && b.votes?.leader && b.votes.leader !== b.canon ? `<p class="dim" style="font-size:14px">The showrunner weighs reasoning as well as numbers — the story followed a different branch than the raw reply count.</p>` : ''}
        ` : ''}
      </aside>
    </div>
    <div class="pager">
      ${prev ? `<a class="btn" href="#/beat/${prev.id}">← ${esc(prev.title)}</a>` : '<span></span>'}
      ${next ? `<a class="btn primary" href="#/beat/${next.id}">${esc(next.title)} →</a>` : ''}
    </div>
  </div>`;
}

function branchName(o) {
  const [head, tail] = o.label.split(/\s[—-]\s/);
  return /^contact /i.test(head) && tail ? tail : head;
}

function viewMap() {
  let lastMission = null;
  const nodes = S.beats.map((b) => {
    let divider = '';
    if (b.mission !== lastMission) {
      lastMission = b.mission;
      divider = `<div class="mission-divider"><span>${esc(b.mission === 'Prologue' ? 'Prologue' : `Mission ${b.missionNumber ?? ''} · ${b.mission}`)}</span></div>`;
    }
    const branches = b.options.map((o) => {
      const cls = b.canon === o.key ? 'taken' : b.canon ? 'untaken' : b.votes?.leader === o.key ? 'leading' : '';
      return `<div class="branch ${cls}" title="${esc(o.summary || '')}">${esc(branchName(o))}<span class="pct">${pctTxt(share(b, o.key))}</span></div>`;
    }).join('');
    return `${divider}<div class="node ${b.status}">
      <a class="node-core" href="#/beat/${b.id}">
        <div class="eyebrow">${fmtDate(b.createdAt)}${b.status === 'open' ? ' · <span style="color:var(--green)">live</span>' : ''}</div>
        <div class="t">${esc(b.title)}</div>
        ${b.question ? `<div class="q">${esc(b.question)}</div>` : ''}
      </a>
      ${branches ? `<div class="branches">${branches}</div>` : ''}
    </div>`;
  }).join('');
  return `<div class="fade-in">
    <p class="eyebrow">Choose-your-own-adventure</p>
    <h1 style="margin:8px 0 6px">Timeline Map</h1>
    <p class="dim" style="margin:0 0 20px;max-width:680px">Every decision point and the branch the fleet chose. Dimmed options are timelines we'll never see — unless a future mission circles back.</p>
    <div class="map">${nodes}<div class="node"><div class="map-end">▼ TRANSMISSION CONTINUES · DAILY 12:01 PM ET</div></div></div>
  </div>`;
}

function viewChronicle() {
  let lastMission = null;
  const chapters = S.beats.map((b, i) => {
    let card = '';
    if (b.mission !== lastMission) {
      lastMission = b.mission;
      card = `<div class="mission-title-card"><span class="mission-num">${b.mission === 'Prologue' ? 'Prologue' : `Mission ${b.missionNumber ?? ''}`}</span><h1>${esc(b.mission === 'Prologue' ? 'Stranded in the Amalgaverse' : b.mission)}</h1></div>`;
    }
    if (b.kind === 'briefing') {
      return `${card}<details class="chapter panel"><summary class="eyebrow" style="cursor:pointer">◈ Pre-launch briefing — ${esc(b.title)} (${fmtDate(b.createdAt)})</summary><div class="prose" style="margin-top:14px">${renderProse(b.text)}</div></details>`;
    }
    const o = b.canon && optByKey(b, b.canon);
    let decision;
    if (o) {
      decision = `<div class="decision-card"><div class="eyebrow">The fleet decided</div><div class="choice">${esc(o.label)}</div>
        <div class="why">${b.votes?.counted ? `${pctTxt(share(b, o.key))} of ${b.votes.counted} counted votes. ` : ''}${esc(b.votes?.reasons?.[o.key] || '')}</div></div>`;
    } else if (b.status === 'open') {
      const lead = b.votes?.leader && optByKey(b, b.votes.leader);
      decision = `<div class="decision-card pending"><div class="eyebrow">● Decision pending — your move</div><div class="choice">${esc(b.question || '')}</div>
        <div class="why">${lead ? `Currently leading: ${esc(lead.label)} (${pctTxt(share(b, lead.key))}). ` : ''}<a href="${esc(b.url)}" target="_blank" rel="noopener">Reply on X to vote ↗</a></div></div>`;
    } else decision = '';
    return `${card}<article class="chapter" id="ch-${b.id}">
      <div class="eyebrow">Chapter ${i} · ${fmtDate(b.createdAt, { month: 'long', day: 'numeric' })}</div>
      <h2>${esc(b.title)}</h2>
      <div class="media-stack">${renderMedia(b.media, { max: 1 })}</div>
      <div class="prose">${renderProse(b.text, { dropHeadline: true, dropAside: true })}</div>
      ${decision}
    </article>`;
  }).join('');
  markSeen(S.beats.map((b) => b.id));
  return `<div class="chronicle fade-in">
    <p class="eyebrow" style="justify-content:center">The story so far</p>
    <h1 style="text-align:center;margin:8px 0 6px">Chronicle</h1>
    <p class="dim" style="text-align:center;margin:0 0 20px">Read every transmission in order, with the choice the fleet made after each one.</p>
    ${chapters}
  </div>`;
}

let crewFilter = 'all';
function franchise(origin) {
  if (/star trek/i.test(origin)) return 'Star Trek';
  if (/stargate/i.test(origin)) return 'Stargate';
  return origin.replace(/\s*\(.*\)/, '');
}
function viewCrew() {
  const away = new Set(currentAwayTeam().map(norm));
  const groups = ['all', ...new Set(S.crew.map((c) => franchise(c.origin)))];
  const cards = S.crew.map((c, i) => {
    const isAway = away.has(norm(c.short));
    const hidden = crewFilter !== 'all' && franchise(c.origin) !== crewFilter;
    if (hidden) return '';
    return `<div class="crew-card ${isAway ? 'away' : ''} ${c.status === 'lost' ? 'lost' : ''}">
      ${portrait(i)}
      <div class="crew-info">
        <div class="crew-role">${esc(c.role || '')}</div>
        <div class="crew-name">${esc(c.name)}</div>
        <div class="crew-origin">${esc(c.origin)}</div>
        <div class="opt-tags">${isAway ? '<span class="badge away">Away team</span>' : ''}${c.status === 'lost' ? '<span class="badge lost">Lost</span>' : ''}${c.isYou ? '<span class="badge canon">You</span>' : ''}</div>
      </div>
    </div>`;
  }).join('');
  return `<div class="fade-in">
    <p class="eyebrow">${esc(S.series.ship || 'Alt. Enterprise-D')} · Crew manifest</p>
    <h1 style="margin:8px 0 6px">The Crew</h1>
    <p class="dim" style="margin:0 0 18px;max-width:720px">Nineteen of sci-fi's best from across myriad realities — and you, the 20th, chosen for your encyclopedic knowledge of shows that, back home, are just fiction. Losses carry forward between missions.</p>
    <div class="origin-legend">${groups.map((g) => `<button class="badge ${crewFilter === g ? 'on' : ''}" data-filter="${esc(g)}">${esc(g === 'all' ? 'All realities' : g)}</button>`).join('')}</div>
    <div class="crew-grid">${cards}</div>
    ${S.assets?.length ? `<div class="section-title"><h2>Ship assets</h2></div>
    <div class="assets">${S.assets.map((a) => `<div class="asset"><div class="s">${esc(a.status || '')}</div><div class="t">${esc(a.name)}</div><div class="n">${esc(a.origin || '')}${a.note ? ` — ${esc(a.note)}` : ''}</div></div>`).join('')}</div>` : ''}
  </div>`;
}

function viewComms() {
  const items = S.dispatches || [];
  return `<div class="fade-in">
    <p class="eyebrow">Subspace channel · @${esc(S.series.handle)}</p>
    <h1 style="margin:8px 0 6px">Comms</h1>
    <p class="dim" style="margin:0 0 20px;max-width:720px">Side transmissions from the showrunner about the Amalgaverse — launch teasers, crew-selection votes, and commentary on how the voting is going.</p>
    <div class="comms">${items.length ? items.map((d) => `<div class="panel comm">
      <div>
        <div class="eyebrow">${fmtDate(d.createdAt, { weekday: 'short', month: 'short', day: 'numeric' })} · ${fmtTime(d.createdAt)}</div>
        <div class="prose" style="margin-top:8px">${renderProse(d.text.replace(/https:\/\/t\.co\/\S+/g, ''), { headline: false })}</div>
        <a class="mono dim" style="font-size:12px" href="${esc(d.url)}" target="_blank" rel="noopener">open on X ↗</a>
      </div>
      <div>${renderMedia(d.media, { max: 1 })}</div>
    </div>`).join('') : '<div class="no-votes">No side transmissions intercepted yet.</div>'}</div>
  </div>`;
}

// ------------------------------------------------------------ router
const ROUTES = { bridge: viewBridge, log: viewLog, map: viewMap, chronicle: viewChronicle, crew: viewCrew, comms: viewComms };
function render() {
  if (!S) return;
  const [, tab = 'bridge', arg] = (location.hash || '#/bridge').split('/');
  const fn = tab === 'beat' ? () => viewBeat(arg) : ROUTES[tab] || viewBridge;
  view.innerHTML = fn();
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === (tab === 'beat' ? 'log' : tab)));
  animateBars();
  if (seen === null) markSeen(S.beats.map((b) => b.id)); // first visit: nothing is "new"
  tick();
}
window.addEventListener('hashchange', () => {
  render();
  window.scrollTo({ top: 0, behavior: 'instant' });
});
view.addEventListener('click', (e) => {
  const f = e.target.closest('[data-filter]');
  if (f) {
    crewFilter = f.dataset.filter;
    render();
  }
});

// ------------------------------------------------------------ telemetry
function nextTransmission(now = new Date()) {
  // 12:01 PM America/New_York, today or tomorrow.
  const tz = 'America/New_York';
  const parts = (d) => Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(d).map((p) => [p.type, p.value]));
  const offsetAt = (d) => {
    const p = parts(d);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000;
  };
  for (let add = 0; add < 3; add++) {
    const p = parts(new Date(now.getTime() + add * 86400000));
    const guess = Date.UTC(+p.year, +p.month - 1, +p.day, 12, 1, 0);
    const t = guess - offsetAt(new Date(guess));
    if (t > now.getTime()) return new Date(t);
  }
  return null;
}
function stardate(d = new Date()) {
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const frac = (d - start) / (365.25 * 86400000);
  return (1000 * (d.getUTCFullYear() - 1946) + frac * 1000).toFixed(1); // whimsical, TNG-flavoured
}
function tick() {
  const now = new Date();
  $('#stardate').textContent = stardate(now);
  const nt = nextTransmission(now);
  $('#countdown').textContent = nt ? dur(nt - now) : '—';
  if (S) $('#lastsync').textContent = ago(S.generatedAt);
  const vl = $('#vote-left');
  if (vl) {
    const close = new Date(vl.dataset.close), open = new Date(vl.dataset.open);
    const left = close - now;
    vl.textContent = left > 0 ? `${dur(left)} remaining` : 'Closed — awaiting next transmission';
    const ring = $('#ring');
    if (ring) ring.style.strokeDashoffset = String(113.1 * Math.max(0, Math.min(1, left / (close - open))));
  }
}
setInterval(tick, 1000);

// ------------------------------------------------------------ live data
async function refresh() {
  if (location.protocol === 'file:') return;
  try {
    const res = await fetch(`data/story.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const fresh = await res.json();
    if (!S || fresh.generatedAt !== S.generatedAt) {
      S = fresh;
      render();
    }
  } catch { /* offline: keep what we have */ }
}
setInterval(refresh, 5 * 60_000);

// ------------------------------------------------------------ starfield
(function stars() {
  const c = $('#stars');
  const ctx = c.getContext('2d');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let w, h, pts;
  const hues = ['255,255,255', '255,210,160', '170,220,255'];
  function resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    w = c.width = innerWidth * dpr;
    h = c.height = innerHeight * dpr;
    pts = Array.from({ length: Math.round((innerWidth * innerHeight) / 5000) }, () => ({ x: (Math.random() - 0.5) * w, y: (Math.random() - 0.5) * h, z: Math.random() * w, c: hues[(Math.random() * 3) | 0] }));
  }
  function frame() {
    ctx.clearRect(0, 0, w, h);
    for (const p of pts) {
      if (!reduce) {
        p.z -= w * 0.0009;
        if (p.z <= 1) { p.z = w; p.x = (Math.random() - 0.5) * w; p.y = (Math.random() - 0.5) * h; }
      }
      const k = (w * 0.5) / p.z;
      const x = p.x * k + w / 2, y = p.y * k + h / 2;
      if (x < 0 || x > w || y < 0 || y > h) continue;
      const r = Math.max(0.3, (1 - p.z / w) * 2.2);
      ctx.fillStyle = `rgba(${p.c},${Math.min(1, 1.2 - p.z / w)})`;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
    if (!reduce) requestAnimationFrame(frame);
  }
  resize();
  addEventListener('resize', () => { resize(); if (reduce) frame(); });
  frame();
})();

// ------------------------------------------------------------ boot
if (S) render();
refresh();

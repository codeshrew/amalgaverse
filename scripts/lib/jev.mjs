// Vote reading with TypeSafe's Jev (https://docs.typesafe.ai) — a "System One"
// model that returns calibrated Choice/Score answers instead of generated text.
// Each reply gets:
//   vote_i   Choice over the beat's options + "none"  → which option it backs
//   mood_i   Score (0-4)                              → how the fan feels about the story
// Answers below MIN_CONFIDENCE are treated as unclear rather than guessed.
// Price is per input token (~$0.04 / million), so a whole beat costs well under a cent.

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const MODEL = process.env.TYPESAFE_MODEL || 'jev-latest';
const BATCH = 25; // replies per request: keeps `state` small (Jev dislikes irrelevant context)
export const MIN_CONFIDENCE = 0.45;

export const jevAvailable = () => !!process.env.TYPESAFE_API_KEY && !process.argv.includes('--no-jev');

const MOOD_LEVELS = [
  'Negative: bored, annoyed, or critical of the story',
  'Neutral: matter-of-fact, no feeling expressed',
  'Mildly positive: interested or amused',
  'Enthusiastic: clearly excited or having fun',
  'Ecstatic: over-the-moon, gushing, all caps, exclamation marks',
];

async function call(body, attempt = 0) {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.TYPESAFE_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if ((res.status === 429 || res.status === 529 || res.status >= 500) && attempt < 5) {
    const wait = Number(res.headers.get('retry-after')) * 1000 || 1000 * 2 ** attempt;
    await new Promise((r) => setTimeout(r, wait));
    return call(body, attempt + 1);
  }
  if (!res.ok) throw new Error(`TypeSafe HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function voteCriteria(beat) {
  const criteria = {};
  for (const o of beat.options) {
    criteria[o.key] = `${o.label}${o.summary ? ` (${o.summary})` : ''}${o.letter ? `. Fans may simply write "${o.letter}" or "Row ${o.letter}".` : ''}`;
  }
  criteria.none =
    'The reply does not clearly pick exactly one of the options: a joke, question, compliment, off-topic remark, a vote for several options, or an idea that matches none of them.';
  return criteria;
}

/**
 * @param beat {question, text, options}
 * @param replies [{id, text}]
 * @returns {Promise<Record<string, {vote: string|null, confidence: number, probs: object, mood: number|null}>>}
 */
export async function jevClassify(beat, replies, { log = () => {} } = {}) {
  const out = {};
  const criteria = voteCriteria(beat);
  const setting = beat.text.replace(/\s+/g, ' ').slice(0, 1200);
  for (let i = 0; i < replies.length; i += BATCH) {
    const chunk = replies.slice(i, i + BATCH);
    const state = {
      story_setup: setting,
      decision_asked: beat.question,
      replies: Object.fromEntries(chunk.map((r, j) => [`r${j}`, r.text.slice(0, 500)])),
    };
    const questions = {};
    chunk.forEach((_, j) => {
      questions[`vote_${j}`] = {
        type: 'choice',
        instructions: `A fan replied to this choose-your-own-adventure post to cast a vote on \`decision_asked\`. Which option does the reply \`replies.r${j}\` vote for?`,
        criteria,
      };
      questions[`mood_${j}`] = {
        type: 'score',
        instructions: `How does the fan who wrote \`replies.r${j}\` feel about the story?`,
        criteria: MOOD_LEVELS,
      };
    });
    const res = await call({ model: MODEL, state, questions });
    chunk.forEach((r, j) => {
      const v = res.answers[`vote_${j}`];
      const m = res.answers[`mood_${j}`];
      const vote = v && v.choice !== 'none' && v.confidence >= MIN_CONFIDENCE ? v.choice : null;
      out[r.id] = {
        vote,
        confidence: v?.confidence ?? 0,
        probs: v?.probabilities ?? {},
        mood: typeof m?.score === 'number' ? m.score : null,
      };
    });
    log(`  jev ${Math.min(i + BATCH, replies.length)}/${replies.length} (${res.model}, ${res.usage?.input_tokens ?? '?'} tok)`);
  }
  return out;
}

# Amalgaverse Console

A sci-fi mission console for following [Joseph Mallozzi](https://x.com/BaronDestructo)'s **#Amalgaverse**, a choose-your-own-adventure told in daily posts on X. Fans vote by replying, and the most popular reply decides what happens next.

```
npm start          # serve on http://localhost:4077 and refresh the data every 30 min
npm run update     # one-off data refresh (the AI reads the votes)
npm run update:fast  # one-off refresh, keyword vote counting only (no AI)
npm run serve      # serve only
```

You can also open `site/index.html` straight from disk. It will show the last snapshot, but it won't auto-refresh.

## Views

| Tab | What it shows |
|---|---|
| **Bridge** | The current decision with the live vote split, a countdown to when voting closes, a fleet-sentiment summary, the path taken so far, the away team, and the latest post from the showrunner |
| **Mission Log** | An episode guide. Each mission is broken into beats, and each beat opens to the full post, its media, the showrunner's "Previously on…" recap, and the final tally |
| **Timeline Map** | The branching path. The choice the story followed is lit up and the options not taken are dimmed |
| **Chronicle** | The whole story in order, with "the fleet decided…" cards between chapters |
| **Crew** | The 20-member crew manifest with portraits taken from the official manifest image. Shows who is on the away team, who has been lost, and ship assets |
| **Comms** | The showrunner's other #Amalgaverse posts: teasers, crew-selection votes, and "the vote is close!" updates |

## How the data is fetched (without the X API)

| Need | Source | Notes |
|---|---|---|
| Posts, media, stats, timeline | [FxTwitter API](https://github.com/FxEmbed/FxEmbed) `api.fxtwitter.com/i/status/<id>`, `/2/profile/<user>/statuses` | Free, no auth. Each beat quotes the one before it, so the updater follows that chain |
| Replies (the votes) | Nitter HTML (`nitter.click`, which pages through the replies) **plus** FxTwitter `/2/conversation/<id>` | Gets 85–100% of replies. On 2026-09-25, xcancel was suspended, most Nitter instances were behind bot walls, and X guest GraphQL needs an account |
| Paid fallback (optional) | Set `SOCIALDATA_API_KEY` or `TWITTERAPI_IO_KEY` | Only used if Nitter fails. About $0.15–0.20 per 1,000 replies, so a few cents a month |

To test the reply fetcher on its own: `npm run replies -- <postId>`.

## How votes are counted

1. Only **direct replies** to the post are counted, **one vote per account** (their latest reply), and the author's own replies are excluded.
2. If the `claude` CLI is installed, Claude Haiku reads each reply against that beat's options, so free-form answers like "send the android" are counted correctly. Otherwise the updater falls back to keyword and row-letter matching using `data/curation.json`.
3. Claude Sonnet writes a short "fleet sentiment" summary of *why* people voted the way they did. The site never shows individual replies. The raw replies stay in `.cache/`, which is gitignored.

Mallozzi weighs people's reasoning, not just the numbers. So the "path taken" is the branch the **next post** actually followed, and it can differ from the top reply count.

## Curation

`data/curation.json` holds each beat's title, question and options. When a new beat appears, the updater catalogues it automatically using Claude. It extracts the options, keywords and away team, and works out which option the previous beat actually followed. Those entries are marked `"auto": true` and you can edit them freely. `data/crew.json` holds the crew manifest and ship assets. Set `"status": "lost"` on anyone the fleet gets killed.

## Layout

```
scripts/update.mjs      discovery → replies → tally → site/data/story.json (+ story.js)
scripts/lib/x.mjs       FxTwitter client
scripts/lib/replies.mjs Nitter + FxTwitter reply fetcher (+ optional paid APIs)
scripts/lib/votes.mjs   keyword + AI classifiers, per-voter dedupe, sentiment summary
scripts/lib/llm.mjs     headless `claude -p` wrapper with an on-disk cache
scripts/serve.mjs       zero-dependency static server (+ --watch)
site/                   the console (plain HTML/CSS/JS, no build)
```

This is a fan project. The story, characters and images belong to their creators. The site links back to every post, so go vote on X.

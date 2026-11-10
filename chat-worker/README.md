# DFFL "Ask the league" chat Worker

A Cloudflare Worker behind the "Ask the league" panel on the site. It takes one question, lets
Claude Haiku 5.5 call a fixed set of league tools (live Sleeper + this repo's published JSON), and
returns a short answer with its sources and an as-of time. The rest of the site does not depend
on it: until the Worker URL is pasted into `index.html`, the panel just says "Chat not set up yet".

No passcode in v1. Anyone on the site can ask; the limits below are what keep it cheap.

## Setup (Drew, once)

Run these from `chat-worker/`. `npx wrangler` works without a global install.

1. **Log in:** `npx wrangler login`
2. **Create the KV namespace** for the counters:
   `npx wrangler kv namespace create LIMITS`
   Paste the printed `id` into `wrangler.toml`, replacing `REPLACE_WITH_KV_NAMESPACE_ID`.
3. **Add the API key as a secret** (never in a file):
   `npx wrangler secret put ANTHROPIC_API_KEY`
4. **Deploy:** `npx wrangler deploy` and note the URL it prints
   (`https://dffl-ask-the-league.<your-subdomain>.workers.dev`).
5. **Turn the panel on:** paste that URL into `CHAT_WORKER_URL` near the top of the script in
   `index.html` (next to `CURRENT_LEAGUE_ID`) and push.
6. **Backstop:** set a **$5 monthly spend limit** in the Anthropic console,
   https://platform.claude.com/settings/billing. The Worker's own cap (below) is the first line;
   this one catches anything it misses.

Plan: **Workers Free** to start. If the Worker logs show **Error 1102** (CPU limit exceeded),
upgrade to Workers Paid (~$5/month) — no code change needed.

## Model and prices

- Model id: `claude-haiku-5-5`
  (https://docs.anthropic.com/en/docs/about-claude/models/overview, checked 2026-11-10).
- Prices used by the spend counter, Claude Haiku 5.5, prompts up to 100k tokens
  (https://platform.claude.com/docs/en/about-claude/pricing, checked 2026-11-10):
  input $0.10 / MTok, output $0.50 / MTok, 5-minute cache writes $0.125 / MTok,
  1-hour cache writes $0.20 / MTok (unused), cache hits $0.01 / MTok.
- All of these live in `wrangler.toml` `[vars]` (`MODEL`, `PRICE_*`). If Anthropic changes the
  id or prices, edit the vars and redeploy; the code reads them from env. Confirm them against the
  pages above before relying on the cap.

## Limits, and how each is enforced

Every check that can refuse a question runs **before** the first Anthropic call, so a refused
question costs nothing.

| Limit | Where | What the page sees |
|---|---|---|
| CORS: only `https://drewkim623-hash.github.io` | `corsHeaders` / origin check in `src/index.js` | other origins get 403 with no CORS header; no localhost |
| ~8 requests / 60 s per IP | Rate Limiting binding `CHAT_RL`, keyed by `CF-Connecting-IP` | 429 `RATE_LIMIT` (retryable) |
| 20 questions / session / UTC day | KV `sess:{id}:{YYYY-MM-DD}` | 429 `SESSION_CAP` |
| $5 / UTC calendar month | KV `spend:{YYYY-MM}` | 402 `MONTHLY_CAP` ("Out of questions this month") |
| 20,000 input tokens per model call | estimated before each call; largest tool results trimmed to fit | — |
| 1,024 output tokens | `max_tokens` | — |
| 4 tool rounds | after round 4 the Worker sends `tool_choice: none` so the model must answer | — |
| ~8,000 tokens per tool result | truncated, with a note in the result | — |
| 50 subrequests (Free) | tools share a budget of 43; Anthropic calls are reserved | tools say "budget used up" instead of failing |

**Session.** The Worker mints a random 128-bit session id and returns it; the page keeps it in
`sessionStorage` and sends it as `X-DFFL-Session`. (A cookie would be cross-site from github.io
to workers.dev, which Safari blocks.) A determined user can mint a new session at will — the per-IP
limit and the $5 monthly cap are the real backstops.

**Spend counter.** After each question the Worker adds `usage` tokens × the `[vars]` prices to
`spend:{YYYY-MM}` (one KV write). If a response has no `usage`, it charges as if the full input and
output caps were used. The month rolls at 00:00 UTC on the 1st, the same window Anthropic uses.

**Honest weakness: KV is eventually consistent.** Two questions arriving together can both read
the counter under $5 and both go ahead, and a write in one Cloudflare location can take up to ~60 s
to show elsewhere. So a burst near the end of the month can overshoot $5 slightly (each question
costs well under a cent, so "slightly" is cents, not dollars). That is why the Anthropic console
limit in step 6 matters. The cap is not exact and does not claim to be.

KV on Free allows 100k reads and 1k writes a day. Each question does 2–3 reads and 2 writes
(session count + spend), so ~500 questions a day before KV writes run out.

## Tools

The model never gets a URL-fetch tool. Every tool builds its URL from a fixed path, and fetches
are allowed only to `api.sleeper.app`, `https://drewkim623-hash.github.io/dffl/…` and (fallback)
`raw.githubusercontent.com/drewkim623-hash/dffl/main/…`. `/v1/players/nfl` (the 5 MB dump) is
blocked outright; player names come from `rosters.json`.

| Tool | Source |
|---|---|
| `get_league_settings` | Sleeper `/league/{id}` |
| `get_nfl_state` | Sleeper `/state/nfl` |
| `get_standings(season?)` | current: Sleeper rosters; 2022–2025: snapshot |
| `get_matchups(season, week)` | current: Sleeper `/matchups/{week}`; prior: snapshot |
| `get_head_to_head(a, b)` | snapshot 2022–2025 + current season live, scores only |
| `get_roster(manager, week?)` | Sleeper rosters / matchups + `rosters.json` names |
| `get_odds` | `data/odds-snapshot.json` |
| `get_odds_history(manager?, week?)` | `data/odds-history.json` (last row per team per week) |
| `get_injuries(manager?)` | `injuries.json` + `injury-returns.json` + pulse + odds hurt list |
| `get_projections(manager? / player?, week?)` | `data/projections.json` (start/sit) |
| `get_recap(season, week)` | one week of `recaps.json` |
| `get_rankings(season, week?)` | `rankings.json` |
| `get_keepers(season, manager?)` | `keepers.json` |
| `get_trades(player?, manager?, trade?)` | bundled `data/trades-2026.json`: 2026 trades, keeper rights, loans, clauses and terms |
| `get_pulse` | `data/pulse.json` |
| `get_week(season, week)` | `data/week-YYYY-WW.json` (games, standings, marquee) |
| `get_faab` | Sleeper league + rosters |
| `search_player(name)` | `rosters.json` (rostered players only) + Sleeper rosters |

Teams are keyed by Sleeper `owner_id`; display names and old names (e.g. `bertalicious` in
`keepers.json`) resolve to the same owner, and tools report the name change.

Caching: Cache API in front of every fetch (45 s for live Sleeper data, 10 min for league
settings/users, 5 min for repo JSON, 1 day for completed weeks), plus per-request memoization.
Slices of the big files (`recaps.json`, `odds-history.json`) are cached on their own, so the
large `JSON.parse` runs once per TTL rather than per question. Not fetched in v1:
`data/trade-grades.json`, `data/consensus*.json`, `data/projections-history/`, `data/sent-emails.json`.

## Matchup history snapshot

`data/matchup-history.json` holds every completed season's scores (2022–2025), keyed by
owner_id, no player lists (~25 KB). Walking five seasons of `/matchups/{week}` live would blow the
50-subrequest limit, so prior seasons come from this file and only the current season is live.

**After a season ends** (championship week final, league status `complete`):

```bash
node chat-worker/scripts/build-matchup-history.mjs
cd chat-worker && npx wrangler deploy
```

When the league rolls over to a new season, also update `CURRENT_LEAGUE_ID` in `wrangler.toml`.
The script is not part of the weekly data workflow and should not be added to it.

## 2026 trades and keeper rights

`get_trades` reads the bundled `data/trades-2026.json` file. It contains the executed 2026 trade
log plus off-Sleeper keeper rights, loans, clauses, notes, and their status. Empty input returns
the one-line-per-trade index; filter by player, manager, or trade number for details.

Rebuild locally with:

```bash
node chat-worker/scripts/build-trades.mjs
```

The script reads `FACTS-season.md` and `FACTS-short.md` under `TRADES_INPUTS` (default
`/Users/drewkim/Desktop/dffl-worktrees/trades-inputs`) and cross-checks the article at
`TRADES_ARTICLE` (default
`/Users/drewkim/Desktop/dffl-worktrees/dev-trades-article/recaps.json`). That `recaps.json`
source on `dev-trades-article` was uncommitted when this file was built. This is a local,
reproducible rebuild, not part of the weekly data workflow.

## Tests

```bash
node chat-worker/test-limits.mjs   # spend math, caps, CORS, session ids — pure, offline
node chat-worker/test-worker.mjs   # whole Worker in node with a FAKE Anthropic; tools hit public Sleeper + Pages
```

Neither test calls Anthropic. `node verify.mjs` (repo root) covers the page panel with the Worker
mocked.

Optional build check without deploying (needs no login): `npx wrangler deploy --dry-run --outdir /tmp/dffl-chat-dryrun`.

## Secrets

Never commit `ANTHROPIC_API_KEY`; it lives only in `wrangler secret`. If it ever leaks, revoke it
in the Anthropic console, create a new one, and run `npx wrangler secret put ANTHROPIC_API_KEY`
again.

# The weekly job

`recaps.json` and `rankings.json` are not written by the site. They are written once a week by a
scheduled cloud agent — routine **DFFL weekly recaps**, Tuesdays at 13:00 UTC (9am Eastern).

The site never depends on either file. A missing, empty or stale `rankings.json` costs nothing: the
power rankings are computed in the browser from the game log, and each team falls back to showing
its record and points where a blurb would go.

## Why the job does not call Sleeper

It cannot. Every run from 18 August 2026 onward failed on exactly this, and the logs are
unambiguous:

```
WebFetch api.sleeper.app  → PROVENANCE_REQUIRED   (a per-URL approval nobody is there to give)
curl    api.sleeper.app:443 → connect_rejected    (the egress proxy denies CONNECT)
```

Both routes are closed in an unattended cloud session. So the data arrives a different way:

- **`.github/workflows/weekly-data.yml`** runs on GitHub Actions, which has no such restriction. It
  runs `build-week.mjs` and `build-injuries.mjs` at 12:30 UTC Tuesday — half an hour before the
  routine — and commits the result.
- **The routine** clones the repo and reads those committed files. It needs no network at all.

If the job ever finds itself reaching for `api.sleeper.app`, something has gone wrong: the answer is
to fix the Action, not to fetch.

## What the Action leaves for the job

| File | What it holds |
|---|---|
| `data/latest.json` | `{season, week, file}` — points at the newest finished week |
| `data/week-<season>-<week>.json` | the whole week: six games with full lineups, season-to-date standings, every completed transaction with FAAB and resolved player names, and a `marquee` block of the high, low, closest, blowout and unluckiest loss |
| `injuries.json` | every player carrying a status, with name, position and club |

Everything is already resolved to names. No ids need looking up, and nothing needs a second source.

## What the job writes

Three things, all committed straight to `main`:

1. **`recaps.json` → `weeks[]`** — the week's write-up.
2. **`rankings.json` → `weeks[]`** — one sentence of colour per manager.
3. **`recaps.json` → `articles[]`** — one column a week.

### The contract for `weeks[]`

```json
{"season":"2026","week":4,"note":"","lede":"…","games":[…6…],"around":[…3-6…]}
```

`games[]` entries are `{headline, winner, winner_points, loser, loser_points, body}`; `around[]`
entries are `{kind, headline, body}` with kind one of `trade, waivers, riser, slider, streak,
injury, race, note`. Replace a week that already exists rather than duplicating it. Set `note` to
`"Playoffs"` from week 15 on (15 = Round 1, 16 = Semifinals, 17 = Championship).

`rankings.json` entries are `{"manager": "<Sleeper display_name, spelled exactly>", "blurb": "…"}`,
all twelve managers, every week. The site matches on that string and falls back silently if it does
not match.

### The article

One column a week, appended to `articles[]`. Shape is documented in `recaps.json`'s own `_schema`;
`kind: "opinion"` gets the Column flag on the front page. Give it a `slug` nothing else uses, the
week's date, and blocks that use the `stat`, `bars` and `cards` types rather than running as
undifferentiated paragraphs — the two pieces already in the file are the standard to match.

**Never drop `articles[]` when rewriting `recaps.json`.** Read the file, append, write it back
whole. Dropping the key deletes writing nothing else regenerates.

## The two hard rules

**Never state a rank or a movement.** Not in the lede, not in a game recap, not in the notebook, not
in a power blurb. The site computes the power rankings itself and prints each team's rank and its
movement arrow directly beside the copy, with the real numbers. If the prose says "up three spots"
and the board says two, the page is wrong in public. Write what happened; the board handles position.

**Never invent a stat.** Everything in the data file is real and sourced. Anything not in it is not
available.

## Voice

Straight ESPN, a beat writer's Tuesday morning: clean, factual, specific. Not trash talk, not jokes.
Reference managers by their Sleeper `display_name`. The lede is one paragraph on the shape of the
week. Game bodies are 2-4 sentences on how it was actually decided — the margin, who carried the
scoring, whether it was close late. Notebook items are 2-3 sentences each, and only the ones the
week supports: a quiet week gets three, a week with two trades and a $60 waiver claim gets six.
Never pad, and never repeat in the notebook what a game recap already said.

FAAB is real money in this league. A $40 claim is a story.

## Editing the routine

The routine lives at https://claude.ai/code/routines. Edit the prompt in the web UI rather than
through the API: the stored config carries a large `custom_system_prompt` and an explicit tool
allow-list, and an API update that omits `session_context` replaces both with defaults.

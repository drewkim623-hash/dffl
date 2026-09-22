# The weekly job

`recaps.json` and `rankings.json` are not written by the site. They are written once a week by a
scheduled cloud agent — routine **DFFL Tuesday recaps**, Tuesdays at 13:00 UTC (9am Eastern).

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

Two things, both committed straight to `main`:

1. **`recaps.json` → `weeks[]`** — the week's write-up.
2. **`rankings.json` → `weeks[]`** — one sentence of colour per manager.

This job does not touch `articles[]` — but it does send, which used to be somebody
else's job. See **Sending the blast** below.

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

### `articles[]` is not this job's to *write*

The weekly column lives in `recaps.json` → `articles[]`, but the Tuesday job doesn't write it: the
Saturday blast writes the week's column, and a separate midweek story watch files one or two more
through the week. Every one of those jobs now *sends* what it filed — see below.

**Never drop `articles[]` when rewriting `recaps.json`.** Read the file, write `weeks[]` back, and
leave `articles[]` exactly as found. Dropping the key deletes writing nothing else regenerates.

## The two hard rules

**Never state a rank or a movement.** Not in the lede, not in a game recap, not in the notebook, not
in a power blurb. The site computes the power rankings itself and prints each team's rank and its
movement arrow directly beside the copy, with the real numbers. If the prose says "up three spots"
and the board says two, the page is wrong in public. Write what happened; the board handles position.

**Never invent a stat.** Everything in the data file is real and sourced. Anything not in it is not
available.

## Sending the blast

**Every piece the desk publishes goes to the league by email, and nothing waits for approval.**
That covers all three jobs: the Tuesday recap, anything the midweek story watch files, and the
Saturday column. Write it, commit it, push it, send it — no draft to Drew, no reply to wait for.
Pushing an article and emailing it are one action, not two with a gate between them.

### Who it goes to

All twelve, in **To**, every time. Not BCC — the league sees each other and can reply to each other,
which is what was asked for.

```
drewkim623@gmail.com, jadenisxd@gmail.com, Joeskule23@gmail.com, bradyrife@gmail.com,
Willie124w@gmail.com, victorthompson023@gmail.com, matthewcolella2@gmail.com,
andrewcroft44@gmail.com, connorhassan04@gmail.com, weshowenstein@gmail.com,
moseslin2023@gmail.com, dominickreyes1@gmail.com
```

Dominick Reyes was missing from the list used up to 19 September. He is on it now. If a send goes
out to eleven addresses, the list is the old one and is wrong.

### A column is never reused

The blast leads with the newest article in `articles[]` and carries the newest week in `weeks[]`.
Neither file knows anything about email, so left alone the default behaviour is to send the league
a column it already read. `data/sent-emails.json` is the record of what actually reached them.
Before composing, run:

```
node blast-status.mjs
```

Exit **0** — the newest piece is unsent. Compose and send it.

Exit **1** — the newest piece has already been sent. **Write a new article off current data, then
send that.** Not a repeat, and not a skipped week. This is the normal Saturday case: the Tuesday
blast will usually have sent the week's column already, so Saturday writes a fresh one. A new
recap does not excuse a stale column — it is what the new piece should be built on, not a reason
to skip writing it.

There is always something to write. The board has moved, somebody has been claimed, a man is back
from injury, a 2-0 team is being carried by one receiver. Find the piece the data supports and
file it.

After the send actually succeeds, record it and commit:

```
node blast-status.mjs --record --subject "<subject>" --lead <slug> \
  --also <slug,slug> --season 2026 --week <n> --to 12 --sha <sha256> --by routine
```

A send that is not recorded will be sent again next time. Recording is part of sending, not an
afterthought.

### Nothing checks the numbers but you

There is no approval step any more, which means no second pair of eyes between a wrong number and
twelve inboxes. The two hard rules below are the whole guard, and one of them needs restating here:
**any ordinal or count must be checked against a sorted list, not recalled.** "The second-highest
score", "three of the six winners", "the lowest bench in the league" — those are the claims that
slip past every numeric check, and several have needed correcting after the fact. Sort the list and
look. If a figure cannot be traced to a file in this repo, it does not go in the email.

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

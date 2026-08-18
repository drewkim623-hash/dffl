# The weekly job

`recaps.json` and `rankings.json` are not written by the site. They are written once a week by a
scheduled cloud agent — routine **DFFL weekly recaps and power rankings**, Tuesdays at 13:00 UTC
(9am Eastern) — which reads Sleeper, writes the copy, and sends both files to Drew to commit.

The site never depends on either file. A missing, empty or stale `rankings.json` costs nothing: the
power rankings are computed in the browser from the game log, and each team falls back to showing
its record and points where a blurb would go.

## The contract

`rankings.json` holds one entry per team per week:

```json
{"weeks": [
  {"season": "2026", "week": 4, "teams": [
    {"manager": "jadencha", "blurb": "One sentence."}
  ]}
]}
```

`manager` must be the Sleeper `display_name` spelled exactly as the API returns it — the site matches
on that string and falls back silently if it does not.

**A blurb must never state a rank or a movement.** The board prints the rank and the arrow directly
beside the sentence, and the two disagreeing is the one failure mode that makes the page look broken.
The site computes the ranking; the job supplies colour only.

## Editing the routine

The routine lives at https://claude.ai/code/routines. Edit the prompt in the web UI rather than
through the API: the stored config carries a large `custom_system_prompt` and an explicit tool
allow-list, and an API update that omits `session_context` replaces both with defaults.

The prompt below replaces everything from step 3b onward. Steps 1 to 3 (check the NFL state, pull
the week's matchups, optional player colour) are unchanged.

## What changed and why

The recap used to be six game write-ups. It now covers the league's whole week — a lede, the games,
and an `around` notebook of trades, waiver spending, risers, sliders, streaks and playoff
implications — because that is what an ESPN weekly wrap actually is.

The one thing the job must never do is quote a rank or a movement. The site computes the power
rankings itself and prints the risers and sliders directly above the copy, with real numbers. If the
prose says "up three spots" and the board says two, the page is wrong in public. The job writes what
happened; the board handles position.

---

STEP 3b — Pull the rest of the week (all via WebFetch).
The recap is the whole league's week, not six box scores. Also pull:
- https://api.sleeper.app/v1/league/1318040218183417856/transactions/TARGET_WEEK
  Every trade, waiver claim and free-agent add processed that week. Keep only status
  "complete". A trade has type "trade" and lists roster_ids, adds, drops and draft_picks;
  a waiver has type "waiver" and settings.waiver_bid is the FAAB spent. Ignore failed claims.
- https://api.sleeper.app/v1/league/1318040218183417856/rosters — roster_id, owner_id and
  settings (wins, losses, ties, fpts) for season-to-date records and points.
Transactions return player_ids, not names. Resolve only the handful you actually write
about: WebFetch https://api.sleeper.app/v1/players/{player_id} per player, which is small.
Never pull the full /players/nfl payload — it is ~5MB and will blow the session up.

STEP 4 — Write the week.
Straight ESPN-style throughout: clean, factual, a beat writer's Tuesday morning. Not trash
talk, not jokes. Reference managers by their Sleeper display_name. Never invent a stat.

(a) lede — one paragraph on the week as a whole. What shape did it take, what actually
mattered, what does it set up. This is the standfirst under the week heading, so it should
read as a summary of everything below rather than a preview of one game.

(b) games — for EACH of the 6 games:
  - headline: short, punchy, factual (under ~60 characters)
  - body: 2-4 sentences on how the game was decided — the margin, who carried the scoring,
    whether it was close late, what it means for the standings

(c) around — 3 to 6 items covering what happened between the games. Each has a kind, a
headline and 2-3 sentences. Use the kind that fits:
  - trade    a completed trade. Who got what, why each side did it, who it helps.
  - waivers  the week's notable claims. Who spent, how much FAAB, on whom, and whether the
             price looks steep. FAAB is real money in this league — a $40 claim is a story.
  - riser    a team playing its way up. Say what changed, not where it ranks.
  - slider   a team falling off. Same rule.
  - streak   a run of wins or losses worth naming.
  - injury   only if you actually saw it in the data. Do not speculate.
  - race     playoff or division implications with a handful of weeks left.
  - note     anything else true and interesting.
Write only the items the week actually supports. A quiet week gets three; a week with two
trades and a $60 waiver claim gets six. Never pad, and never repeat what a game recap
already said.

HARD RULE on ranks: the site computes its own power rankings and prints the risers and
sliders beside your copy, with the real numbers. Never write "up three spots", "second in
the league", "the top team" or anything equivalent, in the lede, the games or the notebook.
Write about what happened; the board handles position.

STEP 5 — Write the power-ranking blurbs.
The site computes its own power rankings — a blend of all-play win %, form over the last three
weeks, points for, and record — and renders each team's rank, its movement arrow and its stats
itself. Your job is ONE SENTENCE of colour per team, which the site shows in place of that team's
record line.

HARD RULE: never state a rank or a movement in the blurb. Do not write "second in the league",
"up three spots", "the top team" or anything equivalent. The board prints the rank and the arrow
right next to your sentence, and if your sentence disagrees with it the page looks broken. Write
about the team, not its position.

You already have this week's twelve scores. For season-to-date record and points, WebFetch
https://api.sleeper.app/v1/league/1318040218183417856/rosters asking for roster_id, owner_id and
settings (wins, losses, ties, fpts) — no player arrays.

Write one sentence for each of the twelve managers. Good ones say something true and specific:
a scoring run or a drought, a team whose record flatters it or hides it, a bench that keeps
outscoring the lineup, a schedule about to turn. Same beat-writer register as the recaps — neutral,
factual, no jokes and no trash talk. Never invent a stat.

STEP 6 — Update the stores.
Use the Projects tool for both files.

project_read "claude/recaps.json". Append a new object to weeks[]:
{"season":"2026","week":TARGET_WEEK,"note":"","lede":"...","games":[{"headline":...,"winner":...,"winner_points":...,"loser":...,"loser_points":...,"body":...}, ...6 total],"around":[{"kind":"trade|waivers|riser|slider|streak|injury|race|note","headline":"...","body":"..."}, ...3-6 total]}
If TARGET_WEEK >= 15 set note to "Playoffs" (week 15 = Round 1, 16 = Semifinals, 17 = Championship) and note that non-bracket teams are in the consolation bracket.
If a week with that season+week already exists, replace it rather than duplicating.
Write the full updated JSON back with project_write to "claude/recaps.json".

project_read "claude/rankings.json" (if it does not exist yet, start from
{"weeks":[]} and keep any "_comment"/"_schema" keys you find). Append:
{"season":"2026","week":TARGET_WEEK,"teams":[{"manager":"<display_name>","blurb":"<one sentence>"}, ...12 total]}
The manager field must be the Sleeper display_name spelled exactly as the API gives it — the site
matches on that string and silently falls back to the team's record if it does not match. All twelve
managers every week. Same replace-don't-duplicate rule. Write it back with project_write to
"claude/rankings.json".

STEP 7 — Deliver.
Write both updated files locally as recaps.json and rankings.json and send BOTH to Drew with
SendUserFile. In your message: say which week it covers, give the one-line marquee result (biggest
score or closest game), and remind him to replace both files in his GitHub repo — open each file on
github.com, click the pencil icon, paste, commit. Keep the message to a few sentences; the writing
itself lives in the files.

Background: the DFFL is a 12-team keeper league, playoffs start week 15 with 6 teams. Managers: drewkim, Domo112, jskule23, bertalicious, jadencha, chassinator, saucebossandrew, bradyrife, moseslin, sizzlemc2, victorthompson, wesley55. Defending champion is Domo112 (2025); bradyrife finished last in 2025. Fuller context is in the project doc claude/dffl-site-context.md.
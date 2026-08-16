# DFFL — League Record Book

A single-page site for the DFFL fantasy football league. It reads the **public Sleeper API
directly from the visitor's browser**, so there is no server, no database, no API key, and
nothing to keep in sync — the page always matches what the Sleeper app shows.

Six sections:

- **Home** — reigning champion, league stat tiles, a tap-anyone manager grid, power rankings, luck
- **Scoreboard** — every matchup from any week the league has ever played, with a season/week picker
- **Managers** — sortable list; tap anyone for a full career profile (season by season, career highs
  and lows, longest streaks, and exactly who they own)
- **Records** — trophy case, the all-time record book, the 10 best and worst weeks ever, per-season
  awards (Points Machine, Mr. Consistent, Boom or Bust, Hard Luck, Daylight Robbery, Paper
  Champion), and weekly high/low-score crowns
- **Matchups** — a "pick two managers" comparison, the full head-to-head grid, rivalries, a
  what-if schedule swap, and a season browser
- **Recaps** — weekly ESPN-style write-ups from `recaps.json`

Every section has a "What do these numbers mean?" panel in plain English, and the whole thing is
built phone-first — that's where the league will actually read it.

---

## Getting it online (GitHub Pages, ~5 minutes)

1. Make a free account at github.com if you don't have one.
2. Create a new **public** repository. Name it whatever you want — `dffl` is fine.
3. Upload these files to the root of the repo (the web UI's "uploading an existing file"
   link works — just drag them in):
   - `index.html`
   - `recaps.json`
   - `README.md` (optional)
4. In the repo go to **Settings -> Pages**. Under "Build and deployment" set
   **Source = Deploy from a branch**, **Branch = `main`**, **Folder = `/ (root)`**. Save.
5. Wait about a minute. The site is live at:

   ```
   https://<your-github-username>.github.io/dffl/
   ```

That URL is what you send the guys. It works on phones.

### If you'd rather use the command line

```bash
git init
git add index.html recaps.json README.md
git commit -m "DFFL league record book"
git branch -M main
git remote add origin https://github.com/<you>/dffl.git
git push -u origin main
```

Then do step 4 above.

---

## How it finds your league history

`index.html` has one line of configuration near the top of the `<script>` block:

```js
const CURRENT_LEAGUE_ID = "1318040218183417856";
```

That is the 2026 DFFL league. Every offseason Sleeper creates a **new** league ID and links it
to the old one via `previous_league_id`. The site walks that chain backwards automatically, so
**when you roll the league over for 2027 you only change this one line** — all the history
keeps working by itself.

Currently on record:

| Season | League name | Sleeper league ID |
|---|---|---|
| 2026 | DFFL | 1318040218183417856 |
| 2025 | Munchkins | 1184636586888007680 |
| 2024 | Munchkins | 1048764400703848448 |
| 2023 | Munchkins | 916413632819400704 |
| 2022 | Keeper league | 850931900448075776 |

---

## Weekly recaps

`recaps.json` holds the ESPN-style write-ups. The site reads it, sorts newest-first, and renders
one card per game. Shape:

```json
{
  "weeks": [
    {
      "season": "2026",
      "week": 1,
      "note": "optional subtitle, e.g. Playoffs - Round 1",
      "games": [
        {
          "headline": "Short game headline",
          "winner": "manager display name",
          "winner_points": 148.22,
          "loser": "manager display name",
          "loser_points": 121.06,
          "body": "Two to four sentences on how the game was won."
        }
      ]
    }
  ]
}
```

To publish a week, replace `recaps.json` in the repo with the updated version. On GitHub you can
do it in the browser: open the file, click the pencil icon, paste, commit.

---

## Notes and known limits

- **Data accuracy.** Every regular-season record and points-for/against total this site computes
  was checked against Sleeper's own official standings for 2025 and matched exactly on all 12
  teams. Final placements come from Sleeper's championship and consolation brackets, not from
  regular-season record — so "dead last" is whoever actually lost the toilet bowl.
- **Load time.** The page makes roughly 90 requests to Sleeper on load (one per week per season),
  capped at 6 concurrent. Expect 3-6 seconds on first paint, with a progress bar.
- **Rate limits.** Sleeper allows about 1000 calls per minute per IP; a normal visit uses ~90.
  Hammering refresh could briefly trip it — the page then shows a clear error instead of a blank
  screen.
- **Pre-draft seasons.** 2026 is `pre_draft`, so it contributes no games yet. The moment week 1
  finalizes it starts appearing everywhere automatically.
- **Nothing is cached.** Deliberate — stale fantasy stats are worse than a 4-second load.

## Local development

```bash
python3 -m http.server 8000     # then open http://localhost:8000
```

`verify.mjs` is the test harness (Node + Playwright). It serves the site, drives it in real
Chromium against a frozen 2025 fixture, and asserts the computed numbers against Sleeper's
official standings, checks manager profiles open and render, and asserts no horizontal overflow at
390px on every section. Run `node verify.mjs` — 44 checks, all must pass.

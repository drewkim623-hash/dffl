/**
 * PR #4 screenshots: a simulated 1 AM Tuesday.
 *   node shoot.mjs <repo root> <before|after> <label>
 * Sleeper's state is mocked to week 2 and data/latest.json to "week 2, final";
 * everything else is live Sleeper data. Same mocks for before and after.
 */
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
const { chromium } = await import(process.env.PW_PATH);

const [root, tag, label] = process.argv.slice(2);
const ROOT = resolve(root);
const OUT = resolve(new URL(".", import.meta.url).pathname);
const TYPES = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };
const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream" }); res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise(r => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

const STATE = { week: 2, leg: 2, display_week: 2, season: "2026", season_type: "regular", league_season: "2026",
  previous_season: "2025", season_start_date: "2026-09-09", league_create_season: "2026", season_has_scores: true };
const LATEST = { season: "2026", week: 2, file: "data/week-2026-02.json", generated: "2026-09-29T04:31:00.000Z",
  generated_at: "2026-09-29T04:31:00.000Z", final: true,
  sleeper_state: { week: 2, leg: 2, display_week: 2, season_type: "regular", season: "2026" } };

const browser = await chromium.launch();
const facts = {};
for (const [vw, vh] of [[1280, 900], [390, 844]]) {
  for (const tab of ["home", "matchups"]) {
    const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: vw < 500 ? 2 : 1 });
    await ctx.route(/api\.sleeper\.app\/v1\/state\/nfl/, r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(STATE) }));
    await ctx.route(/\/data\/latest\.json(\?.*)?$/, r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LATEST) }));
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 120000 });
    if (tab !== "home") await page.click(`#tabs button[data-tab="${tab}"]`);
    await page.waitForFunction(() => document.body.dataset.liveReady, null, { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(3500);
    const f = await page.evaluate(() => {
      const D = window.__DFFL, s = D.DB.seasons.find(x => x.season === "2026") || {};
      return { sleeperWeek: D.DB.sleeperState ? D.DB.sleeperState.week : D.DB.state.week, effectiveWeek: D.DB.state.week,
        liveWeek: s.liveWeek ?? null, liveWeeks: [...new Set(D.DB.live.filter(g => g.season === "2026").map(g => g.week))],
        week2InBook: D.DB.games.filter(g => g.season === "2026" && g.week === 2).length,
        foot: (document.querySelector("#footNote") || {}).textContent.trim() };
    });
    facts[`${tab}-${vw}`] = f;
    await page.evaluate(({ tag, label }) => {
      const b = document.createElement("div");
      b.textContent = `SIMULATED 1 AM TUESDAY · Sleeper state: week 2 · latest.json: week 2, final · ${tag.toUpperCase()} (${label})`;
      b.style.cssText = "position:relative;z-index:99999;background:#b91c1c;color:#fff;font:700 13px/1.35 system-ui,sans-serif;padding:8px 12px;text-align:center;letter-spacing:.02em";
      document.body.insertBefore(b, document.body.firstChild);
      window.scrollTo(0, 0);
    }, { tag, label });
    await page.waitForTimeout(300);
    const file = `${tag}-${tab}-${vw}-sim-1am-tue.png`;
    await page.screenshot({ path: join(OUT, file), fullPage: true });
    console.log(file, JSON.stringify(f));
    await ctx.close();
  }
}
await writeFile(join(OUT, `${tag}-facts.json`), JSON.stringify(facts, null, 1) + "\n");
await browser.close(); server.close();

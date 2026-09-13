/**
 * Write the weekly email blast.
 *
 * The numbers in this email have to agree with the site exactly — a blast that
 * says 34% while the Odds tab says 29% is worse than no blast at all. Rather
 * than reimplement the model here and let the two drift, this drives the real
 * page in a headless browser and reads the numbers the site itself computed.
 *
 *   node build-email.mjs                       # against the published site
 *   node build-email.mjs --local               # against ./index.html
 *   node build-email.mjs --out preview.html
 *
 * Writes data/odds-snapshot.json — the numbers, and nothing else.
 *
 * This half needs a browser and the public site, so it runs in GitHub Actions.
 * The other half, compose-email.mjs, turns the snapshot into the email and runs
 * anywhere — which matters, because the routine that actually sends the thing
 * cannot reach either Sleeper or the site.
 *
 * The split exists so the email cannot invent a number: every figure in it was
 * computed by the page itself and written down here.
 */
import { writeFile, mkdir } from "fs/promises";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join } from "path";
import { chromium } from "playwright";

const LIVE = "https://drewkim623-hash.github.io/dffl/";
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const useLocal = process.argv.includes("--local");

/* ---------------------------------------------------------------- serve */
let server = null, base = LIVE;
if (useLocal) {
  const TYPES = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".png": "image/png" };
  server = createServer(async (req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const p = join(process.cwd(), u === "/" ? "index.html" : u);
    try { const b = await readFile(p); res.writeHead(200, { "content-type": TYPES[extname(p)] || "text/plain" }); res.end(b); }
    catch { res.writeHead(404); res.end(); }
  }).listen(0);
  base = `http://127.0.0.1:${server.address().port}/`;
}

/* ------------------------------------------------------- read the site */
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 120000 });
await page.click('#tabs button[data-tab="odds"]');
await page.waitForFunction(() => document.body.dataset.liveReady, null, { timeout: 180000 });

const D = await page.evaluate(() => {
  const W = window, F = W.__DFFL;
  const model = W.__ODDS, pre = W.__SIM, live = W.__LSIM, board = W.__BOARD, L = W.__LIVE;
  const season = F.DB.seasons[0];
  // nameOf() isn't on the test surface; the manager table behind it is.
  const name = uid => { const m = F.DB.mgr.get(uid); return (m && m.name) || String(uid); };

  // The posted price, not just the probability. priceMarket applies the same 6%
  // hold the board posts, so what lands in the email is the number the site
  // shows rather than a percentage the reader has to convert in their head.
  const priced = (probs) => {
    const m = F.priceMarket(probs.map((p, i) => ({ i, p })));
    const by = new Map(m.map(r => [r.i, r.price]));
    return i => by.get(i);
  };
  const titlePrice = priced(model.teams.map((t, i) =>
    (live ? live.title[i] / live.sims : pre.title[i] / pre.sims)));
  // Playoffs is six of twelve — a yes/no book per team, not one race.
  const playoffPriceMap = new Map(F.priceBinary(model.teams.map((t, i) => ({
    i, p: live ? live.playoff[i] / live.sims : pre.playoff[i] / pre.sims,
  }))).map(r => [r.i, r.price]));
  const playoffPrice = i => playoffPriceMap.get(i);
  const openTitlePrice = priced(model.teams.map((t, i) => pre.title[i] / pre.sims));

  const teams = model.teams.map((t, i) => ({
    uid: t.uid, rid: t.rid, manager: name(t.uid),
    titleWas: pre.title[i] / pre.sims,
    titleNow: live ? live.title[i] / live.sims : null,
    playoffWas: pre.playoff[i] / pre.sims,
    playoffNow: live ? live.playoff[i] / live.sims : null,
    wins: live ? live.wins[i] / live.sims : pre.wins[i] / pre.sims,
    titleOdds: titlePrice(i),
    titleOddsOpen: openTitlePrice(i),
    playoffOdds: playoffPrice(i),
  }));

  const games = board && board.ok ? board.games.map(g => ({
    a: name(g.a.uid), b: name(g.b.uid),
    aPts: g.a.pts, bPts: g.b.pts,
    pA: g.pA, pB: g.pB, settled: g.settled,
    aLeft: g.A.toPlay + g.A.inPlay, bLeft: g.B.toPlay + g.B.inPlay,
    aFrac: g.A.frac, bFrac: g.B.frac,
  })) : [];

  const avail = W.__AVAIL || new Map();
  const hurt = model.teams.map(t => {
    const a = avail.get ? avail.get(t.rid) : null;
    return a && a.hurt.length ? {
      manager: name(t.uid), cost: 1 - a.mult,
      players: a.hurt.map(h => ({ name: (h.rec && h.rec.n) || h.pid, status: h.status })),
    } : null;
  }).filter(Boolean).sort((x, y) => y.cost - x.cost);

  return {
    season: season.season,
    week: season.liveWeek || (L && L.adjWeek) || null,
    liveWeek: season.liveWeek || null,
    decided: L ? L.decided : 0,
    remaining: L ? L.remaining + (L.pending || []).length : 0,
    teams, games, hurt,
    settled: board ? !!board.settled : true,
    nfl: board && board.nfl ? board.nfl : null,
  };
});

const articles = await page.evaluate(async () => {
  try {
    const j = await (await fetch("recaps.json", { cache: "no-cache" })).json();
    return ((j && j.articles) || []).slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
      .slice(0, 3)
      .map(a => ({ slug: a.slug, kicker: a.kicker, headline: a.headline, dek: a.dek, byline: a.byline, date: a.date }));
  } catch (e) { return []; }
});

await browser.close();
if (server) server.close();

/* ------------------------------------------------------------ snapshot */
const snapshot = {
  _comment:
    "Written by build-email.mjs, which drives the published site in a headless browser and reads "
    + "the numbers the page itself computed. compose-email.mjs turns this into the weekly email. "
    + "Nothing downstream recomputes a probability, so the email and the site cannot disagree.",
  generated: new Date().toISOString(),
  at: Date.now(),
  ...D,
  articles,
};

await mkdir("data", { recursive: true });
await writeFile("data/odds-snapshot.json", JSON.stringify(snapshot, null, 1) + "\n");
console.log(`data/odds-snapshot.json — week ${D.week}, ${D.teams.length} teams, `
  + `${D.games.length} live matchups, ${D.hurt.length} teams carrying injuries`);

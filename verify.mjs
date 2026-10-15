/**
 * DFFL verification harness.
 *
 *   node verify.mjs            run everything
 *   node verify.mjs --headed   watch it happen
 *
 * Serves the repo on a throwaway port, loads index.html in Chromium, and
 * asserts against the live page. The site reads Sleeper directly, so this
 * needs network — same as a real visitor.
 */
import { chromium } from "playwright";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname);
const HEADED = process.argv.includes("--headed");
const TYPES = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".css": "text/css" };

/* ------------------------------------------------------------ harness */
let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; failures.push(`${name}${detail ? ` — ${detail}` : ""}`); console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`); }
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;
function group(title) { console.log(`\n${title}`); }

/* ------------------------------------------------------------- server */
const server = createServer(async (req, res) => {
  try {
    const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "index.html";
    const body = await readFile(join(ROOT, rel));
    res.writeHead(200, { "content-type": TYPES[extname(rel)] || "application/octet-stream" });
    res.end(body);
  } catch { res.writeHead(404); res.end("not found"); }
});
await new Promise(r => server.listen(0, r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* -------------------------------------------------------------- start */
const browser = await chromium.launch({ headless: !HEADED });
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", e => errors.push(String(e)));
page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });

console.log(`DFFL verify — ${BASE}`);
await page.goto(BASE, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.dataset.ready, null, { timeout: 90000 });
const ready = await page.evaluate(() => document.body.dataset.ready);
if (ready !== "1") {
  console.error(`\nPage failed to boot (data-ready=${ready}). Sleeper may be rate-limiting.`);
  await browser.close(); server.close(); process.exit(1);
}

/* ============================================== existing behaviour === */
group("Shell and data load");
check("page booted", ready === "1");
check("no uncaught page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
const meta = await page.evaluate(() => {
  const D = window.__DFFL;
  return {
    seasons: D.DB.seasons.map(s => s.season),
    games: D.DB.games.length,
    managers: D.DB.mgr.size,
    tabs: [...document.querySelectorAll("#tabs button")].map(b => b.dataset.tab),
    title: document.title,
  };
});
check("walked the league chain back to 2022", meta.seasons.includes("2022") && meta.seasons.includes("2026"), meta.seasons.join(","));
check("four completed seasons plus the current one", meta.seasons.length === 5, `got ${meta.seasons.length}`);
check("games on record", meta.games > 300, `${meta.games}`);
check("twelve managers known", meta.managers >= 12, `${meta.managers}`);
check("__DFFL internals exposed", await page.evaluate(() => !!window.__DFFL));

group("Tabs");
const EXPECT = ["home", "scores", "managers", "records", "matchups", "power", "odds", "injuries", "picture", "draft", "trades", "recaps"];
check("every tab present and in order", JSON.stringify(meta.tabs) === JSON.stringify(EXPECT), meta.tabs.join(","));
for (const id of EXPECT) {
  await page.click(`#tabs button[data-tab="${id}"]`);
  const shown = await page.evaluate(t => {
    const p = document.querySelector(`[data-panel="${t}"]`);
    return { exists: !!p, visible: p && !p.hidden, selected: document.querySelector(`#tabs button[data-tab="${t}"]`).getAttribute("aria-selected") === "true", kids: p ? p.children.length : 0 };
  }, id);
  check(`${id}: panel renders and is selectable`, shown.exists && shown.visible && shown.selected && shown.kids > 0, JSON.stringify(shown));
}
check("hash routing follows the tab", (await page.evaluate(() => location.hash)) === "#recaps");
check("the Trade Machine is gone: no tab, no panel", await page.evaluate(() =>
  !document.querySelector('#tabs button[data-tab="trade"]') && !document.querySelector('[data-panel="trade"]') &&
  ![...document.querySelectorAll("#tabs button")].some(b => /trade machine/i.test(b.textContent))));
// Old Trade Machine links land on Trades, on a direct load and on a hash change.
const onTrades = p => p.evaluate(() => ({
  hash: location.hash,
  selected: (document.querySelector('#tabs button[aria-selected="true"]') || {}).dataset?.tab || null,
  visible: [...document.querySelectorAll("#app > [data-panel]")].filter(x => !x.hidden).map(x => x.dataset.panel).join(","),
  machine: !!document.querySelector('[data-panel="trade"], #tabs button[data-tab="trade"]'),
}));
const landedOnTrades = d => d.hash === "#trades" && d.selected === "trades" && d.visible === "trades" && !d.machine;
for (const old of ["trade", "machine"]) {
  const direct = await ctx.newPage();
  await direct.goto(BASE + "#" + old, { waitUntil: "domcontentloaded" });
  await direct.waitForFunction(() => document.body.dataset.ready, null, { timeout: 90000 });
  const d = await onTrades(direct);
  check(`a direct load of #${old} lands on Trades`, landedOnTrades(d), JSON.stringify(d));
  await direct.close();
  await page.evaluate(h => { location.hash = h; }, old);
  await page.waitForFunction(() => location.hash === "#trades", null, { timeout: 5000 }).catch(() => {});
  const h = await onTrades(page);
  check(`changing the hash to #${old} lands on Trades`, landedOnTrades(h), JSON.stringify(h));
}

group("Existing stats still compute");
const stats = await page.evaluate(() => {
  const { AT, RB, DIST } = window.__DFFL;
  const top = AT[0];
  return {
    n: AT.length, winPct: top.winPct, sumW: AT.reduce((a, r) => a + r.w, 0), sumL: AT.reduce((a, r) => a + r.l, 0),
    high: RB.high.pts, low: RB.low.pts, dist: DIST.size,
    apOk: AT.every(r => r.apPct >= 0 && r.apPct <= 1),
  };
});
check("all-time table populated", stats.n >= 12, `${stats.n}`);
check("wins and losses balance league-wide", stats.sumW === stats.sumL, `${stats.sumW} vs ${stats.sumL}`);
check("win percentages are probabilities", stats.winPct > 0 && stats.winPct <= 1);
check("beat-everyone rate in [0,1]", stats.apOk);
check("record book found a high and a low", stats.high > stats.low && stats.high > 100);
check("scoring distributions built", stats.dist >= 12, `${stats.dist}`);
check("winProb is symmetric", await page.evaluate(() => {
  const { DIST, winProb, DB } = window.__DFFL;
  const [a, b] = [...DIST.keys()];
  const p = winProb(a, b, DIST), q = winProb(b, a, DIST);
  return Math.abs(p + q - 1) < 1e-9;
}));

/* ====================================================== odds: maths === */
group("American odds conversion");
const math = await page.evaluate(() => {
  const { americanOdds, impliedProb, roundOdds } = window.__DFFL;
  const probs = [];
  for (let p = 0.005; p < 0.999; p += 0.0005) probs.push(p);
  let worstRT = 0, signOk = true, halfOk = true;
  for (const p of probs) {
    const o = americanOdds(p);
    worstRT = Math.max(worstRT, Math.abs(impliedProb(o) - p));
    if (p > 0.5 && o >= 0) signOk = false;
    if (p < 0.5 && o <= 0) signOk = false;
    if (Math.abs(o) < 100) halfOk = false;
  }
  const rounds = [];
  for (const p of probs) {
    const r = roundOdds(americanOdds(p));
    const step = Math.abs(r) < 200 ? 5 : 10;
    if (Math.abs(r) % step !== 0) rounds.push(r);
  }
  return {
    worstRT, signOk, halfOk,
    half: americanOdds(0.5),
    known60: americanOdds(0.6), known25: americanOdds(0.25),
    inv150: impliedProb(-150), inv300: impliedProb(300),
    badRounds: rounds.slice(0, 5),
    r199: roundOdds(199), r201: roundOdds(201), r147: roundOdds(147), r1234: roundOdds(1234),
    guardHigh: americanOdds(1), guardLow: americanOdds(0), guardNaN: americanOdds(1.5),
  };
});
check("odds round-trip back to the input probability", math.worstRT < 1e-12, `worst error ${math.worstRT}`);
check("p = 0.5 maps to -100 (i.e. even money)", Math.abs(math.half + 100) < 1e-9, `${math.half}`);
check("|odds| is never below 100", math.halfOk);
check("favourites price negative, longshots positive", math.signOk);
check("p = .60 → -150 exactly", near(math.known60, -150, 1e-9), `${math.known60}`);
check("p = .25 → +300 exactly", near(math.known25, 300, 1e-9), `${math.known25}`);
check("-150 implies 60%", near(math.inv150, 0.6, 1e-12));
check("+300 implies 25%", near(math.inv300, 0.25, 1e-12));
check("rounding lands on legal increments everywhere", math.badRounds.length === 0, JSON.stringify(math.badRounds));
check("nearest 5 below 200", math.r199 === 200 && math.r147 === 145, `${math.r199}/${math.r147}`);
check("nearest 10 at and above 200", math.r201 === 200 && math.r1234 === 1230, `${math.r201}/${math.r1234}`);
check("degenerate probabilities return null", math.guardHigh === null && math.guardLow === null && math.guardNaN === null);

group("Vig");
const vig = await page.evaluate(() => {
  const { addVig, priceMarket, marketHold, ODDS_HOLD } = window.__DFFL;
  const raw = [0.4, 0.3, 0.2, 0.1];
  const v = addVig(raw);
  const twoWay = addVig([0.5, 0.5]);
  const priced = priceMarket(raw.map(p => ({ p })));
  return {
    rawSum: raw.reduce((a, b) => a + b, 0),
    vigSum: v.reduce((a, b) => a + b, 0),
    twoWaySum: twoWay.reduce((a, b) => a + b, 0),
    hold: ODDS_HOLD,
    monotone: v.every((x, i) => i === 0 || x <= v[i - 1]),
    scaled: v.every((x, i) => Math.abs(x / raw[i] - 1.06) < 1e-12),
    postedHold: marketHold(priced),
    truthKept: priced.every((r, i) => r.p === raw[i]),
    vigAbove: priced.every(r => r.vigP > r.p),
  };
});
check("hold constant is 6%", near(vig.hold, 0.06, 1e-12));
check("true probabilities sum to 1.00 before vig", near(vig.rawSum, 1, 1e-12), `${vig.rawSum}`);
check("vigged probabilities sum to 1.06", near(vig.vigSum, 1.06, 1e-12), `${vig.vigSum}`);
check("two-way market also holds 6%", near(vig.twoWaySum, 1.06, 1e-12), `${vig.twoWaySum}`);
check("vig scales every runner by the same factor", vig.scaled);
check("vig preserves the ordering", vig.monotone);
check("every vigged probability exceeds its true one", vig.vigAbove);
check("the true probability is kept alongside the price", vig.truthKept);
check("posted hold survives rounding (5-7%)", vig.postedHold > 0.045 && vig.postedHold < 0.075, `${(vig.postedHold * 100).toFixed(2)}%`);

/* ==================================================== odds: model ==== */
group("Model and format");
const model = await page.evaluate(() => {
  const { ODDS: M, SIM } = window.__DFFL;
  return {
    ok: M.ok, teams: M.teams.length, weeks: M.weeks, playoffTeams: M.playoffTeams,
    divs: [...M.divNames.entries()], season: M.season, status: M.status,
    carry: M.carry, weekSd: M.weekSd, seasonSd: M.seasonSd, skillSd: M.skillSd,
    sims: SIM.sims, schedWeeks: M.sched.length,
    shrunk: M.teams.every(t => Math.abs(t.edge) <= Math.abs(t.rawEdge) + 1e-9),
    shrinkRange: M.teams.every(t => t.shrink >= 0 && t.shrink <= 1),
    meanFinite: M.teams.every(t => isFinite(t.mean) && t.mean > 50 && t.mean < 250),
  };
});
check("model priced the board", model.ok);
check("twelve teams", model.teams === 12, `${model.teams}`);
check("fourteen-week regular season", model.weeks === 14 && model.schedWeeks === 14, `${model.weeks}/${model.schedWeeks}`);
check("six playoff teams", model.playoffTeams === 6);
check("three divisions, named from Sleeper metadata", model.divs.length === 3, JSON.stringify(model.divs));
check("division names are the real ones", model.divs.map(d => d[1]).join("|") === "CPES|POOL 2|POOL 3", model.divs.map(d => d[1]).join("|"));
check("pricing the current pre-draft season", model.season === "2026" && model.status === "pre_draft", `${model.season}/${model.status}`);
check("year-over-year carry-over is a correlation", model.carry > 0 && model.carry < 1, `${model.carry}`);
check("carry-over is weak, as history says", model.carry < 0.6, `${model.carry}`);
check("every edge is shrunk toward the average", model.shrunk);
check("shrink factors in [0,1]", model.shrinkRange);
check("projected means are plausible weekly scores", model.meanFinite);
check("week-to-week noise dwarfs manager spread", model.weekSd > model.skillSd * 2, `${model.weekSd.toFixed(1)} vs ${model.skillSd.toFixed(1)}`);
check("ran 20,000 simulations", model.sims === 20000, `${model.sims}`);

group("Schedule respects the real format");
const sched = await page.evaluate(() => {
  const { ODDS: M } = window.__DFFL;
  const T = M.teams, per = new Array(T.length).fill(0), pair = new Map();
  for (const wk of M.sched) {
    const seen = new Set();
    for (const [a, b] of wk) {
      per[a]++; per[b]++; seen.add(a); seen.add(b);
      const k = [a, b].sort((x, y) => x - y).join("-");
      pair.set(k, (pair.get(k) || 0) + 1);
    }
    if (seen.size !== T.length) return { badWeek: true };
  }
  const twice = [...pair.entries()].filter(([, c]) => c === 2);
  return {
    badWeek: false,
    games: [...new Set(per)],
    pairs: pair.size,
    once: [...pair.values()].filter(c => c === 1).length,
    twice: twice.length,
    allRematchesInDivision: twice.every(([k]) => { const [a, b] = k.split("-").map(Number); return T[a].div === T[b].div; }),
    maxMeetings: Math.max(...pair.values()),
  };
});
check("every team plays every week", !sched.badWeek);
check("every team plays 14 games", sched.games.length === 1 && sched.games[0] === 14, JSON.stringify(sched.games));
check("full round robin — all 66 pairings occur", sched.pairs === 66, `${sched.pairs}`);
check("48 single meetings, 18 rematches", sched.once === 48 && sched.twice === 18, `${sched.once}/${sched.twice}`);
check("nobody meets three times", sched.maxMeetings === 2);
check("every rematch is intra-division", sched.allRematchesInDivision);

group("Division membership matches Sleeper");
const divCheck = await page.evaluate(async () => {
  const { ODDS: M, DB } = window.__DFFL;
  const cur = DB.seasons[0];
  const live = await fetch(`https://api.sleeper.app/v1/league/${cur.leagueId}/rosters`).then(r => r.json());
  const fromApi = new Map(live.map(r => [r.owner_id, Number(r.settings.division)]));
  const mismatched = M.teams.filter(t => fromApi.get(t.uid) !== t.div)
    .map(t => ({ uid: t.uid, model: t.div, api: fromApi.get(t.uid) }));
  const sizes = {};
  for (const t of M.teams) sizes[t.div] = (sizes[t.div] || 0) + 1;
  return { n: live.length, mismatched, sizes, apiDivs: [...new Set(live.map(r => Number(r.settings.division)))].sort() };
});
check("every manager's division matches roster.settings.division", divCheck.mismatched.length === 0, JSON.stringify(divCheck.mismatched));
check("three divisions of four", JSON.stringify(divCheck.sizes) === JSON.stringify({ 1: 4, 2: 4, 3: 4 }), JSON.stringify(divCheck.sizes));
check("Sleeper reports divisions 1-3", JSON.stringify(divCheck.apiDivs) === "[1,2,3]", JSON.stringify(divCheck.apiDivs));

/* =================================================== odds: markets === */
group("Market probabilities");
const markets = await page.evaluate(() => {
  const { ODDS: M, SIM, priceMarket, marketHold, addVig } = window.__DFFL;
  const n = SIM.sims, T = M.teams;
  const idxByDiv = d => T.map((t, i) => i).filter(i => T[i].div === d);
  const out = {};
  const build = (key, probs) => {
    const priced = priceMarket(probs.map(p => ({ p })));
    out[key] = {
      trueSum: probs.reduce((a, b) => a + b, 0),
      vigSum: addVig(probs).reduce((a, b) => a + b, 0),
      postedSum: priced.reduce((a, r) => a + r.postedP, 0),
      hold: marketHold(priced),
      // the sign follows the probability that was actually converted — the
      // vigged one, not the true one; a 48.5% shot is a 51.4% favourite once
      // the house takes its cut, and prices negative
      signOk: priced.every(r => (r.vigP >= 0.5) === (r.price < 0)),
      // the shortest price must belong to the most likely runner
      favShortest: (() => {
        const best = priced.reduce((a, b) => (b.p > a.p ? b : a));
        return priced.every(r => r.price >= best.price);
      })(),
      n: probs.length,
    };
  };
  build("title", T.map((_, i) => SIM.title[i] / n));
  build("last", T.map((_, i) => SIM.last[i] / n));
  for (const d of [1, 2, 3]) {
    build(`divWin${d}`, idxByDiv(d).map(i => SIM.divWin[i] / n));
    build(`divLast${d}`, idxByDiv(d).map(i => SIM.divLast[i] / n));
  }
  // two-way markets, per manager
  const twoWay = [];
  for (let i = 0; i < T.length; i++) twoWay.push(SIM.playoff[i] / n);
  out.playoffSum = twoWay.reduce((a, b) => a + b, 0);
  out.playoffEach = twoWay.map(p => {
    const pr = priceMarket([{ p }, { p: 1 - p }]);
    return {
      sum: pr.reduce((a, r) => a + r.postedP, 0),
      signs: pr.every(r => (r.vigP >= 0.5) === (r.price < 0)),
      // the likelier side is always the shorter price
      ordered: p >= 0.5 ? pr[0].price <= pr[1].price : pr[1].price <= pr[0].price,
    };
  });
  out.divWinTotal = T.reduce((a, _, i) => a + SIM.divWin[i] / n, 0);
  out.divLastTotal = T.reduce((a, _, i) => a + SIM.divLast[i] / n, 0);
  out.byeTotal = T.reduce((a, _, i) => a + SIM.bye[i] / n, 0);
  return out;
});
for (const [key, m] of Object.entries(markets)) {
  if (!m || typeof m !== "object" || m.trueSum === undefined) continue;
  check(`${key}: true probabilities sum to 1.00 before vig`, near(m.trueSum, 1, 0.002), `${m.trueSum.toFixed(5)}`);
  check(`${key}: vigged probabilities sum to 1.06`, near(m.vigSum, 1.06, 0.002), `${m.vigSum.toFixed(5)}`);
  check(`${key}: posted hold is 5-7% after rounding`, m.hold > 0.045 && m.hold < 0.075, `${(m.hold * 100).toFixed(2)}%`);
  check(`${key}: favourites negative, longshots positive`, m.signOk);
  check(`${key}: the favourite carries the shortest price`, m.favShortest);
}
check("playoff market: exactly 6 of 12 qualify per season", near(markets.playoffSum, 6, 0.002), `${markets.playoffSum.toFixed(4)}`);
check("playoff yes/no pairs each hold ~6%", markets.playoffEach.every(x => x.sum > 1.045 && x.sum < 1.075));
check("playoff yes/no pairs price the right way round", markets.playoffEach.every(x => x.signs));
check("playoff yes/no: the likelier side is the shorter price", markets.playoffEach.every(x => x.ordered));
check("exactly 3 division winners per season", near(markets.divWinTotal, 3, 0.002), `${markets.divWinTotal.toFixed(4)}`);
check("exactly 3 division cellar-dwellers per season", near(markets.divLastTotal, 3, 0.002), `${markets.divLastTotal.toFixed(4)}`);
check("exactly 2 first-round byes per season", near(markets.byeTotal, 2, 0.002), `${markets.byeTotal.toFixed(4)}`);

group("Simulation coherence");
const coh = await page.evaluate(() => {
  const { ODDS: M, SIM, winTotals } = window.__DFFL;
  const n = SIM.sims, T = M.teams;
  const wt = winTotals(M, SIM);
  return {
    titleLePlayoff: T.every((_, i) => SIM.title[i] <= SIM.playoff[i]),
    byeLePlayoff: T.every((_, i) => SIM.bye[i] <= SIM.playoff[i]),
    divWinLePlayoff: T.every((_, i) => SIM.divWin[i] <= SIM.playoff[i]),
    winsTotal: T.reduce((a, _, i) => a + SIM.wins[i] / n, 0),
    winDistOk: T.every((_, i) => SIM.winDist[i].reduce((a, b) => a + b, 0) === n),
    winsInRange: T.every((_, i) => SIM.wins[i] / n > 0 && SIM.wins[i] / n < 14),
    linesHalf: wt.every(w => (w.line * 2) % 2 === 1),
    linesBalanced: wt.every(w => Math.abs(w.pOver - 0.5) <= 0.5),
    overUnderSum: wt.every(w => Math.abs(w.pOver + w.pUnder - 1) < 1e-9),
    lineNearAvg: wt.every(w => Math.abs(w.line - w.avg) < 1.5),
    favIsBest: T[SIM.title.indexOf(Math.max(...SIM.title))].edge === Math.max(...T.map(t => t.edge)),
  };
});
check("title probability never exceeds playoff probability", coh.titleLePlayoff);
check("bye probability never exceeds playoff probability", coh.byeLePlayoff);
check("division win never exceeds playoff probability", coh.divWinLePlayoff);
check("total wins across the league is 6 per week x 14", near(coh.winsTotal, 84, 0.01), `${coh.winsTotal.toFixed(3)}`);
check("every win distribution sums to the sim count", coh.winDistOk);
check("projected wins strictly inside 0-14", coh.winsInRange);
check("win-total lines sit on the half-win", coh.linesHalf);
check("over and under are complements", coh.overUnderSum);
check("lines sit near the projection", coh.lineNearAvg);
check("the title favourite is the highest-rated manager", coh.favIsBest);

group("Consolation bracket quirk");
const quirk = await page.evaluate(() => {
  const { ODDS: M, SIM } = window.__DFFL;
  const n = SIM.sims;
  const lastProbs = M.teams.map((_, i) => SIM.last[i] / n);
  return {
    sum: lastProbs.reduce((a, b) => a + b, 0),
    spread: Math.max(...lastProbs) - Math.min(...lastProbs),
    max: Math.max(...lastProbs),
    allPositive: lastProbs.every(p => p > 0),
  };
});
check("last-place probabilities sum to 1", near(quirk.sum, 1, 0.002), `${quirk.sum.toFixed(4)}`);
check("everyone can finish last", quirk.allPositive);
check("no runaway favourite for last (bracket protects bad teams)", quirk.max < 0.25, `max ${(quirk.max * 100).toFixed(1)}%`);

group("Determinism");
const det = await page.evaluate(() => {
  const { ODDS: M, simulateSeason, SIM } = window.__DFFL;
  const again = simulateSeason(M);
  return M.teams.every((_, i) => again.title[i] === SIM.title[i] && again.last[i] === SIM.last[i] && again.playoff[i] === SIM.playoff[i]);
});
check("re-running the simulation reproduces the board exactly", det);

/* ======================================================== odds: DOM == */
group("Odds tab renders");
await page.click('#tabs button[data-tab="odds"]');
const dom = await page.evaluate(() => {
  const p = document.querySelector('[data-panel="odds"]');
  // fmtOdds prints "—" for an outcome no simulated season produced (0.0%, or
  // 100.0%); that is a well-formed price too.
  const prices = [...p.querySelectorAll(".price .o")].map(e => {
    const t = e.textContent.trim(), tp = e.closest(".price").querySelector(".tp");
    return t === "—" && tp && /^(0\.0|100\.0)%$/.test(tp.textContent.trim()) ? "+0" : t;
  });
  const truths = [...p.querySelectorAll(".price .tp")].map(e => e.textContent.trim());
  const holds = [...p.querySelectorAll(".hold")].map(e => e.textContent.trim());
  const text = p.textContent;
  return {
    boards: p.querySelectorAll(".board").length,
    rows: p.querySelectorAll(".orow").length,
    prices: prices.length,
    wellFormed: prices.every(t => /^[+-]\d+$/.test(t)),
    truthsWellFormed: truths.every(t => /^\d+\.\d%$/.test(t)),
    holdsWellFormed: holds.every(t => /^Hold \d+\.\d%$/.test(t)),
    notice: !!p.querySelector(".notice"),
    saysNotReal: /not real betting lines/i.test(text),
    saysNoBook: /No sportsbook offers/i.test(text),
    saysPreDraft: /pre-draft/i.test(text),
    saysKeepers: /three keepers/i.test(text),
    saysNotProjection: /not a projection/i.test(text),
    // the keepers and draft order are public on Sleeper; the board must say it
    // ignores them rather than imply the data doesn't exist
    disclosesKeeperBlindness: /ignores the keepers and the draft order/i.test(text),
    saysKeepersArePublic: /already public\s+on Sleeper/i.test(text),
    noFalseNeverSeen: !/never seen a 2026 roster/i.test(text),
    methodListsOmissions: /Deliberately not told/i.test(text),
    hasMethod: /How the board is priced/i.test(text),
    divNamesShown: ["CPES", "POOL 2", "POOL 3"].every(d => text.includes(d)),
    markets: ["To win the DFFL championship", "Playoff qualification", "To finish 12th", "Regular-season wins"].filter(m => text.includes(m)),
  };
});
check("boards rendered", dom.boards >= 9, `${dom.boards}`);
check("rows rendered", dom.rows >= 60, `${dom.rows}`);
check("every price is a well-formed American number", dom.wellFormed && dom.prices > 60, `${dom.prices}`);
check("every price shows its de-vigged probability", dom.truthsWellFormed);
check("every board states its hold", dom.holdsWellFormed);
check("all three division names appear", dom.divNamesShown);
check("all five markets present", dom.markets.length === 4, dom.markets.join(" / "));
check("methodology section present", dom.hasMethod);

group("Odds: game lines");
await page.waitForFunction(() => document.body.dataset.linesReady, null, { timeout: 180000 });
const gl = await page.evaluate(() => {
  const D = window.__DFFL, p = document.querySelector('[data-panel="odds"]');
  const sec = p.querySelector('[data-board="gamelines"]');
  const season = D.DB.seasons[0], B = window.__BOARD, L = window.__LINES;
  const expected = (season.live || []).length || (B && B.ok ? B.games.length : null) || (L ? L.games.length : 0);
  const cards = [...(sec ? sec.querySelectorAll('[data-card="gameline"]') : [])].map(c => {
    const ml = [...c.querySelectorAll('[data-mkt="ml"]')];
    const odds = [...c.querySelectorAll('[data-mkt="ml"] [data-odds]')].map(e => +e.dataset.odds);
    const priced = odds.length === 2;
    return {
      state: c.dataset.state, rids: !!(c.dataset.a && c.dataset.b),
      mlBoth: ml.length === 2 && ml.every(m => m.textContent.trim() && m.textContent.trim() !== "—"),
      priced, sum: priced ? odds.reduce((a, o) => a + D.impliedProb(o), 0) : null,
      resultOnly: !priced && ml.every(m => /Won|Lost|Tie|OTB/.test(m.textContent)),
      spreads: [...c.querySelectorAll('[data-mkt="spread"]')].map(e => +e.dataset.line),
      totals: [...c.querySelectorAll('[data-mkt="total"]')].map(e => +e.dataset.line),
      oddsNumeric: [...c.querySelectorAll("[data-odds]")].every(e => /^-?\d+$/.test(e.dataset.odds) && Math.abs(+e.dataset.odds) >= 100),
    };
  });
  const { gameLine, fmtSpread, coverResult, ODDS_HOLD } = D;
  const eq = gameLine({ expected: 120, sd: 30 }, { expected: 120, sd: 30 });
  const fav = gameLine({ expected: 132, sd: 30 }, { expected: 118, sd: 30 });
  const done = gameLine({ expected: 101, sd: 0 }, { expected: 99, sd: 0 });
  const even = D.roundOdds(D.americanOdds(D.addVig([0.5, 0.5], ODDS_HOLD)[0]));
  return {
    // sub-nav first, then the game lines, then the futures board's own heading
    inOdds: !!sec, first: !!sec && p.firstElementChild.classList.contains("glnav") &&
      !!(sec.compareDocumentPosition(p.querySelector(".sechead")) & Node.DOCUMENT_POSITION_FOLLOWING),
    nav: [...p.querySelectorAll(".glnav button")].map(b => b.textContent.trim()),
    expected, cards, status: L && L.status,
    eq: { spread: eq.spread, label: fmtSpread(eq.spread), ml: eq.ml, total: eq.total },
    fav: { ml: fav.ml, spreadA: -fav.spread, pA: fav.pA, total: fav.total,
      pAok: Math.abs(fav.pA - D.liveWinProb({ expected: 132, sd: 30 }, { expected: 118, sd: 30 })) < 1e-12 },
    done: { decided: done.decided, ml: done.ml },
    even, evenOk: eq.spreadPrice === even && eq.totalPrice === even,
    cover: [coverResult(6.5, 10), coverResult(6.5, 3), coverResult(-3, -3), coverResult(0, 5), coverResult(6.5, 6.5000000001)],
    opener: (L ? L.games : []).filter(g => g.open).map(g => !!(g.path[0] && g.path[0].pre && !g.path[0].live
      && g.path[0].p === g.open.pA && g.path.every((q, i) => i === 0 || q.t > g.path[0].t))),
    openers: (L ? L.games : []).filter(g => g.open).length,
  };
});
check("odds tab contains the game-lines board", gl.inOdds);
check("game lines sit above the futures with a two-pill sub-nav", gl.first && gl.nav.join("/") === "Game lines/Futures", gl.nav.join("/"));
check("one card per matchup this week", gl.cards.length === gl.expected && gl.expected > 0, `${gl.cards.length} cards vs ${gl.expected} matchups`);
check("every card carries both managers' rids", gl.cards.every(c => c.rids));
check("every card shows a moneyline (or result) for both teams", gl.cards.every(c => c.mlBoth && (c.priced || c.resultOnly)),
  JSON.stringify(gl.cards.map(c => [c.state, c.priced, c.resultOnly])));
check("undecided cards post two moneyline prices", gl.cards.filter(c => c.state === "live" || c.state === "upcoming")
  .every(c => c.priced || c.resultOnly), JSON.stringify(gl.cards.map(c => c.state)));
check("posted moneylines imply between 1.00 and 1.12", gl.cards.filter(c => c.priced).every(c => c.sum >= 1 && c.sum <= 1.12),
  gl.cards.filter(c => c.priced).map(c => c.sum.toFixed(3)).join(","));
check("every card has a spread and a total on both sides", gl.cards.every(c => c.spreads.length === 2 && c.totals.length === 2));
check("spreads and totals are multiples of 0.5", gl.cards.every(c => [...c.spreads, ...c.totals].every(x => Number.isFinite(x) && Math.abs(x * 2 - Math.round(x * 2)) < 1e-9)));
check("the two sides of a spread mirror each other", gl.cards.every(c => c.spreads[0] === -c.spreads[1]));
check("every data-odds is a whole American price", gl.cards.every(c => c.oddsNumeric));
check("gameLine: equal teams are a pick'em at near-even money", gl.eq.spread === 0 && gl.eq.label === "PK" &&
  gl.eq.ml[0] === gl.eq.ml[1] && gl.eq.ml[0] <= -100 && gl.eq.ml[0] >= -125, JSON.stringify(gl.eq));
check("gameLine: the stronger team is the moneyline favourite with a negative spread",
  gl.fav.ml[0] < 0 && gl.fav.ml[1] > 0 && gl.fav.spreadA < 0 && gl.fav.spreadA === -14 && gl.fav.total === 250, JSON.stringify(gl.fav));
check("gameLine: win chance is liveWinProb's", gl.fav.pAok);
check("gameLine: spread and total both post the vigged 50/50 price", gl.evenOk && gl.even === -115, `${gl.even}`);
check("gameLine: a decided game gets no price", gl.done.decided && gl.done.ml.every(x => x == null));
check("coverResult: covered / didn't / push / no favourite / push through float noise", JSON.stringify(gl.cover) === JSON.stringify(["covered", "missed", "push", null, "push"]), JSON.stringify(gl.cover));
check("each path opens on the card's pregame model line", gl.openers > 0 && gl.opener.every(Boolean),
  `${gl.opener.filter(Boolean).length}/${gl.openers}`);
check("no uncaught page errors after game lines", errors.length === 0, errors.slice(0, 2).join(" | "));

group("ADP snapshot");
const adp = await page.evaluate(async () => {
  const { loadADP, adpValue, adpKey, ADP_CURVE, DB } = window.__DFFL;
  const a = await loadADP();
  if (!a) return { loaded: false };
  // every 2026 draft pick that already exists (the keepers) must price
  const picks = DB.seasons[0].picks || [];
  let hit = 0;
  for (const p of picks) {
    const m = p.metadata || {};
    if (a.byName.get(adpKey(`${m.first_name || ""} ${m.last_name || ""}`, m.position)) != null) hit++;
  }
  // What the league actually pays for a catch, straight off Sleeper. The market
  // the ADP file is sampled from has to match this, or every roster valuation
  // downstream is priced off the wrong board.
  const lg = await fetch(`https://api.sleeper.app/v1/league/${DB.seasons[0].leagueId}`).then(r => r.json());
  const sc = lg.scoring_settings || {};
  const perCatch = { WR: (sc.rec || 0) + (sc.bonus_rec_wr || 0), TE: (sc.rec || 0) + (sc.bonus_rec_te || 0),
    RB: (sc.rec || 0) + (sc.bonus_rec_rb || 0) };
  const want = perCatch.WR >= 0.9 ? "PPR" : perCatch.WR >= 0.4 ? "Half-PPR" : "Non-PPR";
  const missed = [];
  for (const p of picks) {
    const m = p.metadata || {};
    if (a.byName.get(adpKey(`${m.first_name || ""} ${m.last_name || ""}`, m.position)) == null)
      missed.push({ pos: m.position || "?", pick: p.pick_no });
  }
  return {
    loaded: true, n: a.n, meta: a.meta, keeperPicks: picks.length, keeperHits: hit,
    perCatch, want, missedPos: [...new Set(missed.map(x => x.pos))].sort(),
    missedLatest: missed.length ? Math.min(...missed.map(x => x.pick)) : 999,
    v1: adpValue(1), v50: adpValue(50), v180: adpValue(180),
    monotone: [1, 5, 12, 25, 50, 100, 180, 220].every((x, i, arr) => i === 0 || adpValue(x) <= adpValue(arr[i - 1])),
    floored: adpValue(9999) === ADP_CURVE.floor && adpValue(0) === ADP_CURVE.floor,
    kMapped: adpKey("Brandon Aubrey", "K") === adpKey("Brandon Aubrey", "PK"),
    suffix: adpKey("James Cook III", "RB") === adpKey("James Cook", "RB"),
  };
});
check("ADP snapshot loads", adp.loaded);
check("the board carries a full draft's worth of players", adp.n >= 150 && adp.n <= 500, `${adp.n}`);
check("the snapshot is a 12-team board", adp.meta.teams === 12, `${adp.meta.teams}`);
// The original of this check asserted non-PPR "matching DFFL scoring", which was
// never true — the league paid a full point a catch in 2024 and 2025. Ask
// Sleeper what a catch is worth and require the market to match it.
check("the ADP market matches what the league pays for a catch",
  adp.meta.format === adp.want,
  `league pays WR ${adp.perCatch.WR}, TE ${adp.perCatch.TE}, RB ${adp.perCatch.RB} → wants ${adp.want}, file is ${adp.meta.format}`);
check("nearly every drafted player prices against it",
  adp.keeperHits / adp.keeperPicks > 0.88, `${adp.keeperHits}/${adp.keeperPicks}`);
check("the players it cannot price are all deep in the draft",
  adp.missedLatest >= 100, `earliest unpriced pick is ${adp.missedLatest}`);
check("value curve decreases with draft position", adp.monotone);

const keeperPricing = await page.evaluate(async () => {
  const D = window.__DFFL, s = D.DB.seasons[0];
  await D.keepersFor(s);
  const keep = D.keepersOf(s);
  const a = await D.loadADP();
  // A keeper is priced at what the player is worth, not at the round he cost.
  // Rebuild every roster by hand and require the model to agree.
  const byMgr = new Map();
  for (const pk of s.picks) {
    const md = pk.metadata || {};
    const adp = a.byName.get(D.adpKey(`${md.first_name || ""} ${md.last_name || ""}`, md.position));
    const v = D.adpValue(adp != null ? adp : D.ADP_CURVE.deepest);
    if (!byMgr.has(pk.picked_by)) byMgr.set(pk.picked_by, []);
    byMgr.get(pk.picked_by).push({ v, kept: keep.has(String(pk.player_id)) });
  }
  let worst = 0, keptShareMin = 1, keptShareMax = 0;
  for (const t of window.__ODDS.teams) {
    const top = (byMgr.get(t.uid) || []).sort((x, y) => y.v - x.v).slice(0, s.draftRounds);
    const total = top.reduce((x, y) => x + y.v, 0);
    const kept = top.filter(x => x.kept).reduce((x, y) => x + y.v, 0);
    worst = Math.max(worst, Math.abs(total - t.rosterValue));
    keptShareMin = Math.min(keptShareMin, kept / total);
    keptShareMax = Math.max(keptShareMax, kept / total);
  }
  // And the flag itself must not enter the valuation: price the same rosters
  // with every keeper mark removed and nothing may move.
  const before = window.__ODDS.teams.map(t => t.rosterValue);
  const saved = s._keepers; s._keepers = new Set();
  const again = D.rosterValue(s.picks, a, s.draftRounds);
  s._keepers = saved;
  const unchanged = window.__ODDS.teams.every((t, i) =>
    Math.abs((again.byUid.get(t.uid) || 0) - before[i]) < 1e-9);
  return { worst, unchanged, keptShareMin: +(keptShareMin * 100).toFixed(0), keptShareMax: +(keptShareMax * 100).toFixed(0) };
});
check("the odds price every keeper at what the player is worth", keeperPricing.worst < 0.05, `worst gap ${keeperPricing.worst}`);
check("the keeper list itself never enters the valuation", keeperPricing.unchanged);
check("keepers carry a real share of every roster", keeperPricing.keptShareMin > 10 && keeperPricing.keptShareMax < 60,
  `${keeperPricing.keptShareMin}% to ${keeperPricing.keptShareMax}%`);
check("pick 1 worth far more than pick 180", adp.v1 > adp.v180 * 4, `${adp.v1.toFixed(1)} vs ${adp.v180.toFixed(1)}`);
check("out-of-range ADP clamps to the floor", adp.floored);
check("Sleeper kickers (K) map to the board's PK", adp.kMapped);
check("name suffixes are normalized", adp.suffix);

group("Draft-day switch");
const flip = await page.evaluate(async () => {
  const D = window.__DFFL;
  const cur = D.DB.seasons[0];
  const before = { post: D.ODDS.postDraft, shock: D.ODDS.seasonSd, status: cur.draftStatus, done: cur.draftDone };

  const a = await D.loadADP();
  const board = a.meta.players.map(([n, p, v]) => ({ n, p, v }));
  const uids = cur.rosters.map(r => cur.uidOf.get(r.roster_id));

  // Build a synthetic COMPLETE draft: snake order down the ADP board, so the
  // first manager gets the best available every time round.
  const mk = (uid, pl, no) => ({
    pick_no: no, round: Math.ceil(no / 12), picked_by: uid,
    player_id: `syn${no}`, metadata: { first_name: pl.n.split(" ")[0], last_name: pl.n.split(" ").slice(1).join(" "), position: pl.p },
  });
  const picks = []; let no = 0;
  for (let r = 0; r < 15; r++) {
    const order = r % 2 === 0 ? uids : uids.slice().reverse();
    for (const uid of order) { const pl = board[no]; no++; if (pl) picks.push(mk(uid, pl, no)); }
  }

  // Swap in the completed draft and re-run the real code path.
  const saved = { picks: cur.picks, done: cur.draftDone, status: cur.draftStatus, slots: cur.draftSlots };
  cur.picks = picks; cur.draftDone = true; cur.draftStatus = "complete"; cur.draftSlots = 180;
  const M = await D.oddsModel();
  const S = D.simulateSeason(M);

  const T = M.teams, n = S.sims;
  const byUid = new Map(T.map(t => [t.uid, t]));
  const first = byUid.get(uids[0]), last = byUid.get(uids[11]);
  const titles = T.map((t, i) => ({ t, p: S.title[i] / n }));
  const best = titles.reduce((x, y) => (y.t.rosterEdge > x.t.rosterEdge ? y : x));
  const worst = titles.reduce((x, y) => (y.t.rosterEdge < x.t.rosterEdge ? y : x));

  // arithmetic check: the published edge must equal the fitted combination
  const formulaOk = T.every(t =>
    Math.abs(t.edge - (D.W_ROSTER * t.rosterEdge + D.W_HIST_POST * t.rawEdge)) < 1e-9);
  const rvSum = T.reduce((s, t) => s + t.rosterEdge, 0);

  cur.picks = saved.picks; cur.draftDone = saved.done; cur.draftStatus = saved.status; cur.draftSlots = saved.slots;

  return {
    before, post: M.postDraft, shock: M.seasonSd, priced: M.picksPriced, matchRate: M.matchRate,
    allValued: T.every(t => typeof t.rosterValue === "number" && isFinite(t.rosterValue) && t.rosterValue > 0),
    formulaOk, rvSum, histWeight: T[0].shrink,
    firstEdge: first.rosterEdge, lastEdge: last.rosterEdge,
    bestTitle: best.p, worstTitle: worst.p,
    titleSum: titles.reduce((s, x) => s + x.p, 0),
    lastSum: T.reduce((s, _, i) => s + S.last[i] / n, 0),
    winsSum: T.reduce((s, _, i) => s + S.wins[i] / n, 0),
    meansFinite: T.every(t => isFinite(t.mean) && t.mean > 50 && t.mean < 250),
  };
});
check("board starts pre-draft", flip.before.post === false && flip.before.shock === 6.9, JSON.stringify(flip.before));
check("a completed draft flips the model to post-draft", flip.post === true);
check("all 180 picks priced", flip.priced === 180, `${flip.priced}`);
check("synthetic draft matches the ADP board fully", flip.matchRate === 1, `${flip.matchRate}`);
check("every roster gets a value", flip.allValued);
check("edge equals 0.541*roster + 0.355*record exactly", flip.formulaOk);
check("roster edges are centered on the field", Math.abs(flip.rvSum) < 1e-9, `${flip.rvSum}`);
check("history's weight drops to 0.355 post-draft", Math.abs(flip.histWeight - 0.355) < 1e-9, `${flip.histWeight}`);
check("season uncertainty falls from 6.90 to 4.84", flip.shock === 4.84, `${flip.shock}`);
check("drafting first off the board beats drafting last", flip.firstEdge > flip.lastEdge, `${flip.firstEdge.toFixed(2)} vs ${flip.lastEdge.toFixed(2)}`);
check("the best roster is the title favourite", flip.bestTitle > flip.worstTitle * 2, `${(flip.bestTitle * 100).toFixed(1)}% vs ${(flip.worstTitle * 100).toFixed(1)}%`);
check("post-draft title market still sums to 1", near(flip.titleSum, 1, 0.002), `${flip.titleSum.toFixed(4)}`);
check("post-draft last-place market still sums to 1", near(flip.lastSum, 1, 0.002), `${flip.lastSum.toFixed(4)}`);
check("post-draft wins still total 84", near(flip.winsSum, 84, 0.01), `${flip.winsSum.toFixed(3)}`);
check("post-draft projections stay plausible", flip.meansFinite);

group("Draft-in-progress holds the line");
const midDraft = await page.evaluate(async () => {
  const D = window.__DFFL, cur = D.DB.seasons[0];
  const saved = { picks: cur.picks, done: cur.draftDone, status: cur.draftStatus, slots: cur.draftSlots };
  // Sleeper says "drafting" and only half the board is in — must NOT flip.
  cur.draftStatus = "drafting"; cur.draftDone = false; cur.draftSlots = 180;
  const partial = await D.oddsModel();
  // status complete but picks short of the full board — must NOT flip either
  cur.draftStatus = "complete"; cur.draftDone = false;
  const short = await D.oddsModel();
  cur.picks = saved.picks; cur.draftDone = saved.done; cur.draftStatus = saved.status; cur.draftSlots = saved.slots;
  return { partial: partial.postDraft, short: short.postDraft };
});
check("a draft in progress keeps the opening line", midDraft.partial === false);
check("an incomplete board keeps the opening line", midDraft.short === false);

group("Traded picks buy players, not roster value");
const capped = await page.evaluate(async () => {
  const D = window.__DFFL, cur = D.DB.seasons[0];
  const a = await D.loadADP();
  const board = a.meta.players.map(([n, p]) => ({ n, p }));
  const uids = cur.rosters.map(r => cur.uidOf.get(r.roster_id));
  const mk = (uid, pl, no) => ({
    pick_no: no, round: Math.ceil(no / 12), picked_by: uid, player_id: `syn${no}`,
    metadata: { first_name: pl.n.split(" ")[0], last_name: pl.n.split(" ").slice(1).join(" "), position: pl.p },
  });
  const base = []; let no = 0;
  for (let r = 0; r < 15; r++) {
    const order = r % 2 === 0 ? uids : uids.slice().reverse();
    for (const uid of order) { const pl = board[no]; no++; if (pl) base.push(mk(uid, pl, no)); }
  }

  const saved = { picks: cur.picks, done: cur.draftDone, status: cur.draftStatus, slots: cur.draftSlots };
  cur.picks = base; cur.draftDone = true; cur.draftStatus = "complete"; cur.draftSlots = 180;
  const M1 = await D.oddsModel();
  const v1 = new Map(M1.teams.map(t => [t.uid, t.rosterValue]));
  const e1 = new Map(M1.teams.map(t => [t.uid, t.edge]));

  // Same draft, except the first manager has traded for three extra late picks.
  // Those land beyond a startable roster, so nothing about the board may move.
  const extra = [0, 1, 2].map(i => mk(uids[0], { n: `Deep Flier${i}`, p: "WR" }, 181 + i));
  cur.picks = base.concat(extra);
  const M2 = await D.oddsModel();
  const v2 = new Map(M2.teams.map(t => [t.uid, t.rosterValue]));
  const e2 = new Map(M2.teams.map(t => [t.uid, t.edge]));

  // And a manager who traded three good picks AWAY must lose value for it.
  cur.picks = base.filter(p => !(p.picked_by === uids[1] && p.round <= 3));
  const M3 = await D.oddsModel();
  const v3 = new Map(M3.teams.map(t => [t.uid, t.rosterValue]));

  cur.picks = saved.picks; cur.draftDone = saved.done; cur.draftStatus = saved.status; cur.draftSlots = saved.slots;
  return {
    cap: M2.rosterCap, rounds: cur.draftRounds, dropped: M2.picksDropped,
    gain: v2.get(uids[0]) - v1.get(uids[0]),
    edgeMoved: uids.some(u => Math.abs(e2.get(u) - e1.get(u)) > 1e-9),
    othersMoved: uids.slice(1).some(u => Math.abs(v2.get(u) - v1.get(u)) > 1e-9),
    loss: v3.get(uids[1]) - v1.get(uids[1]),
  };
});
check("the roster cap is one player per draft round", capped.cap === capped.rounds && capped.cap > 0, `cap ${capped.cap} vs ${capped.rounds} rounds`);
check("picks beyond the cap are dropped, not counted", capped.dropped === 3, `${capped.dropped}`);
check("three extra late picks add nothing to a roster's value", Math.abs(capped.gain) < 1e-9, `${capped.gain.toFixed(4)}`);
check("no other manager's value moves when one trades for picks", capped.othersMoved === false);
check("no price on the board moves when one trades for picks", capped.edgeMoved === false);
check("trading away three early picks does cost value", capped.loss < -5, `${capped.loss.toFixed(2)}`);

group("Home and Odds agree");
const agree = await page.evaluate(() => {
  const { ODDS: M, SIM } = window.__DFFL;
  const n = SIM.sims;
  const home = document.querySelector('[data-panel="home"]');
  const odds = document.querySelector('[data-panel="odds"]');
  const rows = [...home.querySelectorAll("table")].pop().querySelectorAll("tbody tr");
  const homePcts = [...rows].map(r => ({
    name: r.querySelector("td").textContent.trim(),
    title: parseFloat(r.children[1].textContent),
  }));
  const expected = M.teams.map((t, i) => ({ i, p: SIM.title[i] / n })).sort((a, b) => b.p - a.p);
  return {
    count: homePcts.length,
    matches: homePcts.every((h, k) => Math.abs(h.title - expected[k].p * 100) < 0.06),
    top: homePcts[0],
    // The same probability must sit behind the top price on the OPENING board.
    // The Odds tab also carries a live board above it, which is a different
    // question and must not be compared against a preseason table.
    boardTop: odds.querySelector('[data-board="opening"] .price .tp').textContent.trim(),
    homeTop: homePcts[0].title.toFixed(1) + "%",
    noStaleCopy: !home.textContent.includes("Three thousand"),
  };
});
check("Home lists all twelve managers", agree.count === 12, `${agree.count}`);
check("Home title odds come from the same simulation as the board", agree.matches);
check("Home and the odds board show the same favourite probability", agree.boardTop === agree.homeTop, `${agree.homeTop} vs ${agree.boardTop}`);
check("the live board and the opening line are told apart", await page.evaluate(() => {
  const odds = document.querySelector('[data-panel="odds"]');
  return odds.querySelectorAll('[data-board="opening"]').length > 0;
}));
check("stale copy about the old model is gone", agree.noStaleCopy);

group("Honesty requirements");
check("house notice present", dom.notice);
check("says these are not real betting lines", dom.saysNotReal);
check("says no sportsbook offers this market", dom.saysNoBook);
check("says it is pre-draft", dom.saysPreDraft);
check("explains the keeper reset", dom.saysKeepers);
check("says it is not a projection", dom.saysNotProjection);
check("discloses that it ignores keepers and draft order", dom.disclosesKeeperBlindness);
check("states that keepers and draft order are already public", dom.saysKeepersArePublic);
check("does not falsely claim the 2026 data doesn't exist", dom.noFalseNeverSeen);
check("methodology lists what the model is not told", dom.methodListsOmissions);

/* ==================================================== responsiveness = */
group("Power rankings: the board itself");
const power = await page.evaluate(() => {
  const D = window.__DFFL, P = window.__POWER;
  const seasons = [...P.keys()];
  const bad = [];
  let boards = 0, wk1Boards = 0;
  for (const yr of seasons) {
    const R = P.get(yr);
    for (const b of R.boards) {
      boards++;
      const ranks = b.rows.map(r => r.rank).sort((a, c) => a - c);
      // a permutation of 1..n, every manager once, no gaps and no repeats
      if (ranks.length !== R.n) bad.push(`${yr} w${b.week}: ${ranks.length} rows`);
      if (!ranks.every((v, i) => v === i + 1)) bad.push(`${yr} w${b.week}: ranks ${ranks.join(",")}`);
      if (new Set(b.rows.map(r => r.uid)).size !== R.n) bad.push(`${yr} w${b.week}: duplicate manager`);
      if (b.rows.some(r => !isFinite(r.score) || !isFinite(r.pf))) bad.push(`${yr} w${b.week}: NaN`);
      const moved = b.rows.filter(r => r.move != null);
      const sum = moved.reduce((a, r) => a + r.move, 0);
      if (sum !== 0) bad.push(`${yr} w${b.week}: moves sum to ${sum}`);
      if (b.week === R.weeks[0]) {
        wk1Boards++;
        if (b.rows.some(r => r.move != null || r.prev != null)) bad.push(`${yr} w${b.week}: movement on the first board`);
      } else if (moved.length !== R.n) bad.push(`${yr} w${b.week}: only ${moved.length} of ${R.n} have movement`);
    }
  }
  const R25 = P.get("2025");
  const last = R25.boards[R25.boards.length - 1];
  const weights = D.POWER_W;
  // the published rating has to be the published weights, not a stray constant
  const formulaOk = R25.boards.every(b => b.rows.every(r =>
    Math.abs(r.score - (weights.allPlay * r.apPct + weights.form * r.formPct
      + weights.points * r.pfNorm + weights.record * r.winPct)) < 1e-12));
  return {
    seasons, boards, wk1Boards, bad: bad.slice(0, 5), badN: bad.length, formulaOk,
    weightSum: Object.values(weights).reduce((a, b) => a + b, 0),
    n: R25.n, weeks: R25.weeks.length,
    sortedByScore: R25.boards.every(b => b.rows.every((r, i) => i === 0 || b.rows[i - 1].score >= r.score)),
    componentsInRange: R25.boards.every(b => b.rows.every(r =>
      [r.apPct, r.formPct, r.pfNorm, r.winPct, r.score].every(v => v >= 0 && v <= 1))),
    // the board may only know what had happened by that week
    cumulative: R25.boards.every((b, i) => b.rows.every(r => r.g === i + 1)),
    topName: nameOf(last.rows[0].uid),
  };
});
check("every board is a permutation of the whole league", power.badN === 0, power.bad.join(" | "));
check("boards exist for every week of every played season", power.boards === 56 && power.seasons.length === 4, `${power.boards} boards over ${power.seasons.length} seasons`);
check("the first board of a season shows no movement", power.wk1Boards === 4, `${power.wk1Boards}`);
check("movement sums to zero across the league", power.badN === 0);
check("the rating is exactly the published weights", power.formulaOk);
check("the published weights sum to 1", near(power.weightSum, 1, 1e-12), `${power.weightSum}`);
check("boards are ordered by rating", power.sortedByScore);
check("every component stays between 0 and 1", power.componentsInRange);
check("a week-N board counts exactly N weeks of games", power.cumulative);

group("Power rankings: the page");
await page.click('#tabs button[data-tab="power"]');
await page.waitForTimeout(150);
const powerDom = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="power"]');
  const sels = panel.querySelectorAll("select");
  const openedOn = sels[0].value;
  // the tab opens on the 2026 projection; the rest of these are about a played board
  sels[0].value = "2025"; sels[0].dispatchEvent(new Event("change"));
  const rows = [...panel.querySelectorAll(".pwrow")];
  const marks = rows.map(r => r.querySelector(".mv").textContent.trim());
  return {
    rows: rows.length, sparks: panel.querySelectorAll(".spark").length,
    openedOn, seasonDefault: sels[0].value, weekDefault: sels[1].value,
    weekOptions: sels[1].options.length,
    marks, arrows: marks.filter(m => /[▲▼]/.test(m)).length,
    // the colour is never the only carrier: an arrow and a number ride with it
    colourNotAlone: [...panel.querySelectorAll(".mv.up, .mv.down")].every(n => /[▲▼]\s*\d+/.test(n.textContent)),
    weightsShown: /40%[\s\S]*25%[\s\S]*20%[\s\S]*15%/.test(panel.innerText),
    namesWeights: /All-play win %[\s\S]*Form, last 3 weeks[\s\S]*Points for[\s\S]*Actual record/.test(panel.innerText),
    nan: /NaN|undefined|Infinity/.test(panel.innerText),
  };
});
check("the board renders a row per manager", powerDom.rows === 12, `${powerDom.rows}`);
check("the tab opens on the newest board there is", powerDom.openedOn === "__proj", `opened on ${powerDom.openedOn}`);
check("a played season opens on its most recent completed week", powerDom.seasonDefault === "2025" && powerDom.weekDefault === "14", `${powerDom.seasonDefault} w${powerDom.weekDefault}`);
check("every week of the season is pickable", powerDom.weekOptions === 14, `${powerDom.weekOptions}`);
check("movement arrows reach the page", powerDom.arrows > 0, `${powerDom.arrows} arrows`);
check("movement never relies on colour alone", powerDom.colourNotAlone);
check("a rank line is drawn for every team", powerDom.sparks === 12, `${powerDom.sparks}`);
check("the weights are published on the page", powerDom.weightsShown && powerDom.namesWeights);
check("no NaN on the power board", powerDom.nan === false);

const wk1Dom = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="power"]');
  const sel = panel.querySelectorAll("select")[1];
  sel.value = "1"; sel.dispatchEvent(new Event("change"));
  const rows = [...panel.querySelectorAll(".pwrow")];
  return {
    rows: rows.length,
    arrows: rows.filter(r => /[▲▼]/.test(r.querySelector(".mv").textContent)).length,
    marks: rows.map(r => r.querySelector(".mv").textContent.trim()).filter(Boolean).length,
    sparks: panel.querySelectorAll(".spark").length,
  };
});
check("week 1 shows no movement arrows", wk1Dom.arrows === 0 && wk1Dom.marks === 0, `${wk1Dom.arrows} arrows, ${wk1Dom.marks} marks`);
check("week 1 still ranks everybody", wk1Dom.rows === 12);
check("week 1 draws no rank line, having one point", wk1Dom.sparks === 0, `${wk1Dom.sparks}`);

group("Power rankings: blurbs degrade gracefully");

/* The column prints the power board — ranks and movement arrows — and the site
 * prints its own beside the copy. They come from the same powerRankings() call,
 * so drift is impossible by construction; this asserts the construction. */
const artBoard = await page.evaluate(async () => {
  const F = window.__DFFL;
  const j = await (await fetch("recaps.json", { cache: "no-cache" })).json();
  const col = (j.articles || []).find(a => a.slug === "one-game-was-on-the-bench");
  if (!col) return { skip: "column not published" };
  const picks = col.blocks.filter(b => b.type === "picks");
  const board = picks.find(b => b.items.length === 12);
  const inj = picks.find(b => b !== board);
  if (!board) return { skip: "no twelve-row picks block" };

  const P = F.powerRankings(F.DB.seasons[0]);
  // The board for the week the column is ABOUT, not the newest one. Comparing
  // against the latest would start failing the moment week 3 is in the book,
  // which would be this check rotting rather than the article being wrong.
  const wk = Number(col.kicker.match(/week (\d+)/i)?.[1]);
  const last = P.boards.find(b => b.week === wk);
  if (!last) return { skip: `no board for week ${wk}` };
  const name = uid => { const m = F.DB.mgr.get(uid); return (m && m.name) || String(uid); };
  const live = last.rows.map((r, i) => ({
    rank: i + 1, manager: name(r.uid), rec: `${r.w}-${r.l}`, pf: r.pf.toFixed(2),
    move: r.prev == null || r.prev === r.rank ? "—"
      : `${r.prev > r.rank ? "\u25b2" : "\u25bc"} ${Math.abs(r.prev - r.rank)}`,
  }));

  const mism = [];
  board.items.forEach((it, i) => {
    const l = live[i];
    if (!l) { mism.push(`row ${i} missing`); return; }
    if (it.slot !== String(l.rank)) mism.push(`${i}: slot ${it.slot} vs ${l.rank}`);
    if (it.name !== l.manager) mism.push(`${i}: ${it.name} vs ${l.manager}`);
    if (!it.sub.includes(l.rec)) mism.push(`${i}: rec ${it.sub} lacks ${l.rec}`);
    if (!it.sub.includes(l.pf)) mism.push(`${i}: pf ${it.sub} lacks ${l.pf}`);
    if (it.delta !== l.move) mism.push(`${i}: move "${it.delta}" vs "${l.move}"`);
  });

  // The injury picks block against the live availability map.
  const A = window.__AVAIL || new Map();
  const S = F.DB.seasons[0];
  const ridToUid = new Map((S.rosters || []).map(r => [r.roster_id, r.owner_id]));
  const liveInj = [...A.entries()].filter(([, a]) => a.hurt.length)
    .map(([rid, a]) => ({ manager: name(ridToUid.get(rid)), cost: ((1 - a.mult) * 100).toFixed(1), n: a.hurt.length }))
    .sort((x, y) => Number(y.cost) - Number(x.cost));
  const injMism = [];
  if (inj) inj.items.forEach((it, i) => {
    const l = liveInj[i];
    if (!l) { injMism.push(`row ${i} missing`); return; }
    if (it.name !== l.manager) injMism.push(`${i}: ${it.name} vs ${l.manager}`);
    if (!it.slot.includes(l.cost)) injMism.push(`${i}: cost ${it.slot} vs ${l.cost}`);
    if (!it.delta.startsWith(String(l.n))) injMism.push(`${i}: count ${it.delta} vs ${l.n}`);
  });

  const managers = new Set(F.DB.seasons[0].rosters.map(r => name(r.owner_id)));
  return { rows: board.items.length, mism, injRows: inj ? inj.items.length : 0,
    injNamesReal: inj ? inj.items.every(it => managers.has(it.name)) : false,
    liveInjRows: liveInj.length };
});
if (artBoard.skip) {
  check("the column's power board matches the site's", true, `skipped: ${artBoard.skip}`);
} else {
  check("the column prints all twelve board rows", artBoard.rows === 12, `${artBoard.rows}`);
  check("every rank, record, points and arrow matches powerRankings()",
    artBoard.mism.length === 0, artBoard.mism.slice(0, 4).join(" | "));
  // The article's injury table is a snapshot of the week it was written; the
  // live board reads whatever status Sleeper is carrying right now. Asserting
  // the two match was wrong — it fails the moment any player is upgraded or
  // ruled out, which happens continuously. What must hold is that the table is
  // well formed and names real managers; the numbers were checked when written.
  check("the column's injury table is well formed",
    artBoard.injRows > 0 && artBoard.injNamesReal,
    `${artBoard.injRows} rows, names real: ${artBoard.injNamesReal}`);
}
const blurbs = await page.evaluate(async () => {
  const D = window.__DFFL;
  const before = { ok: window.__DFFL.loadBlurbs && true };
  // Whatever rankings.json holds, the board must render. Prove the lookup is a
  // pure miss when the file has nothing for the week on screen.
  const missing = D.blurbFor("1999", 99, [...D.DB.mgr.keys()][0]);
  const panel = document.querySelector('[data-panel="power"]');
  const sel = panel.querySelectorAll("select")[1];
  sel.value = "14"; sel.dispatchEvent(new Event("change"));
  return {
    ...before, missing,
    rows: panel.querySelectorAll(".pwrow").length,
    fallbackLines: [...panel.querySelectorAll(".pwrow .id .s")].filter(n => n.textContent.trim().length).length,
    note: /rankings\.json/.test(panel.innerText),
  };
});
check("a blurb lookup with nothing behind it returns nothing, not an error", blurbs.missing === null);
check("the board renders in full without any blurbs", blurbs.rows === 12 && blurbs.fallbackLines === 12);
check("the page says where the blurbs come from", blurbs.note);

const noFile = await page.evaluate(async () => {
  // Simulate the file being absent entirely: the loader swallows it and the
  // rest of the page carries on.
  const D = window.__DFFL;
  const realFetch = window.fetch;
  window.fetch = u => String(u).includes("rankings.json")
    ? Promise.resolve({ ok: false, status: 404, json: () => Promise.reject(new Error("404")) })
    : realFetch(u);
  let threw = null;
  try {
    const saved = D.blurbFor("x", 1, "y");
    await (async () => { const f = D.loadBlurbs; return f && f(); })();
  } catch (e) { threw = String(e); }
  window.fetch = realFetch;
  return { threw, stillThere: document.querySelectorAll('[data-panel="power"] .pwrow').length };
});
check("a missing rankings.json never throws", noFile.threw === null, String(noFile.threw));
check("the board survives a missing rankings.json", noFile.stillThere === 12);

// And the other half of the contract: when the weekly job HAS written a line,
// the board shows it in place of the fallback.
const withBlurbs = await page.evaluate(async () => {
  const D = window.__DFFL;
  const panel = document.querySelector('[data-panel="power"]');
  const top = window.__POWER.get("2025").boards[13].rows[0];
  const name = nameOf(top.uid);
  const stub = { weeks: [{ season: "2025", week: 14, teams: [{ manager: name, blurb: "Test line from the weekly job." }] }] };
  const realFetch = window.fetch;
  window.fetch = u => String(u).includes("rankings.json")
    ? Promise.resolve({ ok: true, json: () => Promise.resolve(stub) })
    : realFetch(u);
  await D.loadBlurbs(true);
  window.fetch = realFetch;
  const sel = panel.querySelectorAll("select")[1];
  sel.value = "1"; sel.dispatchEvent(new Event("change"));
  sel.value = "14"; sel.dispatchEvent(new Event("change"));
  const first = panel.querySelector(".pwrow .id .s").textContent.trim();
  const other = [...panel.querySelectorAll(".pwrow .id .s")][1].textContent.trim();
  const noteGone = !/rankings\.json/.test(panel.innerText);
  const lookup = D.blurbFor("2025", 14, top.uid);
  const caseInsensitive = D.blurbFor("2025", 14, top.uid) === stub.weeks[0].teams[0].blurb;
  return { first, other, noteGone, lookup, caseInsensitive, name };
});
check("a blurb written by the job replaces the fallback line", withBlurbs.first === "Test line from the weekly job.", withBlurbs.first);
check("teams the job didn't write about keep their fallback", /points for/.test(withBlurbs.other), withBlurbs.other);
check("the blurb lookup matches on manager name", withBlurbs.caseInsensitive && withBlurbs.lookup !== null);
check("the where-do-blurbs-come-from note steps aside once they arrive", withBlurbs.noteGone);

group("The site's own data files are never served stale");
const freshness = await page.evaluate(async () => {
  // Record how each file is asked for. Ours must revalidate; Sleeper's must not
  // be forced to, since those are cross-origin and change on their own clock.
  const seen = [];
  const realFetch = window.fetch;
  window.fetch = (u, opt) => { seen.push({ u: String(u), mode: (opt || {}).cache || "default" }); return realFetch(u, opt); };
  const D = window.__DFFL;
  await D.loadADP();
  await D.loadStatedKeepers(true);
  await D.loadBlurbs(true);
  await D.panelRecaps();
  window.fetch = realFetch;
  const ours = seen.filter(x => !/^https?:/i.test(x.u));
  const theirs = seen.filter(x => /sleeper\.app/i.test(x.u));
  return {
    ours: ours.map(x => `${x.u}:${x.mode}`),
    allOursRevalidate: ours.length > 0 && ours.every(x => x.mode === "no-cache"),
    sleeperUntouched: theirs.every(x => x.mode === "default"),
  };
});
check("every file this site owns is revalidated on load", freshness.allOursRevalidate, freshness.ours.join(" | "));
check("Sleeper's endpoints are left to the browser", freshness.sleeperUntouched);

group("Power rankings: the preseason projection");
const projB = await page.evaluate(() => {
  const D = window.__DFFL, P = window.__PROJ, O = window.__ODDS, S = window.__SIM;
  if (!P) return { none: true, postDraft: O && O.postDraft };
  const means = P.rows.map(r => r.mean);
  const byUid = new Map(O.teams.map(t => [t.uid, t]));
  return {
    none: false, season: P.season, n: P.rows.length,
    ranksArePermutation: P.rows.map(r => r.rank).every((v, i) => v === i + 1),
    sortedByProjection: means.every((v, i) => i === 0 || means[i - 1] >= v),
    // the board must be the odds model, not a second opinion about it
    matchesOddsModel: P.rows.every(r => Math.abs(r.mean - byUid.get(r.uid).mean) < 1e-12),
    splitAddsUp: P.rows.every(r => {
      const t = byUid.get(r.uid);
      return Math.abs((r.fromDraft + r.fromRecord) - t.edge) < 1e-9;
    }),
    playoffSum: P.rows.reduce((a, r) => a + r.playoff, 0),
    winsSum: P.rows.reduce((a, r) => a + r.wins, 0),
    finite: P.rows.every(r => [r.mean, r.wins, r.playoff, r.rosterValue].every(v => isFinite(v))),
  };
});
check("a preseason projection exists once the draft is in", projB.none === false, `postDraft=${projB.postDraft}`);
check("the projection ranks every manager exactly once", projB.n === 12 && projB.ranksArePermutation);
check("it is ordered by projected scoring", projB.sortedByProjection);
check("it is the odds model itself, not a second opinion", projB.matchesOddsModel);
check("the draft and record split adds back to the edge", projB.splitAddsUp);
check("projected playoff odds still sum to six", near(projB.playoffSum, 6, 0.02), `${projB.playoffSum}`);
check("projected wins still sum to 84", near(projB.winsSum, 84, 0.05), `${projB.winsSum}`);
check("no NaN in the projection", projB.finite);

const projDom = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="power"]');
  const sel = panel.querySelectorAll("select")[0];
  const opts = [...sel.options].map(o => o.value);
  sel.value = "__proj"; sel.dispatchEvent(new Event("change"));
  const rows = [...panel.querySelectorAll(".pwrow")];
  const out = {
    hasProjOption: opts.includes("__proj"),
    rows: rows.length,
    arrows: rows.filter(r => /[▲▼]/.test(r.querySelector(".mv").textContent)).length,
    weekDisabled: panel.querySelectorAll("select")[1].disabled,
    saysProjected: /projected · post-draft/i.test(panel.innerText),
    saysWhyDifferent: /Why this board is different/.test(panel.innerText),
    nan: /NaN|undefined|Infinity/.test(panel.innerText),
  };
  sel.value = "2025"; sel.dispatchEvent(new Event("change"));
  return out;
});
check("the projection is pickable from the season list", projDom.hasProjOption);
check("the projection lists every manager", projDom.rows === 12, `${projDom.rows}`);
check("the projection claims no movement", projDom.arrows === 0, `${projDom.arrows}`);
check("the week picker is inert on the projection", projDom.weekDisabled);
check("the projection says plainly what it is", projDom.saysProjected && projDom.saysWhyDifferent);
check("no NaN on the projection board", projDom.nan === false);

group("Recaps: the week around the games");
const recap = await page.evaluate(async () => {
  const D = window.__DFFL;
  // Risers and sliders are the site's own arithmetic, not the job's prose.
  const mv = D.weekMovers("2025", 8);
  const wk1 = D.weekMovers("2025", 1);
  const R = D.allPowerRankings().get("2025");
  const board8 = R.boards[R.weeks.indexOf(8)];
  const realUp = board8.rows.filter(r => r.move > 0).sort((a, b) => b.move - a.move);
  return {
    hasMovers: !!mv,
    upMatchesBoard: mv && mv.up.length && mv.up[0].uid === realUp[0].uid && mv.up[0].move === realUp[0].move,
    upAllPositive: mv && mv.up.every(r => r.move > 0),
    downAllNegative: mv && mv.down.every(r => r.move < 0),
    capped: mv && mv.up.length <= 3 && mv.down.length <= 3,
    week1None: wk1 === null,
    unknownSeason: D.weekMovers("1999", 4) === null,
  };
});
check("the recap's movers come straight off the power board", recap.upMatchesBoard);
check("climbers climbed and fallers fell", recap.upAllPositive && recap.downAllNegative);
check("the movers strip is capped at three a side", recap.capped);
check("week 1 has no movers to show", recap.week1None);
check("a season with no boards yields no movers", recap.unknownSeason);

const recapDom = await page.evaluate(async () => {
  const D = window.__DFFL;
  // Feed the renderer a full week in the new shape and check every part lands.
  const stub = { weeks: [{
    season: "2025", week: 8, note: "",
    lede: "A lede paragraph about the week as a whole.",
    games: [{ headline: "H", winner: "drewkim", winner_points: 120, loser: "Domo112", loser_points: 100, body: "Game body." }],
    around: [
      { kind: "trade", headline: "A trade happened", body: "Trade body." },
      { kind: "waivers", headline: "Someone spent", body: "Waiver body." },
      { kind: "bogus", headline: "Unknown kind", body: "Falls back." },
    ],
  }] };
  const realFetch = window.fetch;
  window.fetch = u => String(u).includes("recaps.json")
    ? Promise.resolve({ ok: true, json: () => Promise.resolve(stub) })
    : realFetch(u);
  const panel = await D.panelRecaps();
  window.fetch = realFetch;
  const txt = panel.innerText;
  return {
    lede: !!panel.querySelector(".lede"),
    ledeText: /lede paragraph/.test(txt),
    games: panel.querySelectorAll(".recap").length,
    around: panel.querySelectorAll(".atl").length,
    kindLabels: [...panel.querySelectorAll(".atl .kl")].map(n => n.textContent),
    movers: panel.querySelectorAll(".mvr").length,
    heads: [...panel.querySelectorAll(".sechead h2")].map(n => n.textContent),
    nan: /NaN|undefined/.test(txt),
  };
});
check("the lede renders above the games", recapDom.lede && recapDom.ledeText);
check("every game still renders", recapDom.games === 1, `${recapDom.games}`);
check("every notebook item renders", recapDom.around === 3, `${recapDom.around}`);
check("an unknown item kind falls back rather than breaking", recapDom.kindLabels.join(",") === "Trade,Waivers,Around the league", recapDom.kindLabels.join(","));
check("the computed movers ride along with the copy", recapDom.movers > 0, `${recapDom.movers}`);
check("the week is sectioned into games and the rest", recapDom.heads.includes("The games") && recapDom.heads.includes("Around the league"), recapDom.heads.join(" / "));
check("no NaN in a rendered week", recapDom.nan === false);

const recapOld = await page.evaluate(async () => {
  // A week written in the old shape — games only, no lede, no notebook — must
  // still render, because that is what is already committed.
  const D = window.__DFFL;
  const stub = { weeks: [{ season: "2025", week: 3, games: [
    { headline: "Old shape", winner: "drewkim", winner_points: 1, loser: "Domo112", loser_points: 0, body: "b" }] }] };
  const realFetch = window.fetch;
  window.fetch = u => String(u).includes("recaps.json")
    ? Promise.resolve({ ok: true, json: () => Promise.resolve(stub) }) : realFetch(u);
  const panel = await D.panelRecaps();
  window.fetch = realFetch;
  return { games: panel.querySelectorAll(".recap").length, lede: panel.querySelectorAll(".lede").length,
    around: panel.querySelectorAll(".atl").length, empty: panel.querySelectorAll(".empty").length };
});
check("a week in the old games-only shape still renders", recapOld.games === 1 && recapOld.empty === 0);
check("nothing is invented where the job wrote nothing", recapOld.lede === 0 && recapOld.around === 0);

const recapGone = await page.evaluate(async () => {
  const D = window.__DFFL;
  const realFetch = window.fetch;
  window.fetch = u => String(u).includes("recaps.json")
    ? Promise.reject(new Error("404")) : realFetch(u);
  let threw = null, panel = null;
  try { panel = await D.panelRecaps(); } catch (e) { threw = String(e); }
  window.fetch = realFetch;
  return { threw, empty: panel ? panel.querySelectorAll(".empty").length : -1 };
});
check("a missing recaps.json never throws", recapGone.threw === null, String(recapGone.threw));
check("a missing recaps.json shows the waiting state", recapGone.empty === 1);

group("Finishing order follows the scoreboard");
const finish = await page.evaluate(() => {
  const DB = window.__DFFL.DB;
  const out = { seasons: [], wrong: [], gaps: [], toilet: [], lastPerSeason: {} };
  for (const s of DB.seasons) {
    if (!s.complete) continue;
    out.seasons.push(s.season);
    const nm = r => { const u = s.uidOf.get(r); return u ? nameOf(u) : "r" + r; };
    const place = new Map(Object.entries(s.places).map(([pl, rid]) => [Number(rid), Number(pl)]));
    // every place 1..N exactly once
    const pl = Object.keys(s.places).map(Number).sort((a, b) => a - b);
    if (pl.length !== s.rosters.length || pl.some((v, i) => v !== i + 1)) out.gaps.push(`${s.season}: ${pl.join(",")}`);
    // THE invariant: in any tie that decided a placing, whoever scored more
    // must finish above whoever scored less. This is what was broken.
    for (const bracket of [s.wb, s.lb]) for (const m of bracket || []) {
      if (!m.p || !m.t1 || !m.t2) continue;
      const games = s.games.filter(g => g.playoff &&
        ((g.a.rid === m.t1 && g.b.rid === m.t2) || (g.a.rid === m.t2 && g.b.rid === m.t1)));
      if (!games.length) continue;
      const g = games[games.length - 1];
      if (g.a.pts === g.b.pts) continue;
      const won = g.a.pts > g.b.pts ? g.a.rid : g.b.rid;
      const lost = won === g.a.rid ? g.b.rid : g.a.rid;
      if (!(place.get(won) < place.get(lost)))
        out.wrong.push(`${s.season}: ${nm(won)} beat ${nm(lost)} ${g.a.pts.toFixed(1)}-${g.b.pts.toFixed(1)} but finished ${place.get(won)} to ${place.get(lost)}`);
    }
    // the consolation must read as a toilet bowl: Sleeper's "winner" lost
    let contrary = 0, checked = 0;
    for (const m of s.lb || []) {
      if (!m.t1 || !m.t2 || m.w == null) continue;
      const games = s.games.filter(g => g.playoff &&
        ((g.a.rid === m.t1 && g.b.rid === m.t2) || (g.a.rid === m.t2 && g.b.rid === m.t1)));
      if (!games.length) continue;
      const g = games[games.length - 1];
      const won = g.a.pts > g.b.pts ? g.a.rid : g.b.rid;
      checked++; if (won !== m.w) contrary++;
    }
    out.toilet.push(`${s.season}: ${contrary}/${checked}`);
    out.lastPerSeason[s.season] = nm(Number(s.places[s.rosters.length]));
  }
  return out;
});
check("every place is filled exactly once, every season", finish.gaps.length === 0, finish.gaps.join(" | "));
check("whoever won a placing game finishes above whoever lost it", finish.wrong.length === 0, finish.wrong.slice(0, 3).join(" | "));
check("the consolation reads as a toilet bowl in every season",
  finish.toilet.every(t => { const [a, b] = t.split(": ")[1].split("/"); return a === b && Number(b) > 0; }), finish.toilet.join(" | "));
// the one the league itself corrected us on
check("2025 last place is the team that lost the toilet bowl", finish.lastPerSeason["2025"] === "chassinator", JSON.stringify(finish.lastPerSeason));

const lastSim = await page.evaluate(() => {
  const D = window.__DFFL, O = window.__ODDS, S = window.__SIM, n = S.sims;
  const rows = O.teams.map((t, i) => ({ name: nameOf(t.uid), last: S.last[i] / n, edge: t.edge }))
    .sort((a, b) => a.edge - b.edge);
  return {
    sum: rows.reduce((a, r) => a + r.last, 0),
    worstHasRisk: rows[0].last > 0.02,
    // the old model made the two worst seeds structurally safe; they must not be
    zeroes: rows.filter(r => r.last === 0).length,
    worst: `${rows[0].name} ${(rows[0].last * 100).toFixed(1)}%`,
    best: `${rows[rows.length - 1].name} ${(rows[rows.length - 1].last * 100).toFixed(1)}%`,
  };
});
check("the last-place market still sums to 1", near(lastSim.sum, 1, 0.002), `${lastSim.sum}`);
check("the worst team carries real last-place risk", lastSim.worstHasRisk, lastSim.worst);
check("nobody is structurally safe from last", lastSim.zeroes === 0, `${lastSim.zeroes} teams at 0%`);

group("News & Articles");
const tabName = await page.evaluate(() =>
  document.querySelector('#tabs button[data-tab="recaps"]').textContent);
check("the tab is named for what it holds now", tabName === "News & Articles", tabName);
check("the old #recaps link still works", (await page.evaluate(() => !!document.querySelector('[data-panel="recaps"]'))));

const artl = await page.evaluate(async () => {
  const D = window.__DFFL;
  const panel = await D.panelRecaps();
  document.body.appendChild(panel);
  const teasers = [...panel.querySelectorAll(".teaser")];
  const out = {
    teasers: teasers.length,
    covers: panel.querySelectorAll(".teaser .cover").length,
    faces: panel.querySelectorAll(".teaser .cover img").length,
    headlines: teasers.map(t => t.querySelector("h3").textContent),
    // the index is a list of links, not the articles themselves
    noBodyOnIndex: panel.querySelectorAll(".apara").length === 0,
    columnFlagged: panel.querySelectorAll(".teaser.op .oflag").length,
  };
  panel.remove();
  // What the file says should lead, rather than a headline frozen into a test
  // that every new piece would then break.
  const j = await (await fetch("recaps.json", { cache: "no-cache" })).json();
  const byDate = (j.articles || []).slice()
    .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
  out.published = byDate.length;
  out.expectedLead = byDate.length ? byDate[0].headline : null;
  out.newestFirst = out.headlines[0] === out.expectedLead;
  return out;
});
check("every published piece is on the index",
  artl.teasers === artl.published && artl.teasers >= 3 && artl.noBodyOnIndex,
  `${artl.teasers} teasers for ${artl.published} articles`);
check("every headline carries a cover, with no headshots on the index", artl.covers === artl.teasers && artl.faces === 0, `${artl.covers} covers, ${artl.faces} faces`);
check("the newest piece leads", artl.newestFirst, `${artl.headlines[0]} — expected ${artl.expectedLead}`);
check("a column is flagged as a column", artl.columnFlagged === 1, `${artl.columnFlagged}`);

group("News: the Allen three-team trade");
/* The piece is checked against the files it was written from: the trade as
 * pulse.json logged it, and every score it quotes against the week files. */
{
  const rj = JSON.parse(await readFile(join(ROOT, "recaps.json"), "utf8"));
  const pulse = JSON.parse(await readFile(join(ROOT, "data/pulse.json"), "utf8"));
  const wk = await Promise.all([1, 2, 3, 4, 5].map(async w =>
    JSON.parse(await readFile(join(ROOT, `data/week-2026-0${w}.json`), "utf8"))));
  const art = (rj.articles || []).find(a => a.slug === "josh-allen-goes-to-the-leagues-top-scorer");
  check("the trade piece is published", !!art);
  if (art) {
    const text = JSON.stringify(art);
    const tx = (pulse.trades || []).find(t => t.managers.length === 3 && t.adds.some(x => x.name === "Josh Allen"));
    check("pulse.json logs the trade it reports", !!tx);
    if (tx) {
      const to = Object.fromEntries(tx.adds.map(x => [x.name, x.to]));
      check("the piece sends each player where the log does",
        to["Josh Allen"] === "jadencha" && to["Jordan Love"] === "saucebossandrew" && to["J.K. Dobbins"] === "jskule23",
        JSON.stringify(to));
      check("the piece names every manager and player in the trade",
        [...tx.managers, ...tx.adds.map(x => x.name)].every(n => text.includes(n)));
      check("both picks are the ones logged",
        tx.picks.length === 2 && tx.picks.every(p => p.season === "2027" && p.to === "jskule23") &&
        tx.picks.some(p => p.round === 5 && p.from === "jadencha") && tx.picks.some(p => p.round === 9 && p.from === "saucebossandrew"));
    }
    // Every score a side's starters or best bench player put up, by week, for one player on one roster.
    const pts = (w, mgr, name) => {
      const s = wk[w - 1].games.flatMap(g => g.sides).find(x => x.manager === mgr);
      const p = s && [...s.starters, s.benchBest].find(x => x && x.name === name);
      return p ? p.points : null;
    };
    const allen = [1, 2, 3, 4, 5].map(w => pts(w, "jskule23", "Josh Allen"));
    const bars = art.blocks.find(b => b.type === "bars");
    check("Allen's week-by-week bars match jskule23's lineups",
      bars && bars.rows.every((r, i) => r.value === allen[i]), `${allen.join(", ")}`);
    const total = allen.reduce((a, b) => a + b, 0);
    check("the pull-out total is Allen's five weeks added up",
      art.blocks.find(b => b.type === "stat").n === total.toFixed(2), total.toFixed(2));
    check("Love's 25.28 and Dobbins's 14.4 are jadencha's week 5",
      pts(5, "jadencha", "Jordan Love") === 25.28 && pts(5, "jadencha", "J.K. Dobbins") === 14.4 && text.includes("25.28") && text.includes("14.4"));
    const st = Object.fromEntries(wk[4].standings.map(s => [s.manager, `${s.wins}-${s.losses} · ${s.points_for}`]));
    check("the cards carry each side's record and points through week 5",
      ["jadencha", "jskule23", "saucebossandrew"].every(m => text.includes(st[m])), JSON.stringify(st));
  }
}

await page.click('#tabs button[data-tab="recaps"]');
await page.waitForFunction(() => document.querySelectorAll('[data-panel="recaps"] .teaser').length > 0, null, { timeout: 20000 });
// Open pieces by name. Selecting by position meant that publishing anything new
// silently retargeted these checks at a different article.
const opened = await page.evaluate((want) => {
  const t = [...document.querySelectorAll('[data-panel="recaps"] .teaser')]
    .find(x => x.querySelector("h3").textContent === want);
  if (!t) throw new Error("no teaser headlined " + want);
  t.click();
  const a = document.querySelector('[data-panel="article"]');
  const txt = a ? a.innerText : "";
  return {
    exists: !!a,
    indexHidden: document.querySelector('[data-panel="recaps"]').hidden,
    headline: a ? a.querySelector("h2").textContent : null,
    hero: a ? a.querySelectorAll(".cover.big").length : 0,
    back: a ? !!a.querySelector(".back") : false,
    paras: a ? a.querySelectorAll(".apara").length : 0,
    leads: a ? a.querySelectorAll(".apara.lead").length : 0,
    heads: a ? a.querySelectorAll(".ahead h3").length : 0,
    stats: a ? a.querySelectorAll(".astat").length : 0,
    bars: a ? a.querySelectorAll(".abar").length : 0,
    cards: a ? a.querySelectorAll(".acard").length : 0,
    picks: a ? a.querySelectorAll(".apick").length : 0,
    bold: a ? a.querySelectorAll(".apara b").length : 0,
    barsBothWays: (() => {
      const f = [...(a ? a.querySelectorAll(".abar .fill") : [])].map(n => parseFloat(n.style.left));
      return f.some(l => l < 49.9) && f.some(l => l >= 49.9);
    })(),
    nan: /NaN|undefined/.test(txt),
  };
}, "The CPES Problem");
check("clicking a headline opens the full article", opened.exists && opened.indexHidden && opened.headline === "The CPES Problem", opened.headline);
check("the article page leads with its cover", opened.hero === 1);
check("there is a way back to the index", opened.back);
check("every block type renders in the article", opened.paras > 20 && opened.heads === 8 && opened.stats === 2 && opened.bars === 12 && opened.cards === 3 && opened.picks === 5,
  `${opened.paras}p ${opened.heads}h ${opened.stats}stat ${opened.bars}bar ${opened.cards}card ${opened.picks}pick`);
check("the lead paragraph is marked for its drop cap", opened.leads === 1, `${opened.leads}`);
check("bold survives the escaping", opened.bold > 5, `${opened.bold}`);
check("the projection bars diverge both ways", opened.barsBothWays);
check("no NaN in the article", opened.nan === false);

const column = await page.evaluate((want) => {
  document.querySelector('[data-panel="article"] .back').click();
  const t = [...document.querySelectorAll('[data-panel="recaps"] .teaser')]
    .find(x => x.querySelector("h3").textContent === want);
  if (!t) throw new Error("no teaser headlined " + want);
  t.click();
  const a = document.querySelector('[data-panel="article"]');
  const rounds = [...a.querySelectorAll(".brd .brh")].map(n => n.textContent);
  return {
    headline: a.querySelector("h2").textContent,
    isColumn: !!a.querySelector(".artl.op") && !!a.querySelector(".oflag"),
    brackets: a.querySelectorAll(".bracket").length,
    matches: a.querySelectorAll(".brm").length,
    rounds,
    winners: a.querySelectorAll(".bside.won").length,
    placed: a.querySelectorAll(".brm.placed").length,
    // the bracket must show the two worst records starting in round two
    r1: [...a.querySelectorAll(".brd")][0].innerText,
  };
}, "I Owe The Toilet Bowl An Apology");
check("back returns to the index and the column opens", column.headline === "I Owe The Toilet Bowl An Apology", column.headline);
check("the column reads as opinion", column.isColumn);
check("the toilet bowl bracket renders in full", column.brackets === 1 && column.matches === 7 && column.rounds.length === 3,
  `${column.matches} matches, rounds: ${column.rounds.join("/")}`);
check("every tie in the bracket has a winner marked", column.winners === column.matches, `${column.winners} of ${column.matches}`);
check("the placing games are called out", column.placed === 3, `${column.placed}`);
check("the two worst records are absent from round one", !/chassinator|wesley55/.test(column.r1), column.r1.replace(/\n/g, " "));
check("the column shows the drop, not a consolation ladder", /The drop/.test(column.rounds.join("/")), column.rounds.join("/"));

const nine = await page.evaluate((want) => {
  document.querySelector('[data-panel="article"] .back').click();
  const t = [...document.querySelectorAll('[data-panel="recaps"] .teaser')]
    .find(x => x.querySelector("h3").textContent === want);
  if (!t) throw new Error("no teaser headlined " + want);
  t.click();
  const a = document.querySelector('[data-panel="article"]');
  const txt = a.innerText;
  const fills = [...a.querySelectorAll(".abar .fill")].map(n => parseFloat(n.style.left));
  return {
    headline: a.querySelector("h2").textContent,
    paras: a.querySelectorAll(".apara").length,
    leads: a.querySelectorAll(".apara.lead").length,
    heads: a.querySelectorAll(".ahead h3").length,
    stats: a.querySelectorAll(".astat").length,
    bars: a.querySelectorAll(".abar").length,
    cards: a.querySelectorAll(".acard").length,
    note: a.querySelectorAll(".anote").length,
    bothWays: fills.some(l => l < 49.9) && fills.some(l => l >= 49.9),
    nan: /NaN|undefined/.test(txt),
    // the two figures the whole piece rests on
    quotes0009: /0\.09/.test(txt),
    quotes598: /598/.test(txt),
    namesBoth: /Domo112/.test(txt) && /saucebossandrew/.test(txt),
    // and it must not claim a rank the site would contradict
    noRankClaim: !/first in the league|top of the board/i.test(txt),
  };
}, "The Nine-Game Difference");
check("the new piece opens", nine.headline === "The Nine-Game Difference", nine.headline);
check("it is built out of blocks, not a wall of text",
  nine.paras === 10 && nine.heads === 4 && nine.stats === 2 && nine.cards === 2 && nine.note === 1,
  `${nine.paras}p ${nine.heads}h ${nine.stats}stat ${nine.cards}card ${nine.note}note`);
check("its luck chart carries all thirteen managers", nine.bars === 13, `${nine.bars}`);
check("that chart diverges both ways", nine.bothWays);
check("one lead paragraph, for the drop cap", nine.leads === 1, `${nine.leads}`);
check("the two figures it rests on are both in it", nine.quotes0009 && nine.quotes598);
check("both managers are named", nine.namesBoth);
check("no NaN anywhere in it", nine.nan === false);

/* The teaser: ten plain-text lines for the group chat at the foot of every
 * article, with a Copy button. The shape rules live in check-recaps.mjs, the
 * same file the weekly job runs before it pushes. */
group("Article teasers");
{
  const { recapsProblems, teaserLink, SITE } = await import(new URL("./check-recaps.mjs", import.meta.url));
  const rj = JSON.parse(await readFile(join(ROOT, "recaps.json"), "utf8"));
  const arts = rj.articles || [];
  const probs = recapsProblems(rj);
  check("every article has a teaser in the ten-line shape, <=600 chars, no HTML, every stat number in its article",
    arts.length > 0 && probs.length === 0, probs.slice(0, 3).join(" | ") || `${arts.length} articles`);
  const { spawnSync } = await import("node:child_process");
  const cr = spawnSync(process.execPath, ["check-recaps.mjs"], { cwd: ROOT, encoding: "utf8", timeout: 60000 });
  check("check-recaps.mjs exits 0 on the committed recaps.json", cr.status === 0, String(cr.stdout || cr.stderr).slice(-200));
  // The check has to bite: a number the article never prints, and a link to another piece, both fail.
  const a0 = arts[0], L0 = a0.teaser.split("\n");
  const { teaserProblems } = await import(new URL("./check-recaps.mjs", import.meta.url));
  const slugs = new Set(arts.map(a => a.slug));
  const badNum = teaserProblems({ ...a0, teaser: [...L0.slice(0, 4), "📈 98765.4 of nothing", ...L0.slice(5)].join("\n") }, slugs);
  const badLink = teaserProblems({ ...a0, teaser: [...L0.slice(0, 9), teaserLink(arts[1].slug)].join("\n") }, slugs);
  check("an invented stat number or another piece's link fails the teaser check",
    badNum.some(p => /98765\.4/.test(p)) && badLink.some(p => /last line/.test(p)), `${badNum.length}/${badLink.length}`);
  // Every teaser link names the piece it came with: the ?a=<slug> it carries resolves to that article.
  const resolved = await page.evaluate(async list => {
    const out = [];
    for (const { slug, link, site } of list) {
      const u = new URL(link);
      const a = u.href.startsWith(site) && u.pathname === new URL(site).pathname
        ? await window.__DFFL.articleBySlug(u.searchParams.get("a")) : null;
      if (!a || a.slug !== slug) out.push(slug);
    }
    return out;
  }, arts.map(a => ({ slug: a.slug, link: a.teaser.split("\n").pop(), site: SITE })));
  check("every teaser's link opens its own article", resolved.length === 0, resolved.join(", "));

  // The newest piece, loaded straight from its teaser link at 390, the way a tap from the chat lands.
  const newest = arts.slice().sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0];
  const tctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["clipboard-read", "clipboard-write"] });
  const tp = await tctx.newPage();
  const terrs = [];
  tp.on("pageerror", e => terrs.push(String(e)));
  await tp.goto(newest.teaser.split("\n").pop().replace(SITE, `${BASE}/`), { waitUntil: "domcontentloaded" });
  await tp.waitForFunction(() => document.querySelector('[data-panel="article"]:not([hidden]) .artl .ateaser'), null, { timeout: 90000 });
  const td = await tp.evaluate(() => {
    const art = document.querySelector('[data-panel="article"] .artl');
    const box = art.querySelector(".ateaser"), btn = box.querySelector(".copytxt"), say = box.querySelector(".say");
    const r = box.getBoundingClientRect(), b = btn.getBoundingClientRect();
    return {
      headline: art.querySelector("h2").textContent,
      last: art.lastElementChild === box,
      afterBlocks: !!(box.previousElementSibling && box.previousElementSibling.classList.contains("abd")),
      text: box.querySelector("pre").textContent,
      live: say.getAttribute("role") === "status" && say.getAttribute("aria-live") === "polite",
      named: /Copy the teaser for/.test(btn.getAttribute("aria-label") || ""),
      inside: r.left >= 0 && r.right <= innerWidth + 0.5,
      overflow: document.documentElement.scrollWidth > innerWidth,
      tap: b.height >= 44,
      taHidden: box.querySelector("textarea").hidden,
    };
  });
  check("a direct load of the teaser link at 390 opens that article", td.headline === newest.headline, td.headline);
  check("the teaser box is the article's last child, right after the last block", td.last && td.afterBlocks);
  check("the box shows the teaser exactly as committed", td.text === newest.teaser);
  check("the box fits 390 with no sideways scroll, a 44px Copy button and a named, live status",
    td.inside && !td.overflow && td.tap && td.live && td.named && td.taHidden, JSON.stringify(td).slice(0, 200));
  await tp.click(".ateaser .copytxt");
  await tp.waitForFunction(() => document.querySelector(".ateaser .say").textContent.length > 0, null, { timeout: 5000 });
  const copied = await tp.evaluate(async () => ({
    clip: await navigator.clipboard.readText(),
    say: document.querySelector(".ateaser .say").textContent,
    taHidden: document.querySelector(".ateaser textarea").hidden,
  }));
  check("Copy puts the teaser on the clipboard and says so", copied.clip === newest.teaser && /^Copied/.test(copied.say) && copied.taHidden,
    copied.say);
  // No clipboard (an old WebView, an insecure origin): the text appears selected in a readonly box.
  await tp.evaluate(() => Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true }));
  await tp.click(".ateaser .copytxt");
  const fb = await tp.evaluate(() => {
    const ta = document.querySelector(".ateaser textarea");
    return { shown: !ta.hidden, ro: ta.readOnly, value: ta.value, focused: document.activeElement === ta,
      sel: ta.value.slice(ta.selectionStart, ta.selectionEnd), say: document.querySelector(".ateaser .say").textContent,
      inside: ta.getBoundingClientRect().right <= innerWidth + 0.5 };
  });
  check("without a clipboard the teaser shows readonly, focused and fully selected, and says so",
    fb.shown && fb.ro && fb.focused && fb.value === newest.teaser && fb.sel === newest.teaser && /Couldn't copy/.test(fb.say) && fb.inside,
    JSON.stringify({ ...fb, value: fb.value.length, sel: fb.sel.length }));
  const bare = await page.evaluate(() => {
    const n = window.__DFFL.articleCard({ headline: "x", blocks: [{ type: "p", text: "y" }] }, true);
    const idx = window.__DFFL.articleCard({ headline: "x", teaser: "t", blocks: [] }, false);
    return n.querySelectorAll(".ateaser").length + idx.querySelectorAll(".ateaser").length;
  });
  check("no teaser box without a teaser, and none outside the full article", bare === 0, `${bare}`);
  check("no page errors on the teaser page", terrs.length === 0, terrs.slice(0, 2).join(" | "));
  await tctx.close();
}

await page.evaluate(() => { const a = document.querySelector('[data-panel="article"]'); if (a) a.remove(); });
const artSafe = await page.evaluate(() => {
  const D = window.__DFFL;
  // Copy in a file is copy, never markup: only emphasis may survive. Rendered
  // through the full-article path, which is the one that draws the body.
  const evil = { season: "2026", date: "2026-01-01", headline: "<img src=x onerror=alert(1)>",
    dek: "<script>alert(2)<\/script>", byline: "x", kicker: "<b>k</b>",
    cover: { tone: "blue", players: ["not-a-player"] },
    blocks: [
      { type: "p", text: "safe <b>bold</b> and <i>italic</i> and <a href=#>link</a>" },
      { type: "h", eyebrow: "<b>eye</b>", text: "<b>head</b>" },
      { type: "bogus", text: "unknown" },
      null,
    ] };
  const node = D.articleCard(evil, true);
  document.body.appendChild(node);
  const p0 = node.querySelector(".apara");
  const out = {
    imgs: node.querySelectorAll(".abd img").length,
    scripts: node.querySelectorAll("script").length,
    anchors: node.querySelectorAll(".abd a").length,
    italics: node.querySelectorAll(".apara i").length,
    boldKept: p0 ? p0.querySelectorAll("b").length : -1,
    paraText: p0 ? p0.textContent : "",
    headlineIsText: node.querySelector("h2").textContent,
    headingHasNoTags: node.querySelector(".ahead h3").children.length,
    unknownDropped: node.querySelectorAll(".abd > *").length,
  };
  node.remove();
  return out;
});
check("markup in the copy is escaped, not run", artSafe.imgs === 0 && artSafe.scripts === 0 && artSafe.anchors === 0);
check("bold and italic survive, nothing else does", artSafe.boldKept === 1 && artSafe.italics === 1, `${artSafe.boldKept} bold, ${artSafe.italics} italic`);
check("tags that are not emphasis read as text", /<a href=#>link<\/a>/.test(artSafe.paraText), artSafe.paraText);
check("a headline is text, whatever it contains", /<img/.test(artSafe.headlineIsText));
check("headings take no markup at all", artSafe.headingHasNoTags === 0);
check("an unknown block type is dropped rather than guessed at", artSafe.unknownDropped === 2, `${artSafe.unknownDropped}`);

const covers = await page.evaluate(async () => {
  const D = window.__DFFL;
  const panel = await D.panelRecaps();
  document.body.appendChild(panel);
  const teasers = [...panel.querySelectorAll(".teaser")];
  const out = {
    teasers: teasers.length,
    drawn: teasers.filter(t => t.querySelectorAll(".cover svg").length === 1 &&
      [...t.querySelectorAll(".cover svg text")].some(x => x.textContent.trim())).length,
    fallbacks: panel.querySelectorAll(".cfall").length,
    fills: [...new Set([...panel.querySelectorAll(".cover svg text")].map(x => x.getAttribute("fill")))],
  };
  panel.remove();
  const arts = ((await (await fetch("recaps.json", { cache: "no-cache" })).json()).articles || []);
  // Same article, fresh object, empty cache: the same bytes.
  out.deterministic = arts.every(a => {
    const s = D.coverSVG(a, false) + D.coverSVG(a, true);
    D.coverSVG.cache.clear();
    return D.coverSVG(structuredClone(a), false) + D.coverSVG(structuredClone(a), true) === s;
  });
  const svgs = arts.flatMap(a => [D.coverSVG(a, false), D.coverSVG(a, true)]);
  out.distinct = new Set(svgs).size === svgs.length;
  out.kinds = new Set(arts.map(D.coverKind)).size;
  out.pairs = new Set(arts.map(a => { const p = D.COVER_PALETTE[D.coverKind(a)]; return p.from + p.to; })).size;
  // WCAG contrast of both text colours on every gradient stop.
  const lum = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map(v => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
  const ratio = (x, y) => { const [hi, lo] = [lum(x), lum(y)].sort((p, q) => q - p); return (hi + .05) / (lo + .05); };
  out.worst = Math.min(...Object.values(D.COVER_PALETTE).flatMap(p => [p.from, p.to])
    .flatMap(s => [ratio("#ffffff", s), ratio("#d4cbe0", s)]));
  const trade = { slug: "verify-trade", season: "2026", date: "2026-10-01", headline: "A Trade", blocks: [],
    cover: { trade: { a: "drewkim", b: "moseslin", aGets: ["Bijan Robinson"], bGets: ["Ja'Marr Chase", "a 2027 1st"] } } };
  const tsvg = D.coverSVG(trade, false);
  out.trade = D.coverKind(trade) === "trade" && /data-layout="trade"/.test(tsvg) &&
    /drewkim/.test(tsvg) && /moseslin/.test(tsvg) && /Bijan Robinson/.test(tsvg);
  const evil = { season: "2026", date: "2026-01-01", headline: "<img src=x onerror=alert(1)>",
    kicker: "<b>k</b>", cover: { players: ["not-a-player"] }, blocks: [] };
  const esvg = D.coverSVG(evil, false) + D.coverSVG(evil, true);
  const box = document.createElement("div");
  box.innerHTML = esvg;
  out.evilSafe = !/<img|<script/i.test(esvg) && box.querySelectorAll("img,script").length === 0 &&
    ![...box.querySelectorAll("*")].some(n => [...n.attributes].some(at => /^on/i.test(at.name)));
  out.evilAsText = /&lt;img/i.test(esvg);
  const bare = arts.find(a => !a.cover);
  if (bare) {
    const node = D.articleCard(bare, true);
    document.body.appendChild(node);
    out.bareHero = node.querySelectorAll(".cover.big svg").length;
    node.remove();
  }
  return out;
});
check("every teaser draws one cover with words on it, and no fallback plates",
  covers.drawn === covers.teasers && covers.teasers > 0 && covers.fallbacks === 0,
  `${covers.drawn} of ${covers.teasers} drawn, ${covers.fallbacks} fallbacks`);
check("cover text is only white or --ink-2", covers.fills.every(f => f === "#ffffff" || f === "#d4cbe0"), covers.fills.join(" "));
check("covers are deterministic and no two alike", covers.deterministic && covers.distinct && (covers.kinds >= 4 || covers.pairs >= 4),
  `${covers.kinds} kinds, ${covers.pairs} gradients`);
check("every cover gradient stop reads at 4.5:1 for both text colours", covers.worst >= 4.5, covers.worst.toFixed(2));
check("a trade draws the trade layout", covers.trade);
check("markup in a headline is escaped into the cover, not run", covers.evilSafe && covers.evilAsText);
check("an article with no cover field still gets a hero cover", covers.bareHero === 1, `${covers.bareHero}`);

// Cover polish. Each of these is aimed at a way the covers have actually gone wrong:
// text past the edge, a cover that says nothing but DFFL, the wrong kind, the wrong
// row lit on a scoreboard, a record read as a number, labels cut mid-word.
const COVER_KIND_TABLE = {
  "bradyrife-bought-the-backup-too": "waivers", "the-cpes-problem": "draft",
  "i-owe-the-toilet-bowl-an-apology": "column", "the-nine-game-difference": "analysis",
  "week-1-game-by-game": "recap", "the-steepest-fall-on-the-board": "odds",
  "one-game-was-on-the-bench": "column", "the-fifty-one-dollar-quarterback": "waivers",
  "same-record-different-board": "odds", "josh-allen-goes-to-the-leagues-top-scorer": "trade",
};
const coverPage = await ctx.newPage();
coverPage.on("pageerror", e => errors.push(String(e)));
await coverPage.goto(BASE, { waitUntil: "domcontentloaded" });
await coverPage.waitForFunction(() => document.body.dataset.ready, null, { timeout: 90000 });
const coverAudit = () => coverPage.evaluate(async () => {
  const D = window.__DFFL;
  const plain = s => String(s ?? "").replace(/<\/?[bi]>/gi, "").replace(/\s+/g, " ").trim();
  const arts = ((await (await fetch("recaps.json", { cache: "no-cache" })).json()).articles || []);
  const panel = await D.panelRecaps();
  document.body.appendChild(panel);
  const covers = [...panel.querySelectorAll(".teaser")].map(t => ({
    a: arts.find(x => x.headline === t.querySelector("h3").textContent), svg: t.querySelector(".cover svg"), where: "card" }));
  // Heroes as a reader gets them: the article opened for real, at this viewport.
  const heroH = [];
  for (const a of arts) {
    D.openArticle(a, true);
    const hero = document.querySelector('[data-panel="article"] .cover.big');
    heroH.push(hero.getBoundingClientRect().height);
    covers.push({ a, svg: hero.querySelector("svg").cloneNode(true), where: "hero" });
  }
  // The clones are laid out in a holder so getBBox() works on them.
  const holder = document.createElement("div");
  document.body.appendChild(holder);
  for (const c of covers) if (c.where === "hero") holder.appendChild(c.svg);
  const out = { n: covers.length, heroH, overflow: [], content: [], labels: [], kinds: [], weights: [] };
  for (const { a, svg, where } of covers) {
    const tag = `${where}:${a.slug}`, vb = svg.viewBox.baseVal;
    const texts = [...svg.querySelectorAll("text")], words = texts.map(t => t.textContent);
    for (const t of texts) {
      const b = t.getBBox();
      if (b.x < 2 || b.y < 2 || b.x + b.width > vb.width - 2 || b.y + b.height > vb.height - 2)
        out.overflow.push(`${tag} "${t.textContent}" ${[b.x, b.y, b.x + b.width, b.y + b.height].map(Math.round).join(",")} in ${vb.width}x${vb.height}`);
    }
    // Real content, not just the wordmark and label.
    const head = plain(a.headline).toUpperCase(), joined = words.join(" "), layout = svg.dataset.layout;
    const blocks = (a.blocks || []).filter(Boolean);
    const cards = blocks.find(b => b.type === "cards" && (b.items || []).length === 2);
    let ok;
    if (layout === "title") ok = !!head && joined.includes(head);
    else if (layout === "stat") ok = joined.includes(head) && words.includes(plain(blocks.find(b => b.type === "stat").n));
    else if (layout === "versus") ok = cards && ["odds", "analysis"].includes(svg.dataset.kind)
      ? cards.items.flatMap(i => [i.title, i.big]).map(plain).every(s => words.includes(s))
      : svg.querySelectorAll("text.cv-name").length === 2 && svg.querySelectorAll("text.cv-num").length === 2 &&
        [...svg.querySelectorAll("text.cv-name")].every(t => t.textContent && JSON.stringify(a).includes(t.textContent));
    else ok = false;
    if (!ok) out.content.push(`${tag} (${layout}): ${words.join(" | ")}`);
    // The label: there, and cut (if at all) only after a whole word of the piece's own copy.
    const tok = s => String(s).toUpperCase().split(/[\s·,;:—–]+/).filter(Boolean);
    const allowed = new Set([...tok([a.cover && a.cover.caption, a.kicker, a.season, a.headline].map(plain).join(" ")),
      "WEEK", ...Object.keys(D.COVER_PALETTE).map(k => k.toUpperCase())]);
    const lab = svg.querySelector("text.cv-label"), lt = lab ? lab.textContent : "";
    const bad = tok(lt.replace(/…$/, "")).filter(w => !allowed.has(w));
    if (!lt.trim() || bad.length || /…./.test(lt)) out.labels.push(`${tag}: "${lt}"${bad.length ? " (" + bad.join(",") + ")" : ""}`);
    if (svg.dataset.kind !== D.coverKind(a)) out.kinds.push(`${tag}: drawn ${svg.dataset.kind}, coverKind ${D.coverKind(a)}`);
    for (const n of svg.querySelectorAll("*")) {
      const w = n.getAttribute("font-weight") || n.style.fontWeight;
      if (w && (+w > 700 || /bold(er)?$/i.test(w) && w !== "bold")) out.weights.push(`${tag}: ${w}`);
    }
  }
  const one = (slug, where) => covers.find(c => c.a.slug === slug && c.where === where);
  const rows = c => Object.fromEntries([...c.svg.querySelectorAll("text.cv-name")].map(t => [t.textContent, t.getAttribute("fill")]));
  out.steep = ["card", "hero"].map(w => rows(one("the-steepest-fall-on-the-board", w)));
  // Who is drawn in white, where the copy names both managers and the figures must decide.
  out.lit = Object.fromEntries(["week-1-game-by-game", "the-nine-game-difference"].flatMap(s => ["card", "hero"].map(w =>
    [`${w}:${s}`, Object.entries(rows(one(s, w))).filter(([, f]) => f === "#ffffff").map(([n]) => n).join("+")])));
  out.nine = ["card", "hero"].map(w => [...one("the-nine-game-difference", w).svg.querySelectorAll("text")].map(t => t.textContent));
  out.kindOf = Object.fromEntries(arts.map(a => [a.slug, D.coverKind(a)]));
  holder.remove();
  panel.remove();
  return out;
});
const cov1280 = await coverAudit();
await coverPage.setViewportSize({ width: 390, height: 844 });
const cov390 = await coverAudit();
const coverEdge = await coverPage.evaluate(() => {
  const D = window.__DFFL, out = {};
  const texts = s => { const b = document.createElement("div"); b.innerHTML = s; return [...b.querySelectorAll("text")].map(t => t.textContent); };
  out.draftDay = D.coverKind({ slug: "draft-day-regrets", season: "2026", kicker: "2026 · week 4", headline: "Draft Day Regrets", blocks: [] });
  const noHead = { slug: "verify-no-headline", date: "2026-10-02", blocks: [] };
  out.dffl = ["card", "hero", "wide"].map(v => texts(D.coverSVG(noHead, v)).filter(t => t === "DFFL").length);
  const empty = { slug: "verify-empty-cards", source: "saturday", headline: "Empty Cards Here", date: "2026-10-03",
    blocks: [{ type: "cards", items: [{}, {}] }] };
  const half = { slug: "verify-half-cards", source: "saturday", headline: "Half a Scoreboard", date: "2026-10-04",
    blocks: [{ type: "cards", items: [{ title: "drewkim", big: "12.0" }, { title: "moseslin" }] }] };
  out.emptyCards = [empty, half].flatMap(a => ["card", "wide"].map(v => {
    const s = D.coverSVG(a, v);
    return /data-layout="title"/.test(s) && texts(s).join(" ").includes(a.headline.toUpperCase());
  }));
  try {
    const s = { slug: "verify-string-players", headline: "String Players", date: "2026-10-05", cover: { players: "8150" }, blocks: [] };
    const h = D.coverHTML(s, false) + D.coverHTML(s, true) + D.coverSVG(s, "wide");
    out.strPlayers = (h.match(/<img/g) || []).length === 0 ? "ok" : "drew headshots from a string";
  } catch (e) { out.strPlayers = String(e); }
  return out;
});
// Every word on a cover, as the reader sees it, clears the site's 11px floor. The svg
// scales with its width, so what lands on screen is font-size x (shown width / viewBox
// width): measured on the covers as laid out, on the Home "From the desk" cards, the
// News cards and all nine article heroes, at two phone widths and at desktop. Same page
// as the audit above, resized, so no extra page loads (or Sleeper calls).
const coverTextSizes = async (width, height) => {
  await coverPage.setViewportSize({ width, height });
  return coverPage.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const seen = [], squeezed = [], strands = [], weakFigures = [];
    const NOBREAK = /^(?:the|by|of|a|an|and|·|—|–|-|&)$/i;
    const measure = (where, root) => {
      for (const svg of root.querySelectorAll(".cover svg")) {
        const w = svg.getBoundingClientRect().width;
        if (!w) continue;
        const k = w / svg.viewBox.baseVal.width;
        for (const t of svg.querySelectorAll("text")) {
          if (!t.textContent.trim()) continue;
          const px = parseFloat(getComputedStyle(t).fontSize) * k;
          seen.push({ where, role: (t.getAttribute("class") || "text").replace("cv-", ""), txt: t.textContent, px });
          if (t.hasAttribute("textLength")) squeezed.push(`${where} "${t.textContent}"`);
        }
        const lab = [...svg.querySelectorAll("text.cv-label")].map(t => t.textContent.trim());
        if (lab.length === 2 && (NOBREAK.test(lab[0].split(" ").pop()) || /^[·—–\-&]$/.test(lab[1].split(" ")[0])))
          strands.push(`${where} "${lab.join(" / ")}"`);
        const stat = svg.querySelector("text.cv-stat"), sub = svg.querySelector("text.cv-sub");
        if (stat && sub && parseFloat(stat.getAttribute("font-size")) < 2.5 * parseFloat(sub.getAttribute("font-size")))
          weakFigures.push(`${where} ${stat.getAttribute("font-size")} over ${sub.getAttribute("font-size")}`);
      }
    };
    document.querySelector('#tabs button[data-tab="home"]').click();
    for (let i = 0; i < 200 && !document.body.dataset.homeWeek; i++) await sleep(100);
    await sleep(50);
    const homeWeek = document.body.dataset.homeWeek || null;
    const hw = document.querySelector("#homeWeek");
    if (hw) measure("home", hw);
    const homeCovers = hw ? hw.querySelectorAll(".teaser .cover").length : 0;
    document.querySelector('#tabs button[data-tab="recaps"]').click();
    for (let i = 0; i < 100 && !document.querySelector('[data-panel="recaps"]:not([hidden]) .teaser'); i++) await sleep(100);
    const news = document.querySelector('[data-panel="recaps"]');
    measure("news", news);
    const teasers = [...news.querySelectorAll(".teaser")];
    let heroes = 0;
    for (const h of teasers.map(t => t.querySelector("h3").textContent)) {
      const back = document.querySelector('[data-panel="article"] .back');
      if (back) back.click();
      [...document.querySelectorAll('[data-panel="recaps"] .teaser')].find(x => x.querySelector("h3").textContent === h).click();
      const art = document.querySelector('[data-panel="article"]');
      heroes += art.querySelectorAll(".cover.big svg").length;
      measure("article: " + h, art);
    }
    const low = seen.filter(r => r.px < 11).sort((a, b) => a.px - b.px);
    const minBy = {};
    for (const r of seen) if (!(r.role in minBy) || r.px < minBy[r.role]) minBy[r.role] = r.px;
    return { n: seen.length, homeWeek, homeCovers, cards: teasers.length, heroes, squeezed, strands, weakFigures,
      low: low.map(r => `${r.where} ${r.role} "${r.txt}" ${r.px.toFixed(1)}px`),
      minBy: Object.entries(minBy).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(", ") };
  });
};
const size390 = await coverTextSizes(390, 844);
const size360 = await coverTextSizes(360, 780);
const size1280 = await coverTextSizes(1280, 900);
// Labels long enough to wrap in any font: the break goes after the comma, and a
// comma-less one still never leaves THE or AND hanging at the end of line one.
const labelBreaks = await coverPage.evaluate(() => {
  const D = window.__DFFL, why = [];
  const lines = caption => {
    const b = document.createElement("div");
    b.innerHTML = D.coverSVG({ slug: "verify-label-" + caption.length, date: "2026-10-06", headline: "Label Test", blocks: [], cover: { caption } }, "wide");
    return [...b.querySelectorAll("text.cv-label")].map(t => t.textContent.trim());
  };
  const comma = lines("What the schedule has taken from us all, and what the board has given back");
  if (comma.length !== 2 || !/,$/.test(comma[0])) why.push(`comma label: ${comma.join(" / ")}`);
  const plain = lines("The biggest mover of the week and the one that nobody on the board saw coming at all");
  if (plain.length !== 2 || /\b(?:the|by|of|a|an|and)$/i.test(plain[0]) || /…/.test(plain.join(" "))) why.push(`plain label: ${plain.join(" / ")}`);
  return { ok: !why.length, why };
});
await coverPage.close();
const both = [cov1280, cov390];
check("every real cover shows its headline or its figures, not just the wordmark",
  both.every(c => c.content.length === 0 && c.n >= 18), both.flatMap(c => c.content).join(" ; ") || `${cov1280.n} covers per viewport`);
check("every real article gets the cover kind its desk expects",
  Object.entries(COVER_KIND_TABLE).every(([s, k]) => cov1280.kindOf[s] === k) && both.every(c => c.kinds.length === 0),
  Object.entries(COVER_KIND_TABLE).filter(([s, k]) => cov1280.kindOf[s] !== k).map(([s, k]) => `${s}: ${cov1280.kindOf[s]}, want ${k}`)
    .concat(both.flatMap(c => c.kinds)).join(" ; "));
check("no cover text runs past the art's edge at 1280px", cov1280.overflow.length === 0, cov1280.overflow.slice(0, 6).join(" ; "));
check("no cover text runs past the art's edge at 390px", cov390.overflow.length === 0, cov390.overflow.slice(0, 6).join(" ; "));
check("every cover carries its label, cut only after a whole word", both.every(c => c.labels.length === 0),
  both.flatMap(c => c.labels).slice(0, 6).join(" ; "));
check("The Steepest Fall lights bertalicious and mutes drewkim",
  cov1280.steep.every(r => r.bertalicious === "#ffffff" && r.drewkim === "#d4cbe0"), JSON.stringify(cov1280.steep));
check("a scoreboard naming both managers lights the winner: Week 1 → Domo112, Nine-Game → saucebossandrew (37-19)",
  both.every(c => ["card", "hero"].every(w => c.lit[`${w}:week-1-game-by-game`] === "Domo112" &&
    c.lit[`${w}:the-nine-game-difference`] === "saucebossandrew")), JSON.stringify(cov1280.lit));
check("a 28-28 record is drawn whole, as a record",
  cov1280.nine.every(t => t.includes("28-28") && t.includes("37-19") && !t.includes("28")), JSON.stringify(cov1280.nine[0]));
check("the desktop hero stands 240-330px tall at 1280", cov1280.heroH.every(h => h >= 240 && h <= 330), cov1280.heroH.map(Math.round).join(" "));
check("the phone hero keeps at least 140px at 390", cov390.heroH.every(h => h >= 140), cov390.heroH.map(Math.round).join(" "));
check("a recap kicker outranks a word in the headline", coverEdge.draftDay === "recap", coverEdge.draftDay);
check("a piece with no headline says DFFL once, not twice", coverEdge.dffl.every(n => n === 1), coverEdge.dffl.join(" "));
check("a face-off with an empty side draws the headline instead", coverEdge.emptyCards.every(Boolean), coverEdge.emptyCards.join(" "));
check("players given as a string are ignored, not thrown on", coverEdge.strPlayers === "ok", coverEdge.strPlayers);
check("no cover text is set heavier than 700", both.every(c => c.weights.length === 0), both.flatMap(c => c.weights).slice(0, 6).join(" ; "));

for (const [w, z] of [[390, size390], [360, size360], [1280, size1280]]) {
  // The Home cards depend on the live week loading; when it didn't, the line says so
  // (and names why) rather than passing as a plain ok.
  const skip = z.homeWeek !== "1" ? `the Home week did not load, homeWeek=${z.homeWeek}` : !z.homeCovers ? "no From the desk cards on Home" : "";
  check(`every cover word renders at least 11px at ${w}px (${skip ? `news and all article covers; Home skipped: ${skip}` : "home, news and all article covers"})`,
    z.low.length === 0 && z.n > 0 && z.cards >= 9 && z.heroes === z.cards && (z.homeWeek !== "1" || z.homeCovers >= 1),
    z.low.length ? z.low.slice(0, 6).join(" ; ")
      : `${z.n} texts on ${z.homeCovers} home + ${z.cards} news + ${z.heroes} article covers; smallest: ${z.minBy}`);
}
const sizesAll = [size360, size390, size1280];
check("no real cover squeezes a word to fit its line (360, 390, 1280)", sizesAll.every(z => z.squeezed.length === 0),
  sizesAll.flatMap(z => z.squeezed).slice(0, 6).join(" ; "));
check("a two-line cover label never strands a word after THE, BY, OF, A, AN, AND or a separator",
  sizesAll.every(z => z.strands.length === 0) && labelBreaks.ok, sizesAll.flatMap(z => z.strands).concat(labelBreaks.why).slice(0, 6).join(" ; "));
check(`on every stat cover the figure stands at least 2.5x its headline (360, 390, 1280)`, sizesAll.every(z => z.weakFigures.length === 0),
  sizesAll.flatMap(z => z.weakFigures).slice(0, 6).join(" ; "));

const noArt = await page.evaluate(async () => {
  const D = window.__DFFL;
  const realFetch = window.fetch;
  window.fetch = u => String(u).includes("recaps.json")
    ? Promise.resolve({ ok: true, json: () => Promise.resolve({ weeks: [] }) }) : realFetch(u);
  const panel = await D.panelRecaps();
  window.fetch = realFetch;
  return { artl: panel.querySelectorAll(".artl").length, empty: panel.querySelectorAll(".empty").length };
});
check("no articles and no weeks still shows the waiting state", noArt.artl === 0 && noArt.empty === 1);


group("Draft: keepers, views and the player card");
await page.click('#tabs button[data-tab="draft"]');
await page.waitForFunction(() => document.querySelectorAll('[data-panel="draft"] .bc').length > 0, null, { timeout: 30000 });
const draftT = await page.evaluate(async () => {
  const D = window.__DFFL, DB = D.DB;
  const s26 = DB.seasons[0], oldest = DB.seasons[DB.seasons.length - 1];
  for (const s of DB.seasons) if ((s.picks || []).length) await D.keepersFor(s);
  const k26 = D.keepersOf(s26), kOld = D.keepersOf(oldest);
  // Whoever owned each player the moment the draft began — last season's final
  // rosters plus any trade that closed first. A keeper has to come from there.
  const owner = await D.preDraftOwners(s26);
  window.__STATED_2026 = ((await D.loadStatedKeepers()).seasons || {})["2026"] || null;
  const adp = await D.loadADP();
  const marked = (s26.picks || []).filter(p => k26.has(String(p.player_id)));
  const strays = [], overpaid = [];
  // (overpaid is only meaningful for a guessed list; a stated keeper can cost
  // anything the league's rules allow)
  for (const p of marked) {
    if (owner.get(String(p.player_id)) !== p.picked_by)
      strays.push(`${(p.metadata || {}).last_name}`);
    const md = p.metadata || {};
    const a = adp.byName.get(D.adpKey(`${md.first_name || ""} ${md.last_name || ""}`, md.position));
    if (!p.is_keeper && a != null && p.pick_no <= a)
      overpaid.push(`${md.last_name} taken at ${p.pick_no}, market ${a}`);
  }
  const perMgr = {};
  for (const p of marked) perMgr[p.picked_by] = (perMgr[p.picked_by] || 0) + 1;
  const flagged = (s26.picks || []).filter(p => p.is_keeper);
  return {
    k26: k26.size, kOldest: kOld.size, cap: s26.maxKeepers, source: s26._keeperSource,
    flaggedOnly: flagged.length,
    flaggedAreCaught: flagged.every(p => k26.has(String(p.player_id))),
    strays: strays.slice(0, 6),
    // a stated keeper must at least be a pick that manager actually made
    allStatedAreHisPicks: marked.length === k26.size, notHis: [],
    everyMarkedDiscounted: overpaid.length === 0, overpaid: overpaid.slice(0, 3),
    managers: Object.keys(perMgr).length,
    maxPerManager: Math.max(...Object.values(perMgr)),
    statedCount: (() => {
      const listed = (D.DB.seasons[0]._keeperSource === "stated") && window.__STATED_2026;
      return listed ? Object.values(listed).flat().length : k26.size;
    })(),
    derivedMax: (() => {
      // rebuild the guess on an older season, where no stated list exists
      const s23 = DB.seasons.find(x => x.season === "2023");
      if (!s23) return 0;
      const per = {};
      for (const p of s23.picks || []) if (D.keepersOf(s23).has(String(p.player_id)))
        per[p.picked_by] = (per[p.picked_by] || 0) + 1;
      return Math.max(0, ...Object.values(per));
    })(),
    posClasses: ["QB", "RB", "WR", "TE", "K", "DEF", "P"].map(x => D.posClass(x)),
  };
});
check("keepers are worked out, not left to Sleeper's sparse flag", draftT.k26 > 25 && draftT.flaggedOnly < 5, `${draftT.k26} found vs ${draftT.flaggedOnly} flagged`);
check("every pick Sleeper flags is caught too", draftT.flaggedAreCaught);
// The cap binds the derivation, not the truth: one manager really did keep four.
check("a guessed list never exceeds the league's keeper cap", draftT.derivedMax <= draftT.cap, `${draftT.derivedMax} of ${draftT.cap}`);
check("the first season on record has no keepers to work out", draftT.kOldest === 0, `${draftT.kOldest}`);
check("every stated keeper is a real pick by that manager", draftT.allStatedAreHisPicks, draftT.notHis.join(" | "));
check("most keepers do trace to last season's roster", draftT.strays.length <= 4, `${draftT.strays.length} do not: ${draftT.strays.join(", ")}`);
check("the keeper list is read off keepers.json, not guessed", draftT.source === "stated", draftT.source);
check("every keeper on the list reaches the board", draftT.k26 === draftT.statedCount, `${draftT.k26} marked of ${draftT.statedCount} stated`);
check("positions map to their own colour class", draftT.posClasses.join(",") === "qb,rb,wr,te,kk,def,oth", draftT.posClasses.join(","));

const draftDom = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="draft"]');
  const sels = panel.querySelectorAll("select");
  return {
    views: [...sels[1].options].map(o => o.value),
    defaultView: sels[1].value,
    cells: panel.querySelectorAll(".bc").length,
    headers: panel.querySelectorAll(".bh").length,
    kmarks: panel.querySelectorAll(".bc .k").length,
    legend: /keeper/i.test(panel.innerText) && /keepers\.json/.test(panel.innerText),
    tradedCells: panel.querySelectorAll(".bc.traded").length,
    viaLabels: panel.querySelectorAll(".bc .via").length,
    tradedNoted: /picks changed hands in this draft/.test(panel.innerText),
    rounds: panel.querySelectorAll(".brd").length,
    nan: /NaN|undefined/.test(panel.innerText),
  };
});
check("the draft opens on the board, not a long list", draftDom.defaultView === "board" && draftDom.views.join(",") === "board,mgr,list");
check("the board is 12 columns by 15 rounds", draftDom.cells === 180 && draftDom.headers === 13 && draftDom.rounds === 15,
  `${draftDom.cells} cells, ${draftDom.headers} headers, ${draftDom.rounds} rounds`);
check("keepers are marked K on the board", draftDom.kmarks > 30, `${draftDom.kmarks}`);
check("the legend says where the K came from", draftDom.legend);
check("the board says how many picks were traded", draftDom.tradedNoted, `${draftDom.tradedCells} cells marked`);
check("a traded pick names who actually used it", draftDom.tradedCells > 20 && draftDom.viaLabels === draftDom.tradedCells,
  `${draftDom.tradedCells} traded, ${draftDom.viaLabels} labelled`);
check("no NaN on the draft board", draftDom.nan === false);

// draw() is async now — it settles the keepers before it renders anything.
await page.evaluate(() => {
  const sels = document.querySelectorAll('[data-panel="draft"] select');
  sels[0].value = "2025"; sels[0].dispatchEvent(new Event("change"));
});
await page.waitForFunction(() => document.querySelectorAll('[data-panel="draft"] .bc').length > 0, null, { timeout: 30000 });
await page.evaluate(() => {
  const sels = document.querySelectorAll('[data-panel="draft"] select');
  sels[1].value = "mgr"; sels[1].dispatchEvent(new Event("change"));
});
await page.waitForFunction(() => document.querySelectorAll('[data-panel="draft"] .dcard').length > 0, null, { timeout: 30000 });
const byMgr = await page.evaluate(async () => {
  const panel = document.querySelector('[data-panel="draft"]');
  const cards = panel.querySelectorAll(".dcard");
  const picks = panel.querySelectorAll(".dp");
  return { cards: cards.length, picks: picks.length, ks: panel.querySelectorAll(".dp .k").length,
    perCard: [...cards].map(c => c.querySelectorAll(".dp").length) };
});
check("by-manager gives every manager a card", byMgr.cards === 12, `${byMgr.cards}`);
check("every pick lands on exactly one card", byMgr.picks === 180, `${byMgr.picks}`);
check("keepers are marked there too", byMgr.ks > 20, `${byMgr.ks}`);

await page.evaluate(() => {
  const sels = document.querySelectorAll('[data-panel="draft"] select');
  sels[1].value = "board"; sels[1].dispatchEvent(new Event("change"));
});
await page.waitForFunction(() => document.querySelectorAll('[data-panel="draft"] .bc').length > 0, null, { timeout: 30000 });
const card = await page.evaluate(async () => {
  const panel = document.querySelector('[data-panel="draft"]');
  panel.querySelector(".bc").click();
  await new Promise(r => setTimeout(r, 60));
  const m = document.querySelector(".modal");
  const txt = m ? m.innerText : "";
  const bars = m ? m.querySelectorAll(".wkchart .wk").length : 0;
  const post = m ? m.querySelectorAll(".wkchart .wk.post").length : 0;
  const stats = m ? [...m.querySelectorAll(".ms b")].map(n => n.textContent) : [];
  // escape closes it
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  const gone = !document.querySelector(".modal");
  return { opened: !!m, bars, post, stats, gone, nan: /NaN|undefined/.test(txt),
    saysScoring: /under DFFL scoring/.test(txt), noProjections: !/project/i.test(txt) };
});
check("clicking a pick opens that player's card", card.opened);
check("the card charts every week of the season", card.bars === 17, `${card.bars}`);
check("playoff weeks are drawn but marked apart", card.post === 3, `${card.post}`);
check("the card carries real numbers", card.stats.length === 4 && card.stats.every(v => v && v !== "—"), card.stats.join("/"));
check("the card promises scoring, not projections", card.saysScoring && card.noProjections);
check("no NaN on the player card", card.nan === false);
check("escape closes the card", card.gone);

await page.evaluate(() => {
  const sels = document.querySelectorAll('[data-panel="draft"] select');
  sels[0].value = "2026"; sels[0].dispatchEvent(new Event("change"));
});
await page.waitForFunction(() => {
  const c = document.querySelector('[data-panel="draft"] .bc .nm');
  return c && /Hampton|Jeanty|Henry|Lamb/.test(c.textContent);
}, null, { timeout: 30000 });
const unplayed = await page.evaluate(async () => {
  const panel = document.querySelector('[data-panel="draft"]');
  panel.querySelector(".bc").click();
  await new Promise(r => setTimeout(r, 60));
  const m = document.querySelector(".modal");
  const out = { empty: m ? m.querySelectorAll(".mempty").length : -1, charts: m ? m.querySelectorAll(".wkchart").length : -1,
    txt: m ? m.innerText : "" };
  if (m) m.remove();
  return out;
});
check("a player from an unplayed season says so instead of charting zeros", unplayed.empty === 1 && unplayed.charts === 0, JSON.stringify(unplayed).slice(0, 120));

const stated = await page.evaluate(async () => {
  const D = window.__DFFL, s = D.DB.seasons[0];
  const pick = s.picks.find(p => (p.metadata || {}).last_name === "Hampton");
  const mgr = nameOf(pick.picked_by);
  const stub = { seasons: { "2026": { [mgr]: ["Omarion Hampton"], "nobody at all": ["Ja'Marr Chase"] } } };
  const realFetch = window.fetch;
  window.fetch = u => String(u).includes("keepers.json")
    ? Promise.resolve({ ok: true, json: () => Promise.resolve(stub) }) : realFetch(u);
  await D.loadStatedKeepers(true);
  s._keepers = null;
  const set = await D.keepersFor(s);
  window.fetch = realFetch;
  const out = {
    size: set.size, source: s._keeperSource,
    hasHampton: set.has(String(pick.player_id)),
    // a name written against the wrong manager marks nobody
    chaseMarked: [...s.picks].some(p => (p.metadata || {}).last_name === "Chase" && set.has(String(p.player_id))),
  };
  s._keepers = null; D.loadStatedKeepers(true);
  await D.keepersFor(s);
  return out;
});
check("a stated keeper list beats the derivation outright", stated.source === "stated" && stated.size === 1, JSON.stringify(stated));
check("the stated name is the one that gets marked", stated.hasHampton);
check("a name under the wrong manager marks nobody", stated.chaseMarked === false);

group("Lazy tabs cost nothing at boot");
// On a page nobody has clicked, neither heavy tab may have reached for
// anything. Checked on its own tab because every other tab has already been
// opened by the routing pass above.
const lazyPage = await ctx.newPage();
const heavy = [];
lazyPage.on("request", r => {
  const u = r.url();
  if (/\/transactions\/|\/players\/nfl|\/draft\/\d+$/.test(u)) heavy.push(u.replace(/^.*\/v1/, ""));
});
await lazyPage.goto(BASE, { waitUntil: "domcontentloaded" });
await lazyPage.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 90000 });
await lazyPage.waitForTimeout(600);
const lazyState = await lazyPage.evaluate(() => ({
  trades: document.body.dataset.tradesReady || null,
  picture: document.body.dataset.pictureReady || null,
  tradeHost: !!document.querySelector("#tradesHost"),
  pictureHost: !!document.querySelector("#pictureHost"),
}));
check("booting fetches no transactions, no player file and no draft detail", heavy.length === 0, heavy.slice(0, 3).join(", "));
check("neither lazy tab has run at boot", lazyState.trades === null && lazyState.picture === null, JSON.stringify(lazyState));
check("both lazy panels are on the page regardless", lazyState.tradeHost && lazyState.pictureHost);
// Old links to the Race tab land on the Playoff Picture.
// Same URL plus a fragment is only a hash change, so reload to really boot on it.
await lazyPage.goto(BASE + "#race", { waitUntil: "domcontentloaded" });
await lazyPage.reload({ waitUntil: "domcontentloaded" });
await lazyPage.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 90000 });
const raceLink = await lazyPage.evaluate(() => ({
  hash: location.hash,
  selected: (document.querySelector('#tabs button[aria-selected="true"]') || {}).dataset?.tab || null,
  visible: !!document.querySelector('[data-panel="picture"]') && !document.querySelector('[data-panel="picture"]').hidden,
}));
check("#race opens the Playoff Picture", raceLink.hash === "#picture" && raceLink.selected === "picture" && raceLink.visible, JSON.stringify(raceLink));
await lazyPage.close();

group("Playoff Picture: the tab");
const ppTab = await page.evaluate(() => ({
  label: (document.querySelector('#tabs button[data-tab="picture"]') || {}).textContent || null,
  race: !!document.querySelector('#tabs button[data-tab="race"]') || !!document.querySelector('[data-panel="race"]'),
  raceExports: ["ensureRace", "raceOdds", "leverageBoard", "renderRace", "raceEmpty", "RACE_SIMS", "LEVERAGE_SIMS"]
    .filter(k => k in window.__DFFL),
}));
check('a "Playoff Picture" tab exists', ppTab.label === "Playoff Picture", ppTab.label);
check("the Race tab is gone", ppTab.race === false);
check("the Race engine is no longer exported", ppTab.raceExports.length === 0, ppTab.raceExports.join(","));
await page.click('#tabs button[data-tab="picture"]');
await page.waitForFunction(() => document.body.dataset.pictureReady, null, { timeout: 180000 });
const ppLive = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="picture"]');
  const P = window.__PICTURE, L = window.__LSIM, live = window.__LIVE;
  return {
    state: document.body.dataset.pictureReady,
    honesty: panel.querySelector(".mode .what") ? panel.querySelector(".mode .what").innerText : "",
    emptyText: (panel.querySelector(".empty") || {}).innerText || "",
    tables: panel.querySelectorAll("table").length,
    hasLive: !!live,
    // On the live season the tab's Playoffs column is the Odds tab's number, exactly.
    matchesOdds: P && L ? P.playoff.every((p, i) => p === L.playoff[i] / L.sims) : null,
    via: P ? P.via : null,
  };
});
check("the tab settles into a real state", ppLive.state === "1" || ppLive.state === "empty", ppLive.state);
check("the page says these are model outputs, not predictions", /model outputs, not predictions/.test(ppLive.honesty), ppLive.honesty.slice(0, 60));
if (ppLive.state === "empty") {
  check("the empty state explains itself and invents no numbers",
    ppLive.emptyText.length > 60 && ppLive.tables === 0 && !/%/.test(ppLive.emptyText), ppLive.emptyText.slice(0, 60));
} else {
  check("live: the Playoffs column equals the Odds tab's playoff odds exactly", ppLive.matchesOdds === true);
  check("live: the picture ran in a worker", ppLive.via === "worker", ppLive.via);
}

group("Playoff Picture: if the season ended today (v4 board)");
// Reads the live board as drawn at 1280px and checks every number on it against
// the sim's own counts and the Odds tab's run, and the order against today's standings.
const ppV4 = await page.evaluate(() => {
  const P = window.__PICTURE, L = window.__LSIM, live = window.__LIVE;
  const host = document.querySelector("#pictureHost"), board = host && host.querySelector(".ppv");
  if (document.body.dataset.pictureReady !== "1" || !P || !L || !live || !board) return { skip: true };
  const pctf = v => v <= 0 ? "0%" : v >= 1 ? "100%" : v < 0.005 ? "<1%" : v > 0.995 ? ">99%" : `${(v * 100).toFixed(0)}%`;
  const N = live.teams.length, PT = P.rules.playoffTeams, B = P.rules.byes;
  // Today's seeding, worked out here from scratch: rank on wins then points for,
  // division leaders first in rank order, then everyone else in rank order.
  const rank = live.teams.map((_, i) => i).sort((a, b) => live.W0[b] - live.W0[a] || live.PF0[b] - live.PF0[a]);
  const champs = [...new Set(live.teams.map(t => t.div))].map(d => rank.find(i => live.teams[i].div === d));
  champs.sort((a, b) => rank.indexOf(a) - rank.indexOf(b));
  const expect = [...champs, ...rank.filter(i => !champs.includes(i))].map(i => String(live.teams[i].rid));
  const idx = new Map(P.rids.map((rid, i) => [String(rid), i]));
  const listRows = [...board.querySelectorAll(".pp-seeds .pp-li, .pp-elim .pp-li")];
  const bySeed = listRows.slice().sort((a, b) => a.dataset.seed - b.dataset.seed);
  const pbText = (row, k) => { const b = row.querySelector(`.pp-pb[data-k="${k}"] b`); return b ? b.textContent : null; };
  const allBars = [...board.querySelectorAll(".pp-li, .pp-hero")];
  const badBye = allBars.filter(r => {
    const i = idx.get(r.dataset.rid), s = P.seed[i];
    const share = s.slice(0, B).reduce((a, c) => a + c, 0) / P.sims;
    return P.bye[i] !== share || pbText(r, "by") !== pctf(share) || (B === 2 && share !== (s[0] + s[1]) / P.sims);
  }).map(r => r.dataset.rid);
  const badPo = allBars.filter(r => pbText(r, "po") !== pctf(L.playoff[idx.get(r.dataset.rid)] / L.sims)).map(r => r.dataset.rid);
  const prevSeed = sel => { const c = board.querySelector(sel), p = c && c.previousElementSibling; return p ? Number(p.dataset.seed) : null; };
  const dash = sel => { const c = board.querySelector(sel); return c ? getComputedStyle(c, "::before").borderTopStyle : null; };
  const heroes = [...board.querySelectorAll(".pp-hero")];
  const legend = board.querySelector(".pp-legend");
  const lay = getComputedStyle(board.querySelector(".pp-lay")).gridTemplateColumns.split(" ").filter(Boolean);
  const bcol = board.querySelector(".pp-bcol").getBoundingClientRect(), lcol = board.querySelector(".pp-lcol").getBoundingClientRect();
  const txt = host.innerText;
  return {
    N, PT, B, rows: listRows.length,
    heroSeeds: heroes.map(h => Number(h.dataset.seed)),
    heroRids: heroes.map(h => h.dataset.rid), expectTop: expect.slice(0, B),
    order: bySeed.map(r => r.dataset.rid), expect, sameAsPicture: JSON.stringify(P.order.map(String)) === JSON.stringify(expect),
    sectionsAscend: [".pp-seeds", ".pp-elim"].every(s => {
      const seeds = [...board.querySelectorAll(`${s} .pp-li`)].map(r => Number(r.dataset.seed));
      return seeds.every((v, k) => !k || v > seeds[k - 1]);
    }),
    seedsShown: bySeed.every((r, k) => Number(r.dataset.seed) === k + 1 && r.querySelector(".pp-sd").textContent === String(k + 1)),
    badBye, badPo, checked: allBars.length,
    byeAfter: prevSeed('.pp-cut[data-line="bye"]'), poAfter: prevSeed('.pp-cut[data-line="playoff"]'),
    byeDash: dash('.pp-cut[data-line="bye"]'), poDash: dash('.pp-cut[data-line="playoff"]'),
    divPct: /\bDiv\b|Div %|division[- ]title/i.test(txt) || board.querySelectorAll(".dv3, [data-k='dv']").length,
    legend: !!legend && ["x", "y", "z"].every(k => [...legend.querySelectorAll(".pp-mk")].some(m => m.textContent === k))
      && /clinched playoff spot/.test(legend.textContent) && /clinched division/.test(legend.textContent) && /clinched first-round bye/.test(legend.textContent),
    // every x/y/z on a team is the one its exact clinch flags call for
    marksOk: [...board.querySelectorAll(".pp-li, .pp-hero")].every(r => {
      const c = P.clinch.find(x => String(x.rid) === r.dataset.rid), m = r.querySelector(".pp-nm .pp-mk");
      const want = c.clinchedBye ? "z" : c.clinchedDiv ? "y" : c.clinchedPlayoff ? "x" : "";
      return (m ? m.textContent : "") === want;
    }),
    tag: /If the season ended today/i.test(board.querySelector(".pp-tag")?.textContent || ""),
    hints: [...board.querySelectorAll(".pp-br .pp-hn")].length,
    seedsToday: /seeds = today, odds = full season/i.test(txt),
    reseed: /the sims still reseed after round one, which affects only playoff-round and title odds, not Bye % or Playoff %/i.test(txt.replace(/\s+/g, " ")),
    twoCol: lay.length === 2 && bcol.right <= lcol.left + 1, lay: lay.join(" "),
    // "In the hunt" heads the seeds below the line, unless every one of them is eliminated
    hunt: /In the hunt/.test(board.textContent) === (board.querySelectorAll(".pp-seeds .pp-li").length > PT), elimHead: [...board.querySelectorAll(".pp-h")].some(h => h.textContent === "Eliminated"),
    avatars: board.querySelectorAll(".pp-li .av, .pp-hero .av").length,
  };
});
if (ppV4.skip) {
  check("v4 board checks (skipped: no live picture to read)", true);
} else {
  check("v4: the hero cards are seeds 1-" + ppV4.B + ", in order, and the right teams",
    JSON.stringify(ppV4.heroSeeds) === JSON.stringify(Array.from({ length: ppV4.B }, (_, k) => k + 1))
    && JSON.stringify(ppV4.heroRids) === JSON.stringify(ppV4.expectTop), `${ppV4.heroSeeds} / ${ppV4.heroRids}`);
  check("v4: one list row per team, seeds 1..N shown in order", ppV4.rows === ppV4.N && ppV4.seedsShown, `${ppV4.rows} rows`);
  check("v4: the list order is today's seeding (division leaders, then records, ties on points for)",
    JSON.stringify(ppV4.order) === JSON.stringify(ppV4.expect) && ppV4.sameAsPicture && ppV4.sectionsAscend, `${ppV4.order} vs ${ppV4.expect}`);
  check("v4: every Bye % is the sim's seed-1 + seed-2 share, exactly", ppV4.badBye.length === 0 && ppV4.checked >= ppV4.N, ppV4.badBye.join(","));
  check("v4: every Playoff % is the Odds tab's number", ppV4.badPo.length === 0, ppV4.badPo.join(","));
  check("v4: the dashed bye line sits right after seed " + ppV4.B, ppV4.byeAfter === ppV4.B && ppV4.byeDash === "dashed", `${ppV4.byeAfter} ${ppV4.byeDash}`);
  check("v4: the dashed playoff line sits right after seed " + ppV4.PT, ppV4.poAfter === ppV4.PT && ppV4.poDash === "dashed", `${ppV4.poAfter} ${ppV4.poDash}`);
{
  // A team level on wins with the last seed in is out on points for, not "0 GB".
  // Redraw the board with seed 7's record set equal to seed 6's, and seed 8 a win back.
  const pf = await page.evaluate(() => {
    const D = window.__DFFL, P0 = window.__PICTURE && window.__PICTURE.full;
    if (!P0 || !D.pictureBoard) return { skip: true };
    const PT = P0.rules.playoffTeams, rows = P0.rows.map(r => ({ ...r })), PP = { ...P0, rows };
    if (rows.length < PT + 2) return { skip: true };
    const at = k => rows[PP.order[k - 1]], last = at(PT), tie = at(PT + 1), back = at(PT + 2);
    tie.w = last.w; tie.l = last.l; tie.t = last.t;
    back.w = last.w - 1; back.l = last.l + 1; back.t = last.t;
    const b = D.pictureBoard(PP);
    const txt = rid => (b.querySelector(`.pp-seeds .pp-li[data-rid="${rid}"]`) || {}).textContent || "";
    return { tie: txt(tie.rid), back: txt(back.rid) };
  });
  check("v4: a team tied on wins with the last seed in reads 'out on PF'", !pf.skip && /out on PF/.test(pf.tie) && !/0 GB/.test(pf.tie), pf.skip ? "skipped" : pf.tie.replace(/\s+/g, " ").slice(0, 90));
  check("v4: a team one win back reads '1 GB'", !pf.skip && /\b1 GB/.test(pf.back), pf.skip ? "skipped" : pf.back.replace(/\s+/g, " ").slice(0, 90));
}
  check("v4: no Div % anywhere on the tab", !ppV4.divPct);
  check("v4: the x / y / z legend is there", ppV4.legend);
  check("v4: every x / y / z mark comes from the exact clinch flags", ppV4.marksOk);
  check('v4: the bracket is tagged "If the season ended today" with Bye % · PO % slot hints', ppV4.tag && ppV4.hints >= ppV4.PT);
  check('v4: says "seeds = today, odds = full season" and the reseeding caveat', ppV4.seedsToday && ppV4.reseed);
  check("v4: In the hunt and Eliminated sections are there", ppV4.hunt && ppV4.elimHead);
  check("v4: every list row and hero card has a Sleeper avatar", ppV4.avatars === ppV4.N + ppV4.B, `${ppV4.avatars}`);
  check("v4: two columns at 1280px, bracket left of the list", ppV4.twoCol, ppV4.lay);
}

// The job handed to the worker must carry the injury plan's per-week cuts, or the
// Picture's own runs (and every win/lose-this-week run) would be healthy.
const ppInj = await page.evaluate(async () => {
  const D = window.__DFFL, L = await D.liveOnce();
  if (!L.live || !L.model) return { skip: true };
  const cut = L.live.teams.map((_, i) => (i === 0 ? 0.6 : 1)), pws = L.live.pws;
  const multByWeek = new Map([...L.live.weeks.map(w => w.week), pws, pws + 1, pws + 2].map(w => [w, cut]));
  const live2 = { ...L.live, multByWeek };
  const job = structuredClone(D.pictureJob(L.model, live2, 400, 3000));   // what the worker receives
  const run = D.pictureRun(job);
  const direct = D.simulateSeason(L.model, 3000, live2);
  const g = job.games[0];
  const dForced = g ? D.simulateSeason(L.model, 400, live2, { force: { a: g[0], b: g[1], winner: g[0] } }) : null;
  const healthy = D.simulateSeason(L.model, 3000, { ...L.live, multByWeek: null });
  return {
    carries: job.live.multByWeek instanceof Map && job.live.multByWeek.size === multByWeek.size && job.live.pws === pws,
    mainExact: run.main.playoff.every((p, i) => p === direct.playoff[i]),
    forcedExact: !g || run.forced[0].ifA.playoff.every((p, i) => p === dForced.playoff[i]),
    cutBites: direct.wins[0] < healthy.wins[0],
  };
});
if (ppInj.skip) {
  check("the worker's job carries the injury cuts (skipped: no live week)", true);
} else {
  check("the worker's job carries the injury cuts per week and the playoff start week", ppInj.carries);
  check("the Picture's own run includes the injury cuts, exactly as the Odds engine", ppInj.mainExact && ppInj.cutBites, JSON.stringify(ppInj));
  check("the win/lose-this-week runs include the injury cuts too", ppInj.forcedExact, JSON.stringify(ppInj));
}

group("Playoff Picture: follows the live board");
// Move a live score and reprice the way the 60s poll does: the tab must redraw
// off the new run, in the one worker it already has.
const ppRefresh = await page.evaluate(async () => {
  const D = window.__DFFL, games = D.DB.seasons[0].live || [];
  if (!games.length || document.body.dataset.pictureReady !== "1") return { skip: true };
  const b = window.__BOARD;
  const open = g => b && b.ok && b.games.some(x => !x.settled
    && ((x.a.rid === g.a.rid && x.b.rid === g.b.rid) || (x.a.rid === g.b.rid && x.b.rid === g.a.rid)));
  const g = games.find(open) || games[0];
  const RealWorker = window.Worker;
  let made = 0;
  window.Worker = class extends RealWorker { constructor(...a) { super(...a); made++; } };
  const bump = async d => {
    const prev = window.__PICTURE;
    g.a.pts += d;
    LIVE_P = null;
    await D.liveOnce();
    D.emitLive();
    for (let t = 0; t < 150 && window.__PICTURE === prev; t++) await new Promise(r => setTimeout(r, 100));
    const P = window.__PICTURE, L = window.__LSIM;
    return {
      redrawn: P !== prev, via: P.via,
      exact: P.playoff.every((p, i) => p === L.playoff[i] / L.sims),
      changed: P.playoff.some((p, i) => p !== prev.playoff[i]),
    };
  };
  try {
    const one = await bump(60), two = await bump(60);
    await bump(-120);   // put the real score back for the checks that follow
    return { one, two, made };
  } finally { window.Worker = RealWorker; }
});
if (ppRefresh.skip) {
  check("live refresh redraws the picture (skipped: no live week)", true);
} else {
  for (const [k, r] of [["first", ppRefresh.one], ["second", ppRefresh.two]]) {
    check(`live refresh (${k}): the picture redraws`, r.redrawn, JSON.stringify(r));
    check(`live refresh (${k}): Playoffs still equals the Odds tab's run exactly`, r.exact);
    check(`live refresh (${k}): the numbers moved with the score`, r.changed);
  }
  check("two live refreshes create at most one worker", ppRefresh.made <= 1, `${ppRefresh.made} created`);
  check("refreshes still run in the worker", ppRefresh.one.via === "worker" && ppRefresh.two.via === "worker", `${ppRefresh.one.via}/${ppRefresh.two.via}`);
}

// A poll that changes nothing must not rebuild the table and throw away where
// it was scrolled; a poll that does change it keeps the scroll position.
// Narrow the page so the seed table actually scrolls sideways.
await page.setViewportSize({ width: 600, height: 900 });
const ppScroll = await page.evaluate(async () => {
  const D = window.__DFFL, games = D.DB.seasons[0].live || [];
  if (!games.length || document.body.dataset.pictureReady !== "1") return { skip: true };
  const g = games[0], seedScroll = () => document.querySelector("#pictureHost .pp .scroll");
  const refresh = async d => {
    const prev = window.__PICTURE;
    g.a.pts += d;
    LIVE_P = null;
    await D.liveOnce();
    D.emitLive();
    for (let t = 0; t < 150 && window.__PICTURE === prev; t++) await new Promise(r => setTimeout(r, 100));
    return window.__PICTURE !== prev;
  };
  const s0 = seedScroll(), t0 = s0.querySelector("table");
  s0.scrollLeft = s0.scrollWidth;
  const left = s0.scrollLeft;
  const quietPass = await refresh(0);
  const quiet = { pass: quietPass, sameTable: seedScroll().querySelector("table") === t0, left: seedScroll().scrollLeft };
  const movedPass = await refresh(60);
  const moved = { pass: movedPass, redrawn: seedScroll().querySelector("table") !== t0, left: seedScroll().scrollLeft };
  await refresh(-60);   // the real score back
  return { left, quiet, moved };
});
await page.setViewportSize({ width: 1280, height: 900 });
if (ppScroll.skip) {
  check("live refresh keeps the table's sideways scroll (skipped: no live week)", true);
} else {
  check("the seed table scrolls sideways on a narrow page", ppScroll.left > 0, String(ppScroll.left));
  check("an unchanged refresh leaves the seed table alone (same node, same scroll)",
    ppScroll.quiet.pass && ppScroll.quiet.sameTable && ppScroll.quiet.left === ppScroll.left, JSON.stringify(ppScroll));
  check("a changed refresh redraws the seed table and keeps its scroll",
    ppScroll.moved.pass && ppScroll.moved.redrawn && ppScroll.moved.left === ppScroll.left, JSON.stringify(ppScroll));
}

// The skip-if-unchanged signature must see any change a cell can show: whole
// percents flip on a hair, "·" becomes "<1", and two near-tied rows can swap.
const ppSig = await page.evaluate(async () => {
  const D = window.__DFFL, M = window.__ODDS, se = D.DB.seasons.find(x => x.season === "2025"), R = D.raceAsOf(se, 13);
  const live = D.liveState(M, se, R, null, null, 13);
  const PP = await D.computePicture(M, live, R, se, { whatIfSims: 300, main: true });
  const clone = () => ({ ...PP, rows: PP.rows.map(r => ({ ...r, seed: r.seed.slice(), whatIf: r.whatIf && { ...r.whatIf } })), swings: PP.swings.map(g => ({ ...g })) });
  const sig = x => D.pictureSig(x);
  const a = clone(), b = clone(); a.rows[0].playoff = 0.1248; b.rows[0].playoff = 0.1252;
  const c = clone(), d = clone(); c.rows[1].seed[0] = 0; d.rows[1].seed[0] = 0.004;
  const e = clone(); [e.rows[2], e.rows[3]] = [e.rows[3], e.rows[2]];
  return { same: sig(clone()) === sig(PP), flip: sig(a) !== sig(b), dot: sig(c) !== sig(d), swap: sig(e) !== sig(PP) };
});
check("an identical refresh has the same redraw signature (0 redraws)", ppSig.same);
check("a change that only flips a shown cell (12.48% to 12.52%) redraws", ppSig.flip);
check('a change from "·" to "<1" redraws', ppSig.dot);
check("two rows swapping places redraws", ppSig.swap);

// While the tab is hidden a reprice is not worked out; coming back catches up once.
const ppLiveGames = await page.evaluate(() => (window.__DFFL.DB.seasons[0].live || []).length > 0 && document.body.dataset.pictureReady === "1");
if (!ppLiveGames) {
  check("a hidden picture waits for the next visit (skipped: no live week)", true);
} else {
  await page.click('#tabs button[data-tab="odds"]');
  const hid = await page.evaluate(async () => {
    const D = window.__DFFL, g = D.DB.seasons[0].live[0], prev = window.__PICTURE;
    const t0 = document.querySelector("#pictureHost .pp table");
    g.a.pts += 60;
    LIVE_P = null;
    await D.liveOnce();
    D.emitLive();
    await new Promise(r => setTimeout(r, 2000));
    window.__ppHidPrev = prev; window.__ppHidTable = t0;
    return { untouched: window.__PICTURE === prev && document.querySelector("#pictureHost .pp table") === t0 };
  });
  await page.click('#tabs button[data-tab="picture"]');
  const back = await page.evaluate(async () => {
    const prev = window.__ppHidPrev;
    for (let t = 0; t < 150 && window.__PICTURE === prev; t++) await new Promise(r => setTimeout(r, 100));
    const P = window.__PICTURE, L = window.__LSIM;
    const out = { redrawn: P !== prev && document.querySelector("#pictureHost .pp table") !== window.__ppHidTable,
      exact: P.playoff.every((p, i) => p === L.playoff[i] / L.sims) };
    // the real score back
    const D = window.__DFFL, before = window.__PICTURE;
    D.DB.seasons[0].live[0].a.pts -= 60;
    LIVE_P = null;
    await D.liveOnce();
    D.emitLive();
    for (let t = 0; t < 150 && window.__PICTURE === before; t++) await new Promise(r => setTimeout(r, 100));
    delete window.__ppHidPrev; delete window.__ppHidTable;
    return out;
  });
  check("a reprice while the picture is hidden does not redraw it", hid.untouched);
  check("returning to the picture redraws it once", back.redrawn);
  check("after catching up, Playoffs still equals the Odds tab's run exactly", back.exact);
}

group("Playoff Picture: the empty state");
const ppEmpty = await page.evaluate(() => {
  const box = window.__DFFL.pictureEmpty("not-started", "2026");
  return { text: box.innerText || box.textContent, tables: box.querySelectorAll("table").length };
});
check("the not-started state says so and invents no numbers",
  /hasn't started/.test(ppEmpty.text) && ppEmpty.tables === 0 && !/%/.test(ppEmpty.text), ppEmpty.text.slice(0, 60));

group("Race data: a season that was actually played");
const race = await page.evaluate(async () => {
  const D = window.__DFFL;
  const season = D.DB.seasons.find(s => s.season === "2025");
  const R = D.raceAsOf(season, 10);
  // Nothing may be modelled from before the cut: the fixed record has to be
  // exactly what happened through week 10.
  const tally = gs => {
    const w = new Map();
    for (const g of gs) {
      if (g.a.pts > g.b.pts) w.set(g.a.rid, (w.get(g.a.rid) || 0) + 1);
      else if (g.b.pts > g.a.pts) w.set(g.b.rid, (w.get(g.b.rid) || 0) + 1);
      else for (const s of [g.a, g.b]) w.set(s.rid, (w.get(s.rid) || 0) + 0.5);
    }
    return w;
  };
  const realW = tally(season.games.filter(g => !g.playoff && g.week <= 10)), fixedW = tally(R.decided);
  const L = await D.raceData();
  return {
    recordsMatch: R.decided.length > 0 && season.rosters.every(r => (realW.get(r.roster_id) || 0) === (fixedW.get(r.roster_id) || 0)),
    gamesLeft: R.upcoming.length,
    // every remaining fixture must be a real one off Sleeper's schedule
    scheduleReal: R.upcoming.every(g => season.games.some(x =>
      x.week === g.week && ((x.a.rid === g.a && x.b.rid === g.b) || (x.a.rid === g.b && x.b.rid === g.a)))),
    liveShape: ["ready", "why", "decided", "upcoming", "nextWeek"].filter(k => !(k in L)),
    nextWeekOk: !L.upcoming.length || L.nextWeek === L.upcoming[0].week,
  };
});
check("the fixed record is exactly what actually happened", race.recordsMatch);
check("the remaining fixtures are the real schedule, not invented ones", race.scheduleReal && race.gamesLeft > 0, `${race.gamesLeft} games left`);
check("raceData on the live season has ready, why, decided, upcoming and nextWeek", race.liveShape.length === 0, race.liveShape.join(","));
check("raceData's nextWeek is the first upcoming game's week", race.nextWeekOk);

group("Playoff Picture: the engine");
const ppEng = await page.evaluate(async () => {
  const D = window.__DFFL, M = window.__ODDS;
  const L = await D.liveOnce();
  let live = L.live, lsim = L.lsim, src = "live";
  if (!live) {
    // No live season to test on: rewind 2025 to week 10, the way the rewound
    // Odds board does, and compare against the Odds engine on the same inputs.
    const s25 = D.DB.seasons.find(s => s.season === "2025");
    live = D.liveState(M, s25, D.raceAsOf(s25, 10), null, null, 10);
    lsim = D.simulateSeason(M, D.ODDS_SIMS, live);
    src = "2025 at week 10";
  }
  const job = D.pictureJob(M, live, 5000);
  const viaMain = D.runPictureMain(job);
  window.__PP_FORCE_MAIN = false;
  let viaWorker = null, workerErr = null;
  try { viaWorker = await D.runPictureWorker(job); } catch (e) { workerErr = e.message; }
  window.__PP_FORCE_MAIN = true;
  const forcedFallback = await D.runPicture(job);
  window.__PP_FORCE_MAIN = false;
  const m = viaMain.main, P = M.playoffTeams, N = m.playoff.length;
  const rowsOk = m.seed.every((s, i) => s.reduce((a, x) => a + x, 0) + m.miss[i] === m.sims);
  const colsOk = Array.from({ length: P }, (_, k) => m.seed.reduce((a, s) => a + s[k], 0)).every(c => c === m.sims);
  const pct = m.seed.map((s, i) => s.reduce((a, x) => a + x / m.sims, 0) + m.miss[i] / m.sims);
  // The default path must be bit-identical to what it was: the preseason board
  // re-run here must match the one the Odds tab booted with.
  const pre = D.simulateSeason(M);
  const same = (x, y) => JSON.stringify(x) === JSON.stringify(y);
  const wi = D.whatIfOf(viaMain);
  const whatIf = [...wi.values()];
  return {
    src, N, P, sims: m.sims, rowsOk, colsOk,
    pctOk: pct.every(v => Math.abs(v - 1) <= 1e-9),
    equalsOdds: m.sims === lsim.sims && m.playoff.every((c, i) => c === lsim.playoff[i]),
    playoffIsSeedSum: m.playoff.every((c, i) => c === m.seed[i].reduce((a, x) => a + x, 0)),
    preUnchanged: same(pre.playoff, window.__SIM.playoff) && same(pre.title, window.__SIM.title) && same(pre.last, window.__SIM.last),
    workerErr, workerSame: !!viaWorker && same(viaWorker.main, viaMain.main) && same(viaWorker.forced, viaMain.forced),
    fallbackVia: forcedFallback.via, fallbackSame: same(forcedFallback.main, viaMain.main),
    games: job.games.length,
    forcedSims: viaMain.forced.every(f => f.ifA.sims === 5000 && f.ifB.sims === 5000),
    whatIfOk: whatIf.every(w => w.win >= w.lose - 0.02),
    whatIfN: whatIf.length,
    worst: whatIf.length ? Math.min(...whatIf.map(w => w.win - w.lose)) : null,
    // Same seed both ways: a forced win can't take points for away from anyone.
    forcedWinner: viaMain.forced.every(f => f.ifA.playoff[f.a] >= f.ifB.playoff[f.a] - 0.02 * f.ifA.sims),
  };
});
check(`every team's seed odds plus miss odds sum to 100% (${ppEng.src})`, ppEng.rowsOk && ppEng.pctOk);
check("every seed column sums to 100% across teams", ppEng.colsOk);
check("seed columns match the playoff-seed count", ppEng.P === 6);
check("playoff odds are the sum of the seed odds", ppEng.playoffIsSeedSum);
check("the picture's playoff odds equal the Odds tab's for the same inputs, exactly", ppEng.equalsOdds);
check("the Odds tab's default path is unchanged by the new options", ppEng.preUnchanged);
check("the worker path produces identical counts to the main thread", ppEng.workerSame, ppEng.workerErr || "");
check("__PP_FORCE_MAIN forces the main-thread fallback, with identical counts", ppEng.fallbackVia === "main" && ppEng.fallbackSame, ppEng.fallbackVia);
check("every game this week gets a what-if", ppEng.games > 0 && ppEng.whatIfN === ppEng.games * 2, `${ppEng.games} games, ${ppEng.whatIfN} teams`);
check("forced runs use the requested simulation count", ppEng.forcedSims);
check("winning this week is never worth less than losing it", ppEng.whatIfOk && ppEng.forcedWinner, `worst ${ppEng.worst}`);

group("Playoff Picture: exact clinch and elimination");
const ppClinch = await page.evaluate(() => {
  const D = window.__DFFL;
  const T = (ws, divs) => ws.map((w, i) => ({ rid: i + 1, div: divs[i], w, pf: 1000 - i }));
  // One clear clinch, one clear elimination.
  const a = D.exactClinch({ teams: T([10, 2, 2, 6, 6, 5], [1, 1, 1, 2, 2, 2]),
    remaining: [[0, 1], [2, 3], [4, 5]], playoffTeams: 4, byes: 2 });
  // A division that only points for can settle: nobody may be called in or out.
  const b = D.exactClinch({ teams: T([5, 5, 5, 1], [1, 1, 2, 2]), remaining: [], playoffTeams: 2, byes: 0 });
  // Bounds can't clinch team 1 (four teams can still reach its total), but Y and
  // Z play each other, so only one can: only full enumeration sees that.
  const c = D.exactClinch({ teams: T([10, 6, 10, 4, 4, 0], [1, 1, 2, 2, 2, 1]),
    remaining: [[3, 4], [3, 5], [4, 5], [1, 5], [0, 2]], playoffTeams: 4, byes: 2 });
  // Half-wins on record: team 0 can still get in through a tied result, which a
  // win-or-lose walk never visits.
  const d = D.exactClinch({ teams: T([7, 7.5, 7.5, 12, 12, 12], [1, 2, 2, 3, 1, 2]),
    remaining: [[0, 3], [1, 2]], playoffTeams: 4, byes: 2 });
  return { a, b, c, d };
});
check("a runaway division leader has clinched the playoffs, division and bye",
  ppClinch.a[0].clinchedPlayoff && ppClinch.a[0].clinchedDiv && ppClinch.a[0].clinchedBye, JSON.stringify(ppClinch.a[0]));
check("a team four games out with one left is eliminated", ppClinch.a[1].eliminated && !ppClinch.a[1].clinchedPlayoff, JSON.stringify(ppClinch.a[1]));
check("a spot a points tiebreak decides is never claimed either way",
  !ppClinch.b[0].clinchedPlayoff && !ppClinch.b[0].eliminated && !ppClinch.b[1].clinchedPlayoff && !ppClinch.b[1].eliminated,
  JSON.stringify(ppClinch.b.slice(0, 2)));
check("the untied division winner and the last-place team are still called", ppClinch.b[2].clinchedPlayoff && ppClinch.b[3].eliminated);
check("enumeration clinches what the bounds can't", ppClinch.c[1].clinchedPlayoff && ppClinch.c[1].method === "enumeration", JSON.stringify(ppClinch.c[1]));
check("with a tie on record, a team a tied result can still carry in is not eliminated",
  !ppClinch.d[0].eliminated && ppClinch.d.every(c => c.method === "bounds"), JSON.stringify(ppClinch.d[0]));

const pp13 = await page.evaluate(() => {
  const D = window.__DFFL;
  const season = D.DB.seasons.find(s => s.season === "2025");
  const R = D.raceAsOf(season, 13);
  const rules = D.leagueRules(season);
  const rids = season.rosters.map(r => r.roster_id), idx = new Map(rids.map((r, i) => [r, i]));
  const W = rids.map(() => 0);
  for (const g of R.decided) {
    const x = idx.get(g.a.rid), y = idx.get(g.b.rid);
    if (g.a.pts > g.b.pts) W[x]++; else if (g.b.pts > g.a.pts) W[y]++; else { W[x] += .5; W[y] += .5; }
  }
  const teams = rids.map((rid, i) => ({ rid, div: season.divOf.get(rid), w: W[i], pf: 0 }));
  const remaining = R.upcoming.map(g => [idx.get(g.a), idx.get(g.b)]);
  const C = D.exactClinch({ teams, remaining, playoffTeams: rules.playoffTeams, byes: rules.byes });
  // Independent brute force over every result still to come.
  const P = rules.playoffTeams, divs = [...new Set(teams.map(t => t.div))];
  const canMake = i => {
    for (let k = 0; k < 2 ** remaining.length; k++) {
      const w = W.slice();
      remaining.forEach(([a, b], j) => { if ((k >> j) & 1) w[a]++; else w[b]++; });
      // i wins every tie
      const champ = d => { const m = teams.map((t, j) => j).filter(j => teams[j].div === d);
        return m.sort((x, y) => (w[y] - w[x]) || (x === i ? -1 : y === i ? 1 : 0))[0]; };
      const champs = divs.map(champ);
      if (champs.includes(i)) return true;
      const rest = teams.map((_, j) => j).filter(j => !champs.includes(j)).sort((x, y) => (w[y] - w[x]) || (x === i ? -1 : y === i ? 1 : 0));
      if (rest.indexOf(i) < P - champs.length) return true;
    }
    return false;
  };
  const left = rids.map(() => 0); for (const [a, b] of remaining) { left[a]++; left[b]++; }
  return {
    n: C.length, games: remaining.length,
    elim: C.filter(c => c.eliminated).length,
    clinched: C.filter(c => c.clinchedPlayoff).length,
    elimReal: C.every((c, i) => !c.eliminated || !canMake(i)),
    elimBounds: C.every((c, i) => !c.eliminated || teams.filter((_, j) => W[j] > W[i] + left[i]).length >= 1),
    consistent: C.every(c => (!c.clinchedTop || c.clinchedBye) && (!c.clinchedBye || c.clinchedPlayoff)
      && (!c.clinchedDiv || c.clinchedPlayoff) && !(c.clinchedPlayoff && c.eliminated)),
    // Anyone clinched by division must really be out of reach of every rival.
    divReal: C.every((c, i) => !c.clinchedDiv || teams.every((t, j) => j === i || t.div !== teams[i].div || W[j] + left[j] < W[i])),
    method: C[0].method,
  };
});
check("2025 at week 13: every eliminated team really cannot make it", pp13.elim > 0 && pp13.elimReal, `${pp13.elim} eliminated`);
check("2025 at week 13: eliminated teams are behind on win bounds", pp13.elimBounds);
check("2025 at week 13: badges are consistent with each other and the win bounds", pp13.consistent && pp13.divReal);
check("2025 at week 13: with one week left the check is by enumeration", pp13.games <= 24 && pp13.clinched > 0, `${pp13.clinched} clinched, method ${pp13.method}`);

group("Playoff Picture: the board renders");
const ppDrawn = await page.evaluate(async () => {
  const D = window.__DFFL, M = window.__ODDS;
  const season = D.DB.seasons.find(s => s.season === "2025");
  const R = D.raceAsOf(season, 13);
  const live = D.liveState(M, season, R, null, null, 13);
  const PP = await D.computePicture(M, live, R, season, { whatIfSims: 800 });
  const host = document.querySelector("#pictureHost");
  D.renderPicture(host, PP);
  const t = host.querySelectorAll("table")[0];
  const txt = host.innerText;
  const expect = c => c.clinchedTop ? "Clinched top seed" : c.clinchedBye ? "Clinched bye"
    : c.clinchedPlayoff ? "Clinched playoffs" : c.eliminated ? "Eliminated" : "";
  const byRid = new Map(PP.clinch.map(c => [String(c.rid), c]));
  const rows = [...t.querySelectorAll("tbody tr")];
  // A game already final shows "Final"; a team with no game shows "—". Drawn on
  // a copy so the real board above is what the other checks read.
  const scratch = document.createElement("div");
  const fake = { ...PP, rows: PP.rows.map((r, k) => k === 0 ? { ...r, whatIf: null, final: true }
    : k === 1 ? { ...r, whatIf: null, final: false } : r) };
  D.renderPicture(scratch, fake);
  const cellOf = rid => {
    const tr = scratch.querySelector(`.pp tbody tr[data-rid="${rid}"]`);
    return tr.lastElementChild.querySelector(".ppwi");
  };
  const fin = cellOf(PP.rows[0].rid), none = cellOf(PP.rows[1].rid);
  return {
    finalCell: { text: fin.textContent, muted: fin.classList.contains("muted"), title: fin.getAttribute("title") || "" },
    noneCell: { text: none.textContent, title: none.getAttribute("title") || "" },
    secondCellIsPlayoffs: rows.every(tr => {
      const r = PP.rows.find(x => String(x.rid) === tr.dataset.rid);
      return tr.children[1].querySelector("b") && tr.children[1].textContent.trim() === (r.playoff <= 0 ? "0%" : r.playoff >= 1 ? "100%"
        : r.playoff < 0.005 ? "<1%" : r.playoff > 0.995 ? ">99%" : `${(r.playoff * 100).toFixed(0)}%`);
    }),
    rows: rows.length, managers: PP.rows.length, P: PP.rules.playoffTeams,
    heads: [...t.querySelectorAll("thead th")].map(th => th.textContent),
    nan: /NaN|undefined|Infinity/.test(txt),
    how: /How this works/.test(txt) && /playoff_teams/.test(txt) && /points for/.test(txt),
    badgesMatch: rows.every(tr => {
      const b = [...tr.querySelectorAll(".badge")].map(x => x.textContent).join("");
      return b === expect(byRid.get(tr.dataset.rid));
    }),
    badges: host.querySelectorAll(".pp .badge").length,
    whatIf: [...t.querySelectorAll(".ppwi")].filter(x => /Win \d|Win [<>]/.test(x.textContent)).length,
    swings: !!host.querySelector(".bigg") && /Biggest swings this week/.test(txt),
    sorted: PP.rows.slice().sort((a, b) => b.playoff - a.playoff).every((r, i) => String(r.rid) === rows[i].dataset.rid
      || PP.rows.find(x => String(x.rid) === rows[i].dataset.rid).playoff === r.playoff),
  };
});
check("one row per manager", ppDrawn.rows === ppDrawn.managers && ppDrawn.rows === 12, `${ppDrawn.rows}`);
check("one seed column per playoff team, plus Out and Playoffs",
  ["1", "2", "3", "4", "5", "6"].every(s => ppDrawn.heads.includes(s)) && !ppDrawn.heads.includes(String(ppDrawn.P + 1))
  && ppDrawn.heads.includes("Out") && ppDrawn.heads.includes("Playoffs") && ppDrawn.heads.includes("What-if"), ppDrawn.heads.join(","));
check("columns run Manager, Playoffs, Record, PF, seeds, Out, What-if",
  JSON.stringify(ppDrawn.heads) === JSON.stringify(["Manager", "Playoffs", "Record", "PF",
    ...Array.from({ length: ppDrawn.P }, (_, k) => String(k + 1)), "Out", "What-if"]), ppDrawn.heads.join(","));
check("the bold Playoffs total is the second cell of every row", ppDrawn.secondCellIsPlayoffs);
check('a game already final shows a muted "Final" that says why',
  ppDrawn.finalCell.text === "Final" && ppDrawn.finalCell.muted && /final/i.test(ppDrawn.finalCell.title) && /counted/.test(ppDrawn.finalCell.title),
  JSON.stringify(ppDrawn.finalCell));
check("a team with no game this week still shows —", ppDrawn.noneCell.text === "—" && !ppDrawn.noneCell.title, JSON.stringify(ppDrawn.noneCell));
check("sorted by playoff odds", ppDrawn.sorted);
check("no NaN or undefined on the board", ppDrawn.nan === false);
check('the "How this works" note is there and names the rules read', ppDrawn.how);
check("badges on the page come only from the exact clinch table", ppDrawn.badgesMatch && ppDrawn.badges > 0, `${ppDrawn.badges} badges`);
check("every team playing this week shows win / lose odds", ppDrawn.whatIf === 12, `${ppDrawn.whatIf}`);
check("the biggest swing of the week is called out", ppDrawn.swings);

group("Trades: loading and shape");
// The tab is lazy on purpose — nothing is fetched until it is opened.
await page.click('#tabs button[data-tab="trades"]');
await page.waitForFunction(() => document.body.dataset.tradesReady, null, { timeout: 180000 });
const tradesState = await page.evaluate(() => document.body.dataset.tradesReady);
check("the trades tab loads its own data on first open", tradesState === "1", tradesState);

const T = await page.evaluate(() => {
  const L = window.__TRADES, W = window.__WAIVERS, D = window.__DFFL;
  const nums = [];
  const walk = (o, path) => {
    if (typeof o === "number") { if (!isFinite(o)) nums.push(path); return; }
    if (!o || typeof o !== "object") return;
    for (const k of Object.keys(o)) { if (k === "t" || k === "trade") continue; walk(o[k], path + "." + k); }
  };
  walk(L.byMgr, "byMgr"); walk(L.graded.map(t => ({ m: t.margin, mv: t.moved, s: t.sides })), "graded");
  walk(W.claims, "claims");
  return {
    trades: L.trades.length, graded: L.graded.length, reversed: L.reversed,
    // every side of every graded trade mirrors: the nets must cancel exactly
    netZero: L.graded.map(t => t.sides.reduce((a, s) => a + s.net, 0)).reduce((a, b) => Math.abs(a) + Math.abs(b), 0),
    // and the gains must add up to everything that moved
    movedOk: L.graded.every(t => Math.abs(t.sides.reduce((a, s) => a + s.gain, 0) - t.moved) < 1e-9),
    ledgerSum: L.byMgr.reduce((a, m) => a + m.net, 0),
    nonFinite: nums.slice(0, 5),
    ungradedHaveReasons: L.trades.filter(t => !t.graded).every(t => typeof t.reason === "string" && t.reason.length > 0),
    gradedHaveNoReason: L.graded.every(t => !t.reason),
    picksOnlyGraded: L.trades.filter(t => t.nPlayers === 0 && t.pricedPicks > 0).every(t => t.graded),
    picksOnlyUnpriceable: L.trades.filter(t => t.nPlayers === 0 && t.pricedPicks === 0).every(t => !t.graded),
    splitAddsUp: L.byMgr.every(m => Math.abs(m.net - (m.playerNet + m.pickNet)) < 1e-9),
    claims: W.claims.length, spent: W.totalSpent,
    // a claim can only be ranked on value if it had weeks left to deliver any
    rankedHaveWindow: [...W.overpays, ...W.bestBuys, ...W.bestFree].every(c => c.weeksLeft >= 3 && c.played),
    deadHaveWindow: W.deadMoney.every(c => c.weeksLeft >= 1 && c.pts <= 0 && c.bid > 0),
    spendMatches: Math.abs(W.spend.reduce((a, x) => a + x.spent, 0) - W.totalSpent) < 1e-9,
    namesResolved: L.trades.flatMap(t => t.sides.flatMap(s => [...s.got, ...s.sent]))
      .filter(x => x.name === String(x.pid)).length,
    cards: document.querySelectorAll('[data-panel="trades"] .trade').length,
    moreButton: !!document.querySelector('[data-panel="trades"] .back.more'),
    // the summary sections must come before the log, not after it
    order: [...document.querySelectorAll('[data-panel="trades"] .sechead h2')].map(h => h.textContent),
  };
});
check("every trade in league history is listed", T.trades > 100, `${T.trades}`);
check("the trade log opens short rather than as a wall of cards", T.cards === 20 && T.moreButton, `${T.cards} cards`);
check("the summaries come before the log", T.order.indexOf("Every trade in league history") === T.order.length - 1, T.order.join(" / "));
check("the ledger, the picks and the waivers all render", ["All-time trade ledger", "What the traded picks became", "Waivers and FAAB"].every(h => T.order.includes(h)), T.order.join(" / "));
await page.click('[data-panel="trades"] .back.more');
const expanded = await page.evaluate(() => document.querySelectorAll('[data-panel="trades"] .trade').length);
check("expanding shows a card for every trade", expanded === T.trades, `${expanded} cards / ${T.trades} trades`);
check("both sides of every graded trade cancel to zero", T.netZero < 1e-6, `${T.netZero}`);
check("each trade's gains sum to the points it moved", T.movedOk);
check("the whole ledger sums to zero", Math.abs(T.ledgerSum) < 1e-6, `${T.ledgerSum}`);
check("no NaN or Infinity anywhere in the ledger", T.nonFinite.length === 0, T.nonFinite.join(", "));
check("every ungraded trade says why", T.ungradedHaveReasons);
check("every graded trade carries no excuse", T.gradedHaveNoReason);
check("a picks-only trade is graded once its picks resolve", T.picksOnlyGraded);
check("a picks-only trade with nothing priceable is not graded", T.picksOnlyUnpriceable);
check("each manager's net splits exactly into players and picks", T.splitAddsUp);
check("reversed trades are thrown out", T.reversed > 0 && T.reversed % 2 === 0, `${T.reversed}`);
check("player names resolved from ids", T.namesResolved === 0, `${T.namesResolved} unresolved`);
check("waiver claims loaded", T.claims > 500, `${T.claims}`);
check("FAAB spend tallies to the league total", T.spendMatches);
check("value rankings only use claims with three weeks left", T.rankedHaveWindow);
check("dead money is real dead money", T.deadHaveWindow);

const verdicts = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('[data-panel="trades"] .trade')];
  const even = cards.filter(c => c.querySelector(".verd.even"));
  const decided = cards.filter(c => c.querySelector(".verd.win, .verd.lop, .verd.fleeced"));
  const none = cards.filter(c => c.querySelector(".verd.none"));
  return {
    even: even.length, decided: decided.length, none: none.length,
    evenNamesWinner: even.filter(c => c.querySelector(".tside.won")).length,
    evenShowsMargin: even.filter(c => /[+−]\d/.test(c.querySelector(".verd").textContent)).length,
    ungradedNamesWinner: none.filter(c => c.querySelector(".tside.won")).length,
    ungradedShowsPoints: none.filter(c => /\d+\.\d/.test(c.querySelector(".tlist") ? c.querySelector(".tlist").textContent : "")).length,
    decidedAllHaveWinner: decided.every(c => c.querySelector(".tside.won")),
    decidedAllShowMargin: decided.every(c => /[+−]\d/.test(c.querySelector(".verd").textContent)),
  };
});
check("a trade inside the even band names no winner", verdicts.evenNamesWinner === 0, `${verdicts.evenNamesWinner} of ${verdicts.even}`);
check("a trade inside the even band posts no margin", verdicts.evenShowsMargin === 0, `${verdicts.evenShowsMargin}`);
check("an ungraded trade names no winner", verdicts.ungradedNamesWinner === 0, `${verdicts.ungradedNamesWinner} of ${verdicts.none}`);
check("an ungraded trade shows no points at all", verdicts.ungradedShowsPoints === 0, `${verdicts.ungradedShowsPoints}`);
check("every decided trade marks its winner", verdicts.decidedAllHaveWinner && verdicts.decided > 40, `${verdicts.decided} decided`);
check("every decided trade posts its margin", verdicts.decidedAllShowMargin);

group("Trades: draft picks resolve to the player taken");
const picks = await page.evaluate(() => {
  const D = window.__DFFL, DB = D.DB, TX = window.__TX, L = window.__TRADES;
  const seasonOf = new Map(DB.seasons.map(s => [s.season, s]));
  let total = 0, resolved = 0, priced = 0, keepers = 0, unplayed = 0;
  const wrongRound = [];
  // How many times each distinct pick was traded, so we can isolate the ones
  // that moved exactly once and check them against the draft board itself.
  const moves = new Map();
  for (const t of TX) if (t.type === "trade") for (const d of t.draft_picks || []) {
    const k = `${d.season}|${d.round}|${d.roster_id}`;
    moves.set(k, (moves.get(k) || 0) + 1);
  }
  let once = 0, selectedByReceiver = 0;
  const wrongOwner = [];
  for (const t of TX) {
    if (t.type !== "trade") continue;
    const ts = seasonOf.get(t.season);
    for (const d of t.draft_picks || []) {
      total++;
      const r = D.resolvePick(d, ts);
      if (!r.name) continue;
      resolved++;
      if (r.priced) priced++;
      if (r.keeper) keepers++;
      const target = seasonOf.get(String(d.season));
      const board = target.picks.find(x => x.pick_no === r.no);
      if (Number(board.round) !== Number(d.round)) wrongRound.push(`${d.season} r${d.round} -> pick ${r.no} is round ${board.round}`);
      if (!D.seasonPlayed(target)) unplayed++;
      if (moves.get(`${d.season}|${d.round}|${d.roster_id}`) !== 1) continue;
      once++;
      // A pick that moved exactly once was made by whoever received it. This is
      // an outside check on the whole chain — nothing in it comes from the slot
      // map the resolver used.
      if (board.picked_by === ts.uidOf.get(Number(d.owner_id))) selectedByReceiver++;
      else wrongOwner.push(`${d.season} r${d.round}: ${r.name} picked by someone else`);
    }
  }
  const keys = L.pickHauls.map(r => `${r.year}|${r.no}`);
  return {
    total, resolved, priced, keepers, unplayed, once, selectedByReceiver,
    wrongRound: wrongRound.slice(0, 3), wrongOwner: wrongOwner.slice(0, 3),
    keeperNeverPriced: !L.trades.some(t => t.sides.some(sd =>
      [...sd.picksIn, ...sd.picksOut].some(r => r.keeper && r.priced))),
    unplayedNeverPriced: !L.trades.some(t => t.sides.some(sd =>
      [...sd.picksIn, ...sd.picksOut].some(r => r.priced && !D.seasonPlayed(seasonOf.get(r.year))))),
    haulsUnique: new Set(keys).size === keys.length,
    // Not `pts >= 0`: a fantasy player can finish a week under water — a lost
    // fumble alone is minus two — and this assertion only ever held because it
    // was written in an off-season where every total was zero. The first live
    // week produced Jordan Mason on -0.4 and failed it.
    haulsSane: L.pickHauls.every(r => isFinite(r.pts) && r.no > 0 && !!r.name),
    haulsZero: L.pickHauls.filter(r => r.pts === 0).length,
    haulsNegative: L.pickHauls.filter(r => r.pts < 0).length,
    everyUnpricedHasReason: L.trades.every(t => t.sides.every(sd =>
      [...sd.picksIn, ...sd.picksOut].every(r => r.priced || (r.why && r.why.length > 0)))),
  };
});
check("every traded pick resolves to a selection", picks.resolved === picks.total, `${picks.resolved}/${picks.total}`);
check("no resolved pick lands in the wrong round", picks.wrongRound.length === 0, picks.wrongRound.join(" | "));
check("a pick traded once was drafted by whoever received it", picks.once > 100 && picks.selectedByReceiver === picks.once, `${picks.selectedByReceiver}/${picks.once} — ${picks.wrongOwner.join(" | ")}`);
check("most traded picks end up priced", picks.priced > 200, `${picks.priced} of ${picks.total}`);
check("a keeper slot is never priced", picks.keeperNeverPriced && picks.keepers > 0, `${picks.keepers} keeper slots seen`);
check("a pick in an unplayed season is never priced", picks.unplayedNeverPriced && picks.unplayed > 0, `${picks.unplayed} unplayed`);
check("every unpriced pick says why", picks.everyUnpricedHasReason);
check("a pick appears once in the haul table, under its last holder", picks.haulsUnique);
check("every priced haul has a real player and a real slot", picks.haulsSane,
  `${picks.haulsZero} scoreless, ${picks.haulsNegative} under water`);

group("Trades: only the weeks after a trade count");
const after = await page.evaluate(() => {
  const D = window.__DFFL, DB = D.DB;
  const season = DB.seasons.find(s => s.season === "2023");
  const wk = w => season.playerWeek.get(w) || new Map();
  const all = [...new Set([...Array(14)].flatMap((_, i) => [...wk(i + 1).keys()]))];
  // the biggest scorer of that season — a player with points in both halves
  const pid = all.reduce((b, p) => D.ptsFrom(season, p, 1) > D.ptsFrom(season, b, 1) ? p : b, all[0]);
  const sum = ws => ws.reduce((a, w) => a + (wk(w).get(pid) || 0), 0);
  return {
    pid,
    head: sum([1, 2, 3, 4, 5, 6, 7]),
    tail: sum([8, 9, 10, 11, 12, 13, 14]),
    playoffs: sum([15, 16, 17]),
    fromWeek1: D.ptsFrom(season, pid, 1),
    fromWeek8: D.ptsFrom(season, pid, 8),
    fromWeek15: D.ptsFrom(season, pid, 15),
  };
});
check("the week-by-week test has a real player to work on", after.head > 20 && after.tail > 20, JSON.stringify(after));
check("a full-season count matches the sum of its weeks", near(after.fromWeek1, after.head + after.tail, 1e-9), `${after.fromWeek1} vs ${after.head + after.tail}`);
check("counting from week 8 drops weeks 1-7 exactly", near(after.fromWeek8, after.tail, 1e-9), `${after.fromWeek8} vs ${after.tail}`);
check("a mid-season count is strictly less than the whole season", near(after.fromWeek1 - after.fromWeek8, after.head, 1e-9) && after.head > 0, `${after.fromWeek1} − ${after.fromWeek8} should be ${after.head}`);
check("playoff weeks are scored by Sleeper but never counted here", after.playoffs > 0 && after.fromWeek15 === 0, `playoff pts ${after.playoffs}, counted ${after.fromWeek15}`);

group("Trades: v2 grade chips");
{
  const fs = await import("node:fs");
  const G = JSON.parse(fs.readFileSync("data/trade-grades.json", "utf8"));
  const K = JSON.parse(fs.readFileSync("keepers.json", "utf8"));
  const sides = Object.values(G.trades).flatMap(t => t.sides);
  const share = l => sides.filter(s => s.tradeDay.letter === l).length / sides.length;
  check("every trade side has a trade-day letter", sides.every(s => /^(A\+|A|B|C|D|F|F-)$/.test(s.tradeDay.letter)));
  check("C is the biggest band (about the middle 40%)", share("C") > 0.3 && share("C") < 0.55, share("C").toFixed(2));
  check("A+ and F- are rare (under 6% each)", share("A+") < 0.06 && share("F-") < 0.06, `${share("A+").toFixed(3)} / ${share("F-").toFixed(3)}`);
  check("margins cancel within each trade", Object.values(G.trades).every(t => Math.abs(t.sides.reduce((a, s) => a + s.tradeDay.marginPts, 0)) < 0.5));
  check("an unresolved pick leaves hindsight Pending", Object.values(G.trades).some(t => t.sides.some(s => s.hindsight === "Pending")));
  const pierce = G.trades["1014788370771537920"];
  check("2023 Pierce-for-R5 resolves the pick to Jordan Addison in hindsight", pierce && pierce.sides.some(s => s.assets.some(a => a.became === "Jordan Addison")));
  check("regression starts in 2027 and trades don't reset years", K.config.REGRESSION_FROM === 2027 && K.config.TRADE_RESETS_YEARS === false);
  check("Puka's next keeper cost regresses R15 -> R12", K.players["9493"] && K.players["9493"].nextCostRound === 12 && K.players["9493"].regressed);
  check("BTJ is flagged as an exception", (K.exceptions || []).some(e => e.player_id === "11631"));
  check("keepers.json still carries the stated seasons lists", !!(K.seasons && K.seasons["2026"]));
  const chips = await page.evaluate(() => [...document.querySelectorAll('[data-panel="trades"] .gchip')].length);
  check("trade cards show grade chips", chips > 50, `${chips}`);
  const overflow = await page.evaluate(() => [...document.querySelectorAll('[data-panel="trades"] .tside')].some(e => e.scrollWidth > e.clientWidth + 1));
  check("chips don't overflow a trade side", !overflow);
  const vp = page.viewportSize();
  await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(300);
  const overflow390 = await page.evaluate(() => [...document.querySelectorAll('[data-panel="trades"] .tside')].filter(e => e.scrollWidth > e.clientWidth + 1).length);
  check("chips don't overflow a trade side at 390px", overflow390 === 0, `${overflow390}`);
  if (vp) await page.setViewportSize(vp);
  const small = Object.values(G.trades).filter(t => t.sides.reduce((a, s) => a + s.total, 0) < 25);
  check("trades under 25 VOR total grade C · small trade, both sides, point margin kept",
    small.length > 0 && small.every(t => t.sides.every(s => s.tradeDay.letter === "C" && s.tradeDay.small && typeof s.tradeDay.marginPts === "number")), `${small.length} trades`);
  check("every grade stays within ±100%", sides.every(s => Math.abs(s.tradeDay.marginPct) <= 100 && (typeof s.hindsight === "string" || Math.abs(s.hindsight.marginPct) <= 100)));
  const keptPicks = Object.values(G.trades).flatMap(t => t.sides.flatMap(s => s.assets)).filter(a => a.kept);
  const M0 = await import("./build-trade-grades.mjs");
  check("a pick spent on a keeper is valued at its slot's curve value and labelled Kept: <player>",
    keptPicks.length > 0 && keptPicks.every(a => /^Kept: \S/.test(a.became) && Math.abs(a.hindsight - Math.round(M0.curve(Number(a.hindsightBasis.match(/pick (\d+)/)[1])) * 10) / 10) < 0.05), `${keptPicks.length} kept picks`);
  // unit checks on the exported math
  const M = await import("./build-trade-grades.mjs");
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  check("cutoffs: 21.5% C, 21.6% B, -55.3% F, 86.9% A+, -86.8% F", M.letter(0.215) === "C" && M.letter(0.216) === "B" && M.letter(-0.553) === "F" && M.letter(0.869) === "A+" && M.letter(-0.868) === "F");
  check("margin: two teams is side minus other over the total", near(M.marginPts(30, 40, 2), 20) && near(M.marginPct(30, 40, 2), 0.5));
  check("margin: three teams uses the average other side and is bounded", near(M.marginPts(0, 90, 3), -45) && near(M.marginPct(0, 90, 3), -1) && near(M.marginPct(90, 90, 3), 1)
    && near([60, 20, 10].reduce((a, x) => a + M.marginPts(x, 90, 3), 0), 0));
  check("grade: under 25 VOR total is C · small trade with the margin kept", (g => g.letter === "C" && g.small && g.marginPts === 10)(M.grade(10, 10, 2)) && !M.grade(30, 30, 2).small);
  check("regress: R15→12, R10→7, R9→7, R5→3, R4→3, R1→1", [15, 10, 9, 5, 4, 1].map(M.regress).join() === "12,7,7,3,3,1");
  const H = new Map([[2024, new Map([["p", { round: 15, by: "u" }]])], [2025, new Map([["p", { round: 15, by: "u" }]])], [2026, new Map([["p", { round: 15, by: "v" }]])]]);
  check("nextCost: kept 2 years regresses from 2027; not before; trade resets only when switched on",
    M.nextCost(H, "p", 2026, { REGRESSION_FROM: 2027, TRADE_RESETS_YEARS: false }).nextCostRound === 12
    && M.nextCost(H, "p", 2026, { REGRESSION_FROM: 2028, TRADE_RESETS_YEARS: false }).nextCostRound === 15
    && M.nextCost(H, "p", 2026, { REGRESSION_FROM: 2027, TRADE_RESETS_YEARS: true }).yearsKept === 0);
  check("keeperValue: 0.8 x (0.58 x VOR - cost value), floored at 0", near(M.keeperValue(100, 15), 0.8 * (58 - M.curve(M.midPick(15)))) && M.keeperValue(0, 1) === 0);
}

group("Trades: a synthetic trade grades to a known answer");
const synth = await page.evaluate(() => {
  const D = window.__DFFL, DB = D.DB;
  const season = DB.seasons.find(s => s.season === "2023");
  const rids = season.rosters.slice(0, 2).map(r => r.roster_id);
  // Two players with real week-by-week scoring, swapped in week 6.
  const wk = 6;
  const pool = [...season.playerWeek.get(wk).keys()];
  const A = pool.find(p => D.ptsFrom(season, p, wk) > 60);
  const B = pool.find(p => p !== A && D.ptsFrom(season, p, wk) > 5 && D.ptsFrom(season, p, wk) < 40);
  const tx = {
    transaction_id: "synthetic", type: "trade", status: "complete", leg: wk, created: 1,
    roster_ids: rids, draft_picks: [],
    adds: { [A]: rids[1], [B]: rids[0] },
    drops: { [A]: rids[0], [B]: rids[1] },
  };
  const g = D.gradeTrade(tx, season);
  const ptsA = D.ptsFrom(season, A, wk), ptsB = D.ptsFrom(season, B, wk);
  const side1 = g.sides.find(s => s.rid === rids[1]);
  const side0 = g.sides.find(s => s.rid === rids[0]);
  // The same trade a week earlier must be worth strictly more to the winner.
  const earlier = D.gradeTrade({ ...tx, leg: wk - 1 }, season);
  // And one made in the playoffs cannot be graded at all.
  const late = D.gradeTrade({ ...tx, leg: 15 }, season);
  // Picks with no players now resolve to the player actually taken.
  const picksOnly = D.gradeTrade({ ...tx, adds: {}, drops: {}, draft_picks: [{ round: 2, season: "2024", roster_id: rids[1], owner_id: rids[0], previous_owner_id: rids[1] }] }, season);
  // A pick for a season nobody has played still cannot be priced.
  const futurePick = D.gradeTrade({ ...tx, adds: {}, drops: {}, draft_picks: [{ round: 2, season: "2026", roster_id: rids[1], owner_id: rids[0], previous_owner_id: rids[1] }] }, season);
  return {
    ptsA, ptsB, graded: g.graded, moved: g.moved,
    gain1: side1.gain, loss1: side1.loss, net1: side1.net,
    gain0: side0.gain, loss0: side0.loss, net0: side0.net,
    winnerIsA: g.winner && g.winner.rid === rids[1],
    margin: g.margin,
    earlierMargin: earlier.margin,
    lateGraded: late.graded, lateReason: late.reason,
    picksGraded: picksOnly.graded, picksReason: picksOnly.reason,
    picksMoved: picksOnly.moved,
    picksWinnerGain: picksOnly.winner && picksOnly.winner.gain,
    picksResolved: picksOnly.sides.flatMap(x => x.picksIn).filter(x => x.priced)
      .map(x => ({ name: x.name, pts: x.pts, no: x.no })),
    futureGraded: futurePick.graded, futureReason: futurePick.reason,
  };
});
check("the synthetic winner receives exactly the better player's points", near(synth.gain1, synth.ptsA, 1e-9), `${synth.gain1} vs ${synth.ptsA}`);
check("the synthetic loser receives exactly the lesser player's points", near(synth.gain0, synth.ptsB, 1e-9), `${synth.gain0} vs ${synth.ptsB}`);
check("what one side gains, the other gave up", near(synth.loss0, synth.ptsA, 1e-9) && near(synth.loss1, synth.ptsB, 1e-9));
check("the margin is the difference between the two players", near(synth.margin, synth.ptsA - synth.ptsB, 1e-9), `${synth.margin} vs ${synth.ptsA - synth.ptsB}`);
check("points moved is both players added together", near(synth.moved, synth.ptsA + synth.ptsB, 1e-9), `${synth.moved} vs ${synth.ptsA + synth.ptsB}`);
check("the nets are equal and opposite", near(synth.net1, -synth.net0, 1e-9), `${synth.net1} vs ${synth.net0}`);
check("the better player's side is the winner", synth.winnerIsA === true);
check("the same trade made a week earlier is worth more", synth.earlierMargin > synth.margin, `${synth.earlierMargin} vs ${synth.margin}`);
check("a trade made in the playoffs is not graded", synth.lateGraded === false && /regular season/.test(synth.lateReason), synth.lateReason);
check("a picks-only trade is graded on the player its pick became", synth.picksGraded === true && synth.picksResolved.length === 1, JSON.stringify(synth.picksResolved));
check("the picks-only trade is worth exactly that player's season", synth.picksResolved.length === 1 && near(synth.picksMoved, synth.picksResolved[0].pts, 1e-9), `${synth.picksMoved} vs ${synth.picksResolved[0] && synth.picksResolved[0].pts}`);
check("a pick for a season nobody has played is not graded", synth.futureGraded === false && /hasn't been played/.test(synth.futureReason), synth.futureReason);

/* ------------------------------------------------------------------------
 * A week is only a result once it has been played out. Mid-Sunday the matchup
 * rows already carry real, partial scores, and taking those as wins is how a
 * site ends up crowning a team that is up thirty with three starters still to
 * kick off. These checks pin the rule in two places: the decision itself, and
 * the guarantee that nothing which feeds a record ever sees a live game.
 * ---------------------------------------------------------------------- */
group("A week is only a result once it has been played");

const wf = await page.evaluate(() => {
  const { weekIsFinal, DB } = window.__DFFL;
  const save = DB.state;
  const lg = { season: "2026", status: "in_season" };
  DB.state = { season: "2026", week: 5 };
  const r = {
    past: weekIsFinal(lg, 4),
    current: weekIsFinal(lg, 5),
    future: weekIsFinal(lg, 6),
    otherSeason: weekIsFinal({ season: "2024", status: "complete" }, 5),
    completeLeague: weekIsFinal({ season: "2026", status: "complete" }, 5),
  };
  DB.state = null;
  r.noState = weekIsFinal(lg, 5);
  DB.state = { season: "2026", week: "nonsense" };
  r.badState = weekIsFinal(lg, 5);
  DB.state = save;
  return r;
});
check("a week the NFL has finished is a result", wf.past === true);
check("the week being played right now is not a result", wf.current === false);
check("a week nobody has played yet is not a result", wf.future === false);
check("a season that is not the live one is final throughout", wf.otherSeason === true);
check("a completed league is final throughout", wf.completeLeague === true);
check("no NFL state → nothing is held back", wf.noState === true);
check("unreadable NFL state → nothing is held back", wf.badState === true);

const split = await page.evaluate(() => {
  const { DB, weekIsFinal } = window.__DFFL;
  const statusOf = s => (DB.seasons.find(x => x.season === s) || {}).status;
  const lgOf = g => ({ season: g.season, status: statusOf(g.season) });
  const key = g => `${g.season}|${g.week}|${Math.min(g.a.rid, g.b.rid)}`;
  const inGames = new Set(DB.games.map(key));
  return {
    games: DB.games.length,
    live: DB.live.length,
    liveWeek: (DB.seasons[0] || {}).liveWeek,
    // nothing in the record book may sit in a week that is not finished
    leaks: DB.games.filter(g => !weekIsFinal(lgOf(g), g.week)).length,
    // and every live game must be genuinely unfinished
    wrongly: DB.live.filter(g => weekIsFinal(lgOf(g), g.week)).length,
    dupes: DB.live.filter(g => inGames.has(key(g))).length,
    liveFlagged: DB.live.every(g => g.live === true),
    finalUnflagged: DB.games.every(g => !g.live),
    seasonSplit: DB.seasons.every(s =>
      s.games.every(g => !g.live) && (s.live || []).every(g => g.live === true)),
  };
});
check("the record book holds finished football only", split.leaks === 0, `${split.leaks} unfinished games counted`);
check("every held-back game really is unfinished", split.wrongly === 0, `${split.wrongly}`);
check("a live game is never also counted as a result", split.dupes === 0, `${split.dupes}`);
check("live games carry the flag, finished ones don't", split.liveFlagged && split.finalUnflagged);
check("each season splits the same way as the league does", split.seasonSplit);
check("games still on record", split.games > 300, `${split.games}`);

// The standings, the record book and every simulation read DB.games, so the
// split above is the whole guarantee — but check the one place that is allowed
// to show a live week shows it as scores rather than as results.
await page.click('#tabs button[data-tab="scores"]');
await page.waitForTimeout(150);
const sb = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="scores"]');
  const wSel = panel.querySelectorAll("select")[1];
  const opt = [...wSel.options].find(o => /in progress/.test(o.textContent));
  if (!opt) return { present: false };
  wSel.value = opt.value;
  wSel.dispatchEvent(new Event("change"));
  const txt = n => (n.textContent || "");
  return {
    present: true,
    cards: panel.querySelectorAll(".game").length,
    note: !!panel.querySelector(".livenote"),
    verdicts: panel.querySelectorAll(".gside.win, .gside.lose").length,
    leads: panel.querySelectorAll(".gside.lead").length,
    feet: [...panel.querySelectorAll(".gfoot")].filter(f => /In progress/.test(txt(f))).length,
    wonBy: [...panel.querySelectorAll(".gfoot")].filter(f => /won by/.test(txt(f))).length,
    crowns: [...panel.querySelectorAll(".gside .gt")].filter(t => /top score|low score/.test(txt(t))).length,
  };
});
if (!sb.present) {
  check("no week is in progress, so the scoreboard shows results only", split.live === 0, `${split.live} live games but no live week on the board`);
} else {
  check("the live week is on the scoreboard", sb.cards > 0, `${sb.cards}`);
  check("the live week says so in words", sb.note);
  check("nobody is marked as having won a live game", sb.verdicts === 0, `${sb.verdicts} sides styled as win/lose`);
  check("the side ahead is marked as ahead, not as the winner", sb.leads > 0, `${sb.leads}`);
  check("every live card reads as in progress", sb.feet === sb.cards, `${sb.feet}/${sb.cards}`);
  check("no live card claims anyone won by anything", sb.wonBy === 0, `${sb.wonBy}`);
  check("no high or low score is crowned mid-week", sb.crowns === 0, `${sb.crowns}`);
}

/* ------------------------------------------------------------------------
 * The live board: results update the draft-day projection rather than
 * replacing it, injuries are charged to the week they belong to, and none of
 * it is allowed to disturb the opening line.
 * ---------------------------------------------------------------------- */
group("The blast ledger");

/* data/sent-emails.json is what stops the Saturday blast re-sending a column the
 * league already read. It fails open if it is malformed or if a slug in it does
 * not match anything in recaps.json — the guard would quietly decide nothing has
 * ever been sent. These are cheap and catch exactly that. */
const ledgerFile = await page.evaluate(async () => {
  const [l, r] = await Promise.all([
    fetch("data/sent-emails.json", { cache: "no-cache" }).then(x => x.ok ? x.json() : null).catch(() => null),
    fetch("recaps.json", { cache: "no-cache" }).then(x => x.json()),
  ]);
  if (!l) return { missing: true };
  const slugs = new Set((r.articles || []).map(a => a.slug));
  const weeks = new Set((r.weeks || []).map(w => `${w.season}w${w.week}`));
  const refs = l.sent.flatMap(s => [s.lead, ...(s.alsoSent || [])]).filter(Boolean);
  return {
    missing: false,
    n: l.sent.length,
    shaped: l.sent.every(s => s.at && s.subject && typeof s.to === "number"),
    chronological: l.sent.every((s, i, a) => i === 0 || String(a[i - 1].at) <= String(s.at)),
    danglingSlugs: refs.filter(s => !slugs.has(s)),
    danglingWeeks: l.sent.filter(s => s.recap).map(s => `${s.recap.season}w${s.recap.week}`)
      .filter(w => !weeks.has(w)),
    reachedTwelve: l.sent[l.sent.length - 1] ? l.sent[l.sent.length - 1].to : 0,
    newestArticleSent: refs.includes(((r.articles || []).slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))[0] || {}).slug),
  };
});
if (ledgerFile.missing) {
  check("the blast ledger is published", false, "data/sent-emails.json not found");
} else {
  check("the blast ledger is published and shaped", ledgerFile.shaped, `${ledgerFile.n} entries`);
  check("its entries are in chronological order", ledgerFile.chronological);
  check("every article it says was sent still exists",
    ledgerFile.danglingSlugs.length === 0, ledgerFile.danglingSlugs.join(", "));
  check("every week it says was blasted still exists",
    ledgerFile.danglingWeeks.length === 0, ledgerFile.danglingWeeks.join(", "));
  check("the most recent send reached all twelve", ledgerFile.reachedTwelve === 12,
    `${ledgerFile.reachedTwelve} addresses`);
  check("the guard can tell the newest piece has been sent",
    typeof ledgerFile.newestArticleSent === "boolean", `${ledgerFile.newestArticleSent}`);
}

/* The subject says the upcoming week; the recap inside is the week just played.
 * Recording the subject's number once logged a recap that did not exist. These
 * run the recorder's week check against the real recaps.json, in node. */
{
  const { resolveRecapWeek, newestRecap } = await import(new URL("./email-week.mjs", import.meta.url));
  const recaps = JSON.parse(await readFile(join(ROOT, "recaps.json"), "utf8"));
  const newest = newestRecap(recaps);
  const refused = weekArg => { try { resolveRecapWeek({ recaps, weekArg }); return false; } catch { return true; } };
  if (!newest) {
    for (const name of ["recording a send defaults to the recap the email carries",
      "recording the subject's week instead of the recap's is refused",
      "recording the newest recap by number is accepted"])
      check(name, true, "recaps.json has no weeks yet");
  } else {
    const byDefault = resolveRecapWeek({ recaps });
    check("recording a send defaults to the recap the email carries",
      byDefault && byDefault.season === newest.season && byDefault.week === newest.week,
      `${JSON.stringify(byDefault)}`);
    check("recording the subject's week instead of the recap's is refused",
      refused(String(newest.week + 1)), `--week ${newest.week + 1} with newest ${newest.season} week ${newest.week}`);
    check("recording the newest recap by number is accepted",
      !refused(String(newest.week)), `--week ${newest.week}`);
  }
}

/* The Tuesday build and the "which week" guard. The unit tests run in node;
 * the prompt and the workflow are read as text. Nothing here requires today's
 * data/latest.json to carry final or generated_at yet — files written before
 * build-week.mjs learned to add them still pass, and the guard just says hold. */
{
  const { spawnSync } = await import("node:child_process");
  const node = args => spawnSync(process.execPath, args, { cwd: ROOT, encoding: "utf8", timeout: 60000 });
  for (const [file, name] of [
    ["test-email-week.mjs", "the ledger-week and send-guard unit tests pass"],
    ["test-week-final.mjs", "the week-finality unit tests pass"],
    ["test-effective-week.mjs", "the effective-week unit tests pass, and index.html's copy matches"],
  ]) {
    const r = node(["--test", file]);
    const m = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(r.stdout || "");
    check(name, r.status === 0, m ? `${m[1]} pass, ${m[2]} fail` : String(r.stderr || r.error || "").slice(0, 200));
  }

  const prompt = await readFile(join(ROOT, "weekly-job-prompt.md"), "utf8");
  const recordCmd = (prompt.match(/node blast-status\.mjs --record[^`]*/) || [""])[0];
  check("the prompt's record command passes neither --season nor --week",
    !!recordCmd && !/--(season|week)\b/.test(recordCmd), recordCmd.replace(/\s+/g, " ").slice(0, 140));
  check("the prompt still says a refused --record means the email already went out",
    /If `--record` exits 2, the\s+email has already been sent\. Do not send it again\./.test(prompt));
  check("the prompt carries the which-week guard",
    /node recap-guard\.mjs/.test(prompt) && /"final": true/.test(prompt) && /latest\.week \+ 1/.test(prompt)
      && /generated_at/.test(prompt) && /12 hours/.test(prompt) && /data\/sent-emails\.json/.test(prompt)
      && /send nothing/i.test(prompt));

  const wf = await readFile(join(ROOT, ".github/workflows/weekly-data.yml"), "utf8");
  const crons = [...wf.matchAll(/cron:\s*"([^"]+)"/g)].map(m => m[1]);
  check("the Tuesday build runs just after midnight ET in both EDT and EST",
    crons.includes("30 4 * * 2") && crons.includes("30 5 * * 2") && !crons.includes("30 12 * * 2"), crons.join(" | "));
  const pushLines = wf.split("\n").filter(l => /^\s*git (push|pull)\b/.test(l) || /git pull --rebase/.test(l));
  check("the data push rebases onto main first and never forces",
    /git pull --rebase/.test(wf) && /git rebase --abort/.test(wf) && !/--force|\s-f\b|push\s+\+/.test(pushLines.join("\n"))
      && wf.indexOf("git pull --rebase") < wf.lastIndexOf("git push"), pushLines.map(l => l.trim()).join(" | "));
  const wfPush = (wf.match(/name: Commit anything that changed[\s\S]*$/) || [""])[0];
  check("weekly-data.yml push: on a rebase failure, reset to origin, rebuild, retry once, then error; no force push",
    (wfPush.match(/git pull --rebase/g) || []).length === 2 && /git rebase --abort/.test(wfPush) && /git reset --hard "origin\/\$branch"/.test(wfPush)
      && ["build-week.mjs", "build-injuries.mjs", "build-email.mjs", "build-odds-history.mjs"].every(f => wfPush.includes(`node ${f}`))
      && /::error::/.test(wfPush) && /exit 1\s*$/.test(wfPush) && !/--force|push -f\b/.test(wf));

  const g = node(["recap-guard.mjs", "--json"]);
  let verdict = null;
  try { verdict = JSON.parse(g.stdout); } catch {}
  check("the send guard reads the real latest.json and ledger and names all four conditions",
    (g.status === 0 || g.status === 1) && verdict && verdict.checks.length === 4 && verdict.ok === (g.status === 0),
    verdict ? (verdict.ok ? "would send" : `would hold: ${verdict.failed.join(", ")}`) : String(g.stderr).slice(0, 200));

  const latestNow = JSON.parse(await readFile(join(ROOT, "data/latest.json"), "utf8"));
  check("latest.json's new fields, where present, are well-formed",
    !("generated_at" in latestNow) || (Number.isFinite(Date.parse(latestNow.generated_at))
      && typeof latestNow.final === "boolean" && !!latestNow.sleeper_state
      && Number.isFinite(Number(latestNow.sleeper_state.week))),
    "generated_at" in latestNow ? `${latestNow.generated_at}, final ${latestNow.final}` : "not written by the new build-week yet");
}

group("Injuries");

const injFile = await page.evaluate(async () => {
  const r = await fetch("injuries.json", { cache: "no-cache" });
  if (!r.ok) return { ok: false, status: r.status };
  const j = await r.json();
  const vals = Object.values(j.map || {});
  return {
    ok: true, count: j.count, keys: Object.keys(j.map || {}).length,
    bytes: JSON.stringify(j).length,
    shaped: vals.every(v => v.s && v.n && v.t),
    noFreeAgents: vals.every(v => v.t && v.t !== "FA"),
    fresh: Date.now() - j.at < 30 * 24 * 60 * 60 * 1000,
  };
});
check("injuries.json is published", injFile.ok, `HTTP ${injFile.status}`);
check("it carries a status per player", injFile.ok && injFile.count === injFile.keys, `${injFile.count} vs ${injFile.keys}`);
check("every row has a status, a name and a club", injFile.shaped);
check("nobody without an NFL club is in it", injFile.noFreeAgents);
check("it is small enough for the front page", injFile.bytes < 200 * 1024, `${(injFile.bytes / 1024).toFixed(1)}KB`);
check("it is not stale", injFile.fresh);

/* The outlook: Sleeper says a man is hurt, ESPN says how badly and for how
 * long. The rails below are all about not lying — a stale return date, a
 * "Not Specified" severity printed as detail, or ESPN's status quietly
 * replacing Sleeper's would each be worse than showing nothing. */
const outlook = await page.evaluate(async () => {
  const [ij, rj] = await Promise.all([
    fetch("injuries.json", { cache: "no-cache" }).then(r => r.json()),
    fetch("rosters.json", { cache: "no-cache" }).then(r => r.json()).catch(() => ({ map: {} })),
  ]);
  const rostered = new Set(Object.keys(rj.map || {}));
  const ent = Object.entries(ij.map || {});
  const vals = ent.map(([, v]) => v);
  const NOT_BODY = /^(coach's decision|undisclosed|personal|not injury related|rest)$/i;
  // Sleeper's own vocabulary. ESPN writes "Injured Reserve" and "Active"; if
  // either ever appears here, the feeds have been crossed and the Odds tab is
  // pricing off a status INJ_AVAIL has never heard of.
  const SLEEPER_STATUSES = new Set(["Out","Questionable","Doubtful","IR","PUP","Sus","NA","DNR","COV"]);
  return {
    n: vals.length,
    withBp: vals.filter(v => v.bp).length,
    withSev: vals.filter(v => v.sev).length,
    withRet: vals.filter(v => v.ret).length,
    withNote: vals.filter(v => v.note).length,
    badBp: vals.filter(v => v.bp && NOT_BODY.test(v.bp)).length,
    badSev: vals.filter(v => v.sev && /not specified/i.test(v.sev)).length,
    badRet: vals.filter(v => v.ret && !/^\d{4}-\d{2}-\d{2}$/.test(v.ret)).length,
    pastRet: vals.filter(v => v.ret && Date.parse(v.ret) < Date.parse(ij.generated)).length,
    longNote: vals.filter(v => v.note && v.note.length > 201).length,
    tinyNote: vals.filter(v => v.note && v.note.length < 20).length,
    noteOffRoster: ent.filter(([id, v]) => v.note && !rostered.has(id)).length,
    foreignStatus: vals.filter(v => !SLEEPER_STATUSES.has(v.s)).map(v => v.s),
    statusSource: (ij.sources || {}).status || "",
    outlookSource: (ij.sources || {}).outlook || "",
    // Outlook fields are additive: a row that has none of them must still be
    // a complete row, because that is what every row was before this existed.
    bareRowsIntact: vals.filter(v => !v.bp && !v.sev && !v.ret && !v.note).every(v => v.s && v.n && v.t),
  };
});
check("the outlook reached a meaningful share of the list", outlook.withBp > outlook.n * 0.2,
  `${outlook.withBp}/${outlook.n} body parts, ${outlook.withSev} severities, ${outlook.withRet} return dates`);
check("no coach's decision is printed as a body part", outlook.badBp === 0, `${outlook.badBp}`);
check("no severity says 'Not Specified'", outlook.badSev === 0, `${outlook.badSev}`);
check("every return date is an ISO date", outlook.badRet === 0, `${outlook.badRet}`);
check("no return date is already in the past", outlook.pastRet === 0, `${outlook.pastRet}`);
check("notes are capped", outlook.longNote === 0, `${outlook.longNote} over 201 chars`);
check("no note is too short to say anything", outlook.tinyNote === 0, `${outlook.tinyNote}`);
check("notes are carried only for rostered players", outlook.noteOffRoster === 0,
  `${outlook.noteOffRoster} off-roster notes`);
check("Sleeper is still the only authority on status", outlook.foreignStatus.length === 0,
  [...new Set(outlook.foreignStatus)].join(", "));
check("the file names both of its sources", !!outlook.statusSource && !!outlook.outlookSource,
  `status=${outlook.statusSource} outlook=${outlook.outlookSource}`);
check("a row with no outlook is still a complete row", outlook.bareRowsIntact);

// The two renderers, on the cases that actually occur in the feed.
const injRender = await page.evaluate(() => {
  const { injuryDetail, returnLabel } = window.__DFFL;
  const iso = d => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);
  return {
    both: injuryDetail({ bp: "Knee - ACL", sev: "Surgery" }),
    dupe: injuryDetail({ bp: "Concussion", sev: "Concussion" }),
    bpOnly: injuryDetail({ bp: "Hamstring" }),
    sevOnly: injuryDetail({ sev: "Sprain" }),
    empty: injuryDetail({}),
    nul: injuryDetail(null),
    near: returnLabel(iso(19)),
    far: returnLabel(iso(150)),
    junk: returnLabel("not-a-date"),
    none: returnLabel(""),
    // An ISO date is midnight UTC; built wrong it prints as the day before. The
    // invariant is the label naming the day the ISO string names — comparing
    // against today-plus-19 instead would fail on its own near local midnight,
    // when that instant and that date are different days.
    sameDay: (() => {
      const d = iso(19);
      return returnLabel(d).includes(String(Number(d.slice(8, 10))));
    })(),
    sameDayFor: iso(19),
  };
});
check("a body part and a severity read as one phrase", injRender.both === "Knee - ACL, surgery", injRender.both);
check("a severity that repeats the body part is said once", injRender.dupe === "Concussion", injRender.dupe);
check("either half stands alone", injRender.bpOnly === "Hamstring" && injRender.sevOnly === "Sprain");
check("nothing known prints nothing", injRender.empty === "" && injRender.nul === "");
check("a date weeks out is given as a date", /^back /.test(injRender.near), injRender.near);
check("a date months out is given as the season", injRender.far === "rest of season", injRender.far);
check("a return date is not shifted by the timezone", injRender.sameDay,
  `${injRender.sameDayFor} rendered as "${injRender.near}"`);
check("an absent or broken return date prints nothing", injRender.junk === "" && injRender.none === "");

const avail = await page.evaluate(() => {
  const D = window.__DFFL;
  const season = D.DB.seasons[0];
  const r0 = season.rosters[0];
  const st = (r0.starters || []).filter(p => p && p !== "0");
  const mk = pairs => {
    const m = new Map();
    for (const [pid, s] of pairs) m.set(pid, { s, n: "T " + s, p: "WR", t: "XX" });
    return { map: m, at: Date.now(), source: "test" };
  };
  const one = D.availability(season, mk([[st[0], "Out"]])).get(r0.roster_id);
  const two = D.availability(season, mk([[st[0], "Out"], [st[1], "Questionable"]])).get(r0.roster_id);
  const weird = D.availability(season, mk([[st[0], "Bananas"]])).get(r0.roster_id);
  const allOut = D.availability(season, mk(st.map(p => [p, "Out"]))).get(r0.roster_id);
  const none = D.availability(season, { map: new Map() });
  const n = st.length;
  // Derive the expectation from the shares the model actually used, not from an
  // assumed even split. Before a week is finished every starter weighs the same;
  // after one, weights come from what each has scored. The arithmetic under test
  // is the same either way, and hard-coding 1/n made this pass only in September.
  const shareOf = (row, pid) => (row.hurt.find(h => h.pid === pid) || {}).share;
  const s0 = shareOf(one, st[0]);
  const t0 = shareOf(two, st[0]), t1 = shareOf(two, st[1]);
  return {
    starters: n, basis: one.basis, finishedWeeks: (season.finalWeeks || new Set()).size,
    oneMult: one.mult, oneExpect: 1 - s0 * (1 - D.REPLACEMENT),
    twoMult: two.mult,
    twoExpect: 1 - (t0 * (1 - D.REPLACEMENT) + t1 * (1 - D.INJ_AVAIL.Questionable) * (1 - D.REPLACEMENT)),
    sharesSumToOne: Math.abs([...one.hurt, ...one.detail || []].length ? 0 : 0) === 0,
    weirdMult: weird.mult, weirdHurt: weird.hurt.length,
    allOutMult: allOut.mult, floor: D.INJ_FLOOR,
    everyoneHealthy: [...none.values()].every(x => x.mult === 1 && x.hurt.length === 0),
    othersUntouched: [...D.availability(season, mk([[st[0], "Out"]])).values()]
      .filter(x => x.rid !== r0.roster_id).every(x => x.mult === 1),
    ruledOut: ["Out", "IR", "PUP", "Sus", "NA", "DNR", "COV"].every(k => D.INJ_AVAIL[k] === 0),
    coinFlips: D.INJ_AVAIL.Doubtful === 0.25 && D.INJ_AVAIL.Questionable === 0.75,
  };
});
check("every designation that means 'not playing' is priced at zero", avail.ruledOut);
check("doubtful and questionable are the only partial ones", avail.coinFlips);
check("no injuries means every team at full strength", avail.everyoneHealthy);
check("one starter ruled out costs the replacement gap, not the player",
  near(avail.oneMult, avail.oneExpect, 1e-9), `${avail.oneMult} vs ${avail.oneExpect}`);
check("a questionable starter costs a quarter of that again",
  near(avail.twoMult, avail.twoExpect, 1e-9), `${avail.twoMult} vs ${avail.twoExpect}`);
check("an injury to one team does not touch another", avail.othersUntouched);
check("a status nobody has heard of is treated as healthy",
  avail.weirdMult === 1 && avail.weirdHurt === 0, `${avail.weirdMult}`);
check("the haircut cannot exceed the floor", avail.allOutMult >= avail.floor - 1e-12, `${avail.allOutMult}`);
check("starters are weighed by what they have scored once a week is in the book",
  avail.finishedWeeks > 0 ? avail.basis === "points" : avail.basis === "even",
  `${avail.finishedWeeks} finished week(s), basis ${avail.basis}`);

group("The line moves on results, slowly");

/* Every market on the Odds tab now prices off the live simulation, and the
 * board can be rewound to any finished week. Both were real gaps: division,
 * cellar and last-place prices used to read off the preseason line and never
 * moved, so a 0-2 team still carried its draft-day division price. */
const asOf = await page.evaluate(async () => {
  const F = window.__DFFL, M = window.__ODDS;
  const R = await F.raceData();
  const weeks = F.pricedWeeks();
  const host = document.querySelector("#liveHost");
  const sel = host && host.querySelector(".asofbar select");
  const boardTitles = () => [...host.querySelectorAll('[data-board="live"] .bt')]
    .map(e => e.textContent.trim());
  // The injury report is a plain .board, not a priced [data-board="live"] one,
  // so it has to be looked for across the whole host or it is never found —
  // which would make "it is gone" pass for the wrong reason.
  const hasInjuryBoard = () => [...host.querySelectorAll(".bt")]
    .some(e => /injury report/i.test(e.textContent));
  const nowTitles = boardTitles();

  // Rewinding must actually move the numbers, and must drop the two surfaces
  // that only make sense for "now".
  let rewound = null;
  if (sel && weeks.length) {
    const before = host.querySelector('[data-board="live"] .orow').innerText;
    sel.value = String(weeks[0]); sel.dispatchEvent(new Event("change"));
    const pastTitles = boardTitles();
    rewound = {
      note: !!host.querySelector(".rewound"),
      injuryBoardGone: !hasInjuryBoard(),
      sameBoardCount: pastTitles.length === nowTitles.length,
      strip: [...host.querySelectorAll(".livestrip > span")].map(s => s.innerText.replace(/\n/g, "=")),
    };
    sel.value = ""; sel.dispatchEvent(new Event("change"));
    rewound.restored = host.querySelector('[data-board="live"] .orow').innerText === before;
    rewound.injuryBoardBack = hasInjuryBoard();
  }

  // The model itself, independent of the DOM.
  const byWeek = weeks.map(w => {
    const b = F.boardAsOf(M, w, R);
    return b ? { w, decided: b.live.decided, through: b.live.throughWeek,
      top: Math.max(...b.lsim.divWin.map(x => x / b.lsim.sims)) } : { w, err: true };
  });

  return {
    weeks, hasSelector: !!sel,
    options: sel ? [...sel.options].map(o => o.value) : [],
    boardTitles: nowTitles,
    rewound, byWeek,
    labelTiles: [...host.querySelectorAll(".livestrip > span .k")]
      .map(k => getComputedStyle(k).borderTopWidth),
  };
});
check("the odds tab offers a week selector", asOf.hasSelector);
check("it lists Now plus every finished week",
  asOf.options.length === asOf.weeks.length + 1 && asOf.options[0] === "",
  asOf.options.join(","));
check("division, cellar and last-place boards are on the live board",
  ["— to win", "— to finish last", "To finish 12th"].every(t => asOf.boardTitles.some(b => b.includes(t))),
  asOf.boardTitles.length + " boards");
check("the championship and playoff boards are still there",
  ["To win the DFFL championship", "To make the playoffs"].every(t => asOf.boardTitles.some(b => b.includes(t))));
check("every finished week can be rewound to",
  asOf.byWeek.every(b => !b.err), asOf.byWeek.filter(b => b.err).map(b => b.w).join(","));
check("a rewound board counts only the games played by then",
  asOf.byWeek.every(b => b.err || b.through === b.w), JSON.stringify(asOf.byWeek.map(b => [b.w, b.decided])));
check("fewer games are banked the further back you go",
  asOf.byWeek.length < 2 || asOf.byWeek.every((b, i, a) => i === 0 || a[i - 1].decided >= b.decided),
  asOf.byWeek.map(b => b.decided).join(" >= "));
if (asOf.rewound) {
  check("a rewound board says so", asOf.rewound.note);
  check("it drops the injury board, which is today's not that week's", asOf.rewound.injuryBoardGone);
  check("it still renders every market", asOf.rewound.sameBoardCount);
  check("going back to Now restores the current prices", asOf.rewound.restored);
  check("and brings the injury board back", asOf.rewound.injuryBoardBack);
} else {
  check("a rewound board says so", true, "skipped: no finished week to rewind to");
}
check("the live strip labels are not boxed",
  asOf.labelTiles.every(w => w === "0px"), asOf.labelTiles.join(","));


/* The opening price on the live board. A price is a function of the whole
 * market, not of one runner: addVig normalises to the sum it is handed, so
 * pricing a single probability alone returns a 99.5% certainty every time. That
 * printed "opened -19900" against all twelve teams on both live boards. */
const openPrices = await page.evaluate(() => {
  const { priceMarket, priceBinary, addVig, americanOdds, roundOdds } = window.__DFFL;
  // Strictly decreasing on purpose: equal probabilities should price equally,
  // and the real board does carry ties, so a distinctness test needs distinct input.
  const field = [0.286, 0.202, 0.149, 0.092, 0.066, 0.063, 0.047, 0.037, 0.031, 0.030, 0.025, 0.018];
  // What the old code did, kept as the thing being guarded against.
  const alone = field.map(p => roundOdds(americanOdds(addVig([p])[0])));
  const asRace = priceMarket(field.map((p, i) => ({ i, p }))).map(r => r.price);
  const asBooks = priceBinary(field.map((p, i) => ({ i, p }))).map(r => r.price);
  const rows = [...document.querySelectorAll('[data-board="live"] .orow .was')]
    .map(e => (e.textContent.match(/opened\s*([+-]?\d+)/) || [])[1]).filter(Boolean);
  return {
    aloneDistinct: new Set(alone).size, aloneFirst: alone[0],
    raceDistinct: new Set(asRace).size, raceFirst: asRace[0], raceLast: asRace[asRace.length - 1],
    booksDistinct: new Set(asBooks).size,
    domCount: rows.length, domDistinct: new Set(rows).size,
    domHasSentinel: rows.includes("-19900"),
    domSample: rows.slice(0, 4),
  };
});
check("pricing one runner alone collapses every price to the same certainty",
  openPrices.aloneDistinct === 1 && String(openPrices.aloneFirst) === "-19900",
  `${openPrices.aloneDistinct} distinct, first ${openPrices.aloneFirst}`);
check("priced as a race, distinct openings give distinct prices",
  openPrices.raceDistinct === 12, `${openPrices.raceDistinct} distinct`);
check("the favourite opens shorter than the longshot",
  openPrices.raceFirst < openPrices.raceLast, `${openPrices.raceFirst} vs ${openPrices.raceLast}`);
check("priced as yes/no books, distinct openings stay distinct",
  openPrices.booksDistinct === 12, `${openPrices.booksDistinct} distinct`);
check("the live board prints an opening price per row",
  openPrices.domCount === 0 || openPrices.domCount >= 12, `${openPrices.domCount} rows`);
check("no board opens every team at the same price",
  openPrices.domCount === 0 || openPrices.domDistinct > 1,
  `${openPrices.domDistinct} distinct of ${openPrices.domCount}: ${openPrices.domSample.join(", ")}`);
check("no opening price is the one-runner sentinel",
  !openPrices.domHasSentinel, openPrices.domSample.join(", "));

const post = await page.evaluate(() => {
  const D = window.__DFFL, model = window.__ODDS;
  const t = model.teams[0];
  const games = (pts, weeks) => Array.from({ length: weeks }, (_, i) => ({
    season: "2026", week: i + 1, playoff: false,
    a: { rid: t.rid, uid: t.uid, pts }, b: { rid: -1, uid: null, pts: 0 },
  }));
  const at = n => D.livePosterior(model, { games: games(t.mean + 60, n) })[0];
  const zero = D.livePosterior(model, { games: [] });
  const one = at(1), three = at(3), six = at(6);
  const below = D.livePosterior(model, { games: games(t.mean - 60, 4) })[0];
  return {
    untouched: Math.max(...zero.map(x => Math.abs(x.moved))), zeroN: zero[0].n,
    between: one.mean > t.mean && one.mean < t.mean + 60,
    monotone: one.moved < three.moved && three.moved < six.moved,
    tightens: six.levelSd < three.levelSd && three.levelSd < one.levelSd && one.levelSd < model.seasonSd,
    symmetric: Math.abs(below.moved + D.livePosterior(model, { games: games(t.mean + 60, 4) })[0].moved) < 1e-9,
    oneWeekSmall: Math.abs(one.moved) < 6,
    priorKept: Math.abs(one.priorMean - t.mean) < 1e-12,
  };
});
check("no finished week means the opening line stands", post.untouched === 0 && post.zeroN === 0);
check("the posterior lands between the projection and what was scored", post.between);
check("more evidence moves it further", post.monotone);
check("and tightens it, always inside the draft-day spread", post.tightens);
check("a cold start moves it exactly as far as a hot one, the other way", post.symmetric);
check("one big week barely moves the line", post.oneWeekSmall);
check("the draft-day projection is kept alongside it", post.priorKept);

group("The live board prices the season being played");

const lsim = await page.evaluate(() => {
  const D = window.__DFFL, model = window.__ODDS, sim = window.__SIM;
  const season = D.DB.seasons[0];
  const rids = model.teams.map(t => t.rid);
  const decided = [], upcoming = [];
  for (let w = 1; w <= 7; w++) for (let k = 0; k < rids.length; k += 2) {
    decided.push({ season: season.season, week: w, playoff: false,
      a: { rid: rids[k], uid: null, pts: 130 }, b: { rid: rids[k + 1], uid: null, pts: 90 } });
  }
  for (let w = 8; w <= 14; w++) for (let k = 0; k < rids.length; k += 2) {
    upcoming.push({ week: w, a: rids[k], b: rids[k + 1] });
  }
  const R = { season, ready: true, decided, upcoming, nextWeek: 8, lastReg: 14 };
  const avail = D.availability(season, { map: new Map() });
  const empty = D.liveState(model, season,
    { season, ready: true, decided: [], upcoming, nextWeek: 1, lastReg: 14 }, avail);
  const live = D.liveState(model, season, R, avail);
  const L = D.simulateSeason(model, 4000, live);
  const n = L.sims;
  const winners = rids.map((_, i) => i).filter(i => i % 2 === 0);
  const losers = rids.map((_, i) => i).filter(i => i % 2 === 1);
  const idx = new Map(rids.map((r, i) => [r, i]));
  const wk = D.weeksOf(upcoming, idx);
  const again = D.simulateSeason(model, sim.sims);
  return {
    emptyIsNull: empty === null,
    weeks: live.weeks.length, adjWeek: live.adjWeek,
    decided: live.decided, remaining: live.remaining,
    w0: live.W0.every((w, i) => w === (i % 2 === 0 ? 7 : 0)),
    grouped: wk.length === 7 && wk[0].week === 8 && wk.every(x => x.pairs.length === 6)
      && wk.every((x, i) => i === 0 || x.week > wk[i - 1].week),
    title: L.title.reduce((a, b) => a + b, 0) / n,
    playoff: L.playoff.reduce((a, b) => a + b, 0) / n,
    last: L.last.reduce((a, b) => a + b, 0) / n,
    bye: L.bye.reduce((a, b) => a + b, 0) / n,
    divWin: L.divWin.reduce((a, b) => a + b, 0) / n,
    winnersIn: winners.reduce((a, i) => a + L.playoff[i], 0) / n / winners.length,
    losersIn: losers.reduce((a, i) => a + L.playoff[i], 0) / n / losers.length,
    minWins: Math.min(...L.wins.map(w => w / n)),
    maxWins: Math.max(...L.wins.map(w => w / n)),
    distOk: L.winDist.every(d => d.length === model.weeks + 1
      && d.reduce((a, b) => a + b, 0) === n && d.every(v => v >= 0)),
    flagged: L.live === true,
    preseasonUntouched: again.title.every((v, i) => v === sim.title[i])
      && again.playoff.every((v, i) => v === sim.playoff[i]),
  };
});
check("nothing decided means no live board", lsim.emptyIsNull);
check("the remaining schedule groups into its real weeks", lsim.grouped);
check("injuries are charged to the next week and no other", lsim.adjWeek === 8, `${lsim.adjWeek}`);
check("the banked record is carried in exactly", lsim.w0, "7-0 / 0-7 split not preserved");
check("42 games banked, 42 left", lsim.decided === 42 && lsim.remaining === 42, `${lsim.decided}/${lsim.remaining}`);
check("exactly one champion per simulated season", near(lsim.title, 1, 1e-9), `${lsim.title}`);
check("exactly six playoff teams", near(lsim.playoff, 6, 1e-9), `${lsim.playoff}`);
check("exactly three division winners", near(lsim.divWin, 3, 1e-9), `${lsim.divWin}`);
check("exactly two byes", near(lsim.bye, 2, 1e-9), `${lsim.bye}`);
check("exactly one team finishes twelfth", near(lsim.last, 1, 1e-9), `${lsim.last}`);
check("teams that won every game are nearly certain to make it", lsim.winnersIn > 0.95, `${lsim.winnersIn}`);
check("teams that lost every game are nearly certain not to", lsim.losersIn < 0.05, `${lsim.losersIn}`);
check("nobody projects fewer wins than they have banked", lsim.minWins >= 7 - 4.5 && lsim.maxWins <= 14, `${lsim.minWins}-${lsim.maxWins}`);
check("the win distribution is well formed", lsim.distOk);
check("the live board says it is live", lsim.flagged);
check("and none of it disturbs the opening line", lsim.preseasonUntouched);

/* ------------------------------------------------------------------------
 * A week in flight: the odds move with it, and nothing else does. This is the
 * whole contract — a probability may change on a Sunday afternoon, a result
 * may not.
 * ---------------------------------------------------------------------- */
group("A week in flight is priced, not decided");

const gs = await page.evaluate(async () => {
  const D = window.__DFFL;
  const g = await D.loadNflGames(true);
  const counts = { pre: 0, in: 0, post: 0 };
  for (const v of g.byTeam.values()) {
    if (v.state === "pre_game") counts.pre++;
    else if (v.state === "complete") counts.post++;
    else counts.in++;
  }
  return {
    ok: g.ok, source: g.source, clubs: g.byTeam.size,
    pre: g.pre, live: g.live, post: g.post, counts,
    rem: {
      pre: D.gameRemaining("pre_game"),
      live: D.gameRemaining("in_game"),
      done: D.gameRemaining("complete"),
      junk: D.gameRemaining("who knows"),
      missing: D.gameRemaining(undefined),
    },
    // the site's own club spellings must all resolve, or a lineup silently
    // reads as "nothing left to play"
    unresolved: (() => {
      const R = window.__DFFL.ROSTERED_TEST || null;
      return null;
    })(),
  };
});
check("the NFL schedule loads from Sleeper", gs.ok && gs.source === "sleeper", gs.source);
check("every club has a game state", gs.clubs === 32, `${gs.clubs}`);
check("the three states account for every club", gs.counts.pre + gs.counts.in + gs.counts.post === gs.clubs);
check("games total the week's fixtures", (gs.pre + gs.live + gs.post) === 16, `${gs.pre}/${gs.live}/${gs.post}`);
check("a game not started has all of itself left", gs.rem.pre === 1);
check("a game under way counts as half played", gs.rem.live === 0.5);
check("a finished game has nothing left", gs.rem.done === 0);
check("an unknown or missing state yields nothing rather than guessing",
  gs.rem.junk === 0 && gs.rem.missing === 0);

const clubs = await page.evaluate(async () => {
  const D = window.__DFFL;
  const r = await D.loadRostered();
  const g = await D.loadNflGames();
  const teams = [...new Set([...r.map.values()].map(x => x.t).filter(Boolean))];
  return {
    source: r.source, players: r.map.size, slots: r.slots,
    unresolved: teams.filter(t => t !== "FA" && !g.byTeam.has(t)),
  };
});
check("rosters.json is published and read", clubs.source === "file" && clubs.players > 100, `${clubs.source}/${clubs.players}`);
check("the lineup slots are known", clubs.slots.length === 10 && clubs.slots[0] === "QB" && clubs.slots[9] === "DEF", clubs.slots.join(","));
check("every club on a DFFL roster resolves against the schedule",
  clubs.unresolved.length === 0, `unmatched: ${clubs.unresolved.join(",")}`);

const lin = await page.evaluate(async () => {
  const D = window.__DFFL;
  const shares = D.slotShares();
  const games = { byTeam: new Map([["AAA", { rem: 1, state: "pre_game" }], ["BBB", { rem: 0, state: "complete" }], ["CCC", { rem: 0.5, state: "in_game" }]]) };
  const rostered = { map: new Map([
    ["p1", { n: "All To Play", p: "QB", t: "AAA" }],
    ["p2", { n: "Finished",    p: "RB", t: "BBB" }],
    ["p3", { n: "Mid Game",    p: "WR", t: "CCC" }],
    ["p4", { n: "On A Bye",    p: "TE", t: "ZZZ" }],
  ]) };
  const mu = 100, sd = 30;
  const even = [0.25, 0.25, 0.25, 0.25];
  const allDone = D.lineupState(["p2", "p2", "p2", "p2"], 90, mu, sd, rostered, games, even);
  const allLeft = D.lineupState(["p1", "p1", "p1", "p1"], 0, mu, sd, rostered, games, even);
  const mixed = D.lineupState(["p1", "p2", "p3", "p4"], 45, mu, sd, rostered, games, even);
  const bye = D.lineupState(["p4", "p4", "p4", "p4"], 12, mu, sd, rostered, games, even);
  const p = (a, b) => D.liveWinProb(a, b);
  return {
    done: { frac: allDone.frac, sd: allDone.sd, exp: allDone.expected, counts: [allDone.done, allDone.inPlay, allDone.toPlay] },
    left: { frac: allLeft.frac, sd: +allLeft.sd.toFixed(6), exp: allLeft.expected },
    mixed: { frac: mixed.frac, exp: mixed.expected, counts: [mixed.done, mixed.inPlay, mixed.toPlay] },
    bye: { frac: bye.frac, exp: bye.expected },
    settledWin: p(allDone, D.lineupState(["p2","p2","p2","p2"], 80, mu, sd, rostered, games, even)),
    settledLoss: p(D.lineupState(["p2","p2","p2","p2"], 80, mu, sd, rostered, games, even), allDone),
    deadHeat: p(allLeft, allLeft),
    // trailing by 35 with the whole lineup left beats leading by 35 with none of it
    comeback: p(D.lineupState(["p1","p1","p1","p1"], 0, mu, sd, rostered, games, even),
                D.lineupState(["p2","p2","p2","p2"], 35, mu, sd, rostered, games, even)),
    shares: shares && { n: shares.length, sum: +shares.reduce((a, b) => a + b, 0).toFixed(9),
      qbOverK: shares[0] > shares[8], allPositive: shares.every(x => x > 0) },
  };
});
check("a lineup that has finished has nothing left and no spread",
  lin.done.frac === 0 && lin.done.sd === 0 && lin.done.exp === 90);
check("a lineup that has not started expects its whole week",
  lin.left.frac === 1 && lin.left.exp === 100 && lin.left.sd === 30);
check("a half-played game counts half", lin.mixed.frac === 0.375, `${lin.mixed.frac}`);
check("played, playing and still to come are counted separately",
  JSON.stringify(lin.mixed.counts) === JSON.stringify([2, 1, 1]), JSON.stringify(lin.mixed.counts));
check("a club with no game this week brings nothing", lin.bye.frac === 0 && lin.bye.exp === 12);
check("a finished matchup is a certainty, both ways", lin.settledWin === 1 && lin.settledLoss === 0);
check("two identical lineups are a coin flip", Math.abs(lin.deadHeat - 0.5) < 1e-9, `${lin.deadHeat}`);
check("a whole lineup still to play beats a 35-point lead with none left",
  lin.comeback > 0.5 && lin.comeback < 1, `${lin.comeback}`);
check("lineup slot shares come off this league's own history",
  lin.shares && Math.abs(lin.shares.sum - 1) < 1e-9 && lin.shares.n === 10, JSON.stringify(lin.shares));
check("a quarterback is worth more of the lineup than a kicker", lin.shares.qbOverK);
check("no slot is worth nothing", lin.shares.allPositive);

const board = await page.evaluate(() => {
  const B = window.__BOARD, L = window.__LIVE, S = window.__LSIM, P = window.__SIM;
  if (!B) return { none: true };
  return {
    none: false, ok: B.ok, week: B.week, n: B.games.length, at: B.at,
    bounded: B.games.every(g => g.pA >= 0 && g.pA <= 1 && g.pB >= 0 && g.pB <= 1),
    complements: B.games.every(g => Math.abs(g.pA + g.pB - 1) < 1e-9),
    ordered: B.games.every((g, i) => i === 0
      || Math.abs(0.5 - g.pA) >= Math.abs(0.5 - B.games[i - 1].pA) - 1e-9),
    live: L && { pending: L.pending.length, weeks: L.weeks.length, liveWeek: L.liveWeek, remaining: L.remaining },
    full: L ? L.pending.length + L.remaining : null,
    titleSum: S ? S.title.reduce((a, b) => a + b, 0) / S.sims : null,
    playoffSum: S ? S.playoff.reduce((a, b) => a + b, 0) / S.sims : null,
    moved: (S && P) ? Math.max(...S.title.map((v, i) => Math.abs(v / S.sims - P.title[i] / P.sims))) : null,
  };
});
if (board.none || !board.ok) {
  check("no week in flight, so no live board", true);
} else {
  check("every matchup in the live week is priced", board.n === 6, `${board.n}`);
  check("probabilities are probabilities", board.bounded);
  check("the two sides of a matchup sum to one", board.complements);
  check("the board leads with the closest game", board.ordered);
  check("the board is stamped with when it was worked out", board.at > 0);
  check("the week in flight is pending, not upcoming",
    board.live.pending === 6 && board.live.liveWeek === board.week, JSON.stringify(board.live));
  check("the rest of the season is still simulated",
    board.live.weeks === 13 && board.full === 84, `${board.live.weeks} weeks / ${board.full} games`);
  check("the season still resolves to one champion", Math.abs(board.titleSum - 1) < 1e-9, `${board.titleSum}`);
  check("and six playoff teams", Math.abs(board.playoffSum - 6) < 1e-9, `${board.playoffSum}`);
  check("one week in flight moves the title market, but not wildly",
    board.moved > 0 && board.moved < 0.25, `biggest move ${board.moved}`);
}

const sealed = await page.evaluate(() => {
  const D = window.__DFFL;
  const season = D.DB.seasons[0];
  const live = season.live || [];
  const PR = D.allPowerRankings().get(season.season) || null;
  const at = window.__AT;
  return {
    liveGames: live.length,
    // the live week must appear in no record, no ranking and no standing
    inRecord: D.DB.games.some(g => g.season === season.season && g.week === season.liveWeek),
    inSeasonGames: season.games.some(g => g.week === season.liveWeek),
    powerBoards: PR ? PR.boards.map(b => b.week) : [],
    powerHasLive: PR ? PR.boards.some(b => b.week === season.liveWeek) : false,
    winsBalance: at.reduce((a, r) => a + r.w, 0) === at.reduce((a, r) => a + r.l, 0),
    seasonRecords: at.reduce((a, r) => a + r.w + r.l, 0),
  };
});
// Between Tuesday and Thursday there is no week in flight, and that is a normal
// state rather than a hole in the guard. The invariant is the same either way:
// whatever is live is in no record. It just has nothing to bite on some days.
if (sealed.liveGames === 0) {
  check("no week in flight right now, so nothing to guard against",
    sealed.inRecord === false && sealed.powerHasLive === false, "and nothing leaked anyway");
} else {
  check("there is a week in flight to guard against", sealed.liveGames === 6, `${sealed.liveGames}`);
  check("it is in no record", sealed.inRecord === false);
  check("it is in no season's game log", sealed.inSeasonGames === false);
  check("it is in no power ranking", sealed.powerHasLive === false, sealed.powerBoards.join(","));
}
check("wins and losses still balance league-wide", sealed.winsBalance);

/* ------------------------------------------------------------------------
 * The injury plan: one set of cuts, shared by the futures, the game lines and
 * the live win chances. Everything here runs on a synthetic two-team league
 * and a fixed clock, so it means the same thing in September and December.
 * ---------------------------------------------------------------------- */
group("Injuries are charged for as long as they last");

const injPlan = await page.evaluate(() => {
  const D = window.__DFFL;
  // Friday 2 October 2026, noon local: the coming Sunday is 4 October.
  const now = new Date(2026, 9, 2, 12, 0, 0);
  const iso = days => {
    const x = new Date(now.getTime() + days * 86400000);
    return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
  };
  const model = { ok: true, weekSd: 30, seasonSd: 15, teams: [{ rid: 1, mean: 100 }, { rid: 2, mean: 100 }] };
  const four = ["a1", "a2", "a3", "a4"], ten = Array.from({ length: 10 }, (_, i) => "a" + (i + 1));
  const other = ["b1", "b2", "b3", "b4"];
  // done: finished weeks; pts: pid -> points per finished week (default 20).
  const mkSeason = (st, done = [], pts = {}) => {
    const playerWeek = new Map();
    done.forEach((w, i) => {
      const wm = new Map();
      for (const pid of [...st, ...other]) wm.set(pid, pid in pts ? pts[pid][i] : 20);
      playerWeek.set(w, wm);
    });
    return {
      pws: 15, liveWeek: null,
      rosters: [{ roster_id: 1, starters: st }, { roster_id: 2, starters: other }],
      finalWeeks: new Set(done), playerWeek,
      games: done.map(w => ({ week: w, playoff: false, a: { rid: 1, pts: 100 }, b: { rid: 2, pts: 100 } })),
    };
  };
  const inj = rows => ({ map: new Map(Object.entries(rows)), at: now.getTime(), source: "test" });
  const P = (season, rows) => D.injuryPlan(season, inj(rows), model, { now });
  const H = (plan, pid) => plan.teams.get(1).hurt.find(h => h.pid === pid);
  const gap = 1 - D.REPLACEMENT;

  // 1. One starter out, no return date: next week only.
  const p1 = P(mkSeason(four), { a1: { s: "Out", n: "De'Von Achane" } });
  const h1 = H(p1, "a1");
  // 2. Back in ten days: Sunday 4 Oct and Sunday 11 Oct kick off before 12 Oct.
  const p2 = P(mkSeason(four), { a1: { s: "Out", n: "X", ret: iso(10) } });
  const p2b = P(mkSeason(four), { a1: { s: "IR", n: "X", ret: iso(1) } });
  const pNoRet = P(mkSeason(four), { a1: { s: "IR", n: "X" } });
  const pQ = P(mkSeason(four), { a1: { s: "Questionable", n: "X", ret: iso(30) } });
  // 3. Season-ending: ESPN dates it to next February.
  const p3 = P(mkSeason(four), { a1: { s: "IR", n: "X", ret: "2027-02-15" } });
  const h3 = H(p3, "a1");
  // 4. Out for the last two of three finished weeks, against one who played them all.
  const s4 = mkSeason(four, [1, 2, 3], { a1: [20, 0, 0] });
  const p4 = P(s4, { a1: { s: "Out", n: "X" } });
  const h4 = H(p4, "a1");
  const p4h = P(mkSeason(four, [1, 2, 3]), { a1: { s: "Out", n: "X" } });
  const h4h = H(p4h, "a1");
  const pp = 1 / (15 * 15), op = 1 / (30 * 30);
  // 5. The whole lineup out.
  const p5 = P(mkSeason(four), Object.fromEntries(four.map(p => [p, { s: "Out", n: p }])));

  // 7. The label, on a ten-man lineup so each starter is a tenth of it.
  const lab = D.injuryLabel(P(mkSeason(ten), {
    a1: { s: "Out", n: "De'Von Achane" }, a2: { s: "IR", n: "Breece Hall" } }), 1, 1);
  const labMix = D.injuryLabel(P(mkSeason(ten), {
    a1: { s: "Out", n: "De'Von Achane" }, a2: { s: "Doubtful", n: "Jaylen Smith Jr." } }), 1, 1);
  const labQ = D.injuryLabel(P(mkSeason(ten), { a1: { s: "Questionable", n: "Travis Kelce" } }), 1, 1);
  const T = window.__ODDS.teams;
  const line = D.gameLine({ expected: 100 * (1 - lab.cut), sd: 30 }, { expected: 95, sd: 30 });
  const html = D.gameCardHTML({
    a: { rid: 1, uid: T[0].uid, pts: 0, inj: lab }, b: { rid: 2, uid: T[1].uid, pts: 0, inj: null },
    aPts: 0, bPts: 0, open: line, now: line, settled: false, started: false, path: [], cover: null,
  });
  const div = document.createElement("div");
  div.innerHTML = html;
  const tags = [...div.querySelectorAll('[data-card="gameline"] .inj-tag')];

  // 6. In-game: a ruled-out starter whose game has not started.
  const rostered = { map: new Map(["q1", "q2", "q3", "q4"].map(p => [p, { n: p, p: "WR", t: "AAA" }])) };
  const pre = { byTeam: new Map([["AAA", { rem: 1, state: "pre_game" }]]) };
  const fin = { byTeam: new Map([["AAA", { rem: 0, state: "complete" }]]) };
  const even = [0.25, 0.25, 0.25, 0.25], lu = ["q1", "q2", "q3", "q4"];
  const L = (games, pts, hurt) => D.lineupState(lu, pts, 100, 30, rostered, games, even, hurt);
  // hurt maps carry each starter's cut in team terms: share × (1 − avail) × 0.45 × scale.
  const cutOut = 0.25 * 1 * gap, cutQ = 0.25 * (1 - D.INJ_AVAIL.Questionable) * gap;
  const healthy = L(pre, 0), outL = L(pre, 0, new Map([["q1", cutOut]]));
  const qL = L(pre, 0, new Map([["q1", cutQ]]));
  const allOutL = L(pre, 0, new Map(lu.map(p => [p, cutOut])));
  const playedL = L(fin, 50, new Map([["q1", cutOut]]));

  // 9. Kickoff equals the opener: the shrunk injury from case 4, fed through the
  // same helper the live board uses, with the whole lineup still to play.
  const rost4 = { map: new Map(four.map(p => [p, { n: p, p: "RB", t: "AAA" }])) };
  const hm4 = D.injuryHurtMap(p4, 1, p4.W0);
  const kick4 = D.lineupState(four, 0, 100, 30, rost4, pre, even, hm4);
  const kickoff = { live: kick4.expected, opener: 100 * D.injuryMult(p4, 1, p4.W0), scale: h4.scale,
    raw: 100 * (1 - h4.loss) };

  // 10. The bracket: a synthetic live state off the real model, healthy vs a
  // season-ending cut on one team (regular season and playoffs) vs the same cut
  // stopping at the regular season.
  const M = window.__ODDS;
  const nT = M.teams.length, zeros = () => new Array(nT).fill(0);
  const baseLive = () => ({
    teams: M.teams.map(t => ({ ...t, levelSd: 8 })), W0: zeros(), PF0: zeros(), pending: [],
    weeks: M.sched.map((pairs, i) => ({ week: i + 1, pairs })), pws: M.sched.length + 1,
  });
  const favIdx = M.teams.reduce((b, t, i) => (t.mean > M.teams[b].mean ? i : b), 0);
  const cutArr = () => M.teams.map((_, i) => (i === favIdx ? 0.85 : 1));
  const regOnly = new Map(M.sched.map((_, i) => [i + 1, cutArr()]));
  const withPO = new Map(regOnly);
  for (let r = 0; r < 3; r++) withPO.set(M.sched.length + 1 + r, cutArr());
  const run = mbw => {
    const sim = D.simulateSeason(M, 20000, { ...baseLive(), multByWeek: mbw });
    return { title: sim.title[favIdx] / sim.sims, playoff: sim.playoff[favIdx] / sim.sims };
  };
  const bracket = { healthy: run(new Map()), reg: run(regOnly), full: run(withPO) };
  const s10 = mkSeason(four, [1, 2, 3]);
  const p10 = P(s10, { a1: { s: "IR", n: "X", ret: "2027-02-15" } });
  bracket.planWeeks = H(p10, "a1").weeks; bracket.lastWeek = p10.lastWeek;

  // 8. A week in flight: a1 scored in it before getting hurt, a2 has not played yet.
  const s8 = mkSeason(four, [1, 2, 3]);
  s8.liveWeek = 4;
  s8.playerWeek.set(4, new Map([["a1", 3.5], ["a2", 0], ["a3", 11], ["a4", 0]]));
  // Monday 5 October: week 4's Sunday was yesterday, so a date of Sunday 11 Oct
  // is after week 4 kicked off but not after week 5 — he misses week 4 only.
  const mon = new Date(2026, 9, 5, 20, 0, 0);
  const p8 = D.injuryPlan(s8, inj({ a1: { s: "Out", n: "X" }, a2: { s: "Out", n: "Y", ret: "2026-10-11" } }), model, { now: mon });
  const flight = { W0: p8.W0, a1: H(p8, "a1").weeks, a2: H(p8, "a2").weeks };

  return {
    gap, floor: D.INJ_FLOOR, flight, kickoff, bracket,
    one: { W0: p1.W0, weeks: h1.weeks, share: h1.share, scale: h1.scale,
      m1: D.injuryMult(p1, 1, 1), m2: D.injuryMult(p1, 1, 2), other: D.injuryMult(p1, 2, 1),
      excluded: D.injuryMult(p1, 1, 1, ["a1"]), note: D.injuryFuturesNote(p1, 1, 1) },
    ret: { weeks: H(p2, "a1").weeks, m1: D.injuryMult(p2, 1, 1), m2: D.injuryMult(p2, 1, 2),
      m3: D.injuryMult(p2, 1, 3), note: D.injuryFuturesNote(p2, 1, 1),
      tomorrow: H(p2b, "a1").weeks, noRet: H(pNoRet, "a1").weeks, questionable: H(pQ, "a1").weeks },
    end: { weeks: h3.weeks, lastReg: p3.lastReg, seasonEnding: h3.seasonEnding,
      lastWeek: p3.lastWeek, mLast: D.injuryMult(p3, 1, p3.lastWeek), mPost: D.injuryMult(p3, 1, p3.lastWeek + 1),
      note: D.injuryFuturesNote(p3, 1, 1) },
    shrink: { W0: p4.W0, onset: h4.onset, missed: h4.missed, scale: h4.scale, loss: h4.loss,
      cut: 1 - D.injuryMult(p4, 1, p4.W0), expect: 1 - (2 * op) / (pp + 3 * op),
      healthyMissed: h4h.missed, healthyScale: h4h.scale, healthyLoss: h4h.loss,
      healthyCut: 1 - D.injuryMult(p4h, 1, p4h.W0) },
    floorMult: D.injuryMult(p5, 1, 1), floorRaw: 1 - four.length * 0.25 * gap,
    live: { healthy: healthy.expected, out: outL.expected, q: qL.expected, allOut: allOutL.expected,
      sdSame: healthy.sd === outL.sd, played: playedL.expected, playedHealthy: L(fin, 50).expected,
      hurtLeft: outL.hurtLeft, injCut: outL.injCut },
    label: { text: lab && lab.text, cut: lab && lab.cut, names: lab && lab.names,
      mix: labMix && labMix.text, q: labQ && labQ.text,
      small: (D.injuryLabelText(0.0072, [{ name: "Kelce", status: "Questionable" }]) || {}).text,
      tiny: D.injuryLabelText(0.004, [{ name: "Kelce", status: "Questionable" }]),
      suffix: D.lastNameOf("Kenneth Walker III") },
    card: { tags: tags.length, text: tags[0] && tags[0].textContent.trim(),
      rid: tags[0] && tags[0].dataset.inj },
  };
});
const IP = injPlan;
check("an Out starter cuts his team by share × 0.45 in the next week",
  IP.one.W0 === 1 && near(IP.one.m1, 1 - IP.one.share * IP.gap, 1e-12) && near(1 - IP.one.m1, 0.25 * 0.45, 1e-12),
  `${IP.one.m1} (share ${IP.one.share})`);
check("with no return date, the week after is uncut and the other team untouched",
  IP.one.m2 === 1 && IP.one.other === 1 && JSON.stringify(IP.one.weeks) === "[1]", JSON.stringify(IP.one));
check("a starter who has already played this week is not charged", IP.one.excluded === 1);
check("a starter hurt in the game in flight is charged from next week, one still to play from this week",
  IP.flight.W0 === 4 && JSON.stringify(IP.flight.a1) === "[5]" && JSON.stringify(IP.flight.a2) === "[4]",
  JSON.stringify(IP.flight));
check("a return date 10 days out charges the two weeks that kick off before it",
  JSON.stringify(IP.ret.weeks) === "[1,2]" && IP.ret.m1 < 1 && IP.ret.m2 < 1, JSON.stringify(IP.ret.weeks));
check("and not the week after it expires", IP.ret.m3 === 1, `${IP.ret.m3}`);
check("a return date is always charged at least the next week", JSON.stringify(IP.ret.tomorrow) === "[1]",
  JSON.stringify(IP.ret.tomorrow));
check("no return date, or a questionable tag, is next week only",
  JSON.stringify(IP.ret.noRet) === "[1]" && JSON.stringify(IP.ret.questionable) === "[1]",
  `${JSON.stringify(IP.ret.noRet)} / ${JSON.stringify(IP.ret.questionable)}`);
check("a season-ending date carries the cut through the championship week",
  IP.end.seasonEnding && IP.end.lastWeek === IP.end.lastReg + 3 && IP.end.weeks.length === IP.end.lastWeek
    && IP.end.weeks[IP.end.weeks.length - 1] === IP.end.lastWeek
    && IP.end.mLast < 1 && IP.end.mPost === 1, `${IP.end.weeks.length} weeks, last ${IP.end.mLast}`);
check("at kickoff, a shrunk injury gives the live board the pregame line's expected score",
  IP.kickoff.scale < 1 && near(IP.kickoff.live, IP.kickoff.opener, 1e-9) && IP.kickoff.live > IP.kickoff.raw,
  JSON.stringify(IP.kickoff));
check("a season-ending injury cuts the bracket: title odds fall more than playoff odds",
  (IP.bracket.healthy.title - IP.bracket.full.title) / IP.bracket.healthy.title
    > (IP.bracket.healthy.playoff - IP.bracket.full.playoff) / IP.bracket.healthy.playoff
    && IP.bracket.full.title < IP.bracket.reg.title && IP.bracket.full.playoff === IP.bracket.reg.playoff,
  JSON.stringify(IP.bracket));
check("the plan runs a season-ending injury through the playoff weeks",
  IP.bracket.planWeeks[IP.bracket.planWeeks.length - 1] === IP.bracket.lastWeek, JSON.stringify(IP.bracket.planWeeks));
check("the futures note says how long",
  /next week \(Achane out\)$/.test(IP.one.note) && /for 2 weeks/.test(IP.ret.note) && /rest of season/.test(IP.end.note),
  `${IP.one.note} | ${IP.ret.note} | ${IP.end.note}`);
check("weeks already missed are counted from the first finished week he did not score",
  IP.shrink.W0 === 4 && IP.shrink.onset === 2 && IP.shrink.missed === 2, JSON.stringify(IP.shrink));
check("the cut shrinks by the share of the average built without him",
  IP.shrink.scale < 1 && near(IP.shrink.scale, IP.shrink.expect, 1e-12)
    && near(IP.shrink.cut, IP.shrink.loss * IP.shrink.scale, 1e-12) && IP.shrink.cut < IP.shrink.loss,
  `scale ${IP.shrink.scale} vs ${IP.shrink.expect}`);
check("with no weeks missed the cut is not shrunk",
  IP.shrink.healthyMissed === 0 && IP.shrink.healthyScale === 1 && near(IP.shrink.healthyCut, IP.shrink.healthyLoss, 1e-12),
  JSON.stringify(IP.shrink));
check("the 0.80 floor holds with the whole lineup out",
  IP.floorRaw < IP.floor && IP.floorMult === IP.floor, `${IP.floorMult}`);
check("in-game, an Out starter still to play is 55% of his slot",
  near(IP.live.healthy - IP.live.out, 100 * 0.25 * IP.gap, 1e-9) && IP.live.sdSame
    && JSON.stringify(IP.live.hurtLeft) === '["q1"]', `${IP.live.healthy} → ${IP.live.out}`);
check("a questionable one keeps his availability weight",
  near(IP.live.healthy - IP.live.q, 100 * 0.25 * (1 - 0.75) * IP.gap, 1e-9), `${IP.live.q}`);
check("the in-game cut respects the floor", near(IP.live.allOut, 100 * IP.floor, 1e-9), `${IP.live.allOut}`);
check("once his game is over, the injury changes nothing", IP.live.played === IP.live.playedHealthy && IP.live.played === 50);
check("the label reads like a book's",
  IP.label.text === "Injuries: −9% (Achane, Hall out)", IP.label.text);
check("statuses are grouped and suffixes dropped",
  IP.label.mix === "Injuries: −8% (Achane out, Smith doubtful)" && IP.label.q === "Injuries: −1% (Kelce questionable)"
    && IP.label.suffix === "Walker", `${IP.label.mix} | ${IP.label.q} | ${IP.label.suffix}`);
check("under 1% gets a decimal, under half a percent gets nothing",
  IP.label.small === "Injuries: −0.7% (Kelce questionable)" && IP.label.tiny === null, `${IP.label.small}`);
check("a game-line card with a label carries an .inj-tag",
  IP.card.tags === 1 && IP.card.text === IP.label.text && IP.card.rid === "1", JSON.stringify(IP.card));

group("The front page leads with this season");

const home = await page.evaluate(() => {
  const panel = document.querySelector('[data-panel="home"]');
  const week = document.querySelector("#homeWeek");
  const champ = panel.querySelector(".champbar");
  const heads = [...week.querySelectorAll("h2")].map(h => h.textContent.trim());
  const pos = n => [...panel.children].indexOf(n.closest('[data-panel="home"] > *') || n);
  return {
    present: !!week,
    filled: document.body.dataset.homeWeek || null,
    skeletonGone: !week.querySelector(".wskel"),
    heads,
    games: week.querySelectorAll(".wgame").length,
    sides: week.querySelectorAll(".wgame .ws").length,
    aboveChampion: champ ? pos(week) < pos(champ) : true,
    hasChampion: !!champ,
    injuryChips: week.querySelectorAll(".ichip").length,
    teasers: week.querySelectorAll(".teaser").length,
    // a live week must not colour anybody as the winner, here either
    verdicts: week.querySelectorAll(".ws.win, .ws.lose").length,
    leads: week.querySelectorAll(".ws.lead").length,
    live: /still|live|being played/i.test(week.textContent),
  };
});
check("the week block is on the front page", home.present && home.filled === "1", home.filled);
check("it replaced its own skeleton", home.skeletonGone);
check("it leads the page, above the old champion", home.aboveChampion);
check("the defending champion is still on the page, just not first", home.hasChampion);
check("this week's games are on it", home.games === 6 && home.sides === 12, `${home.games} games / ${home.sides} sides`);
check("the injury report reaches the front page", home.injuryChips > 0, `${home.injuryChips} chips`);
check("the desk's latest pieces are linked", home.teasers > 0, `${home.teasers}`);
if (home.live) {
  check("a live week crowns nobody on the front page either", home.verdicts === 0, `${home.verdicts}`);
  check("it marks who is ahead instead", home.leads > 0, `${home.leads}`);
}

/* ------------------------------------------------------------------------
 * "Six of twelve make it" is not a race with one winner, and pricing it like
 * one turned a 93% near-lock into a +510 longshot.
 * ---------------------------------------------------------------------- */
group("A yes/no market is priced as one");

const bin = await page.evaluate(() => {
  const D = window.__DFFL;
  const probs = [0.93, 0.75, 0.5, 0.25, 0.07];
  const rows = D.priceBinary(probs.map((p, i) => ({ i, p })));
  const race = D.priceMarket(probs.map((p, i) => ({ i, p })));
  return {
    prices: rows.map(r => r.price),
    racePrices: race.map(r => r.price),
    // a favourite must be odds-on, a longshot odds-against
    favouriteNegative: rows[0].price < 0,
    longshotPositive: rows[4].price > 0,
    monotone: rows.every((r, i) => i === 0 || r.price > rows[i - 1].price),
    // each runner is its own two-way book holding about 6%
    holds: rows.map(r => +(r.postedP + r.noPostedP - 1).toFixed(3)),
    hold: +D.marketHold(rows).toFixed(3),
    // the field does NOT have to sum to one here
    fieldSum: +rows.reduce((a, r) => a + r.postedP, 0).toFixed(2),
    // and the one-winner pricer still behaves as it always did
    raceHold: +D.marketHold(race).toFixed(3),
    raceSum: +race.reduce((a, r) => a + r.postedP, 0).toFixed(2),
  };
});
check("a near-certainty prices as a heavy favourite", bin.favouriteNegative, `${bin.prices[0]}`);
check("a longshot prices as a longshot", bin.longshotPositive, `${bin.prices[4]}`);
check("prices lengthen as the chance falls", bin.monotone, bin.prices.join(" "));
check("every runner holds about 6% on its own two-way book",
  bin.holds.every(h => h > 0.045 && h < 0.075), bin.holds.join(" "));
check("the reported hold is that per-runner hold, not a field sum",
  bin.hold > 0.045 && bin.hold < 0.075, `${bin.hold}`);
check("a six-of-twelve field is not forced to sum to one", bin.fieldSum > 1.5, `${bin.fieldSum}`);
check("the one-winner pricer is unchanged", bin.raceSum > 1.03 && bin.raceSum < 1.09
  && bin.raceHold > 0.03 && bin.raceHold < 0.09, `sum ${bin.raceSum}, hold ${bin.raceHold}`);

const boards = await page.evaluate(() => {
  const odds = document.querySelector('[data-panel="odds"]');
  const rows = [...odds.querySelectorAll('[data-board] .orow')];
  const live = odds.querySelector('[data-board="live"]');
  return {
    named: odds.querySelectorAll("[data-board]").length,
    hasOpening: !!odds.querySelector('[data-board="opening"]'),
    // no board should post a hold outside a plausible book's range
    holds: [...odds.querySelectorAll("[data-board] .hold")].map(n => n.textContent.trim())
      .filter(t => /Hold/.test(t)),
  };
});
check("every board on the tab is named", boards.named >= 2, `${boards.named}`);
check("the opening line is still there to compare against", boards.hasOpening);
check("a timestamp is never dressed up as a hold", await page.evaluate(() => {
  const odds = document.querySelector('[data-panel="odds"]');
  return [...odds.querySelectorAll(".hold")].every(n => /^Hold \d+\.\d%$/.test(n.textContent.trim()));
}));
check("no board posts an implausible hold",
  boards.holds.every(h => { const v = parseFloat(h.replace(/[^0-9.]/g, "")); return v > 3 && v < 12; }),
  boards.holds.join(" | "));

/* ------------------------------------------------------------------------
 * Gmail proxies every outbound link through google.com/url, and a #fragment
 * on the end of that is what makes it stop and show a Redirect Notice. The
 * email links with ?a=<slug> instead, so the site has to honour it.
 * ---------------------------------------------------------------------- */
group("An emailed link opens the piece");

for (const [url, want] of [
  ["/?a=the-nine-game-difference", "The Nine-Game Difference"],
  ["/?a=the-cpes-problem", "The CPES Problem"],
  ["/?a=nothing-by-this-name", null],
  ["/?t=odds", null],
]) {
  const p2 = await ctx.newPage();
  const errs = [];
  p2.on("pageerror", e => errs.push(e.message));
  await p2.goto(BASE + url, { waitUntil: "domcontentloaded" });
  await p2.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 90000 });
  await p2.waitForTimeout(700);
  const got = await p2.evaluate(() => {
    const a = document.querySelector('[data-panel="article"]');
    const vis = [...document.querySelectorAll("#app > .panel")].find(x => !x.hidden);
    return { headline: a && !a.hidden ? a.querySelector("h2").textContent : null,
             panel: vis ? vis.dataset.panel : null };
  });
  check(`${url} → ${want || "the index, not a blank page"}`,
    want ? got.headline === want : got.headline === null && !!got.panel,
    `panel=${got.panel} headline=${got.headline}${errs.length ? " ERR:" + errs.join("|") : ""}`);
  await p2.close();
}

/* ------------------------------------------------------------------------
 * Futures markets: the sportsbook-style browser, on both lines. Presentation
 * only, so every price is checked against the simulation it claims to show —
 * Opening against SIM, Live against LIVE_NOW.lsim (the run the live board is
 * drawn from) — through the page's own priceMarket / winTotals / fmtOdds.
 * ---------------------------------------------------------------------- */
group("Futures markets");
const fxErr0 = errors.length;
const FX_MARKETS = ["title", "divWin", "playoff", "bye", "wins", "divLast", "last"];
await page.click('#tabs button[data-tab="odds"]');
await page.waitForSelector('[data-panel="odds"] .fxm', { timeout: 30000 });
await page.waitForFunction(() => document.body.dataset.liveReady, null, { timeout: 180000 });
const fxLive = await page.evaluate(() => {
  const N = window.__DFFL.liveNow();
  return { status: document.body.dataset.liveReady, ok: document.body.dataset.liveReady === "1" && !!(N && N.lsim) };
});
const FX_SKIP = `skipped: no live sim on this run (liveReady=${fxLive.status}) — offseason or no live data`;
const liveCheck = (name, fn) => fxLive.ok ? fn() : check(name, true, FX_SKIP);

// Rows and prices of one line, against the simulation behind it.
const fxLine = kind => page.evaluate(kind => {
  const D = window.__DFFL, M = D.ODDS, T = M.teams;
  const S = kind === "live" ? (D.liveNow() || {}).lsim : D.SIM;
  const view = document.querySelector(`[data-panel="odds"] .fxm .fxm-line-view[data-line="${kind}"]`);
  if (!S || !view) return { missing: true };
  const n = S.sims, pct = p => `${(p * 100).toFixed(1)}%`, exp = {};
  const put = (mk, uid, list) => ((exp[mk] = exp[mk] || {})[uid] = list.map(r => ({ o: D.fmtOdds(r.price), tp: pct(r.p) })));
  const all = T.map((_, i) => i);
  const race = (mk, ids) => D.priceMarket(ids.map(i => ({ uid: T[i].uid, p: S[mk][i] / n }))).forEach(r => put(mk, r.uid, [r]));
  race("title", all); race("last", all);
  for (const d of new Set(T.map(t => t.div))) {
    const ids = all.filter(i => T[i].div === d);
    race("divWin", ids); race("divLast", ids);
  }
  for (const mk of ["playoff", "bye"]) all.forEach(i => { const p = S[mk][i] / n; put(mk, T[i].uid, D.priceMarket([{ p }, { p: 1 - p }])); });
  D.winTotals(M, S).forEach(w => put("wins", w.uid, D.priceMarket([{ p: w.pOver }, { p: w.pUnder }])));
  const markets = {};
  for (const sec of view.querySelectorAll(".fxm-mkt")) {
    const mk = sec.dataset.market, rows = [...sec.querySelectorAll(".fxm-row")], uids = rows.map(r => r.dataset.uid);
    const bad = [];
    for (const r of rows) {
      const shown = [...r.querySelectorAll(".price")].map(x => ({ o: x.querySelector(".o").textContent.trim(), tp: x.querySelector(".tp").textContent.trim() }));
      const want = (exp[mk] || {})[r.dataset.uid];
      if (!want || JSON.stringify(shown) !== JSON.stringify(want)) bad.push(`${r.dataset.name}: ${JSON.stringify(shown)} vs ${JSON.stringify(want)}`);
    }
    markets[mk] = { rows: rows.length, unique: new Set(uids).size, allTeams: T.every(t => uids.includes(t.uid)),
      groups: sec.querySelectorAll(".board").length, bad: bad.slice(0, 3), badN: bad.length };
  }
  return { markets, teams: T.length, divs: new Set(T.map(t => t.div)).size };
}, kind);
const fxState = () => page.evaluate(() => {
  const root = document.querySelector('[data-panel="odds"] .fxm');
  const vis = [...root.querySelectorAll(".fxm-mkt")].filter(s => s.offsetParent).map(s => s.dataset.market);
  const card = root.querySelector(".fxm-card");
  return {
    ...root.dataset, visible: vis,
    chips: [...root.querySelectorAll(".fxm-chip")].map(c => c.dataset.market),
    selected: [...root.querySelectorAll('.fxm-chip[aria-selected="true"]')].map(c => c.dataset.market),
    pressed: [...root.querySelectorAll('.fxm-lineseg [aria-pressed="true"]')].map(b => b.dataset.line),
    liveDisabled: root.querySelector('.fxm-lineseg [data-line="live"]').disabled,
    note: root.querySelector(".fxm-srctxt").textContent.replace(/\s+/g, " ").trim(),
    shownLine: [...root.querySelectorAll(".fxm-line-view")].filter(v => !v.hidden).map(v => v.dataset.line).join(),
    card: card && card.offsetParent ? { uid: card.dataset.uid, line: card.dataset.line } : null,
    sel: { div: root.querySelector('select[data-fxm="div"]').value, team: root.querySelector('select[data-fxm="team"]').value },
  };
});

const fx0 = await fxState();
check("futures: one chip per market the simulation computes, in order", JSON.stringify(fx0.chips) === JSON.stringify(FX_MARKETS), fx0.chips.join(","));
check("futures: opens on the championship, and only that market shows", fx0.selected.join() === "title" && fx0.visible.join() === "title",
  `selected ${fx0.selected} visible ${fx0.visible}`);
if (fxLive.ok) {
  check("futures: the toggle defaults to Live once the live sim is ready",
    fx0.line === "live" && fx0.pressed.join() === "live" && fx0.shownLine === "live" && !fx0.liveDisabled && /^Live line/.test(fx0.note), JSON.stringify({ line: fx0.line, pressed: fx0.pressed, note: fx0.note }));
} else {
  check("futures: the toggle defaults to Live once the live sim is ready", true, FX_SKIP);
  check("futures: with no live sim it stays on Opening, says so, and Live is off",
    fx0.line === "opening" && fx0.liveDisabled && /^Opening line/.test(fx0.note), JSON.stringify({ line: fx0.line, note: fx0.note }));
}

const fxO = await fxLine("opening");
for (const mk of FX_MARKETS) {
  const m = (fxO.markets || {})[mk] || {};
  check(`futures ${mk} (opening): one row per team`, m.rows === fxO.teams && m.unique === fxO.teams && m.allTeams, `${m.rows} rows, ${m.unique} unique of ${fxO.teams}`);
  check(`futures ${mk} (opening): every price is __SIM's after the 6% hold`, m.rows > 0 && m.badN === 0, `${m.badN} off: ${(m.bad || []).join(" | ")}`);
}
check("futures: division markets carry one group per division",
  fxO.markets && fxO.markets.divWin.groups === fxO.divs && fxO.markets.divLast.groups === fxO.divs);
const fxL = fxLive.ok ? await fxLine("live") : null;
for (const mk of FX_MARKETS) {
  liveCheck(`futures ${mk} (live): one row per team`, () => {
    const m = (fxL.markets || {})[mk] || {};
    check(`futures ${mk} (live): one row per team`, m.rows === fxL.teams && m.unique === fxL.teams && m.allTeams, `${m.rows} rows, ${m.unique} unique of ${fxL.teams}`);
  });
  liveCheck(`futures ${mk} (live): every price is lsim's after the 6% hold`, () => {
    const m = (fxL.markets || {})[mk] || {};
    check(`futures ${mk} (live): every price is lsim's after the 6% hold`, m.rows > 0 && m.badN === 0, `${m.badN} off: ${(m.bad || []).join(" | ")}`);
  });
}

// The live championship is the live board's championship, team for team.
if (fxLive.ok) {
  const vs = await page.evaluate(() => {
    const sel = document.querySelector("#liveHost .asofbar select");
    const rewound = sel && sel.value !== "";
    const lb = [...document.querySelectorAll('#liveHost [data-board="live"]')]
      .find(b => /To win the DFFL championship/.test(b.querySelector(".bt").textContent));
    const txt = r => [...r.querySelectorAll(".price")].map(x => x.querySelector(".o").textContent.trim() + "@" + x.querySelector(".tp").textContent.trim()).join(" ");
    const board = new Map(lb ? [...lb.querySelectorAll(".orow")].map(r => [r.querySelector(".who .n").textContent.trim(), txt(r)]) : []);
    const fxm = [...document.querySelectorAll('.fxm .fxm-line-view[data-line="live"] .fxm-mkt[data-market="title"] .fxm-row')]
      .map(r => ({ name: r.dataset.name, t: txt(r) }));
    return { rewound, found: !!lb, n: board.size, fxn: fxm.length, off: fxm.filter(r => board.get(r.name) !== r.t).map(r => `${r.name}: ${r.t} vs ${board.get(r.name)}`) };
  });
  check("futures: the live championship posts exactly the live board's prices",
    vs.found && !vs.rewound && vs.n === 12 && vs.fxn === 12 && vs.off.length === 0, JSON.stringify(vs).slice(0, 300));
} else check("futures: the live championship posts exactly the live board's prices", true, FX_SKIP);

// Injury notes: the Live line carries the live board's own note, row for row;
// the Opening line never carries one.
if (fxLive.ok) {
  const inj = await page.evaluate(() => {
    const noteOf = s => { const m = (s || "").match(/ · (Injuries: .*)$/); return m ? m[1].trim() : ""; };
    const board = title => {
      const b = [...document.querySelectorAll('#liveHost [data-board="live"]')].find(x => x.querySelector(".bt").textContent.includes(title));
      return new Map(b ? [...b.querySelectorAll(".orow")].map(r => [r.querySelector(".who .n").textContent.trim(), noteOf(r.querySelector(".who .s").textContent.replace(/\s+/g, " "))]) : []);
    };
    const mine = mk => new Map([...document.querySelectorAll(`.fxm .fxm-line-view[data-line="live"] .fxm-mkt[data-market="${mk}"] .fxm-row`)]
      .map(r => [r.dataset.name, ((r.querySelector(".fxm-inj") || {}).textContent || "").replace(/\s+/g, " ").trim()]));
    const cmp = (a, b) => [...a.keys()].filter(k => a.get(k) !== b.get(k)).map(k => `${k}: "${a.get(k)}" vs "${b.get(k)}"`);
    const tB = board("To win the DFFL championship"), pB = board("To make the playoffs"), tM = mine("title"), pM = mine("playoff");
    return { tn: tB.size, pn: pB.size, tm: tM.size, pm: pM.size, tOff: cmp(tM, tB), pOff: cmp(pM, pB),
      withNote: [...tB.entries()].filter(([, v]) => v).map(([k]) => k),
      otherMarkets: [...document.querySelectorAll('.fxm .fxm-line-view[data-line="live"] .fxm-mkt:not([data-market="title"]):not([data-market="playoff"]) .fxm-inj')].length };
  });
  check("injury notes: live Championship rows carry the live board's note, team for team",
    inj.tn === 12 && inj.tm === 12 && inj.tOff.length === 0, `${inj.withNote.length} with notes; ${inj.tOff.slice(0, 3).join(" | ")}`);
  check("injury notes: live Make playoffs rows carry the live playoff board's note, team for team",
    inj.pn === 12 && inj.pm === 12 && inj.pOff.length === 0, inj.pOff.slice(0, 3).join(" | "));
  check("injury notes: only the championship and playoff markets carry them", inj.otherMarkets === 0, `${inj.otherMarkets}`);
  if (inj.withNote.length) {
    const uid = await page.evaluate(n => [...document.querySelectorAll('.fxm-line-view[data-line="live"] .fxm-mkt[data-market="title"] .fxm-row')].find(r => r.dataset.name === n).dataset.uid, inj.withNote[0]);
    await page.selectOption('.fxm select[data-fxm="team"]', uid);
    const cardLive = await page.evaluate(() => [...document.querySelectorAll(".fxm .fxm-card .fxm-trow")].map(r => [r.dataset.market, ((r.querySelector(".fxm-inj") || {}).textContent || "").trim()]));
    const listLive = await page.evaluate(u => ["title", "playoff"].map(mk => ((document.querySelector(`.fxm-line-view[data-line="live"] .fxm-mkt[data-market="${mk}"] .fxm-row[data-uid="${u}"] .fxm-inj`) || {}).textContent || "").trim()), uid);
    await page.click('.fxm-lineseg [data-line="opening"]');
    const cardOpen = await page.evaluate(() => document.querySelectorAll(".fxm .fxm-card .fxm-inj").length);
    await page.click('.fxm-lineseg [data-line="live"]');
    await page.selectOption('.fxm select[data-fxm="team"]', "");
    const byMk = new Map(cardLive);
    check("injury notes: the Live team card shows them on Championship and Make playoffs, and nowhere else",
      byMk.get("title") === listLive[0] && byMk.get("playoff") === listLive[1] && !!listLive[0] &&
      cardLive.filter(([mk, t]) => t && mk !== "title" && mk !== "playoff").length === 0, JSON.stringify(cardLive));
    check("injury notes: the Opening team card shows none", cardOpen === 0, `${cardOpen}`);
  } else {
    check("injury notes: the Live team card shows them on Championship and Make playoffs, and nowhere else", true, "skipped: no team carries an injury note on this run");
    check("injury notes: the Opening team card shows none", true, "skipped: no team carries an injury note on this run");
  }
} else {
  for (const n of ["injury notes: live Championship rows carry the live board's note, team for team",
    "injury notes: live Make playoffs rows carry the live playoff board's note, team for team",
    "injury notes: only the championship and playoff markets carry them",
    "injury notes: the Live team card shows them on Championship and Make playoffs, and nowhere else",
    "injury notes: the Opening team card shows none"]) check(n, true, FX_SKIP);
}
const openInj = await page.evaluate(() => {
  const v = document.querySelector('.fxm .fxm-line-view[data-line="opening"]');
  return { spans: v.querySelectorAll(".fxm-inj").length, text: /Injuries:/.test(v.textContent) };
});
check("injury notes: Opening rows never show one", openInj.spans === 0 && !openInj.text, JSON.stringify(openInj));

// Yes/no holds: the Live playoff label is the live playoff board's label.
if (fxLive.ok) {
  const hv = await page.evaluate(() => {
    const lb = [...document.querySelectorAll('#liveHost [data-board="live"]')]
      .find(b => /To make the playoffs/.test(b.querySelector(".bt").textContent));
    const fx = document.querySelector('.fxm .fxm-line-view[data-line="live"] .fxm-mkt[data-market="playoff"] .hold');
    return { board: lb && lb.querySelector(".hold").textContent.trim(), fxm: fx && fx.textContent.trim() };
  });
  check("futures: the live Make playoffs hold label equals the live playoff board's", !!hv.board && hv.fxm === hv.board, `${hv.fxm} vs ${hv.board}`);
} else check("futures: the live Make playoffs hold label equals the live playoff board's", true, FX_SKIP);

const fxRows = mk => page.evaluate(mk => {
  const rows = [...document.querySelectorAll(`.fxm-mkt[data-market="${mk}"] .fxm-row`)].filter(r => !r.hidden && r.offsetParent)
    .map(r => ({ uid: r.dataset.uid, name: r.dataset.name, key: +r.dataset.key, price: +r.dataset.price, div: r.dataset.div,
      rk: r.querySelector(".rk").textContent.trim(), board: r.closest(".board").dataset.div || "" }));
  const names = rows.map(r => r.name);
  return { rows, alpha: names.join("|") === names.slice().sort((a, b) => a.localeCompare(b)).join("|") };
}, mk);
const byBoard = rows => Object.values(rows.reduce((a, r) => ((a[r.board] = a[r.board] || []).push(r), a), {}));
const ranked = rows => byBoard(rows).every(g => g.every((r, i) => r.rk === String(i + 1)));
const oddsOrdered = (rows, priced = true) => byBoard(rows).every(g =>
  g.every((r, i) => i === 0 || (g[i - 1].key >= r.key && (!priced || g[i - 1].price <= r.price))));

let so = {};
for (const mk of ["title", "playoff", "divWin", "wins"]) {
  await page.click(`.fxm-chip[data-market="${mk}"]`);
  so[mk] = await fxRows(mk);
}
check("sort by odds: shortest price first in every market", ["title", "playoff", "divWin"].every(mk => oddsOrdered(so[mk].rows)) && oddsOrdered(so.wins.rows, false),
  ["title", "playoff", "divWin", "wins"].map(mk => `${mk}:${so[mk].rows.map(r => r.price).join(",")}`).join(" "));
check("sort by odds: every team visible and ranked 1..n", so.title.rows.length === fxO.teams && ranked(so.title.rows) && ranked(so.divWin.rows));
await page.click('.fxm-chip[data-market="title"]');
await page.click('.fxm-seg button[data-sort="name"]');
const soName = { title: await fxRows("title") };
await page.click('.fxm-chip[data-market="divWin"]');
soName.divWin = await fxRows("divWin");
check("sort by name: alphabetical, and it survives a market switch",
  soName.title.alpha && soName.title.rows.length === fxO.teams && byBoard(soName.divWin.rows).every(g => g.map(r => r.name).join("|") === g.map(r => r.name).sort((a, b) => a.localeCompare(b)).join("|")),
  soName.title.rows.map(r => r.name).join(","));
await page.click('.fxm-seg button[data-sort="odds"]');
await page.click('.fxm-chip[data-market="title"]');
check("sort back to odds restores the odds order", oddsOrdered((await fxRows("title")).rows));

const fxDivs = await page.evaluate(() => [...document.querySelectorAll('.fxm select[data-fxm="div"] option')].map(o => o.value).filter(Boolean));
const divRes = [];
for (const d of fxDivs) {
  await page.selectOption('.fxm select[data-fxm="div"]', d);
  const t = await fxRows("title");
  await page.click('.fxm-chip[data-market="divWin"]');
  const g = await page.evaluate(() => [...document.querySelectorAll('.fxm-mkt[data-market="divWin"] .board')].filter(b => b.offsetParent).map(b => b.dataset.div));
  await page.click('.fxm-chip[data-market="title"]');
  divRes.push({ d, n: t.rows.length, same: t.rows.every(r => r.div === d), ranked: ranked(t.rows), g });
}
await page.selectOption('.fxm select[data-fxm="div"]', "");
check("division filter: every division narrows the list to its own four", fxDivs.length === fxO.divs && divRes.every(x => x.n === 4 && x.same && x.ranked),
  JSON.stringify(divRes));
check("division filter: division markets show only that division's group", divRes.every(x => x.g.join() === x.d), JSON.stringify(divRes.map(x => x.g)));
check("division filter: All brings every team back", (await fxRows("title")).rows.length === fxO.teams);

const pickTeam = async () => page.evaluate(() => {
  const root = document.querySelector(".fxm"), card = root.querySelector(".fxm-card");
  if (!card || !card.offsetParent) return { shown: false };
  const uid = card.dataset.uid, view = root.querySelector(`.fxm-line-view[data-line="${root.dataset.line}"]`);
  const txt = e => [...e.querySelectorAll(".price")].map(x => x.querySelector(".o").textContent.trim() + "@" + x.querySelector(".tp").textContent.trim()).join(" ");
  const rows = [...card.querySelectorAll(".fxm-trow")].map(r => {
    const src = view.querySelector(`.fxm-mkt[data-market="${r.dataset.market}"] .fxm-row[data-uid="${uid}"]`);
    return { mk: r.dataset.market, same: !!src && txt(src) === txt(r) && txt(r).length > 0, t: txt(r) };
  });
  return { shown: true, uid, line: card.dataset.line, rows, marketsHidden: [...root.querySelectorAll(".fxm-mkt")].every(s => !s.offsetParent),
    sel: root.querySelector('select[data-fxm="team"]').value };
});
const fxTeam = await page.evaluate(() => [...document.querySelectorAll('.fxm select[data-fxm="team"] option')].map(o => o.value).filter(Boolean)[3]);
await page.selectOption('.fxm select[data-fxm="team"]', fxTeam);
const tp = await pickTeam();
check("team pick: one manager's card replaces the lists", tp.shown && tp.uid === fxTeam && tp.marketsHidden, JSON.stringify({ shown: tp.shown, uid: tp.uid }));
check("team pick: a row for every market", tp.shown && JSON.stringify(tp.rows.map(r => r.mk)) === JSON.stringify(FX_MARKETS), tp.rows && tp.rows.map(r => r.mk).join(","));
check("team pick: each price is the one the market list posts", tp.shown && tp.rows.every(r => r.same), tp.rows && tp.rows.filter(r => !r.same).map(r => r.mk).join(","));
await page.click('.fxm-chip[data-market="last"]');
const lastUid = await page.evaluate(() => [...document.querySelectorAll('.fxm-mkt[data-market="last"] .fxm-row')].find(x => x.offsetParent).dataset.uid);
await page.click(`.fxm-line-view:not([hidden]) .fxm-mkt[data-market="last"] .fxm-row[data-uid="${lastUid}"]`);
const tp2 = await pickTeam();
check("team pick: tapping a team row opens that manager's card", tp2.shown && tp2.uid === lastUid && tp2.sel === lastUid, `${tp2.uid} vs ${lastUid}`);
await page.click('.fxm-chip[data-market="title"]');
const back = await fxState();
check("team pick: choosing a market goes back to the lists", back.team === "" && back.sel.team === "" && !back.card, JSON.stringify({ team: back.team, card: back.card }));

// Opening <-> Live keeps every control where the reader left it.
if (fxLive.ok) {
  await page.click('.fxm-chip[data-market="divWin"]');
  await page.click('.fxm-seg button[data-sort="name"]');
  await page.selectOption('.fxm select[data-fxm="div"]', fxDivs[1]);
  const keep = s => ({ market: s.market, sort: s.sort, div: s.div, team: s.team, visible: s.visible.join(), selDiv: s.sel.div, selTeam: s.sel.team, selected: s.selected.join() });
  const s0 = await fxState();
  const r0 = await fxRows("divWin");
  await page.click('.fxm-lineseg [data-line="opening"]');
  const s1 = await fxState(), r1 = await fxRows("divWin");
  await page.click('.fxm-lineseg [data-line="live"]');
  const s2 = await fxState(), r2 = await fxRows("divWin");
  check("toggle: switching Live -> Opening -> Live keeps market, sort and division filter",
    s1.line === "opening" && s1.shownLine === "opening" && /^Opening line/.test(s1.note) && s2.line === "live" && s2.shownLine === "live" &&
    JSON.stringify(keep(s1)) === JSON.stringify(keep(s0)) && JSON.stringify(keep(s2)) === JSON.stringify(keep(s0)) &&
    r1.rows.length === 4 && r1.rows.every(r => r.div === fxDivs[1]) && r1.alpha && r2.alpha && r2.rows.length === 4,
    JSON.stringify({ s0: keep(s0), s1: keep(s1), s2: keep(s2) }));
  await page.selectOption('.fxm select[data-fxm="team"]', fxTeam);
  const t0 = await pickTeam();
  await page.click('.fxm-lineseg [data-line="opening"]');
  const t1 = await pickTeam();
  await page.click('.fxm-lineseg [data-line="live"]');
  const t2 = await pickTeam();
  check("toggle: the team pick survives the switch and reprices from the line shown",
    t0.shown && t1.shown && t2.shown && t0.uid === fxTeam && t1.uid === fxTeam && t2.uid === fxTeam &&
    t0.line === "live" && t1.line === "opening" && t2.line === "live" && [t0, t1, t2].every(t => t.rows.every(r => r.same)) &&
    JSON.stringify(t0.rows.map(r => r.t)) === JSON.stringify(t2.rows.map(r => r.t)),
    JSON.stringify({ t0: [t0.uid, t0.line], t1: [t1.uid, t1.line], t2: [t2.uid, t2.line] }));

  // A poll that reprices the live line swaps the lists in place: controls and
  // scroll stay put, and the prices follow the new run. Simulated by handing
  // the view another run, then the real one back.
  const redraw = await page.evaluate(async () => {
    const D = window.__DFFL, root = document.querySelector(".fxm"), N = D.liveNow();
    const before = { ...root.dataset }, y0 = (window.scrollTo(0, root.getBoundingClientRect().top + scrollY + 120), window.scrollY);
    root._fxm.setLive({ ...N, lsim: D.SIM }, "ready");
    const mid = { ...root.dataset }, y1 = window.scrollY;
    const card = root.querySelector(".fxm-card");
    const champ = card && card.querySelector('.fxm-trow[data-market="title"] .price .tp').textContent.trim();
    const T = D.ODDS.teams, i = T.findIndex(t => t.uid === before.team);
    const wantSim = `${(D.SIM.title[i] / D.SIM.sims * 100).toFixed(1)}%`;
    root._fxm.setLive(N, "ready");
    const after = { ...root.dataset }, champBack = root.querySelector('.fxm-card .fxm-trow[data-market="title"] .price .tp').textContent.trim();
    const wantLive = `${(N.lsim.title[i] / N.lsim.sims * 100).toFixed(1)}%`;
    const same = (a, b) => ["line", "market", "sort", "div", "team"].every(k => a[k] === b[k]);
    return { keep: same(before, mid) && same(before, after), y0, y1, y2: window.scrollY, champ, wantSim, champBack, wantLive };
  });
  check("live redraw: a repriced live line keeps market, sort, filter, team and scroll",
    redraw.keep && Math.abs(redraw.y1 - redraw.y0) <= 1 && Math.abs(redraw.y2 - redraw.y0) <= 1, JSON.stringify(redraw));
  check("live redraw: the prices follow the new run, and come back with the real one",
    redraw.champ === redraw.wantSim && redraw.champBack === redraw.wantLive, JSON.stringify(redraw));
  await page.selectOption('.fxm select[data-fxm="team"]', "");
  await page.selectOption('.fxm select[data-fxm="div"]', "");
  await page.click('.fxm-seg button[data-sort="odds"]');
  await page.click('.fxm-chip[data-market="title"]');
} else {
  for (const n of ["toggle: switching Live -> Opening -> Live keeps market, sort and division filter",
    "toggle: the team pick survives the switch and reprices from the line shown",
    "live redraw: a repriced live line keeps market, sort, filter, team and scroll",
    "live redraw: the prices follow the new run, and come back with the real one"]) check(n, true, FX_SKIP);
}

const reach = await page.evaluate(() => {
  const p = document.querySelector('[data-panel="odds"]'), fxm = p.querySelector(".fxm");
  const after = sel => { const t = p.querySelector(sel); return !!t && !!(fxm.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING); };
  return {
    jumps: [...fxm.querySelectorAll(".fxm-links [data-jump]")].map(b => b.dataset.jump),
    targets: ["liveHost", "fxmNotice", "fxmHow"].every(id => p.querySelector("#" + id)),
    below: after("#liveHost") && after("#fxmNotice") && after("#fxmHow"),
    live: document.body.dataset.liveReady, liveKids: p.querySelector("#liveHost") ? p.querySelector("#liveHost").children.length : 0,
    notice: /These are not real betting lines/.test((p.querySelector("#fxmNotice") || {}).textContent || ""),
    method: /What the model is told/.test(p.textContent) && /The prices/.test(p.textContent),
    quirk: /How last place is decided/.test((fxm.querySelector(".fxm-quirk") || {}).textContent || ""),
    blurbs: !!fxm.querySelector(".fxm-blurb") && fxm.querySelector(".fxm-blurb").textContent.includes("6% hold"),
  };
});
check("explanation and live board: moved below the markets, not removed",
  reach.targets && reach.below && reach.notice && reach.method && reach.quirk && reach.blurbs, JSON.stringify(reach));
check("explanation and live board: the markets link to each of them", ["liveHost", "fxmNotice", "fxmHow"].every(j => reach.jumps.includes(j)), reach.jumps.join(","));
check("the live board still renders under the markets", reach.live === "waiting" || (reach.live === "1" && reach.liveKids > 2), `${reach.live}, ${reach.liveKids} children`);
await page.click('.fxm-links [data-jump="liveHost"]');
await page.waitForTimeout(1200);
const liveTop = await page.evaluate(() => Math.round(document.querySelector("#liveHost").getBoundingClientRect().top));
check("the Live board link scrolls to it", liveTop > -10 && liveTop < 300, `top ${liveTop}`);
check("no uncaught page errors in the futures markets", errors.length === fxErr0, errors.slice(fxErr0, fxErr0 + 2).join(" | "));
await page.evaluate(() => window.scrollTo(0, 0));

group("Layout at 390px");
const mobile = await ctx.newPage();
await mobile.goto(BASE, { waitUntil: "domcontentloaded" });
await mobile.setViewportSize({ width: 390, height: 844 });
await mobile.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 90000 });
await mobile.click('#tabs button[data-tab="odds"]');
await mobile.waitForTimeout(150);
const narrow = await mobile.evaluate(() => {
  const de = document.documentElement;
  const panel = document.querySelector('[data-panel="odds"]');
  const over = [];
  for (const n of panel.querySelectorAll("*")) {
    // The futures market chips scroll sideways inside their own row by design.
    if (n.closest(".fxm-chips")) continue;
    const r = n.getBoundingClientRect();
    if (r.width && r.right > window.innerWidth + 1) over.push((n.className || n.tagName) + " → " + Math.round(r.right));
  }
  return {
    docScroll: de.scrollWidth, inner: window.innerWidth,
    bodyScroll: document.body.scrollWidth,
    overflowing: over.slice(0, 6),
    priceCount: panel.querySelectorAll(".price").length,
  };
});
check("document does not scroll horizontally at 390px", narrow.docScroll <= narrow.inner, `${narrow.docScroll} > ${narrow.inner}`);
check("body does not scroll horizontally at 390px", narrow.bodyScroll <= narrow.inner, `${narrow.bodyScroll} > ${narrow.inner}`);
check("no element overflows the viewport at 390px", narrow.overflowing.length === 0, narrow.overflowing.join(" | "));
check("prices still render at 390px", narrow.priceCount > 60, `${narrow.priceCount}`);
// The futures markets at phone width, on both lines: chips scroll sideways
// inside their own row; nothing else, the Live/Opening toggle included, may be
// wider than the screen, and every price box is whole.
await mobile.waitForFunction(() => document.body.dataset.liveReady, null, { timeout: 180000 });
const fxNarrow = await mobile.evaluate(async () => {
  const root = document.querySelector('[data-panel="odds"] .fxm');
  const chips = root.querySelector(".fxm-chips"), seg = root.querySelector(".fxm-lineseg");
  const W = window.innerWidth, out = { views: [], over: [], clipped: [], prices: 0 };
  const tick = () => new Promise(r => setTimeout(r, 40));
  const measure = label => {
    for (const s of root.querySelectorAll(".fxm-inj")) {
      const r = s.getBoundingClientRect();
      if (!r.width) continue;
      out.notes = (out.notes || 0) + 1;
      if (r.left < 0 || r.right > W + 1 || s.scrollWidth > s.clientWidth + 1 || getComputedStyle(s).whiteSpace === "nowrap") out.noteClipped = (out.noteClipped || []).concat(`${label}: ${s.textContent.trim().slice(0, 40)}`);
    }
    for (const n of root.querySelectorAll("*")) {
      if (n.closest(".fxm-chips") && n !== chips) continue;
      const r = n.getBoundingClientRect();
      if (r.width && (r.right > W + 1 || r.left < -1)) out.over.push(`${label}: ${n.className || n.tagName} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    for (const p of root.querySelectorAll(".price")) {
      const r = p.getBoundingClientRect();
      if (!r.width) continue;
      out.prices++;
      const o = p.querySelector(".o");
      if (r.left < 0 || r.right > W || o.scrollWidth > o.clientWidth + 1 || p.scrollWidth > p.clientWidth + 1) out.clipped.push(`${label}: ${o.textContent.trim()}`);
    }
    out.views.push(label);
    out.doc = Math.max(out.doc || 0, document.documentElement.scrollWidth);
  };
  const lines = [...seg.querySelectorAll("[data-line]")].filter(b => !b.disabled).map(b => b.dataset.line);
  for (const line of lines) {
    seg.querySelector(`[data-line="${line}"]`).click(); await tick();
    for (const c of root.querySelectorAll(".fxm-chip")) { c.click(); await tick(); measure(`${line}/${c.dataset.market}`); }
    const sel = root.querySelector('select[data-fxm="team"]');
    // A manager with an injury note, when there is one, so the card is measured with it showing.
    const hurt = root.querySelector('.fxm-line-view[data-line="live"] .fxm-mkt[data-market="title"] .fxm-row .fxm-inj');
    sel.value = hurt ? hurt.closest(".fxm-row").dataset.uid : sel.options[1].value;
    sel.dispatchEvent(new Event("change")); await tick(); measure(`${line}/team`);
    sel.value = ""; sel.dispatchEvent(new Event("change"));
  }
  seg.querySelector('[data-line="live"]').disabled || seg.querySelector('[data-line="live"]').click();
  root.querySelector('.fxm-chip[data-market="title"]').click(); await tick();
  const cr = chips.getBoundingClientRect(), sr = seg.getBoundingClientRect();
  return { ...out, W, lines, chipsScroll: chips.scrollWidth > chips.clientWidth, chipsFit: cr.left >= -1 && cr.right <= W + 1,
    chipsOverflow: getComputedStyle(chips).overflowX, segFit: sr.width > 0 && sr.left >= -1 && sr.right <= W + 1 };
});
check("futures at 390px: page never scrolls sideways in any market, on either line", fxNarrow.doc <= fxNarrow.W, `${fxNarrow.doc} > ${fxNarrow.W}`);
check("futures at 390px: no element wider than the viewport, in every market and the team card",
  fxNarrow.views.length === 8 * fxNarrow.lines.length && fxNarrow.views.length >= 8 && fxNarrow.over.length === 0,
  `${fxNarrow.views.length} views (${fxNarrow.lines}); ${fxNarrow.over.slice(0, 5).join(" | ")}`);
check("futures at 390px: every price box fully visible and unclipped", fxNarrow.prices > 100 && fxNarrow.clipped.length === 0,
  `${fxNarrow.prices} boxes; ${fxNarrow.clipped.slice(0, 5).join(" | ")}`);
check("futures at 390px: the chip row scrolls sideways inside the screen", fxNarrow.chipsFit && fxNarrow.chipsOverflow === "auto" && fxNarrow.chipsScroll,
  JSON.stringify({ fit: fxNarrow.chipsFit, ov: fxNarrow.chipsOverflow, scroll: fxNarrow.chipsScroll }));
check("futures at 390px: the Live / Opening toggle sits fully on screen", fxNarrow.segFit);
check("futures at 390px: injury notes wrap on screen, nothing clipped or overflowing",
  !(fxNarrow.noteClipped || []).length && fxNarrow.over.length === 0,
  fxNarrow.notes ? `${fxNarrow.notes} notes measured; ${(fxNarrow.noteClipped || []).slice(0, 3).join(" | ")}` : "no injury notes on this run to measure");
await mobile.waitForFunction(() => document.body.dataset.linesReady, null, { timeout: 180000 });
const glNarrow = await mobile.evaluate(() => {
  const sec = document.querySelector('[data-board="gamelines"]');
  const over = [];
  // Scoped to the game lines: the rest of the panel has its own overflow check above.
  for (const n of document.querySelectorAll('[data-board="gamelines"] *')) {
    const r = n.getBoundingClientRect();
    if (r.width && r.right > window.innerWidth + 1) over.push((n.className || n.tagName) + " → " + Math.round(r.right));
  }
  return { doc: document.documentElement.scrollWidth, inner: window.innerWidth, over: over.slice(0, 6),
    cards: sec ? sec.querySelectorAll('[data-card="gameline"]').length : 0 };
});
check("game lines: no horizontal overflow at 390px", glNarrow.doc <= glNarrow.inner && glNarrow.over.length === 0,
  `${glNarrow.doc} > ${glNarrow.inner} ${glNarrow.over.join(" | ")}`);
check("game lines: cards render at 390px", glNarrow.cards > 0, `${glNarrow.cards}`);

// the trade block, fully loaded, at phone width
await mobile.click('#tabs button[data-tab="trades"]');
await mobile.waitForFunction(() => document.body.dataset.tradesReady, null, { timeout: 180000 });
const tradeNarrow = await mobile.evaluate(() => {
  const panel = document.querySelector('[data-panel="trades"]');
  const over = [];
  for (const n of panel.querySelectorAll("*")) {
    // A wide table inside overflow-x:auto is the design; the page must not scroll.
    if (n.closest(".scroll")) continue;
    const r = n.getBoundingClientRect();
    if (r.width && r.right > window.innerWidth + 1) over.push((n.className || n.tagName) + " → " + Math.round(r.right));
  }
  return {
    docScroll: document.documentElement.scrollWidth, inner: window.innerWidth,
    overflowing: over.slice(0, 6),
    cards: panel.querySelectorAll(".trade").length,
    tiles: panel.querySelectorAll(".tile").length,
  };
});
await mobile.click('[data-panel="trades"] .back.more');
await mobile.waitForTimeout(120);
const tradeNarrowFull = await mobile.evaluate(() => {
  const panel = document.querySelector('[data-panel="trades"]');
  const over = [];
  for (const n of panel.querySelectorAll("*")) {
    if (n.closest(".scroll")) continue;
    const r = n.getBoundingClientRect();
    if (r.width && r.right > window.innerWidth + 1) over.push((n.className || n.tagName) + " → " + Math.round(r.right));
  }
  return { over: over.slice(0, 6), cards: panel.querySelectorAll(".trade").length,
    docScroll: document.documentElement.scrollWidth, inner: window.innerWidth };
});
check("trades: every card fits at 390px once expanded", tradeNarrowFull.over.length === 0 && tradeNarrowFull.docScroll <= tradeNarrowFull.inner, tradeNarrowFull.over.join(" | "));
check("trades: all 150+ cards render at 390px", tradeNarrowFull.cards > 100, `${tradeNarrowFull.cards}`);
check("trades: page does not scroll horizontally at 390px", tradeNarrow.docScroll <= tradeNarrow.inner, `${tradeNarrow.docScroll} > ${tradeNarrow.inner}`);
check("trades: nothing outside a scroller overflows at 390px", tradeNarrow.overflowing.length === 0, tradeNarrow.overflowing.join(" | "));
check("trades: the whole board still renders at 390px", tradeNarrow.cards === 20 && tradeNarrow.tiles === 4, `${tradeNarrow.cards} cards, ${tradeNarrow.tiles} tiles`);

// the playoff picture at phone width, with a season that actually has a race in it
await mobile.click('#tabs button[data-tab="picture"]');
await mobile.waitForFunction(() => document.body.dataset.pictureReady, null, { timeout: 180000 });
const ppNarrow = await mobile.evaluate(async () => {
  const D = window.__DFFL, M = window.__ODDS;
  const season = D.DB.seasons.find(s => s.season === "2025");
  const R = D.raceAsOf(season, 10);
  const live = D.liveState(M, season, R, null, null, 10);
  D.renderPicture(document.querySelector("#pictureHost"), await D.computePicture(M, live, R, season, { whatIfSims: 500 }));
  const panel = document.querySelector('[data-panel="picture"]');
  const over = [];
  for (const n of panel.querySelectorAll("*")) {
    if (n.closest(".scroll")) continue;
    const r = n.getBoundingClientRect();
    if (r.width && r.right > window.innerWidth + 1) over.push((n.className || n.tagName) + " → " + Math.round(r.right));
  }
  const first = panel.querySelector(".pp tbody td");
  return { over: over.slice(0, 6), doc: document.documentElement.scrollWidth, inner: window.innerWidth,
    rows: panel.querySelectorAll("tbody tr").length,
    nameW: first ? first.getBoundingClientRect().width : 0,
    sticky: first ? getComputedStyle(first).position : "" };
});
check("picture: page does not scroll horizontally at 390px", ppNarrow.doc <= ppNarrow.inner, `${ppNarrow.doc} > ${ppNarrow.inner}`);
check("picture: nothing outside a scroller overflows at 390px", ppNarrow.over.length === 0, ppNarrow.over.join(" | "));
check("picture: the whole board renders at 390px", ppNarrow.rows >= 18, `${ppNarrow.rows} rows`);
check("picture: the manager column stays pinned and compact at 390px",
  ppNarrow.sticky === "sticky" && ppNarrow.nameW > 60 && ppNarrow.nameW <= 170, `${ppNarrow.sticky}, ${Math.round(ppNarrow.nameW)}px`);

// Clinch badges at 390px, on a week late enough that somebody has clinched.
const ppBadges = await mobile.evaluate(async () => {
  const D = window.__DFFL, M = window.__ODDS, se = D.DB.seasons.find(x => x.season === "2025"), R = D.raceAsOf(se, 13);
  const live = D.liveState(M, se, R, null, null, 13);
  const PP = await D.computePicture(M, live, R, se, { whatIfSims: 300, main: true });
  D.renderPicture(document.querySelector("#pictureHost"), PP);
  const inside = n => {
    const td = n.closest("td"), tr = td.getBoundingClientRect();
    return n.getBoundingClientRect().right <= tr.right - parseFloat(getComputedStyle(td).paddingRight) + 1;
  };
  const badges = [...document.querySelectorAll("#pictureHost .pp .badge")];
  const names = [...document.querySelectorAll("#pictureHost .pp .nm")];
  return {
    n: badges.length,
    badBadges: badges.filter(b => !inside(b) || b.scrollWidth > b.clientWidth + 1).map(b => b.dataset.short),
    badTitles: badges.filter(b => !/^(Clinched |Eliminated)/.test(b.title) || b.title === b.dataset.short).map(b => b.title),
    badShort: badges.filter(b => !getComputedStyle(b, "::after").content.includes(b.dataset.short)).map(b => b.dataset.short),
    badRole: badges.filter(b => b.getAttribute("role") !== "img" || b.getAttribute("aria-label") !== b.title).map(b => b.dataset.short),
    badNames: names.filter(n => !inside(n) || n.title !== n.textContent).map(n => n.textContent),
  };
});
check("picture: week 13 of 2025 shows clinch badges", ppBadges.n > 0, `${ppBadges.n} badges`);
check("picture: every badge fits its cell unclipped at 390px", ppBadges.badBadges.length === 0, ppBadges.badBadges.join(","));
check("picture: badges keep the full text in their title", ppBadges.badTitles.length === 0, ppBadges.badTitles.join(","));
check("picture: badges show the short label on a phone", ppBadges.badShort.length === 0, ppBadges.badShort.join(","));
check("picture: badges read their full text to screen readers (role=img + aria-label)", ppBadges.badRole.length === 0, ppBadges.badRole.join(","));
check("picture: every name fits its cell and carries its full name as a title", ppBadges.badNames.length === 0, ppBadges.badNames.join(","));

// The v4 board at 390px: nothing overflows and no text is under 11px, on an
// early week (nobody out) and a late one (clinches and an Eliminated list).
const ppV4Narrow = await mobile.evaluate(async () => {
  const D = window.__DFFL, M = window.__ODDS, se = D.DB.seasons.find(x => x.season === "2025");
  const host = document.querySelector("#pictureHost"), panel = document.querySelector('[data-panel="picture"]');
  const out = [];
  for (const wk of [10, 13]) {
    const R = D.raceAsOf(se, wk), live = D.liveState(M, se, R, null, null, wk);
    const PP = await D.computePicture(M, live, R, se, { whatIfSims: 300, main: true });
    D.renderPicture(host, PP);
    const over = [], small = [];
    for (const n of panel.querySelectorAll("*")) {
      if (n.closest(".scroll")) continue;
      const r = n.getBoundingClientRect();
      if (r.width && r.right > window.innerWidth + 1) over.push((n.className || n.tagName) + " → " + Math.round(r.right));
    }
    for (const n of host.querySelectorAll("*")) {
      const own = [...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim());
      const cs = getComputedStyle(n), fs = parseFloat(cs.fontSize);
      if (own && n.getClientRects().length && fs > 0 && fs < 11) small.push(`${n.className || n.tagName} ${fs}px`);
      const after = getComputedStyle(n, "::after");
      if (after.content && after.content !== "none" && after.content !== '""' && parseFloat(after.fontSize) < 11)
        small.push(`${n.className}::after ${after.fontSize}`);
    }
    const P = PP.rules.playoffTeams;
    const elimShown = [...host.querySelectorAll(".pp-elim .pp-li")].map(r => r.dataset.rid).sort();
    const elimWant = PP.rows.filter(r => r.todaySeed > P && r.clinch.eliminated).map(r => String(r.rid)).sort();
    out.push({ wk, over: over.slice(0, 6), small: [...new Set(small)].slice(0, 6),
      doc: document.documentElement.scrollWidth, inner: window.innerWidth,
      elimOk: JSON.stringify(elimShown) === JSON.stringify(elimWant), elimN: elimWant.length,
      emptyElim: !elimWant.length === !!host.querySelector(".pp-elim .pp-empty"),
      oneCol: getComputedStyle(host.querySelector(".pp-lay")).gridTemplateColumns.split(" ").length === 1 });
  }
  return out;
});
for (const r of ppV4Narrow) {
  check(`v4 at 390px (2025 week ${r.wk}): nothing overflows`, r.over.length === 0 && r.doc <= r.inner, r.over.join(" | "));
  check(`v4 at 390px (2025 week ${r.wk}): no text under 11px`, r.small.length === 0, r.small.join(" | "));
  check(`v4 at 390px (2025 week ${r.wk}): one column`, r.oneCol);
  check(`v4 (2025 week ${r.wk}): the Eliminated list is exactly the mathematically eliminated teams`, r.elimOk && r.emptyElim, `${r.elimN} eliminated`);
}
check("v4: 2025 week 13 has somebody eliminated to show", ppV4Narrow.some(r => r.elimN > 0));

// Opening the site straight on #picture boots into the board.
{
  const direct = await ctx.newPage();
  await direct.goto(BASE + "#picture", { waitUntil: "domcontentloaded" });
  await direct.waitForFunction(() => document.body.dataset.pictureReady, null, { timeout: 180000 });
  const d = await direct.evaluate(() => ({
    state: document.body.dataset.pictureReady,
    selected: (document.querySelector('#tabs button[aria-selected="true"]') || {}).dataset?.tab || null,
    visible: !document.querySelector('[data-panel="picture"]').hidden,
    board: !!document.querySelector("#pictureHost .ppv .pp-seeds"),
    empty: !!document.querySelector("#pictureHost .empty"),
  }));
  check("v4: a direct load of #picture opens the tab and draws the board",
    d.selected === "picture" && d.visible && ((d.state === "1" && d.board) || (d.state === "empty" && d.empty)), JSON.stringify(d));
  await direct.close();
}

// the power board at phone width, on a week with movement in it
await mobile.click('#tabs button[data-tab="power"]');
await mobile.waitForTimeout(150);
const powerNarrow = await mobile.evaluate(() => {
  const panel = document.querySelector('[data-panel="power"]');
  const sel = panel.querySelectorAll("select")[0];
  sel.value = "2025"; sel.dispatchEvent(new Event("change"));
  const over = [];
  for (const n of panel.querySelectorAll("*")) {
    if (n.closest(".scroll")) continue;
    const r = n.getBoundingClientRect();
    if (r.width && r.right > window.innerWidth + 1) over.push((n.className || n.tagName) + " → " + Math.round(r.right));
  }
  return { over: over.slice(0, 6), doc: document.documentElement.scrollWidth, inner: window.innerWidth,
    rows: panel.querySelectorAll(".pwrow").length,
    arrows: [...panel.querySelectorAll(".mv")].filter(n => /[▲▼]/.test(n.textContent)).length };
});
check("power: page does not scroll horizontally at 390px", powerNarrow.doc <= powerNarrow.inner, `${powerNarrow.doc} > ${powerNarrow.inner}`);
check("power: nothing overflows at 390px", powerNarrow.over.length === 0, powerNarrow.over.join(" | "));
check("power: the whole board renders at 390px", powerNarrow.rows === 12 && powerNarrow.arrows > 0, `${powerNarrow.rows} rows, ${powerNarrow.arrows} arrows`);

// the draft board at phone width: it may scroll inside its card, never the page
await mobile.click('#tabs button[data-tab="draft"]');
await mobile.waitForFunction(() => document.querySelectorAll('[data-panel="draft"] .bc').length > 0, null, { timeout: 30000 });
const draftNarrow = await mobile.evaluate(() => {
  const panel = document.querySelector('[data-panel="draft"]');
  const over = [];
  for (const n of panel.querySelectorAll("*")) {
    if (n.closest(".scroll")) continue;
    const r = n.getBoundingClientRect();
    if (r.width && r.right > window.innerWidth + 1) over.push((n.className || n.tagName) + " → " + Math.round(r.right));
  }
  return { over: over.slice(0, 6), doc: document.documentElement.scrollWidth, inner: window.innerWidth,
    cells: panel.querySelectorAll(".bc").length };
});
check("draft: page does not scroll horizontally at 390px", draftNarrow.doc <= draftNarrow.inner, `${draftNarrow.doc} > ${draftNarrow.inner}`);
check("draft: nothing outside the board's scroller overflows at 390px", draftNarrow.over.length === 0, draftNarrow.over.join(" | "));
check("draft: the board still renders at 390px", draftNarrow.cells === 180, `${draftNarrow.cells}`);

// every other tab too, so the new CSS didn't break anything narrow
for (const id of EXPECT.filter(t => t !== "odds")) {
  await mobile.click(`#tabs button[data-tab="${id}"]`);
  await mobile.waitForTimeout(80);
  const w = await mobile.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  check(`${id}: no horizontal overflow at 390px`, w);
}

group("Wide tables as phone cards");
// The trade ledger, best/worst weeks and the rivalry tables stack into
// labelled cards at phone width: nothing inside is wider than its card, and
// every field still carries its name.
{
  const PHONE_TABLES = [
    { tab: "trades", head: "All-time trade ledger", labels: ["Trades", "Net", "From players", "From picks", "W–L", "Best", "Worst"] },
    { tab: "records", head: "10 best weeks ever", labels: ["Score", "Season", "Wk", "Opponent", "They had", "Result"] },
    { tab: "records", head: "10 worst weeks ever", labels: ["Score", "Season", "Wk", "Opponent", "They had", "Result"] },
    { tab: "matchups", head: "Real rivalries", labels: ["Series", "Games", "Avg score"] },
    { tab: "matchups", head: "Somebody owns somebody", labels: ["Series", "Games", "Avg score"] },
  ];
  const measureTable = head => {
    const h = [...document.querySelectorAll(".sechead h2")].find(x => x.textContent.trim() === head && x.offsetParent);
    const card = h && h.closest(".sechead").nextElementSibling;
    const t = card && card.querySelector("table");
    if (!t) return null;
    const over = [];
    for (const box of [card, card.querySelector(".scroll"), t]) if (box.scrollWidth > box.clientWidth + 1) over.push(`${box.className || box.tagName} ${box.scrollWidth}>${box.clientWidth}`);
    const cr = card.getBoundingClientRect();
    for (const n of t.querySelectorAll("*")) {
      const r = n.getBoundingClientRect();
      if (r.width && (r.right > cr.right + 1 || r.left < cr.left - 1 || n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).display !== "inline"))
        over.push(`${n.tagName}.${n.className} ${Math.round(r.left)}..${Math.round(r.right)}`);
    }
    // A field's name, as the reader sees it: the ::before label on phones, the header on desktop.
    const shown = new Set();
    for (const td of t.querySelectorAll("tbody td")) {
      const c = getComputedStyle(td, "::before").content;
      if (c && c !== "none" && c !== "normal") shown.add(c.replace(/^"|"$/g, ""));
    }
    const minFont = Math.min(...[...t.querySelectorAll("tbody td")].flatMap(td => [parseFloat(getComputedStyle(td).fontSize), parseFloat(getComputedStyle(td, "::before").fontSize)]));
    const ths = [...t.querySelectorAll("thead th")];
    return { over: over.slice(0, 4), shown: [...shown], minFont, rows: t.tBodies[0].rows.length,
      heads: ths.map(th => th.textContent.trim()), cols: Math.max(0, ...[...t.tBodies[0].rows].map(r => r.cells.length)),
      headVisible: ths.every(th => th.getBoundingClientRect().width > 0 && th.getBoundingClientRect().right <= cr.right + 1) };
  };
  for (const s of PHONE_TABLES) {
    await mobile.click(`#tabs button[data-tab="${s.tab}"]`);
    await mobile.waitForTimeout(120);
    const m = await mobile.evaluate(measureTable, s.head);
    if (!m) { check(`${s.head}: table found at 390px`, false); continue; }
    check(`${s.head}: nothing wider than its card at 390px`, m.over.length === 0, m.over.join(" | "));
    const missing = s.labels.filter(l => !m.shown.includes(l));
    check(`${s.head}: every field labelled at 390px`, missing.length === 0, `missing ${missing.join(", ")}`);
    check(`${s.head}: card text stays at 11px or larger`, m.minFont >= 11, `${m.minFont}px`);
  }
  // A playoff week keeps its PO tag in the card.
  await mobile.click('#tabs button[data-tab="records"]');
  const po = await mobile.evaluate(() => [...document.querySelectorAll('[data-panel="records"] table.phone-cards .badge')]
    .filter(b => b.textContent.trim() === "PO").map(b => b.getBoundingClientRect().width > 0));
  check("best/worst weeks: PO tags still show at 390px", po.every(Boolean), `${po.filter(x => !x).length} hidden`);

  // Desktop: the ledger names every column and nothing runs off the card.
  await page.click('#tabs button[data-tab="trades"]');
  await page.waitForTimeout(150);
  const L1280 = await page.evaluate(measureTable, "All-time trade ledger");
  check("trade ledger at 1280: a header for every column", L1280 && L1280.heads.length === L1280.cols && L1280.heads.every(Boolean),
    L1280 ? L1280.heads.join("|") : "no table");
  check("trade ledger at 1280: every header within the card", L1280 && L1280.headVisible);
  check("trade ledger at 1280: no cell overflows the card", L1280 && L1280.over.length === 0, L1280 ? L1280.over.join(" | ") : "");
}

/* ------------------------------------------------------------------------
 * 1 AM Tuesday, simulated: Sleeper still says week 2 while data/latest.json
 * already marks week 2 final. The site must treat week 2 as finished and week
 * 3 as the live one — the same rule the email snapshot reads (effective-week).
 * Mocks only Sleeper's state and latest.json; everything else is live.
 * ---------------------------------------------------------------------- */
group("Effective week (simulated 1 AM Tuesday)");
{
  const simCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await simCtx.route(/api\.sleeper\.app\/v1\/state\/nfl/, r => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ week: 2, leg: 2, display_week: 2, season: "2026", season_type: "regular",
      league_season: "2026", previous_season: "2025", season_start_date: "2026-09-09",
      league_create_season: "2026", season_has_scores: true }),
  }));
  await simCtx.route(/\/data\/latest\.json(\?.*)?$/, r => r.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ season: "2026", week: 2, file: "data/week-2026-02.json",
      generated: new Date().toISOString(), generated_at: new Date().toISOString(), final: true,
      sleeper_state: { week: 2, leg: 2, display_week: 2, season_type: "regular", season: "2026" } }),
  }));
  const sim = await simCtx.newPage();
  await sim.goto(BASE, { waitUntil: "domcontentloaded" });
  await sim.waitForFunction(() => document.body.dataset.ready, null, { timeout: 90000 });
  const S = await sim.evaluate(() => {
    const D = window.__DFFL, s = D.DB.seasons.find(x => x.season === "2026") || {};
    return {
      ready: document.body.dataset.ready,
      sleeperWeek: D.DB.sleeperState ? D.DB.sleeperState.week : null,
      week: D.DB.state ? D.DB.state.week : null,
      liveWeek: s.liveWeek ?? null,
      liveWeek2: D.DB.live.filter(g => g.season === "2026" && g.week === 2).length,
      final2: D.DB.games.filter(g => g.season === "2026" && g.week === 2).length,
      foot: (document.querySelector("#footNote") || {}).textContent || "",
    };
  });
  check("simulated 1 AM Tuesday: the site takes the effective week, latest.week + 1",
    S.ready === "1" && S.sleeperWeek === 2 && S.week === 3 && /week 3\b/.test(S.foot),
    `sleeper ${S.sleeperWeek}, effective ${S.week}, foot "${S.foot.trim()}"`);
  check("simulated 1 AM Tuesday: the finished week is not shown as live",
    S.liveWeek2 === 0 && S.liveWeek !== 2, `liveWeek ${S.liveWeek}, ${S.liveWeek2} week-2 games live`);
  check("simulated 1 AM Tuesday: the finished week counts as played",
    S.final2 === 6, `${S.final2} week-2 games in the book`);
  await simCtx.close();
}

/* ------------------------------------------------------------------------
 * Tap-to-explain jargon: LUCK, ALL-PLAY, FORM, RATING, PO, OTB and the
 * Draft tab's K are buttons (or, inside another button, role="button" spans)
 * that open one shared popover with the JARGON text. Plus the Records
 * trophy cards' "Champion" label.
 * ---------------------------------------------------------------------- */
group("Jargon explainers");
{
  const jxErr0 = errors.length;
  const jxState = pg => pg.evaluate(() => {
    const pop = document.getElementById("jxPop");
    const r = pop && !pop.hidden ? pop.getBoundingClientRect() : null;
    const open = [...document.querySelectorAll('.jx[aria-expanded="true"]')];
    return {
      open: !!(r && r.width && r.height), text: pop ? pop.textContent.trim() : "",
      role: pop && pop.getAttribute("role"), pos: pop && getComputedStyle(pop).position,
      rect: r && { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width },
      vw: innerWidth, vh: innerHeight, expanded: open.length, which: open.map(b => b.dataset.jx),
      focus: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.jx || null : null,
    };
  });
  const isLabel = (pg, sel) => pg.evaluate(sel => {
    const all = [...document.querySelectorAll(sel)];
    return {
      n: all.length,
      ok: all.length > 0 && all.every(b => (b.tagName === "BUTTON" ? b.type === "button" : b.getAttribute("role") === "button" && b.tabIndex === 0)
        && b.getAttribute("aria-expanded") === "false" && b.getAttribute("aria-controls") === "jxPop"),
    };
  }, sel);
  const fits = s => s.rect && s.rect.l >= 0 && s.rect.r <= s.vw && s.rect.t >= 0 && s.rect.b <= s.vh;
  const JX = await page.evaluate(() => window.__DFFL.JARGON || {});
  check("JARGON has a non-empty text for every label",
    ["luck", "allplay", "form", "rating", "po", "otb", "keeper"].every(k => typeof JX[k] === "string" && JX[k].length > 30),
    Object.keys(JX).join(","));
  check("the RATING text carries the live POWER_W weights",
    /40%/.test(JX.rating || "") && /25%/.test(JX.rating || "") && /20%/.test(JX.rating || "") && /15%/.test(JX.rating || ""), JX.rating);

  // Managers: Luck sits inside a row that is itself a button to the profile.
  await page.click('#tabs button[data-tab="managers"]');
  await page.waitForTimeout(200);
  const luckL = await isLabel(page, '[data-panel="managers"] .rowc .cl .jx[data-jx="luck"]');
  check("Managers: every Luck chip label is a role=button with aria-expanded", luckL.ok && luckL.n >= 12, `${luckL.n} labels`);
  await page.locator('[data-panel="managers"] .rowc .jx[data-jx="luck"]').first().click();
  let st = await jxState(page);
  check("Managers: clicking Luck opens the popover with the Luck text",
    st.open && st.text === JX.luck && st.expanded === 1 && st.which[0] === "luck", JSON.stringify(st.which));
  check("the popover is position:fixed with role=tooltip", st.pos === "fixed" && st.role === "tooltip", `${st.pos} ${st.role}`);
  check("the popover fits the viewport at 1280px", fits(st), JSON.stringify(st.rect));
  check("Managers: tapping Luck does not open the profile",
    await page.evaluate(() => !document.querySelector('[data-panel="profile"]') || document.querySelector('[data-panel="profile"]').hidden));
  await page.locator('[data-panel="managers"] .rowc .jx[data-jx="luck"]').nth(1).click();
  st = await jxState(page);
  check("only one popover open at a time", st.open && st.expanded === 1, `${st.expanded} expanded`);
  await page.locator('[data-panel="managers"] .sechead h2').first().click();
  st = await jxState(page);
  check("clicking outside closes it", !st.open && st.expanded === 0);

  // Power: All-play, Form, Rating chips on a played week (not the projected board).
  await page.click('#tabs button[data-tab="power"]');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const sel = document.querySelector('[data-panel="power"] select[aria-label="Season"]');
    const real = [...sel.options].find(o => o.value !== "__proj");
    if (real) { sel.value = real.value; sel.dispatchEvent(new Event("change")); }
  });
  await page.waitForTimeout(150);
  for (const k of ["allplay", "form", "rating"]) {
    const L = await isLabel(page, `[data-panel="power"] .pwrow .cl button.jx[data-jx="${k}"]`);
    check(`Power: every ${k} chip label is a <button> with aria-expanded`, L.ok && L.n >= 12, `${L.n} labels`);
    await page.locator(`[data-panel="power"] .pwrow .jx[data-jx="${k}"]`).first().click();
    st = await jxState(page);
    check(`Power: clicking ${k} opens its explanation`, st.open && st.text === JX[k] && st.which[0] === k, st.text.slice(0, 40));
  }
  await page.keyboard.press("Escape");
  st = await jxState(page);
  check("Escape closes it and returns focus to the label", !st.open && st.expanded === 0 && st.focus === "rating", `focus ${st.focus}`);
  await page.keyboard.press("Enter");
  st = await jxState(page);
  check("keyboard Enter on a focused label opens it", st.open && st.which[0] === "rating");
  await page.keyboard.press("Escape");

  // Records: PO badges in the best/worst weeks tables, and the trophy cards.
  await page.click('#tabs button[data-tab="records"]');
  await page.waitForTimeout(200);
  const poL = await isLabel(page, '[data-panel="records"] td .badge button.jx[data-jx="po"]');
  check("Records: every PO badge is a <button> with aria-expanded", poL.ok, `${poL.n} labels`);
  if (poL.n) {
    await page.locator('[data-panel="records"] .jx[data-jx="po"]').first().click();
    st = await jxState(page);
    check("Records: clicking PO opens its explanation", st.open && st.text === JX.po);
    await page.keyboard.press("Escape");
  }
  const tro = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('[data-panel="records"] .trophy')];
    return { n: cards.length, ok: cards.every(c => { const ch = c.querySelector(".ch"); return ch && ch.textContent.trim() === "Champion" && ch.getBoundingClientRect().height > 0; }) };
  });
  check("Records: every trophy card carries a visible Champion label", tro.n >= 4 && tro.ok, `${tro.n} cards`);

  // Odds: OTB only shows on a game too lopsided to price, so render one.
  const otb = await page.evaluate(() => {
    const D = window.__DFFL, T = window.__ODDS.teams;
    const line = D.gameLine({ expected: 160, sd: 4 }, { expected: 60, sd: 4 });
    const div = document.createElement("div");
    div.id = "jxOtbProbe";
    div.innerHTML = D.gameCardHTML({
      a: { rid: 1, uid: T[0].uid, pts: 0, inj: null }, b: { rid: 2, uid: T[1].uid, pts: 0, inj: null },
      aPts: 0, bPts: 0, open: line, now: line, settled: false, started: false, path: [], cover: null,
    });
    document.body.prepend(div);
    return { offBoard: line.offBoard, n: div.querySelectorAll('button.jx[data-jx="otb"][aria-expanded="false"]').length };
  });
  check("Odds: an off-the-board moneyline renders OTB as a <button> with aria-expanded", otb.offBoard && otb.n === 2, JSON.stringify(otb));
  if (otb.n) {
    await page.locator('#jxOtbProbe .jx[data-jx="otb"]').first().click();
    st = await jxState(page);
    check("Odds: clicking OTB opens its explanation", st.open && st.text === JX.otb);
    await page.keyboard.press("Escape");
  }
  await page.evaluate(() => document.getElementById("jxOtbProbe")?.remove());

  // Draft: K on the board sits inside a pick button that opens the player card.
  await page.click('#tabs button[data-tab="draft"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-panel="draft"] .bc').length > 0, null, { timeout: 30000 });
  const kL = await isLabel(page, '[data-panel="draft"] .bc .k .jx[data-jx="keeper"]');
  const kLeg = await isLabel(page, '[data-panel="draft"] .legend .badge button.jx[data-jx="keeper"]');
  check("Draft: every board K marker is a role=button with aria-expanded", kL.ok, `${kL.n} markers`);
  check("Draft: the K legend is a <button> explainer", kLeg.ok && kLeg.n === 1, `${kLeg.n}`);
  if (kL.n) {
    await page.locator('[data-panel="draft"] .bc .jx[data-jx="keeper"]').first().click();
    st = await jxState(page);
    const modal = await page.evaluate(() => !!document.querySelector(".modal"));
    check("Draft: clicking K explains keepers and does not open the player card", st.open && st.text === JX.keeper && !modal, `modal ${modal}`);
    await page.keyboard.press("Escape");
    await page.locator('[data-panel="draft"] .bc .jx[data-jx="keeper"]').first().focus();
    await page.keyboard.press("Enter");
    st = await jxState(page);
    const modal2 = await page.evaluate(() => !!document.querySelector(".modal"));
    check("Draft: Enter on a focused K marker opens it, not the player card", st.open && st.which[0] === "keeper" && !modal2);
    await page.keyboard.press("Escape");
    st = await jxState(page);
    check("Draft: Escape closes the K explainer and refocuses the marker", !st.open && st.focus === "keeper", `focus ${st.focus}`);
  }

  // 390px: the popover is clamped inside a phone screen.
  await mobile.setViewportSize({ width: 390, height: 844 });
  await mobile.click('#tabs button[data-tab="managers"]');
  await mobile.waitForTimeout(200);
  for (const nth of [0, 5]) {
    const b = mobile.locator('[data-panel="managers"] .rowc .jx[data-jx="luck"]').nth(nth);
    await b.scrollIntoViewIfNeeded();
    await b.click();
    st = await jxState(mobile);
    check(`popover fits the viewport at 390px (row ${nth + 1})`, st.open && fits(st) && st.rect.w <= 366, JSON.stringify(st.rect));
  }
  await mobile.keyboard.press("Escape");
  check("no uncaught page errors from the explainers", errors.length === jxErr0, errors.slice(jxErr0, jxErr0 + 2).join(" | "));
}

/* ------------------------------------------------------------------------
 * Players left and the games that decide a matchup. A made-up Sunday is fed
 * through window.__plFixture onto the real scoreboard: one matchup, with a
 * final game, a game in progress, kickoffs still to come, a bye, a player with
 * no team and two empty slots.
 * ---------------------------------------------------------------------- */
group("Scoreboard: players left and deciding games");
{
  // Real data, fresh page, straight to the scoreboard: the block must appear on
  // its own, without a fixture or a wait for the minute poll.
  const realPage = await ctx.newPage();
  await realPage.goto(BASE, { waitUntil: "domcontentloaded" });
  await realPage.waitForFunction(() => document.body.dataset.ready, null, { timeout: 90000 });
  await realPage.click('#tabs button[data-tab="scores"]');
  const realPls = await realPage.waitForFunction(
    () => document.querySelectorAll('[data-panel="scores"] .pl').length, null, { timeout: 8000 })
    .then(h => h.jsonValue()).catch(() => 0);
  const real = await realPage.evaluate(async () => {
    const s = DB.seasons[0], g = await window.__DFFL.loadNflGames();
    return { liveWeek: s && s.liveWeek, ok: g.ok, games: s ? s.live.length : 0 };
  });
  if (real.liveWeek && real.ok) {
    check("pl: the real live week shows players-left blocks without a fixture",
      realPls > 0, `week ${real.liveWeek}: ${realPls} blocks for ${real.games} matchups`);
  } else {
    check(`pl: the real live week shows players-left blocks without a fixture (skipped: ${real.liveWeek ? "schedule unavailable" : "no live week"})`, true);
  }
  await realPage.close();

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.click('#tabs button[data-tab="scores"]');
  await page.waitForTimeout(150);
  const pick = await page.evaluate(() => {
    const p = document.querySelector('[data-panel="scores"]');
    const [sSel, wSel] = p.querySelectorAll("select");
    const w = window.__DFFL.allWeeks().find(x => x.season === sSel.value && String(x.week) === String(wSel.value));
    return w && w.games.length ? { a: w.games[0].a.rid, b: w.games[0].b.rid } : null;
  });
  check("pl: the scoreboard shows a week to test against", !!pick);

  const ET = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h + 4, mi);   // EDT is UTC-4
  const games = [
    { home: "PHI", away: "DAL", status: "in_game", date: "2026-10-18", start_time: ET(2026, 10, 18, 13, 0) },
    { home: "WAS", away: "NYG", status: "pre_game", date: "2026-10-18", start_time: ET(2026, 10, 18, 13, 0) },
    { home: "DEN", away: "LV", status: "pre_game", date: "2026-10-18", start_time: ET(2026, 10, 18, 16, 25) },
    { home: "BUF", away: "MIA", status: "pre_game", date: "2026-10-18", start_time: ET(2026, 10, 18, 20, 20) },
    { home: "KC", away: "HOU", status: "complete", date: "2026-10-18", start_time: ET(2026, 10, 18, 13, 0) },
  ];
  const players = {
    p1: { n: "CeeDee Lamb", t: "DAL" }, p2: { n: "Saquon Barkley", t: "PHI" }, p3: { n: "Travis Kelce", t: "KC" },
    p4: { n: "George Kittle", t: "SF" }, p5: { n: "Free Agent", t: null }, p6: { n: "Brock Bowers", t: "LV" },
    q1: { n: "Dak Prescott", t: "DAL" }, q2: { n: "Jalen Hurts", t: "PHI" }, q3: { n: "A.J. Brown", t: "PHI" },
    q4: { n: "Malik Nabers", t: "NYG" }, q5: { n: "Tyreek Hill", t: "MIA" }, q6: { n: "Nico Collins", t: "HOU" },
  };
  const startersA = ["p1", "p2", "p3", "p4", "p5", "p6", "0", ""];
  const startersB = ["q1", "q2", "q3", "q4", "q5", "q6"];
  const fixture = gs => ({
    games: gs, players,
    matchups: pick ? [{ roster_id: pick.a, starters: startersA }, { roster_id: pick.b, starters: startersB }] : [],
  });
  // The hand count: real starters, less anyone whose game is final, on a bye or without a club.
  const handLeft = (starters, gs) => starters.filter(pid => {
    if (!pid || pid === "0") return false;
    const club = players[pid] && players[pid].t;
    const g = club && gs.find(x => x.home === club || x.away === club);
    return !!g && g.status !== "complete";
  }).length;

  const readPl = () => page.evaluate(({ a, b }) => {
    const n = document.querySelector(`[data-panel="scores"] .pl[data-a="${a}"][data-b="${b}"]`);
    if (!n) return null;
    const num = s => { const m = /: (\d+) left/.exec(s || ""); return m ? Number(m[1]) : null; };
    const A = n.querySelector(".pl-a"), B = n.querySelector(".pl-b"), d = n.querySelector(".pl-dec");
    return {
      text: n.textContent.replace(/\s+/g, " ").trim(),
      a: A ? num(A.textContent) : null, b: B ? num(B.textContent) : null,
      aText: A ? A.textContent : "", bText: B ? B.textContent : "",
      dec: [...n.querySelectorAll(".pl-dec li")].map(li => li.textContent.trim()),
      open: d ? d.open : null,
      pls: document.querySelectorAll('[data-panel="scores"] .pl').length,
      cards: document.querySelectorAll('[data-panel="scores"] .game').length,
      marked: window.__plMark === 1,
    };
  }, pick);

  await page.evaluate(F => window.__plFixture(F), fixture(games));
  await page.waitForTimeout(80);
  const one = pick ? await readPl() : null;
  check("pl: the matchup card shows a players-left block", !!one, JSON.stringify(one));
  check("pl: each side's count is its starters less those whose games are final (bye, no team and empty slots count 0)",
    one && one.a === handLeft(startersA, games) && one.b === handLeft(startersB, games) && one.a === 3 && one.b === 5,
    one && `${one.a} v ${one.b}, hand ${handLeft(startersA, games)} v ${handLeft(startersB, games)}`);
  check("pl: byes and clubless players are named as such, final ones are not listed",
    one && /Kittle bye/.test(one.aText) && /Agent no team/.test(one.aText) && !/Kelce/.test(one.aText) && !/Collins/.test(one.bText),
    one && one.aText);
  check("pl: kickoffs read in ET (in progress, 1:00 PM, SNF)",
    one && /Lamb live/.test(one.aText) && /Nabers Sun 1:00 PM/.test(one.bText) && /Hill SNF/.test(one.bText) && /Bowers Sun 4:25 PM/.test(one.aText),
    one && `${one.aText} | ${one.bText}`);
  // By hand: DAL@PHI holds Lamb, Barkley v Prescott, Hurts, Brown; then one each, earliest first; HOU@KC is final.
  const handDec = ["DAL @ PHI: 2 v 3", "NYG @ WAS: 0 v 1", "LV @ DEN: 1 v 0"];
  check("pl: deciding games ranked by starters in them, final games dropped, top 3",
    one && JSON.stringify(one.dec) === JSON.stringify(handDec), one && JSON.stringify(one.dec));
  check("pl: the deciding games are open on desktop", one && one.open === true);

  // Phone width: re-render so the ranking folds away, then nothing may poke out.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(F => window.__plFixture(F), fixture(games));
  await page.waitForTimeout(120);
  const narrowPl = await page.evaluate(() => {
    const W = document.documentElement.clientWidth;
    const nodes = [...document.querySelectorAll('[data-panel="scores"] .pl')];
    const over = nodes.filter(n => n.scrollWidth > n.clientWidth + 1 || n.getBoundingClientRect().right > W + 0.5).length;
    const small = [...document.querySelectorAll('[data-panel="scores"] .pl, [data-panel="scores"] .pl *')]
      .filter(n => parseFloat(getComputedStyle(n).fontSize) < 11).length;
    const d = document.querySelector('[data-panel="scores"] .pl-dec');
    return { n: nodes.length, over, small, doc: document.documentElement.scrollWidth, W, closed: d ? !d.open : null };
  });
  check("pl: no horizontal overflow at 390px", narrowPl.n > 0 && narrowPl.over === 0 && narrowPl.doc <= narrowPl.W,
    JSON.stringify(narrowPl));
  check("pl: deciding games collapse behind a toggle at 390px", narrowPl.closed === true);
  check("pl: nothing in the block is set below 11px", narrowPl.small === 0, `${narrowPl.small}`);
  await page.setViewportSize({ width: 1280, height: 900 });

  // Every game final: "all done", no list.
  await page.evaluate(F => window.__plFixture(F), fixture(games.map(g => ({ ...g, status: "complete" }))));
  await page.waitForTimeout(80);
  const done = pick ? await readPl() : null;
  check("pl: an all-final week reads \"all done\" with no list",
    done && /all done/.test(done.text) && !/\(/.test(done.text) && done.dec.length === 0, done && done.text);

  // A refresh with DAL@PHI gone final updates the same card's text without a reload.
  await page.evaluate(F => window.__plFixture(F), fixture(games));
  await page.waitForTimeout(80);
  const before = await readPl();
  await page.evaluate(() => { window.__plMark = 1; });
  const later = games.map(g => (g.home === "PHI" ? { ...g, status: "complete" } : g));
  await page.evaluate(F => window.__plFixture(F), fixture(later));
  await page.waitForTimeout(80);
  const after = await readPl();
  check("pl: a refresh updates the text in place",
    before && after && after.marked && after.a === handLeft(startersA, later) && after.b === handLeft(startersB, later)
      && after.text !== before.text && after.pls === before.pls && after.cards === before.cards
      && !after.dec.some(s => s.startsWith("DAL @ PHI")),
    after && `${after.a} v ${after.b}; ${JSON.stringify(after.dec)}`);

  await page.evaluate(() => window.__plFixture(null));
}

/* ------------------------------------------------------------------------
 * Position rooms: each team's starters by slot type, per game, ranked across
 * the league. One team's numbers are recomputed here straight from Sleeper's
 * matchup rows and the league's roster_positions, not from anything the page
 * kept, so a slot mapped to the wrong room or a game miscounted shows up.
 * ---------------------------------------------------------------------- */
group("Position rooms");
{
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.click('#tabs button[data-tab="power"]');
  await page.waitForTimeout(150);
  const pr = await page.evaluate(async () => {
    const D = window.__DFFL, s = D.DB.seasons[0];
    const POS = ["QB", "RB", "WR", "TE", "FLEX"];
    const rows = D.positionRooms;
    const panel = document.querySelector('[data-panel="power"]');
    const sec = panel.querySelector('[data-section="rooms"]');
    const board = panel.querySelector(".rows");
    const regWeeks = [...s.finalWeeks].filter(w => w < s.pws).sort((a, b) => a - b);
    const out = {
      isArray: Array.isArray(rows), n: rows ? rows.length : 0, regWeeks: regWeeks.length,
      sec: !!sec, title: sec ? (sec.querySelector(".sechead h2") || {}).textContent : null,
      afterBoard: !!(sec && board && (board.compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING)),
      text: sec ? sec.innerText : "",
      emptyOk: D.positionRoomsOf({ regEntries: new Map(), games: [] }, null).rows.length === 0,
    };
    if (!out.n) return out;

    out.fiveEach = rows.every(r => Object.keys(r.rooms).length === 5 && POS.every(p => r.rooms[p]
      && isFinite(r.rooms[p].ppg) && isFinite(r.rooms[p].diff) && Number.isInteger(r.rooms[p].rank)));
    out.badPerm = POS.filter(p => {
      const rk = rows.map(r => r.rooms[p].rank).sort((a, b) => a - b);
      return !rk.every((v, i) => v === i + 1);
    });
    // more points never ranks lower, and diff is ppg less the league average
    out.badOrder = POS.filter(p => rows.some(a => rows.some(b => a.rooms[p].ppg > b.rooms[p].ppg + 1e-9 && a.rooms[p].rank > b.rooms[p].rank)));
    out.badDiff = POS.filter(p => {
      const avg = rows.reduce((t, r) => t + r.rooms[p].ppg, 0) / rows.length;
      return rows.some(r => Math.abs(r.rooms[p].diff - (r.rooms[p].ppg - avg)) > 1e-6);
    });

    // Independent recompute from Sleeper for the first and last team.
    const API = "https://api.sleeper.app/v1";
    const lg = await (await fetch(`${API}/league/${s.leagueId}`)).json();
    const slots = lg.roster_positions || [];
    const weekRows = [];
    for (const w of regWeeks) weekRows.push(await (await fetch(`${API}/league/${s.leagueId}/matchups/${w}`)).json());
    out.recompute = [rows[0], rows[rows.length - 1]].map(team => {
      let games = 0;
      const sum = { QB: 0, RB: 0, WR: 0, TE: 0, FLEX: 0 };
      for (const d of weekRows) {
        const e = (d || []).find(x => x.roster_id === team.rid);
        if (!e || e.matchup_id == null) continue;
        games++;
        (e.starters || []).forEach((pid, i) => {
          if (!(slots[i] in sum)) return;
          const v = Number((e.players_points || {})[pid]);
          if (isFinite(v)) sum[slots[i]] += v;
        });
      }
      return { rid: team.rid, games, mism: POS.filter(p => !games || Math.abs(sum[p] / games - team.rooms[p].ppg) > 1e-6)
        .map(p => `${p}: test ${games ? (sum[p] / games).toFixed(3) : "no games"} vs page ${team.rooms[p].ppg.toFixed(3)}`) };
    });
    out.slotsRead = slots.join(",");

    // Hints name only real managers, never the manager themself, and only real bench players.
    const names = new Set([...D.DB.mgr.values()].map(m => m.name));
    const rostered = await D.loadRostered();
    const playerNames = new Set([...rostered.map.values()].map(p => p.n));
    const HEAD = /^Weakest room: (QB|RB|WR|TE|FLEX) \((\d+)(?:st|nd|rd|th)\)\.(?: (.+)\.)?$/;
    const CLAUSE = /^(.+?) has the (?:\d+(?:st|nd|rd|th)-)?deepest (QB|RB|WR|TE|FLEX) bench(?: \((.+)\))? and needs (?:an? (?:QB|RB|WR|TE)|FLEX help), where you rank \d+(?:st|nd|rd|th)$/;
    out.badHints = [];
    out.partnered = 0;
    for (const r of rows) {
      const own = nameOf(r.uid);
      const m = HEAD.exec(r.hint || "");
      if (!m) { out.badHints.push(`${own}: unparsed "${r.hint}"`); continue; }
      const worst = Math.max(...POS.map(p => r.rooms[p].rank));
      if (Number(m[2]) !== r.rooms[m[1]].rank || r.rooms[m[1]].rank !== worst) out.badHints.push(`${own}: ${m[1]} is not the weakest room`);
      if (!m[3]) continue;
      const clauses = m[3].split("; ");
      if (clauses.length > 2) out.badHints.push(`${own}: ${clauses.length} partners`);
      clauses.forEach((c, i) => {
        const k = CLAUSE.exec(c);
        if (!k) { out.badHints.push(`${own}: unparsed clause "${c}"`); return; }
        if (!names.has(k[1]) || k[1] === own) out.badHints.push(`${own}: names "${k[1]}"`);
        if (k[2] !== m[1]) out.badHints.push(`${own}: partner bench is ${k[2]}, weakest is ${m[1]}`);
        const partner = r.partners[i] && nameOf(r.partners[i]);
        if (partner !== k[1]) out.badHints.push(`${own}: text names ${k[1]}, data ${partner}`);
        if (k[3] && !playerNames.has(k[3])) out.badHints.push(`${own}: "${k[3]}" is not a rostered player`);
        out.partnered++;
      });
    }

    // The page itself: a row per manager, each with five rooms and its hint; three green and three red per room.
    if (!sec) return out;
    const domRows = [...sec.querySelectorAll(".rmrow:not(.avg)")];
    out.domRows = domRows.length;
    out.domCells = domRows.every(n => n.querySelectorAll(".rmc").length === 5);
    out.domHints = domRows.every(n => {
      const r = rows.find(x => x.uid === n.dataset.uid);
      return r && n.querySelector(".hint").textContent === r.hint;
    });
    out.topBot = POS.map(p => [sec.querySelectorAll(`.rmc.top[data-room="${p}"]`).length, sec.querySelectorAll(`.rmc.bot[data-room="${p}"]`).length]);
    const first = domRows[0] ? [...domRows[0].querySelectorAll(".rmc")].map(c => Math.round(c.getBoundingClientRect().top)) : [];
    out.oneLine = first.length === 5 && new Set(first).size === 1;
    out.avgRow = !!sec.querySelector(".rmrow.avg") && POS.every(p => sec.querySelector(`.rmrow.avg .rmc[data-room="${p}"] .pos-dot`));
    return out;
  });

  check("rooms: the section renders on the Power tab", pr.sec && pr.title === "Position rooms", String(pr.title));
  check("rooms: the section sits after the power rankings", pr.afterBoard);
  check("rooms: window.__DFFL.positionRooms is an array", pr.isArray);
  check("rooms: no finished week builds no rooms", pr.emptyOk);
  if (!pr.regWeeks) {
    check("rooms: before week 1 is final the section says so", /Position rooms start after week 1 is final\./.test(pr.text) && pr.n === 0, pr.text.slice(0, 120));
  } else {
    check("rooms: one entry per manager", pr.n === 12, `${pr.n}`);
    check("rooms: every manager has 5 rooms with finite numbers", pr.fiveEach);
    check("rooms: each position's ranks are a permutation of 1..N", pr.badPerm.length === 0, pr.badPerm.join(","));
    check("rooms: more points per game never ranks lower", pr.badOrder.length === 0, pr.badOrder.join(","));
    check("rooms: diff is per-game points less the league average", pr.badDiff.length === 0, pr.badDiff.join(","));
    check("rooms: the league's roster_positions carry every room", ["QB", "RB", "WR", "TE", "FLEX"].every(p => pr.slotsRead.split(",").includes(p)), pr.slotsRead);
    for (const t of pr.recompute) {
      check(`rooms: roster ${t.rid}'s per-game points match a fresh recompute from Sleeper's matchups (${t.games} games)`,
        t.games > 0 && t.mism.length === 0, t.mism.join(" | "));
    }
    check("rooms: hints are well formed and name only real managers and rostered players", pr.badHints.length === 0, pr.badHints.slice(0, 4).join(" | "));
    console.log(`       (${pr.partnered} trade partners named across ${pr.n} hints)`);
    check("rooms: a row per manager on the page, five rooms each", pr.domRows === pr.n && pr.domCells, `${pr.domRows} rows`);
    check("rooms: each row shows its own hint", pr.domHints);
    check("rooms: three top and three bottom rooms marked per position", !!pr.topBot && pr.topBot.every(([t, b]) => t === 3 && b === 3), JSON.stringify(pr.topBot));
    check("rooms: desktop lays the five rooms on one line", pr.oneLine);
    check("rooms: the league average is shown for every position", pr.avgRow);
    check("rooms: the roster-weeks note is present",
      pr.text.includes("Points only count weeks a player was on that roster, so a recent pickup or trade arrival is credited only from the week he joined."));
  }

  await mobile.click('#tabs button[data-tab="power"]');
  await mobile.waitForTimeout(150);
  const roomsNarrow = await mobile.evaluate(() => {
    const sec = document.querySelector('[data-panel="power"] [data-section="rooms"]');
    const W = window.innerWidth, over = [];
    for (const n of sec ? [sec, ...sec.querySelectorAll("*")] : []) {
      const r = n.getBoundingClientRect();
      if (r.width && (r.right > W + 1 || r.left < -1 || r.width > W)) over.push(`${n.className || n.tagName} → ${Math.round(r.left)}..${Math.round(r.right)}`);
      if (n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== "hidden" && !n.classList.contains("n"))
        over.push(`${n.className || n.tagName} scrolls ${n.scrollWidth} > ${n.clientWidth}`);
    }
    const rows = sec ? [...sec.querySelectorAll(".rmrow:not(.avg)")] : [];
    return { sec: !!sec, over: over.slice(0, 6), doc: document.documentElement.scrollWidth, W, rows: rows.length,
      dots: rows.length ? [...rows[0].querySelectorAll(".rmc .pos-dot")].filter(d => d.getBoundingClientRect().width > 0).length : 5 };
  });
  check("rooms: the section renders at 390px", roomsNarrow.sec);
  check("rooms: nothing in the section is wider than the viewport at 390px", roomsNarrow.over.length === 0 && roomsNarrow.doc <= roomsNarrow.W,
    roomsNarrow.over.join(" | ") || `${roomsNarrow.doc} > ${roomsNarrow.W}`);
  check("rooms: phone cards label each of the five rooms", roomsNarrow.dots === 5, `${roomsNarrow.dots}`);
}

/* The Injuries tab: every injured player on every roster, bench included, with
 * his projected points lost this week and for the rest of the season. Run in a fresh context at
 * phone width so the tab reads injuries.json itself rather than a cache another
 * page wrote, and so the layout checks see the narrow screen. */
group("Injuries tab");
const injCtx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const injPage = await injCtx.newPage();
const injErrs = [];
injPage.on("pageerror", e => injErrs.push(String(e)));
const injRoute = async () => {
  try {
    await injPage.waitForFunction(() => document.body.dataset.ready, null, { timeout: 90000 });
    await injPage.waitForFunction(() => {
      const p = document.querySelector('[data-panel="injuries"]');
      return p && p.dataset.ready === "1";
    }, null, { timeout: 60000 });
  } catch (e) {
    return { timedOut: String(e).split("\n")[0] };
  }
  return injPage.evaluate(() => {
    const p = document.querySelector('[data-panel="injuries"]');
    const b = document.querySelector('#tabs button[data-tab="injuries"]');
    return { hash: location.hash, tab: !!b, label: b && b.textContent, selected: b && b.getAttribute("aria-selected"),
      visible: !!p && !p.hidden, others: [...document.querySelectorAll("#app > .panel")].filter(x => x !== p && !x.hidden).length };
  });
};
await injPage.goto(BASE + "#injuries", { waitUntil: "domcontentloaded" });
const injDirect = await injRoute();
check("injuries: the tab is in the tab row", injDirect.tab && injDirect.label === "Injuries", `${injDirect.label}`);
check("injuries: #injuries opens the tab on a direct load", injDirect.visible && injDirect.selected === "true"
  && injDirect.others === 0 && injDirect.hash === "#injuries", JSON.stringify(injDirect));
await injPage.reload({ waitUntil: "domcontentloaded" });
const injReload = await injRoute();
check("injuries: and again on reload", injReload.visible && injReload.selected === "true" && injReload.hash === "#injuries",
  JSON.stringify(injReload));
// The Injuries tab (Research's playoff-odds view) and projectedPointsLost() underneath it.
const PL_NAMES = [
  "points lost: the tab loads data/projections.json",
  "points lost: the source label reads Sleeper projections, ESPN return dates",
  "injuries tab: rows are injuryLossPlan's rows, the ones the odds worker measures",
  "injuries tab: each row leads with its playoff odds impact as a hero −X.X% labelled playoff odds, ~0% under 0.5",
  "injuries tab: title odds and lineup points are secondary: −X.X% title, pts/wk in lineup × wks = total pts",
  "injuries tab: bench players are tagged bench; players who wouldn't start cost 0 pts",
  "injuries tab: the return source and its checked date are shown beside the return",
  "injuries tab: with injuryPlayoffDeltas() null every row reads calculating…",
  "injuries tab: rows sorted by playoff impact, most negative first, unmeasured last",
  "injuries tab: each team's lineup pts lost is the sum of its rows; teams sorted by it",
  "injuries tab: the method text explains the playoff odds, the points and the cap",
  "points lost: an independent re-implementation agrees on every row and team",
  "points lost: return fields — a date wins over retWeeks, retWeeks alone sets the weeks, neither keeps the old rule",
  "points lost: return fields — rows carry retSource, estimated and retNote; the tab shows the source and an estimated tag",
  "points lost: a hurt player projected at 0 uses his last projection above zero, else season PPG; a bye stays 0",
  "points lost: last_nonzero/ppg cover injured rostered players only; fallback used only on 0 non-bye weeks",
  "points lost: a FLEX slot takes the best RB/WR/TE; a fixed RB/WR slot never takes another position",
  "points lost: a bench injury that wouldn't start costs 0; one that would start costs the lineup drop",
  "points lost: a team with a no-estimate row marks its rest-of-season total partial",
  "points lost: De'Von Achane (IR) no longer reads 0 for the rest of the season",
  "points lost: no-estimate rows show no rest-of-season number and stay out of the total",
  "points lost: a Questionable starter carries his full loss and a status tag",
  "points lost: this week's stand-ins are healthy players entering the best lineup",
  "points lost: a made-up report proves the replacement, weeks-out and IR rules",
  "points lost: without data/projections.json the tab says so",
  "points lost: rest of season is each out player's share of the best-lineup drop, starters included",
  "points lost: the stand-in is who enters the rebuilt lineup, never an injured player; else lineup shuffle",
  "points lost: this week is the same best-lineup drop as rest of season, so both figures on a row mean the same thing",
  "points lost: splitLineupDrop shares the drop by (with - with minus just him), scaled to the drop; all 0 -> even",
  "points lost: IR with no date reads season (IR), not no estimate",
  "points lost: retWeeks without a date reads ~N wk (est.) with its source, never no estimate",
  "odds fallback: without projections the old multiplier path is origin/main's, byte for byte"];
// With the tab missing or never ready, name every check below as failed
// rather than letting a timeout take the whole run down.
const INJ_NAMES = ["injuries: the tab reads the published injuries.json and shows its timestamp",
  "injuries: every injured rostered player in injuries.json appears", "injuries: each one is grouped under his own team",
  "injuries: nobody is listed who isn't injured and rostered",
  "injuries: a player with no return date says no estimate", "injuries: a return date reads as the site's return label",
  "injuries: a past return date reads as was expected back",
  "injuries: an empty report says nobody is hurt",
  ...PL_NAMES, "injuries: rows render at 390px",
  "injuries: no element in the tab overflows at 390px", "injuries: stacked rows, not a sideways table",
  "injuries: no text in the tab under 11px at 390px", "injury report: every team lists every injured player on its roster",
  "injury report: bench injured players are included, at 0%", "injury report: each team's total matches its charged per-player cuts", "injury report: each starter carries the model's charged cut",
  "injuries: no uncaught page errors"];
if (injDirect.timedOut || injReload.timedOut) {
  for (const n of INJ_NAMES) check(n, false, `skipped: ${injDirect.timedOut || injReload.timedOut}`);
} else try {

const injData = await injPage.evaluate(async () => {
  const D = window.__DFFL;
  const file = await fetch("injuries.json", { cache: "no-cache" }).then(r => r.json());
  const map = new Map(Object.entries(file.map || {}));
  const season = D.DB.seasons[0];
  const panel = document.querySelector('[data-panel="injuries"]');
  const out = { at: Number(panel.querySelector(".srcnote").dataset.at), fileAt: file.at,
    expected: 0, missing: [], misplaced: [], extra: [], noRet: 0, noRetBad: [], retBad: [] };
  const want = new Map();
  for (const r of season.rosters || []) {
    const ids = new Set([...(r.starters || []), ...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])]
      .filter(p => p && p !== "0").map(String));
    const st = new Set((r.starters || []).map(String));
    for (const pid of ids) {
      const rec = map.get(pid);
      if (!rec) continue;
      want.set(pid, { rid: String(r.roster_id), starter: st.has(pid), rec });
    }
  }
  out.expected = want.size;
  const shown = new Map();
  for (const row of panel.querySelectorAll(".injteam .injp")) {
    shown.set(row.dataset.pid, row);
  }
  for (const [pid, w] of want) {
    const row = shown.get(pid);
    if (!row) { out.missing.push(`${w.rec.n} (${pid})`); continue; }
    if (row.closest(".injteam").dataset.rid !== w.rid) out.misplaced.push(w.rec.n);
    const ret = row.querySelector(".ret").textContent.trim();
    const rw = !/^\d{4}-\d{2}-\d{2}/.test(String(w.rec.ret || "")) && Number(w.rec.retWeeks) > 0 ? Math.round(Number(w.rec.retWeeks)) : 0;
    if (rw) { if (ret !== (w.rec.retEstimated ? `~${rw} wk (est.)` : `${rw} wk`)) out.noRetBad.push(`${w.rec.n}: ${ret}`); }
    else if (!w.rec.ret) {
      out.noRet++;
      // IR with no date runs to season's end; anything else with no date has no estimate.
      if (ret !== (w.rec.s === "IR" ? "season (IR)" : "no estimate")) out.noRetBad.push(`${w.rec.n}: ${ret}`);
    }
    else if (ret !== D.returnLabel(w.rec.ret)) out.retBad.push(`${w.rec.n}: ${ret}`);
  }
  for (const pid of shown.keys()) if (!want.has(pid)) out.extra.push(pid);

  // A starter with no return date, so the no-estimate path is proven whatever
  // this week's feed happens to hold.
  const r0 = (season.rosters || []).find(r => (r.starters || []).some(p => p && p !== "0"));
  const sp = String(r0.starters.find(p => p && p !== "0"));
  const host = document.createElement("div");
  D.renderInjuries(host, { at: Date.now(), source: "file", map: new Map([[sp, { s: "Out", n: "Fake Starter", p: "WR", t: "KC" }]]) });
  const fs = host.querySelector(`.injp[data-pid="${sp}"]`);
  out.fake = { starterRet: fs && fs.querySelector(".ret").textContent };
  const none = document.createElement("div");
  D.renderInjuries(none, { at: Date.now(), source: "file", map: new Map() });
  const past = new Date(); past.setDate(past.getDate() - 12);
  const iso = `${past.getFullYear()}-${String(past.getMonth() + 1).padStart(2, "0")}-${String(past.getDate()).padStart(2, "0")}`;
  out.pastLabel = D.returnLabel(iso);
  out.emptyState = !!none.querySelector(".empty") && !none.querySelector(".injteam");

  /* ---- projected points lost ---- */
  const projRes = await fetch("data/projections.json", { cache: "no-cache" });
  const proj = projRes.ok ? await projRes.json() : null;
  const rost = await fetch("rosters.json", { cache: "no-cache" }).then(r => r.json());
  const pl = out.pl = { projOk: !!proj, week: D.DB.state && D.DB.state.week, rosters: (season.rosters || []).map(r => ({
    roster_id: r.roster_id, starters: r.starters, players: r.players, reserve: r.reserve, taxi: r.taxi })) };
  pl.text = panel.textContent;
  pl.srcLabel = (panel.querySelector(".ptsrc") || {}).textContent || "";
  // The playoff-odds view: Research's injuryLossPlan rows, led by each one's
  // measured playoffDelta. The tab re-rendered with deltas stubbed in (and,
  // separately, with the worker not done) so the format, order and placeholder
  // are checked whatever the live worker has finished.
  const rostered = await D.loadRostered();
  const tabOf = host => [...host.querySelectorAll(".injteam")].map(b => ({
    rid: b.dataset.rid, lost: b.dataset.lost === "" ? null : Number(b.dataset.lost),
    lostText: b.querySelector(".tc .tm-pts").textContent,
    rows: [...b.querySelectorAll(".injp")].map(r => ({
      pid: r.dataset.pid, starter: r.dataset.starter === "1", lost: r.dataset.lost === "" ? null : Number(r.dataset.lost),
      lead: r.firstElementChild && r.firstElementChild.classList.contains("imp") && r.firstElementChild.firstElementChild
        ? r.firstElementChild.firstElementChild.textContent : null,
      label: (r.querySelector(".imp .pol") || {}).textContent || null,
      title: (r.querySelector(".imp .ti") || {}).textContent || null,
      pts: (r.querySelector(".meta.pts .ptl") || {}).textContent || "",
      benchTag: !!r.querySelector(".meta.pts .tag.bench"), benchCls: r.classList.contains("bench"),
      status: r.querySelector(".st").textContent, src: (r.querySelector(".rsrc") || {}).textContent || "",
      text: r.textContent,
    })),
  }));
  pl.shown = tabOf(panel);
  const injObj = { at: Date.now(), source: "file", map };
  const loss = D.attachLossPlan(D.injuryPlan(season, injObj, window.__ODDS), season, injObj, proj, rostered).loss;
  pl.lossTeams = loss ? [...loss.byTeam.values()].map(T => ({ rid: String(T.rid),
    rows: T.rows.map(x => ({ pid: String(x.pid), bench: !!x.bench, wouldStart: x.wouldStart, weeksOut: x.weeksOut,
      lineupPerWeek: x.lineupPerWeek, totalLost: x.totalLost * x.weight, retLabel: x.retLabel || "", retSource: x.retSource })) })) : null;
  const realDeltas = INJ_DELTAS;
  try {
    // Stubbed measurements: spread from −9.9 to +0.4, one row left unmeasured.
    const pids = pl.lossTeams ? pl.lossTeams.flatMap(t => t.rows.map(x => x.pid)) : [];
    const stub = new Map(pids.slice(1).map((pid, i) => [pid,
      { rosterId: 0, playoffDelta: i % 5 === 4 ? 0.4 : -((i * 1.37) % 9.9) - 0.5, titleDelta: -((i * 0.61) % 4), sims: 1 }]));
    pl.stubbed = { unmeasured: pids[0] || null, deltas: Object.fromEntries([...stub].map(([k, v]) => [k, [v.playoffDelta, v.titleDelta]])) };
    INJ_DELTAS = stub;
    const hs = document.createElement("div");
    D.renderInjuries(hs, injObj, proj, rostered);
    pl.stubTab = tabOf(hs);
    pl.stubFmt = [D.fmtInjuryDelta(-3.456, "%"), D.fmtInjuryDelta(0.49, "%"), D.fmtInjuryDelta(-0.5, "%"), D.fmtInjuryDelta(null, "%")];
    // The worker not done yet.
    INJ_DELTAS = null;
    const hn = document.createElement("div");
    D.renderInjuries(hn, injObj, proj, rostered);
    pl.nullTab = tabOf(hn);
    pl.nullPending = D.injuryPlayoffDeltas() === null;
  } finally { INJ_DELTAS = realDeltas; }
  pl.capPct = Math.round(D.INJ_ODDS.cap * 100);
  pl.capNote = new RegExp(`capped at ${pl.capPct}% of its strength`).test(((panel.querySelector(".injkey") || {}).textContent || "").replace(/\s+/g, " "));
  pl.explainers = ["injodds", "injlost", "injstatus"].every(k => panel.querySelector(`.jx[data-jx="${k}"]`) && D.JARGON[k]);
  // The page's own pure function over the same inputs.
  const opts = D.pointsLostOpts();
  pl.fn = (season.rosters || []).map(r => {
    const L = D.projectedPointsLost(r, map, proj, opts);
    return { rid: String(r.roster_id), thisWeek: L.thisWeek, ros: L.ros, estimated: L.estimated,
      rosRows: L.rosRows, partial: L.partial,
      rows: L.rows.map(x => ({ pid: x.pid, thisWeek: x.thisWeek, ros: x.ros,
        hurt: x.perWeek.map(p => [p.week, p.hurt]),
        repls: x.perWeek.map(p => [p.week, p.repl]).concat(x.starter && x.twRepl ? [["tw", x.twRepl]] : []) })) };
  }).filter(t => t.rows.length);
  pl.rostMap = rost.map;
  pl.slots = season.rosterPositions;

  // Slots, worked by hand: R1 (RB slot, 15), W1 (WR slot, 14) and F1 (WR in
  // the FLEX, 13) are out with no date. Bench RB3 10, RB2 4, TE1 9, WZ (WR, 0).
  // Best lineup without them: RB RB3 10, WR nobody (WZ projects 0 and an RB/TE
  // may not fill a WR slot, though RB2 sits idle), FLEX TE1 9 (the best
  // RB/WR/TE left) = 19, vs 42 with them: 23. Margins: without R1 RB3 enters
  // at RB (37 -> 5); without W1 F1 slides to WR and RB3 enters the FLEX (38 ->
  // 4); without F1 RB3 takes the FLEX (39 -> 3). Shares 23 x 5/12, 4/12, 3/12.
  const slP = { current_week: 6, playoff_week_start: 7, sundays: { 6: "2026-10-18" },
    weeks: { 6: { R1: 15, W1: 14, F1: 13, RB2: 4, RB3: 10, TE1: 9, WZ: 0 } } };
  const slPos = { R1: "RB", W1: "WR", F1: "WR", RB2: "RB", RB3: "RB", TE1: "TE", WZ: "WR" };
  const SL = D.projectedPointsLost({ starters: ["R1", "W1", "F1"], players: Object.keys(slPos), reserve: [], taxi: [] },
    new Map(["R1", "W1", "F1"].map(p => [p, { s: "Out", n: p, p: slPos[p] }])), slP,
    { week: 6, player: pid => ({ n: pid, p: slPos[pid] }), slots: ["RB", "WR", "FLEX", "BN", "BN", "BN", "BN"] });
  pl.slotFake = { tw: SL.thisWeek, rows: Object.fromEntries(SL.rows.map(r => [r.pid, [r.thisWeek, r.repl && r.repl.pid, r.slot]])) };

  // Bench injuries, worked by hand: lineup QB Q 20, RB R 10, WR W 10, FLEX F
  // (RB) 8; bench H (TE) 7. B1 (WR, IR slot, no date) projects 6 then 15; B2
  // (RB, bench, out to Oct 20 = week 6 only) 5. Week 6: neither beats anybody,
  // best lineup 48 with them and without -> 0. Week 7: B1 takes the WR slot,
  // W slides to FLEX: 55 vs 48 -> B1 costs 7. B2 0 all along.
  const bnP = { current_week: 6, playoff_week_start: 8, sundays: { 6: "2026-10-18", 7: "2026-10-25" },
    weeks: { 6: { Q: 20, R: 10, W: 10, F: 8, H: 7, B1: 6, B2: 5 }, 7: { Q: 20, R: 10, W: 10, F: 8, H: 7, B1: 15, B2: 5 } } };
  const bnPos = { Q: "QB", R: "RB", W: "WR", F: "RB", H: "TE", B1: "WR", B2: "RB" };
  const BN = D.projectedPointsLost({ starters: ["Q", "R", "W", "F"], players: Object.keys(bnPos), reserve: ["B1"], taxi: [] },
    new Map(Object.entries({ B1: { s: "IR", n: "B1", p: "WR" }, B2: { s: "Out", n: "B2", p: "RB", ret: "2026-10-20" } })), bnP,
    { week: 6, player: pid => ({ n: pid, p: bnPos[pid] }), slots: ["QB", "RB", "WR", "FLEX", "BN", "BN", "BN"] });
  pl.benchFake = { tw: BN.thisWeek, ros: BN.ros,
    rows: Object.fromEntries(BN.rows.map(r => [r.pid, { tw: r.thisWeek, ros: r.ros, lost: r.perWeek.map(w => w.lost) }])) };

  // A made-up team, worked by hand (see the expectations in the check below).
  const fakeProj = { current_week: 6, playoff_week_start: 9,
    sundays: { 6: "2026-10-18", 7: "2026-10-25", 8: "2026-11-01" },
    weeks: { 6: { A: 20, B: 15, C: 18, D: 8, E: 10, F: 12, G: 0, H: 5 },
             7: { A: 20, B: 15, C: 18, D: 8, E: 10, F: 12, G: 9, H: 5 } } };
  const fakeInj = new Map(Object.entries({
    A: { s: "Out", n: "A", p: "WR" },
    B: { s: "Questionable", n: "B", p: "RB", ret: "2026-10-30" },
    E: { s: "Questionable", n: "E", p: "RB" },
    F: { s: "Out", n: "F", p: "WR", ret: "2026-10-25" },
    G: { s: "IR", n: "G", p: "TE" },
    H: { s: "IR", n: "H", p: "K", ret: "2026-10-20" },
  }));
  const pos = { C: "QB", D: "WR" };
  const L = D.projectedPointsLost({ starters: ["A", "B", "C"], players: ["A", "B", "C", "D", "E", "F", "G", "H"], reserve: ["G", "H"], taxi: [] },
    fakeInj, fakeProj, { week: 6, player: pid => (pos[pid] ? { n: pid, p: pos[pid] } : null),
      slots: ["WR", "RB", "QB", "BN", "BN", "BN", "BN", "BN"] });
  pl.fake = { thisWeek: L.thisWeek, ros: L.ros, order: L.rows.map(r => r.pid).join(""),
    rows: Object.fromEntries(L.rows.map(r => [r.pid, { tw: r.thisWeek, ros: r.ros, wo: r.weeksOut && r.weeksOut.join(","),
      repl: r.repl && r.repl.pid }])) };
  // The hurt-player fallback, worked by hand: P (RB, MIA), Q (WR, BUF) and Z
  // (TE, NYJ) are IR starters (no date: weeks 6-7). P is 0 both weeks with
  // last_nonzero 14 (wk 3) and PPG 9 -> 14 in week 6; week 7 is MIA's bye -> 0.
  // Q is 12 in week 6 and 0 in week 7 -> week 6's 12 (latest published week
  // above 0) in both. Z is 0 with no last_nonzero -> PPG 6. Bench R (RB) 4,
  // S (WR) 3, no TE. This week 14-4 + 12-3 + 6 = 25; rest of season P 10,
  // Q 9 + 9 = 18, Z 12 -> 40. Setting off: only Q's real 12 counts -> 9 and 9.
  const fbProj = { current_week: 6, playoff_week_start: 8, sundays: { 6: "2026-10-18", 7: "2026-10-25" },
    weeks: { 6: { P: 0, Q: 12, Z: 0, R: 4, S: 3 }, 7: { P: 0, Q: 0, Z: 0, R: 4, S: 3 } },
    last_nonzero: { P: { week: 3, pts: 14 } }, ppg: { P: 9, Z: 6 }, byes: { 6: ["KC"], 7: ["MIA"] } };
  const fbInj = new Map(Object.entries({ P: { s: "IR", n: "P", p: "RB", t: "MIA" }, Q: { s: "IR", n: "Q", p: "WR", t: "BUF" },
    Z: { s: "IR", n: "Z", p: "TE", t: "NYJ" } }));
  const fbPos = { R: "RB", S: "WR" };
  const fbTeam = { starters: ["P", "Q", "Z"], players: ["P", "Q", "Z", "R", "S"], reserve: [], taxi: [] };
  const fbOpt = { week: 6, player: pid => (fbPos[pid] ? { n: pid, p: fbPos[pid] } : null), slots: ["RB", "WR", "TE", "BN", "BN"] };
  const FB = D.projectedPointsLost(fbTeam, fbInj, fbProj, fbOpt);
  const was = D.PTS_LOST.hurtFallback;
  D.PTS_LOST.hurtFallback = false;
  const FB0 = D.projectedPointsLost(fbTeam, fbInj, fbProj, fbOpt);
  D.PTS_LOST.hurtFallback = was;
  pl.fallback = { tw: FB.thisWeek, ros: FB.ros, off: [FB0.thisWeek, FB0.ros],
    rows: Object.fromEntries(FB.rows.map(r => [r.pid, [r.thisWeek, r.ros]])) };
  // Research's return fields (injury-returns.mjs), on a synthetic record: one
  // hurt WR starter, bench WR R at 2, everyone else 10 a week, so each week out
  // costs 8. X has a date (Oct 30: weeks 6-7) and retWeeks 3 — the date wins,
  // 16. Y has only retWeeks 3: weeks 6-8, 24. Z has neither: Out, no estimate.
  const rwP = { current_week: 6, playoff_week_start: 10,
    sundays: { 6: "2026-10-18", 7: "2026-10-25", 8: "2026-11-01", 9: "2026-11-08" },
    weeks: Object.fromEntries([6, 7, 8, 9].map(w => [w, { X: 10, Y: 10, Z: 10, R: 2 }])) };
  const rwRec = {
    X: { s: "Out", n: "X", p: "WR", ret: "2026-10-30", retWeeks: 3, retSource: "espn-return-date", retEstimated: false, retNote: "ESPN date" },
    Y: { s: "Out", n: "Y", p: "WR", retWeeks: 3, retSource: "report", retEstimated: true, retNote: "per the beat writer", retChecked: "2026-10-13" },
    Z: { s: "Out", n: "Z", p: "WR" },
  };
  const rwOne = id => D.projectedPointsLost({ starters: [id], players: [id, "R"], reserve: [], taxi: [] },
    new Map([[id, rwRec[id]]]), rwP, { week: 6, player: pid => ({ n: pid, p: "WR" }), slots: ["WR", "BN"] }).rows[0];
  const [rx, ry, rz] = ["X", "Y", "Z"].map(rwOne);
  pl.retFields = { x: [rx.ros, rx.weeksOut && rx.weeksOut.join(","), rx.retSource, rx.retEstimated, rx.retNote],
    y: [ry.ros, ry.weeksOut && ry.weeksOut.join(","), ry.retSource, ry.retEstimated, ry.retNote],
    z: [rz.ros, rz.weeksOut, rz.retSource, rz.retEstimated, rz.retNote] };
  // And on the tab: a real injured rostered player given these fields.
  const tagPid = [...map.keys()].find(pid => rost.map[pid] && map.get(pid) && map.get(pid).s);
  if (tagPid) {
    const m2 = new Map(map);
    m2.set(tagPid, { ...map.get(tagPid), retWeeks: undefined, retSource: "report", retEstimated: true, retNote: "synthetic" });
    const hostT = document.createElement("div");
    D.renderInjuries(hostT, { at: Date.now(), source: "file", map: m2 }, proj);
    const rowT = hostT.querySelector(`.injp[data-pid="${tagPid}"]`);
    pl.retTab = { pid: tagPid, src: rowT && (rowT.querySelector(".rsrc") || {}).textContent, est: !!(rowT && rowT.querySelector(".est")),
      title: rowT && rowT.title };
    // An exact-week report (weeks_list / dated ret -> retEstimated false) reads "reported".
    const m4 = new Map(map);
    m4.set(tagPid, { ...map.get(tagPid), ret: "2026-11-01", retWeeks: undefined, retWeeksList: undefined, retSource: "report", retEstimated: false, retNote: "synthetic" });
    const hostR = document.createElement("div");
    D.renderInjuries(hostR, { at: Date.now(), source: "file", map: m4 }, proj);
    const rowR = hostR.querySelector(`.injp[data-pid="${tagPid}"]`);
    pl.repTab = rowR ? [...rowR.querySelectorAll(".est")].map(e => e.textContent.trim()) : null;
  } else { pl.retTab = null; pl.repTab = null; }
  // ccubed's rest-of-season rule, by hand (week 6 only). (a) S1 (RB 12, IR)
  // starts at RB, S2 (RB 11) at FLEX, bench WR3 9 and no RB: this week the RB
  // slot has no RB -> 12; rest of season S2 slides to RB and WR3 enters the
  // FLEX: 23 vs 20 -> 3, stand-in WR3. (b) A (WR 10) and B (WR 6) out, bench
  // C 5, D 1: drop 16-6 = 10; margins 16-11 = 5 and 16-15 = 1 -> 8.33 / 1.67.
  // (c) A and B both 10, bench C 10: drop 10, both margins 0 -> 5 / 5.
  // (d) A (WR 10) out, only a Questionable WR enters -> "lineup shuffle".
  const cc = (players, pos, hurt, wk6, starters, slots, extra = {}) => D.projectedPointsLost(
    { starters, players, reserve: [], taxi: [] },
    new Map([...hurt.map(p => [p, { s: "IR", n: p, p: pos[p] }]), ...Object.entries(extra)]),
    { current_week: 6, playoff_week_start: 7, sundays: { 6: "2026-10-18" }, weeks: { 6: wk6 } },
    { week: 6, player: pid => ({ n: pid, p: pos[pid] }), slots });
  const ccA = cc(["S1", "S2", "WR3"], { S1: "RB", S2: "RB", WR3: "WR" }, ["S1"], { S1: 12, S2: 11, WR3: 9 }, ["S1", "S2"], ["RB", "FLEX", "BN"]);
  const ccB = cc(["A", "B", "C", "D"], { A: "WR", B: "WR", C: "WR", D: "WR" }, ["A", "B"], { A: 10, B: 6, C: 5, D: 1 }, ["A", "B"], ["WR", "WR", "BN", "BN"]);
  const ccC = cc(["A", "B", "C"], { A: "WR", B: "WR", C: "WR" }, ["A", "B"], { A: 10, B: 10, C: 10 }, ["A", "B"], ["WR", "WR", "BN"]);
  const ccD = cc(["A", "Q"], { A: "WR", Q: "WR" }, ["A"], { A: 10, Q: 8 }, ["A"], ["WR", "BN"], { Q: { s: "Questionable", n: "Q", p: "WR" } });
  const rowOf = (L, p) => L.rows.find(r => r.pid === p);
  pl.ccubed = {
    a: [rowOf(ccA, "S1").thisWeek, rowOf(ccA, "S1").ros, rowOf(ccA, "S1").perWeek[0].repl],
    b: [rowOf(ccB, "A").ros, rowOf(ccB, "B").ros, ccB.ros, rowOf(ccB, "A").perWeek[0].repl],
    c: [rowOf(ccC, "A").ros, rowOf(ccC, "B").ros],
    d: [rowOf(ccD, "A").ros, rowOf(ccD, "A").perWeek[0].repl, rowOf(ccD, "A").repl && rowOf(ccD, "A").repl.name],
    // This week by the same rule: (a) 3 not the old slot rule's 12; (b) and (c)
    // match their one-week rest of season exactly.
    tw: [rowOf(ccA, "S1").thisWeek, rowOf(ccB, "A").thisWeek, rowOf(ccB, "B").thisWeek, rowOf(ccC, "A").thisWeek, rowOf(ccC, "B").thisWeek],
  };
  // The shared split helper on its own: margins 5 and 1 of a 10 drop; all
  // margins 0 -> even; a negative margin counts as 0; nobody -> [].
  pl.split = { fn: typeof D.splitLineupDrop === "function",
    a: D.splitLineupDrop(10, 16, [11, 15]), b: D.splitLineupDrop(10, 20, [20, 20]),
    c: D.splitLineupDrop(5, 10, [12, 8]), d: D.splitLineupDrop(3, 7, []) };
  // IR with no date runs to season's end: "season (IR)", not "no estimate".
  if (tagPid) {
    const m4 = new Map(map), base = { ...map.get(tagPid), s: "IR", sev: undefined, retWeeks: undefined };
    delete base.ret;
    m4.set(tagPid, base);
    const h4 = document.createElement("div");
    D.renderInjuries(h4, { at: Date.now(), source: "file", map: m4 }, proj);
    const r4 = h4.querySelector(`.injp[data-pid="${tagPid}"]`);
    pl.irLabel = r4 && r4.querySelector(".ret").textContent;
  }
  // retWeeks without a date: "~N wk (est.)" plus the source, never "no estimate".
  if (tagPid) {
    const m3 = new Map(map), base = { ...map.get(tagPid) };
    delete base.ret;
    m3.set(tagPid, { ...base, retWeeks: 2, retSource: "espn-outlook", retEstimated: true });
    const h3 = document.createElement("div");
    D.renderInjuries(h3, { at: Date.now(), source: "file", map: m3 }, proj);
    const r3 = h3.querySelector(`.injp[data-pid="${tagPid}"]`);
    pl.rwLabel = r3 && { ret: r3.querySelector(".ret").textContent, src: (r3.querySelector(".rsrc") || {}).textContent || "",
      noEst: /no estimate/.test(r3.textContent) };
  }
  const noProj = document.createElement("div");
  D.renderInjuries(noProj, { at: Date.now(), source: "file", map }, null);
  pl.noProj = { msg: !!noProj.querySelector(".projnone"),
    numbers: [...noProj.querySelectorAll(".tm-pts, .imp, .meta.pts")].filter(e => /\d/.test(e.textContent)).length };
  return out;
});
check("injuries: the tab reads the published injuries.json and shows its timestamp",
  injData.at === injData.fileAt, `${injData.at} vs ${injData.fileAt}`);
check("injuries: every injured rostered player in injuries.json appears", injData.expected > 0 && injData.missing.length === 0,
  `${injData.missing.length}/${injData.expected} missing: ${injData.missing.slice(0, 4).join(", ")}`);
check("injuries: each one is grouped under his own team", injData.misplaced.length === 0, injData.misplaced.slice(0, 4).join(", "));
check("injuries: nobody is listed who isn't injured and rostered", injData.extra.length === 0, injData.extra.slice(0, 4).join(", "));
check("injuries: a player with no return date says no estimate", injData.noRetBad.length === 0
  && injData.fake.starterRet === "no estimate", `${injData.noRet} without; ${injData.noRetBad.slice(0, 3).join(" ; ")} fake=${injData.fake.starterRet}`);
check("injuries: a return date reads as the site's return label", injData.retBad.length === 0, injData.retBad.slice(0, 3).join(" ; "));
check("injuries: a past return date reads as was expected back", /^was expected back /.test(injData.pastLabel), injData.pastLabel);
check("injuries: an empty report says nobody is hurt", injData.emptyState);

/* Projected points lost. Every number is recomputed twice: by the page's own
 * projectedPointsLost() and by the small re-implementation below, written from
 * the definition rather than copied, over injuries.json, data/projections.json,
 * rosters.json and the live Sleeper rosters. */
{
  const PL = injData.pl;
  const injFileNow = JSON.parse(await readFile(join(ROOT, "injuries.json"), "utf8"));
  let projFile = null;
  try { projFile = JSON.parse(await readFile(join(ROOT, "data/projections.json"), "utf8")); } catch { /* missing */ }
  const fmt = v => (v >= 0.05 ? `−${(Math.round(v * 10) / 10).toFixed(1)}` : "0.0");
  const close = (a, b) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) < 0.006);

  // The re-implementation.
  const reimpl = (r) => {
    const inj = injFileNow.map, P = projFile;
    const last = P.playoff_week_start - 1, wk = Number(PL.week) || P.current_week;
    const published = Object.keys(P.weeks).map(Number);
    const projOf = (pid, w) => {
      if (P.weeks[w] && pid in P.weeks[w]) return P.weeks[w][pid];
      let best = null;
      for (const x of published) if (x < w && pid in P.weeks[x] && (best == null || x > best)) best = x;
      if (best == null) for (const x of published) if (x > w && pid in P.weeks[x] && (best == null || x < best)) best = x;
      return best == null ? 0 : P.weeks[best][pid];
    };
    const ids = a => (a || []).filter(p => p && p !== "0").map(String);
    const st = ids(r.starters), park = [...ids(r.reserve), ...ids(r.taxi)];
    const everyone = [...new Set([...st, ...ids(r.players), ...park])];
    const posOf = pid => (PL.rostMap[pid] && PL.rostMap[pid].p) || (inj[pid] && inj[pid].p) || "";
    const clubOf = pid => (PL.rostMap[pid] && PL.rostMap[pid].t) || (inj[pid] && inj[pid].t) || "";
    // A hurt player at 0 in a week his club plays: latest earlier published week
    // above 0, else last_nonzero, else PPG.
    const hurtOf = (pid, w) => {
      const v = projOf(pid, w);
      if (v > 0) return v;
      if (((P.byes || {})[w] || []).includes(clubOf(pid))) return 0;
      let x = null;
      for (const y of published) if (y < w && P.weeks[y][pid] > 0 && (x == null || y > x)) x = y;
      if (x != null) return P.weeks[x][pid];
      if (P.last_nonzero && P.last_nonzero[pid] && P.last_nonzero[pid].pts > 0) return P.last_nonzero[pid].pts;
      return (P.ppg && P.ppg[pid] > 0) ? P.ppg[pid] : 0;
    };
    const ELIG = { FLEX: ["RB", "WR", "TE"], SUPER_FLEX: ["QB", "RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"] };
    const fits = (slot, pid) => (ELIG[slot] || [slot]).includes(posOf(pid));
    const width = s => (ELIG[s] || [s]).length;
    // Slot index from the raw starters[], empty "0" slots included.
    const rawSt = (r.starters || []).map(String);
    const slotAt = i => PL.slots[i] || posOf(rawSt[i]);
    const slotList = PL.slots.filter(s => !["BN", "IR", "TAXI"].includes(s)).slice().sort((a, b) => width(a) - width(b));
    const okNow = p => !inj[p] || !inj[p].s || inj[p].s === "Questionable";
    const benchOk = everyone.filter(p => !st.includes(p) && !park.includes(p) && okNow(p));
    const season = [];
    for (let w = wk; w <= last; w++) season.push(w);
    const out = {};
    const hurtAll = everyone.filter(p => inj[p] && inj[p].s);
    for (const p of hurtAll) {
      const rec = inj[p];
      let weeks = null;
      const rw = Math.round(Number(rec.retWeeks));
      // PTS_LOST's documented rule: a date wins; else retWeeks = that many weeks
      // starting with this one (retWeeksStartsThisWeek), capped at the season.
      // An exact weeks list (retWeeksList) beats everything; then the date.
      if (Array.isArray(rec.retWeeksList)) weeks = season.filter(w => rec.retWeeksList.map(Number).includes(w));
      else if (!/^\d{4}-\d{2}-\d{2}/.test(String(rec.ret || "")) && rw > 0) weeks = season.slice(0, rw);
      else if (/season/i.test(rec.sev || "") || (rec.s === "IR" && !rec.ret)) weeks = season;
      else if (rec.ret) weeks = season.filter(w => P.sundays[w] < rec.ret);
      out[p] = { weeks, ros: weeks ? 0 : null, thisWeek: 0 };
    }
    const isOut = (p, w) => !!(out[p] && out[p].weeks && out[p].weeks.includes(w));
    // Choose the top projected player in `from` the slot takes, not in `taken`, above 0.
    const top = (slot, from, taken, val) => {
      let pick = null;
      for (const b of from) {
        if (taken.has(b) || !fits(slot, b) || !(val(b) > 0)) continue;
        if (pick == null || val(b) > val(pick) || (val(b) === val(pick) && b < pick)) pick = b;
      }
      return pick;
    };
    const lineup = (pool, val) => {
      const taken = new Set(), at = {};
      let sum = 0;
      for (const s of slotList) {
        const p = top(s, pool, taken, val);
        if (p != null) { taken.add(p); at[p] = s; sum += val(p); }
      }
      return { sum, at };
    };
    // One week: best lineup with vs without the out players; each one in the
    // with-lineup gets drop * (with - with-minus-just-him) / sum of those, or
    // an even split when every margin is 0. Returns pid -> share.
    const weekLoss = (w, gone) => {
      const res = {};
      if (!gone.length) return res;
      const pool = everyone.filter(p => !park.includes(p) && !gone.includes(p)
        && (okNow(p) || (out[p] && out[p].weeks ? !isOut(p, w) : w > wk)));
      const val = p => (gone.includes(p) ? hurtOf(p, w) : projOf(p, w));
      const all2 = [...pool, ...gone];
      const W = lineup(all2, val), WO = lineup(pool, val);
      const drop = Math.max(0, W.sum - WO.sum);
      const inside = gone.filter(p => p in W.at);
      const m = {};
      for (const p of inside) m[p] = Math.max(0, W.sum - lineup(all2.filter(q => q !== p), val).sum);
      const sm = inside.reduce((s, p) => s + m[p], 0);
      for (const p of inside) res[p] = drop * (sm > 0 ? m[p] / sm : 1 / inside.length);
      return res;
    };
    // This week: every injured starter is out unless his return puts him back
    // this week (0 weeks out); rest of season: whoever's weeks out include w.
    if (season.includes(wk)) {
      const tw = weekLoss(wk, hurtAll.filter(p => st.includes(p) && (!out[p].weeks || out[p].weeks.includes(wk))));
      for (const p in tw) out[p].thisWeek = tw[p];
    }
    for (const w of season) {
      const lw = weekLoss(w, hurtAll.filter(p => isOut(p, w)));
      for (const p in lw) out[p].ros += lw[p];
    }
    let tW = 0, tR = 0;
    for (const p in out) { tW += out[p].thisWeek; tR += out[p].ros || 0; }
    return { rows: out, thisWeek: tW, ros: tR };
  };

  check("points lost: the tab loads data/projections.json", PL.projOk && !!projFile);
  check("points lost: the source label reads Sleeper projections, ESPN return dates",
    PL.srcLabel === "Sleeper projections, ESPN return dates", PL.srcLabel);

  /* The Injuries tab's playoff-odds view (Research's lineup-delta model). */
  {
    const LT = PL.lossTeams || [];
    const lossOf = new Map(LT.flatMap(t => t.rows.map(x => [x.pid, { ...x, rid: t.rid }])));
    const lossTeam = new Map(LT.map(t => [t.rid, t]));
    const f1 = v => (Math.round(v * 10) / 10).toFixed(1);
    const fmtD = (d, u) => (Math.abs(d) < 0.5 ? `~0${u}` : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}${u}`);
    const LEAD = /^(calculating…|not measured|~0%|[−+]\d+\.\d%)$/;
    // Rows: the plan's own, per team, nothing added or dropped.
    const rowBad = [];
    for (const t of PL.shown) {
      const T = lossTeam.get(t.rid);
      if (!T) { if (t.rows.some(x => x.lost != null)) rowBad.push(`${t.rid}: priced without a plan`); continue; }
      if ([...t.rows.map(x => x.pid)].sort().join() !== T.rows.map(x => x.pid).sort().join()) rowBad.push(`${t.rid}: rows`);
      for (const x of t.rows) if (!close(x.lost, lossOf.get(x.pid).totalLost)) rowBad.push(`${x.pid}: ${x.lost} vs ${lossOf.get(x.pid).totalLost}`);
    }
    check("injuries tab: rows are injuryLossPlan's rows, the ones the odds worker measures",
      LT.length > 0 && PL.shown.length > 0 && rowBad.length === 0, rowBad.slice(0, 4).join(" ; "));
    // Lead: the measured playoffDelta as "−X.X% playoff odds"; title after.
    const ST = PL.stubTab || [], SD = (PL.stubbed || {}).deltas || {};
    const leadBad = [], secBad = [], ptsBad = [], benchBad = [], srcBad = [], sortBad = [], wordBad = [];
    let benchSeen = 0, zeroSeen = 0, srcSeen = 0;
    for (const t of [...PL.shown, ...ST]) for (const x of t.rows) {
      if (!LEAD.test(x.lead || "") || x.label !== "playoff odds") leadBad.push(`${x.pid}: ${x.lead}`);
      if (/for his|stand-in|replacement|stands in/i.test(x.text)) wordBad.push(x.pid);
    }
    for (const t of ST) for (const x of t.rows) {
      const d = SD[x.pid], L = lossOf.get(x.pid);
      if (d && (x.lead !== fmtD(d[0], "%") || x.title !== `${fmtD(d[1], "%")} title`)) secBad.push(`${x.pid}: ${x.lead} / ${x.title}`);
      if (!d && (x.lead !== "not measured" || x.title)) secBad.push(`${x.pid} unmeasured: ${x.lead}`);
      if (!L) continue;
      const want = !L.weeksOut ? "0 pts" : L.wouldStart === false ? "wouldn't start · 0 pts"
        : `${f1(L.lineupPerWeek)} pts/wk in lineup × ${L.weeksOut} wk${L.weeksOut === 1 ? "" : "s"} = ${f1(L.totalLost)} pts`;
      if (x.pts !== want) ptsBad.push(`${x.pid}: "${x.pts}" vs "${want}"`);
      if (x.benchTag !== L.bench || x.benchCls !== L.bench) benchBad.push(x.pid);
      if (L.bench) benchSeen++;
      if (L.wouldStart === false && L.weeksOut) zeroSeen++;
      if (L.retLabel) { srcSeen++; if (x.src !== L.retLabel) srcBad.push(`${x.pid}: ${x.src}`); }
      else if (x.src) srcBad.push(`${x.pid}: unexpected ${x.src}`);
    }
    for (const t of ST) for (let i = 1; i < t.rows.length; i++) {
      const a = SD[t.rows[i - 1].pid], b = SD[t.rows[i].pid];
      if ((!a && b) || (a && b && a[0] > b[0] + 1e-9)) sortBad.push(`${t.rid}: ${t.rows[i - 1].pid} before ${t.rows[i].pid}`);
    }
    const F = PL.stubFmt || [];
    check("injuries tab: each row leads with its playoff odds impact as a hero −X.X% labelled playoff odds, ~0% under 0.5",
      ST.length > 0 && leadBad.length === 0 && secBad.length === 0 && F.join("|") === "−3.5%|~0%|−0.5%|"
        && ST.some(t => t.rows.some(x => x.lead === "~0%")) && ST.some(t => t.rows.some(x => x.lead === "not measured")),
      `${F.join("|")} ${[...leadBad, ...secBad].slice(0, 4).join(" ; ")}`);
    check("injuries tab: title odds and lineup points are secondary: −X.X% title, pts/wk in lineup × wks = total pts",
      ptsBad.length === 0 && wordBad.length === 0 && ST.some(t => t.rows.some(x => /pts\/wk in lineup ×/.test(x.pts))),
      [...ptsBad, ...wordBad.map(p => `${p}: replacement wording`)].slice(0, 4).join(" ; "));
    check("injuries tab: bench players are tagged bench; players who wouldn't start cost 0 pts",
      benchBad.length === 0 && benchSeen > 0, `${benchSeen} bench, ${zeroSeen} wouldn't start; ${benchBad.slice(0, 4).join(", ")}`);
    check("injuries tab: the return source and its checked date are shown beside the return",
      srcBad.length === 0 && srcSeen > 0, `${srcSeen} with a source; ${srcBad.slice(0, 4).join(" ; ")}`);
    const NT = PL.nullTab || [];
    const notCalc = NT.flatMap(t => t.rows.filter(x => lossOf.has(x.pid) && (x.lead !== "calculating…" || x.title)).map(x => `${x.pid}: ${x.lead}`));
    check("injuries tab: with injuryPlayoffDeltas() null every row reads calculating…",
      PL.nullPending && NT.length > 0 && notCalc.length === 0, notCalc.slice(0, 4).join(" ; "));
    check("injuries tab: rows sorted by playoff impact, most negative first, unmeasured last",
      ST.length > 0 && sortBad.length === 0, sortBad.slice(0, 4).join(" ; "));
    const sumBad = [], teamSort = [];
    for (const t of PL.shown) {
      if (t.lost == null) continue;
      const s = t.rows.reduce((a, x) => a + (x.lost ?? 0), 0);
      // Rendered per-row values are rounded to 2dp, so the sum may drift by a few hundredths.
      if (Math.abs(s - t.lost) > 0.03 || t.lostText !== `−${f1(t.lost)}`) sumBad.push(`team ${t.rid}: ${s.toFixed(2)} vs ${t.lost} "${t.lostText}"`);
    }
    for (let i = 1; i < PL.shown.length; i++) {
      const a = PL.shown[i - 1], b = PL.shown[i];
      if ((a.lost == null && b.lost != null) || (a.lost != null && b.lost != null && a.lost < b.lost - 1e-9)) teamSort.push(`${a.rid} before ${b.rid}`);
    }
    check("injuries tab: each team's lineup pts lost is the sum of its rows; teams sorted by it",
      sumBad.length === 0 && teamSort.length === 0, [...sumBad, ...teamSort].slice(0, 4).join(" ; "));
    check("injuries tab: the method text explains the playoff odds, the points and the cap",
      PL.capNote && PL.explainers && /playoff odds/i.test(PL.text), `cap ${PL.capPct}% note ${PL.capNote}, explainers ${PL.explainers}`);
  }

  // projectedPointsLost() itself, which the odds' lineup-delta pricing reads.
  const reBad = [], qBad = [], dupBad = [];
  const standBad = [];
  let qSeen = 0;
  const shownStatus = new Map(PL.shown.flatMap(t => t.rows.map(x => [x.pid, x.status])));
  for (const f of PL.fn) {
    const re = projFile ? reimpl(PL.rosters.find(r => String(r.roster_id) === f.rid)) : null;
    if (re && (!close(f.thisWeek, re.thisWeek) || !close(f.ros, re.ros))) reBad.push(`team ${f.rid}: ${f.thisWeek}/${f.ros} vs ${re.thisWeek.toFixed(2)}/${re.ros.toFixed(2)}`);
    for (const x of f.rows) {
      const z = re && re.rows[x.pid];
      if (re && (!z || !close(x.thisWeek, z.thisWeek) || !close(x.ros, z.ros))) reBad.push(`${x.pid}: ${x.thisWeek}/${x.ros} vs ${z && z.thisWeek}/${z && z.ros}`);
      const st = injFileNow.map[x.pid] && injFileNow.map[x.pid].s;
      if (st === "Questionable" && x.thisWeek > 0) {
        qSeen++;
        if (!/questionable/i.test(shownStatus.get(x.pid) || "") || (z && !close(x.thisWeek, z.thisWeek))) qBad.push(x.pid);
      }
    }
    // A stand-in, this week or later, is whoever enters the best lineup —
    // never an injured player, and never someone already in it.
    for (const x of f.rows) for (const [w, b] of x.repls) {
      if (!b) continue;
      if (injFileNow.map[b] && injFileNow.map[b].s) (w === "tw" ? dupBad : standBad).push(`${x.pid} wk ${w}: ${b}`);
      if (b === x.pid) dupBad.push(`${x.pid} stands in for himself`);
    }
  }
  const fnByRid = new Map(PL.fn.map(t => [t.rid, t]));
  {
    const RF = PL.retFields || {};
    check("points lost: return fields — a date wins over retWeeks, retWeeks alone sets the weeks, neither keeps the old rule",
      !!RF.x && close(RF.x[0], 16) && RF.x[1] === "6,7" && close(RF.y[0], 24) && RF.y[1] === "6,7,8" && RF.z[0] == null && RF.z[1] == null,
      JSON.stringify(RF));
    const RT = PL.retTab;
    check("points lost: return fields — rows carry retSource, estimated and retNote; the tab shows the source and an estimated tag",
      !!RF.x && RF.x[2] === "espn-return-date" && RF.x[3] === false && RF.x[4] === "ESPN date"
        && RF.y[2] === "report" && RF.y[3] === true && RF.y[4] === "per the beat writer"
        && RF.z[2] === null && RF.z[3] === false && RF.z[4] === null
        && !!RT && /report/.test(RT.src || "") && RT.est && /synthetic/.test(RT.title || ""), JSON.stringify({ RF, RT }));
    check("points lost: an exact-week report (retEstimated false) is tagged 'reported', not 'estimated'",
      Array.isArray(PL.repTab) && PL.repTab.join() === "reported", JSON.stringify(PL.repTab));
    const F = PL.fallback || {};
    check("points lost: a hurt player projected at 0 uses his last projection above zero, else season PPG; a bye stays 0",
      close(F.tw, 25) && close(F.ros, 40) && F.rows && close(F.rows.P[1], 10) && close(F.rows.Q[1], 18) && close(F.rows.Z[1], 12)
        && F.off && close(F.off[0], 9) && close(F.off[1], 9), JSON.stringify(F));
    // last_nonzero / ppg only for injured rostered players; byes as week -> clubs.
    const fbBad = [];
    const P0 = projFile || {};
    const injRost = pid => !!(PL.rostMap[pid] && injFileNow.map[pid] && injFileNow.map[pid].s);
    for (const [pid, v] of Object.entries(P0.last_nonzero || {})) {
      if (!injRost(pid) || !(v.pts > 0) || !(v.week >= 1 && v.week < P0.current_week)) fbBad.push(`last_nonzero ${pid}`);
    }
    for (const [pid, v] of Object.entries(P0.ppg || {})) if (!injRost(pid) || !(v > 0)) fbBad.push(`ppg ${pid}`);
    for (const [w, clubs] of Object.entries(P0.byes || {})) if (!Array.isArray(clubs)) fbBad.push(`byes ${w}`);
    // The page used a fallback only on a 0 week whose club plays: a positive
    // own projection is kept as is, and a bye week stays 0.
    const clubOf = pid => (PL.rostMap[pid] && PL.rostMap[pid].t) || (injFileNow.map[pid] && injFileNow.map[pid].t);
    let fbUsed = 0;
    for (const x of PL.fn.flatMap(t => t.rows)) for (const [w, h] of x.hurt) {
      const own = P0.weeks && P0.weeks[w] ? P0.weeks[w][x.pid] : undefined;
      if (own > 0 && !close(h, own)) fbBad.push(`${x.pid} wk ${w}: ${h} for his own ${own}`);
      if (!(own > 0) && h > 0) {
        fbUsed++;
        if (((P0.byes || {})[w] || []).includes(clubOf(x.pid))) fbBad.push(`${x.pid} wk ${w}: bye but ${h}`);
      }
    }
    check("points lost: last_nonzero/ppg cover injured rostered players only; fallback used only on 0 non-bye weeks",
      !!projFile && !!P0.last_nonzero && !!P0.ppg && !!P0.byes && !("hurt_fallback" in P0) && fbBad.length === 0,
      `${fbUsed} fallback weeks; ${fbBad.slice(0, 4).join(", ")}`);
    const S = PL.slotFake;
    check("points lost: a FLEX slot takes the best RB/WR/TE; a fixed RB/WR slot never takes another position",
      close(S.tw, 23) && S.rows.R1[1] === "RB3" && close(S.rows.R1[0], 23 * 5 / 12) && S.rows.W1[1] === "RB3" && close(S.rows.W1[0], 23 * 4 / 12)
        && S.rows.W1[2] === "WR" && S.rows.F1[1] === "RB3" && S.rows.F1[2] === "FLEX" && close(S.rows.F1[0], 23 * 3 / 12), JSON.stringify(S));
    const B = PL.benchFake;
    check("points lost: a bench injury that wouldn't start costs 0; one that would start costs the lineup drop",
      close(B.tw, 0) && close(B.ros, 7) && close(B.rows.B1.ros, 7) && close(B.rows.B1.lost[0], 0) && close(B.rows.B1.lost[1], 7)
        && close(B.rows.B2.ros, 0), JSON.stringify(B));
    const partBad = PL.fn.filter(f => f.partial !== f.rows.some(x => x.ros == null)).map(f => f.rid);
    // injury-returns.mjs gives every real record an estimate, so the no-estimate
    // path runs on a stub: X has no ret/retWeeks/retSource, Y a 2-week default.
    const PS = await page.evaluate(() => {
      const D = window.__DFFL;
      const P = { current_week: 6, playoff_week_start: 10,
        sundays: { 6: "2026-10-18", 7: "2026-10-25", 8: "2026-11-01", 9: "2026-11-08" },
        weeks: Object.fromEntries([6, 7, 8, 9].map(w => [w, { X: 10, Y: 10, R: 2, R2: 2 }])) };
      const inj = new Map([["X", { s: "Out", n: "X", p: "WR" }],
        ["Y", { s: "Out", n: "Y", p: "WR", retWeeks: 2, retSource: "default", retEstimated: true }]]);
      const L = D.projectedPointsLost({ starters: ["X", "Y"], players: ["X", "Y", "R", "R2"], reserve: [], taxi: [] }, inj, P,
        { week: 6, player: pid => ({ n: pid, p: "WR" }), slots: ["WR", "WR", "BN", "BN"] });
      const row = id => L.rows.find(r => r.pid === id);
      return { partial: L.partial, rosRows: L.rosRows, ros: L.ros, x: row("X").ros, y: row("Y").ros };
    });
    check("points lost: a team with a no-estimate row marks its rest-of-season total partial",
      PS.partial === true && PS.x === null && PS.rosRows === 1 && close(PS.ros, PS.y) && PS.y > 0 && partBad.length === 0,
      `${JSON.stringify(PS)}; fn disagrees on ${partBad.join(", ")}`);
    const achane = Object.keys(injFileNow.map).find(pid => injFileNow.map[pid].n === "De'Von Achane");
    const aRow = achane && PL.fn.flatMap(t => t.rows).find(x => x.pid === achane);
    check("points lost: De'Von Achane (IR) no longer reads 0 for the rest of the season",
      !!aRow && aRow.ros != null && aRow.ros > 0, aRow ? `ros ${aRow.ros}` : "Achane not on a roster with an injury status");
  }
  check("points lost: an independent re-implementation agrees on every row and team", !!projFile && reBad.length === 0,
    reBad.slice(0, 4).join(" ; "));
  check("points lost: no-estimate rows show no rest-of-season number and stay out of the total",
    PL.fake.rows.A.ros === null && PL.fake.ros === 14, JSON.stringify(PL.fake.rows.A));
  check("points lost: a Questionable starter carries his full loss and a status tag", qBad.length === 0 && PL.fake.rows.B.tw === 5,
    `${qSeen} live; ${qBad.join(", ")} fake B=${PL.fake.rows.B.tw}`);
  check("points lost: this week's stand-ins are healthy players entering the best lineup", dupBad.length === 0, dupBad.slice(0, 3).join(" ; "));
  // Worked by hand, lineup slots WR (A), RB (B), QB (C): A (WR, out, no date)
  // loses 20-8 to D this week; B (RB, questionable to Oct 30) 15-10 to the
  // questionable bench E in weeks 6 and 7. Bench and IR slot, rest of season by
  // best lineup: week 6 (A out, no estimate) F (bench WR, back Oct 25) takes
  // the WR slot over D: 40 vs 36, F costs 4; H (IR K) and G (IR TE) have no
  // slot. Week 7: A is assumed back (no estimate past this week), G (9) no TE
  // slot -> 0; week 8 likewise. So B 10, F 4, G 0, H 0; A and E no estimate.
  const FK = PL.fake;
  const fakeOk = FK.thisWeek === 17 && FK.ros === 14 && FK.order === "ABFGHE"
    && FK.rows.A.tw === 12 && FK.rows.A.repl === "D" && FK.rows.B.ros === 10 && FK.rows.B.wo === "6,7" && FK.rows.B.repl === null
    && FK.rows.F.ros === 4 && FK.rows.F.wo === "6" && FK.rows.H.ros === 0 && FK.rows.H.wo === "6" && FK.rows.H.repl === null
    && FK.rows.G.ros === 0 && FK.rows.G.wo === "6,7,8" && FK.rows.E.ros === null;
  check("points lost: a made-up report proves the replacement, weeks-out and IR rules", fakeOk, JSON.stringify(FK));
  {
    const CC = PL.ccubed || {};
    check("points lost: rest of season is each out player's share of the best-lineup drop, starters included",
      !!CC.a && close(CC.a[0], 3) && close(CC.a[1], 3) && close(CC.b[0], 10 * 5 / 6) && close(CC.b[1], 10 / 6) && close(CC.b[2], 10)
        && close(CC.c[0], 5) && close(CC.c[1], 5), JSON.stringify(CC));
    check("points lost: the stand-in is who enters the rebuilt lineup, never an injured player; else lineup shuffle",
      !!CC.a && CC.a[2] === "WR3" && CC.b[3] === "C" && close(CC.d[0], 2) && CC.d[1] === null && CC.d[2] === "lineup shuffle"
        && standBad.length === 0, `${JSON.stringify(CC)} ${standBad.slice(0, 3).join(", ")}`);
    check("points lost: this week is the same best-lineup drop as rest of season, so both figures on a row mean the same thing",
      Array.isArray(CC.tw) && close(CC.tw[0], 3) && close(CC.tw[1], CC.b[0]) && close(CC.tw[2], CC.b[1]) && close(CC.tw[3], 5) && close(CC.tw[4], 5),
      JSON.stringify(CC.tw));
    const SP = PL.split || {};
    check("points lost: splitLineupDrop shares the drop by (with - with minus just him), scaled to the drop; all 0 -> even",
      SP.fn && close(SP.a[0], 10 * 5 / 6) && close(SP.a[1], 10 / 6) && close(SP.b[0], 5) && close(SP.b[1], 5)
        && close(SP.c[0], 0) && close(SP.c[1], 5) && SP.d.length === 0, JSON.stringify(SP));
    check("points lost: IR with no date reads season (IR), not no estimate", PL.irLabel === "season (IR)", String(PL.irLabel));
    const RW = PL.rwLabel;
    check("points lost: retWeeks without a date reads ~N wk (est.) with its source, never no estimate",
      !!RW && RW.ret === "~2 wk (est.)" && /ESPN outlook/.test(RW.src) && !/no estimate/.test(RW.ret), JSON.stringify(RW));
  }
  check("points lost: without data/projections.json the tab says so", PL.noProj.msg && PL.noProj.numbers === 0, JSON.stringify(PL.noProj));

  // The Odds model's injury code must not have moved: the same source text as
  // origin/main for the table and every function it prices with.
  const { execFileSync } = await import("node:child_process");
  let mainSrc = "";
  try { mainSrc = execFileSync("git", ["show", "origin/main:index.html"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 << 20 }); } catch { /* no origin */ }
  const hereSrc = await readFile(join(ROOT, "index.html"), "utf8");
  const grab = (src, name) => {
    const m = src.match(new RegExp(`\\n(?:const ${name}\\s*=|(?:async )?function ${name}\\()`));
    if (!m) return null;
    let i = src.indexOf("{", m.index), depth = 0;
    for (let j = i; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return src.slice(m.index, j + 1);
    }
    return null;
  };
  // This branch prices injuries in projected points when projections are
  // published. Without them the OLD multiplier path must be exactly origin/main's:
  // the untouched pieces byte-for-byte, and the ones that grew a loss-plan branch
  // (injuryPlan/injuryCharged/injuryMult/injuryHurtMap, gameLinesData,
  // simulateSeason) give byte-identical output to origin/main's own source on
  // the same inputs, with no loss plan attached.
  // livePosterior grew the trade adjustment (data/roster-weeks.json); with it
  // switched off its output must be origin/main's, checked below.
  const SAME_FNS = ["INJ_AVAIL", "availability", "approxKickoff", "injRetDate", "injuryLabel",
    "injuryLabelText", "injuryFuturesNote", "loadInjuries"];
  const moved = SAME_FNS.filter(n => { const a = grab(mainSrc, n); return !a || a !== grab(hereSrc, n); });
  const constLine = n => (src => (src.match(new RegExp(`\\nconst ${n} = [^\\n]*`)) || [""])[0]);
  const consts = ["REPLACEMENT", "INJ_FLOOR"].filter(n => !constLine(n)(mainSrc) || constLine(n)(mainSrc) !== constLine(n)(hereSrc));
  const GREW = ["injuryPlan", "injuryCharged", "injuryMult", "injuryHurtMap", "gameLinesData", "simulateSeason", "livePosterior"];
  // The body starts at ") {", past default parameters like `opts = {}`.
  const grabFn = (src, name) => {
    const m = src.match(new RegExp(`\\n(?:async )?function ${name}\\(`));
    if (!m) return null;
    const i = src.indexOf(") {", m.index) + 2;
    for (let j = i, depth = 0; j < src.length; j++) {
      if (src[j] === "{") depth++;
      else if (src[j] === "}" && --depth === 0) return src.slice(m.index, j + 1);
    }
    return null;
  };
  const mainFns = Object.fromEntries(GREW.map(n => [n, grabFn(mainSrc, n)]));
  const fb = !mainSrc || GREW.some(n => !mainFns[n]) ? { err: "origin/main source missing" } : await page.evaluate(async (src) => {
    const D = window.__DFFL;
    // origin/main's versions, bound as a set so they call one another (globals otherwise).
    const M = new Function(`${Object.values(src).join("\n")}\nreturn { ${Object.keys(src).join(", ")} };`)();
    const { R } = await D.liveOnce();
    const season = D.DB.seasons[0], inj = window.__INJ, model = window.__ODDS, now = new Date();
    const strip = p => JSON.stringify(p, (k, v) => (typeof v === "function" ? undefined : v instanceof Map ? [...v] : v));
    const pB = D.injuryPlan(season, inj, model, { now }), pM = M.injuryPlan(season, inj, model, { now });
    const bad = [];
    const keep = ["W0", "lastReg", "lastWeek", "teams"];
    if (strip(Object.fromEntries(keep.map(k => [k, pB[k]]))) !== strip(Object.fromEntries(keep.map(k => [k, pM[k]])))) bad.push("injuryPlan");
    for (const r of season.rosters) for (let w = pB.W0; w <= pB.lastWeek; w++) {
      if (D.injuryMult(pB, r.roster_id, w) !== M.injuryMult(pM, r.roster_id, w)) bad.push(`injuryMult ${r.roster_id}/${w}`);
      if (strip(D.injuryCharged(pB, r.roster_id, w)) !== strip(M.injuryCharged(pM, r.roster_id, w))) bad.push(`injuryCharged ${r.roster_id}/${w}`);
      if (strip(D.injuryHurtMap(pB, r.roster_id, w)) !== strip(M.injuryHurtMap(pM, r.roster_id, w))) bad.push(`injuryHurtMap ${r.roster_id}/${w}`);
    }
    // The trade adjustment (data/roster-weeks.json) off: game lines and
    // livePosterior, now and rewound, are origin/main's.
    const rwKeep = D.rosterWeeks();
    await D.loadRosterWeeks(null);
    const glB = D.gameLinesData(R, null, pB), glM = M.gameLinesData(R, null, pM);
    if (strip(glB.games.map(g => [g.open, g.a.inj, g.b.inj])) !== strip(glM.games.map(g => [g.open, g.a.inj, g.b.inj]))) bad.push("gameLinesData");
    for (const tw of [null, 3]) {
      if (strip(D.livePosterior(model, season, tw)) !== strip(M.livePosterior(model, season, tw))) bad.push(`livePosterior ${tw}`);
    }
    await D.loadRosterWeeks(rwKeep);
    let sims = 0;
    if (model && model.ok && window.__SIM) {
      const avail = D.availability(season, inj);
      const live = D.liveState(model, season, R, avail, window.__BOARD, null, pB);
      if (live) {
        const a = D.simulateSeason(model, 3000, live), b = M.simulateSeason(model, 3000, live);
        sims = 3000;
        for (const k of ["title", "playoff", "divWin", "bye", "wins", "seed"]) if (strip(a[k]) !== strip(b[k])) bad.push(`simulateSeason ${k}`);
      }
    }
    return { bad, sims, games: glB.games.length, lossAttached: !!pB.loss };
  }, mainFns);
  check("odds fallback: without projections the old multiplier path is origin/main's, byte for byte",
    !!mainSrc && moved.length === 0 && consts.length === 0 && !fb.err && fb.bad.length === 0 && !fb.lossAttached && fb.sims > 0,
    mainSrc ? `changed: ${[...moved, ...consts].join(", ")} · ${JSON.stringify(fb).slice(0, 300)}` : "git show origin/main:index.html failed");
}

const injNarrow = await injPage.evaluate(() => {
  const panel = document.querySelector('[data-panel="injuries"]');
  const W = window.innerWidth, over = [], small = [];
  for (const n of panel.querySelectorAll("*")) {
    const r = n.getBoundingClientRect();
    if (r.width && (r.right > W + 1 || r.left < -1)) over.push(`${n.className || n.tagName} → ${Math.round(r.left)}..${Math.round(r.right)}`);
    const text = [...n.childNodes].some(c => c.nodeType === 3 && c.textContent.trim());
    const fs = parseFloat(getComputedStyle(n).fontSize);
    if (text && r.width && fs < 11) small.push(`${n.className || n.tagName} ${fs}px "${n.textContent.trim().slice(0, 20)}"`);
  }
  return { W, over: over.slice(0, 6), small: small.slice(0, 6), doc: document.documentElement.scrollWidth,
    tables: panel.querySelectorAll("table").length, rows: panel.querySelectorAll(".injp").length };
});
check("injuries: rows render at 390px", injNarrow.rows > 0, `${injNarrow.rows}`);
check("injuries: no element in the tab overflows at 390px", injNarrow.over.length === 0 && injNarrow.doc <= injNarrow.W,
  injNarrow.over.join(" | ") || `${injNarrow.doc} > ${injNarrow.W}`);
check("injuries: stacked rows, not a sideways table", injNarrow.tables === 0, `${injNarrow.tables} tables`);
check("injuries: no text in the tab under 11px at 390px", injNarrow.small.length === 0, injNarrow.small.join(" | "));

// The Odds tab's injury report lists the whole roster's injuries too.
await injPage.click('#tabs button[data-tab="odds"]');
await injPage.waitForFunction(() => document.body.dataset.liveReady, null, { timeout: 180000 });
const injBoard = await injPage.evaluate(() => {
  const D = window.__DFFL, inj = window.__INJ, avail = window.__AVAIL;
  const season = D.DB.seasons[0];
  // The plan the board prices from: the points-lost plan when projections are published.
  const plan = inj ? (window.__PLAN || D.injuryPlan(season, inj, window.__ODDS)) : null;
  const out = { teams: 0, bench: 0, benchShown: 0, mismatch: [], cutBad: [], totalBad: [] };
  if (!inj || !avail) return { ...out, skipped: true };
  for (const r of season.rosters || []) {
    const ids = new Set([...(r.starters || []), ...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])]
      .filter(p => p && p !== "0").map(String));
    const st = new Set((r.starters || []).map(String));
    const want = [...ids].filter(p => inj.map.has(p));
    if (!want.length) continue;
    out.teams++;
    const row = document.querySelector(`#liveHost .irow[data-rid="${r.roster_id}"]`);
    const chips = row ? [...row.querySelectorAll(".ip[data-pid]")] : [];
    const got = new Set(chips.map(c => c.dataset.pid));
    if (want.length !== got.size || want.some(p => !got.has(p))) out.mismatch.push(`${r.roster_id}: ${got.size}/${want.length}`);
    const hurt = new Map(D.injuryCharged(plan, r.roster_id, plan.W0).map(x => [String(x.pid), x]));
    if (row) {
      const cost = row.querySelector(".cost"), k = cost.querySelector(".k").textContent;
      const got = cost.textContent.slice(0, -k.length).trim();
      const T = D.injuryLossTeam(plan, r.roster_id);
      const raw = [...hurt.values()].reduce((s, x) => s + x.loss * x.scale, 0);
      // The loss plan caps a team-week at INJ_ODDS.cap of the level.
      const sum = T ? Math.min(raw, D.INJ_ODDS.cap) : raw;
      const m = D.injuryMult(plan, r.roster_id, plan.W0);
      const exp = m < 1 ? `−${((1 - m) * 100).toFixed(1)}%` : "0%";
      // INJ_FLOOR aside, the total is the plain sum of the charged cuts.
      if (got !== exp || (m > 0.5 && Math.abs((1 - m) - sum) > 1e-9)) out.totalBad.push(`${r.roster_id}: ${got} vs ${exp} (sum ${(sum * 100).toFixed(1)})`);
    }
    for (const c of chips) {
      const pid = c.dataset.pid, cut = c.querySelector(".cut").textContent.trim();
      if (!st.has(pid)) { out.bench++; if (cut === "0% bench") out.benchShown++; else out.cutBad.push(`${pid}: ${cut}`); }
      else {
        const x = hurt.get(pid);
        const exp = x && x.loss * x.scale > 0 ? `−${(x.loss * x.scale * 100).toFixed(1)}%` : "0%";
        if (cut !== exp) out.cutBad.push(`${pid}: ${cut} vs ${exp}`);
      }
    }
  }
  return out;
});
check("injury report: every team lists every injured player on its roster", !injBoard.skipped && injBoard.teams > 0
  && injBoard.mismatch.length === 0, injBoard.skipped ? "no live board" : injBoard.mismatch.slice(0, 4).join(" ; "));
check("injury report: bench injured players are included, at 0%", injBoard.bench > 0 && injBoard.benchShown === injBoard.bench,
  `${injBoard.benchShown}/${injBoard.bench}`);
check("injury report: each team's total matches its charged per-player cuts", !injBoard.skipped && injBoard.totalBad.length === 0,
  injBoard.skipped ? "no live board" : injBoard.totalBad.slice(0, 4).join(" ; "));
check("injury report: each starter carries the model's charged cut", injBoard.cutBad.length === 0, injBoard.cutBad.slice(0, 4).join(" ; "));
check("injuries: no uncaught page errors", injErrs.length === 0, injErrs.slice(0, 2).join(" | "));
} catch (e) {
  check("injuries: section ran to the end", false, String(e).split("\n")[0]);
}
await injCtx.close();

/* The tab row's scroll hint at phone width: fades, chevron, first-visit nudge. */
group("Tab bar scroll hint");
{
  const op = (pg, sel, pseudo) => pg.evaluate(([s, p]) => {
    const n = document.querySelector(s); return n ? Number(getComputedStyle(n, p).opacity) : -1;
  }, [sel, pseudo || null]);
  const settle = pg => pg.waitForFunction(() => document.querySelector("#tabs button"), null, { timeout: 60000 });
  // A first visit at 390: the row overflows, the right fade and chevron show, the nudge runs once.
  const tctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const tp = await tctx.newPage();
  await tp.goto(BASE, { waitUntil: "domcontentloaded" });
  await settle(tp);
  await tp.waitForFunction(() => document.body.dataset.tabNudge, null, { timeout: 10000 }).catch(() => {});
  await tp.waitForTimeout(1400);
  const first = await tp.evaluate(() => {
    const bar = document.querySelector("#tabs"), w = bar.parentElement, chev = w.querySelector(".tabarr-r");
    return { over: bar.scrollWidth > bar.clientWidth, more: w.classList.contains("more"), nudge: document.body.dataset.tabNudge || "",
      stored: localStorage.getItem("tabNudgeSeen"), left: bar.scrollLeft,
      pe: [getComputedStyle(w, "::after").pointerEvents, getComputedStyle(w, "::before").pointerEvents],
      arrow: chev ? { hidden: chev.hidden, label: chev.getAttribute("aria-label"), tag: chev.tagName, w: chev.getBoundingClientRect().width, h: chev.getBoundingClientRect().height } : null,
      sticky: getComputedStyle(document.querySelector("nav.tabs")).position };
  });
  check("tab hint: at 390 the tab row overflows", first.over);
  check("tab hint: the right fade shows when the row overflows", first.more && await op(tp, "nav.tabs .wrap", "::after") > 0.9);
  check("tab hint: a right arrow button shows when the row overflows", first.arrow && !first.arrow.hidden && first.arrow.tag === "BUTTON" && first.arrow.label === "Scroll tabs right", JSON.stringify(first.arrow));
  check("tab hint: the arrow is a 32px+ tap target", first.arrow && first.arrow.w >= 32 && first.arrow.h >= 32, JSON.stringify(first.arrow));
  check("tab hint: no left arrow at the start", await tp.evaluate(() => document.querySelector(".tabarr-l").hidden));
  check("tab hint: no left fade at the start", await op(tp, "nav.tabs .wrap", "::before") < 0.1);
  check("tab hint: the fades never take taps", first.pe.every(v => v === "none"), first.pe.join(","));
  check("tab hint: the tab bar is still sticky", first.sticky === "sticky", first.sticky);
  check("tab hint: the first visit nudges once and remembers it", first.nudge === "ran" && first.stored === "1" && first.left < 2,
    `${first.nudge} ${first.stored} left=${first.left}`);
  // A tab still takes a tap where the fade sits.
  const lastVisible = await tp.evaluate(() => {
    const bar = document.querySelector("#tabs"), r = bar.getBoundingClientRect();
    const b = [...bar.children].find(x => { const q = x.getBoundingClientRect(); return q.left < r.right - 10 && q.right > r.right - 30; });
    return b ? b.dataset.tab : null;
  });
  if (lastVisible) {
    const r = await tp.evaluate(t => { const q = document.querySelector(`#tabs button[data-tab="${t}"]`).getBoundingClientRect(); return { x: q.left + 8, y: q.top + q.height / 2 }; }, lastVisible);
    await tp.mouse.click(r.x, r.y);
    await tp.waitForTimeout(150);
  }
  const tapped = lastVisible ? await tp.evaluate(t => document.querySelector(`#tabs button[data-tab="${t}"]`).getAttribute("aria-selected"), lastVisible) : null;
  check("tab hint: a tab under the right fade still takes a tap", tapped === "true", `${lastVisible} ${tapped}`);
  const tapped0 = await tp.evaluate(() => document.querySelector('#tabs [aria-selected="true"]').dataset.tab);
  // The right arrow pages the row; the left arrow pages it back.
  await tp.evaluate(() => { const b = document.querySelector("#tabs"); b.scrollLeft = 0; b.dispatchEvent(new Event("scroll")); });
  await tp.waitForTimeout(250);
  await tp.click(".tabarr-r");
  await tp.waitForTimeout(700);
  const paged = await tp.evaluate(() => { const b = document.querySelector("#tabs"); return { left: b.scrollLeft, cw: b.clientWidth, sel: document.querySelector('#tabs [aria-selected="true"]').dataset.tab }; });
  check("tab hint: tapping the right arrow pages the row and changes no tab", paged.left >= paged.cw * 0.5 && paged.sel === tapped0, JSON.stringify(paged));
  await tp.click(".tabarr-l");
  await tp.waitForTimeout(700);
  check("tab hint: the left arrow pages it back", await tp.evaluate(l => document.querySelector("#tabs").scrollLeft < l, paged.left));
  // Scrolled partway: the left fade shows. Scrolled to the end: right fade and chevron hide.
  await tp.evaluate(() => { const b = document.querySelector("#tabs"); b.scrollLeft = 60; b.dispatchEvent(new Event("scroll")); });
  await tp.waitForTimeout(300);
  check("tab hint: scrolling past the start shows the left fade", await op(tp, "nav.tabs .wrap", "::before") > 0.9);
  await tp.evaluate(() => { const b = document.querySelector("#tabs"); b.scrollLeft = b.scrollWidth; b.dispatchEvent(new Event("scroll")); });
  await tp.waitForTimeout(300);
  check("tab hint: at the end the right fade hides", await op(tp, "nav.tabs .wrap", "::after") < 0.1);
  check("tab hint: at the end the right arrow hides and the left one shows", await tp.evaluate(() => document.querySelector(".tabarr-r").hidden && !document.querySelector(".tabarr-l").hidden));
  // A direct load of the last tab scrolls the row so that tab is in view.
  const lastId = await tp.evaluate(() => [...document.querySelectorAll("#tabs button")].pop().dataset.tab);
  const rp0 = await tctx.newPage();
  await rp0.goto(BASE + "#" + lastId, { waitUntil: "domcontentloaded" });
  await settle(rp0);
  await rp0.waitForTimeout(1500);
  const vis = await rp0.evaluate(id => { const bar = document.querySelector("#tabs"), b = bar.querySelector(`[data-tab="${id}"]`), r = b.getBoundingClientRect(), q = bar.getBoundingClientRect();
    return { sel: b.getAttribute("aria-selected"), inView: r.left >= q.left - 1 && r.right <= q.right + 1, left: bar.scrollLeft }; }, lastId);
  check("tab hint: on load the selected tab is scrolled into view", vis.sel === "true" && vis.inView && vis.left > 0, JSON.stringify(vis));
  // Switching tabs keeps the new one in view.
  await rp0.evaluate(() => document.querySelector('#tabs button[data-tab="home"]').click());
  await rp0.waitForTimeout(700);
  check("tab hint: changing tab scrolls the new one into view", await rp0.evaluate(() => { const b = document.querySelector('#tabs [aria-selected="true"]'), r = b.getBoundingClientRect(), q = document.querySelector("#tabs").getBoundingClientRect(); return b.dataset.tab === "home" && r.left >= q.left - 1 && r.right <= q.right + 1; }));
  await rp0.close();
  // A second visit in the same browser: no nudge.
  await tp.reload({ waitUntil: "domcontentloaded" });
  await settle(tp);
  await tp.waitForTimeout(1200);
  const again = await tp.evaluate(() => document.body.dataset.tabNudge || "");
  check("tab hint: the nudge does not run on a second visit", again === "seen", again);
  await tctx.close();
  // Reduced motion: no nudge, nothing stored.
  const rctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
  const rp = await rctx.newPage();
  await rp.goto(BASE, { waitUntil: "domcontentloaded" });
  await settle(rp);
  await rp.waitForTimeout(1200);
  const red = await rp.evaluate(() => ({ n: document.body.dataset.tabNudge || "", s: localStorage.getItem("tabNudgeSeen"), left: document.querySelector("#tabs").scrollLeft }));
  check("tab hint: no nudge under prefers-reduced-motion", red.n === "reduced" && red.s === null && red.left === 0, JSON.stringify(red));
  await rctx.close();
  // Desktop, where the row fits: nothing at all.
  const dctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const dp = await dctx.newPage();
  await dp.goto(BASE, { waitUntil: "domcontentloaded" });
  await settle(dp);
  await dp.waitForTimeout(1200);
  const desk = await dp.evaluate(() => {
    const bar = document.querySelector("#tabs"), w = bar.parentElement;
    return { over: bar.scrollWidth > bar.clientWidth + 2, cls: ["more", "less"].filter(c => w.classList.contains(c)).join(","), nudge: document.body.dataset.tabNudge || "" };
  });
  check("tab hint: at 1280 the hint matches the row (fade only if it really overflows)",
    desk.over ? desk.cls.includes("more") : !desk.cls && !desk.nudge, JSON.stringify(desk));
  // Where the row fits, nothing shows: trim it to three tabs and let the resize handler re-check.
  const fit = await dp.evaluate(async () => {
    const bar = document.querySelector("#tabs"), w = bar.parentElement;
    [...bar.children].slice(3).forEach(b => { b.style.display = "none"; });
    bar.scrollLeft = 0; window.dispatchEvent(new Event("resize"));
    await new Promise(r => setTimeout(r, 300));
    const op = (n, p) => Number(getComputedStyle(n, p).opacity);
    return { over: bar.scrollWidth > bar.clientWidth + 2, cls: ["over", "more", "less"].filter(c => w.classList.contains(c)).join(","),
      after: op(w, "::after"), before: op(w, "::before"), chev: w.querySelector(".tabarr-r").hidden && w.querySelector(".tabarr-l").hidden ? 0 : 1 };
  });
  check("tab hint: on desktop with a row that fits, no fade or chevron", !fit.over && !fit.cls && fit.after < 0.1 && fit.before < 0.1 && fit.chev < 0.1, JSON.stringify(fit));
  await dctx.close();
}

group("Injury odds: lineup drop per out week (full value only without lineup slots)");
{
  // injury-returns.mjs, in Node.
  const IR = await import(new URL("./injury-returns.mjs", import.meta.url));
  // Its failure path: ESPN dead (a closed port) -> falls back to the cache, exit 0;
  // no injuries.json at all -> warning, exit 0, files untouched.
  {
    const { spawnSync } = await import("node:child_process");
    const fs = await import("node:fs"), os = await import("node:os");
    const dir = fs.mkdtempSync(join(os.tmpdir(), "inj-ret-"));
    for (const f of ["injury-returns.mjs", "fetch-json.mjs"]) fs.copyFileSync(join(ROOT, f), join(dir, f));
    const env = { ...process.env, ESPN_INJURIES_URL: "http://127.0.0.1:9/injuries" };
    const run = () => spawnSync(process.execPath, ["injury-returns.mjs"], { cwd: dir, env, encoding: "utf8", timeout: 60000 });
    const none = run();
    fs.writeFileSync(join(dir, "injuries.json"), JSON.stringify({ map: { 9: { n: "Cached Guy", s: "Out", p: "WR" } } }));
    fs.writeFileSync(join(dir, "injury-returns-cache.json"), JSON.stringify({ entries: { 9: { s: "Out", retWeeks: 3, retSource: "espn-outlook", retEstimated: true } } }));
    const dead = run();
    const rec = JSON.parse(fs.readFileSync(join(dir, "injuries.json"), "utf8")).map[9];
    fs.rmSync(dir, { recursive: true, force: true });
    check("returns CLI: no injuries.json -> warning, exit 0",
      none.status === 0 && /skipped/.test(none.stderr), JSON.stringify([none.status, none.stderr.slice(0, 200)]));
    check("returns CLI: ESPN unreachable -> warning, cached return reused, exit 0",
      dead.status === 0 && /ESPN feed unavailable/.test(dead.stderr) && rec.retWeeks === 3 && rec.retSource === "espn-outlook",
      JSON.stringify([dead.status, dead.stderr.slice(0, 200), rec]));
  }
  const today = "2026-10-13";
  const ol = IR.resolveReturn({ rec: { s: "Out" }, notes: ["He is expected to miss 4-6 weeks with a sprained ankle."], week: 6, today });
  check("returns: 'expected to miss 4-6 weeks' -> retWeeks 6, estimated, espn-outlook",
    ol.retWeeks === 6 && ol.retEstimated === true && ol.retSource === "espn-outlook" && !ol.ret, JSON.stringify(ol));
  const df = IR.resolveReturn({ rec: { s: "Out" }, notes: [], week: 6, lastReg: 14, today });
  const dfIR = IR.resolveReturn({ rec: { s: "IR" }, notes: [], week: 6, lastReg: 14, today });
  check("returns: default flagged estimated, retSource default (Out 1 week, IR minimum 4 weeks)",
    df.retSource === "default" && df.retEstimated === true && df.retWeeks === 1 && dfIR.retWeeks === 4 && dfIR.retSource === "default",
    JSON.stringify([df, dfIR]));
  // The IR / PUP 4-week minimum counts from irSince, not the coming week.
  const irAt = (irSince, s = "IR") => IR.resolveReturn({ rec: { s }, notes: [], week: 6, lastReg: 14, today, irSince });
  const ir3 = irAt(3), ir6 = irAt(6), ir1 = irAt(1), pup4 = irAt(4, "PUP");
  check("returns: IR/PUP default counts from irSince (wk 3 -> 1 left at wk 6; wk 6 -> 4; wk 1 -> run out = coming week only)",
    ir3.retWeeks === 1 && ir6.retWeeks === 4 && ir1.retWeeks === 1 && /run out/.test(ir1.retNote) && pup4.retWeeks === 2
      && [ir3, ir6, ir1, pup4].every(x => x.retSource === "default" && x.retEstimated === true),
    JSON.stringify([ir3, ir6, ir1, pup4]));
  {
    // The CLI persists irSince per pid in the cache and carries it forward.
    const { spawnSync } = await import("node:child_process");
    const fs = await import("node:fs"), os = await import("node:os");
    const dir = fs.mkdtempSync(join(os.tmpdir(), "inj-irs-"));
    for (const f of ["injury-returns.mjs", "fetch-json.mjs"]) fs.copyFileSync(join(ROOT, f), join(dir, f));
    fs.mkdirSync(join(dir, "data"));
    fs.writeFileSync(join(dir, "data", "projections.json"), JSON.stringify({ current_week: 6, playoff_week_start: 15,
      sundays: { 5: "2026-10-11", 6: "2026-10-18", 7: "2026-10-25", 8: "2026-11-01" } }));
    fs.writeFileSync(join(dir, "injuries.json"), JSON.stringify({ map: { 7: { n: "Old IR", s: "IR", p: "RB" }, 8: { n: "New IR", s: "IR", p: "RB" },
      10: { n: "Dated IR", s: "IR", p: "WR", injury_start_date: "2026-10-09" } } }));
    fs.writeFileSync(join(dir, "injury-returns-cache.json"), JSON.stringify({ week: 5, entries: { 7: { s: "IR", irSince: 3, retWeeks: 4, retSource: "default" } } }));
    const run = spawnSync(process.execPath, ["injury-returns.mjs"], { cwd: dir, encoding: "utf8", timeout: 60000,
      env: { ...process.env, ESPN_INJURIES_URL: "http://127.0.0.1:9/injuries" } });
    const m = JSON.parse(fs.readFileSync(join(dir, "injuries.json"), "utf8")).map;
    const ce = JSON.parse(fs.readFileSync(join(dir, "injury-returns-cache.json"), "utf8")).entries;
    fs.rmSync(dir, { recursive: true, force: true });
    check("returns CLI: irSince carried in the cache (3 kept -> 1 wk left; new -> this week, 4; injury_start_date -> its week)",
      run.status === 0 && ce[7].irSince === 3 && m[7].retWeeks === 1 && ce[8].irSince === 6 && m[8].retWeeks === 4
        && ce[10].irSince === 5 && m[10].retWeeks === 3,
      JSON.stringify([run.status, ce, run.stderr.slice(0, 200)]));
  }
  const es = IR.resolveReturn({ rec: { s: "IR", ret: "2026-11-20" }, notes: ["out for the season"], week: 6, today });
  check("returns: an ESPN date wins and is not estimated",
    es.retSource === "espn-return-date" && es.retEstimated === false && es.ret === "2026-11-20", JSON.stringify(es));
  const rp = IR.resolveReturn({ rec: { s: "Out" }, notes: [], report: { ret: "2026-11-01", source: "beat", checked: "2026-10-12" }, week: 6, today });
  check("returns: a report entry is used when ESPN says nothing", rp.retSource === "report" && rp.ret === "2026-11-01", JSON.stringify(rp));
  check("returns: outlook parser reads season-ending, out until Week N, IR, week-to-week",
    IR.parseOutlook("suffered a season-ending ACL tear").weeks === IR.SEASON && IR.parseOutlook("He is out until Week 9").untilWeek === 9
    && IR.parseOutlook("was placed on IR Tuesday").weeks === 4 && IR.parseOutlook("considered week-to-week").weeks === 2);

  const tm = IR.resolveReturn({ rec: { s: "Out", ret: "2026-11-20" }, notes: ["expected to miss 4-6 weeks"],
    report: { kind: "team", weeks: 2, source: "club", checked: "2026-10-12" }, week: 6, today });
  check("returns: a team timetable (kind team) wins over ESPN's date and prose, not estimated",
    tm.retSource === "team" && tm.retEstimated === false && tm.retWeeks === 2 && !tm.ret, JSON.stringify(tm));
  const sl = IR.resolveReturn({ rec: { s: "Out", ret: "2026-11-20" }, sleeperNotes: ["Coach says he will miss 3 weeks."], week: 6, today });
  const slNone = IR.resolveReturn({ rec: { s: "Out", ret: "2026-11-20" }, sleeperNotes: [], week: 6, today });
  check("returns: Sleeper outlook prose (stubbed) -> sleeper-outlook, estimated, ahead of ESPN; none -> ESPN",
    sl.retSource === "sleeper-outlook" && sl.retEstimated === true && sl.retWeeks === 3 && slNone.retSource === "espn-return-date",
    JSON.stringify([sl, slNone]));

  const io = await page.evaluate(async () => {
    const D = window.__DFFL;
    // Synthetic: weeks 6-14 regular, 15-17 playoffs. No replacement offset: full value per out week.
    const reg = [6, 7, 8, 9, 10, 11, 12, 13, 14], all = [...reg, 15, 16, 17];
    const sundays = Object.fromEntries(all.map((w, i) => [w, new Date(Date.UTC(2026, 9, 18 + 7 * i)).toISOString().slice(0, 10)]));
    const P = { current_week: 6, playoff_week_start: 15, sundays: Object.fromEntries(reg.map(w => [w, sundays[w]])),
      weeks: Object.fromEntries(reg.map(w => [w, { A: 20, BN: 15, B12: 12, Z: 0, L: 0, PP: 0, H: 20, Q: 3 }])),
      last_nonzero: { L: { pts: 12 } }, ppg: { PP: 9, L: 4 }, byes: {} };
    const base = { weeks: all, lastReg: 14, sun: w => sundays[w], pos: "WR" };
    const imp = (rec, pid = "A") => D.injuryImpact(pid, rec, P, base);
    const out = {};
    const o = imp({ s: "Out", retWeeks: 1 });
    out.full = [o.ptsPerWeek, o.weeksOut, o.totalLost, o.valueSource, "replLevel" in o, "varPerWeek" in o];
    out.qd = ["Questionable", "Doubtful"].map(s => { const x = imp({ s, retWeeks: 1 }); return x.ptsPerWeek * x.weight; });
    // Bench player projected 12, out 2 weeks -> 24; a zero projection out 2 weeks prices at last_nonzero (12) -> 24.
    const b2 = D.teamInjuryImpact({ starters: ["A"], players: ["A", "B12"] }, { B12: { s: "Out", p: "WR", retWeeks: 2 } }, P, base).rows[0];
    const l2 = D.injuryImpact("L", { s: "Out", retWeeks: 2 }, P, base);
    out.two = [b2.bench, b2.ptsPerWeek, b2.weeksOut, b2.totalLost, l2.ptsPerWeek, l2.totalLost, l2.valueSource];
    out.fmt = [0.49, -0.49, 0, 0.5, -1.234, 2, null].map(D.fmtInjuryDelta);
    out.fb = [D.injuryImpact("L", { s: "Out", retWeeks: 1 }, P, base), D.injuryImpact("PP", { s: "Out", retWeeks: 1 }, P, base),
      D.injuryImpact("Z", { s: "Out", retWeeks: 1 }, P, base)].map(x => [x.value, x.valueSource]);
    out.date = imp({ s: "IR", ret: sundays[9], retSource: "espn-return-date" }).outWeeks;
    const se = imp({ s: "IR" });
    out.season = [se.outWeeks.join(","), se.seasonEnding];
    out.ir14 = imp({ s: "IR", retWeeks: 9, retSource: "default" }).outWeeks.join(",");
    out.low = D.injuryImpact("Q", { s: "Out", retWeeks: 1 }, P, base).totalLost;
    // A team: starter A (20) and bench BN (15) both out a week.
    const team = { roster_id: 1, starters: ["A"], players: ["A", "BN"], reserve: [], taxi: [] };
    const inj = new Map([["A", { s: "Out", n: "A", p: "WR", retWeeks: 1 }], ["BN", { s: "Out", n: "BN", p: "WR", retWeeks: 1 }]]);
    const player = pid => ({ n: pid, p: "WR" });
    const TI = D.teamInjuryImpact(team, inj, P, { ...base, player });
    const TN = D.teamInjuryImpact(team, inj, P, { ...base, player, includeBench: false });
    out.team = { wk6: TI.byWeek[6], bench: TI.rows.find(r => r.pid === "BN").ptsPerWeek, benchFlag: TI.rows.find(r => r.pid === "BN").bench,
      noBench: TN.byWeek[6], noBenchROS: TN.totalROS, benchROS: TN.benchROS };
    // The loss plan on top: cap, scale, shape.
    const plan0 = (scale = 1, level = 200) => ({ W0: 6, lastReg: 14, inFlight: false, ptsIn: () => 0,
      scaleOf: () => ({ scale }), levelOf: () => level });
    const season = { rosters: [team, { roster_id: 2, starters: ["H"], players: ["H"], reserve: [], taxi: [] }] };
    const lp = (p = plan0()) => D.injuryLossPlan(season, inj, P, { plan: p, player, slots: ["WR", "BN"] });
    const L1 = lp();
    out.plan = { wk6: L1.byTeam.get(1).weekLoss(6), wk7: L1.byTeam.get(1).weekLoss(7), lost: L1.lost[6], source: L1.source,
      cap: lp(plan0(1, 50)).byTeam.get(1).weekLoss(6), scale: lp(plan0(0.5)).byTeam.get(1).weekLoss(6) };
    out.noProj = D.injuryLossPlan(season, inj, null, { plan: plan0(), player }) === null;
    out.noRepl = !("replacementLevels" in D) && !("repl" in L1);

    // The real board: totals, sims, deltas.
    const model = window.__ODDS, live = window.__LIVE, plan = window.__PLAN;
    out.realRows = plan && plan.loss ? [...plan.loss.byTeam.values()].flatMap(T => T.rows)
      .filter(r => r.pricing !== "lineup-delta" ? Math.abs(r.totalLost - r.ptsPerWeek * r.weeksOut) > 1e-9
        : Math.abs(r.totalLost - Object.values(r.perWeek).reduce((a, x) => a + x, 0)) > 1e-9).length : null;
    if (model && model.ok && live) {
      const n = live.teams.length, wk0 = live.weeks.length ? live.weeks[0].week : null;
      const healthy = { ...live, multByWeek: new Map(), lostByWeek: new Map() };
      const hurt = { ...live, multByWeek: new Map(), lostByWeek: new Map([[wk0, live.teams.map((t, i) => (i === 0 ? 25 : 0))]]) };
      const a = D.simulateSeason(model, 2000, healthy), b = D.simulateSeason(model, 2000, hurt);
      out.sim = { team0: [a.wins[0], b.wins[0]], others: live.teams.map((_, i) => i).slice(1)
        .reduce((s, i) => s + (b.wins[i] >= a.wins[i] ? 1 : 0), 0), n };
      if (plan) {
        const keep = plan.loss; plan.loss = null;
        const rid = live.teams[0].rid, w = plan.W0;
        out.fallback = [D.injuryLostPts(plan, rid, w, 100), 100 * (1 - D.injuryMult(plan, rid, w))];
        plan.loss = keep;
      }
      // Each injury's own effect, from the odds worker (started by liveOnce).
      for (let i = 0; i < 120 && !D.injuryPlayoffDeltas(); i++) await new Promise(r => setTimeout(r, 500));
      const M = D.injuryPlayoffDeltas();
      out.deltas = M ? { n: M.size, worst: Math.min(...[...M.values()].map(d => d.playoffDelta)),
        positive: [...M.values()].filter(d => d.playoffDelta > 0.05).length, sims: [...M.values()][0] && [...M.values()][0].sims } : null;
      const row = plan && plan.loss && [...plan.loss.byTeam.values()].flatMap(T => T.rows).find(r => M && M.has(r.pid));
      out.rowReads = row ? row.playoffDelta === M.get(row.pid).playoffDelta && row.titleDelta === M.get(row.pid).titleDelta : null;
      // CRN: "removing" an injury while keeping its loss gives exactly the baseline.
      const job = D.injuryDeltaJob(model, live, plan, 400);
      const one = job && job.injuries.find(x => !x.noop);
      if (one) {
        const T = plan.loss.byTeam.get(one.rid);
        const noop = { ...one, lost: one.lost.map(([w]) => [w, T.weekLoss(w)]) };
        const r = D.pictureRun({ ...job, injuries: [noop, one] }).injuries;
        out.crn = { noop: [r[0].playoffDelta, r[0].titleDelta], real: r[1].playoffDelta };
      }
    }
    return out;
  });
  check("injury impact: full projected value per out week, no replacement offset (20 -> 20 a week)",
    JSON.stringify(io.full) === JSON.stringify([20, 1, 20, "proj", false, false]), JSON.stringify(io.full));
  check("injury impact: a low projection still costs its full value (3 -> 3)", io.low === 3, String(io.low));
  check("injury impact: bench, projection 12, out 2 weeks -> 24; zero projection -> last_nonzero 12 x 2 -> 24",
    JSON.stringify(io.two) === JSON.stringify([true, 12, 2, 24, 12, 24, "last_nonzero"]), JSON.stringify(io.two));
  check("injury impact: Questionable and Doubtful charged in full", io.qd.every(x => x === 20), JSON.stringify(io.qd));
  check("fmtInjuryDelta: '~0' under 0.5 pp, signed pp otherwise, '' unmeasured",
    JSON.stringify(io.fmt) === JSON.stringify(["~0", "~0", "~0", "+0.5 pp", "−1.2 pp", "+2.0 pp", ""]), JSON.stringify(io.fmt));
  check("odds loss: no replacement levels anywhere (replacementLevels gone, plan has no repl)", io.noRepl === true, String(io.noRepl));
  check("injury impact: a zero projection falls back to last_nonzero, then ppg, else none",
    JSON.stringify(io.fb) === JSON.stringify([[12, "last_nonzero"], [9, "ppg"], [0, "none"]]), JSON.stringify(io.fb));
  check("injury impact: out-weeks stop at the return date", io.date.join(",") === "6,7,8", JSON.stringify(io.date));
  check("injury impact: season-ending runs through the playoffs; IR default stops at week 14",
    io.season[0] === "6,7,8,9,10,11,12,13,14,15,16,17" && io.season[1] === true && io.ir14 === "6,7,8,9,10,11,12,13,14",
    JSON.stringify([io.season, io.ir14]));
  check("injury impact: a bench player counts at full projected value",
    io.team.bench === 15 && io.team.benchFlag === true && io.team.wk6 === 35, JSON.stringify(io.team));
  check("injury impact: includeBench false leaves the bench out (benchROS still reported)",
    io.team.noBench === 20 && io.team.noBenchROS === 20 && io.team.benchROS === 15, JSON.stringify(io.team));
  // Lineup delta: starter A (20) is out with nobody to replace him (20); bench BN
  // (15) would not start, so costs 0. Scale 0.5 -> 10.
  check("odds loss: team-week loss is the lineup drop from teamInjuryImpact, lost[w][teamIdx], source projections",
    io.plan.wk6 === 20 && io.plan.wk7 === 0 && JSON.stringify(io.plan.lost) === "[20,0]" && io.plan.source === "projections", JSON.stringify(io.plan));
  check("odds loss: capped at 30% of the team's level", io.plan.cap === 15, String(io.plan.cap));
  check("odds loss: injuryPlan's scale applied to the lineup drop", io.plan.scale === 10, String(io.plan.scale));
  check("odds loss: no projections -> no loss plan", io.noProj);
  check("odds loss: totalLost = the sum of its per-week lineup drops on every real row (ptsPerWeek × weeksOut without slots)", io.realRows === 0, String(io.realRows));
  // The lineup-delta rule on its own synthetic teams (slots given, so not full value).
  const ld = await page.evaluate(() => {
    const D = window.__DFFL;
    const reg = [6, 7, 8, 9, 10, 11, 12, 13, 14], all = [...reg, 15, 16, 17];
    const sundays = Object.fromEntries(all.map((w, i) => [w, new Date(Date.UTC(2026, 9, 18 + 7 * i)).toISOString().slice(0, 10)]));
    const P = { current_week: 6, playoff_week_start: 15, sundays: Object.fromEntries(reg.map(w => [w, sundays[w]])),
      weeks: Object.fromEntries(reg.map(w => [w, { A: w === 7 ? 0 : 20, BN: 15, B12: 12, H: 20, X: 10, Y: 1, Z: 0.9 }])), byes: { 7: ["KC"] } };
    const player = pid => ({ n: pid, p: "WR", t: pid === "A" ? "KC" : "NYJ" });
    const plan = { W0: 6, lastReg: 14, inFlight: false, ptsIn: () => 0, scaleOf: () => ({ scale: 1 }), levelOf: () => 1000 };
    const other = { roster_id: 2, starters: ["H"], players: ["H"], reserve: [], taxi: [] };
    const loss = (team, inj) => D.injuryLossPlan({ rosters: [team, other] }, new Map(Object.entries(inj)), P,
      { plan, player, slots: ["WR", "BN"] }).byTeam.get(1);
    const out = {};
    // Healthy starter A, bench BN out: BN would not start, so the week costs 0.
    out.bench = loss({ roster_id: 1, starters: ["A"], players: ["A", "BN"], reserve: [], taxi: [] },
      { BN: { s: "Out", n: "BN", p: "WR", t: "NYJ", retWeeks: 1 } }).weekLoss(6);
    // Starter A (20) out, healthy B12 (12) steps in: the lineup drops 8.
    const st = loss({ roster_id: 1, starters: ["A"], players: ["A", "B12"], reserve: [], taxi: [] },
      { A: { s: "Out", n: "A", p: "WR", t: "KC", retWeeks: 3 } });
    out.starter = st.weekLoss(6);
    // A's club KC is on bye in week 7: not charged; week 8 is.
    out.bye = [st.weekLoss(7), st.weekLoss(8)];
    // Shares: X (10) and Y (1) start, Z (0.9) is the only, also-injured, stand-in.
    // Split by marginal drop, X's raw share is ~10.9 > his 10; capShare holds it to 10.
    const team = { roster_id: 1, starters: ["X", "Y"], players: ["X", "Y", "Z"], reserve: [], taxi: [] };
    const inj = Object.fromEntries(["X", "Y", "Z"].map(p => [p, { s: "Out", n: p, p: "WR", t: "NYJ", retWeeks: 1 }]));
    const xLost = capShare => D.projectedPointsLost(team, inj, P, { week: 6, player, slots: ["WR", "WR"], capShare })
      .rows.find(r => r.pid === "X").perWeek[0].lost;
    out.cap = [xLost(false), xLost(true)];
    // weeks_list with a gap (retWeeksList) is charged on exactly those weeks.
    const gap = { s: "IR", n: "A", p: "WR", t: "NYJ", retWeeks: 2, retWeeksList: [6, 8] };
    out.listImpact = D.injuryImpact("A", gap, P, { weeks: all, lastReg: 14, sun: w => sundays[w] }).outWeeks.join(",");
    out.listLost = (D.projectedPointsLost({ roster_id: 1, starters: ["A"], players: ["A"], reserve: [], taxi: [] }, { A: gap }, P,
      { week: 6, player, slots: ["WR"] }).rows[0].weeksOut || []).join(",");
    // 0 weeks out (weeks_list [] -> ret = this Sunday; or an empty retWeeksList):
    // the Injuries tab and the odds both charge nothing this week. No estimate:
    // both count the coming week (20 - 12 = 8).
    const zero = { ret: { s: "Out", n: "A", p: "WR", t: "NYJ", ret: sundays[6], retWeeks: 0 },
      list: { s: "Out", n: "A", p: "WR", t: "NYJ", retWeeks: 0, retWeeksList: [] }, none: { s: "Out", n: "A", p: "WR", t: "NYJ" } };
    const team1 = { roster_id: 1, starters: ["A"], players: ["A", "B12"], reserve: [], taxi: [] };
    out.zero = Object.fromEntries(Object.entries(zero).map(([k, rec]) => {
      const r = D.projectedPointsLost(team1, { A: rec }, P, { week: 6, player, slots: ["WR"] }).rows[0];
      const I = D.injuryImpact("A", rec, P, { weeks: all, lastReg: 14, sun: w => sundays[w] });
      return [k, [r.thisWeek, r.weeksOut ? r.weeksOut.length : null, I.weeksOut, loss(team1, { A: rec }).weekLoss(6)]];
    }));
    return out;
  });
  check("odds loss: a bench injury that would not start costs 0 in the weekly line", ld.bench === 0, String(ld.bench));
  check("odds loss: an injured starter costs the lineup drop (20 - 12 stand-in = 8)", near(ld.starter, 8, 1e-9), String(ld.starter));
  check("odds loss: a bye week is not charged (bye 0, next week 8)", ld.bye[0] === 0 && near(ld.bye[1], 8, 1e-9), JSON.stringify(ld.bye));
  check("odds loss: a player's share is capped at his own projection (capShare)",
    ld.cap[0] > 10 && near(ld.cap[1], 10, 1e-9), JSON.stringify(ld.cap));
  check("weeks_list: a gap list is charged on exactly those weeks (injuryImpact and PTS_LOST)",
    ld.listImpact === "6,8" && ld.listLost === "6,8", JSON.stringify(ld));
  check("0 weeks out (weeks_list [] / ret this Sunday): the Injuries tab shows 0 this week, matching the odds; no estimate still counts this week",
    JSON.stringify(ld.zero.ret) === "[0,0,0,0]" && JSON.stringify(ld.zero.list) === "[0,0,0,0]"
      && near(ld.zero.none[0], 8, 1e-9) && ld.zero.none[1] === null && ld.zero.none[2] === 1 && near(ld.zero.none[3], 8, 1e-9),
    JSON.stringify(ld.zero));
  {
    const sundayOf = w => ({ 6: "2026-10-18", 7: "2026-10-25", 8: "2026-11-01", 9: "2026-11-08", 10: "2026-11-15", 11: "2026-11-22" })[w] || null;
    const rr = (report, week) => IR.resolveReturn({ rec: { s: "Out", t: "NYJ" }, report, week, lastReg: 14, sundayOf, today: "2026-10-14" });
    const r67 = rr({ kind: "report", weeks: 5, unit: "games", weeks_list: [6, 7], checked: "2026-10-14" }, 6);
    const r68 = rr({ kind: "report", weeks: 2, weeks_list: [6, 8], checked: "2026-10-14" }, 6);
    const r0 = rr({ kind: "report", weeks: 3, weeks_list: [], checked: "2026-10-14" }, 6);
    check("weeks_list: wins over weeks/unit; contiguous -> ret the Sunday after; a gap -> retWeeksList; [] -> not out",
      r67.ret === "2026-11-01" && r67.retWeeks == null && JSON.stringify(r68.retWeeksList) === "[6,8]" && r0.ret === "2026-10-18",
      JSON.stringify([r67, r68, r0]));
    const rRet = rr({ kind: "report", ret: "2026-10-25", checked: "2026-10-14" }, 6);
    const rWk = rr({ kind: "report", weeks: 2, checked: "2026-10-14" }, 6);
    check("returns: a report with weeks_list or a dated ret is reported (retEstimated false); weeks alone stays estimated",
      [r67, r68, r0, rRet].every(x => x.retSource === "report" && x.retEstimated === false) && rWk.retEstimated === true,
      JSON.stringify([r67.retEstimated, r68.retEstimated, r0.retEstimated, rRet.retEstimated, rWk.retEstimated]));
    const old = rr({ kind: "report", weeks_list: [6, 7], checked: "2026-10-14", note: "audit" }, 10);
    const oldW = rr({ kind: "report", weeks: 2, checked: "2026-10-14" }, 10);
    const live = rr({ kind: "report", weeks_list: [6, 11], checked: "2026-10-14" }, 10);
    check("returns: a stale audit entry is ignored at (fake) week 10; one with a week still ahead holds",
      old.retSource === "default" && /ignored: weeks_list/.test(old.retNote) && oldW.retSource === "default" && /ignored/.test(oldW.retNote)
      && live.retSource === "report" && JSON.stringify(live.retWeeksList) === "[11]",
      JSON.stringify([old, oldW, live]));
  }
  {
    // consensus.mjs: importing it does not run it; the decision rules; a dead feed -> stale cache, exit 0.
    const C = await import(new URL("./consensus.mjs", import.meta.url));
    const d = o => C.decideWeek(o).decision, b = o => C.decideWeek(o);
    check("consensus: Sleeper + ESPN projections are one vote (in if either, out only if both)",
      C.projectionVote("in", "out") === "in" && C.projectionVote("out", null) === null && C.projectionVote("out", "out") === "out"
      && C.projectionVote(null, null) === null);
    check("consensus: current week, props and the projection vote agree -> that, no flag",
      d({ current: true, props: "out", sleeper: "out", espn: "out", auditOut: false }) === "out"
      && d({ current: true, props: "in", sleeper: "in", espn: "out", auditOut: true }) === "in"
      && !b({ current: true, props: "in", sleeper: "in", auditOut: true }).uncertain);
    const tie = [b({ current: true, props: "out", sleeper: "in", auditOut: true }), b({ current: true, props: "in", sleeper: "out", espn: "out", auditOut: false })];
    check("consensus: current week, props and the vote disagree -> the audit breaks the tie, flagged uncertain",
      tie[0].decision === "out" && tie[1].decision === "in" && tie.every(x => x.uncertain && x.basis === "audit-tiebreak"), JSON.stringify(tie));
    check("consensus: later weeks keep the audit unless BOTH projections say out",
      d({ sleeper: "out", espn: null, auditOut: false }) === "in" && d({ sleeper: "in", espn: "in", auditOut: true }) === "out"
      && d({ sleeper: "out", espn: "out", auditOut: false }) === "out" && d({ props: "out", sleeper: "out", auditOut: false }) === "in");
    check("consensus: a bye is never out", d({ bye: true, sleeper: "out", espn: "out", auditOut: true }) === "bye");
    const { spawnSync } = await import("node:child_process");
    const fs = await import("node:fs"), os = await import("node:os");
    const dir = fs.mkdtempSync(join(os.tmpdir(), "consensus-"));
    fs.mkdirSync(join(dir, "cache"));
    fs.copyFileSync(join(ROOT, "data", "consensus-cache", "dffl-rosters.json"), join(dir, "cache", "dffl-rosters.json"));
    fs.copyFileSync(join(ROOT, "injury-returns.json"), join(dir, "audit.json"));
    const before = fs.readFileSync(join(dir, "audit.json"), "utf8");
    const env = { ...process.env, CONSENSUS_TIMEOUT_MS: "3000" };
    for (const k of ["SLEEPER_API", "SLEEPER_PROJ", "ESPN_SITE", "ESPN_CORE", "ESPN_FANTASY"]) env[`CONSENSUS_${k}`] = "http://127.0.0.1:9";
    const run = spawnSync(process.execPath, ["consensus.mjs", "--audit", join(dir, "audit.json"), "--cache", join(dir, "cache"), "--from", "6", "--to", "7", "--dry-run"],
      { cwd: ROOT, env, encoding: "utf8", timeout: 60000 });
    const after = fs.readFileSync(join(dir, "audit.json"), "utf8");
    fs.rmSync(dir, { recursive: true, force: true });
    check("consensus CLI: sources down -> stale cache used ('stale: dffl-rosters'), missing cache noted, exit 0",
      run.status === 0 && /^stale: dffl-rosters$/m.test(run.stdout) && /^stale: sleeper-players \(no cache\)$/m.test(run.stdout)
      && /^consensus: \d+ injured/m.test(run.stdout) && after === before,
      JSON.stringify([run.status, run.stdout.slice(-300), run.stderr.slice(0, 200)]));
    // Not a dry run, every source dead: nothing written (no noise commit).
    const wdir = fs.mkdtempSync(join(os.tmpdir(), "consensus-w-"));
    fs.mkdirSync(join(wdir, "cache")); fs.mkdirSync(join(wdir, "data"));
    fs.copyFileSync(join(ROOT, "consensus.mjs"), join(wdir, "consensus.mjs"));
    fs.copyFileSync(join(ROOT, "data", "consensus-cache", "dffl-rosters.json"), join(wdir, "cache", "dffl-rosters.json"));
    fs.copyFileSync(join(ROOT, "injury-returns.json"), join(wdir, "injury-returns.json"));
    fs.copyFileSync(join(ROOT, "injuries.json"), join(wdir, "injuries.json"));
    const wBefore = fs.readFileSync(join(wdir, "injury-returns.json"), "utf8");
    const wrun = spawnSync(process.execPath, ["consensus.mjs", "--cache", "cache", "--from", "6", "--to", "7"],
      { cwd: wdir, env, encoding: "utf8", timeout: 60000 });
    const wAfter = fs.readFileSync(join(wdir, "injury-returns.json"), "utf8"), wReport = fs.existsSync(join(wdir, "data", "consensus.json"));
    fs.rmSync(wdir, { recursive: true, force: true });
    check("consensus CLI: a stale-only run writes neither injury-returns.json nor the report ('stale/no change, nothing written'), exit 0",
      wrun.status === 0 && /^consensus: stale\/no change, nothing written$/m.test(wrun.stdout) && wAfter === wBefore && !wReport,
      JSON.stringify([wrun.status, wrun.stdout.slice(-300), wReport]));
  }
  {
    // injury-refresh.yml: ±30 min gate, its own concurrency group, Sunday skip
    // while weekly-data runs, one regenerate-and-retry on a rebase failure, no force push.
    const fs = await import("node:fs");
    const y = fs.readFileSync(join(ROOT, ".github", "workflows", "injury-refresh.yml"), "utf8");
    const script = (y.match(/name: Commit anything that changed[\s\S]*$/) || [""])[0];
    check("injury-refresh.yml: gate within 30 min, shared sleeper-data concurrency group, actions: read + GH_TOKEN",
      /\[ \$d -lt 30 \]/.test(y) && !/-le 7/.test(y) && /group: sleeper-data/.test(y) && !/group: (weekly-data|injury-refresh)\b/.test(y)
        && /^\s+actions: read$/m.test(y) && /GH_TOKEN: \$\{\{ github\.token \}\}/.test(y));
    check("injury-refresh.yml: Sundays skip while a weekly-data.yml run is in progress or queued",
      /"\$dow" = 7/.test(y) && /gh run list[^\n]*--workflow weekly-data\.yml[^\n]*--status "\$st"/.test(y) && /for st in in_progress queued/.test(y) && /go=false/.test(y));
    check("injury-refresh.yml: pull --rebase; on failure abort, reset to origin, rerun the three scripts, retry once, then error; no force push",
      (script.match(/git pull --rebase/g) || []).length === 2 && /git rebase --abort/.test(script) && /git reset --hard "origin\/\$branch"/.test(script)
        && ["consensus.mjs", "build-injuries.mjs", "injury-returns.mjs"].every(f => script.includes(`node ${f}`))
        && /::error::/.test(script) && /exit 1\s*$/.test(script) && !/--force|push -f\b/.test(y));
  }
  {
    // sleeper-poll.yml and the concurrency groups. Static: files only.
    const fs = await import("node:fs");
    const wfPath = f => join(ROOT, ".github", "workflows", f);
    const names = ["weekly-data.yml", "injury-refresh.yml", "sleeper-poll.yml"];
    const wfs = Object.fromEntries(names.map(f => [f, fs.existsSync(wfPath(f)) ? fs.readFileSync(wfPath(f), "utf8") : ""]));
    const poll = wfs["sleeper-poll.yml"];
    check("sleeper-poll.yml exists with the 7,27,47 cron and workflow_dispatch",
      /cron:\s*"7,27,47 \* \* \* \*"/.test(poll) && /workflow_dispatch/.test(poll));
    // GitHub keeps one pending run per group, so weekly-data stays out of the
    // poll's group: a queued poll must never cancel a pending weekly run.
    const group = (f, g) => new RegExp(`concurrency:\\s*\\n\\s+group: ${g}\\s*\\n\\s+cancel-in-progress: false`).test(wfs[f]);
    check("sleeper-poll and injury-refresh share concurrency group sleeper-data, no cancel-in-progress",
      group("sleeper-poll.yml", "sleeper-data") && group("injury-refresh.yml", "sleeper-data"));
    check("weekly-data.yml keeps its own concurrency group weekly-data, no cancel-in-progress",
      group("weekly-data.yml", "weekly-data") && !/group: sleeper-data/.test(wfs["weekly-data.yml"]));
    const retry = w => { const s = (w.match(/name: Commit anything that changed[\s\S]*$/) || [""])[0];
      return (s.match(/git pull --rebase origin "\$branch" && git push origin "HEAD:\$branch"/g) || []).length === 2
        && /git rebase --abort/.test(s) && /git reset --hard "origin\/\$branch"/.test(s)
        && /::error::/.test(s) && /exit 1\s*$/.test(s) && !/--force|push -f\b|push\s+\+/.test(w); };
    check("all three workflows: pull --rebase + push; on failure abort, reset to origin, regenerate, retry once; no force",
      names.every(f => retry(wfs[f])), names.filter(f => !retry(wfs[f])).join(","));
    // build-email.mjs only writes data/odds-snapshot.json; every other mail-ish script is the routine's.
    const mailish = s => s !== "build-email.mjs" && /compose-email|send|sent-emails|mail|blast|poll-tally/.test(s);
    const bad = names.filter(f => [...wfs[f].matchAll(/node\s+([\w.-]+\.mjs)/g)].some(m => mailish(m[1]))
      || /compose-email|sent-emails/.test(wfs[f])
      || [...wfs[f].matchAll(/secrets\.(\w+)/g)].some(m => m[1] !== "GITHUB_TOKEN"));
    check("none of the three workflows compose/send/record email or use secrets beyond GITHUB_TOKEN/github.token",
      bad.length === 0, bad.join(","));
    check("sleeper-poll.yml: permissions are contents: write only",
      /permissions:\s*\n\s+contents: write\s*\n\s*\n/.test(poll) && !/actions: |pull-requests: |id-token: /.test(poll));
    let fp = null;
    try { fp = JSON.parse(fs.readFileSync(join(ROOT, "data", "sleeper-fingerprint.json"), "utf8")); } catch {}
    check("data/sleeper-fingerprint.json present and parses (season, week, transactions, rosters; no injuries)",
      !!fp && !!fp.season && Number.isFinite(fp.week) && Array.isArray(fp.transactions)
        && Object.keys(fp.rosters || {}).length >= 12 && !("injuries" in fp));
    // Sleeper asks that the 5MB player file be pulled about once a day; the poll runs 72 times.
    const fpSrc = fs.existsSync(join(ROOT, "sleeper-fingerprint.mjs")) ? fs.readFileSync(join(ROOT, "sleeper-fingerprint.mjs"), "utf8") : "";
    check("sleeper-fingerprint.mjs never fetches players/nfl (state, transactions and rosters only)",
      !!fpSrc && !/players\/nfl/.test(fpSrc) && /state\/nfl/.test(fpSrc) && /\/transactions\//.test(fpSrc) && /\/rosters/.test(fpSrc));
    const ir = wfs["injury-refresh.yml"];
    check("injury-refresh.yml runs build-email.mjs and build-odds-history.mjs (|| warning) and stages the odds files",
      /run: node build-email\.mjs/.test(ir) && /node build-odds-history\.mjs \|\| echo "::warning::/.test(ir)
        && /data\/odds-snapshot\.json/.test(ir) && /data\/odds-history\.json/.test(ir) && /dry_run/.test(ir));
    const checkAt = poll.indexOf("sleeper-fingerprint.mjs --check");
    const npmAt = Math.min(...["npm ci", "playwright"].map(s => poll.indexOf(s)).filter(i => i >= 0));
    check("sleeper-poll.yml: the fingerprint check comes before any npm/playwright step",
      checkAt > 0 && Number.isFinite(npmAt) && checkAt < npmAt);
    const steps = poll.split(/\n      - /).slice(1);
    const afterCheck = steps.slice(steps.findIndex(s => s.includes("--check")) + 1);
    check("sleeper-poll.yml: every step after the check is gated on changed == 'true'",
      afterCheck.length >= 9 && afterCheck.every(s => /if: steps\.fp\.outputs\.changed == 'true'/.test(s)));
    check("all three workflows write the fingerprint before committing; the poll rebases, retries once, never forces",
      names.every(f => { const w = wfs[f]; const at = w.indexOf("sleeper-fingerprint.mjs --write");
        return at > 0 && at < w.indexOf("name: Commit anything that changed"); })
        && (poll.match(/git pull --rebase/g) || []).length === 2 && /git reset --hard "origin\/\$branch"/.test(poll)
        && !/--force|push -f\b/.test(poll));
    check("no Claude/AI steps in the three workflows",
      names.every(f => !/anthropic|claude-code|claude_code|ANTHROPIC/i.test(wfs[f])));
  }
  check("odds sim: points come off the mean (hurt team loses wins, nobody else does)",
    io.sim && io.sim.team0[1] < io.sim.team0[0] && io.sim.others === io.sim.n - 1, JSON.stringify(io.sim));
  check("odds fallback: without projections the old multiplier prices the loss",
    io.fallback && Math.abs(io.fallback[0] - io.fallback[1]) < 1e-9, JSON.stringify(io.fallback));
  check("injury deltas: computed in the worker for every injured player; removing one never lowers playoff %",
    !!io.deltas && io.deltas.n > 0 && io.deltas.positive === 0 && io.deltas.sims === 2000, JSON.stringify(io.deltas));
  check("injury deltas: rows read playoffDelta/titleDelta from injuryPlayoffDeltas()", io.rowReads === true, String(io.rowReads));
  check("injury deltas: common random numbers — a no-op removal is exactly 0",
    !!io.crn && io.crn.noop[0] === 0 && io.crn.noop[1] === 0, JSON.stringify(io.crn));

  for (const [w, h] of [[390, 844], [1280, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.click('#tabs button[data-tab="odds"]');
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const p = document.querySelector('[data-panel="odds"]');
      return { shown: !!(p && p.offsetParent), doc: document.documentElement.scrollWidth, W: window.innerWidth,
        rule: !!document.querySelector('[data-inj-rule="points"]') };
    });
    check(`Odds tab at ${w}: renders, no horizontal overflow`, r.shown && r.doc <= r.W, JSON.stringify(r));
    if (w === 1280) check("Odds tab: method text states the points-lost rule when projections are published", r.rule, JSON.stringify(r));
  }
  await page.setViewportSize({ width: 1280, height: 900 });
}

group("Screenshots");
await page.click('#tabs button[data-tab="power"]');
await page.waitForTimeout(200);
await page.screenshot({ path: "power-desktop.png", fullPage: true });
await mobile.click('#tabs button[data-tab="power"]');
await mobile.waitForTimeout(200);
await mobile.screenshot({ path: "power-mobile.png", fullPage: true });
await page.click('#tabs button[data-tab="picture"]');
await page.waitForTimeout(200);
await page.screenshot({ path: "picture-desktop.png", fullPage: true });
await mobile.click('#tabs button[data-tab="picture"]');
await mobile.waitForTimeout(200);
await mobile.screenshot({ path: "picture-mobile.png", fullPage: true });
await page.click('#tabs button[data-tab="trades"]');
await page.waitForTimeout(200);
await page.screenshot({ path: "trades-desktop.png", fullPage: true });
await mobile.click('#tabs button[data-tab="trades"]');
await mobile.waitForTimeout(200);
await mobile.screenshot({ path: "trades-mobile.png", fullPage: true });
await page.click('#tabs button[data-tab="odds"]');
await page.waitForTimeout(200);
await page.screenshot({ path: "odds-desktop.png", fullPage: true });
await mobile.click('#tabs button[data-tab="odds"]');
await mobile.screenshot({ path: "odds-mobile.png", fullPage: true });
await page.click('#tabs button[data-tab="scores"]');
await page.waitForTimeout(200);
await page.screenshot({ path: "scores-desktop.png", fullPage: true });
await mobile.click('#tabs button[data-tab="scores"]');
await mobile.waitForTimeout(200);
await mobile.screenshot({ path: "scores-mobile.png", fullPage: true });
await page.click('#tabs button[data-tab="home"]');
await page.waitForTimeout(200);
await page.screenshot({ path: "home-desktop.png", fullPage: true });
await mobile.click('#tabs button[data-tab="home"]');
await mobile.waitForTimeout(200);
await mobile.screenshot({ path: "home-mobile.png", fullPage: true });
check("screenshots written", true);

/* ------------------------------------------ odds history: team rows */
group("Odds history: per-team odds for each finalized week");
{
  const { teamRowsFromSnapshot, mergeTeamWeeks } = await import("./odds-history.mjs");
  const hist = JSON.parse(await readFile(join(ROOT, "data/odds-history.json"), "utf8"));
  const snap = JSON.parse(await readFile(join(ROOT, "data/odds-snapshot.json"), "utf8"));
  const teams = hist.teams || {};
  const keys = Object.keys(teams);
  const p01 = x => typeof x === "number" && x >= 0 && x <= 1;
  const badRow = keys.flatMap(k => teams[k].map(r => [k, r])).find(([k, r]) =>
    !/^\d{4}-\d+$/.test(k) || typeof r.at !== "string" || Number.isNaN(Date.parse(r.at)) || !r.uid ||
    !p01(r.playoff) || !p01(r.title) || JSON.stringify(Object.keys(r)) !== '["at","uid","manager","playoff","title"]');
  check("team rows have shape { at, uid, manager, playoff, title } with chances in [0,1]", keys.length > 0 && !badRow, JSON.stringify(badRow));
  check("one row per team per week, all from one reading", keys.every(k =>
    new Set(teams[k].map(r => r.uid)).size === teams[k].length && new Set(teams[k].map(r => r.at)).size === 1));
  check("matchup line rows untouched alongside", hist.weeks && Object.values(hist.weeks).every(rows =>
    Array.isArray(rows) && rows.every(r => r.a && r.b && typeof r.pA === "number")));

  // Synthetic: the same week written twice is replaced, never duplicated.
  const S = (generated, week, pf, tt, over = {}) => ({ generated, season: "2026", week, liveWeek: null, settled: true,
    teams: [{ uid: "u1", manager: "m1", playoffNow: pf, titleNow: tt }, { uid: "u2", manager: "m2", playoffNow: 1 - pf, titleNow: 1 - tt }], ...over });
  const first = mergeTeamWeeks(undefined, [teamRowsFromSnapshot(S("2026-10-13T05:00:00.000Z", 6, 0.4, 0.1))]);
  const again = mergeTeamWeeks(first.teams, [teamRowsFromSnapshot(S("2026-10-13T05:00:00.000Z", 6, 0.4, 0.1))]);
  const second = mergeTeamWeeks(first.teams, [teamRowsFromSnapshot(S("2026-10-13T11:00:00.000Z", 6, 0.6, 0.2))]);
  const stale = mergeTeamWeeks(second.teams, [teamRowsFromSnapshot(S("2026-10-13T05:00:00.000Z", 6, 0.4, 0.1))]);
  check("a finalized week is keyed season-(week before the snapshot's)", JSON.stringify(Object.keys(first.teams)) === '["2026-5"]');
  check("writing the same reading twice changes nothing", !again.changed && JSON.stringify(again.teams) === JSON.stringify(first.teams));
  check("a newer reading of the same week replaces its rows, no duplicates", second.changed &&
    second.teams["2026-5"].length === 2 && second.teams["2026-5"][0].playoff === 0.6 && second.teams["2026-5"][0].title === 0.2);
  check("an older reading never overwrites a newer one", !stale.changed);
  check("a snapshot with a week in flight records nothing",
    teamRowsFromSnapshot(S("2026-10-12T11:00:00.000Z", 5, 0.5, 0.5, { liveWeek: 5, settled: false })) === null);

  // The committed snapshot, when it was read between weeks, must be the latest week on file.
  const want = teamRowsFromSnapshot(snap);
  if (want) {
    const have = teams[want.key];
    check(`latest finalized week ${want.key} is recorded from the committed snapshot`,
      keys.at(-1) === want.key && JSON.stringify(have) === JSON.stringify(want.rows), `latest on file ${keys.at(-1)}`);
  } else check("committed snapshot is mid-week, so no latest-week row is expected from it", true);
}

group("Trade-aware odds (data/roster-weeks.json)");
{
  const fs = await import("node:fs");
  const { lineupStrength } = await import(new URL("./build-roster-weeks.mjs", import.meta.url));
  let RW = null;
  try { RW = JSON.parse(await readFile(join(ROOT, "data/roster-weeks.json"), "utf8")); } catch {}
  const ids = a => Array.isArray(a) && a.every(p => typeof p === "string");
  const wkBad = RW && RW.weeks ? Object.entries(RW.weeks).flatMap(([wk, rs]) => Object.entries(rs)
    .filter(([, r]) => !ids(r.fielded) || !r.fielded.length || !ids(r.players) || !ids(r.optimal) || !Number.isFinite(r.strength))
    .map(([rid]) => `${wk}/${rid}`)) : ["missing"];
  const cur = (RW && RW.current) || {};
  const curBad = Object.entries(cur).filter(([, r]) => !ids(r.optimal) || !r.optimal.length || !Number.isFinite(r.strength)).map(([rid]) => rid);
  check("roster-weeks.json: updated, weeks with fielded arrays and numeric strength, current optimal+strength for all 12 rosters",
    !!RW && !Number.isNaN(Date.parse(RW.updated)) && Object.keys(RW.weeks || {}).length > 0
      && Object.values(RW.weeks).every(rs => Object.keys(rs).length === 12) && wkBad.length === 0
      && Object.keys(cur).length === 12 && curBad.length === 0,
    `weeks ${Object.keys((RW && RW.weeks) || {}).join(",")} · bad ${[...wkBad, ...curBad].slice(0, 5).join(" ")}`);

  // Strength is the build script's own function on today's projections; the
  // file's current strengths are reproducible from it.
  const P = JSON.parse(await readFile(join(ROOT, "data/projections.json"), "utf8"));
  const rost = JSON.parse(await readFile(join(ROOT, "rosters.json"), "utf8"));
  const posOf = p => (rost.map[p] || {}).p || "";
  const strengthOf = players => lineupStrength(players, P, posOf, rost.slots).strength;
  const redo = RW ? Object.entries(cur).filter(([, r]) => strengthOf(r.players) !== r.strength).map(([rid]) => rid) : ["no file"];
  check("roster-weeks.json: current strengths reproduce from lineupStrength() on data/projections.json", redo.length === 0, redo.join(","));

  // Fixtures below: a roster whose players never changed (every week = today),
  // a league where nobody's did, and today's trade undone. The fixture weeks'
  // strengths are off by a float's worth on purpose: the same players must
  // still give exactly 0.
  const nameRid = n => Object.entries(rost.map).find(([, v]) => v.n === n)?.[0];
  const puka = nameRid("Puka Nacua"), mhj = nameRid("Marvin Harrison"), evans = nameRid("Mike Evans");
  const res = !RW ? null : await page.evaluate(async ({ RW, puka, mhj, evans, undoStr }) => {
    const D = window.__DFFL, model = window.__ODDS, season = D.DB.seasons[0];
    const { R } = await D.liveOnce();
    const ridOf = name => { const u = season.users.find(x => x.display_name === name); return u ? season.rosters.find(r => r.owner_id === u.user_id).roster_id : null; };
    const strip = x => JSON.stringify(x);
    const run = async rw => {
      await D.loadRosterWeeks(rw);
      const live = D.liveState(model, season, R, window.__AVAIL, window.__BOARD, null, window.__PLAN);
      const s = live && D.simulateSeason(model, D.ODDS_SIMS, live);
      return { deltas: [...D.rosterDeltas], post: live && live.teams.map(t => t.mean),
        playoff: s && Object.fromEntries(live.teams.map((t, i) => [t.rid, s.playoff[i]])),
        counts: s && strip(["title", "playoff", "seed", "wins"].map(k => s[k])) };
    };
    const off = await run(null);
    const real = await run(RW);
    // (b) one roster that never changed: rid 10, everybody else as filed.
    const one = JSON.parse(JSON.stringify(RW));
    for (const wk in one.weeks) one.weeks[wk][10] && Object.assign(one.weeks[wk][10], { players: [...one.current[10].players], strength: one.current[10].strength + 1e-9 * Number(wk) });
    const oneRun = await run(one);
    // (c) nobody's roster changed: every Δ 0, so the board is the deltas-off board exactly.
    const none = JSON.parse(JSON.stringify(RW));
    for (const rid in none.current) for (const wk in none.weeks) none.weeks[wk][rid] && Object.assign(none.weeks[wk][rid], { players: [...none.current[rid].players], strength: none.current[rid].strength + 1e-9 * Number(wk) });
    const noneRun = await run(none);
    // (d) today's trade undone: Puka back to jskule23, Harrison and Evans back to Domo112.
    const domo = ridOf("Domo112"), jsk = ridOf("jskule23");
    const undo = JSON.parse(JSON.stringify(RW));
    undo.current[domo].strength = undoStr[0]; undo.current[jsk].strength = undoStr[1];
    const undoRun = await run(undo);
    await D.loadRosterWeeks();
    return { off, real, oneRun, noneRun, undoRun, domo, jsk,
      pukaOn: !!(RW.current[domo] && RW.current[domo].players.includes(puka)),
      restored: strip([...D.rosterDeltas]) === strip(real.deltas) };
  }, (() => {
    // Undo strengths, computed here with the build script's own function.
    if (!RW || !puka || !mhj || !evans) return { RW, puka, mhj, evans, undoStr: [NaN, NaN] };
    const holder = p => Object.keys(cur).find(rid => cur[rid].players.includes(p));
    const domo = holder(puka), jsk = holder(evans);
    const swap = (list, out, inn) => [...list.filter(p => !out.includes(p)), ...inn];
    return { RW, puka, mhj, evans, undoStr: [
      strengthOf(swap(cur[domo].players, [puka], [mhj, evans])),
      strengthOf(swap(cur[jsk].players, [mhj, evans], [puka])),
    ] };
  })());
  const dOf = (r, rid) => new Map(r.deltas).get(rid);
  check("roster Δ is exactly 0 for a roster whose players never changed (fixture: roster 10 same players every week)",
    !!res && dOf(res.oneRun, 10) === 0 && dOf(res.real, 10) !== undefined, res && JSON.stringify(res.oneRun.deltas));
  check("with every Δ 0 the live board equals the deltas-off board exactly (levels and sim counts, same seed)",
    !!res && res.noneRun.deltas.every(([, d]) => d === 0) && JSON.stringify(res.noneRun.post) === JSON.stringify(res.off.post)
      && res.noneRun.counts === res.off.counts && !!res.off.counts);
  check("no file: every Δ is 0 and the board is today's", !!res && res.off.deltas.length === 0);
  check("Puka Nacua is on Domo112's roster in roster-weeks.json", !!res && res.pukaOn && !!puka && !!mhj && !!evans,
    `puka ${puka} mhj ${mhj} evans ${evans}`);
  check("trade: Domo112's playoff odds go up and jskule23's go down vs deltas off",
    !!res && res.real.playoff[res.domo] > res.off.playoff[res.domo] && res.real.playoff[res.jsk] < res.off.playoff[res.jsk],
    res && `Domo112 ${res.off.playoff[res.domo]}→${res.real.playoff[res.domo]}, jskule23 ${res.off.playoff[res.jsk]}→${res.real.playoff[res.jsk]}`);
  check("trade: undoing it (Puka back for Harrison + Evans) lowers Domo112 and raises jskule23 vs the real file",
    !!res && res.undoRun.playoff[res.domo] < res.real.playoff[res.domo] && res.undoRun.playoff[res.jsk] > res.real.playoff[res.jsk],
    res && `Domo112 ${res.undoRun.playoff[res.domo]} vs ${res.real.playoff[res.domo]}, jskule23 ${res.undoRun.playoff[res.jsk]} vs ${res.real.playoff[res.jsk]}`);
  check("loadRosterWeeks() restores the file's deltas after the fixtures", !!res && res.restored);

  const hist = join(ROOT, "data", "projections-history");
  const badHist = fs.existsSync(hist) ? fs.readdirSync(hist).filter(f => !/^\d{4}-wk\d{2}\.json$/.test(f)) : [];
  check("data/projections-history/: every file is <season>-wk<NN>.json", badHist.length === 0, badHist.join(","));
}

/* -------------------------------------------------------------- done */
await browser.close();
server.close();
console.log(`\n${"=".repeat(52)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log(`\nFailures:`); failures.forEach(f => console.log(`  - ${f}`)); }
console.log(`${"=".repeat(52)}\n`);
process.exit(fail ? 1 : 0);

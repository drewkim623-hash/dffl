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
const EXPECT = ["home", "scores", "managers", "records", "matchups", "power", "odds", "race", "draft", "trades", "recaps"];
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
  const prices = [...p.querySelectorAll(".price .o")].map(e => e.textContent.trim());
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
  return {
    loaded: true, n: a.n, meta: a.meta, keeperPicks: picks.length, keeperHits: hit,
    v1: adpValue(1), v50: adpValue(50), v180: adpValue(180),
    monotone: [1, 5, 12, 25, 50, 100, 180, 220].every((x, i, arr) => i === 0 || adpValue(x) <= adpValue(arr[i - 1])),
    floored: adpValue(9999) === ADP_CURVE.floor && adpValue(0) === ADP_CURVE.floor,
    kMapped: adpKey("Brandon Aubrey", "K") === adpKey("Brandon Aubrey", "PK"),
    suffix: adpKey("James Cook III", "RB") === adpKey("James Cook", "RB"),
  };
});
check("ADP snapshot loads", adp.loaded);
check("210 players on the board", adp.n === 210, `${adp.n}`);
check("snapshot is 12-team non-PPR, matching DFFL scoring", adp.meta.teams === 12 && adp.meta.format === "Non-PPR", JSON.stringify([adp.meta.teams, adp.meta.format]));
check("every existing 2026 pick prices against it", adp.keeperHits === adp.keeperPicks && adp.keeperPicks > 0, `${adp.keeperHits}/${adp.keeperPicks}`);
check("value curve decreases with draft position", adp.monotone);
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
    // the same probability must be behind the top price on the odds board
    boardTop: odds.querySelector(".price .tp").textContent.trim(),
    homeTop: homePcts[0].title.toFixed(1) + "%",
    noStaleCopy: !home.textContent.includes("Three thousand"),
  };
});
check("Home lists all twelve managers", agree.count === 12, `${agree.count}`);
check("Home title odds come from the same simulation as the board", agree.matches);
check("Home and the odds board show the same favourite probability", agree.boardTop === agree.homeTop, `${agree.homeTop} vs ${agree.boardTop}`);
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

group("News & Articles");
const tabName = await page.evaluate(() =>
  document.querySelector('#tabs button[data-tab="recaps"]').textContent);
check("the tab is named for what it holds now", tabName === "News & Articles", tabName);
check("the old #recaps link still works", (await page.evaluate(() => !!document.querySelector('[data-panel="recaps"]'))));

const artl = await page.evaluate(async () => {
  const D = window.__DFFL;
  const panel = await D.panelRecaps();
  const a = panel.querySelector(".artl");
  const txt = a ? a.innerText : "";
  return {
    articles: panel.querySelectorAll(".artl").length,
    headline: a ? a.querySelector("h2").textContent : null,
    paras: panel.querySelectorAll(".apara").length,
    leads: panel.querySelectorAll(".apara.lead").length,
    heads: panel.querySelectorAll(".ahead h3").length,
    stats: panel.querySelectorAll(".astat").length,
    bars: panel.querySelectorAll(".abar").length,
    cards: panel.querySelectorAll(".acard").length,
    picks: panel.querySelectorAll(".apick").length,
    bold: panel.querySelectorAll(".apara b").length,
    // the bars must diverge about the zero line, not all point one way
    barsBothWays: (() => {
      const f = [...panel.querySelectorAll(".abar .fill")].map(n => parseFloat(n.style.left));
      return f.some(l => l < 49.9) && f.some(l => l >= 49.9);
    })(),
    nan: /NaN|undefined/.test(txt),
    // the article leads the section; the weekly log follows it
    articleFirst: [...panel.children].findIndex(n => n.classList.contains("artl")) <
      Math.max(1, [...panel.children].findIndex(n => n.classList.contains("wkhead"))) ||
      !panel.querySelector(".wkhead"),
  };
});
check("the draft piece is on the page", artl.articles === 1 && artl.headline === "The CPES Problem", artl.headline);
check("every block type renders", artl.paras > 20 && artl.heads === 8 && artl.stats === 2 && artl.bars === 12 && artl.cards === 3 && artl.picks === 5,
  `${artl.paras}p ${artl.heads}h ${artl.stats}stat ${artl.bars}bar ${artl.cards}card ${artl.picks}pick`);
check("the lead paragraph is marked for its drop cap", artl.leads === 1, `${artl.leads}`);
check("bold survives the escaping", artl.bold > 5, `${artl.bold}`);
check("the projection bars diverge both ways", artl.barsBothWays);
check("articles lead the section", artl.articleFirst);
check("no NaN in the article", artl.nan === false);

const artSafe = await page.evaluate(async () => {
  const D = window.__DFFL;
  // Copy in a file is copy, never markup: only <b> may survive.
  const evil = { articles: [{ season: "2026", date: "2026-01-01", headline: "<img src=x onerror=alert(1)>",
    dek: "<script>alert(2)<\/script>", byline: "x",
    blocks: [
      { type: "p", text: "safe <b>bold</b> and <i>italic</i> and <a href=#>link</a>" },
      { type: "h", eyebrow: "<b>eye</b>", text: "<b>head</b>" },
      { type: "bogus", text: "unknown" },
      null,
    ] }], weeks: [] };
  const realFetch = window.fetch;
  window.fetch = u => String(u).includes("recaps.json")
    ? Promise.resolve({ ok: true, json: () => Promise.resolve(evil) }) : realFetch(u);
  const panel = await D.panelRecaps();
  window.fetch = realFetch;
  const p0 = panel.querySelector(".apara");
  return {
    imgs: panel.querySelectorAll("img").length,
    scripts: panel.querySelectorAll("script").length,
    anchors: panel.querySelectorAll(".abd a").length,
    italics: panel.querySelectorAll(".apara i").length,
    boldKept: p0 ? p0.querySelectorAll("b").length : -1,
    paraText: p0 ? p0.textContent : "",
    headlineIsText: panel.querySelector(".artl h2").textContent,
    headingHasNoTags: panel.querySelector(".ahead h3").children.length,
    unknownDropped: panel.querySelectorAll(".abd > *").length,
  };
});
check("markup in the copy is escaped, not run", artSafe.imgs === 0 && artSafe.scripts === 0 && artSafe.anchors === 0);
check("only bold survives", artSafe.boldKept === 1 && artSafe.italics === 0, `${artSafe.boldKept} bold, ${artSafe.italics} italic`);
check("escaped tags read as text", /<i>italic<\/i>/.test(artSafe.paraText), artSafe.paraText);
check("a headline is text, whatever it contains", /<img/.test(artSafe.headlineIsText));
check("headings take no markup at all", artSafe.headingHasNoTags === 0);
check("an unknown block type is dropped rather than guessed at", artSafe.unknownDropped === 2, `${artSafe.unknownDropped}`);

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
  const s26 = DB.seasons[0], s25 = DB.seasons[1], oldest = DB.seasons[DB.seasons.length - 1];
  const k26 = D.keepersOf(s26), k25 = D.keepersOf(s25), kOld = D.keepersOf(oldest);
  // A held-over player must actually have been on that manager's roster last year.
  const prev = DB.seasons[1];
  const held = new Map();
  for (const r of prev.rosters) { const u = prev.uidOf.get(r.roster_id); if (u) held.set(u, new Set(r.players || [])); }
  const marked = (s26.picks || []).filter(p => k26.has(String(p.player_id)));
  const everyMarkedWasHeld = marked.every(p => p.is_keeper || (held.get(p.picked_by) || new Set()).has(p.player_id));
  const perMgr = {};
  for (const p of marked) perMgr[p.picked_by] = (perMgr[p.picked_by] || 0) + 1;
  const flagged = (s26.picks || []).filter(p => p.is_keeper);
  return {
    k26: k26.size, k25: k25.size, kOldest: kOld.size,
    flaggedOnly: flagged.length,
    // every pick Sleeper does flag must also be caught by the derivation
    flaggedAreCaught: flagged.every(p => k26.has(String(p.player_id))),
    everyMarkedWasHeld,
    managers: Object.keys(perMgr).length,
    maxPerManager: Math.max(...Object.values(perMgr)),
    posClasses: ["QB", "RB", "WR", "TE", "K", "DEF", "P"].map(x => D.posClass(x)),
  };
});
check("keepers are derived, not left to Sleeper's sparse flag", draftT.k26 > 30 && draftT.flaggedOnly < 5, `${draftT.k26} derived vs ${draftT.flaggedOnly} flagged`);
check("every pick Sleeper flags is caught too", draftT.flaggedAreCaught);
check("every marked keeper really was on that roster last year", draftT.everyMarkedWasHeld);
check("every manager kept somebody", draftT.managers === 12, `${draftT.managers}`);
check("nobody is credited with an absurd number of keepers", draftT.maxPerManager <= 6, `${draftT.maxPerManager}`);
check("the first season on record has no keepers to derive", draftT.kOldest === 0, `${draftT.kOldest}`);
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
    legend: /held over from 2025/.test(panel.innerText),
    saysThree: /keeps three/.test(panel.innerText),
    rounds: panel.querySelectorAll(".brd").length,
    nan: /NaN|undefined/.test(panel.innerText),
  };
});
check("the draft opens on the board, not a long list", draftDom.defaultView === "board" && draftDom.views.join(",") === "board,mgr,list");
check("the board is 12 columns by 15 rounds", draftDom.cells === 180 && draftDom.headers === 13 && draftDom.rounds === 15,
  `${draftDom.cells} cells, ${draftDom.headers} headers, ${draftDom.rounds} rounds`);
check("keepers are marked K on the board", draftDom.kmarks > 30, `${draftDom.kmarks}`);
check("the legend says exactly what a K means", draftDom.legend && draftDom.saysThree);
check("no NaN on the draft board", draftDom.nan === false);

const byMgr = await page.evaluate(async () => {
  const panel = document.querySelector('[data-panel="draft"]');
  const sels = panel.querySelectorAll("select");
  sels[0].value = "2025"; sels[0].dispatchEvent(new Event("change"));
  await new Promise(r => setTimeout(r, 400));
  sels[1].value = "mgr"; sels[1].dispatchEvent(new Event("change"));
  const cards = panel.querySelectorAll(".dcard");
  const picks = panel.querySelectorAll(".dp");
  return { cards: cards.length, picks: picks.length, ks: panel.querySelectorAll(".dp .k").length,
    perCard: [...cards].map(c => c.querySelectorAll(".dp").length) };
});
check("by-manager gives every manager a card", byMgr.cards === 12, `${byMgr.cards}`);
check("every pick lands on exactly one card", byMgr.picks === 180, `${byMgr.picks}`);
check("keepers are marked there too", byMgr.ks > 20, `${byMgr.ks}`);

const card = await page.evaluate(async () => {
  const panel = document.querySelector('[data-panel="draft"]');
  const sels = panel.querySelectorAll("select");
  sels[1].value = "board"; sels[1].dispatchEvent(new Event("change"));
  await new Promise(r => setTimeout(r, 500));
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

const unplayed = await page.evaluate(async () => {
  const panel = document.querySelector('[data-panel="draft"]');
  const sels = panel.querySelectorAll("select");
  sels[0].value = "2026"; sels[0].dispatchEvent(new Event("change"));
  await new Promise(r => setTimeout(r, 500));
  panel.querySelector(".bc").click();
  await new Promise(r => setTimeout(r, 60));
  const m = document.querySelector(".modal");
  const out = { empty: m ? m.querySelectorAll(".mempty").length : -1, charts: m ? m.querySelectorAll(".wkchart").length : -1,
    txt: m ? m.innerText : "" };
  if (m) m.remove();
  return out;
});
check("a player from an unplayed season says so instead of charting zeros", unplayed.empty === 1 && unplayed.charts === 0, JSON.stringify(unplayed).slice(0, 120));

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
  race: document.body.dataset.raceReady || null,
  tradeHost: !!document.querySelector("#tradesHost"),
  raceHost: !!document.querySelector("#raceHost"),
}));
check("booting fetches no transactions, no player file and no draft detail", heavy.length === 0, heavy.slice(0, 3).join(", "));
check("neither lazy tab has run at boot", lazyState.trades === null && lazyState.race === null, JSON.stringify(lazyState));
check("both lazy panels are on the page regardless", lazyState.tradeHost && lazyState.raceHost);
await lazyPage.close();

group("Race: the off-season state");
await page.click('#tabs button[data-tab="race"]');
await page.waitForFunction(() => document.body.dataset.raceReady, null, { timeout: 120000 });
const offSeason = await page.evaluate(() => {
  const R = window.__RACEDATA, panel = document.querySelector('[data-panel="race"]');
  return {
    state: document.body.dataset.raceReady, why: R.why, ready: R.ready,
    played: R.decided.length,
    emptyText: (panel.querySelector(".empty") || {}).innerText || "",
    honesty: panel.querySelector(".mode .what") ? panel.querySelector(".mode .what").innerText : "",
    tables: panel.querySelectorAll("table").length,
  };
});
// 2026 is drafted but unplayed, so there is no race yet — and the page must say
// so rather than modelling a season from nothing.
check("with no games played the race reports no race", offSeason.ready === false && offSeason.why === "not-started", `${offSeason.why}`);
check("the off-season state renders an explanation", /hasn't started/.test(offSeason.emptyText) && offSeason.emptyText.length > 80, offSeason.emptyText.slice(0, 60));
check("the off-season state invents no numbers", offSeason.tables === 0 && !/%/.test(offSeason.emptyText));
check("the page says these are model outputs, not predictions", /model outputs, not predictions/.test(offSeason.honesty), offSeason.honesty.slice(0, 60));

group("Race: playoff odds on a season that was actually played");
const race = await page.evaluate(() => {
  const D = window.__DFFL, DB = D.DB;
  const season = DB.seasons.find(s => s.season === "2025");
  const dist = D.scoringDist();
  const R = D.raceAsOf(season, 10);
  const O = D.raceOdds(R, dist, 20000);
  const sum = k => O.rows.reduce((a, r) => a + r[k], 0);
  const byDiv = {};
  for (const r of O.rows) byDiv[r.div] = (byDiv[r.div] || 0) + r.divWin;
  // Nothing may be modelled from before the cut: the fixed record has to be
  // exactly what happened through week 10.
  const realW = new Map();
  for (const g of season.games.filter(g => !g.playoff && g.week <= 10)) {
    const win = g.a.pts > g.b.pts ? g.a.rid : g.b.rid;
    realW.set(win, (realW.get(win) || 0) + 1);
  }
  return {
    n: O.rows.length, sims: O.sims,
    playoffSum: sum("playoff"), byeSum: sum("bye"), winsSum: sum("projWins"),
    divSums: byDiv, divs: Object.keys(byDiv).length,
    recordsMatch: O.rows.every(r => (realW.get(r.rid) || 0) === r.w),
    gamesFixed: R.decided.length, gamesLeft: R.upcoming.length,
    // every remaining fixture must be a real one off Sleeper's schedule
    scheduleReal: R.upcoming.every(g => season.games.some(x =>
      x.week === g.week && ((x.a.rid === g.a && x.b.rid === g.b) || (x.a.rid === g.b && x.b.rid === g.a)))),
    inRange: O.rows.every(r => [r.playoff, r.divWin, r.bye].every(v => isFinite(v) && v >= 0 && v <= 1)),
    byeNeverExceedsPlayoff: O.rows.every(r => r.bye <= r.playoff + 1e-9),
    divNeverExceedsPlayoff: O.rows.every(r => r.divWin <= r.playoff + 1e-9),
    finite: O.rows.every(r => isFinite(r.pf) && isFinite(r.projWins) && isFinite(r.w) && isFinite(r.l)),
  };
});
check("the fixed record is exactly what actually happened", race.recordsMatch);
check("the remaining fixtures are the real schedule, not invented ones", race.scheduleReal, `${race.gamesLeft} games left`);
check("playoff odds across the league sum to the six places", near(race.playoffSum, 6, 1e-9), `${race.playoffSum}`);
check("bye odds sum to the two byes", near(race.byeSum, 2, 1e-9), `${race.byeSum}`);
check("division-winner odds sum to 1 inside every division",
  Object.values(race.divSums).every(v => near(v, 1, 1e-9)) && race.divs >= 2, JSON.stringify(race.divSums));
check("projected wins sum to one per game played", near(race.winsSum, 84, 1e-9), `${race.winsSum}`);
check("every probability lands between 0 and 1", race.inRange);
check("a bye is never likelier than the playoffs", race.byeNeverExceedsPlayoff);
check("a division title is never likelier than the playoffs", race.divNeverExceedsPlayoff);
check("no NaN in the race table", race.finite);

group("Race: clinched and eliminated");
const dead = await page.evaluate(() => {
  const D = window.__DFFL, DB = D.DB;
  const season = DB.seasons.find(s => s.season === "2025");
  const dist = D.scoringDist();
  // One week left. Anybody who cannot reach the sixth-best win total is
  // mathematically out, whatever the simulation thinks.
  const R = D.raceAsOf(season, 13);
  const O = D.raceOdds(R, dist, 5000);
  const left = new Map();
  for (const g of R.upcoming) { left.set(g.a, (left.get(g.a) || 0) + 1); left.set(g.b, (left.get(g.b) || 0) + 1); }
  const wins = O.rows.map(r => r.w).sort((a, b) => b - a);
  const sixth = wins[5];
  const impossible = O.rows.filter(r => r.w + (left.get(r.rid) || 0) < sixth);
  const certain = O.rows.filter(r => r.w > wins[5] + Math.max(...O.rows.map(x => left.get(x.rid) || 0)));
  return {
    impossible: impossible.length, impossibleOdds: impossible.map(r => r.playoff),
    certainOdds: certain.map(r => r.playoff),
    zeroCount: O.rows.filter(r => r.playoff <= 0).length,
    oneCount: O.rows.filter(r => r.playoff >= 1).length,
    sixth,
  };
});
check("a mathematically eliminated team shows exactly 0%", dead.impossible > 0 && dead.impossibleOdds.every(v => v === 0), `${dead.impossible} eliminated, odds ${dead.impossibleOdds.join(",")}`);
check("teams that cannot be caught show exactly 100%", dead.certainOdds.every(v => v === 1), dead.certainOdds.join(","));
check("clinched and eliminated are both reachable states", dead.zeroCount > 0 && dead.oneCount > 0, `${dead.oneCount} clinched, ${dead.zeroCount} out`);

group("Race: leverage");
const lev = await page.evaluate(() => {
  const D = window.__DFFL, DB = D.DB;
  const season = DB.seasons.find(s => s.season === "2025");
  const dist = D.scoringDist();
  const R = D.raceAsOf(season, 10);
  const board = D.leverageBoard(R, dist, 11, 4000);
  // Forcing a team to win must never leave it worse off. Run one game both ways
  // and compare every team's odds directly, not just the two playing.
  const g = R.upcoming.find(x => x.week === 11);
  const ifA = D.raceOdds(R, dist, 6000, { week: 11, win: g.a, lose: g.b });
  const ifB = D.raceOdds(R, dist, 6000, { week: 11, win: g.b, lose: g.a });
  const aWithWin = ifA.byRid.get(g.a).playoff, aWithLoss = ifB.byRid.get(g.a).playoff;
  const bWithWin = ifB.byRid.get(g.b).playoff, bWithLoss = ifA.byRid.get(g.b).playoff;
  return {
    games: board.length, sims: board[0] && board[0].sims,
    ranked: board.every((x, i) => i === 0 || board[i - 1].total >= x.total),
    swingsPositive: board.every(x => x.aSwing >= -0.02 && x.bSwing >= -0.02),
    totalsFinite: board.every(x => isFinite(x.total) && x.total >= 0 && x.total <= board.length * 12),
    aGain: aWithWin - aWithLoss, bGain: bWithWin - bWithLoss,
    // a forced win cannot cost the forced team wins on the season either
    aWinsUp: ifA.byRid.get(g.a).projWins > ifB.byRid.get(g.a).projWins,
    biggestIsLargest: board.length > 1 && board[0].total >= board[1].total,
  };
});
check("every game on the slate gets a leverage number", lev.games === 6, `${lev.games}`);
check("leverage runs at the lower simulation count", lev.sims === 4000, `${lev.sims}`);
check("the slate is ranked by how much it moves", lev.ranked && lev.biggestIsLargest);
check("forcing a win never lowers that team's playoff odds", lev.aGain >= -0.02 && lev.bGain >= -0.02, `${lev.aGain.toFixed(4)} / ${lev.bGain.toFixed(4)}`);
check("winning a game is worth something to both sides", lev.swingsPositive);
check("a forced win adds to that team's projected wins", lev.aWinsUp, `${lev.aGain}`);
check("league-wide swings stay finite", lev.totalsFinite);

group("Race: the board renders");
const drawn = await page.evaluate(() => {
  const D = window.__DFFL, DB = D.DB;
  const season = DB.seasons.find(s => s.season === "2025");
  const dist = D.scoringDist();
  const R = D.raceAsOf(season, 10);
  const O = D.raceOdds(R, dist, 4000), LEV = D.leverageBoard(R, dist, 11, 800);
  const host = document.querySelector("#raceHost");
  D.renderRace(host, R, O, LEV);
  const txt = host.innerText;
  return {
    tables: host.querySelectorAll("table").length,
    rows: host.querySelectorAll("table")[0].querySelectorAll("tbody tr").length,
    big: !!host.querySelector(".bigg"),
    tiles: host.querySelectorAll(".tile").length,
    tags: host.querySelectorAll(".badge").length,
    nan: /NaN|undefined|Infinity/.test(txt),
    saysSims: /20|4,000|simulations/i.test(txt),
  };
});
check("the race board draws both tables", drawn.tables === 2, `${drawn.tables}`);
check("every manager gets a row", drawn.rows === 12, `${drawn.rows}`);
check("the biggest game of the week is called out", drawn.big);
check("the race summary tiles render", drawn.tiles === 4, `${drawn.tiles}`);
check("clinched and eliminated tags reach the page", drawn.tags > 0, `${drawn.tags}`);
check("no NaN or undefined on the race board", drawn.nan === false);

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
    haulsSane: L.pickHauls.every(r => isFinite(r.pts) && r.pts >= 0 && r.no > 0 && !!r.name),
    haulsZero: L.pickHauls.filter(r => r.pts === 0).length,
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
check("every priced haul has a real player and a real slot", picks.haulsSane, `${picks.haulsZero} of them drafted a player who never scored`);

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

// the race board at phone width, with a season that actually has a race in it
await mobile.click('#tabs button[data-tab="race"]');
await mobile.waitForFunction(() => document.body.dataset.raceReady, null, { timeout: 120000 });
const raceNarrow = await mobile.evaluate(() => {
  const D = window.__DFFL, DB = D.DB;
  const season = DB.seasons.find(s => s.season === "2025");
  const dist = D.scoringDist();
  const R = D.raceAsOf(season, 10);
  D.renderRace(document.querySelector("#raceHost"), R, D.raceOdds(R, dist, 3000), D.leverageBoard(R, dist, 11, 500));
  const panel = document.querySelector('[data-panel="race"]');
  const over = [];
  for (const n of panel.querySelectorAll("*")) {
    if (n.closest(".scroll")) continue;
    const r = n.getBoundingClientRect();
    if (r.width && r.right > window.innerWidth + 1) over.push((n.className || n.tagName) + " → " + Math.round(r.right));
  }
  return { over: over.slice(0, 6), doc: document.documentElement.scrollWidth, inner: window.innerWidth,
    rows: panel.querySelectorAll("tbody tr").length };
});
check("race: page does not scroll horizontally at 390px", raceNarrow.doc <= raceNarrow.inner, `${raceNarrow.doc} > ${raceNarrow.inner}`);
check("race: nothing outside a scroller overflows at 390px", raceNarrow.over.length === 0, raceNarrow.over.join(" | "));
check("race: the whole board renders at 390px", raceNarrow.rows >= 18, `${raceNarrow.rows} rows`);

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

group("Screenshots");
await page.click('#tabs button[data-tab="power"]');
await page.waitForTimeout(200);
await page.screenshot({ path: "power-desktop.png", fullPage: true });
await mobile.click('#tabs button[data-tab="power"]');
await mobile.waitForTimeout(200);
await mobile.screenshot({ path: "power-mobile.png", fullPage: true });
await page.click('#tabs button[data-tab="race"]');
await page.waitForTimeout(200);
await page.screenshot({ path: "race-desktop.png", fullPage: true });
await mobile.click('#tabs button[data-tab="race"]');
await mobile.waitForTimeout(200);
await mobile.screenshot({ path: "race-mobile.png", fullPage: true });
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
check("screenshots written", true);

/* -------------------------------------------------------------- done */
await browser.close();
server.close();
console.log(`\n${"=".repeat(52)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log(`\nFailures:`); failures.forEach(f => console.log(`  - ${f}`)); }
console.log(`${"=".repeat(52)}\n`);
process.exit(fail ? 1 : 0);

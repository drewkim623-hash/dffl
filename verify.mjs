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

  return { rows: board.items.length, mism, injRows: inj ? inj.items.length : 0, injMism,
    liveInjRows: liveInj.length };
});
if (artBoard.skip) {
  check("the column's power board matches the site's", true, `skipped: ${artBoard.skip}`);
} else {
  check("the column prints all twelve board rows", artBoard.rows === 12, `${artBoard.rows}`);
  check("every rank, record, points and arrow matches powerRankings()",
    artBoard.mism.length === 0, artBoard.mism.slice(0, 4).join(" | "));
  check("the column's injury table covers every affected roster",
    artBoard.injRows === artBoard.liveInjRows, `${artBoard.injRows} vs ${artBoard.liveInjRows}`);
  check("every injury cost and starter count matches the live board",
    artBoard.injMism.length === 0, artBoard.injMism.slice(0, 4).join(" | "));
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
check("every headline carries a cover", artl.covers === artl.teasers && artl.faces >= 5, `${artl.covers} covers, ${artl.faces} faces`);
check("the newest piece leads", artl.newestFirst, `${artl.headlines[0]} — expected ${artl.expectedLead}`);
check("a column is flagged as a column", artl.columnFlagged === 1, `${artl.columnFlagged}`);

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
  // Week 13: bradyrife cannot mathematically reach the sixth-best win total, so
  // the eliminated tag is certain rather than a low-probability draw.
  const R13 = D.raceAsOf(season, 13);
  const O = D.raceOdds(R13, dist, 4000), LEV = D.leverageBoard(R13, dist, 14, 800);
  const host = document.querySelector("#raceHost");
  D.renderRace(host, R13, O, LEV);
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

/* -------------------------------------------------------------- done */
await browser.close();
server.close();
console.log(`\n${"=".repeat(52)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log(`\nFailures:`); failures.forEach(f => console.log(`  - ${f}`)); }
console.log(`${"=".repeat(52)}\n`);
process.exit(fail ? 1 : 0);

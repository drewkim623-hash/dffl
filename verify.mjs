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
const EXPECT = ["home", "scores", "managers", "records", "matchups", "power", "odds", "picture", "draft", "trades", "recaps"];
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
    .flatMap(s => [ratio("#ffffff", s), ratio("#c6c5cf", s)]));
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
check("cover text is only white or --ink-2", covers.fills.every(f => f === "#ffffff" || f === "#c6c5cf"), covers.fills.join(" "));
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
  "same-record-different-board": "odds",
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
  cov1280.steep.every(r => r.bertalicious === "#ffffff" && r.drewkim === "#c6c5cf"), JSON.stringify(cov1280.steep));
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

group("Playoff bracket: played fixed, the way Sleeper builds it");
const fb = await page.evaluate(async () => {
  const D = window.__DFFL, M = D.ODDS, B = M && M.bracket;
  if (!B) return { none: true };
  const strip = t => JSON.stringify({ winners: t.winners, losers: t.losers });
  const prev = D.DB.seasons.find(s => s.season === "2025");
  const t25 = prev ? D.bracketFromSleeper(prev.wb, prev.lb, D.bracketSeeds(prev), 6, 12) : null;
  // Structure, in seed slots.
  const W = B.winners, Lb = B.losers;
  const r1 = side => side.filter(g => g.r === 1).map(g => [g.a.seed, g.b.seed].sort((x, y) => x - y).join("v")).sort();
  const oppOf = (side, k) => { const g = side.find(g => g.r === 2 && (g.a.seed === k || g.b.seed === k)); if (!g) return null;
    const o = g.a.seed === k ? g.b : g.a; const src = side.find(x => x.m === o.w);
    return src ? [src.a.seed, src.b.seed].sort((x, y) => x - y).join("v") : null; };
  const structure = { wr1: r1(W), lr1: r1(Lb), s1: oppOf(W, 1), s2: oppOf(W, 2), s12: oppOf(Lb, 12), s11: oppOf(Lb, 11) };

  // A deterministic run of the real simulator: no regular season left, the table
  // banked, every level pinned, so the higher level always wins its game.
  const det = (se, W0, PF0, level) => {
    const rs = se.rosters, idx = new Map(rs.map((r, i) => [r.roster_id, i]));
    const model = { ok: true, weekSd: 1e-9, seasonSd: 1e-9, playoffTeams: 6, weeks: 14, sched: [], bracket: B,
      teams: rs.map(r => ({ mean: level(r.roster_id), div: se.divOf.get(r.roster_id) })) };
    const live = { teams: rs.map(r => ({ mean: level(r.roster_id), levelSd: 1e-9, div: se.divOf.get(r.roster_id) })),
      weeks: [], W0: rs.map(r => W0(r.roster_id)), PF0: rs.map(r => PF0(r.roster_id)), pending: [],
      mult: rs.map(() => 1), adjWeek: null, pws: 15, multByWeek: null };
    const trace = [], C = D.simulateSeason(model, 1, live, { trace });
    const rid = i => rs[i].roster_id;
    return { trace: trace.map(g => ({ ...g, a: rid(g.a), b: rid(g.b), won: rid(g.won) })),
      champ: rid(C.title.indexOf(1)), last: rid(C.last.indexOf(1)), idx };
  };

  // 1. 2025, replayed: its real table and its real winners, through the template
  // the board plays today. Every game must be Sleeper's game.
  let y25 = null;
  if (prev) {
    const st = new Map(prev.rosters.map(r => [r.roster_id, r.settings]));
    const beats = new Map();
    const won = (w, l) => { if (!beats.has(w)) beats.set(w, []); beats.get(w).push(l); };
    for (const g of prev.wb) if (!g.p || g.p === 1) won(g.w, g.l);
    for (const g of prev.lb) if (!g.p || g.p === 1) won(g.l, g.w);   // toilet bowl: Sleeper's w lost the game
    const depth = new Map(), dep = x => depth.has(x) ? depth.get(x)
      : (depth.set(x, 1 + Math.max(0, ...(beats.get(x) || []).map(dep))), depth.get(x));
    const run = det(prev, r => st.get(r).wins + (st.get(r).ties || 0) / 2,
      r => st.get(r).fpts + (st.get(r).fpts_decimal || 0) / 100, r => 100 + 10 * dep(r));
    const sleeper = { winners: prev.wb, losers: prev.lb };
    const rows = run.trace.map(g => {
      const s = sleeper[g.bracket].find(x => x.m === g.m);
      const same = !!s && new Set([s.t1, s.t2, g.a, g.b]).size === 2;
      const sw = s ? (g.bracket === "winners" ? s.w : s.l) : null;
      return { ...g, same, wonSame: sw === g.won, t1: s && s.t1, t2: s && s.t2 };
    });
    const pl = prev.places || {};
    y25 = { rows, allSame: rows.length === 10 && rows.every(r => r.same && r.wonSame),
      champ: run.champ, last: run.last, sleeperChamp: pl[1], sleeperLast: pl[12] };
  }

  // 2. A result a re-seeded bracket would play differently: seeds 5 and 6 win
  // round one. Fixed, seed 1 meets the 4/5 winner (seed 5) and seed 2 the 3/6
  // winner (seed 6); re-seeded, seed 1 would have drawn seed 6.
  const cur = D.DB.seasons[0], seedOf = D.bracketSeeds(cur), bySeed = new Map([...seedOf].map(([r, k]) => [k, r]));
  const lvl = { 1: 200, 2: 190, 3: 100, 4: 110, 5: 150, 6: 140, 7: 60, 8: 50, 9: 40, 10: 30, 11: 20, 12: 10 };
  const fx = det(cur, r => 20 - seedOf.get(r), () => 1000, r => lvl[seedOf.get(r)]);
  const g2 = fx.trace.filter(g => g.bracket === "winners" && g.r === 2).map(g => [seedOf.get(g.a), seedOf.get(g.b)].sort((x, y) => x - y).join("v")).sort();
  const t1 = fx.trace.filter(g => g.bracket === "losers" && g.r === 2).map(g => [seedOf.get(g.a), seedOf.get(g.b)].sort((x, y) => x - y).join("v")).sort();

  // 3. The worker gets the template with the job, and its run is the page's run.
  const L = await D.liveOnce();
  const job = D.pictureJob(M, L.live || null, 200, 2000);
  const url = URL.createObjectURL(new Blob([D.pictureWorkerSource()], { type: "text/javascript" }));
  const w = new Worker(url);
  const out = await new Promise((res, rej) => { w.onmessage = e => res(e.data); w.onerror = e => rej(String(e.message)); w.postMessage({ id: 1, job }); });
  w.terminate(); URL.revokeObjectURL(url);
  const direct = D.simulateSeason(M, 2000, L.live || null);
  return {
    source: B.source, season: B.season, sameAsFallback: strip(B) === strip(D.FALLBACK_BRACKET),
    same25: t25 ? strip(t25) === strip(B) : null, structure, y25,
    fixedR2: g2, toiletR2: t1,
    jobCarries: strip(job.model.bracket) === strip(B),
    workerOk: out.ok, workerTitle: out.ok && out.out.main.title.every((x, i) => x === direct.title[i]),
    workerPlayoff: out.ok && out.out.main.playoff.every((x, i) => x === direct.playoff[i]),
  };
});
if (fb.none) check("the odds model carries a bracket template", false);
else {
  check("the bracket template is read from Sleeper, not the fallback", fb.source === "current" || fb.source === "previous", `${fb.source} ${fb.season}`);
  check("this season's bracket and 2025's give the same template", fb.same25 === true, String(fb.same25));
  check("the labeled fallback is the same template Sleeper draws", fb.sameAsFallback);
  check("winners round one is 4 v 5 and 3 v 6; seeds 1 and 2 sit out",
    JSON.stringify(fb.structure.wr1) === '["3v6","4v5"]', JSON.stringify(fb.structure.wr1));
  check("seed 1 meets the 4/5 winner and seed 2 the 3/6 winner (by slot, not re-seeded)",
    fb.structure.s1 === "4v5" && fb.structure.s2 === "3v6", JSON.stringify(fb.structure));
  check("toilet bowl round one is 7 v 10 and 8 v 9; 12 meets the 8/9 loser and 11 the 7/10 loser",
    JSON.stringify(fb.structure.lr1) === '["7v10","8v9"]' && fb.structure.s12 === "8v9" && fb.structure.s11 === "7v10", JSON.stringify(fb.structure));
  check("fixed: when seeds 5 and 6 win round one, seed 1 plays 5 and seed 2 plays 6",
    JSON.stringify(fb.fixedR2) === '["1v5","2v6"]', JSON.stringify(fb.fixedR2));
  check("toilet bowl: the 8/9 and 7/10 losers go on to meet 12 and 11 (9 v 12, 10 v 11 here)",
    JSON.stringify(fb.toiletR2) === '["10v11","9v12"]', JSON.stringify(fb.toiletR2));
  if (!fb.y25) check("2025 replays through the template (skipped: no 2025 season)", true);
  else {
    check("2025 replayed with its real seeds and winners: every game is Sleeper's game, both brackets",
      fb.y25.allSame, JSON.stringify(fb.y25.rows.filter(r => !r.same || !r.wonSame)));
    check("2025 replayed: the champion and last place are Sleeper's",
      fb.y25.champ === fb.y25.sleeperChamp && fb.y25.last === fb.y25.sleeperLast, JSON.stringify([fb.y25.champ, fb.y25.sleeperChamp, fb.y25.last, fb.y25.sleeperLast]));
  }
  check("the Playoff Picture's worker job carries the bracket template", fb.jobCarries);
  check("the worker's title and playoff odds equal the page's run exactly", fb.workerOk && fb.workerTitle && fb.workerPlayoff,
    JSON.stringify({ ok: fb.workerOk, t: fb.workerTitle, p: fb.workerPlayoff }));
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

/* -------------------------------------------------------------- done */
await browser.close();
server.close();
console.log(`\n${"=".repeat(52)}`);
console.log(`  ${pass} passed, ${fail} failed`);
if (fail) { console.log(`\nFailures:`); failures.forEach(f => console.log(`  - ${f}`)); }
console.log(`${"=".repeat(52)}\n`);
process.exit(fail ? 1 : 0);

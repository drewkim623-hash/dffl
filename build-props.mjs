/**
 * build-props.mjs — this week's NFL player props for every DFFL-rostered
 * player, each with an edge and a confidence score. Writes data/props.json.
 *
 * Lines come from The Odds API (key in the ODDS_API_KEY secret, never in the
 * page). The comparison is Sleeper's weekly stat projection for the same
 * player — the same projections the rest of the site already uses.
 *
 * For each prop:
 *   market   the no-vig probability: each book's two sides with the hold
 *            removed, averaged across books at the consensus line.
 *   model    the chance Sleeper's projection clears the line. Yardage is
 *            treated as normal around the projection with a spread that
 *            grows with it (see SPREAD); an anytime TD is 1 - e^-λ, λ the
 *            projected touchdowns.
 *   blend    model 30%, market 70%. A stat projection alone
 *            is not good enough to bet against a whole market at full weight,
 *            so the edge is shrunk toward the market before it is shown.
 *   edge     blend minus market, in percentage points, on the better side.
 *   ev       the blend's expected return at the best price any book posts.
 *   score    0–100 confidence: how big the edge is, how many books agree on
 *            the line, and whether the best price is still +EV. 60+ is
 *            "Strong", 35–59 "Lean", below that "Pass".
 *
 * Budget: the free plan is 500 requests a month and each event costs one
 * request per market. The script stops before the account drops below
 * RESERVE, and it skips games that have already kicked off — those keep the
 * lines from the last run, marked as closed.
 *
 *   ODDS_API_KEY=… node build-props.mjs
 */
import fs from "node:fs";
import { fetchJSON } from "./fetch-json.mjs";

const KEY = process.env.ODDS_API_KEY;
const OUT = "data/props.json";
const LEAGUE = "1318040218183417856";
const RESERVE = Number(process.env.PROPS_RESERVE || 30);
const BASE = "https://api.the-odds-api.com/v4/sports/americanfootball_nfl";

// Odds API market -> how to read Sleeper's projection for it.
const MARKETS = {
  player_pass_yds: { label: "Passing yards", stat: s => s.pass_yd, kind: "yds" },
  player_rush_yds: { label: "Rushing yards", stat: s => s.rush_yd, kind: "yds" },
  player_reception_yds: { label: "Receiving yards", stat: s => s.rec_yd, kind: "yds" },
  player_anytime_td: { label: "Anytime TD", stat: s => (s.rush_td || 0) + (s.rec_td || 0), kind: "td" },
};
// Week-to-week spread of a yardage total, as a share of its projection, with a
// floor so a small projection still has a realistic range.
const SPREAD = {
  player_pass_yds: m => Math.max(45, 0.28 * m),
  player_rush_yds: m => Math.max(14, 0.5 * m),
  player_reception_yds: m => Math.max(15, 0.6 * m),
};
// How much say the projection gets against the market. Sleeper's projections
// are not sharper than six books' consensus, so they get well under half.
const W_MODEL = 0.3;
const TD_HOLD = 1.08; // anytime-TD books rarely post "No"; this is their usual hold


// ---- small maths ----
const dec = a => (a > 0 ? 1 + a / 100 : 1 + 100 / -a);
const imp = a => 1 / dec(a);
function phi(z) { // standard normal CDF (Abramowitz–Stegun 7.1.26)
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2);
  return z >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const r3 = x => Math.round(x * 1000) / 1000;
const norm = n => String(n || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[.'’]/g, "").replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/[^a-z]+/g, " ").trim();

/**
 * Score every prop in place. Sleeper projects a player's average; a book's
 * line sits near the median, and yardage is skewed, so a raw projection runs
 * above the line for nearly everyone. Each market (QB rushing on its own) is
 * calibrated first: the typical ratio of line to projection becomes the
 * baseline, so an edge means Sleeper likes this player more than the market
 * does compared with everyone else in that market, not merely that averages
 * exceed medians.
 */
function score(list) {
  const group = p => p.market + (p.market === "player_rush_yds" && p.pos === "QB" ? ":QB" : "");
  const raw = p => MARKETS[p.market].kind === "td"
    ? -Math.log(1 - Math.min(0.97, p.fair_over)) / p.proj // market λ per projected λ
    : p.line / p.proj;
  const ratios = {};
  for (const p of list) if (p.proj > 0) (ratios[group(p)] ||= []).push(raw(p));
  const byMarket = {};
  for (const p of list) if (p.proj > 0) (byMarket[p.market] ||= []).push(raw(p));
  const calib = p => {
    const g = ratios[group(p)];
    if (g && g.length >= 6) return median(g);
    const m = byMarket[p.market];
    return m && m.length >= 6 ? median(m) : 1;
  };
  for (const p of list) {
    const M = MARKETS[p.market], c = calib(p), L = p.quotes, fairOver = p.fair_over;
    const center = p.proj * c;
    const modelOver = M.kind === "td" ? 1 - Math.exp(-center) : 1 - phi((p.line - center) / SPREAD[p.market](center));
    const blendOver = W_MODEL * modelOver + (1 - W_MODEL) * fairOver;
    // Take whichever side the blend likes; anytime TD only has a "Yes" to bet.
    const overSide = M.kind === "td" || blendOver >= fairOver;
    const quotes = L[overSide ? "over" : "under"];
    const best = quotes.length ? quotes.reduce((a, b) => (dec(b.price) > dec(a.price) ? b : a)) : null;
    const pr = overSide ? blendOver : 1 - blendOver;
    const fair = overSide ? fairOver : 1 - fairOver;
    const edge = pr - fair;
    const evr = best ? pr * dec(best.price) - 1 : -1;
    // Confidence: edge (full marks at 8 points after the shrink), market depth
    // (full at 5 books), and a price that is still worth taking.
    const sc = evr < 0.0005 ? 0 : Math.round(100 * Math.min(1, Math.max(0, edge) / 0.08) * (0.55 + 0.45 * Math.min(1, p.books / 5)));
    Object.assign(p, {
      side: M.kind === "td" ? "yes" : overSide ? "over" : "under", baseline: r3(c),
      p_model: r3(overSide ? modelOver : 1 - modelOver), p_market: r3(fair), p: r3(pr),
      edge: r3(edge), ev: r3(evr), best, score: sc, tier: sc >= 60 ? "Strong" : sc >= 35 ? "Lean" : "Pass",
    });
  }
}

// Rescore the props already on file (no API calls): node build-props.mjs --rescore
if (process.argv.includes("--rescore")) {
  const j = JSON.parse(fs.readFileSync(OUT, "utf8"));
  score(j.props);
  j.props.sort((a, b) => b.score - a.score || b.edge - a.edge);
  fs.writeFileSync(OUT, JSON.stringify(j) + "\n");
  console.log(`rescored ${j.props.length} props`);
  process.exit(0);
}

if (!KEY) { console.error("ODDS_API_KEY is not set; nothing written."); process.exit(0); }

// ---- the odds account ----
let remaining = null;
async function odds(path) {
  const sep = path.includes("?") ? "&" : "?";
  const r = await fetch(`${BASE}${path}${sep}apiKey=${KEY}`);
  const left = r.headers.get("x-requests-remaining");
  if (left != null) remaining = Number(left);
  if (!r.ok) throw new Error(`Odds API ${r.status} on ${path.split("?")[0]}`);
  return r.json();
}

// ---- who is on a DFFL roster ----
const rosters = JSON.parse(fs.readFileSync("rosters.json", "utf8")).map;
const leagueRosters = await fetchJSON(`https://api.sleeper.app/v1/league/${LEAGUE}/rosters`, { label: "rosters" });
const ownerOf = new Map();
for (const r of leagueRosters) for (const pid of r.players || []) ownerOf.set(pid, r.owner_id);
const byName = new Map();
for (const [pid, p] of Object.entries(rosters)) {
  if (!ownerOf.has(pid) || !["QB", "RB", "WR", "TE"].includes(p.p)) continue;
  byName.set(norm(p.n), pid);
}

// ---- Sleeper's stat projections for the week ----
const state = await fetchJSON("https://api.sleeper.app/v1/state/nfl", { label: "state" });
const season = String(state.season), week = Number(state.week);
const projRows = await fetchJSON(`https://api.sleeper.app/projections/nfl/${season}/${week}?season_type=regular&position[]=QB&position[]=RB&position[]=WR&position[]=TE`, { label: "projections" });
const proj = new Map(projRows.map(r => [String(r.player_id), r.stats || {}]));

// ---- carry over games already priced this week ----
let prev = null;
try { prev = JSON.parse(fs.readFileSync(OUT, "utf8")); } catch { /* first run */ }
const keepPrev = prev && prev.season === season && prev.week === week;
const now = Date.now();

// ---- this week's games ----
const events = await odds("/events");
// This NFL week only: up to the coming Tuesday morning, after Monday's game.
const horizon = (() => { const d = new Date(now); d.setUTCHours(10, 0, 0, 0);
  do d.setUTCDate(d.getUTCDate() + 1); while (d.getUTCDay() !== 2); return d.getTime(); })();
const games = events.filter(e => { const t = Date.parse(e.commence_time); return t < horizon && t > now - 4 * 36e5; });

const props = [];
const gameRows = [];
const keys = Object.keys(MARKETS);
let skipped = 0;
for (const e of games) {
  const kick = Date.parse(e.commence_time);
  const g = { id: e.id, away: e.away_team, home: e.home_team, kickoff: e.commence_time };
  if (kick <= now) { // already under way: keep what the last run saw
    const old = keepPrev ? prev.props.filter(p => p.game === e.id) : [];
    old.forEach(p => { p.closed = true; });
    props.push(...old);
    gameRows.push({ ...g, closed: true, priced: old.length > 0 });
    continue;
  }
  if (remaining != null && remaining - keys.length < RESERVE) {
    skipped++;
    const old = keepPrev ? prev.props.filter(p => p.game === e.id) : [];
    props.push(...old);
    gameRows.push({ ...g, priced: old.length > 0, stale: true });
    continue;
  }
  let ev;
  try { ev = await odds(`/events/${e.id}/odds?regions=us&markets=${keys.join(",")}&oddsFormat=american`); }
  catch (err) { console.warn(err.message); gameRows.push({ ...g, priced: false }); continue; }
  gameRows.push({ ...g, priced: true });

  // market -> player -> point -> { over:[{book,price}], under:[…] }
  const book = {};
  for (const b of ev.bookmakers || []) for (const m of b.markets || []) {
    for (const o of m.outcomes || []) {
      const who = o.description; if (!who) continue;
      const side = /^(over|yes)$/i.test(o.name) ? "over" : /^(under|no)$/i.test(o.name) ? "under" : null;
      if (!side) continue;
      const pt = m.key === "player_anytime_td" ? 0.5 : o.point;
      if (pt == null) continue;
      const slot = ((book[m.key] ||= {})[who] ||= {});
      (slot[pt] ||= { over: [], under: [] })[side].push({ book: b.title, price: o.price });
    }
  }

  for (const [mk, players] of Object.entries(book)) {
    const M = MARKETS[mk];
    for (const [who, lines] of Object.entries(players)) {
      const pid = byName.get(norm(who));
      if (!pid) continue;
      const s = proj.get(pid);
      const mean = s ? M.stat(s) : null;
      if (mean == null || !(mean > (M.kind === "td" ? 0.02 : 1))) continue; // not projected to play

      // The consensus line: the point the most books post.
      const pts = Object.entries(lines).sort((a, b) => (b[1].over.length + b[1].under.length) - (a[1].over.length + a[1].under.length));
      const [ptStr, L] = pts[0];
      const line = Number(ptStr);
      if (!L.over.length) continue;

      // No-vig market probability of the over.
      let fairs = [];
      if (M.kind === "yds") {
        const books = new Set(L.over.map(x => x.book));
        for (const b of books) {
          const o = L.over.find(x => x.book === b), u = L.under.find(x => x.book === b);
          if (o && u) fairs.push(imp(o.price) / (imp(o.price) + imp(u.price)));
        }
      } else {
        for (const o of L.over) {
          const u = L.under.find(x => x.book === o.book);
          fairs.push(u ? imp(o.price) / (imp(o.price) + imp(u.price)) : imp(o.price) / TD_HOLD);
        }
      }
      if (!fairs.length) continue;
      const fairOver = fairs.reduce((a, b) => a + b, 0) / fairs.length;
      props.push({
        pid, name: rosters[pid].n, pos: rosters[pid].p, team: rosters[pid].t, owner: ownerOf.get(pid),
        game: e.id, kickoff: e.commence_time, market: mk, label: M.label,
        line, proj: Math.round(mean * 100) / 100, fair_over: r3(fairOver),
        quotes: L, books: new Set([...L.over, ...L.under].map(x => x.book)).size,
      });
    }
  }
}

score(props);
props.sort((a, b) => b.score - a.score || b.edge - a.edge);
const out = {
  _comment: "Written by build-props.mjs. This week's NFL player props (The Odds API) for DFFL-rostered players, each set against Sleeper's stat projection: p_market is the no-vig market chance of the listed side, p_model the projection's, p the two blended 30/70, edge = p - p_market, ev the blend's return at the best price, score a 0-100 confidence. Read by the Props board on the Odds tab.",
  generated: new Date().toISOString(), season, week, requests_remaining: remaining, skipped_for_budget: skipped,
  games: gameRows, props,
};
fs.writeFileSync(OUT, JSON.stringify(out) + "\n");
console.log(`props: ${props.length} lines over ${gameRows.filter(g => g.priced).length}/${gameRows.length} games; ${remaining} requests left${skipped ? `; ${skipped} games skipped to save budget` : ""}`);

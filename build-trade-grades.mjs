/**
 * build-trade-grades.mjs — the NFL-style trade grade (scale v2) for every DFFL trade.
 *
 * Writes data/trade-grades.json; with --write-keepers it also refreshes the computed `players` block in keepers.json
 * (the stated `seasons` lists are never touched). Read-only against Sleeper; dependency-free.
 *
 * Value of a side = what it received, in VOR (points above a replacement starter):
 *   players  rest-of-season VOR from the trade week to week 17. Past seasons use ACTUAL points
 *            (Sleeper keeps no old projections, so those grades are hindsight-tinged and say so);
 *            the current season uses actual points so far + Sleeper projections for the rest.
 *   keeper   shrunk surplus: 0.8 x max(0, SHRINK x last full season VOR - value of next keeper cost round)
 *   picks    e^(3.83 - 0.0135*pick) - 1 at the round's mid-slot (trade-day; slot unknown).
 * margin = side - average of the other sides; % = that / (side + average other side) (two teams: (side-other)/total).
 * Under 25 VOR traded in total, both sides grade "C · small trade" (point margin kept). Letters on |margin| (v2 percentile cutoffs, fixed so
 * grades don't drift as trades are added): C < 21.6% <= B/D < 55.3% <= A/F < 86.9% <= A+/F-.
 * Hindsight: once every traded pick has become a player with a completed season, the pick is valued
 * at his actual season VOR + actual keeper surplus; otherwise "Pending".
 */
import fs from "node:fs";
import { fetchJSON } from "./fetch-json.mjs";

const API = "https://api.sleeper.app/v1", STATS = "https://api.sleeper.com";
const LEAGUE = "1318040218183417856";
const LAST_WEEK = 17;
const STARTERS = { QB: 12, RB: 30, WR: 30, TE: 14 };
export const CUTOFFS = { c: 0.216, bd: 0.553, af: 0.869 };
export const SMALL_TRADE = 25;                               // total VOR traded below this grades C · small trade
export const SHRINK = 0.58, KEEPER_DISCOUNT = 0.8;           // fitted 2022->25 year-to-year VOR slope; one-year-out discount
const K = JSON.parse(fs.readFileSync("keepers.json", "utf8"));
const CFG = { TRADE_RESETS_YEARS: false, REGRESSION_FROM: 2027, ...(K.config || {}) };
const EXC = new Set(((K.exceptions) || []).map(e => String(e.player_id)));

export const curve = pick => Math.exp(3.83 - 0.0135 * pick) - 1;
export const midPick = round => (round - 1) * 12 + 6.5;
export const regress = r => r >= 10 ? r - 3 : r >= 5 ? r - 2 : Math.max(1, r - 1);
export const letter = m => { const a = Math.abs(m), up = m >= 0;
  return a < CUTOFFS.c ? "C" : a < CUTOFFS.bd ? (up ? "B" : "D") : a < CUTOFFS.af ? (up ? "A" : "F") : (up ? "A+" : "F-"); };
export function score(S, s, pos) { const st = { ...s };
  if (st.rec != null) { if (pos === "TE" && st.bonus_rec_te == null) st.bonus_rec_te = st.rec; if (pos === "WR" && st.bonus_rec_wr == null) st.bonus_rec_wr = st.rec; if (pos === "RB" && st.bonus_rec_rb == null) st.bonus_rec_rb = st.rec; }
  let t = 0; for (const [k, w] of Object.entries(S)) if (typeof st[k] === "number") t += st[k] * w; return t; }
/** Next-draft keeper cost: base round, regressed once he has been kept 2+ years (from REGRESSION_FROM). */
export function nextCost(history, pid, draftYear, cfg = CFG) {
  const d = history.get(draftYear)?.get(pid); if (!d) return null;
  let apps = 0; for (let y = draftYear; history.has(y); y--) { const e = history.get(y).get(pid); if (!e || (cfg.TRADE_RESETS_YEARS && e.by !== d.by)) break; apps++; }
  const yearsKept = apps - 1, regressed = draftYear + 1 >= cfg.REGRESSION_FROM && yearsKept >= 2;
  return { baseRound: d.round, nextCostRound: regressed ? regress(d.round) : d.round, regressed, yearsKept, origin: { year: draftYear - yearsKept, round: history.get(draftYear - yearsKept).get(pid).round } };
}
/** Points margin: this side minus the average of the other sides (sums to zero for any n). */
export const marginPts = (x, total, n) => x - (total - x) / (Math.max(2, n) - 1);
/** Margin share: divided by this side + the average other side, so it is total for two teams and within ±100% for any n. */
export const marginPct = (x, total, n) => { const o = (total - x) / (Math.max(2, n) - 1); return x + o > 0 ? (x - o) / (x + o) : 0; };
/** One grade: letter, or C · small trade when too little value moved. */
export const grade = (x, total, n) => { const p = marginPct(x, total, n), small = total < SMALL_TRADE;
  return { letter: small ? "C" : letter(p), ...(small ? { small: true } : {}), marginPct: Math.round(p * 100), marginPts: Math.round(marginPts(x, total, n) * 10) / 10 }; };
export const keeperValue = (lastVor, costRound) => KEEPER_DISCOUNT * Math.max(0, SHRINK * lastVor - curve(midPick(costRound)));

const r1 = x => Math.round(x * 10) / 10;
async function main() {
  const state = await fetchJSON(`${API}/state/nfl`, { label: "state" });
  const curSeason = Number(state.season), curWeek = Math.max(1, Number(state.week) || 1);
  // league chain
  const leagues = []; for (let id = LEAGUE; id && id !== "0";) { const l = await fetchJSON(`${API}/league/${id}`, { label: `league ${id}` }); leagues.push(l); id = l.previous_league_id; }
  const seasons = new Map(); const players = await fetchJSON(`${API}/players/nfl`, { label: "players" });
  const pos = pid => players[pid]?.position, nm = pid => players[pid]?.full_name || pid;
  const history = new Map();                                  // year -> pid -> {round, by}
  for (const l of leagues) { const y = Number(l.season);
    const [users, rosters, drafts] = await Promise.all([`users`, `rosters`, `drafts`].map(p => fetchJSON(`${API}/league/${l.league_id}/${p}`, { label: `${y} ${p}` })));
    // the league's draft list omits slot_to_roster_id; the draft itself has it (needed to resolve a traded pick)
    if (drafts[0]) drafts[0] = await fetchJSON(`${API}/draft/${drafts[0].draft_id}`, { label: `${y} draft` });
    const picks = drafts[0] ? await fetchJSON(`${API}/draft/${drafts[0].draft_id}/picks`, { label: `${y} picks` }) : [];
    const h = new Map(); for (const p of picks) if (p.player_id) h.set(String(p.player_id), { round: p.round, by: p.picked_by, no: p.pick_no, rid: p.roster_id }); history.set(y, h);
    const txs = []; for (let w = 1; w <= 18; w++) txs.push(...(await fetchJSON(`${API}/league/${l.league_id}/transactions/${w}`, { label: `${y} tx ${w}` })).filter(t => t.type === "trade" && t.status === "complete").map(t => ({ ...t, _week: w })));
    const mgr = rid => { const r = rosters.find(x => x.roster_id === rid); return users.find(u => u.user_id === r?.owner_id)?.display_name || `roster ${rid}`; };
    seasons.set(y, { l, S: l.scoring_settings, users, rosters, drafts, picks, txs, mgr, uid: rid => rosters.find(x => x.roster_id === rid)?.owner_id || null });
  }
  // stats
  const wk = new Map(), season = new Map(), repl = new Map();
  const W = async (y, w) => { const k = `${y}-${w}`; if (!wk.has(k)) wk.set(k, await fetchJSON(`${STATS}/stats/nfl/${y}/${w}?season_type=regular`, { label: `stats ${k}` })); return wk.get(k); };
  const seasonRows = async (y, p) => { const k = `${y}-${p}`; if (!season.has(k)) season.set(k, await fetchJSON(`${STATS}/stats/nfl/${y}?season_type=regular&position[]=${p}`, { label: `season ${k}` })); return season.get(k); };
  const yS = y => seasons.get(Math.min(y, curSeason))?.S;
  const seasonVor = async (y, pid) => { const p = pos(pid); if (!STARTERS[p] || y >= curSeason || !seasons.has(y)) return 0; const S = yS(y), rows = await seasonRows(y, p);
    if (!repl.has(`${y}${p}`)) repl.set(`${y}${p}`, rows.map(r => score(S, r.stats || {}, p)).sort((a, b) => b - a)[STARTERS[p]]);
    const e = rows.find(r => r.player_id === pid); return e ? Math.max(0, score(S, e.stats || {}, p) - repl.get(`${y}${p}`)) : 0; };
  const proj = new Map(); const P = async (w, p) => { const k = `${w}-${p}`; if (!proj.has(k)) proj.set(k, await fetchJSON(`${STATS}/projections/nfl/${curSeason}/${w}?season_type=regular&position[]=${p}`, { label: `proj ${k}` })); return proj.get(k); };
  const replWeek = async (y, p) => { const ly = y >= curSeason ? curSeason - 1 : y; await seasonVor(ly, Object.keys(players).find(id => players[id].position === p && STARTERS[p]) || ""); return (repl.get(`${ly}${p}`) || 0) / 17; };
  async function ros(y, w0, pid) { const p = pos(pid); if (!STARTERS[p]) return { v: 0, basis: "kicker/defense: not valued" };
    const S = yS(y), rw = await replWeek(y, p); let v = 0; const lastActual = y >= curSeason ? curWeek - 1 : LAST_WEEK;
    for (let w = Math.max(1, w0); w <= lastActual; w++) { const e = (await W(y, w)).find(x => x.player_id === pid); v += Math.max(0, (e ? score(S, e.stats || {}, p) : 0) - rw); }
    if (y >= curSeason) for (let w = Math.max(curWeek, w0); w <= LAST_WEEK; w++) { const e = (await P(w, p)).find(x => x.player_id === pid); v += Math.max(0, (e ? score(S, e.stats || {}, p) : 0) - rw); }
    return { v, basis: y >= curSeason ? `actual to wk ${curWeek - 1} + Sleeper projection` : "actual remaining points (hindsight; no stored projections)" }; }
  async function keeperFor(y, pid) {
    const c = nextCost(history, pid, y); if (!c) return null; const lastY = Math.min(y, curSeason - 1), vor = await seasonVor(lastY, pid);
    return { ...c, value: keeperValue(vor, c.nextCostRound), lastVor: vor }; }
  const out = { generated: new Date().toISOString(), scale: "v2", cutoffs: CUTOFFS, shrink: SHRINK, keeperDiscount: KEEPER_DISCOUNT, config: CFG, trades: {} };
  const keeperRows = {};
  for (const [y, s] of seasons) for (const t of s.txs) {
    const rids = [...new Set([...(t.roster_ids || []), ...(t.draft_picks || []).flatMap(d => [d.owner_id, d.previous_owner_id])])].filter(r => r != null);
    const sides = []; let pendingAny = false;
    for (const rid of rids) { const assets = []; let day = 0, hind = 0, pend = false;
      for (const [pid, to] of Object.entries(t.adds || {})) if (to === rid) { const r = await ros(y, t._week, pid); assets.push({ asset: nm(pid), pid, value: r1(r.v), basis: r.basis }); day += r.v; hind += r.v;
        const k = await keeperFor(y, pid); if (k && k.value > 0) { assets.push({ asset: `${nm(pid)} keeper`, value: r1(k.value), basis: `next cost R${k.nextCostRound}${k.regressed ? ` (regressed from R${k.baseRound})` : ""}, kept ${k.yearsKept} yr, shrunk` }); day += k.value; hind += k.value; } }
      for (const d of (t.draft_picks || []).filter(d => d.owner_id === rid)) { const v = curve(midPick(d.round)); day += v;
        const dy = Number(d.season), ds = seasons.get(dy), done = dy < curSeason && ds && ds.drafts[0];
        let dp = null; if (done) { const uid = s.uid(d.roster_id), rid = ds.rosters.find(r => r.owner_id === uid)?.roster_id ?? d.roster_id;
          const slot = Number(Object.entries(ds.drafts[0].slot_to_roster_id || {}).find(([, v]) => v === rid)?.[0]); const teams = Object.keys(ds.drafts[0].slot_to_roster_id || {}).length || 12;
          const no = slot ? (d.round - 1) * teams + (d.round % 2 ? slot : teams + 1 - slot) : null; const e = ds.picks.find(p => p.pick_no === no); if (e && e.player_id) dp = [String(e.player_id), !!e.is_keeper, e.pick_no]; }
        let h = null;
        // A slot spent on a keeper bought nothing new: value it like any unused pick at that slot (curve at its pick number).
        if (dp && dp[1]) { h = curve(dp[2]); hind += h; } else
        if (dp && dy < curSeason) { const [pid] = dp; const kv = history.has(dy + 1) && history.get(dy + 1).has(pid) ? Math.max(0, (await seasonVor(dy + 1, pid)) - curve(midPick(history.get(dy + 1).get(pid).round))) : 0; h = (await seasonVor(dy, pid)) + kv; hind += h; } else { pend = true; }
        assets.push({ asset: `${d.season} R${d.round}`, value: r1(v), basis: "mid-slot curve", ...(h != null ? { hindsight: r1(h), ...(dp[1] ? { kept: true, became: `Kept: ${nm(dp[0])}`, hindsightBasis: `kept slot: curve value at pick ${dp[2]}, same as an unused pick there` } : { became: nm(dp[0]) }) } : { hindsight: "Pending" }) }); }
      pendingAny ||= pend || y >= curSeason;
      sides.push({ rid, uid: s.uid(rid), manager: s.mgr(rid), assets, day, hind }); }
    const tot = sides.reduce((a, x) => a + x.day, 0), htot = sides.reduce((a, x) => a + x.hind, 0);
    const n = sides.length;
    out.trades[t.transaction_id] = { season: y, week: t._week, sides: sides.map(x => ({ rid: x.rid, uid: x.uid, manager: x.manager, assets: x.assets, total: r1(x.day),
      tradeDay: grade(x.day, tot, n), hindsight: pendingAny ? "Pending" : grade(x.hind, htot, n) })) };
  }
  // keepers.json computed block (current rosters' players drafted this season)
  // Only players on the stated keeper list: appearing in back-to-back drafts can also mean he was simply drafted again.
  const nk = x => String(x || "").toLowerCase().replace(/[^a-z]/g, "");
  const stated = new Set(Object.values(K.seasons?.[String(curSeason)] || {}).flat().map(nk));
  for (const [pid] of history.get(curSeason) || []) { if (!stated.has(nk(nm(pid)))) continue; const c = nextCost(history, pid, curSeason); if (c)
    keeperRows[pid] = { name: nm(pid), origin: c.origin, yearsKept: c.yearsKept, baseRound: c.baseRound, nextCostRound: c.nextCostRound, regressed: c.regressed,
      ruleSource: "Commissioner, league chat: kept 2+ years -> R10-15 up 3, R5-9 up 2, R1-4 up 1; from the 2027 draft", rights: K.players?.[pid]?.rights || [], ...(EXC.has(pid) ? { exception: true } : {}) }; }
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync("data/trade-grades.json", JSON.stringify(out, null, 1) + "\n");
  if (process.argv.includes("--write-keepers")) fs.writeFileSync("keepers.json", JSON.stringify({ ...K, config: CFG, players: keeperRows }, null, 2) + "\n");
  console.log(`trade grades: ${Object.keys(out.trades).length} trades; keepers computed: ${Object.keys(keeperRows).length}`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error("::warning::trade grades not built:", e.message); process.exit(0); });

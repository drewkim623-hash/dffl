/**
 * Write data/roster-weeks.json — how strong each DFFL roster is now, against
 * how strong the rosters it actually fielded were.
 *
 * The live odds learn a team's scoring level from the weeks it has already
 * played. That is right until a trade: the points were scored by players who
 * may have left, and the level carries on as if they had not. This file is the
 * correction's raw material. For every scored regular-season week it records
 * the roster that played (from Sleeper's matchups) and that roster's strength;
 * for today it records the current roster and its strength. The site adds the
 * difference — today's strength minus the average fielded strength — to each
 * team's level, and nothing else about the odds changes.
 *
 * Strength is one number per roster: its best HEALTHY lineup, week by week over
 * data/projections.json's weeks (current_week through playoff_week_start - 1),
 * averaged. Every roster, past or present, is priced off the same projections,
 * so the only thing that can move it is who is on the roster. The lineup is
 * filled the way projectedPointsLost()'s bestLineup does in index.html: slots
 * from the league's roster_positions minus BN/IR/TAXI, most restrictive slot
 * first and FLEX last, best projected first, ties by id. Healthy means a
 * player's value never drops to 0 for a bye or an injury: a week published at 0
 * or missing falls back to his latest published week above 0, then
 * last_nonzero, then season PPG (index.html's byeValue). Injuries are the
 * injury model's business, not this file's.
 *
 *   node build-roster-weeks.mjs
 *
 * Run it after build-rosters.mjs and build-injuries.mjs (which writes
 * data/projections.json), and before build-email.mjs reads the site.
 */
import { writeFile, readFile } from "fs/promises";
import { pathToFileURL } from "url";
import { fetchJSON } from "./fetch-json.mjs";

const API = "https://api.sleeper.app/v1";
const LEAGUE = "1318040218183417856";

// The slots each lineup position accepts (index.html's PTS_LOST.slots).
const SLOT_ALLOWS = {
  FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"],
};

/**
 * A pool's strength: its best healthy lineup, averaged over the projections'
 * weeks. Exported for verify.mjs, which prices a what-if roster with it.
 *
 *   pool   player ids
 *   P      data/projections.json
 *   posOf  pid -> position
 *   slots  roster_positions minus BN/IR/TAXI
 *
 * Returns { strength, optimal } — optimal is the best lineup on each player's
 * average healthy value over those weeks.
 */
export function lineupStrength(pool, P, posOf, slots) {
  const lastWeek = (Number(P.playoff_week_start) || 15) - 1;
  const pubWeeks = Object.keys(P.weeks || {}).map(Number).sort((a, b) => a - b);
  const weeks = pubWeeks.filter(w => w >= Number(P.current_week) && w <= lastWeek);
  const ids = [...new Set((pool || []).filter(p => p && p !== "0").map(String))];
  // byeValue: the latest published week above 0 before w (else the first after
  // it), then last_nonzero, then season PPG.
  const byeValue = (pid, w) => {
    const back = pubWeeks.filter(x => x !== w && P.weeks[x] && Number(P.weeks[x][pid]) > 0);
    const near = back.filter(x => x < w).pop() ?? back[0];
    if (near != null) return Number(P.weeks[near][pid]);
    const ln = P.last_nonzero && P.last_nonzero[pid];
    if (ln && Number(ln.pts) > 0) return Number(ln.pts);
    return Number(P.ppg && P.ppg[pid]) > 0 ? Number(P.ppg[pid]) : 0;
  };
  const healthy = (pid, w) => {
    const v = Number(P.weeks[w] && P.weeks[w][pid]) || 0;
    return v > 0 ? v : byeValue(pid, w);
  };
  const allowed = s => SLOT_ALLOWS[s] || [s];
  const order = [...slots].sort((a, b) => allowed(a).length - allowed(b).length);
  const bestLineup = v => {
    const used = new Set();
    let total = 0;
    for (const s of order) {
      const p = ids.filter(q => !used.has(q) && v(q) > 0 && allowed(s).includes(posOf(q)))
        .sort((a, b) => (v(b) - v(a)) || a.localeCompare(b))[0];
      if (p) { used.add(p); total += v(p); }
    }
    return { total, used };
  };
  if (!weeks.length) return { strength: 0, optimal: [] };
  const strength = weeks.reduce((s, w) => s + bestLineup(p => healthy(p, w)).total, 0) / weeks.length;
  const avg = new Map(ids.map(p => [p, weeks.reduce((s, w) => s + healthy(p, w), 0) / weeks.length]));
  const optimal = [...bestLineup(p => avg.get(p)).used];
  return { strength: Math.round(strength * 1000) / 1000, optimal };
}

async function main() {
  const get = (path) => fetchJSON(`${API}/${path}`, { label: path });
  const P = JSON.parse(await readFile("data/projections.json", "utf8"));
  const rosterMap = JSON.parse(await readFile("rosters.json", "utf8")).map || {};
  let latest = null;
  try { latest = JSON.parse(await readFile("data/latest.json", "utf8")); } catch (e) { /* preseason */ }

  const [league, rosters] = await Promise.all([get(`league/${LEAGUE}`), get(`league/${LEAGUE}/rosters`)]);
  const slots = (league.roster_positions || []).filter(p => p !== "BN" && p !== "IR" && p !== "TAXI");
  const pws = Number(league.settings && league.settings.playoff_week_start) || 15;

  // Scored weeks: 1 through the last week build-week.mjs called final, this season.
  const last = latest && String(latest.season) === String(league.season)
    ? Math.min(Number(latest.week) || 0, pws - 1) : 0;
  const matchups = {};
  for (let wk = 1; wk <= last; wk++) matchups[wk] = await get(`league/${LEAGUE}/matchups/${wk}`);

  const clean = a => (a || []).filter(p => p && p !== "0").map(String);
  // Today's roster: everyone on it, reserve included, taxi squad not.
  const current = new Map(rosters.map(r => {
    const taxi = new Set(clean(r.taxi));
    return [r.roster_id, [...new Set([...clean(r.players), ...clean(r.reserve)])].filter(p => !taxi.has(p)).sort()];
  }));

  // Positions from the roster map; a fielded player who has since left every
  // DFFL roster is looked up in Sleeper's player file, once, and only if needed.
  const everyone = new Set([...current.values()].flat());
  for (const wk in matchups) for (const m of matchups[wk]) clean(m.players).forEach(p => everyone.add(p));
  const pos = new Map(Object.entries(rosterMap).map(([pid, x]) => [pid, x.p || ""]));
  const unknown = [...everyone].filter(p => !pos.has(p));
  if (unknown.length) {
    const players = await get("players/nfl");
    for (const p of unknown) if (players[p]) pos.set(p, players[p].position || "");
  }
  const posOf = p => pos.get(p) || "";

  // data/projections.json covers today's rosters only. A fielded player since
  // dropped would count 0 and make every past roster look weaker than it was,
  // so his projections are read from the same Sleeper files build-injuries.mjs
  // reads, scored the same way, and added to this run's copy (never written
  // back to data/projections.json).
  const has = p => Object.values(P.weeks || {}).some(w => Object.hasOwn(w, p));
  const absent = new Set([...everyone].filter(p => !has(p)));
  if (absent.size) {
    const scoring = league.scoring_settings || {};
    const score = stats => Object.entries(stats || {})
      .reduce((s, [k, v]) => s + (Object.hasOwn(scoring, k) ? Number(v) * Number(scoring[k]) || 0 : 0), 0);
    for (const w of Object.keys(P.weeks || {})) {
      const rows = await fetchJSON(`https://api.sleeper.app/projections/nfl/${P.season}/${w}?season_type=regular`,
        { label: `projections/${w}` }).catch(e => { console.warn(e.message); return null; });
      for (const r of Array.isArray(rows) ? rows : []) {
        const pid = String(r.player_id);
        if (absent.has(pid)) P.weeks[w][pid] = Math.round(score(r.stats) * 100) / 100;
      }
    }
  }
  const unpriced = [...everyone].filter(p => !Object.values(P.weeks || {}).some(w => Number(w[p]) > 0)
    && !(P.last_nonzero && Number((P.last_nonzero[p] || {}).pts) > 0) && !(Number((P.ppg || {})[p]) > 0));

  const weeks = {};
  for (const wk in matchups) {
    weeks[wk] = {};
    for (const m of matchups[wk]) {
      const players = clean(m.players).sort();
      if (!players.length) continue;
      const { strength, optimal } = lineupStrength(players, P, posOf, slots);
      weeks[wk][m.roster_id] = { fielded: clean(m.starters), players, optimal, strength };
    }
  }
  const cur = {};
  for (const [rid, players] of current) cur[rid] = { players, ...lineupStrength(players, P, posOf, slots) };

  const out = {
    _comment:
      "Written by build-roster-weeks.mjs. weeks[wk][roster_id] is the roster Sleeper's matchup shows "
      + "that week (fielded = its starters, players = everyone on it); current[roster_id] is today's "
      + "roster. strength = best healthy lineup, averaged over data/projections.json's weeks, so a "
      + "roster's strength moves only when its players do. The odds add current.strength minus the "
      + "average fielded strength to each team's level.",
    updated: new Date().toISOString(),
    season: String(league.season),
    projections_week: Number(P.current_week) || null,
    weeks,
    current: cur,
  };
  await writeFile("data/roster-weeks.json", JSON.stringify(out, null, 0) + "\n");
  console.log(`data/roster-weeks.json — weeks 1–${last}, ${Object.keys(cur).length} rosters`
    + `${unknown.length ? `, ${unknown.length} position(s) from the player file` : ""}`
    + `${absent.size ? `, ${absent.size} fielded player(s) priced from Sleeper's projection files` : ""}`
    + `${unpriced.length ? `, ${unpriced.length} player(s) projected 0 throughout (count 0)` : ""}`);
  for (const [rid, c] of Object.entries(cur)) {
    const past = Object.keys(weeks).map(wk => weeks[wk][rid]).filter(Boolean);
    const avg = past.length ? past.reduce((s, x) => s + x.strength, 0) / past.length : c.strength;
    console.log(`  roster ${rid}: now ${c.strength.toFixed(2)}, fielded avg ${avg.toFixed(2)}, Δ ${(c.strength - avg).toFixed(2)}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

/**
 * Fallback projections for HURT players, for projectedPointsLost() (see
 * PTS_LOST.hurtFallback in index.html). Read-only: Sleeper projections plus the
 * repo's own files. Sleeper projects many Out/IR players at 0 (or not at all),
 * which would make an injury cost nothing. For each injured rostered player and
 * each week from `cur` through playoff_week_start - 1 where his own projection
 * is 0 or missing and his NFL team is NOT on bye that week:
 *   1. his most recent earlier weekly projection above zero ("wk N"), else
 *   2. his season points per game from the week files ("ppg": points in the
 *      weeks he started for his DFFL/C Cubed team / those weeks).
 * A bye week stays 0 (no entry). Result: { [pid]: { [week]: [points, source] } }.
 */
import { readFile, readdir } from "fs/promises";

const scoreStats = (stats, scoring) => {
  let t = 0;
  for (const [k, v] of Object.entries(stats || {})) {
    const m = scoring[k];
    if (typeof m === "number" && typeof v === "number") t += v * m;
  }
  return Math.round(t * 100) / 100;
};

export async function hurtFallback({ season, cur, pws, scoring, fetchJSON }) {
  const inj = JSON.parse(await readFile("injuries.json", "utf8")).map || {};
  const ros = JSON.parse(await readFile("rosters.json", "utf8")).map || {};
  const hurt = Object.keys(ros).filter(pid => inj[pid] && inj[pid].s);
  if (!hurt.length) return {};

  // Every week 1 .. pws-1: hurt players' scored projections, their clubs, and
  // the clubs with anybody projected above zero (a club absent there is on bye).
  const pts = {}, playing = {}, club = {};
  for (let w = 1; w < pws; w++) {
    const rows = await fetchJSON(`https://api.sleeper.app/projections/nfl/${season}/${w}?season_type=regular`,
      { label: `projections/${season}/${w} (hurt fallback)` }).catch(() => null);
    if (!Array.isArray(rows) || !rows.length) continue;
    const want = new Set(hurt), wk = {}, on = new Set();
    for (const r of rows) {
      if (!r) continue;
      const s = scoreStats(r.stats, scoring);
      if (s > 0 && r.team) on.add(r.team);
      const pid = String(r.player_id || "");
      if (want.has(pid)) { wk[pid] = s; if (r.team) (club[pid] ||= {})[w] = r.team; }
    }
    if (!on.size) continue;
    pts[w] = wk; playing[w] = on;
  }

  // Season points per game from the repo's week files, matched by name + position.
  const ppg = {};
  const files = (await readdir("data").catch(() => [])).filter(f => /^week-\d{4}-\d{2}\.json$/.test(f) && f.includes(`-${season}-`));
  const acc = new Map();
  for (const f of files) {
    const wf = JSON.parse(await readFile(`data/${f}`, "utf8"));
    for (const g of wf.games || []) for (const side of g.sides || []) for (const st of side.starters || []) {
      if (st == null || st.name == null) continue;
      const k = `${st.name}|${st.pos}`, a = acc.get(k) || { pts: 0, n: 0 };
      a.pts += Number(st.points) || 0; a.n += 1; acc.set(k, a);
    }
  }
  for (const pid of hurt) {
    const a = acc.get(`${inj[pid].n}|${inj[pid].p}`);
    if (a && a.n) ppg[pid] = Math.round((a.pts / a.n) * 100) / 100;
  }

  const out = {};
  for (const pid of hurt) {
    for (let w = cur; w < pws; w++) {
      if (!pts[w]) continue;                                   // unpublished week: the page's own fallback applies
      if ((pts[w][pid] || 0) > 0) continue;                    // a real projection
      const team = (club[pid] && club[pid][w]) || inj[pid].t || ros[pid].t;
      if (team && !playing[w].has(team)) continue;             // bye: stays 0
      let v = null, src = null;
      for (let x = w - 1; x >= 1; x--) if (pts[x] && (pts[x][pid] || 0) > 0) { v = pts[x][pid]; src = `wk ${x}`; break; }
      if (v == null && ppg[pid] > 0) { v = ppg[pid]; src = "ppg"; }
      if (v != null) (out[pid] ||= {})[w] = [v, src];
    }
  }
  return out;
}

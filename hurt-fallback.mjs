/**
 * Fallback inputs for HURT players, for projectedPointsLost() (see
 * PTS_LOST.hurtFallback in index.html). Read-only: Sleeper projections plus the
 * repo's own files. Sleeper projects many Out/IR players at 0 (or not at all),
 * which would make an injury cost nothing, and projections.json only starts at
 * the current week. So, for each injured rostered player:
 *   last_nonzero[pid] = { week, pts }: his most recent weekly projection above
 *     zero before the current week (`cur`);
 *   ppg[pid] = his season points per game from the week files (points in the
 *     weeks he started for his DFFL/C Cubed team / those weeks);
 * and byes[week] = the NFL teams on bye that week (seen in Sleeper's file but
 * with nobody projected above zero). The page uses them only for a hurt player
 * at 0 in a non-bye week; a bye stays 0. Result: { last_nonzero, ppg, byes }.
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

  // Every week 1 .. pws-1: hurt players' scored projections, and the clubs
  // with anybody projected above zero (a club seen but absent there is on bye).
  const pts = {}, playing = {}, seen = new Set();
  for (let w = 1; w < pws; w++) {
    const rows = await fetchJSON(`https://api.sleeper.app/projections/nfl/${season}/${w}?season_type=regular`,
      { label: `projections/${season}/${w} (hurt fallback)` }).catch(() => null);
    if (!Array.isArray(rows) || !rows.length) continue;
    const want = new Set(hurt), wk = {}, on = new Set();
    for (const r of rows) {
      if (!r) continue;
      const s = scoreStats(r.stats, scoring);
      if (r.team) seen.add(r.team);
      if (s > 0 && r.team) on.add(r.team);
      const pid = String(r.player_id || "");
      if (want.has(pid)) wk[pid] = s;
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

  // His latest weekly projection above zero before the current week.
  const last_nonzero = {};
  for (const pid of hurt) {
    for (let x = cur - 1; x >= 1; x--) {
      if (pts[x] && (pts[x][pid] || 0) > 0) { last_nonzero[pid] = { week: x, pts: pts[x][pid] }; break; }
    }
  }
  const byes = {};
  for (const w of Object.keys(playing)) byes[w] = [...seen].filter(t => !playing[w].has(t)).sort();
  return { last_nonzero, ppg, byes };
}

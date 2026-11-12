#!/usr/bin/env node
/**
 * One-off: writes chat-worker/data/matchup-history.json, the scores of every
 * completed DFFL season, so the chat Worker never walks five seasons of
 * /matchups/{week} live (that alone would blow the 50-subrequest limit).
 *
 *   node chat-worker/scripts/build-matchup-history.mjs
 *
 * Not a weekly builder. Run it by hand after a season ends (once the
 * championship week is final), then redeploy the Worker. It follows
 * previous_league_id back from the current league and keeps every season
 * whose status is "complete". Teams are keyed by owner_id; roster ids change
 * between seasons and display names change whenever someone renames.
 *
 * Shape (kept tiny so JSON.parse stays cheap inside the Worker):
 *   seasons[season] = { league_id, playoff_week_start, names: {owner_id: display_name},
 *                       games: [[week, owner_a, pts_a, owner_b, pts_b], ...] }
 * No player lists.
 */
import { writeFile } from "node:fs/promises";

const API = "https://api.sleeper.app/v1";
const CURRENT_LEAGUE_ID = "1318040218183417856";
const OUT = new URL("../data/matchup-history.json", import.meta.url);

async function get(path) {
  const r = await fetch(API + path);
  if (!r.ok) throw new Error(`${path} → HTTP ${r.status}`);
  return r.json();
}

const seasons = {};
let id = (await get(`/league/${CURRENT_LEAGUE_ID}`)).previous_league_id;
while (id && id !== "0") {
  const lg = await get(`/league/${id}`);
  if (lg.status === "complete") {
    const [users, rosters] = await Promise.all([get(`/league/${id}/users`), get(`/league/${id}/rosters`)]);
    const names = {};
    for (const u of users) names[u.user_id] = u.display_name;
    const owner = {};
    for (const r of rosters) owner[r.roster_id] = r.owner_id;
    const last = Number(lg.settings?.last_scored_leg) || 17;
    const games = [];
    for (let w = 1; w <= last; w++) {
      const rows = await get(`/league/${id}/matchups/${w}`);
      const byM = {};
      for (const m of rows || []) if (m.matchup_id != null) (byM[m.matchup_id] ||= []).push(m);
      for (const pair of Object.values(byM)) {
        if (pair.length !== 2) continue;
        const [a, b] = pair;
        if (!(a.points || b.points)) continue;
        games.push([w, owner[a.roster_id], Math.round(a.points * 100) / 100, owner[b.roster_id], Math.round(b.points * 100) / 100]);
      }
    }
    seasons[lg.season] = { league_id: id, playoff_week_start: lg.settings?.playoff_week_start ?? null, names, games };
    console.log(`${lg.season} ${id}: ${games.length} games through week ${last}`);
  } else {
    console.log(`${lg.season} ${id}: status ${lg.status}, skipped`);
  }
  id = lg.previous_league_id;
}

await writeFile(OUT, JSON.stringify({
  _comment: "Written by chat-worker/scripts/build-matchup-history.mjs from the public Sleeper API. Completed seasons only; scores only. games: [week, owner_a, pts_a, owner_b, pts_b]. Weeks at or after playoff_week_start are bracket games (winners and consolation).",
  generated: new Date().toISOString(),
  current_league_id: CURRENT_LEAGUE_ID,
  seasons,
}) + "\n");
console.log(`wrote ${OUT.pathname}`);

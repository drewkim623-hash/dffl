/**
 * Write the finished week to data/ so the writing job never has to reach for
 * Sleeper.
 *
 * This exists because of a hard constraint: a scheduled Claude routine cannot
 * reach api.sleeper.app. WebFetch wants a per-URL approval nobody is present to
 * give, and the sandbox's egress proxy rejects curl outright. Every Tuesday run
 * since the routine was created failed on exactly that.
 *
 * GitHub Actions has no such restriction, so the split is: this script runs on
 * GitHub, pulls Sleeper, and commits a plain JSON file; the routine clones the
 * repo and writes prose from the file. The writer needs no network at all.
 *
 *   node build-week.mjs            # the week Sleeper says just finished
 *   node build-week.mjs --week 3   # a specific week, for backfill
 *
 * Writes data/week-<season>-<week>.json and points data/latest.json at it.
 * Exits 0 and writes nothing when no week has finished yet, so the scheduled
 * run is a no-op in the off-season rather than a failure.
 */
import { writeFile, mkdir } from "fs/promises";
import { fetchJSON } from "./fetch-json.mjs";

const API = "https://api.sleeper.app/v1";
const LEAGUE = "1318040218183417856";

const arg = (k) => {
  const i = process.argv.indexOf(k);
  return i > 0 ? process.argv[i + 1] : null;
};

// Retries the blips rather than dying on them; see fetch-json.mjs. The label
// keeps the error text reading the way it always has.
const get = (path) => fetchJSON(`${API}/${path}`, { label: path });

const state = await get("state/nfl");
const league = await get(`league/${LEAGUE}`);

// The same rule the site uses: Sleeper only advances state.week once a week's
// last game is over, so the newest *finished* week is the one before it.
const forced = arg("--week");
const target = forced ? Number(forced) : Number(state.week) - 1;

if (!Number.isFinite(target) || target < 1) {
  console.log(`No finished week yet (NFL ${state.season} ${state.season_type} week ${state.week}). Nothing written.`);
  process.exit(0);
}
if (String(state.season) !== String(league.season)) {
  console.log(`Sleeper is in ${state.season}; the league is ${league.season}. Nothing written.`);
  process.exit(0);
}

const [users, rosters, matchups, txns, players] = await Promise.all([
  get(`league/${LEAGUE}/users`),
  get(`league/${LEAGUE}/rosters`),
  get(`league/${LEAGUE}/matchups/${target}`),
  get(`league/${LEAGUE}/transactions/${target}`).catch(() => []),
  get("players/nfl"),
]);

const userById = new Map(users.map(u => [u.user_id, u]));
const ownerOf = new Map(rosters.map(r => [r.roster_id, r.owner_id]));
const nameOf = rid => {
  const u = userById.get(ownerOf.get(rid));
  return u ? u.display_name : `roster ${rid}`;
};
const teamOf = rid => {
  const u = userById.get(ownerOf.get(rid));
  return (u && u.metadata && u.metadata.team_name) || "";
};
const player = pid => {
  const p = players[String(pid)];
  if (!p) return { name: String(pid), pos: "", team: "" };
  return {
    name: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || String(pid),
    pos: p.position || "",
    team: p.team || "FA",
  };
};

/* ---- the six games, with the lineups that decided them ---- */
const byMatchup = new Map();
for (const e of matchups) {
  if (e.matchup_id == null) continue;
  if (!byMatchup.has(e.matchup_id)) byMatchup.set(e.matchup_id, []);
  byMatchup.get(e.matchup_id).push(e);
}

const side = e => {
  const pp = e.players_points || {};
  const starters = (e.starters || []).filter(p => p && p !== "0").map(pid => ({
    ...player(pid), points: Number(pp[pid]) || 0,
  })).sort((a, b) => b.points - a.points);
  const bench = (e.players || []).filter(p => p && p !== "0" && !(e.starters || []).includes(p))
    .map(pid => ({ ...player(pid), points: Number(pp[pid]) || 0 }))
    .sort((a, b) => b.points - a.points);
  return {
    manager: nameOf(e.roster_id), team: teamOf(e.roster_id), roster_id: e.roster_id,
    points: Number(e.points) || 0,
    starters,
    top: starters[0] || null,
    bust: starters.filter(s => s.pos !== "K" && s.pos !== "DEF").slice(-1)[0] || null,
    benchBest: bench[0] || null,
    benchLeft: Number(bench.reduce((a, b) => a + b.points, 0).toFixed(2)),
  };
};

const games = [];
for (const arr of byMatchup.values()) {
  if (arr.length !== 2) continue;
  const [x, y] = arr.map(side);
  const [w, l] = x.points >= y.points ? [x, y] : [y, x];
  games.push({
    winner: w.manager, winner_points: Number(w.points.toFixed(2)),
    loser: l.manager, loser_points: Number(l.points.toFixed(2)),
    margin: Number((w.points - l.points).toFixed(2)),
    total: Number((w.points + l.points).toFixed(2)),
    sides: [w, l],
  });
}
games.sort((a, b) => b.total - a.total);

/* ---- season to date ---- */
const standings = rosters.map(r => ({
  manager: nameOf(r.roster_id), team: teamOf(r.roster_id), roster_id: r.roster_id,
  wins: (r.settings && r.settings.wins) || 0,
  losses: (r.settings && r.settings.losses) || 0,
  ties: (r.settings && r.settings.ties) || 0,
  points_for: Number((((r.settings && r.settings.fpts) || 0)
    + ((r.settings && r.settings.fpts_decimal) || 0) / 100).toFixed(2)),
  points_against: Number((((r.settings && r.settings.fpts_against) || 0)
    + ((r.settings && r.settings.fpts_against_decimal) || 0) / 100).toFixed(2)),
  waiver_budget_used: (r.settings && r.settings.waiver_budget_used) || 0,
})).sort((a, b) => b.wins - a.wins || b.points_for - a.points_for);

/* ---- what happened between the games ---- */
const transactions = (txns || []).filter(t => t.status === "complete").map(t => {
  const who = (t.roster_ids || []).map(nameOf);
  const adds = Object.entries(t.adds || {}).map(([pid, rid]) => ({ ...player(pid), to: nameOf(rid) }));
  const drops = Object.entries(t.drops || {}).map(([pid, rid]) => ({ ...player(pid), from: nameOf(rid) }));
  return {
    type: t.type, managers: who, adds, drops,
    faab: (t.settings && t.settings.waiver_bid) != null ? t.settings.waiver_bid : null,
    picks: (t.draft_picks || []).map(p => ({
      season: p.season, round: p.round, from: nameOf(p.roster_id), to: nameOf(p.owner_id),
    })),
  };
});

/* ---- the lines a writer reaches for first ---- */
const allSides = games.flatMap(g => g.sides);
const by = (arr, f, dir = -1) => arr.slice().sort((a, b) => (f(a) - f(b)) * dir)[0];
const marquee = {
  high: by(allSides, s => s.points),
  low: by(allSides, s => s.points, 1),
  closest: by(games, g => g.margin, 1),
  blowout: by(games, g => g.margin),
  shootout: by(games, g => g.total),
  unlucky: by(allSides.filter(s => games.some(g => g.loser === s.manager)), s => s.points),
};

const out = {
  _comment:
    "Written by build-week.mjs in GitHub Actions. The weekly writing job reads this instead of "
    + "calling Sleeper, which it cannot reach. Everything is already resolved to manager and "
    + "player names — no ids need looking up.",
  season: String(league.season),
  week: target,
  generated: new Date().toISOString(),
  league: { id: LEAGUE, name: league.name, playoff_week_start: league.settings.playoff_week_start },
  is_playoffs: target >= (league.settings.playoff_week_start || 15),
  games, standings, transactions, marquee,
};

await mkdir("data", { recursive: true });
const file = `data/week-${out.season}-${String(target).padStart(2, "0")}.json`;
await writeFile(file, JSON.stringify(out, null, 1) + "\n");
await writeFile("data/latest.json", JSON.stringify({
  _comment: "Points at the most recently finished week written by build-week.mjs.",
  season: out.season, week: target, file, generated: out.generated,
}, null, 1) + "\n");

console.log(`${file} — week ${target}, ${games.length} games, ${transactions.length} transactions`);
console.log(`  marquee: ${marquee.high.manager} ${marquee.high.points} high · `
  + `${marquee.closest.winner} by ${marquee.closest.margin} closest`);

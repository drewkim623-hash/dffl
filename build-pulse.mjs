/**
 * Write data/pulse.json — a small, current picture of the league.
 *
 * The weekly recap job runs on a finished week and has data/week-*.json to work
 * from. The story watch does not: it runs every day and has to decide whether
 * anything worth writing has actually happened. This is what it reads.
 *
 * Deliberately small and deliberately factual. It records what is true right
 * now — standings, the week in progress, recent moves, who is hurt — and makes
 * no judgement about whether any of it is interesting. That judgement is the
 * one thing the watch is for.
 *
 *   node build-pulse.mjs
 */
import { writeFile, mkdir } from "fs/promises";

const API = "https://api.sleeper.app/v1";
const LEAGUE = "1318040218183417856";
const get = async p => {
  const r = await fetch(`${API}/${p}`);
  if (!r.ok) throw new Error(`${p} -> HTTP ${r.status}`);
  return r.json();
};

const state = await get("state/nfl");
const league = await get(`league/${LEAGUE}`);
const week = Number(state.week) || 1;

const [users, rosters, players, schedule] = await Promise.all([
  get(`league/${LEAGUE}/users`),
  get(`league/${LEAGUE}/rosters`),
  fetch(`${API}/players/nfl`).then(r => r.json()),
  fetch("https://api.sleeper.app/schedule/nfl/regular/" + league.season).then(r => r.json()).catch(() => []),
]);

const userById = new Map(users.map(u => [u.user_id, u]));
const owner = new Map(rosters.map(r => [r.roster_id, r.owner_id]));
const nameOf = rid => { const u = userById.get(owner.get(rid)); return u ? u.display_name : `roster ${rid}`; };
const pl = pid => {
  const p = players[String(pid)];
  return p ? { name: p.full_name || `${p.first_name || ""} ${p.last_name || ""}`.trim(), pos: p.position || "", team: p.team || "FA", status: p.injury_status || null } : { name: String(pid) };
};

// The two most recent weeks of moves is enough context to spot a story.
const txWeeks = [week, week - 1].filter(w => w >= 1);
const txns = (await Promise.all(txWeeks.map(w =>
  get(`league/${LEAGUE}/transactions/${w}`).then(x => x.map(t => ({ ...t, _week: w }))).catch(() => []))))
  .flat().filter(t => t.status === "complete");

const matchups = await get(`league/${LEAGUE}/matchups/${week}`).catch(() => []);
const byId = new Map();
for (const e of matchups) {
  if (e.matchup_id == null) continue;
  if (!byId.has(e.matchup_id)) byId.set(e.matchup_id, []);
  byId.get(e.matchup_id).push(e);
}
const gameState = new Map();
for (const g of (schedule || [])) if (Number(g.week) === week) for (const t of [g.home, g.away]) gameState.set(t, g.status);

const thisWeek = [...byId.values()].filter(a => a.length === 2).map(([x, y]) => {
  const side = e => {
    const starters = (e.starters || []).filter(p => p && p !== "0");
    const left = starters.filter(p => {
      const c = (players[String(p)] || {}).team;
      return c && gameState.get(c) !== "complete";
    }).length;
    return { manager: nameOf(e.roster_id), points: Number(e.points) || 0, startersLeftToPlay: left };
  };
  return { a: side(x), b: side(y) };
});

const standings = rosters.map(r => ({
  manager: nameOf(r.roster_id),
  wins: (r.settings || {}).wins || 0,
  losses: (r.settings || {}).losses || 0,
  points_for: Number(((((r.settings || {}).fpts) || 0) + (((r.settings || {}).fpts_decimal) || 0) / 100).toFixed(2)),
  points_against: Number(((((r.settings || {}).fpts_against) || 0) + (((r.settings || {}).fpts_against_decimal) || 0) / 100).toFixed(2)),
  faab_spent: (r.settings || {}).waiver_budget_used || 0,
  starters_hurt: (r.starters || []).filter(p => p && p !== "0" && (players[String(p)] || {}).injury_status)
    .map(p => { const x = pl(p); return `${x.name} (${x.status})`; }),
})).sort((a, b) => b.wins - a.wins || b.points_for - a.points_for);

const moves = txns.map(t => ({
  week: t._week, type: t.type,
  managers: (t.roster_ids || []).map(nameOf),
  adds: Object.entries(t.adds || {}).map(([pid, rid]) => ({ ...pl(pid), to: nameOf(rid) })),
  drops: Object.entries(t.drops || {}).map(([pid, rid]) => ({ ...pl(pid), from: nameOf(rid) })),
  faab: (t.settings || {}).waiver_bid ?? null,
  picks: (t.draft_picks || []).map(p => ({ season: p.season, round: p.round, from: nameOf(p.roster_id), to: nameOf(p.owner_id) })),
}));

const out = {
  _comment:
    "Written by build-pulse.mjs. A current, factual picture of the league for the story watch to "
    + "judge. It records what is true; it does not decide what is interesting.",
  generated: new Date().toISOString(),
  at: Date.now(),
  season: String(league.season),
  nfl_week: week,
  season_type: state.season_type,
  week_in_progress: thisWeek.some(g => g.a.startersLeftToPlay + g.b.startersLeftToPlay > 0),
  standings,
  this_week: thisWeek,
  trades: moves.filter(m => m.type === "trade"),
  waivers: moves.filter(m => m.type !== "trade" && (m.faab ?? 0) > 0).sort((a, b) => (b.faab || 0) - (a.faab || 0)).slice(0, 20),
  free_agent_moves: moves.filter(m => m.type !== "trade" && !(m.faab ?? 0)).length,
};

await mkdir("data", { recursive: true });
await writeFile("data/pulse.json", JSON.stringify(out, null, 1) + "\n");
console.log(`data/pulse.json — week ${week}, ${standings.length} teams, ${out.trades.length} trades, `
  + `${out.waivers.length} paid claims, ${out.free_agent_moves} free moves`);

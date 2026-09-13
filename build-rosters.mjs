/**
 * Write rosters.json — who is on every DFFL roster, and which NFL club they
 * play for.
 *
 * The site needs this to price a week while it is being played. Knowing a
 * starter is on 180 points with three men still to play requires knowing which
 * NFL games those three are in, and that means a player-to-club mapping. The
 * only Sleeper endpoint that carries one is the 5MB player file, which the front
 * page must never pull — so the mapping is reduced here to the couple of hundred
 * players actually on a DFFL roster and committed as a few kilobytes.
 *
 *   node build-rosters.mjs
 *
 * Run it alongside build-injuries.mjs. Rosters change on waivers, so the Action
 * refreshes this on Sunday morning as well as Tuesday — a lineup locked on
 * Sunday is the one that needs pricing.
 */
import { writeFile } from "fs/promises";

const API = "https://api.sleeper.app/v1";
const LEAGUE = "1318040218183417856";

const get = async (path) => {
  const r = await fetch(`${API}/${path}`);
  if (!r.ok) throw new Error(`${path} -> HTTP ${r.status}`);
  return r.json();
};

const [league, rosters, players] = await Promise.all([
  get(`league/${LEAGUE}`),
  get(`league/${LEAGUE}/rosters`),
  fetch(`${API}/players/nfl`).then(r => r.json()),
]);

// The slots a lineup is made of, in the order Sleeper lists starters. This is
// what lets the site know that starters[0] is the quarterback.
const slots = (league.roster_positions || []).filter(p => p !== "BN" && p !== "IR" && p !== "TAXI");

const map = {};
let missing = 0;
for (const r of rosters) {
  for (const pid of [...(r.players || []), ...(r.starters || [])]) {
    if (!pid || pid === "0" || map[pid]) continue;
    const p = players[String(pid)];
    if (!p) { missing++; continue; }
    map[pid] = {
      n: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || String(pid),
      p: p.position || "",
      t: p.team || "FA",
      ...(p.injury_status ? { s: String(p.injury_status) } : {}),
    };
  }
}

const out = {
  _comment:
    "Written by build-rosters.mjs. Every player on a DFFL roster with position, NFL club and any "
    + "injury status. The site reads this to work out which of a lineup's starters have already "
    + "played, which is what makes a live win probability possible without a 5MB download.",
  at: Date.now(),
  generated: new Date().toISOString(),
  season: String(league.season),
  slots,
  count: Object.keys(map).length,
  map,
};

await writeFile("rosters.json", JSON.stringify(out, null, 0) + "\n");
const bytes = JSON.stringify(out).length;
console.log(`rosters.json — ${out.count} rostered players, ${(bytes / 1024).toFixed(1)}KB`
  + `${missing ? `, ${missing} not found in the player file` : ""}`);
console.log(`  lineup slots: ${slots.join(" ")}`);

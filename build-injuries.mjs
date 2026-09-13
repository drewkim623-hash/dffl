/**
 * Write injuries.json — the small injury snapshot the site reads on the front
 * page.
 *
 * Sleeper's player file is about 5MB. The site must not pull that on boot, so
 * this reduces it to the few hundred players actually carrying a status, which
 * comes to a few tens of kilobytes, and commits that alongside the page. A
 * reader who never opens the Odds tab still sees who is hurt; the Odds tab is
 * the only thing that ever pays for the full download, and only to get a status
 * fresher than this file's.
 *
 *   node build-injuries.mjs
 *
 * Run it whenever you want the front page's injury strip refreshed — the weekly
 * job runs it as part of the Tuesday update.
 */
import { writeFile } from "fs/promises";

const SRC = "https://api.sleeper.app/v1/players/nfl";

const res = await fetch(SRC);
if (!res.ok) {
  console.error(`${SRC} -> HTTP ${res.status}`);
  process.exit(1);
}
const all = await res.json();

const map = {};
for (const id of Object.keys(all)) {
  const p = all[id];
  const s = p && p.injury_status;
  if (!s) continue;
  // Sleeper carries a status on free agents and on players who retired years
  // ago. Nobody in a DFFL starting lineup is without an NFL club, so dropping
  // them costs the site nothing and halves the file.
  if (!p.team) continue;
  map[id] = {
    s: String(s),
    n: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id,
    p: p.position || "",
    t: p.team,
  };
}

const out = {
  _comment:
    "Written by build-injuries.mjs from Sleeper's player file. The site reads this so the "
    + "front page can show the injury report without pulling 5MB. Absence from map means healthy.",
  at: Date.now(),
  generated: new Date().toISOString(),
  source: SRC,
  count: Object.keys(map).length,
  map,
};

await writeFile("injuries.json", JSON.stringify(out, null, 0) + "\n");
const bytes = JSON.stringify(out).length;
console.log(`injuries.json — ${out.count} players carrying a status, ${(bytes / 1024).toFixed(1)}KB`);

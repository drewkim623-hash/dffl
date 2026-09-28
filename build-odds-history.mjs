/**
 * How each matchup's line moved during a week, read back out of git.
 *
 *   node build-odds-history.mjs
 *
 * data/odds-snapshot.json is rewritten by build-email.mjs several times a week,
 * and every committed copy of it is a reading of what the site believed at that
 * moment. Nothing else keeps that record, so this walks the file's history and
 * lays the matchup rows side by side:
 *
 *   data/odds-history.json = { _comment, generated,
 *     weeks: { "<season>-<week>": [ { at, a, b, pA, aPts, bPts, settled }, ... ] } }
 *
 * Read-only against git. The only thing it writes is data/odds-history.json.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(new URL(".", import.meta.url).pathname);
const SNAP = "data/odds-snapshot.json";
const OUT = join(ROOT, "data/odds-history.json");

const git = args => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

const log = git(["log", "--format=%H%x09%cI", "--", SNAP]).trim().split("\n").filter(Boolean);
const weeks = {};
const seen = new Set();
let read = 0, skipped = 0;

for (const line of log) {
  const [sha, committed] = line.split("\t");
  let snap;
  try { snap = JSON.parse(git(["show", `${sha}:${SNAP}`])); }
  catch { skipped++; continue; }
  read++;
  const games = Array.isArray(snap.games) ? snap.games : [];
  // The games on a snapshot belong to the week in flight; fall back to the
  // snapshot's own week when nothing was live.
  const week = snap.liveWeek ?? snap.week;
  if (!games.length || week == null || !snap.season) continue;
  const key = `${snap.season}-${week}`;
  // The snapshot's own clock, not the commit's: a copy can be committed well
  // after it was taken.
  const at = snap.generated || committed;
  for (const g of games) {
    if (!g || !g.a || !g.b || typeof g.pA !== "number") continue;
    const dup = `${key}|${at}|${g.a}|${g.b}`;
    if (seen.has(dup)) continue;
    seen.add(dup);
    (weeks[key] ||= []).push({
      at, a: g.a, b: g.b, pA: g.pA,
      aPts: g.aPts ?? 0, bPts: g.bPts ?? 0, settled: !!g.settled,
    });
  }
}
for (const k of Object.keys(weeks)) weeks[k].sort((x, y) => Date.parse(x.at) - Date.parse(y.at));

const out = {
  _comment: "Written by build-odds-history.mjs from the git history of data/odds-snapshot.json. " +
    "One row per matchup per committed snapshot; pA is the chance manager a beats manager b as the site priced it at that moment.",
  generated: new Date().toISOString(),
  weeks: Object.fromEntries(Object.keys(weeks).sort().map(k => [k, weeks[k]])),
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
const rows = Object.values(weeks).reduce((n, w) => n + w.length, 0);
console.log(`read ${read} snapshots (${skipped} unreadable) → ${Object.keys(weeks).length} weeks, ${rows} rows → ${OUT}`);

/**
 * A small fingerprint of the Sleeper state the site's odds depend on, so the
 * 20-minute poll (.github/workflows/sleeper-poll.yml) can tell in a few
 * seconds whether anything worth a rebuild has happened.
 *
 * Three things, for this league and the current week (Sleeper /state/nfl):
 *   - transactions for this week and last (late-processed waivers land a week
 *     behind), keyed by transaction_id + status + status_updated;
 *   - roster composition, roster_id -> sorted players / reserve / taxi;
 *   - injuries: every rostered player's injury tags off Sleeper's player file
 *     (INJURY_TAGS below), player_id -> hash, only for players carrying any.
 *
 * The injury part costs the 5MB player file on every poll, which is more often
 * than the once a day Sleeper asks for; it is the price of seeing a status
 * change within 20 minutes rather than at the next injury-refresh.yml slot.
 * If that file fails to load, the transactions and rosters are still compared
 * and the committed injury part is carried forward unchanged, so a flaky player
 * file never hides a trade and never reads as an injury change.
 *
 *   node sleeper-fingerprint.mjs --check   # GITHUB_OUTPUT changed=true|false, injuries=true|false
 *   node sleeper-fingerprint.mjs --write   # save data/sleeper-fingerprint.json
 *
 * injuries=true means an injury tag moved, and the poll then runs the
 * consensus (consensus.mjs) ahead of the snapshot and return-date builds.
 *
 * A fetch failure of state, rosters or transactions is never a change: it
 * warns, reports changed=false, exits 0, and writes nothing, so a partial
 * fingerprint is never committed.
 */
import { readFile, writeFile, appendFile } from "fs/promises";
import { createHash } from "crypto";
import { fetchJSON } from "./fetch-json.mjs";

// URL overrides (verify.mjs points them at a dead port): SLEEPER_API, SLEEPER_PLAYERS_URL.
const API = process.env.SLEEPER_API || "https://api.sleeper.app/v1";
const LEAGUE = "1318040218183417856";
const FILE = "data/sleeper-fingerprint.json";
const PLAYERS_URL = process.env.SLEEPER_PLAYERS_URL || `${API}/players/nfl`;

/** The Sleeper player fields that make up a player's injury state. */
export const INJURY_TAGS = ["injury_status", "injury_body_part", "injury_notes", "injury_start_date",
  "practice_participation", "practice_description", "status"];

const get = p => fetchJSON(`${API}/${p}`, { label: p });
const hash = v => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

/**
 * player_id -> hash of his INJURY_TAGS, for the given ids. A player with no
 * injury tag and Sleeper status "Active" (or none) is healthy and left out, so
 * getting healthy reads as a change too.
 */
export function injuryTags(players, ids) {
  const out = {};
  for (const id of [...new Set(ids)].map(String).sort()) {
    const p = players && players[id];
    if (!p) continue;
    const tags = {};
    for (const k of INJURY_TAGS) {
      const v = p[k];
      if (v == null || v === "" || (Array.isArray(v) && !v.length)) continue;
      if (k === "status" && v === "Active") continue;
      tags[k] = v;
    }
    if (Object.keys(tags).length) out[id] = hash(tags);
  }
  return out;
}

/** What moved between two fingerprints: { changes: [..], injuries: bool }. */
export function diff(a, b) {
  const out = [];
  if (!a) return { changes: ["no committed fingerprint"], injuries: b.injuries != null };
  if (a.season !== b.season || a.week !== b.week) out.push(`week ${a.season}-${a.week} -> ${b.season}-${b.week}`);
  const oldTx = new Set(a.transactions || []);
  const newTx = b.transactions.filter(t => !oldTx.has(t));
  if (newTx.length || (a.transactions || []).length !== b.transactions.length)
    out.push(`transactions ${newTx.length} new/updated (${newTx.slice(0, 3).map(t => t.split(":").slice(1, 3).join(" ")).join(", ")})`);
  const ids = new Set([...Object.keys(a.rosters || {}), ...Object.keys(b.rosters)]);
  const moved = [...ids].filter(id => (a.rosters || {})[id] !== b.rosters[id]);
  if (moved.length) out.push(`rosters ${moved.join(",")} changed`);
  // No player file this run (b.injuries null): no evidence either way.
  let injuries = false;
  if (b.injuries) {
    const ai = a.injuries || {};
    const pids = new Set([...Object.keys(ai), ...Object.keys(b.injuries)]);
    const hurt = [...pids].filter(id => ai[id] !== b.injuries[id]);
    if (!a.injuries) hurt.push("(no committed injury tags)");
    if (hurt.length) {
      injuries = true;
      out.push(`injury tags ${hurt.length} changed (${hurt.slice(0, 5).join(",")})`);
    }
  }
  return { changes: out, injuries };
}

async function output(changed, injuries) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\ninjuries=${injuries}\n`);
}

async function build() {
  const state = await get("state/nfl");
  const week = Math.max(1, Number(state.week) || 1);
  const weeks = week > 1 ? [week - 1, week] : [week];
  const [rosters, players, ...txWeeks] = await Promise.all([
    get(`league/${LEAGUE}/rosters`),
    fetchJSON(PLAYERS_URL, { label: "players/nfl", tries: 2 }).catch(e => {
      console.log(`::warning::sleeper-fingerprint: player file unavailable, injury tags not compared (${e.message})`);
      return null;
    }),
    ...weeks.map(w => get(`league/${LEAGUE}/transactions/${w}`)),
  ]);
  if (!Array.isArray(rosters) || !rosters.length || txWeeks.some(t => !Array.isArray(t)))
    throw new Error("unexpected Sleeper response shape");

  const transactions = txWeeks.flat()
    .map(t => `${t.transaction_id}:${t.type}:${t.status}:${t.status_updated}`)
    .sort();

  const sorted = a => [...(a || [])].map(String).sort();
  const rosterMap = {};
  for (const r of rosters) {
    rosterMap[r.roster_id] = hash({ players: sorted(r.players), reserve: sorted(r.reserve), taxi: sorted(r.taxi) });
  }
  const rosteredIds = rosters.flatMap(r => [...(r.players || []), ...(r.reserve || []), ...(r.taxi || [])]);
  const injuries = players && typeof players === "object" ? injuryTags(players, rosteredIds) : null;

  return { season: String(state.season), week, transactions, rosters: rosterMap, injuries };
}

async function main() {
  const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : null;
  if (!mode) {
    console.error("usage: node sleeper-fingerprint.mjs --check | --write");
    process.exit(2);
  }

  let fp;
  try {
    fp = await build();
  } catch (e) {
    console.log(`::warning::sleeper-fingerprint: fetch failed, treating as no change (${e.message})`);
    if (mode === "check") await output(false, false);
    process.exit(0);
  }

  const prev = await readFile(FILE, "utf8").then(JSON.parse).catch(() => null);
  if (mode === "write") {
    // No player file this run: keep the committed injury part, so the next
    // poll compares against what was last seen rather than against nothing.
    if (fp.injuries == null) fp.injuries = (prev && prev.injuries) || null;
    if (fp.injuries == null) delete fp.injuries;
    await writeFile(FILE, JSON.stringify(fp, null, 1) + "\n");
    console.log(`sleeper-fingerprint: wrote ${FILE} (${fp.season} week ${fp.week}, ${fp.transactions.length} transactions, `
      + `${Object.keys(fp.rosters).length} rosters, ${fp.injuries ? Object.keys(fp.injuries).length : "no"} injury-tagged)`);
  } else {
    const { changes, injuries } = diff(prev, fp);
    await output(changes.length > 0, injuries);
    console.log(changes.length ? `sleeper-fingerprint: changed — ${changes.join("; ")}` : "sleeper-fingerprint: no change");
  }
}

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();

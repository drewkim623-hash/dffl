/**
 * A small fingerprint of the Sleeper state the site's odds depend on, so the
 * 20-minute poll (.github/workflows/sleeper-poll.yml) can tell in a few
 * seconds whether anything worth a rebuild has happened.
 *
 * Two things, both for this league and the current week (Sleeper /state/nfl):
 *   - transactions for this week and last (late-processed waivers land a week
 *     behind), keyed by transaction_id + status + status_updated;
 *   - roster composition, roster_id -> sorted players / reserve / taxi.
 *
 * Injuries are deliberately not part of it. Sleeper asks that its 5MB player
 * file be pulled about once a day, and a poll every 20 minutes cannot honour
 * that, so injury changes are left to injury-refresh.yml (daily) and the
 * weekly build, which are the only things here that read it.
 *
 *   node sleeper-fingerprint.mjs --check   # GITHUB_OUTPUT changed=true|false
 *   node sleeper-fingerprint.mjs --write   # save data/sleeper-fingerprint.json
 *
 * A fetch failure is never a change: it warns, reports changed=false, exits 0,
 * and writes nothing, so a partial fingerprint is never committed.
 */
import { readFile, writeFile, appendFile } from "fs/promises";
import { createHash } from "crypto";
import { fetchJSON } from "./fetch-json.mjs";

const API = "https://api.sleeper.app/v1";
const LEAGUE = "1318040218183417856";
const FILE = "data/sleeper-fingerprint.json";
const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : null;
if (!mode) {
  console.error("usage: node sleeper-fingerprint.mjs --check | --write");
  process.exit(2);
}

const get = p => fetchJSON(`${API}/${p}`, { label: p });
const hash = v => createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 16);

async function output(changed) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
}

async function build() {
  const state = await get("state/nfl");
  const week = Math.max(1, Number(state.week) || 1);
  const weeks = week > 1 ? [week - 1, week] : [week];
  const [rosters, ...txWeeks] = await Promise.all([
    get(`league/${LEAGUE}/rosters`),
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

  return { season: String(state.season), week, transactions, rosters: rosterMap };
}

function diff(a, b) {
  const out = [];
  if (!a) return ["no committed fingerprint"];
  if (a.season !== b.season || a.week !== b.week) out.push(`week ${a.season}-${a.week} -> ${b.season}-${b.week}`);
  const oldTx = new Set(a.transactions || []);
  const newTx = b.transactions.filter(t => !oldTx.has(t));
  if (newTx.length || (a.transactions || []).length !== b.transactions.length)
    out.push(`transactions ${newTx.length} new/updated (${newTx.slice(0, 3).map(t => t.split(":").slice(1, 3).join(" ")).join(", ")})`);
  const ids = new Set([...Object.keys(a.rosters || {}), ...Object.keys(b.rosters)]);
  const moved = [...ids].filter(id => (a.rosters || {})[id] !== b.rosters[id]);
  if (moved.length) out.push(`rosters ${moved.join(",")} changed`);
  return out;
}

let fp;
try {
  fp = await build();
} catch (e) {
  console.log(`::warning::sleeper-fingerprint: fetch failed, treating as no change (${e.message})`);
  if (mode === "check") await output(false);
  process.exit(0);
}

if (mode === "write") {
  await writeFile(FILE, JSON.stringify(fp, null, 1) + "\n");
  console.log(`sleeper-fingerprint: wrote ${FILE} (${fp.season} week ${fp.week}, ${fp.transactions.length} transactions, `
    + `${Object.keys(fp.rosters).length} rosters)`);
} else {
  const prev = await readFile(FILE, "utf8").then(JSON.parse).catch(() => null);
  const changes = diff(prev, fp);
  await output(changes.length > 0);
  console.log(changes.length ? `sleeper-fingerprint: changed — ${changes.join("; ")}` : "sleeper-fingerprint: no change");
}

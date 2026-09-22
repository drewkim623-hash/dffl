/**
 * Write injuries.json — the small injury snapshot the site reads on the front
 * page, and what the league can expect of each hurt player.
 *
 * Sleeper's player file is about 5MB. The site must not pull that on boot, so
 * this reduces it to the few hundred players actually carrying a status, which
 * comes to a few tens of kilobytes, and commits that alongside the page. A
 * reader who never opens the Odds tab still sees who is hurt; the Odds tab is
 * the only thing that ever pays for the full download, and only to get a status
 * fresher than this file's.
 *
 * Sleeper says *that* a man is hurt and roughly where. It says nothing at all
 * about how long for: injury_start_date, practice_participation and
 * practice_description are empty for every player on the list. So the outlook —
 * whether there was surgery, when he is expected back — is read off ESPN's
 * public injury feed and matched to Sleeper by name.
 *
 * Sleeper remains the authority on status, because the Odds tab prices lineups
 * off it and the two feeds disagree often enough to matter: on a given week
 * ESPN will have a man Questionable whom Sleeper has Out. ESPN is used here for
 * description and nothing else, so nothing added below can move a price.
 *
 *   node build-injuries.mjs
 *
 * Run it whenever you want the front page's injury strip refreshed — the weekly
 * job runs it as part of the Tuesday update, after the roster map, because the
 * prose notes are only worth their bytes for players somebody actually rosters.
 */
import { writeFile, readFile } from "fs/promises";
import { fetchJSON } from "./fetch-json.mjs";

const SRC = "https://api.sleeper.app/v1/players/nfl";
const ESPN = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries";

// 5MB over a connection Sleeper sometimes resets, on a schedule with nobody
// watching to hit re-run: retrying is the difference between a fresh snapshot
// and a red job. See fetch-json.mjs.
const all = await fetchJSON(SRC).catch(e => {
  console.error(e.message);
  process.exit(1);
});

// The outlook is a bonus on top of a file that was useful before it existed, so
// it must never be the thing that fails the run. If ESPN is down the snapshot
// still gets written; it just carries statuses and body parts, as it always did.
const espnFeed = await fetchJSON(ESPN, { label: "espn/injuries" }).catch(e => {
  console.warn(`ESPN outlook unavailable (${e.message}) — writing statuses only.`);
  return null;
});

/* ------------------------------------------------------------------ matching */

// "A.J. Brown Jr." and "AJ Brown" are one man. Punctuation and generational
// suffixes are the only things that differ between the two feeds' spellings.
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const normName = s => String(s || "")
  .toLowerCase()
  .replace(/[^a-z\s]/g, "")
  .split(/\s+/)
  .filter(w => w && !SUFFIXES.has(w))
  .join("");

const espnByName = new Map();
for (const team of (espnFeed && espnFeed.injuries) || []) {
  for (const it of team.injuries || []) {
    const a = it.athlete || {};
    const d = it.details || {};
    const key = normName(a.displayName);
    if (!key) continue;
    if (!espnByName.has(key)) espnByName.set(key, []);
    espnByName.get(key).push({
      status: String(it.status || ""),
      pos: (a.position && a.position.abbreviation) || "",
      team: (a.team && a.team.abbreviation) || "",
      type: String(d.type || ""),
      detail: String(d.detail || ""),
      returnDate: String(d.returnDate || ""),
      note: String(it.longComment || it.shortComment || "").replace(/\s+/g, " ").trim(),
    });
  }
}

/**
 * Which ESPN entry, if any, is this Sleeper player.
 *
 * Two men can share a name, and guessing between them would print one man's
 * torn knee against the other man's name. Position and club settle almost every
 * case; where they do not, the honest answer is to say nothing.
 */
const matchEspn = (rec) => {
  const cands = espnByName.get(normName(rec.n));
  if (!cands || !cands.length) return null;
  if (cands.length === 1) return cands[0];
  const byPos = cands.filter(c => c.pos && rec.p && c.pos === rec.p);
  if (byPos.length === 1) return byPos[0];
  const byTeam = (byPos.length ? byPos : cands).filter(c => c.team && rec.t && c.team === rec.t);
  return byTeam.length === 1 ? byTeam[0] : null;
};

/* ------------------------------------------------------------- reading ESPN */

// Sleeper puts a coach's decision and a suspension in the same field as a torn
// ACL. They are real reasons a man is not playing, and the status already says
// so — but none of them is a body part, and printing them as one reads badly.
const NOT_A_BODY_PART = new Set([
  "coach's decision", "undisclosed", "personal", "not injury related",
  "load management", "rest",
]);

const bodyPart = (fromSleeper, fromEspn) => {
  for (const c of [fromSleeper, fromEspn]) {
    const v = String(c || "").trim();
    if (v && !NOT_A_BODY_PART.has(v.toLowerCase())) return v;
  }
  return "";
};

// "Not Specified" is ESPN's way of saying it has no detail, which the site can
// say in fewer bytes by leaving the field out.
const severity = d => {
  const v = String(d || "").trim();
  return v && v.toLowerCase() !== "not specified" ? v : "";
};

/**
 * ESPN's returnDate, but only when it is actually a prognosis.
 *
 * For most of the list it holds the date of the next game — over a hundred of
 * today's entries share one Sunday — which tells a reader only that football is
 * played on Sundays. Beyond the coming week it is a real expectation, and the
 * ones that matter are weeks or months out. The cost of the rule is a genuine
 * eight-day absence read as "no date"; the alternative is printing "back Sep 27"
 * against every sprained ankle in the league.
 */
const NEAR_DAYS = 8;
const realReturn = (iso) => {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  return (t - Date.now()) / 86400000 >= NEAR_DAYS ? String(iso).slice(0, 10) : "";
};

// ESPN writes a comment on every player it tracks, hurt or not, and for the
// healthy ones it is fantasy copy about last week's carries. Only a player it
// actually lists an injury against has a comment worth repeating.
const isHurtOnEspn = hit => !!(hit && hit.type && hit.status && hit.status !== "Active");

const NOTE_MAX = 200;
const clip = (s) => {
  if (s.length <= NOTE_MAX) return s;
  const cut = s.lastIndexOf(" ", NOTE_MAX);
  return s.slice(0, cut > 40 ? cut : NOTE_MAX).replace(/[,;:.\s]+$/, "") + "…";
};

// The prose is the expensive part of this file, so it goes only to players
// somebody in the league actually rosters — about twenty men rather than five
// hundred. Written by build-rosters.mjs, which the Action runs first.
let rostered = new Set();
try {
  const r = JSON.parse(await readFile("rosters.json", "utf8"));
  rostered = new Set(Object.keys(r.map || {}));
} catch (e) {
  console.warn("rosters.json unreadable — outlook notes skipped this run.");
}

/* -------------------------------------------------------------- the snapshot */

const map = {};
const seen = { matched: 0, bp: 0, sev: 0, ret: 0, note: 0 };

for (const id of Object.keys(all)) {
  const p = all[id];
  const s = p && p.injury_status;
  if (!s) continue;
  // Sleeper carries a status on free agents and on players who retired years
  // ago. Nobody in a DFFL starting lineup is without an NFL club, so dropping
  // them costs the site nothing and halves the file.
  if (!p.team) continue;

  const rec = {
    s: String(s),
    n: p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || id,
    p: p.position || "",
    t: p.team,
  };

  const hit = matchEspn(rec);
  if (hit) seen.matched++;

  const bp = bodyPart(p.injury_body_part, hit && hit.type);
  if (bp) { rec.bp = bp; seen.bp++; }

  if (isHurtOnEspn(hit)) {
    const sev = severity(hit.detail);
    if (sev) { rec.sev = sev; seen.sev++; }
    const ret = realReturn(hit.returnDate);
    if (ret) { rec.ret = ret; seen.ret++; }
    if (rostered.has(id) && hit.note.length > 20) { rec.note = clip(hit.note); seen.note++; }
  }

  map[id] = rec;
}

const out = {
  _comment:
    "Written by build-injuries.mjs. Status, name, position, club and body part (bp) from "
    + "Sleeper's player file; severity (sev), expected return (ret) and the prose note from "
    + "ESPN's public injury feed, matched by name. Sleeper is the authority on status — the "
    + "Odds tab prices off it. Absence from map means healthy. Notes are carried only for "
    + "players on a DFFL roster.",
  at: Date.now(),
  generated: new Date().toISOString(),
  source: SRC,
  sources: { status: SRC, outlook: espnFeed ? ESPN : null },
  count: Object.keys(map).length,
  map,
};

await writeFile("injuries.json", JSON.stringify(out, null, 0) + "\n");
const bytes = JSON.stringify(out).length;
console.log(`injuries.json — ${out.count} players carrying a status, ${(bytes / 1024).toFixed(1)}KB`);
console.log(`  outlook: ${seen.matched} matched on ESPN · ${seen.bp} body parts · ${seen.sev} severities`
  + ` · ${seen.ret} return dates · ${seen.note} notes (rostered only)`);

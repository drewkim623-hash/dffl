/**
 * How long a hurt player is out — settled once, in its own build step
 * (`node injury-returns.mjs`, after build-injuries.mjs), and written onto his
 * injuries.json record, where projectedPointsLost() and the odds read it.
 * verify.mjs imports parseOutlook / resolveReturn.
 *
 * First hit wins:
 *   1. the club's timetable: injury-returns.json kind "team"  retSource "team"  (not estimated)
 *   2. Sleeper outlook/news prose (none exposed today; hook) retSource "sleeper-outlook" (estimated)
 *   3. ESPN's returnDate, when it is a real prognosis        retSource "espn-return-date"
 *      a timetable in ESPN's outlook prose                   retSource "espn-outlook"  (estimated)
 *      injury-returns.json kind "report"                      retSource "report" (estimated unless dated)
 *   4. RETURN_DEFAULTS for the status                         retSource "default"  (estimated)
 *
 * Fields written: ret (ISO date, only when one is derivable), retWeeks (weeks
 * from the coming one, when there is no date; 99 = rest of season, playoffs
 * included), retSource, retEstimated, retNote, retChecked.
 */

/** weeks from the coming one; "ros" = the rest of the regular season. */
export const RETURN_DEFAULTS = {
  Questionable: { weeks: 1 }, Doubtful: { weeks: 1 },
  Out: { weeks: 1 }, Sus: { weeks: 1 }, NA: { weeks: 1 }, DNR: { weeks: 1 }, COV: { weeks: 1 },
  IR: { weeks: "ros" }, PUP: { weeks: "ros" },
};

export const SEASON = 99;
const NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, twelve: 12 };
const num = s => (/^\d+$/.test(String(s)) ? Number(s) : (NUM[String(s).toLowerCase()] ?? NaN));
const N = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|twelve)";

/**
 * A timetable in prose, or null: { weeks, phrase } with weeks counted from the
 * coming week (SEASON = the rest of it), or { untilWeek, phrase }.
 *   parseOutlook("expected to miss 4-6 weeks") -> { weeks: 6, phrase: "miss 4-6 weeks" }
 */
export function parseOutlook(text) {
  const t = String(text || "").replace(/\s+/g, " ");
  if (!t) return null;
  let m;
  if ((m = t.match(/season[- ]ending|(?:out|miss|sidelined) for the (?:rest of the |remainder of the )?(?:\d{4} )?season/i))) {
    return { weeks: SEASON, phrase: m[0] };
  }
  if ((m = t.match(/\bout (?:until|through) Week (\d+)/i))) return { untilWeek: Number(m[1]), phrase: m[0] };
  if ((m = t.match(new RegExp(`\\bmiss(?:ing)?\\b[^.]{0,25}?\\b${N}(?:\\s*(?:-|–|to|or)\\s*${N})?\\s*(?:more\\s+)?(?:weeks?|games?)\\b`, "i")))) {
    const hi = Math.max(num(m[1]), m[2] ? num(m[2]) : 0);
    if (hi > 0) return { weeks: hi, phrase: m[0] };
  }
  if ((m = t.match(/placed (?:\w+ )?on (?:injured reserve|IR)\b|(?:moved|lands?|landed|goes|going|headed) (?:\w+ )?(?:on|to) (?:injured reserve|IR)\b/i))) {
    return { weeks: 4, phrase: m[0] };
  }
  if ((m = t.match(/week[- ]to[- ]week/i))) return { weeks: 2, phrase: m[0] };
  return null;
}

/**
 * The return fields for one rostered injured player.
 *   rec      his injuries.json record so far ({ s, ret? }); ret here is ESPN's
 *   notes    ESPN long / short comments and the carried note text
 *   report   his injury-returns.json entry, if any
 *   week     the coming NFL week (projections.current_week)
 *   lastReg  the last regular-season week (playoff_week_start - 1)
 *   sundayOf (w) -> that week's Sunday, ISO, or null
 * retWeeks counts fantasy weeks starting with `week` — what PTS_LOST
 * .retWeeksStartsThisWeek reads; SEASON (99) runs past the regular season.
 */
export function resolveReturn({ rec, notes = [], sleeperNotes = [], report = null, week, lastReg = 14, sundayOf = null, today }) {
  const retChecked = today || new Date().toISOString().slice(0, 10);
  // A hand entry: { ret } or { weeks }, from the team ("team") or a report ("report").
  const fromEntry = (e, retSource, estimated) => ({
    ...(e.ret ? { ret: e.ret } : { retWeeks: e.weeks === "season" ? SEASON : Number(e.weeks) }),
    retSource, retEstimated: estimated,
    retNote: [e.source, e.note].filter(Boolean).join(" — ") || retSource, retChecked: e.checked || retChecked,
  });
  const has = e => e && (e.ret || e.weeks != null);
  // A timetable in prose, or null.
  const fromProse = (texts, retSource) => {
    for (const n of texts) {
      const hit = parseOutlook(n);
      if (!hit) continue;
      const out = { retSource, retEstimated: true, retNote: hit.phrase, retChecked };
      if (hit.untilWeek != null) {
        // Back in week N: out every week before it.
        const sun = sundayOf && sundayOf(hit.untilWeek);
        if (sun) out.ret = sun;
        else out.retWeeks = Math.max(1, hit.untilWeek - (week || 1));
      } else out.retWeeks = hit.weeks;
      return out;
    }
    return null;
  };
  // 1. The club's own timetable (injury-returns.json, kind "team"): a date or a
  //    number of weeks the team gave is not an estimate.
  if (report && report.kind === "team" && has(report)) return fromEntry(report, "team", false);
  // 2. Sleeper outlook/news. Sleeper exposes none today: players/nfl carries only
  //    injury_notes (the injury type — "Sprain", "Fracture"), practice_description
  //    is empty and there is no news endpoint. The hook stays for if it ever does.
  const sl = fromProse(sleeperNotes, "sleeper-outlook");
  if (sl) return sl;
  // 3. Online reports: ESPN's date, then ESPN's prose, then a hand-curated report.
  if (rec.ret) return { ret: rec.ret, retSource: "espn-return-date", retEstimated: false, retNote: "ESPN return date", retChecked };
  const es = fromProse(notes, "espn-outlook");
  if (es) return es;
  if (report && report.kind !== "team" && has(report)) return fromEntry(report, "report", !report.ret);
  // 4. RETURN_DEFAULTS.
  const d = RETURN_DEFAULTS[rec.s] || { weeks: 1 };
  return {
    retWeeks: d.weeks === "ros" ? (week != null ? Math.max(1, lastReg - week + 1) : SEASON) : d.weeks,
    retSource: "default", retEstimated: true,
    retNote: d.weeks === "ros" ? `default: ${rec.s} = rest of regular season` : `default: ${rec.s} = coming week only`,
    retChecked,
  };
}

/* ------------------------------------------------------------------ the CLI */
/*
 * node injury-returns.mjs — run after build-injuries.mjs, never in the browser.
 * Reads injuries.json, looks each rostered injured player up on ESPN's injury
 * feed (full comments, not the clipped note), writes the return fields onto his
 * record and the derived result, with its source and date, into
 * injury-returns-cache.json. If ESPN is unreachable (20s timeout), a cached
 * result for the same status is reused. Any other failure logs a warning and
 * leaves injuries.json and the cache as they were: the weekly job never fails
 * on this script. ESPN_INJURIES_URL overrides the feed (verify.mjs points it at
 * a dead port to test the fallback).
 */
const FIELDS = ["ret", "retWeeks", "retSource", "retEstimated", "retNote", "retChecked"];
const ESPN = process.env.ESPN_INJURIES_URL || "https://site.api.espn.com/apis/site/v2/sports/football/nfl/injuries";
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);
const normName = s => String(s || "").toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/)
  .filter(w => w && !SUFFIXES.has(w)).join("");

async function main() {
  const fs = await import("node:fs");
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
  const inj = read("injuries.json", null);
  if (!inj || !inj.map) throw new Error("injuries.json missing or empty — run build-injuries.mjs first");
  const rost = read("rosters.json", null);
  const proj = read("data/projections.json", {});
  const reports = read("injury-returns.json", {}).entries || {};
  const cache = read("injury-returns-cache.json", { entries: {} });
  const week = Number(proj.current_week) || null;
  const lastReg = (Number(proj.playoff_week_start) || 15) - 1;
  const sundayOf = w => (proj.sundays || {})[w] || null;
  const today = new Date().toISOString().slice(0, 10);

  let feed = null;
  try {
    const { fetchJSON } = await import("./fetch-json.mjs");
    feed = await fetchJSON(ESPN, { label: "espn/injuries", tries: 2, timeoutMs: 20000 });
  } catch (e) { console.warn(`ESPN feed unavailable (${e.message}) — reusing cached results where the status matches.`); }
  const byName = new Map();
  for (const team of (feed && feed.injuries) || []) for (const it of team.injuries || []) {
    const a = it.athlete || {}, key = normName(a.displayName);
    if (!key) continue;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push({
      pos: (a.position && a.position.abbreviation) || "", team: (a.team && a.team.abbreviation) || "",
      notes: [it.longComment, it.shortComment].map(x => String(x || "").replace(/\s+/g, " ").trim()).filter(Boolean),
    });
  }
  // Same rule as build-injuries.mjs: an ambiguous name matches nobody.
  const match = rec => {
    const c = byName.get(normName(rec.n)) || [];
    if (c.length <= 1) return c[0] || null;
    const p = c.filter(x => x.pos === rec.p);
    if (p.length === 1) return p[0];
    const t = (p.length ? p : c).filter(x => x.team === rec.t);
    return t.length === 1 ? t[0] : null;
  };

  const rostered = rost && rost.map ? new Set(Object.keys(rost.map)) : null;
  const entries = {}, tally = {};
  for (const [pid, rec] of Object.entries(inj.map)) {
    if (!rec || !rec.s || (rostered && !rostered.has(pid))) continue;
    // A ret this script derived on an earlier run is not ESPN's: start clean.
    if (rec.retSource && rec.retSource !== "espn-return-date") delete rec.ret;
    for (const f of FIELDS) if (f !== "ret") delete rec[f];
    const c = cache.entries && cache.entries[pid];
    const r = !feed && !rec.ret && c && c.s === rec.s && c.retSource
      ? Object.fromEntries(FIELDS.filter(f => c[f] != null).map(f => [f, c[f]]))
      : resolveReturn({ rec, notes: [...((match(rec) || {}).notes || []), rec.note].filter(Boolean),
        report: reports[pid] || null, week, lastReg, sundayOf, today });
    for (const f of FIELDS) if (r[f] != null) rec[f] = r[f];
    entries[pid] = { n: rec.n, s: rec.s, ret: rec.ret || null, retWeeks: rec.retWeeks ?? null, retSource: rec.retSource,
      retEstimated: !!rec.retEstimated, retNote: rec.retNote, retChecked: rec.retChecked };
    tally[rec.retSource] = (tally[rec.retSource] || 0) + 1;
  }
  fs.writeFileSync("injuries.json", JSON.stringify(inj));
  fs.writeFileSync("injury-returns-cache.json", JSON.stringify({
    _comment: "Written by injury-returns.mjs: every rostered injured player's derived return, with its source and the day it was looked up. A record, not an input — hand entries go in injury-returns.json.",
    generated: new Date().toISOString(), week, entries }, null, 1) + "\n");
  console.log(`injury-returns: ${Object.keys(entries).length} rostered injured · `
    + Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(" · "));
}

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (e) {
    console.warn(`injury-returns: skipped (${e.message}) — injuries.json and injury-returns-cache.json left as they were.`);
  }
  process.exit(0);
}

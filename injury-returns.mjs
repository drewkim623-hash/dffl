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
 * included), retWeeksList (exact out weeks, from a weeks_list with a gap),
 * retSource, retEstimated, retNote, retChecked.
 */

/** weeks from the coming one; "ros" = the rest of the regular season. */
export const RETURN_DEFAULTS = {
  Questionable: { weeks: 1 }, Doubtful: { weeks: 1 },
  Out: { weeks: 1 }, Sus: { weeks: 1 }, NA: { weeks: 1 }, DNR: { weeks: 1 }, COV: { weeks: 1 },
  // IR / PUP with nothing else known: the NFL minimum stint, 4 games.
  IR: { weeks: 4, label: "IR minimum 4 weeks" }, PUP: { weeks: 4, label: "PUP minimum 4 weeks" },
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
  if ((m = t.match(/season[- ]ending|(?:out|miss|sidelined|done) for the (?:rest of the |remainder of the )?(?:\d{4} )?(?:regular )?(?:season|year)|(?:miss|out for) the (?:rest|remainder) of the (?:\d{4} )?(?:regular )?season|done for (?:the )?(?:\d{4}|year|season)|\b(?:torn|tore (?:his |an? )?)\s?(?:left |right )?ACL\b|\bACL (?:tear|reconstruction)/i))) {
    return { weeks: SEASON, phrase: m[0] };
  }
  if ((m = t.match(/\b(?:out (?:until|through)|expected back (?:in|for|by)|(?:expected|projected|targeting|aiming) to return (?:in|for|by)|return (?:in|for) Week)\s*Week (\d+)/i))
    || (m = t.match(/\breturn (?:in|for) Week (\d+)/i))) return { untilWeek: Number(m[1]), phrase: m[0] };
  // Eligible to come off IR now, or his practice window is open: the coming week.
  if ((m = t.match(/\beligible (?:for activation|to (?:be activated|return|come off)(?: (?:from )?(?:injured reserve|IR))?)[^.]{0,30}?\b(this week|Week (\d+))/i))) {
    return m[2] ? { untilWeek: Number(m[2]), phrase: m[0] } : { weeks: 1, phrase: m[0] };
  }
  if ((m = t.match(/designated (?:\w+ )?to return|practice window (?:has been |was |is )?open(?:ed)?|opened (?:his |the )?(?:21-day )?practice window/i))) {
    return { weeks: 1, phrase: m[0] };
  }
  if ((m = t.match(new RegExp(`\\bmiss(?:ing)?\\b[^.]{0,25}?\\b${N}(?:\\s*(?:-|–|to|or)\\s*${N})?\\s*(?:more\\s+)?(?:weeks?|games?)\\b`, "i")))) {
    const hi = Math.max(num(m[1]), m[2] ? num(m[2]) : 0);
    if (hi > 0) return { weeks: hi, phrase: m[0] };
  }
  if ((m = t.match(/placed (?:\w+ )?on (?:injured reserve|IR)\b|(?:moved|lands?|landed|goes|going|headed) (?:\w+ )?(?:on|to) (?:injured reserve|IR)\b/i))) {
    return { weeks: 4, phrase: m[0] };
  }
  if ((m = t.match(/week[- ]to[- ]week/i))) return { weeks: 2, phrase: m[0] };
  // A bare range: "a 4-6 week recovery", "two to four weeks".
  if ((m = t.match(new RegExp(`\\b${N}\\s*(?:-|–|to)\\s*${N}[- ]weeks?\\b`, "i")))) {
    const hi = Math.max(num(m[1]), num(m[2]));
    if (hi > 0) return { weeks: hi, phrase: m[0] };
  }
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
export function resolveReturn({ rec, notes = [], sleeperNotes = [], report = null, week, lastReg = 14, sundayOf = null, byes = null, today }) {
  const retChecked = today || new Date().toISOString().slice(0, 10);
  // A hand entry: { ret } or { weeks }, from the team ("team") or a report ("report").
  // unit "games" (the injury audit): games he misses, his club's bye weeks not
  // counted, turned into the fantasy weeks the odds walk (a bye inside the span
  // is an out week that costs 0 anyway, so nothing is skipped twice). 0 games =
  // back this week: a return date of this week's Sunday, so no week is out.
  const weeksOf = e => {
    // weeks_list: the exact fantasy weeks out ([] = not out); wins over weeks/unit.
    // Contiguous from this week -> a return date (the Sunday after the last one);
    // with a gap -> retWeeksList, which the odds and PTS_LOST charge week by week.
    if (Array.isArray(e.weeks_list)) {
      const ws = [...new Set(e.weeks_list.map(Number))].filter(w => !(week > 0) || w >= week).sort((a, b) => a - b);
      if (!ws.length) return sundayOf && week > 0 && sundayOf(week) ? { ret: sundayOf(week) } : { retWeeks: 0 };
      const last = ws[ws.length - 1];
      if (week > 0 && ws.every((w, i) => w === week + i)) {
        const sun = sundayOf && sundayOf(last + 1);
        return sun ? { ret: sun } : { retWeeks: last - week + 1 };
      }
      return { retWeeks: ws.length, retWeeksList: ws };
    }
    if (e.weeks === "season") return { retWeeks: SEASON };
    const g = Number(e.weeks);
    if (e.unit !== "games" || !(week > 0)) return { retWeeks: g };
    if (g <= 0) return sundayOf && sundayOf(week) ? { ret: sundayOf(week) } : { retWeeks: 0 };
    const off = w => !!(rec.t && byes && (byes[w] || []).includes(rec.t));
    let w = week, left = g;
    while (left > 0 && w < week + 30) { if (!off(w)) left--; w++; }
    return { retWeeks: w - week };
  };
  const fromEntry = (e, retSource, estimated) => ({
    ...(e.ret && !Array.isArray(e.weeks_list) ? { ret: e.ret } : weeksOf(e)),
    retSource, retEstimated: estimated,
    ...(e.flag || /\bflag (\w+)/i.test(e.note || "") ? { retFlag: e.flag || e.note.match(/\bflag (\w+)/i)[1] } : {}),
    retNote: [e.source, e.note].filter(Boolean).join(" — ") || retSource, retChecked: e.checked || retChecked,
  });
  const has = e => e && (e.ret || e.weeks != null || Array.isArray(e.weeks_list));
  // Staleness guard for hand entries. The week an entry was checked is the first
  // fantasy week whose Sunday is on or after `checked`; its return week is that
  // plus its weeks (unit "games": plus his club's byes inside the span), or the
  // week of its `ret` date. Once the return week is here or past (and the entry
  // was checked in an earlier week — a same-week "back this week" holds), or Sleeper no
  // longer lists him as injured, the entry is ignored and the normal chain runs.
  // A live entry's out weeks are re-counted from today's week, not from `checked`.
  const sundays = sundayOf ? Array.from({ length: 30 }, (_, i) => [i + 1, sundayOf(i + 1)]).filter(x => x[1]) : [];
  const weekOfDate = d => { const hit = sundays.find(([, sun]) => sun >= d); return hit ? hit[0] : null; };
  let ignored = null;
  const live = e => {
    if (!has(e)) return null;
    const tag = `${e.kind || "report"} entry checked ${e.checked || "?"}`;
    if (!rec.s) { ignored = `${tag} ignored: no longer injured in Sleeper`; return null; }
    if (!(week > 0) || !sundays.length) return e;
    // weeks_list: stale once every listed week is before this one (and it was
    // checked in an earlier week); [] counts as all past.
    if (Array.isArray(e.weeks_list)) {
      const cw = (e.checked && weekOfDate(e.checked)) || week;
      if (e.weeks_list.every(w => Number(w) < week) && cw < week) {
        ignored = `${tag} ignored: weeks_list [${e.weeks_list.join(",")}] has passed`; return null;
      }
      return e;
    }
    if (e.ret) {
      const rw = weekOfDate(e.ret);
      const cw = (e.checked && weekOfDate(e.checked)) || week;
      if (rw != null && rw <= week && cw < week) { ignored = `${tag} ignored: return ${e.ret} (wk ${rw}) has passed`; return null; }
      return e;
    }
    if (e.weeks === "season") return e;
    const from = (e.checked && weekOfDate(e.checked)) || week;
    const off = w => !!(e.unit === "games" && rec.t && byes && (byes[w] || []).includes(rec.t));
    let w = from, left = Number(e.weeks);
    while (left > 0 && w < from + 30) { if (!off(w)) left--; w++; }
    if (w <= week && from < week) { ignored = `${tag} ignored: return wk ${w} has passed`; return null; }
    return { ...e, unit: undefined, weeks: w - week };
  };
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
  const entry = report ? live(report) : null;
  const withIgnored = r => (ignored ? { ...r, retNote: `${r.retNote} (${ignored})` } : r);
  if (entry && entry.kind === "team") return fromEntry(entry, "team", false);
  // 2. Sleeper outlook/news. Sleeper exposes none today: players/nfl carries only
  //    injury_notes (the injury type — "Sprain", "Fracture"), practice_description
  //    is empty and there is no news endpoint. The hook stays for if it ever does.
  const sl = fromProse(sleeperNotes, "sleeper-outlook");
  if (sl) return withIgnored(sl);
  // 3. Online reports: ESPN's date, then ESPN's prose, then a hand-curated report.
  // A curated report (injury-returns.json kind "report", e.g. the injury audit)
  // overrides ESPN's date, the prose parser and the defaults.
  if (entry && entry.kind !== "team") return fromEntry(entry, "report", !entry.ret);
  if (rec.ret) return withIgnored({ ret: rec.ret, retSource: "espn-return-date", retEstimated: false, retNote: "ESPN return date", retChecked });
  const es = fromProse(notes, "espn-outlook");
  if (es) return withIgnored(es);
  // 4. Defaults. A season-length injury type on IR (Sleeper's body part, e.g.
  //    "Knee - ACL") with nothing more specific: the rest of the season.
  const bp = `${rec.bp || ""} ${rec.sev || ""}`;
  if (/^(IR|PUP)$/.test(rec.s || "") && /\bACL\b|Achilles/i.test(bp)) return withIgnored({
    retWeeks: SEASON, retSource: "default", retEstimated: true,
    retNote: `default: ${rec.s} with ${bp.trim()} = rest of season`, retChecked });
  // RETURN_DEFAULTS.
  const d = RETURN_DEFAULTS[rec.s] || { weeks: 1 };
  return withIgnored({
    retWeeks: d.weeks === "ros" ? (week != null ? Math.max(1, lastReg - week + 1) : SEASON) : d.weeks,
    retSource: "default", retEstimated: true,
    retNote: d.label ? `default: ${d.label}` : d.weeks === "ros" ? `default: ${rec.s} = rest of regular season` : `default: ${rec.s} = coming week only`,
    retChecked,
  });
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
const FIELDS = ["ret", "retWeeks", "retWeeksList", "retSource", "retEstimated", "retNote", "retChecked", "retFlag"];
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
        report: reports[pid] || null, week, lastReg, sundayOf, byes: proj.byes || null, today });
    if (r.ret == null) delete rec.ret; // a report in weeks replaces ESPN's date
    for (const f of FIELDS) if (r[f] != null) rec[f] = r[f];
    entries[pid] = { n: rec.n, s: rec.s, ret: rec.ret || null, retWeeks: rec.retWeeks ?? null,
      ...(rec.retWeeksList ? { retWeeksList: rec.retWeeksList } : {}), retSource: rec.retSource,
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

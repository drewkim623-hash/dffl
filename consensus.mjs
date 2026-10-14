#!/usr/bin/env node
/**
 * Injury return consensus — `node consensus.mjs`, before build-injuries.mjs and
 * injury-returns.mjs. Node 20, no deps, no API keys.
 *
 * For every rostered injured DFFL player and every week from the current one
 * (data/projections.json current_week) through Week 17 it decides out / in /
 * bye, then rewrites his injury-returns.json entry (weeks_list, weeks, note,
 * flag) for injury-returns.mjs to read. verify.mjs imports decideWeek().
 *
 * Signals:
 *   props     ESPN core API propBets, DraftKings (provider 100); current week
 *             only, and only for games with at least PROPS_MIN props posted.
 *             Listed = in, not listed = out.
 *   sleeper   Sleeper PPR projection: < OUT_PTS = out, else in.
 *   espn      ESPN fantasy projection, same thresholds.
 *   Sleeper and ESPN projections together are ONE vote (they share the same
 *   injury blind spot): in if either says in, out only if both say out.
 *   A player who projects under STARTER_PTS every week casts no vote.
 *
 * Rules (decideWeek):
 *   current week  props and the projection vote agree -> that; they disagree ->
 *                 the audit (the existing injury-returns.json entry) breaks the
 *                 tie and the player is flagged "uncertain"; one missing -> audit.
 *   later weeks   the audit holds unless BOTH Sleeper and ESPN project him out.
 *   bye           his club is not on that week's ESPN scoreboard: never out.
 *
 * Every fetch is cached in data/consensus-cache/. A failed fetch falls back to
 * that cache and the run is marked stale ("stale: <key>"); no cache = the
 * signal is missing. Without Sleeper's player file the injured list and names
 * come from injuries.json / rosters.json. A run on stale data only, or one
 * that moves no weeks_list / weeks, writes nothing. The script always exits 0.
 *
 * Options: --league ID  --audit path  --cache dir  --from W  --to W  --dry-run
 * URL overrides (verify.mjs points them at a dead port): CONSENSUS_SLEEPER_API,
 * CONSENSUS_SLEEPER_PROJ, CONSENSUS_ESPN_SITE, CONSENSUS_ESPN_CORE,
 * CONSENSUS_ESPN_FANTASY; CONSENSUS_TIMEOUT_MS (default 20000).
 */

export const OUT_PTS = 1, STARTER_PTS = 3, PROPS_MIN = 100;

/** Sleeper + ESPN projections as one vote: "in" | "out" | null. */
export function projectionVote(sleeper, espn) {
  if (sleeper === "in" || espn === "in") return "in";
  if (sleeper === "out" && espn === "out") return "out";
  return null;
}

/** A projection as a signal: null when he never projects like a starter or has no line. */
export const projSignal = (pts, maxPts) => (maxPts < STARTER_PTS || pts == null ? null : pts < OUT_PTS ? "out" : "in");

/**
 * One player-week. Pure.
 *   decideWeek({ current, props, sleeper, espn, auditOut, bye })
 *     -> { decision: "out" | "in" | "bye", basis, uncertain, vote }
 */
export function decideWeek({ current = false, props = null, sleeper = null, espn = null, auditOut = false, bye = false }) {
  const vote = projectionVote(sleeper, espn);
  const audit = auditOut ? "out" : "in";
  if (bye) return { decision: "bye", basis: "bye", uncertain: false, vote };
  if (current) {
    if (props && vote && props === vote) return { decision: vote, basis: "consensus", uncertain: false, vote };
    if (props && vote) return { decision: audit, basis: "audit-tiebreak", uncertain: true, vote };
    return { decision: audit, basis: "audit", uncertain: false, vote };
  }
  if (sleeper === "out" && espn === "out") return { decision: "out", basis: "both-projections-out", uncertain: false, vote };
  return { decision: audit, basis: "audit", uncertain: false, vote };
}

/** The weeks an audit entry has him out, within FROM..TO. */
export function auditWeeks(e, from, to) {
  const range = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  if (!e) return [];
  if (Array.isArray(e.weeks_list)) return e.weeks_list.map(Number).filter(w => w >= from && w <= to);
  if (e.weeks === "season") return range;
  return range.slice(0, Math.max(0, Number(e.weeks) || 0));
}

/* ------------------------------------------------------------------ the CLI */
async function main() {
  const fs = await import("node:fs"), path = await import("node:path");
  const argv = process.argv.slice(2), arg = (k, d) => { const i = argv.indexOf(k); return i < 0 ? d : argv[i + 1]; };
  const read = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch (e) { return d; } };
  const env = (k, d) => process.env[k] || d;
  const SL = env("CONSENSUS_SLEEPER_API", "https://api.sleeper.app/v1");
  const SLP = env("CONSENSUS_SLEEPER_PROJ", "https://api.sleeper.app/projections");
  const SITE = env("CONSENSUS_ESPN_SITE", "https://site.api.espn.com");
  const CORE = env("CONSENSUS_ESPN_CORE", "https://sports.core.api.espn.com");
  const FAN = env("CONSENSUS_ESPN_FANTASY", "https://lm-api-reads.fantasy.espn.com");
  const TIMEOUT = Number(env("CONSENSUS_TIMEOUT_MS", 20000));

  const LEAGUE = arg("--league", "1318040218183417856");
  const AUDIT = arg("--audit", "injury-returns.json");
  const CACHE = arg("--cache", path.join("data", "consensus-cache"));
  const DRY = argv.includes("--dry-run");
  const proj = read(path.join("data", "projections.json"), {});
  const FROM = Number(arg("--from", proj.current_week || 1)), TO = Number(arg("--to", 17));
  const SEASON = String(arg("--season", proj.season || "2026"));
  const today = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(CACHE, { recursive: true });

  // Fetch with one retry; on failure the cached copy, marked stale. `slim`
  // trims a response before it is cached, so the cache stays small enough to commit.
  const stale = [];
  let fresh = 0;
  const get = async (url, key, opts = {}) => {
    const f = path.join(CACHE, key.replace(/[^\w.-]/g, "_") + ".json");
    for (let t = 0; t < 2; t++) {
      try {
        const r = await fetch(url, { headers: opts.headers, signal: AbortSignal.timeout(TIMEOUT) });
        if (r.status === 404 && opts.allow404) { fresh++; return null; }
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        fresh++;
        fs.writeFileSync(f, JSON.stringify(opts.slim ? opts.slim(j) : j));
        return j;
      } catch (e) { /* retry once, then the cache */ }
    }
    if (fs.existsSync(f)) { stale.push(key); console.log(`stale: ${key}`); return read(f, null); }
    stale.push(`${key} (no cache)`); console.log(`stale: ${key} (no cache)`);
    return null;
  };

  const range = Array.from({ length: TO - FROM + 1 }, (_, i) => FROM + i);
  const abbr = a => ({ WSH: "WAS", JAC: "JAX" }[a] || a);
  const norm = n => String(n || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/[^a-z]/g, "");
  const INJ = new Set(["Questionable", "Doubtful", "Out", "IR", "PUP", "Sus", "NA", "COV"]);

  // The league: rosters and managers.
  const rosters = await get(`${SL}/league/${LEAGUE}/rosters`, "dffl-rosters") || [];
  const users = await get(`${SL}/league/${LEAGUE}/users`, "dffl-users") || [];
  const U = Object.fromEntries(users.map(u => [u.user_id, u.display_name]));
  const owner = {};
  for (const r of rosters) for (const p of r.players || []) owner[p] = U[r.owner_id] || "?";
  const repo = read("rosters.json", {}).map || {};
  for (const p of Object.keys(repo)) if (!owner[p]) owner[p] = "?";

  // Who: Sleeper's player file (cached trimmed to rostered players), else the repo's snapshots.
  const slim = o => Object.fromEntries(Object.keys(owner).filter(p => o[p]).map(p => {
    const x = o[p]; return [p, { full_name: x.full_name, team: x.team, position: x.position, injury_status: x.injury_status, espn_id: x.espn_id }];
  }));
  const sleeperPlayers = await get(`${SL}/players/nfl`, "sleeper-players", { slim });
  const inj = read("injuries.json", {}).map || {};
  const info = p => {
    const s = sleeperPlayers && sleeperPlayers[p];
    if (s) return { name: s.full_name, team: s.team, status: s.injury_status, espnId: s.espn_id ? String(s.espn_id) : null };
    const r = inj[p] || {}, q = repo[p] || {};
    return { name: r.n || q.n || p, team: r.t || q.t || null, status: r.s || q.s || null, espnId: null };
  };
  const hurt = Object.keys(owner).filter(p => INJ.has(info(p).status));

  // Schedule: who plays each week (byes) and the current week's games.
  const plays = {}, events = {}, teamGame = {};
  for (const w of range) {
    const sb = await get(`${SITE}/apis/site/v2/sports/football/nfl/scoreboard?dates=${SEASON}&seasontype=2&week=${w}`, `scoreboard-${w}`, {
      slim: j => ({ events: (j.events || []).map(e => ({ id: e.id, competitions: [{ competitors: e.competitions[0].competitors.map(c => ({ team: { abbreviation: c.team.abbreviation } })) }] })) }),
    });
    plays[w] = new Set(); events[w] = [];
    for (const e of (sb && sb.events) || []) {
      events[w].push(e.id);
      for (const c of e.competitions[0].competitors) {
        plays[w].add(abbr(c.team.abbreviation));
        if (w === FROM) teamGame[abbr(c.team.abbreviation)] = e.id;
      }
    }
  }
  const hasSched = w => plays[w].size >= 20;

  // Sleeper projections.
  const slProj = {};
  for (const w of range) {
    slProj[w] = {};
    for (const pos of ["QB", "RB", "WR", "TE"]) {
      const a = await get(`${SLP}/nfl/${SEASON}/${w}?season_type=regular&position[]=${pos}`, `sleeper-proj-${w}-${pos}`,
        { slim: a => a.map(p => ({ player_id: p.player_id, stats: { pts_ppr: p.stats && p.stats.pts_ppr } })) }) || [];
      for (const p of a) if (p.player_id) slProj[w][p.player_id] = (p.stats && p.stats.pts_ppr) ?? 0;
    }
  }

  // ESPN ids: Sleeper's espn_id, else ESPN's injury feed by name (cached trimmed).
  const feed = await get(`${SITE}/apis/site/v2/sports/football/nfl/injuries`, "espn-injuries", {
    slim: j => ({ injuries: (j.injuries || []).map(t => ({ injuries: (t.injuries || []).map(i => ({
      athlete: { displayName: i.athlete && i.athlete.displayName, links: [{ href: i.athlete && i.athlete.links && i.athlete.links[0] && i.athlete.links[0].href }] },
      details: { returnDate: i.details && i.details.returnDate }, shortComment: i.shortComment, date: i.date })) })) }),
  });
  const feedId = {}, feedById = {};
  for (const t of (feed && feed.injuries) || []) for (const i of t.injuries || []) {
    const m = /\/id\/(\d+)/.exec((i.athlete && i.athlete.links && i.athlete.links[0] && i.athlete.links[0].href) || "");
    if (m) { feedId[norm(i.athlete.displayName)] = m[1]; feedById[m[1]] = i; }
  }
  const espnIdOf = p => info(p).espnId || feedId[norm(info(p).name)] || null;

  // Props: the current week only (books post one week ahead).
  const propAth = new Set(), propGames = new Set();
  for (const ev of events[FROM] || []) {
    const base = `${CORE}/v2/sports/football/leagues/nfl/events/${ev}/competitions/${ev}/odds/100/propBets?limit=1000`;
    const slimProps = j => ({ count: j.count, pageCount: j.pageCount, items: (j.items || []).map(i => ({ athlete: { $ref: i.athlete && i.athlete.$ref } })) });
    const j = await get(base, `props-${ev}`, { allow404: true, slim: slimProps });
    if (!j || (j.count || 0) < PROPS_MIN) continue;
    let items = j.items || [];
    for (let pg = 2; pg <= (j.pageCount || 1); pg++) items = items.concat(((await get(`${base}&page=${pg}`, `props-${ev}-${pg}`, { slim: slimProps })) || {}).items || []);
    propGames.add(ev);
    for (const i of items) { const m = /athletes\/(\d+)/.exec((i.athlete && i.athlete.$ref) || ""); if (m) propAth.add(m[1]); }
  }

  // ESPN fantasy projections for the injured (cached trimmed to the projections).
  const espnIds = [...new Set(hurt.map(espnIdOf).filter(Boolean))].map(Number);
  const kona = espnIds.length ? await get(`${FAN}/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leaguedefaults/3?view=kona_player_info`, "espn-kona-injured", {
    headers: { "X-Fantasy-Filter": JSON.stringify({ players: { filterIds: { value: espnIds } } }) },
    slim: j => ({ players: (j.players || []).map(p => ({ player: { id: p.player.id, injuryStatus: p.player.injuryStatus,
      stats: (p.player.stats || []).filter(s => s.statSourceId === 1 && s.statSplitTypeId === 1 && String(s.seasonId) === SEASON)
        .map(s => ({ statSourceId: 1, statSplitTypeId: 1, seasonId: s.seasonId, scoringPeriodId: s.scoringPeriodId, appliedTotal: s.appliedTotal })) } })) }),
  }) : null;
  const espn = {};
  for (const p of (kona && kona.players) || []) {
    const pl = p.player, wk = {};
    for (const s of pl.stats || []) if (s.statSourceId === 1 && s.statSplitTypeId === 1 && String(s.seasonId) === SEASON) wk[s.scoringPeriodId] = s.appliedTotal || 0;
    espn[pl.id] = { status: pl.injuryStatus, wk };
  }

  // Decide.
  const auditFile = read(AUDIT, { entries: {} });
  const audit = auditFile.entries || (auditFile.entries = {});
  // What counts as a change worth writing: an entry's weeks_list or weeks.
  const substance = () => JSON.stringify(Object.entries(audit).map(([p, e]) => [p, e.weeks_list ?? null, e.weeks ?? null]));
  const before = substance();
  const players = [];
  for (const pid of hurt) {
    const me = info(pid), eid = espnIdOf(pid), ae = audit[pid];
    const aW = auditWeeks(ae, FROM, TO);
    const slMax = Math.max(0, ...range.map(w => slProj[w][pid] || 0));
    const esMax = Math.max(0, ...Object.values((espn[eid] || {}).wk || {}));
    const weeks = range.map(w => {
      const bye = !!(me.team && hasSched(w) && !plays[w].has(me.team));
      const sleeper = projSignal(slProj[w][pid], slMax);
      const es = projSignal(eid && espn[eid] ? espn[eid].wk[w] : undefined, esMax);
      const props = w === FROM && eid && propGames.has(teamGame[me.team]) ? (propAth.has(String(eid)) ? "in" : "out") : null;
      return { week: w, ...decideWeek({ current: w === FROM, props, sleeper, espn: es, auditOut: aW.includes(w), bye }), props, sleeper, espn: es };
    });
    const out = weeks.filter(x => x.decision === "out").map(x => x.week);
    const byes = new Set(weeks.filter(x => x.decision === "bye").map(x => x.week));
    const changed = JSON.stringify(out) !== JSON.stringify(aW.filter(w => !byes.has(w)));
    const tie = weeks.filter(x => x.uncertain).map(x => x.week);
    players.push({ player_id: pid, player: me.name, team: me.team, manager: owner[pid], status: me.status, espn_id: eid,
      weeks_out: out, audit_weeks: aW, changed, flag: tie.length ? "uncertain" : "consensus", tiebreak_weeks: tie, weeks });

    // The entry: a new one only when the signals put him out; an unchanged one
    // keeps its weeks_list and checked date (so the stale guard still sees it age).
    if (!ae && !out.length) continue;
    const e = ae || { kind: "report", source: "consensus.mjs" };
    if (changed || !ae) {
      e.weeks_list = out;
      e.weeks = out.includes(TO) && out.length >= TO - FROM - 2 ? "season" : out.length;
      delete e.unit; delete e.ret;
      e.checked = today;
    }
    // On stale data a missing signal is no evidence: an earlier flag stands.
    const was = e.flag || (/Consensus:[^;]*; (uncertain|consensus)/.exec(e.note || "") || [])[1];
    e.flag = tie.length ? "uncertain" : stale.length && was ? was : "consensus";
    e.note = `${String(e.note || "").replace(/\s*Consensus:.*$/, "")} Consensus: ${changed ? "changed from audit " + JSON.stringify(aW) : "matches audit"}; ${e.flag}${tie.length ? " (audit tiebreak wk " + tie.join(",") + ")" : ""}${stale.length ? "; stale data" : ""}.`.trim();
    audit[pid] = e;
  }

  // Only stale data (every fetch fell back to the cache), or no weeks_list /
  // weeks moved: write nothing, so a dead-feed run is not a noise commit.
  const idle = !fresh || substance() === before;
  if (idle) console.log("consensus: stale/no change, nothing written");
  if (!DRY && !idle) {
    fs.writeFileSync(AUDIT, JSON.stringify(auditFile, null, 2) + "\n");
    fs.writeFileSync(path.join("data", "consensus.json"), JSON.stringify({
      generated: new Date().toISOString(), league: LEAGUE, weeks: [FROM, TO], stale,
      props: { source: "ESPN core API propBets, provider 100 (DraftKings)", week: FROM, gamesWithProps: [...propGames] }, players }) + "\n");
  }
  console.log(`consensus: ${players.length} injured · ${players.filter(p => p.flag === "consensus").length} consensus · `
    + `${players.filter(p => p.changed).length} changed · ${players.filter(p => p.flag === "uncertain").length} uncertain · `
    + `props games ${propGames.size} of ${(events[FROM] || []).length}${stale.length ? ` · ${stale.length} stale` : ""}${DRY ? " (dry run)" : ""}`);
}

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch (e) { console.warn(`consensus: skipped (${e.message}) — injury-returns.json left as it was.`); }
  process.exit(0);
}

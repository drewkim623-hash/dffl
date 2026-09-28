/**
 * Is a week really over? The one question build-week.mjs has to get right
 * before it moves data/latest.json forward.
 *
 * "Over" means two things, and both have to be true:
 *
 *   1. every NFL game Sleeper lists for that week is complete, and
 *   2. every league matchup that week has points recorded.
 *
 * Sleeper's own signal — state.week moving on — is not good enough on its
 * own. On Monday 21 September 2026 every week 2 game was final at 23:40 ET and
 * state.week still read 2 at midnight; it had moved to 3 by the 07:00 ET run.
 * So the Tuesday build cannot wait for Sleeper to flip, and it cannot trust a
 * flip either. It looks at the games and the scores instead.
 *
 * Game status comes from https://api.sleeper.app/schedule/nfl/regular/<season>
 * — undocumented, but the site's live board and build-pulse.mjs already read
 * it. Each game is {week, status, home, away, date, game_id}, and the statuses
 * seen are "pre_game", "in_game", "complete" and "canceled". A canceled game is
 * never going to be played (2026 week 6 has one), so it does not hold the week
 * open; anything else that is not "complete" does, including statuses nobody
 * has seen yet. When in doubt, the week is not over.
 *
 * Points: while a week is still the one Sleeper calls current, 0 (or null)
 * means "not scored yet" — that is what every matchup reads before kickoff.
 * Once Sleeper has moved past the week and all its games are done, any finite
 * number counts, 0 and negatives included: an empty lineup or a brutal week
 * is a real result, and treating it as unscored would stall the week forever.
 * null, missing or non-numeric points never count.
 *
 * Pure: no network, no files, nothing at import time. build-week.mjs does the
 * fetching; test-week-final.mjs covers the cases.
 */

const DONE = new Set(["complete", "canceled", "cancelled"]);

/**
 * @param {object} p
 * @param {number} p.week                 the week in question
 * @param {Array}  p.schedule             Sleeper's regular-season schedule (all weeks)
 * @param {Array}  p.matchups             /league/<id>/matchups/<week>
 * @param {number} [p.stateWeek]          Sleeper's state.week, if known
 * @returns {{final: boolean, past: boolean, reason: string, nfl: object, league: object}}
 */
export function weekFinality({ week, schedule, matchups, stateWeek }) {
  const w = Number(week);
  const sw = stateWeek === null || stateWeek === undefined || stateWeek === "" ? NaN : Number(stateWeek);
  const games = (Array.isArray(schedule) ? schedule : []).filter(g => g && Number(g.week) === w);
  const pending = games.filter(g => !DONE.has(String(g.status)));
  const nfl = {
    games: games.length,
    complete: games.filter(g => g.status === "complete").length,
    canceled: games.filter(g => g.status === "canceled" || g.status === "cancelled").length,
    pending: pending.map(g => `${g.away}@${g.home} ${g.status}`),
  };

  // Only entries with a matchup_id are games. A team with none (a playoff bye,
  // an eliminated team) is not waiting on anything.
  const entries = (Array.isArray(matchups) ? matchups : []).filter(e => e && e.matchup_id != null);
  // In the past: Sleeper has moved beyond the week and every game in it is done.
  const past = Number.isFinite(sw) && Number.isInteger(w) && sw > w && games.length > 0 && pending.length === 0;
  const numeric = e => e.points !== null && e.points !== undefined && e.points !== ""
    && typeof e.points !== "boolean" && Number.isFinite(Number(e.points));
  const scored = e => numeric(e) && (past || Number(e.points) > 0);
  const unscored = entries.filter(e => !scored(e));
  const league = {
    entries: entries.length,
    scored: entries.length - unscored.length,
    unscored: unscored.map(e => `roster ${e.roster_id} (${e.points === undefined ? "no points" : e.points})`),
  };

  const out = (final, reason) => ({ final, past, reason, nfl, league });
  if (!Number.isInteger(w) || w < 1) return out(false, `week ${week} is not a real week`);
  if (!games.length) return out(false, `Sleeper's schedule lists no NFL games for week ${w}`);
  if (pending.length) return out(false, `${pending.length} of ${games.length} NFL games in week ${w} are not complete: ${nfl.pending.join(", ")}`);
  if (!entries.length) return out(false, `the league has no matchups for week ${w}`);
  // In the current week, zero counts as unrecorded: a matchup Sleeper has not
  // scored yet reads 0 all the time. Once the week is past, only non-numbers do.
  if (unscored.length) return out(false, `${unscored.length} of ${entries.length} league matchup entries in week ${w} have no points: ${league.unscored.join(", ")}`);
  return out(true, `all ${games.length} NFL games in week ${w} are over and all ${entries.length} league entries are scored`);
}

/**
 * Which week to build when nobody forced one.
 *
 * If the week Sleeper calls current is already over (the Monday-night-to-
 * Tuesday-morning gap before Sleeper flips), build that one. Otherwise build
 * the week before it, which is the old rule and still right once Sleeper has
 * moved on.
 */
export function chooseTargetWeek({ stateWeek, stateWeekFinal }) {
  const w = Number(stateWeek);
  if (!Number.isFinite(w)) return null;
  return stateWeekFinal ? w : w - 1;
}

/**
 * The new data/latest.json. Only adds to what was there — season, week, file
 * and generated keep their meaning, because the routine and the workflow's
 * commit message read them.
 *
 * `week` and `season` at the top level are the finished week this points at.
 * Sleeper's own state lives under `sleeper_state`, as it read when the file
 * was written, because the routine that sends the email cannot reach Sleeper
 * and has to judge "which week" from this file alone. `generated_at` is what
 * a freshness check reads: file mtimes in a git checkout mean nothing.
 */
export function buildLatest({ season, week, file, generatedAt, state, final, finality }) {
  return {
    _comment: "Points at the most recently finished week written by build-week.mjs. "
      + "sleeper_state is Sleeper's /state/nfl as read at generated_at; final is true only when every "
      + "NFL game that week is complete and every league matchup has points.",
    season: String(season),
    week: Number(week),
    file,
    generated: generatedAt,
    generated_at: generatedAt,
    final: final === true,
    sleeper_state: {
      week: numOrNull(state && state.week),
      leg: numOrNull(state && state.leg),
      display_week: numOrNull(state && state.display_week),
      season_type: (state && state.season_type) || null,
      season: state && state.season != null ? String(state.season) : null,
    },
    ...(finality ? { finality } : {}),
  };
}

function numOrNull(v) {
  const n = Number(v);
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n;
}

const round2 = n => Math.round(n * 100) / 100;

/**
 * Fold a finished week into standings that are exactly one week behind.
 *
 * Sleeper posts a week into the team records when it flips state.week, not
 * when the last game ends, so a week built in that gap carries standings one
 * game short. When — and only when — that is plainly what happened, add the
 * week's results: every team one game behind, every team in exactly one game
 * this week, not a playoff week, and no league-median game (which Sleeper
 * scores as a second result nobody here can see). Anything else is left
 * exactly as Sleeper had it.
 *
 * @returns {{standings: Array, through: number, folded: boolean, reason: string}}
 */
export function foldWeekIntoStandings({ standings, games, week, isPlayoffs = false, medianMatch = false }) {
  const rows = (Array.isArray(standings) ? standings : []).map(s => ({ ...s }));
  const played = s => (Number(s.wins) || 0) + (Number(s.losses) || 0) + (Number(s.ties) || 0);
  const through = rows.length ? Math.max(...rows.map(played)) : 0;
  const w = Number(week);
  const keep = reason => ({ standings: rows, through, folded: false, reason });

  if (!rows.length) return keep("no standings");
  if (through >= w) return keep(`standings already run through week ${through}`);
  if (isPlayoffs) return keep("playoff weeks do not change the records");
  if (medianMatch) return keep("the league also plays the median, which only Sleeper can score");
  if (rows.some(s => played(s) !== w - 1)) return keep(`not every team is exactly one game behind week ${w}`);

  const byRid = new Map(rows.map(s => [s.roster_id, s]));
  const seen = new Map();
  for (const g of games || []) for (const sd of (g && g.sides) || []) seen.set(sd.roster_id, (seen.get(sd.roster_id) || 0) + 1);
  if (seen.size !== rows.length || rows.some(s => seen.get(s.roster_id) !== 1))
    return keep(`not every team has exactly one game in week ${w}`);
  const pts = sd => (sd.points === null || sd.points === undefined || sd.points === "" ? NaN : Number(sd.points));
  if ((games || []).some(g => g.sides.length !== 2 || !g.sides.every(sd => Number.isFinite(pts(sd)))))
    return keep(`a week ${w} game has no usable score`);

  for (const g of games) {
    const [a, b] = g.sides, A = byRid.get(a.roster_id), B = byRid.get(b.roster_id);
    const pa = pts(a), pb = pts(b);
    for (const r of [A, B]) { r.wins = Number(r.wins) || 0; r.losses = Number(r.losses) || 0; r.ties = Number(r.ties) || 0; }
    if (pa > pb) { A.wins++; B.losses++; } else if (pb > pa) { B.wins++; A.losses++; } else { A.ties++; B.ties++; }
    A.points_for = round2((Number(A.points_for) || 0) + pa); A.points_against = round2((Number(A.points_against) || 0) + pb);
    B.points_for = round2((Number(B.points_for) || 0) + pb); B.points_against = round2((Number(B.points_against) || 0) + pa);
  }
  rows.sort((x, y) => y.wins - x.wins || y.points_for - x.points_for);
  return { standings: rows, through: w, folded: true, reason: `week ${w} folded in from its games; Sleeper had not posted it yet` };
}

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
 * Pure: no network, no files, nothing at import time. build-week.mjs does the
 * fetching; test-week-final.mjs covers the cases.
 */

const DONE = new Set(["complete", "canceled", "cancelled"]);

/**
 * @param {object} p
 * @param {number} p.week                 the week in question
 * @param {Array}  p.schedule             Sleeper's regular-season schedule (all weeks)
 * @param {Array}  p.matchups             /league/<id>/matchups/<week>
 * @returns {{final: boolean, reason: string, nfl: object, league: object}}
 */
export function weekFinality({ week, schedule, matchups }) {
  const w = Number(week);
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
  const scored = e => e.points !== null && e.points !== undefined && e.points !== ""
    && Number.isFinite(Number(e.points)) && Number(e.points) > 0;
  const unscored = entries.filter(e => !scored(e));
  const league = {
    entries: entries.length,
    scored: entries.length - unscored.length,
    unscored: unscored.map(e => `roster ${e.roster_id} (${e.points === undefined ? "no points" : e.points})`),
  };

  const out = (final, reason) => ({ final, reason, nfl, league });
  if (!Number.isInteger(w) || w < 1) return out(false, `week ${week} is not a real week`);
  if (!games.length) return out(false, `Sleeper's schedule lists no NFL games for week ${w}`);
  if (pending.length) return out(false, `${pending.length} of ${games.length} NFL games in week ${w} are not complete: ${nfl.pending.join(", ")}`);
  if (!entries.length) return out(false, `the league has no matchups for week ${w}`);
  // Zero counts as unrecorded. A full lineup that genuinely scores 0.00 does
  // not happen; a matchup Sleeper has not scored yet reads 0 all the time.
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

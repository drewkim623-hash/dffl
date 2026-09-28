/**
 * node --test test-week-final.mjs
 *
 * In-memory fixtures only: no network, no files. Shapes copied from what
 * Sleeper returned on 28 September 2026 — schedule games are
 * {status, date, home, week, game_id, away}; matchup entries carry
 * {roster_id, matchup_id, points, ...}.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { weekFinality, chooseTargetWeek, buildLatest, foldWeekIntoStandings } from "./week-final.mjs";

const game = (week, status, home = "KC", away = "DEN") => ({ status, date: "2026-09-28", home, week, game_id: `${week}${home}`, away });
// Two NFL games in week 3, a third in week 4 that must not count.
const sched = (...statuses) => [
  ...statuses.map((s, i) => game(3, s, `H${i}`, `A${i}`)),
  game(4, "pre_game", "X", "Y"),
];
const entry = (roster_id, matchup_id, points) => ({ roster_id, matchup_id, points, starters: [], players: [] });
const LEAGUE = [entry(1, 1, 120.5), entry(2, 1, 98.1), entry(3, 2, 101), entry(4, 2, 88.44)];

test("every game complete and every matchup scored is final", () => {
  const r = weekFinality({ week: 3, schedule: sched("complete", "complete"), matchups: LEAGUE });
  assert.equal(r.final, true, r.reason);
  assert.equal(r.nfl.games, 2);
  assert.equal(r.league.scored, 4);
});

test("one game in progress is not final", () => {
  const r = weekFinality({ week: 3, schedule: sched("complete", "in_game"), matchups: LEAGUE });
  assert.equal(r.final, false);
  assert.match(r.reason, /1 of 2 NFL games in week 3 are not complete/);
  assert.match(r.reason, /in_game/);
});

test("Monday night not yet kicked off (today's real shape) is not final", () => {
  const r = weekFinality({ week: 3, schedule: sched("complete", "pre_game"), matchups: LEAGUE });
  assert.equal(r.final, false);
  assert.match(r.reason, /pre_game/);
});

test("an unknown or postponed status holds the week open", () => {
  for (const s of ["postponed", "suspended", "delayed", undefined, null, ""]) {
    const r = weekFinality({ week: 3, schedule: sched("complete", s), matchups: LEAGUE });
    assert.equal(r.final, false, `status ${JSON.stringify(s)}`);
  }
});

test("a canceled game does not hold the week open", () => {
  const r = weekFinality({ week: 3, schedule: sched("complete", "canceled"), matchups: LEAGUE });
  assert.equal(r.final, true, r.reason);
  assert.equal(r.nfl.canceled, 1);
});

test("a matchup with 0 points is not final", () => {
  const m = [...LEAGUE.slice(0, 3), entry(4, 2, 0)];
  const r = weekFinality({ week: 3, schedule: sched("complete", "complete"), matchups: m });
  assert.equal(r.final, false);
  assert.match(r.reason, /1 of 4 league matchup entries in week 3 have no points/);
  assert.match(r.reason, /roster 4/);
});

test("null, missing or junk points are not final", () => {
  for (const p of [null, undefined, "", "abc", NaN, -3]) {
    const m = [...LEAGUE.slice(0, 3), entry(4, 2, p)];
    const r = weekFinality({ week: 3, schedule: sched("complete", "complete"), matchups: m });
    assert.equal(r.final, false, `points ${String(p)}`);
  }
});

test("points as numeric strings count", () => {
  const m = LEAGUE.map(e => ({ ...e, points: String(e.points) }));
  assert.equal(weekFinality({ week: 3, schedule: sched("complete"), matchups: m }).final, true);
});

test("a team with no matchup_id (playoff bye) is ignored, scored or not", () => {
  const m = [...LEAGUE, entry(5, null, 0), entry(6, undefined, null)];
  const r = weekFinality({ week: 3, schedule: sched("complete", "complete"), matchups: m });
  assert.equal(r.final, true, r.reason);
  assert.equal(r.league.entries, 4);
});

test("no league matchups at all is not final", () => {
  for (const m of [[], null, undefined, [entry(1, null, 0)]]) {
    const r = weekFinality({ week: 3, schedule: sched("complete"), matchups: m });
    assert.equal(r.final, false);
    assert.match(r.reason, /no matchups/);
  }
});

test("no NFL games listed for the week (bye, off-season, bad fetch) is not final", () => {
  for (const s of [[], null, undefined, [game(4, "complete")]]) {
    const r = weekFinality({ week: 3, schedule: s, matchups: LEAGUE });
    assert.equal(r.final, false);
    assert.match(r.reason, /lists no NFL games for week 3/);
  }
});

test("other weeks' games do not leak in, and week can be a string", () => {
  const s = [game(3, "complete"), game(2, "in_game"), game(4, "pre_game")];
  assert.equal(weekFinality({ week: "3", schedule: s, matchups: LEAGUE }).final, true);
  const s2 = [{ ...game(3, "complete"), week: "3" }];
  assert.equal(weekFinality({ week: 3, schedule: s2, matchups: LEAGUE }).final, true);
});

test("nonsense weeks are never final", () => {
  for (const w of [0, -1, 2.5, NaN, null, undefined, "abc"])
    assert.equal(weekFinality({ week: w, schedule: [game(w, "complete")], matchups: LEAGUE }).final, false, `week ${w}`);
});

test("chooseTargetWeek: current week if it is over, otherwise the one before", () => {
  assert.equal(chooseTargetWeek({ stateWeek: 3, stateWeekFinal: true }), 3);   // Monday night, Sleeper not flipped
  assert.equal(chooseTargetWeek({ stateWeek: 4, stateWeekFinal: false }), 3);  // Sleeper has flipped
  assert.equal(chooseTargetWeek({ stateWeek: 1, stateWeekFinal: false }), 0);  // nothing finished yet
  assert.equal(chooseTargetWeek({ stateWeek: "3", stateWeekFinal: false }), 2);
  assert.equal(chooseTargetWeek({ stateWeek: undefined, stateWeekFinal: false }), null);
});

test("buildLatest keeps the old fields and only adds", () => {
  const state = { week: 4, leg: 4, season: "2026", season_type: "regular", display_week: 4, league_season: "2026" };
  const at = "2026-09-29T04:31:02.000Z";
  const l = buildLatest({ season: "2026", week: 3, file: "data/week-2026-03.json", generatedAt: at, state, final: true });
  // What the routine and the workflow's commit message already read.
  assert.equal(l.season, "2026");
  assert.equal(l.week, 3);
  assert.equal(l.file, "data/week-2026-03.json");
  assert.equal(l.generated, at);
  assert.equal(typeof l._comment, "string");
  // What is new.
  assert.equal(l.generated_at, at);
  assert.match(l.generated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
  assert.equal(l.final, true);
  assert.deepEqual(l.sleeper_state, { week: 4, leg: 4, display_week: 4, season_type: "regular", season: "2026" });
});

test("buildLatest: final is strictly boolean, and missing state reads as null", () => {
  const l = buildLatest({ season: 2026, week: "3", file: "f", generatedAt: "x", state: null, final: "yes" });
  assert.equal(l.final, false);
  assert.equal(l.season, "2026");
  assert.equal(l.week, 3);
  assert.deepEqual(l.sleeper_state, { week: null, leg: null, display_week: null, season_type: null, season: null });
});

/* ------------------------------------------ a week Sleeper has moved past ---- */

test("past week: once Sleeper is beyond it and its games are done, 0 and negative scores count", () => {
  for (const p of [0, -4.2, "0", "-1.5"]) {
    const m = [...LEAGUE.slice(0, 3), entry(4, 2, p)];
    const r = weekFinality({ week: 3, schedule: sched("complete", "canceled"), matchups: m, stateWeek: 4 });
    assert.equal(r.final, true, `points ${JSON.stringify(p)}: ${r.reason}`);
    assert.equal(r.past, true);
  }
});

test("past week: null, missing or junk points still do not count", () => {
  for (const p of [null, undefined, "", "abc", NaN, true]) {
    const m = [...LEAGUE.slice(0, 3), entry(4, 2, p)];
    const r = weekFinality({ week: 3, schedule: sched("complete", "complete"), matchups: m, stateWeek: 4 });
    assert.equal(r.final, false, `points ${String(p)}`);
  }
});

test("current week: 0 is still unscored, whether stateWeek is given or not", () => {
  const m = [...LEAGUE.slice(0, 3), entry(4, 2, 0)];
  for (const stateWeek of [3, 2, undefined, null, ""]) {
    const r = weekFinality({ week: 3, schedule: sched("complete", "complete"), matchups: m, stateWeek });
    assert.equal(r.final, false, `stateWeek ${JSON.stringify(stateWeek)}`);
    assert.equal(r.past, false);
  }
});

test("Sleeper past the week but a game not complete: not past, 0 is unscored, not final", () => {
  const m = [...LEAGUE.slice(0, 3), entry(4, 2, 0)];
  const r = weekFinality({ week: 3, schedule: sched("complete", "in_game"), matchups: m, stateWeek: 4 });
  assert.equal(r.past, false);
  assert.equal(r.final, false);
  assert.match(r.reason, /not complete/);
});

test("past week with no NFL games listed is still not final", () => {
  const r = weekFinality({ week: 3, schedule: [], matchups: LEAGUE, stateWeek: 4 });
  assert.equal(r.past, false);
  assert.equal(r.final, false);
});

/* ------------------------------------------------ folding standings ---- */

const row = (roster_id, wins, losses, pf, pa, ties = 0) =>
  ({ manager: `m${roster_id}`, team: "", roster_id, wins, losses, ties, points_for: pf, points_against: pa, waiver_budget_used: 0 });
const side = (roster_id, points) => ({ roster_id, points, manager: `m${roster_id}` });
const gm = (a, b) => ({ sides: [a, b] });
// Two weeks played, building week 3; Sleeper has not posted week 3.
const BEHIND = [row(1, 2, 0, 250.5, 200), row(2, 1, 1, 230, 229.1), row(3, 1, 1, 210, 215.25), row(4, 0, 2, 190.1, 236.25)];
const WEEK3 = [gm(side(4, 130.2), side(1, 99.8)), gm(side(2, 101.01), side(3, 100))];

test("fold: one week behind, everyone in one game — the week is added", () => {
  const f = foldWeekIntoStandings({ standings: BEHIND, games: WEEK3, week: 3 });
  assert.equal(f.folded, true, f.reason);
  assert.equal(f.through, 3);
  const by = new Map(f.standings.map(s => [s.roster_id, s]));
  assert.deepEqual([by.get(1).wins, by.get(1).losses], [2, 1]);
  assert.deepEqual([by.get(4).wins, by.get(4).losses], [1, 2]);
  assert.deepEqual([by.get(2).wins, by.get(2).losses], [2, 1]);
  assert.equal(by.get(1).points_for, 350.3);
  assert.equal(by.get(1).points_against, 330.2);
  assert.equal(by.get(4).points_for, 320.3);
  assert.equal(by.get(2).points_for, 331.01);
  assert.equal(by.get(3).points_against, 316.26);
  // Re-sorted: wins, then points for.
  assert.deepEqual(f.standings.map(s => s.roster_id), [1, 2, 4, 3]);
  // The input is not touched.
  assert.equal(BEHIND[0].losses, 0);
});

test("fold: a tied game is a tie for both", () => {
  const f = foldWeekIntoStandings({ standings: BEHIND, games: [gm(side(1, 100), side(2, 100)), gm(side(3, 90), side(4, 80))], week: 3 });
  assert.equal(f.folded, true);
  const by = new Map(f.standings.map(s => [s.roster_id, s]));
  assert.equal(by.get(1).ties, 1);
  assert.equal(by.get(2).ties, 1);
});

test("fold: already current — left exactly as Sleeper had it", () => {
  const current = BEHIND.map(r => ({ ...r, wins: r.wins + 1 }));
  const f = foldWeekIntoStandings({ standings: current, games: WEEK3, week: 3 });
  assert.equal(f.folded, false);
  assert.equal(f.through, 3);
  assert.deepEqual(f.standings, current);
});

test("fold: refused in the playoffs, with a median game, or when not exactly one behind", () => {
  assert.equal(foldWeekIntoStandings({ standings: BEHIND, games: WEEK3, week: 3, isPlayoffs: true }).folded, false);
  assert.equal(foldWeekIntoStandings({ standings: BEHIND, games: WEEK3, week: 3, medianMatch: true }).folded, false);
  assert.equal(foldWeekIntoStandings({ standings: BEHIND, games: WEEK3, week: 4 }).folded, false);
  const uneven = [...BEHIND.slice(0, 3), row(4, 0, 1, 90, 120)];
  assert.equal(foldWeekIntoStandings({ standings: uneven, games: WEEK3, week: 3 }).folded, false);
});

test("fold: refused when a team is missing a game, plays twice, or a score is unusable", () => {
  assert.equal(foldWeekIntoStandings({ standings: BEHIND, games: WEEK3.slice(0, 1), week: 3 }).folded, false);
  assert.equal(foldWeekIntoStandings({ standings: BEHIND, games: [...WEEK3, gm(side(1, 1), side(2, 2))], week: 3 }).folded, false);
  assert.equal(foldWeekIntoStandings({ standings: BEHIND, games: [WEEK3[0], gm(side(2, null), side(3, 100))], week: 3 }).folded, false);
  assert.equal(foldWeekIntoStandings({ standings: [], games: WEEK3, week: 3 }).folded, false);
});

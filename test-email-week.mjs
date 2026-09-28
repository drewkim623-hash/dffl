/**
 * node --test test-email-week.mjs
 *
 * In-memory fixtures only: nothing here reads or writes the real ledger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { newestRecap, resolveRecapWeek, recapSendGuard } from "./email-week.mjs";

const wk = (season, week) => ({ season, week, games: [] });
// Deliberately out of order: the newest is not first or last.
const SEP = { weeks: [wk("2026", 1), wk("2026", 2)] };
const SHUFFLED = { weeks: [wk("2025", 17), wk("2026", 2), wk("2026", 1), wk("2025", 3)] };
const BOUNDARY = { weeks: [wk("2026", 16), wk("2027", 1), wk("2026", 17)] };
const NONE = { weeks: [] };

test("newestRecap sorts by season then week, not by array order", () => {
  assert.deepEqual(newestRecap(SHUFFLED), { season: "2026", week: 2 });
  assert.deepEqual(newestRecap(BOUNDARY), { season: "2027", week: 1 });
  assert.equal(newestRecap(NONE), null);
  assert.equal(newestRecap({}), null);
});

test("omitted --week records the newest recap", () => {
  assert.deepEqual(resolveRecapWeek({ recaps: SHUFFLED }), { season: "2026", week: 2 });
  assert.deepEqual(resolveRecapWeek({ recaps: SHUFFLED, weekArg: null, seasonArg: null }), { season: "2026", week: 2 });
});

test("the newest week by number is accepted, with or without --season", () => {
  assert.deepEqual(resolveRecapWeek({ recaps: SEP, weekArg: "2" }), { season: "2026", week: 2 });
  assert.deepEqual(resolveRecapWeek({ recaps: SEP, weekArg: "2", seasonArg: "2026" }), { season: "2026", week: 2 });
});

test("the Sep 26 mistake: --week 3 copied from the subject is refused", () => {
  assert.throws(() => resolveRecapWeek({ recaps: SEP, weekArg: "3", seasonArg: "2026" }), err => {
    assert.match(err.message, /--week 3 has no recap/);
    assert.match(err.message, /subject/);
    assert.match(err.message, /newest is 2026 week 2/);
    assert.match(err.message, /"DFFL Week 3: \.\.\." carries the week 2 recap/);
    assert.match(err.message, /--week 2/);
    return true;
  });
  assert.throws(() => resolveRecapWeek({ recaps: SEP, weekArg: "3" }), /no recap/);
});

test("a week with no recap is refused", () => {
  assert.throws(() => resolveRecapWeek({ recaps: SEP, weekArg: "9" }), /--week 9 has no recap.*newest is 2026 week 2/s);
});

test("an older existing week is refused unless allowOlder", () => {
  assert.throws(() => resolveRecapWeek({ recaps: SEP, weekArg: "1" }), err => {
    assert.match(err.message, /older recap/);
    assert.match(err.message, /only ever sends the newest/);
    assert.match(err.message, /2026 week 2/);
    assert.match(err.message, /--allow-older-week/);
    assert.match(err.message, /--at/);
    return true;
  });
  assert.deepEqual(resolveRecapWeek({ recaps: SEP, weekArg: "1", allowOlder: true }), { season: "2026", week: 1 });
});

test("--no-recap records null, and contradicts --week", () => {
  assert.equal(resolveRecapWeek({ recaps: SEP, noRecap: true }), null);
  assert.equal(resolveRecapWeek({ recaps: NONE, noRecap: true }), null);
  assert.throws(() => resolveRecapWeek({ recaps: SEP, weekArg: "2", noRecap: true }), /contradict/);
});

test("no recaps at all: omitted week is null, any --week is refused", () => {
  assert.equal(resolveRecapWeek({ recaps: NONE }), null);
  assert.equal(resolveRecapWeek({ recaps: {} }), null);
  assert.throws(() => resolveRecapWeek({ recaps: NONE, weekArg: "1" }), /no recaps yet.*--no-recap/s);
});

test("invalid --week strings are refused", () => {
  for (const bad of ["", "abc", "2.5", "0", "-1", "--to", "--season", " 2", "2x", "02"])
    assert.throws(() => resolveRecapWeek({ recaps: SEP, weekArg: bad }), /positive whole number/, `weekArg ${JSON.stringify(bad)}`);
});

test("invalid --season strings are refused", () => {
  for (const bad of ["", "--week", "26", "abcd"])
    assert.throws(() => resolveRecapWeek({ recaps: SEP, weekArg: "2", seasonArg: bad }), /four-digit year/);
});

test("season boundary: defaults to the new season, not the calendar year or the old one", () => {
  assert.deepEqual(resolveRecapWeek({ recaps: BOUNDARY }), { season: "2027", week: 1 });
  assert.deepEqual(resolveRecapWeek({ recaps: BOUNDARY, weekArg: "1" }), { season: "2027", week: 1 });
  // --week 17 alone means 2027, which has no week 17; say so and point at 2026.
  assert.throws(() => resolveRecapWeek({ recaps: BOUNDARY, weekArg: "17" }), err => {
    assert.match(err.message, /--week 17 has no recap in recaps\.json \(season 2027\)/);
    assert.match(err.message, /newest is 2027 week 1/);
    assert.match(err.message, /2026 week 17/);
    return true;
  });
  assert.throws(() => resolveRecapWeek({ recaps: BOUNDARY, weekArg: "17", seasonArg: "2026" }), /older recap/);
  assert.deepEqual(resolveRecapWeek({ recaps: BOUNDARY, weekArg: "17", seasonArg: "2026", allowOlder: true }),
    { season: "2026", week: 17 });
});

test("season stored as a number works the same as a string", () => {
  const numeric = { weeks: [wk(2026, 1), wk(2026, 2)] };
  assert.deepEqual(newestRecap(numeric), { season: "2026", week: 2 });
  assert.deepEqual(resolveRecapWeek({ recaps: numeric }), { season: "2026", week: 2 });
  assert.deepEqual(resolveRecapWeek({ recaps: numeric, weekArg: "2", seasonArg: "2026" }), { season: "2026", week: 2 });
  assert.throws(() => resolveRecapWeek({ recaps: numeric, weekArg: "3" }), /no recap/);
  assert.throws(() => resolveRecapWeek({ recaps: numeric, weekArg: "1" }), /older recap/);
});

test("--season that disagrees with the recap the email carried is refused", () => {
  assert.throws(() => resolveRecapWeek({ recaps: SEP, seasonArg: "2025" }), /--season 2025 does not match.*2026 week 2/s);
  assert.deepEqual(resolveRecapWeek({ recaps: SEP, seasonArg: "2026" }), { season: "2026", week: 2 });
});

/* ---------------------------------------------------- recapSendGuard ---- */

const NOW = Date.parse("2026-09-29T05:00:00Z"); // 1:00 AM EDT, Tuesday
const latest = (over = {}) => ({
  season: "2026", week: 3, file: "data/week-2026-03.json",
  generated: "2026-09-29T04:31:00Z", generated_at: "2026-09-29T04:31:00Z", final: true,
  sleeper_state: { week: 3, leg: 3, display_week: 3, season_type: "regular", season: "2026" },
  ...over,
});
const LEDGER = { sent: [{ at: "2026-09-22T04:32:50Z", subject: "DFFL Week 3: One Game Was on the Bench", recap: { season: "2026", week: 2 } }] };
const guard = (l, ledger = LEDGER, now = NOW) => recapSendGuard({ latest: l, ledger, now });

test("guard: final, fresh, unsent, Sleeper not flipped yet — send", () => {
  const r = guard(latest());
  assert.equal(r.ok, true, JSON.stringify(r.checks));
  assert.deepEqual(r.recap, { season: "2026", week: 3 });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.checks.map(c => c.id), ["final", "week", "fresh", "unsent"]);
});

test("guard: Sleeper already moved on to latest.week + 1 — send", () => {
  const r = guard(latest({ sleeper_state: { week: 4, leg: 4, display_week: 4, season_type: "regular", season: "2026" } }));
  assert.equal(r.ok, true, JSON.stringify(r.checks));
});

test("guard: not final — no send, and says so", () => {
  for (const final of [false, undefined, null, "true", 1]) {
    const r = guard(latest({ final }));
    assert.equal(r.ok, false);
    assert.ok(r.failed.includes("final"), `final ${JSON.stringify(final)}`);
    // Sleeper still on the same week is only acceptable when final.
    assert.ok(r.failed.includes("week"));
  }
});

test("guard: stale latest.json (Sleeper two weeks on, or behind) fails the week check", () => {
  const st = w => ({ week: w, leg: w, display_week: w, season_type: "regular", season: "2026" });
  assert.deepEqual(guard(latest({ sleeper_state: st(5) })).failed, ["week"]);
  assert.match(guard(latest({ sleeper_state: st(5) })).checks[1].message, /stale/);
  assert.deepEqual(guard(latest({ sleeper_state: st(2) })).failed, ["week"]);
  assert.deepEqual(guard(latest({ sleeper_state: { ...st(4), season: "2027" } })).failed, ["week"]);
  assert.deepEqual(guard(latest({ sleeper_state: undefined })).failed, ["week"]);
});

test("guard: generated_at 12 hours or more old fails; just under passes", () => {
  const at = h => new Date(NOW - h * 36e5).toISOString();
  assert.equal(guard(latest({ generated_at: at(11.9) })).ok, true);
  assert.deepEqual(guard(latest({ generated_at: at(12) })).failed, ["fresh"]);
  assert.deepEqual(guard(latest({ generated_at: at(30) })).failed, ["fresh"]);
  assert.match(guard(latest({ generated_at: at(30) })).checks[2].message, /30\.0 hours old/);
});

test("guard: missing, junk or future generated_at fails — the old `generated` is not enough", () => {
  assert.deepEqual(guard(latest({ generated_at: undefined })).failed, ["fresh"]);
  assert.deepEqual(guard(latest({ generated_at: "yesterday" })).failed, ["fresh"]);
  assert.deepEqual(guard(latest({ generated_at: new Date(NOW + 36e5).toISOString() })).failed, ["fresh"]);
});

test("guard: a recap week already in the ledger is not sent again", () => {
  const ledger = { sent: [...LEDGER.sent, { at: "2026-09-29T05:01:00Z", subject: "DFFL Week 4: x", recap: { season: "2026", week: 3 } }] };
  const r = guard(latest(), ledger);
  assert.deepEqual(r.failed, ["unsent"]);
  assert.match(r.checks[3].message, /already logged as sent/);
  // Same week number, other season: not the same recap.
  const other = { sent: [{ at: "2025-09-30T05:00:00Z", subject: "old", recap: { season: "2025", week: 3 } }] };
  assert.equal(guard(latest(), other).ok, true);
  // Sends that carried no recap do not count.
  assert.equal(guard(latest(), { sent: [{ at: "x", subject: "y", recap: null }] }).ok, true);
  assert.equal(guard(latest(), undefined).ok, true);
});

test("guard: today's main latest.json (no final, no generated_at, no sleeper_state) is refused on every count but unsent", () => {
  const old = { season: "2026", week: 2, file: "data/week-2026-02.json", generated: "2026-09-28T11:03:54.636Z" };
  const r = guard(old, LEDGER, Date.parse("2026-09-28T12:00:00Z"));
  assert.equal(r.ok, false);
  assert.deepEqual(r.failed, ["final", "week", "fresh", "unsent"]);
});

test("guard: an empty or missing latest.json is refused", () => {
  for (const l of [{}, null, undefined]) {
    const r = guard(l);
    assert.equal(r.ok, false);
    assert.equal(r.recap, null);
    assert.deepEqual(r.failed, ["final", "week", "fresh", "unsent"]);
  }
});

test("guard: numeric season and week strings behave the same", () => {
  const r = guard(latest({ season: 2026, week: "3", sleeper_state: { week: "4", season: 2026 } }));
  assert.equal(r.ok, true, JSON.stringify(r.checks));
});

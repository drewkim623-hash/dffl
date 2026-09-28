/**
 * node --test test-email-week.mjs
 *
 * In-memory fixtures only: nothing here reads or writes the real ledger.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { newestRecap, resolveRecapWeek } from "./email-week.mjs";

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

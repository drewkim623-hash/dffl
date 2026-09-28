/**
 * node --test test-effective-week.mjs
 *
 * The effective-week rule, and a check that index.html's inline copy behaves
 * exactly like effective-week.mjs. In-memory fixtures; the only file read is
 * index.html, to lift the copy out of it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { effectiveState, effectiveWeek } from "./effective-week.mjs";

const ST = (week, over = {}) => ({ week, leg: week, display_week: week, season: "2026", season_type: "regular", ...over });
const LT = (week, ...rest) => ({ season: "2026", week, file: `data/week-2026-0${week}.json`,
  final: rest.length ? rest[0] : true, ...(rest[1] || {}) });

test("1 AM Tuesday: Sleeper still on the finished week, latest.json says it is final — advance", () => {
  const s = effectiveState(ST(2), LT(2));
  assert.equal(s.week, 3);
  assert.equal(s.leg, 3);
  assert.equal(s.display_week, 3);
  assert.equal(s.sleeper_week, 2);
  assert.equal(s.season, "2026");
  assert.equal(effectiveWeek(ST(2), LT(2)), 3);
});

test("Sleeper has already flipped — nothing to do", () => {
  const st = ST(3);
  assert.equal(effectiveState(st, LT(2)), st);
  assert.equal(effectiveWeek(st, LT(2)), 3);
});

test("the week is not final (or final is missing, as on main today) — Sleeper's week stands", () => {
  for (const final of [false, undefined, null, "true", 1]) {
    const st = ST(3);
    assert.equal(effectiveState(st, LT(3, final)), st, `final ${JSON.stringify(final)}`);
    assert.equal(effectiveWeek(st, LT(3, final)), 3);
  }
  const old = { season: "2026", week: 2, file: "data/week-2026-02.json", generated: "2026-09-28T11:03:54.636Z" };
  assert.equal(effectiveWeek(ST(3), old), 3);
});

test("latest.json behind or ahead of Sleeper never moves the week", () => {
  assert.equal(effectiveWeek(ST(5), LT(3)), 5);
  assert.equal(effectiveWeek(ST(2), LT(3)), 2);
});

test("different season, missing inputs, junk weeks — unchanged", () => {
  assert.equal(effectiveWeek(ST(1, { season: "2027" }), LT(1)), 1);
  assert.equal(effectiveState(null, LT(2)), null);
  assert.equal(effectiveWeek(null, LT(2)), null);
  const st = ST(2);
  assert.equal(effectiveState(st, null), st);
  assert.equal(effectiveState(st, undefined), st);
  assert.equal(effectiveState(ST(0), LT(0)).week, 0);
  assert.equal(effectiveState(ST("abc"), LT("abc")).week, "abc");
});

test("numeric season and week strings behave the same", () => {
  assert.equal(effectiveWeek(ST("2", { season: 2026 }), LT(2, true, { season: "2026" })), 3);
  assert.equal(effectiveWeek(ST(2), LT("2")), 3);
});

test("leg and display_week only move when they matched the week", () => {
  const s = effectiveState(ST(2, { display_week: 3, leg: 2 }), LT(2));
  assert.equal(s.display_week, 3);
  assert.equal(s.leg, 3);
});

test("the input state is never mutated", () => {
  const st = ST(2);
  effectiveState(st, LT(2));
  assert.equal(st.week, 2);
  assert.equal(st.sleeper_week, undefined);
});

test("index.html's inline copy is the same code and gives the same answers", () => {
  const between = src => {
    const m = /\/\* effective-week:begin \*\/\n([\s\S]*?)\/\* effective-week:end \*\//.exec(src);
    assert.ok(m, "effective-week markers not found");
    return m[1];
  };
  const mod = between(readFileSync(new URL("./effective-week.mjs", import.meta.url), "utf8"));
  const html = between(readFileSync(new URL("./index.html", import.meta.url), "utf8"));
  // index.html indents it inside <script>; compare with leading whitespace removed.
  const norm = s => s.split("\n").map(l => l.trim()).filter(Boolean).join("\n");
  assert.equal(norm(html), norm(mod));
  const inline = new Function(`${html}; return effectiveState;`)();
  const cases = [
    [ST(2), LT(2)], [ST(3), LT(2)], [ST(3), LT(3, false)], [ST(3), LT(3, undefined)],
    [ST(1, { season: "2027" }), LT(1)], [null, LT(2)], [ST(2), null], [ST("2"), LT("2")],
    [ST(2, { display_week: 3 }), LT(2)], [ST(18), LT(18)],
  ];
  for (const [s, l] of cases) assert.deepEqual(inline(s, l), effectiveState(s, l), JSON.stringify([s, l]));
});

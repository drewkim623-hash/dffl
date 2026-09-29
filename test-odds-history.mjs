/**
 * node --test test-odds-history.mjs
 *
 * The odds history only ever grows: odds-history.mjs's merge rules in memory,
 * then build-odds-history.mjs end to end against throwaway git repos in the
 * temp dir (including a --depth 1 clone, which is what the data job checks out).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mergeHistory, rowKey, rowsFromSnapshot } from "./odds-history.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "build-odds-history.mjs");

const ROW = (at, a, b, pA, over = {}) => ({ at, a, b, pA, aPts: 0, bPts: 0, settled: false, ...over });
const FILE = weeks => ({ _comment: "c", generated: "2026-09-01T00:00:00.000Z", weeks });
const SNAP = (generated, week, games, over = {}) => ({ generated, season: "2026", week, liveWeek: week, games, ...over });
const G = (a, b, pA, over = {}) => ({ a, b, pA, aPts: 10, bPts: 20, settled: false, ...over });

test("rowsFromSnapshot derives rows the way the old script did", () => {
  const rows = rowsFromSnapshot(SNAP("2026-09-20T12:00:00.000Z", 3,
    [G("x", "y", 0.4), { a: "p", b: "q", pA: 0.5 }, { a: "m", b: "n" }, null, { a: "r", pA: 0.1 }],
    { liveWeek: null, week: 2 }), "fallback");
  assert.deepEqual(rows, [
    { key: "2026-2", row: ROW("2026-09-20T12:00:00.000Z", "x", "y", 0.4, { aPts: 10, bPts: 20 }) },
    { key: "2026-2", row: ROW("2026-09-20T12:00:00.000Z", "p", "q", 0.5) },
  ]);
  assert.equal(rowsFromSnapshot({ season: "2026", week: 1, games: [G("x", "y", 0.4)] }, "F")[0].row.at, "F");
  assert.deepEqual(rowsFromSnapshot({ season: "2026", games: [G("x", "y", 0.4)] }), []);
  assert.deepEqual(rowsFromSnapshot(null), []);
  assert.equal(rowKey("2026-3", ROW("t", "a", "b", 0.5)), "2026-3|t|a|b");
});

test("merge keeps every existing row and appends new ones", () => {
  const old = [ROW("2026-09-13T00:00:00Z", "a", "b", 0.6), ROW("2026-09-14T00:00:00Z", "a", "b", 0.7)];
  const existing = FILE({ "2026-1": old });
  const { out, added } = mergeHistory(existing, [{ key: "2026-1", row: ROW("2026-09-15T00:00:00Z", "a", "b", 0.9) }]);
  assert.equal(added, 1);
  assert.equal(out.weeks["2026-1"].length, 3);
  assert.deepEqual(out.weeks["2026-1"].slice(0, 2), old);
  assert.equal(out.weeks["2026-1"][0], old[0], "the existing object itself is kept");
  assert.equal(out._comment, "c");
});

test("idempotent: the same incoming twice gives identical output and adds nothing", () => {
  const incoming = [
    { key: "2026-2", row: ROW("2026-09-20T00:00:00Z", "a", "b", 0.5) },
    { key: "2026-2", row: ROW("2026-09-20T00:00:00Z", "a", "b", 0.5) },
    { key: "2026-2", row: ROW("2026-09-20T00:00:00Z", "c", "d", 0.2) },
  ];
  const first = mergeHistory(FILE({}), incoming);
  assert.equal(first.added, 2, "duplicates within incoming are dropped");
  const second = mergeHistory(first.out, incoming);
  assert.equal(second.added, 0);
  assert.equal(JSON.stringify(second.out), JSON.stringify(first.out));
});

test("an existing row is never rewritten by an incoming row with the same key", () => {
  const existing = FILE({ "2026-1": [ROW("2026-09-13T00:00:00Z", "a", "b", 0.6, { aPts: 1 })] });
  const before = JSON.stringify(existing);
  const { out, added } = mergeHistory(existing, [{ key: "2026-1", row: ROW("2026-09-13T00:00:00Z", "a", "b", 0.99, { aPts: 50 }) }]);
  assert.equal(added, 0);
  assert.equal(out.weeks["2026-1"].length, 1);
  assert.equal(out.weeks["2026-1"][0].pA, 0.6);
  assert.equal(out.weeks["2026-1"][0].aPts, 1);
  assert.equal(JSON.stringify(existing), before, "the input is not mutated");
});

test("empty incoming (a shallow or empty history) keeps every existing row unchanged", () => {
  const existing = FILE({
    "2026-1": [ROW("2026-09-13T00:00:00Z", "a", "b", 0.6), ROW("2026-09-13T00:00:00Z", "c", "d", 0.3)],
    "2026-2": [ROW("2026-09-20T00:00:00Z", "a", "c", 0.5)],
  });
  for (const incoming of [[], null, undefined]) {
    const { out, added } = mergeHistory(existing, incoming);
    assert.equal(added, 0);
    assert.deepEqual(out, existing);
  }
  assert.deepEqual(mergeHistory(null, []).out.weeks, {});
});

test("rows from different weeks land in the right week, weeks sorted, rows sorted by time", () => {
  const existing = FILE({ "2026-2": [ROW("2026-09-20T12:00:00Z", "a", "b", 0.5)] });
  const { out, added } = mergeHistory(existing, [
    { key: "2026-3", row: ROW("2026-09-27T12:00:00Z", "a", "b", 0.4) },
    { key: "2026-2", row: ROW("2026-09-20T09:00:00Z", "c", "d", 0.1) },
    { key: "2026-1", row: ROW("2026-09-13T12:00:00Z", "a", "b", 0.3) },
    { key: "2026-2", row: ROW("2026-09-21T09:00:00Z", "a", "b", 0.7) },
    { key: "2026-2", row: ROW("2026-09-20T12:00:00Z", "e", "f", 0.2) },
  ]);
  assert.equal(added, 5);
  assert.deepEqual(Object.keys(out.weeks), ["2026-1", "2026-2", "2026-3"]);
  assert.deepEqual(out.weeks["2026-2"].map(r => `${r.at} ${r.a}`), [
    "2026-09-20T09:00:00Z c",
    "2026-09-20T12:00:00Z a", // stable: the existing row stays ahead of a same-time newcomer
    "2026-09-20T12:00:00Z e",
    "2026-09-21T09:00:00Z a",
  ]);
  assert.equal(out.weeks["2026-1"].length, 1);
  assert.equal(out.weeks["2026-3"].length, 1);
});

// ---- end to end -------------------------------------------------------------

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const write = (root, rel, obj) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) + "\n");
};
const run = root => spawnSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8" });
const initRepo = dir => {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
};
const withTmp = fn => {
  const dir = mkdtempSync(join(tmpdir(), "odds-history-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test("end to end: a --depth 1 clone keeps every committed row and adds the working-tree snapshot", () => withTmp(tmp => {
  const origin = join(tmp, "origin");
  initRepo(origin);
  write(origin, "data/odds-snapshot.json", SNAP("2026-09-13T12:00:00.000Z", 1, [G("a", "b", 0.6), G("c", "d", 0.4)]));
  git(origin, "add", "-A"); git(origin, "commit", "-qm", "snap 1");
  write(origin, "data/odds-snapshot.json", SNAP("2026-09-20T12:00:00.000Z", 2, [G("a", "c", 0.55)]));
  // Rows no commit of the snapshot could produce: only the file remembers them.
  const history = FILE({
    "2026-0": [ROW("2026-09-01T00:00:00.000Z", "old", "timer", 0.123456789)],
    "2026-1": [
      ROW("2026-09-10T00:00:00.000Z", "a", "b", 0.51, { aPts: 3.14 }),
      ROW("2026-09-11T00:00:00.000Z", "c", "d", 0.49, { settled: true }),
      // Same rowKey as snap 1's first game but different numbers: must not be rewritten.
      ROW("2026-09-13T12:00:00.000Z", "a", "b", 0.01),
    ],
  });
  write(origin, "data/odds-history.json", history);
  git(origin, "add", "-A"); git(origin, "commit", "-qm", "snap 2 + history");

  const clone = join(tmp, "clone");
  git(tmp, "clone", "-q", "--depth", "1", `file://${origin}`, clone);
  assert.equal(git(clone, "rev-list", "--count", "HEAD").trim(), "1", "really shallow");
  write(clone, "data/odds-snapshot.json", SNAP("2026-09-27T12:00:00.000Z", 3, [G("a", "d", 0.7), G("b", "c", 0.3)]));

  const r = run(clone);
  assert.equal(r.status, 0, r.stderr);
  const after = JSON.parse(readFileSync(join(clone, "data/odds-history.json"), "utf8"));
  for (const [k, rows] of Object.entries(history.weeks)) {
    for (const row of rows) {
      const found = after.weeks[k].filter(x => rowKey(k, x) === rowKey(k, row));
      assert.equal(found.length, 1, rowKey(k, row));
      assert.deepEqual(found[0], row);
    }
  }
  assert.equal(after.weeks["2026-3"].length, 2, "working-tree snapshot added");
  assert.equal(after.weeks["2026-2"].length, 1, "the one visible commit added");
  assert.equal(after.weeks["2026-1"].length, 3, "snap 1 is past the shallow boundary, so nothing of it is added");
  assert.match(r.stdout, /4 existing rows, 3 added, 7 total/);
  assert.match(after._comment, /never removed/);

  const bytes = readFileSync(join(clone, "data/odds-history.json"), "utf8");
  const r2 = run(clone);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /0 added/);
  assert.equal(readFileSync(join(clone, "data/odds-history.json"), "utf8"), bytes, "second run is byte-identical");
}));

test("end to end: a corrupt history file is left untouched and the exit code is 0", () => withTmp(tmp => {
  const repo = join(tmp, "repo");
  initRepo(repo);
  write(repo, "data/odds-snapshot.json", SNAP("2026-09-20T12:00:00.000Z", 2, [G("a", "b", 0.5)]));
  for (const bad of ['{ "weeks": { "2026-1": [', '{"_comment":"no weeks"}\n', "[]\n", '{"weeks":{"2026-1":{"at":"x"}}}\n']) {
    write(repo, "data/odds-history.json", bad);
    const r = run(repo);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /warning/);
    assert.equal(readFileSync(join(repo, "data/odds-history.json"), "utf8"), bad);
  }
}));

test("end to end: no git history and no history file — the file is created from the working-tree snapshot", () => withTmp(tmp => {
  const repo = join(tmp, "repo");
  initRepo(repo);
  write(repo, "data/odds-snapshot.json", SNAP("2026-09-20T12:00:00.000Z", 2, [G("a", "b", 0.5), G("c", "d", 0.25)]));
  const r = run(repo);
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(readFileSync(join(repo, "data/odds-history.json"), "utf8"));
  assert.deepEqual(Object.keys(out), ["_comment", "generated", "weeks"]);
  assert.deepEqual(out.weeks, { "2026-2": [
    ROW("2026-09-20T12:00:00.000Z", "a", "b", 0.5, { aPts: 10, bPts: 20 }),
    ROW("2026-09-20T12:00:00.000Z", "c", "d", 0.25, { aPts: 10, bPts: 20 }),
  ] });
  assert.match(r.stdout, /0 existing rows, 2 added, 2 total/);

  // Not even a git repo: still fine.
  const plain = join(tmp, "plain");
  write(plain, "data/odds-snapshot.json", SNAP("2026-09-20T12:00:00.000Z", 2, [G("a", "b", 0.5)]));
  const r2 = run(plain);
  assert.equal(r2.status, 0, r2.stderr);
  assert.match(r2.stdout, /1 added/);
}));

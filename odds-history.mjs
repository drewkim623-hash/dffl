/**
 * The pure half of build-odds-history.mjs: turn an odds snapshot into rows, and
 * merge rows into the history without ever losing or rewriting one.
 *
 *   data/odds-history.json = { _comment, generated,
 *     weeks: { "<season>-<week>": [ { at, a, b, pA, aPts, bPts, settled }, ... ] } }
 *
 * No I/O here; test-odds-history.mjs exercises it directly.
 */

// The rows one data/odds-snapshot.json yields, as [{ key, row }].
export function rowsFromSnapshot(snap, fallbackAt) {
  if (!snap || typeof snap !== "object") return [];
  const games = Array.isArray(snap.games) ? snap.games : [];
  // The games on a snapshot belong to the week in flight; fall back to the
  // snapshot's own week when nothing was live.
  const week = snap.liveWeek ?? snap.week;
  if (!games.length || week == null || !snap.season) return [];
  const key = `${snap.season}-${week}`;
  // The snapshot's own clock, not the commit's: a copy can be committed well
  // after it was taken.
  const at = snap.generated || fallbackAt;
  const out = [];
  for (const g of games) {
    if (!g || !g.a || !g.b || typeof g.pA !== "number") continue;
    out.push({ key, row: {
      at, a: g.a, b: g.b, pA: g.pA,
      aPts: g.aPts ?? 0, bPts: g.bPts ?? 0, settled: !!g.settled,
    } });
  }
  return out;
}

// One reading of one game in one week.
export const rowKey = (key, row) => `${key}|${row.at}|${row.a}|${row.b}`;

const time = row => {
  const t = Date.parse(row.at);
  return Number.isNaN(t) ? Infinity : t;
};

// existing: the parsed file (or null). incoming: [{ key, row }].
// Existing rows are kept exactly as they are, even when an incoming row shares
// their rowKey; only rows with a new rowKey are appended. Returns { out, added }.
export function mergeHistory(existing, incoming) {
  const weeks = {};
  const seen = new Set();
  for (const [key, rows] of Object.entries(existing?.weeks || {})) {
    weeks[key] = Array.isArray(rows) ? rows.slice() : [];
    for (const row of weeks[key]) seen.add(rowKey(key, row));
  }
  let added = 0;
  for (const { key, row } of incoming || []) {
    const k = rowKey(key, row);
    if (seen.has(k)) continue;
    seen.add(k);
    (weeks[key] ||= []).push(row);
    added++;
  }
  // Array.prototype.sort is stable, so rows taken at the same moment keep
  // their order.
  for (const k of Object.keys(weeks)) weeks[k].sort((x, y) => {
    const a = time(x), b = time(y);
    return a === b ? 0 : a < b ? -1 : 1;
  });
  const out = {
    ...(existing && typeof existing === "object" ? existing : {}),
    weeks: Object.fromEntries(Object.keys(weeks).sort().map(k => [k, weeks[k]])),
  };
  return { out, added };
}

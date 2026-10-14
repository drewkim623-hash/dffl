/**
 * The pure half of build-odds-history.mjs: turn an odds snapshot into rows, and
 * merge rows into the history without ever losing or rewriting one.
 *
 *   data/odds-history.json = { _comment, generated,
 *     weeks: { "<season>-<week>": [ { at, a, b, pA, aPts, bPts, settled }, ... ] },
 *     teams: { "<season>-<week>": [ { at, uid, manager, playoff, title }, ... ] } }
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

// ---- per-team odds at the end of each finalized week -------------------------
//
//   teams: { "<season>-<week>": [ { at, uid, manager, playoff, title }, ... ] }
//
// playoff and title are the site's chances (0..1) once <week> was final, read
// straight off the snapshot. Only a snapshot taken between weeks counts (no
// week in flight, board settled); its week is the one coming up, so the week it
// speaks for is the one before.

// The finalized week one snapshot yields, as { key, rows }, or null.
export function teamRowsFromSnapshot(snap, fallbackAt) {
  if (!snap || typeof snap !== "object" || !snap.season) return null;
  if (snap.liveWeek != null || snap.settled !== true) return null;
  if (typeof snap.week !== "number" || snap.week < 2 || !Array.isArray(snap.teams)) return null;
  const at = snap.generated || fallbackAt;
  if (!at) return null;
  const rows = [];
  for (const t of snap.teams) {
    if (!t || !t.uid) continue;
    // With no week live the site prices off the pre-week sims; so does this.
    const playoff = t.playoffNow ?? t.playoffWas, title = t.titleNow ?? t.titleWas;
    if (typeof playoff !== "number" || typeof title !== "number") continue;
    rows.push({ at, uid: t.uid, manager: t.manager ?? null, playoff, title });
  }
  return rows.length ? { key: `${snap.season}-${snap.week - 1}`, rows } : null;
}

const weekOrder = (x, y) => {
  const [sx, wx] = x.split("-").map(Number), [sy, wy] = y.split("-").map(Number);
  return sx - sy || wx - wy;
};

// existing: the file's teams object (or undefined). incoming: [{ key, rows }].
// A week's rows are replaced wholesale, never appended to, by the newest
// reading of that week; a reading older than the one on file is ignored.
// Weeks nobody sent are kept as they are. Returns { teams, changed }.
export function mergeTeamWeeks(existing, incoming) {
  const teams = { ...(existing || {}) };
  const sorted = (incoming || []).filter(x => x && x.rows && x.rows.length)
    .slice().sort((x, y) => {
      const a = time(x.rows[0]), b = time(y.rows[0]);
      return a === b ? 0 : a < b ? -1 : 1;
    });
  for (const { key, rows } of sorted) {
    const have = teams[key];
    if (Array.isArray(have) && have.length && time(have[0]) > time(rows[0])) continue;
    teams[key] = rows.map(r => ({ ...r }));
  }
  const out = Object.fromEntries(Object.keys(teams).sort(weekOrder).map(k => [k, teams[k]]));
  return { teams: out, changed: JSON.stringify(out) !== JSON.stringify(existing || {}) };
}

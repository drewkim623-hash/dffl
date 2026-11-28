/*
 * DFFL's tiebreak rule, in one place. Loaded two ways:
 *   - the browser: <script src="tiebreak.js"></script> before the page's own script
 *   - Node ESM:    import "./tiebreak.js"; const { rankStandings } = globalThis.DFFLTiebreak;
 * so it has no import/export statements; it hangs everything off globalThis.
 *
 * The rule (every ranking on the site: division winners, seeds, wild cards,
 * the standings table, the toilet-bowl order, last place):
 *   1. Wins. A tied game counts half.
 *   2. Exactly TWO teams level:
 *        a. head to head (their games against each other, ties half);
 *        b. still level AND the two share a division: division record — win %
 *           in every division game of the season (against every other team in
 *           that division, ties half);
 *        c. points for.
 *      Two teams from different divisions: head to head, then points for.
 *   3. THREE OR MORE level: points for, straight.
 * A tie is sized inside the list being ranked (a division, the division
 * winners, the wild-card pool, the whole league).
 *
 * tieOrder is written self-contained (no outside references) so the page can
 * paste its source into a Web Worker with .toString().
 */
(function () {
  /**
   * Order `list` (team indices) best first.
   *   W[i]   wins (ties as half), PF[i] points for — both indexed by team, length N
   *   H      head-to-head wins: N×N rows (H[a][b]), a flat N*N array (H[a*N+b]),
   *          or a function (a, b) => a's wins over b; null = no games
   *   divOf  i => division, or null to skip the division step
   *   all    every team index (whose games make up a division record);
   *          defaults to 0..W.length-1
   */
  function tieOrder(list, W, PF, H, divOf, all) {
    const N = W.length;
    let h;
    if (typeof H === "function") h = H;
    else if (!H) h = () => 0;
    else if (H.length === N * N && N > 1 && typeof H[0] === "number") h = (a, b) => H[a * N + b] || 0;
    else h = (a, b) => (H[a] && H[a][b]) || 0;
    const everyone = all || Array.from({ length: N }, (_, i) => i);
    const divPct = x => {
      const d = divOf(x);
      let w = 0, g = 0;
      for (const y of everyone) if (y !== x && divOf(y) === d) { const a = h(x, y), b = h(y, x); w += a; g += a + b; }
      return g ? w / g : 0.5;
    };
    const s = list.slice().sort((a, b) => W[b] - W[a] || PF[b] - PF[a]);
    const out = [];
    for (let k = 0; k < s.length;) {
      let e = k + 1;
      while (e < s.length && W[s[e]] === W[s[k]]) e++;
      if (e - k === 2) {
        const a = s[k], b = s[k + 1];
        let d = h(a, b) - h(b, a);
        if (d === 0 && divOf && divOf(a) != null && divOf(a) === divOf(b)) d = divPct(a) - divPct(b);
        out.push(d < 0 ? b : a, d < 0 ? a : b);   // level all the way: points for (s is in PF order)
      } else for (let j = k; j < e; j++) out.push(s[j]);
      k = e;
    }
    return out;
  }

  /** Division record of team x: { w, g, pct } over its games against same-division teams. */
  function divisionRecord(x, H, divOf, all) {
    const N = all ? Math.max(...all) + 1 : (H.length && Array.isArray(H[0]) ? H.length : Math.round(Math.sqrt(H.length)));
    const h = typeof H === "function" ? H : Array.isArray(H[0]) ? (a, b) => H[a][b] || 0 : (a, b) => H[a * N + b] || 0;
    const everyone = all || Array.from({ length: N }, (_, i) => i);
    let w = 0, g = 0;
    for (const y of everyone) if (y !== x && divOf(y) === divOf(x)) { w += h(x, y); g += h(x, y) + h(y, x); }
    return { w, g, pct: g ? w / g : 0.5 };
  }

  /**
   * Head-to-head matrix (rows) from decided games {a, b, a_pts, b_pts}, a and b
   * being keys idxOf maps to 0..N-1 (games with an unknown side are skipped).
   * A tied game is half a win to each.
   */
  function h2hFromGames(games, idxOf, N) {
    const H = Array.from({ length: N }, () => new Array(N).fill(0));
    for (const g of games || []) {
      const a = idxOf(g.a), b = idxOf(g.b);
      if (a == null || b == null || a === b) continue;
      const pa = Number(g.a_pts), pb = Number(g.b_pts);
      if (pa > pb) H[a][b]++;
      else if (pb > pa) H[b][a]++;
      else { H[a][b] += 0.5; H[b][a] += 0.5; }
    }
    return H;
  }

  /**
   * Standings rows in league order, for the data writers.
   *   rows:  [{ roster_id, wins, losses, ties, points_for, division? }] — any
   *          extra fields are kept; `fpts`/`fpts_decimal` style rows should pass
   *          points_for already combined. Not mutated.
   *   games: decided regular-season games [{ a: roster_id, b: roster_id, a_pts, b_pts }].
   *          Missing/empty = no head to head (wins, then points for).
   *   opts.division: roster_id => division, overriding row.division.
   * Division record runs only when every row has a division; otherwise a
   * two-way tie is head to head then points for.
   * Returns a new array of the same row objects, best first.
   */
  function rankStandings(rows, games, opts) {
    const o = opts || {};
    const list = rows || [];
    const N = list.length;
    const idx = new Map(list.map((r, i) => [String(r.roster_id), i]));
    const W = list.map(r => (Number(r.wins) || 0) + (Number(r.ties) || 0) / 2);
    const PF = list.map(r => Number(r.points_for) || 0);
    const H = h2hFromGames(games || [], k => idx.get(String(k)), N);
    const divs = list.map(r => (o.division ? o.division(r.roster_id) : r.division));
    const haveDiv = N > 0 && divs.every(d => d != null && d !== "");
    const ids = list.map((_, i) => i);
    return tieOrder(ids, W, PF, H, haveDiv ? (i => divs[i]) : null, ids).map(i => list[i]);
  }

  /**
   * Decided games from Sleeper matchup arrays: weeks = [[{ roster_id, matchup_id, points }], ...].
   * A pairing where both sides scored 0 is treated as not played.
   */
  function gamesFromMatchups(weeks) {
    const out = [];
    for (const ms of weeks || []) {
      const by = new Map();
      for (const m of ms || []) {
        if (m.matchup_id == null) continue;
        if (!by.has(m.matchup_id)) by.set(m.matchup_id, []);
        by.get(m.matchup_id).push(m);
      }
      for (const pair of by.values()) {
        if (pair.length !== 2) continue;
        const [x, y] = pair, px = Number(x.points) || 0, py = Number(y.points) || 0;
        if (!px && !py) continue;
        out.push({ a: x.roster_id, b: y.roster_id, a_pts: px, b_pts: py });
      }
    }
    return out;
  }

  const RULE_TEXT = "wins (a tie counts half); two teams level: head to head, then — if they share a division — division record, then points for; three or more level: points for";

  globalThis.DFFLTiebreak = { tieOrder, divisionRecord, h2hFromGames, rankStandings, gamesFromMatchups, RULE_TEXT };
})();

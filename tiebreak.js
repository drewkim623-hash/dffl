/*
 * DFFL's tiebreak rule, in one place. Loaded two ways:
 *   - the browser: <script src="tiebreak.js"></script> before the page's own script
 *   - Node ESM:    import "./tiebreak.js"; const { rankStandings } = globalThis.DFFLTiebreak;
 * so it has no import/export statements; it hangs everything off globalThis.
 *
 * The rule (every ranking on the site: division winners, seeds, wild cards,
 * the standings table, the toilet-bowl order, last place):
 *   1. Wins. A tied game counts half.
 *   2. Exactly TWO teams level: head to head (their games against each other,
 *      ties half); then, if the two share a division, division record — win %
 *      in every division game of the season (ties half); then points for.
 *   3. THREE OR MORE level: combined head to head (each team's win % in games
 *      among the tied teams only; no such games = .500); then points for. If
 *      ALL of them share one division: combined head to head, then division
 *      record, then points for.
 *   4. A step that separates some but not all: the teams it separates are
 *      placed in order and every still-level subgroup starts again at step 2
 *      or 3 (by its own size). A step that separates nobody: next step.
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
   *   trace  optional array: gets { teams, step: "h2h"|"div"|"pf", vals, parts, level }
   *          for every step applied to a tied group (for explanations)
   */
  function tieOrder(list, W, PF, H, divOf, all, trace) {
    const N = W.length;
    let h;
    if (typeof H === "function") h = H;
    else if (!H) h = () => 0;
    else if (H.length === N * N && N > 1 && typeof H[0] === "number") h = (a, b) => H[a * N + b] || 0;
    else h = (a, b) => (H[a] && H[a][b]) || 0;
    const everyone = all || Array.from({ length: N }, (_, i) => i);
    const dOf = x => (divOf ? divOf(x) : null);
    const dp = new Map();
    // Division record: win % in every division game of the season (against
    // every other team in the division, ties half); no division games = .500.
    const divPct = x => {
      if (dp.has(x)) return dp.get(x);
      const d = dOf(x);
      let w = 0, g = 0;
      for (const y of everyone) if (y !== x && dOf(y) === d) { const a = h(x, y), b = h(y, x); w += a; g += a + b; }
      const v = g ? w / g : 0.5;
      dp.set(x, v);
      return v;
    };
    // COMBINED HEAD TO HEAD: team x's win percentage in the games it has played
    // against the OTHER teams of the tied group `g` only — games against teams
    // outside the group don't count, and a tied game is half a win. A team that
    // has played no one else in the group counts as .500. With exactly two
    // teams this is plain head to head.
    const h2hPct = (x, g) => {
      let w = 0, n = 0;
      for (const y of g) if (y !== x) { const a = h(x, y), b = h(y, x); w += a; n += a + b; }
      return n ? w / n : 0.5;
    };
    const sameDiv = g => g.every(x => dOf(x) != null && dOf(x) === dOf(g[0]));
    // Order one group level on wins (g arrives in points-for order). Steps:
    //   1. combined head to head;
    //   2. division record — only if EVERY team in g shares one division;
    //   3. points for (equal points keep the incoming order).
    // A step that splits g places the pieces in order and re-runs this whole
    // rule FROM THE START on every piece still holding 2+ teams (two left =
    // the two-team rule; three or more = combined head to head among just
    // them, ...). A step that splits nobody hands g to the next step, so it
    // never loops. `trace`, if given, gets one entry per step taken.
    const resolve = g => {
      if (g.length < 2) return g.slice();
      const steps = sameDiv(g) ? ["h2h", "div", "pf"] : ["h2h", "pf"];
      for (const step of steps) {
        const val = step === "h2h" ? (x => h2hPct(x, g)) : step === "div" ? divPct : (x => PF[x]);
        const v = new Map(g.map(x => [x, val(x)]));
        const keys = [...new Set(v.values())].sort((a, b) => b - a);
        const parts = keys.map(k => g.filter(x => v.get(x) === k));
        if (trace) trace.push({ teams: g.slice(), step, vals: v, parts: parts.map(p => p.slice()), level: keys.length === 1 });
        if (step === "pf") return parts.flat();
        if (keys.length > 1) return parts.flatMap(resolve);
      }
      return g.slice();
    };
    const s = list.slice().sort((a, b) => W[b] - W[a] || PF[b] - PF[a]);
    const out = [];
    for (let k = 0; k < s.length;) {
      let e = k + 1;
      while (e < s.length && W[s[e]] === W[s[k]]) e++;
      if (e - k === 1) out.push(s[k]);
      else for (const x of resolve(s.slice(k, e))) out.push(x);
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

  const RULE_TEXT = "wins (a tie counts half); two teams level: head to head, then — if they share a division — division record, then points for; three or more level: combined head to head among the tied teams (win % in games among them; none played = .500), then — only if all share a division — division record, then points for; when a step separates some teams, each group still level starts the rule over by its own size";

  globalThis.DFFLTiebreak = { tieOrder, divisionRecord, h2hFromGames, rankStandings, gamesFromMatchups, RULE_TEXT };
})();

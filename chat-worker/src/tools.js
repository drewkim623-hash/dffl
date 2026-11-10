// Tools the model can call. Each one fetches only allowlisted URLs, built here
// from fixed paths; the model never supplies a URL. Results are small objects
// with a `source` label and an `as_of` time.
import HISTORY from "../data/matchup-history.json";
import TRADES from "../data/trades-2026.json";

const SLEEPER = "https://api.sleeper.app/v1";
const RAW = "https://raw.githubusercontent.com/drewkim623-hash/dffl/main";
const DERIVED = "https://dffl-chat.internal/derived/"; // Cache API key space only, never fetched

// TTLs in seconds. Live/current-week data stays short; settled history long.
const TTL = { live: 45, league: 600, repo: 300, settled: 86400 };

// Every subrequest (fetch, cache match, cache put) counts against the Free
// plan's 50 per request. Anthropic calls get their own reserve in index.js.
export function toolCtx(env, ctx, budget) {
  return { env, ctx, memo: new Map(), budget, sources: new Set(), asOfs: [] };
}

function spend(c, n = 1) {
  if (c.budget.used + n > c.budget.max) throw new Error("subrequest budget for this question is used up; answer with what you have");
  c.budget.used += n;
}

function allowed(env, url) {
  if (/\/players\/nfl\b/.test(url)) return false; // the 5MB dump; never needed
  return url.startsWith(SLEEPER + "/") || url.startsWith(env.DATA_BASE_URL + "/") || url.startsWith(RAW + "/");
}

// Cache API first, then the network. Memoized per request so one question
// never fetches the same URL twice. Returns { data, at } where `at` is when
// the bytes were fetched from the origin.
async function getJson(c, url, ttl) {
  if (!allowed(c.env, url)) throw new Error("blocked url");
  if (c.memo.has(url)) return c.memo.get(url);
  const p = (async () => {
    const cache = caches.default;
    spend(c);
    const hit = await cache.match(url);
    if (hit) return { data: await hit.json(), at: hit.headers.get("x-fetched-at") };
    spend(c);
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`upstream HTTP ${r.status}`);
    const text = await r.text();
    const at = new Date().toISOString();
    if (c.budget.used < c.budget.max) {
      spend(c);
      c.ctx.waitUntil(cache.put(url, new Response(text, { headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}`, "x-fetched-at": at } })));
    }
    return { data: JSON.parse(text), at };
  })();
  c.memo.set(url, p);
  try { return await p; } catch (e) { c.memo.delete(url); throw e; }
}

// Repo file from GitHub Pages, raw.githubusercontent.com as the fallback.
async function repo(c, path) {
  try { return await getJson(c, `${c.env.DATA_BASE_URL}/${path}`, TTL.repo); }
  catch (e) { if (/budget/.test(e.message)) throw e; return getJson(c, `${RAW}/${path}`, TTL.repo); }
}

// A small slice computed from a big file, cached on its own so the big
// JSON.parse (recaps.json is ~290KB) happens once per TTL, not per question.
async function derived(c, key, ttl, compute) {
  const url = DERIVED + encodeURIComponent(key);
  if (c.budget.used + 1 <= c.budget.max) {
    spend(c);
    const hit = await caches.default.match(url);
    if (hit) return hit.json();
  }
  const out = await compute();
  if (c.budget.used + 1 <= c.budget.max) {
    spend(c);
    c.ctx.waitUntil(caches.default.put(url, new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "cache-control": `max-age=${ttl}` } })));
  }
  return out;
}

const sleeper = (c, path, ttl = TTL.live) => getJson(c, SLEEPER + path, ttl);
const lid = c => c.env.CURRENT_LEAGUE_ID;
const r2 = n => Math.round(n * 100) / 100;
const norm = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

/* ------------------------------------------------------------ league */
async function state(c) { return (await sleeper(c, "/state/nfl")).data; }
async function leagueInfo(c) { return (await sleeper(c, `/league/${lid(c)}`, TTL.league)).data; }
async function currentSeason(c) { return String((await leagueInfo(c)).season); }

// Owners of the current league, keyed by owner_id, plus every name each owner
// has used in the snapshot seasons.
async function owners(c) {
  const [users, rosters] = await Promise.all([sleeper(c, `/league/${lid(c)}/users`, TTL.league), sleeper(c, `/league/${lid(c)}/rosters`)]);
  const by = {};
  for (const u of users.data) by[u.user_id] = { owner_id: u.user_id, name: u.display_name, team: u.metadata?.team_name || null, aliases: [] };
  const rid = {};
  for (const r of rosters.data) { rid[r.roster_id] = r.owner_id; if (by[r.owner_id]) by[r.owner_id].roster = r; }
  for (const s of Object.values(HISTORY.seasons)) for (const [oid, n] of Object.entries(s.names)) {
    by[oid] ||= { owner_id: oid, name: n, team: null, aliases: [] };
    if (n !== by[oid].name && !by[oid].aliases.includes(n)) by[oid].aliases.push(n);
  }
  return { by, rid, rosters: rosters.data, at: rosters.at };
}

function resolve(o, q) {
  if (!q) return null;
  const k = norm(q);
  const all = Object.values(o.by);
  return all.find(m => m.owner_id === q) || all.find(m => norm(m.name) === k) || all.find(m => norm(m.team) === k)
    || all.find(m => m.aliases.some(a => norm(a) === k))
    || all.find(m => k.length >= 3 && (norm(m.name).includes(k) || norm(m.team).includes(k))) || null;
}
const who = m => ({ owner_id: m.owner_id, manager: m.name, ...(m.aliases.length ? { also_known_as: m.aliases } : {}) });
function need(o, q, label) {
  const m = resolve(o, q);
  if (!m) throw new Error(`no manager matches ${label} "${String(q).slice(0, 40)}"`);
  return m;
}

const nameOf = (o, oid) => o.by[oid]?.name || oid;
const pts = (whole, dec) => r2((whole || 0) + (dec || 0) / 100);

// Pair a Sleeper /matchups/{week} response into games keyed by owner_id.
function pair(rows, rid) {
  const byM = {};
  for (const m of rows || []) if (m.matchup_id != null) (byM[m.matchup_id] ||= []).push(m);
  return Object.values(byM).filter(p => p.length === 2).map(([a, b]) => [rid[a.roster_id], r2(a.points || 0), rid[b.roster_id], r2(b.points || 0)]);
}

async function weekRows(c, week, st) {
  const settled = st.season === (await currentSeason(c)) && week < Number(st.week);
  return sleeper(c, `/league/${lid(c)}/matchups/${week}`, settled ? TTL.settled : TTL.live);
}

const snap = season => HISTORY.seasons[season];
const snapAsOf = () => HISTORY.generated;

/* ------------------------------------------------------------ player names */
async function playerMap(c) { return repo(c, "rosters.json"); }
function rosterPlayers(r, map) {
  const one = pid => { const p = map[pid] || {}; return { id: pid, name: p.n || pid, pos: p.p || null, team: p.t || null, ...(p.s ? { status: p.s } : {}) }; };
  const st = new Set(r.starters || []), ir = new Set(r.reserve || []);
  return {
    starters: (r.starters || []).filter(x => x && x !== "0").map(one),
    bench: (r.players || []).filter(p => !st.has(p) && !ir.has(p)).map(one),
    ir: (r.reserve || []).map(one),
  };
}

/* ------------------------------------------------------------ tools */
const T = {
  async get_league_settings(c) {
    const lg = await leagueInfo(c);
    const s = lg.settings || {};
    return {
      source: "Sleeper league", as_of: new Date().toISOString(),
      name: lg.name, season: lg.season, status: lg.status, total_rosters: lg.total_rosters,
      settings: { playoff_week_start: s.playoff_week_start, playoff_teams: s.playoff_teams, waiver_budget: s.waiver_budget, trade_deadline: s.trade_deadline, divisions: s.divisions, last_scored_leg: s.last_scored_leg, leg: s.leg },
      roster_positions: lg.roster_positions, scoring_settings: lg.scoring_settings,
    };
  },

  async get_nfl_state(c) {
    const st = await state(c);
    return { source: "Sleeper NFL state", as_of: new Date().toISOString(), season: st.season, week: st.week, display_week: st.display_week, season_type: st.season_type };
  },

  async get_standings(c, { season } = {}) {
    const cur = await currentSeason(c);
    if (!season || String(season) === cur) {
      const o = await owners(c);
      const rows = o.rosters.map(r => ({ ...who(o.by[r.owner_id] || { owner_id: r.owner_id, name: r.owner_id, aliases: [] }), team: o.by[r.owner_id]?.team || null,
        wins: r.settings.wins, losses: r.settings.losses, ties: r.settings.ties,
        points_for: pts(r.settings.fpts, r.settings.fpts_decimal), points_against: pts(r.settings.fpts_against, r.settings.fpts_against_decimal) }));
      rows.sort((a, b) => b.wins - a.wins || b.points_for - a.points_for);
      return { source: `Sleeper rosters ${cur}`, as_of: o.at, season: cur, standings: rows };
    }
    const s = snap(String(season));
    if (!s) return { error: `no data for season ${season}`, seasons_available: [...Object.keys(HISTORY.seasons), cur] };
    const t = {};
    const row = oid => (t[oid] ||= { owner_id: oid, manager: s.names[oid], wins: 0, losses: 0, ties: 0, points_for: 0, points_against: 0 });
    for (const [w, a, pa, b, pb] of s.games) {
      if (s.playoff_week_start && w >= s.playoff_week_start) continue;
      const A = row(a), B = row(b);
      A.points_for += pa; A.points_against += pb; B.points_for += pb; B.points_against += pa;
      if (pa > pb) { A.wins++; B.losses++; } else if (pb > pa) { B.wins++; A.losses++; } else { A.ties++; B.ties++; }
    }
    const rows = Object.values(t).map(r => ({ ...r, points_for: r2(r.points_for), points_against: r2(r.points_against) }));
    rows.sort((a, b) => b.wins - a.wins || b.points_for - a.points_for);
    return { source: `matchup-history snapshot ${season}`, as_of: snapAsOf(), season: String(season), note: "regular season only, computed from game scores; names are each owner's current display name", standings: rows };
  },

  async get_matchups(c, { season, week }) {
    week = Number(week);
    if (!(week >= 1 && week <= 18)) return { error: "week must be 1-18" };
    const cur = await currentSeason(c);
    if (!season || String(season) === cur) {
      const [o, st] = await Promise.all([owners(c), state(c)]);
      const rows = await weekRows(c, week, st);
      const live = st.season === cur && week >= Number(st.week);
      return { source: `Sleeper matchups ${cur} week ${week}`, as_of: rows.at, season: cur, week, in_progress_or_future: live,
        games: pair(rows.data, o.rid).map(([a, pa, b, pb]) => ({ a: nameOf(o, a), a_owner_id: a, a_points: pa, b: nameOf(o, b), b_owner_id: b, b_points: pb })) };
    }
    const s = snap(String(season));
    if (!s) return { error: `no data for season ${season}` };
    return { source: `matchup-history snapshot ${season} week ${week}`, as_of: snapAsOf(), season: String(season), week,
      playoffs: !!(s.playoff_week_start && week >= s.playoff_week_start),
      games: s.games.filter(g => g[0] === week).map(([, a, pa, b, pb]) => ({ a: s.names[a], a_owner_id: a, a_points: pa, b: s.names[b], b_owner_id: b, b_points: pb })) };
  },

  async get_head_to_head(c, { manager_a, manager_b }) {
    const [o, st] = await Promise.all([owners(c), state(c)]);
    const A = need(o, manager_a, "manager_a"), B = need(o, manager_b, "manager_b");
    const games = [];
    for (const [season, s] of Object.entries(HISTORY.seasons)) for (const [w, a, pa, b, pb] of s.games) {
      const po = !!(s.playoff_week_start && w >= s.playoff_week_start);
      if (a === A.owner_id && b === B.owner_id) games.push({ season, week: w, a_points: pa, b_points: pb, playoffs: po });
      else if (a === B.owner_id && b === A.owner_id) games.push({ season, week: w, a_points: pb, b_points: pa, playoffs: po });
    }
    // Current season, live. One /matchups call per played week; completed weeks cache for a day.
    const cur = await currentSeason(c);
    let liveAt = null;
    const missing = [];
    if (st.season === cur) {
      const lg = await leagueInfo(c);
      const last = Math.min(Number(st.week) || 0, Number(lg.settings?.playoff_week_start || 15) + 2);
      const weeks = Array.from({ length: last }, (_, i) => i + 1);
      const res = await Promise.all(weeks.map(w => weekRows(c, w, st).catch(() => null)));
      res.forEach((r, i) => {
        if (!r) { missing.push(weeks[i]); return; }
        liveAt = r.at > (liveAt || "") ? r.at : liveAt;
        for (const [a, pa, b, pb] of pair(r.data, o.rid)) {
          const w = weeks[i], po = w >= Number(lg.settings?.playoff_week_start || 15), live = w >= Number(st.week);
          if (a === A.owner_id && b === B.owner_id) games.push({ season: cur, week: w, a_points: pa, b_points: pb, playoffs: po, ...(live ? { in_progress: true } : {}) });
          else if (a === B.owner_id && b === A.owner_id) games.push({ season: cur, week: w, a_points: pb, b_points: pa, playoffs: po, ...(live ? { in_progress: true } : {}) });
        }
      });
    }
    const rec = list => list.filter(g => !g.in_progress).reduce((r, g) => (g.a_points > g.b_points ? r.a_wins++ : g.b_points > g.a_points ? r.b_wins++ : r.ties++, r), { a_wins: 0, b_wins: 0, ties: 0 });
    return {
      source: `matchup-history snapshot 2022-2025 + Sleeper matchups ${cur}`, as_of: liveAt || snapAsOf(), snapshot_as_of: snapAsOf(),
      a: who(A), b: who(B),
      ...(missing.length ? { incomplete: `could not load ${cur} weeks ${missing.join(", ")}; the record below leaves them out` } : {}),
      regular_season: rec(games.filter(g => !g.playoffs)), playoffs_and_consolation: rec(games.filter(g => g.playoffs)), all_games: rec(games),
      games,
    };
  },

  async get_roster(c, { manager, week }) {
    const [o, map] = await Promise.all([owners(c), playerMap(c)]);
    const m = need(o, manager, "manager");
    const r = m.roster;
    if (!r) return { error: `${m.name} has no roster this season` };
    if (week) {
      const st = await state(c);
      const rows = await weekRows(c, Number(week), st);
      const e = (rows.data || []).find(x => x.roster_id === r.roster_id);
      if (!e) return { error: `no week ${week} lineup` };
      return { source: `Sleeper matchups week ${week}`, as_of: rows.at, ...who(m), week: Number(week), points: r2(e.points || 0),
        starters: (e.starters || []).map((pid, i) => ({ name: map.data.map[pid]?.n || pid, pos: map.data.map[pid]?.p || null, points: r2(e.starters_points?.[i] || 0) })) };
    }
    return { source: "Sleeper rosters", as_of: o.at, names_as_of: map.data.generated, ...who(m), team: m.team, ...rosterPlayers(r, map.data.map) };
  },

  async get_odds(c) {
    const { data: d } = await repo(c, "data/odds-snapshot.json");
    return {
      source: `odds-snapshot week ${d.week}`, as_of: d.generated, season: d.season, week: d.week, decided_games: d.decided, remaining_games: d.remaining,
      teams: d.teams.map(t => ({ owner_id: t.uid, manager: t.manager, projected_wins: r2(t.wins), playoff_prob: r2(t.playoffNow), title_prob: r2(t.titleNow), playoff_prob_prev: r2(t.playoffWas), title_prob_prev: r2(t.titleWas), title_odds: t.titleOdds, playoff_odds: t.playoffOdds }))
        .sort((a, b) => b.title_prob - a.title_prob),
      hurt: (d.hurt || []).map(h => ({ manager: h.manager, cost: r2(h.cost), players: h.players })),
    };
  },

  async get_odds_history(c, { manager, week }) {
    const o = manager ? await owners(c) : null;
    const m = manager ? need(o, manager, "manager") : null;
    const out = await derived(c, `oddshist:${m?.owner_id || ""}:${week || ""}`, TTL.repo, async () => {
      const { data: d } = await repo(c, "data/odds-history.json");
      const weeks = [];
      for (const [k, rows] of Object.entries(d.teams || {})) {
        const [season, w] = k.split("-");
        if (week && Number(w) !== Number(week)) continue;
        const last = {};
        for (const r of rows) if (!m || r.uid === m.owner_id) last[r.uid] = r; // last row per team is the week's close
        weeks.push({ season, week: Number(w), teams: Object.values(last).map(r => ({ owner_id: r.uid, manager: r.manager, playoff_prob: r2(r.playoff), title_prob: r2(r.title), at: r.at })) });
      }
      weeks.sort((a, b) => a.season.localeCompare(b.season) || a.week - b.week);
      return { as_of: d.generated, weeks };
    });
    return { source: "odds-history", ...out };
  },

  async get_injuries(c, { manager } = {}) {
    const [o, inj, ret, pulse, odds] = await Promise.all([owners(c), repo(c, "injuries.json"), repo(c, "injury-returns.json"), repo(c, "data/pulse.json"), repo(c, "data/odds-snapshot.json")]);
    const m = manager ? need(o, manager, "manager") : null;
    const teams = [];
    for (const r of o.rosters) {
      if (m && r.owner_id !== m.owner_id) continue;
      const st = new Set(r.starters || []);
      const hurt = [];
      for (const pid of r.players || []) {
        const i = inj.data.map[pid];
        if (!i || !i.s) continue;
        const e = ret.data.entries?.[pid];
        hurt.push({ name: i.n, pos: i.p, team: i.t, status: i.s, ...(i.bp ? { body_part: i.bp } : {}), starter: st.has(pid),
          ...(i.ret ? { expected_return: i.ret, return_estimated: !!i.retEstimated } : {}),
          ...(e ? { weeks_out: e.weeks, return_checked: e.checked, return_note: String(e.note || "").slice(0, 140) } : {}) });
      }
      const name = nameOf(o, r.owner_id);
      teams.push({ owner_id: r.owner_id, manager: name, hurt,
        pulse_starters_hurt: pulse.data.standings?.find(s => s.manager === name)?.starters_hurt || [],
        odds_hurt: odds.data.hurt?.find(h => h.manager === name)?.players || [] });
    }
    return { source: "injuries.json + injury-returns.json + pulse + odds-snapshot", as_of: inj.data.generated, pulse_as_of: pulse.data.generated, odds_as_of: odds.data.generated, roster_as_of: o.at, teams };
  },

  async get_projections(c, { manager, player, week } = {}) {
    if (!manager && !player) return { error: "give a manager or a player" };
    const [o, proj, inj, map] = await Promise.all([owners(c), repo(c, "data/projections.json"), repo(c, "injuries.json"), playerMap(c)]);
    const P = proj.data, wk = String(week || P.current_week);
    const base = { source: `projections week ${wk}`, as_of: P.generated, season: P.season, scoring: P.scoring, current_week: P.current_week, sunday: P.sundays?.[wk] || null };
    const info = pid => { const i = inj.data.map[pid]; const n = map.data.map[pid] || {};
      return { name: n.n || i?.n || pid, pos: n.p || i?.p, team: n.t || i?.t, ...(i?.s ? { status: i.s } : {}), ...(i?.ret ? { expected_return: i.ret } : {}) }; };
    if (player) {
      const k = norm(player);
      const ids = Object.keys(map.data.map).filter(pid => norm(map.data.map[pid].n).includes(k)).slice(0, 4);
      if (!ids.length) return { ...base, error: `no rostered player matches "${String(player).slice(0, 40)}"` };
      return { ...base, players: ids.map(pid => {
        const r = o.rosters.find(x => (x.players || []).includes(pid));
        const by = {};
        for (const [w, row] of Object.entries(P.weeks || {})) if (pid in row) by[w] = row[pid];
        return { ...info(pid), manager: r ? nameOf(o, r.owner_id) : null, projected_by_week: by, last_nonzero: P.last_nonzero?.[pid] || null };
      }) };
    }
    const m = need(o, manager, "manager");
    const r = m.roster;
    if (!r) return { ...base, error: `${m.name} has no roster this season` };
    const row = P.weeks?.[wk] || {}, st = new Set(r.starters || []);
    const list = (r.players || []).map(pid => ({ ...info(pid), starter: st.has(pid), projected: pid in row ? row[pid] : null }))
      .sort((a, b) => (b.projected ?? -1) - (a.projected ?? -1));
    return { ...base, ...who(m), week: Number(wk), players: list };
  },

  async get_recap(c, { season, week }) {
    season = String(season || await currentSeason(c));
    const out = await derived(c, `recap:${season}:${week}`, TTL.repo, async () => {
      const { data: d } = await repo(c, "recaps.json");
      const w = (d.weeks || []).find(x => String(x.season) === season && Number(x.week) === Number(week));
      if (!w) return { error: `no published recap for ${season} week ${week}`, published: (d.weeks || []).map(x => `${x.season}-${x.week}`) };
      return { season, week: Number(week), note: w.note || undefined, lede: w.lede,
        games: (w.games || []).map(g => ({ headline: g.headline, winner: g.winner, winner_points: g.winner_points, loser: g.loser, loser_points: g.loser_points, body: String(g.body || "").slice(0, 500) })),
        around: (w.around || []).map(a => ({ kind: a.kind, headline: a.headline, body: String(a.body || "").slice(0, 300) })) };
    });
    return { source: `recaps ${season} week ${week}`, as_of: null, note_on_time: "recap prose has no generated time; cite season and week", ...out };
  },

  async get_rankings(c, { season, week } = {}) {
    const { data: d, at } = await repo(c, "rankings.json");
    const s = String(season || await currentSeason(c));
    const ws = (d.weeks || []).filter(x => String(x.season) === s);
    const w = week ? ws.find(x => Number(x.week) === Number(week)) : ws.sort((a, b) => b.week - a.week)[0];
    if (!w) return { error: `no rankings for ${s}${week ? ` week ${week}` : ""}`, published: ws.map(x => x.week) };
    return { source: `rankings ${s} week ${w.week}`, as_of: at, season: s, week: w.week, teams: w.teams.map((t, i) => ({ rank: i + 1, manager: t.manager, blurb: String(t.blurb || "").slice(0, 400) })) };
  },

  async get_keepers(c, { season, manager } = {}) {
    const { data: d, at } = await repo(c, "keepers.json");
    const s = String(season || await currentSeason(c));
    const list = d.seasons?.[s];
    if (!list) return { error: `no keeper list for ${s}`, seasons: Object.keys(d.seasons || {}) };
    const byName = {};
    for (const [pid, p] of Object.entries(d.players || {})) byName[norm(p.name)] = { player_id: pid, years_kept: p.yearsKept, base_round: p.baseRound, next_cost_round: p.nextCostRound, regressed: p.regressed };
    let keys = Object.keys(list);
    let alias = null;
    if (manager) {
      const o = await owners(c);
      const m = resolve(o, manager);
      const names = m ? [m.name, ...m.aliases] : [manager];
      keys = keys.filter(k => names.some(n => norm(n) === norm(k)));
      if (m && keys[0] && keys[0] !== m.name) alias = `keepers.json lists ${m.name} under the old name "${keys[0]}"`;
      if (!keys.length) return { error: `no keepers listed for ${manager} in ${s}` };
    }
    return { source: `keepers ${s}`, as_of: at, season: s, scope: `start-of-season keepers: who was kept going into the ${s} season`,
      not: "not current ownership (use get_roster / search_player) and not current keeper rights (use get_trades)",
      ...(alias ? { name_change: alias } : {}),
      keepers: Object.fromEntries(keys.map(k => [k, list[k].map(n => ({ name: n, ...(byName[norm(n)] || {}) }))])),
      exceptions: d.exceptions };
  },

  // Bundled 2026 trade log + off-Sleeper rights (data/trades-2026.json). No fetches.
  async get_trades(c, { player, manager, other_manager, trade } = {}) {
    const base = { source: "trades-2026 log (FACTS research files)", as_of: TRADES.generated, scope: TRADES.scope, status_key: TRADES.status_key,
      keeper_rules: TRADES.keeper_rules, pick_values: TRADES.pick_values };
    const mgr = q => {
      if (!q) return null;
      const k = norm(q), nick = TRADES.nicknames[k];
      if (nick) return { name: nick.manager, ...(nick.status !== "confirmed by Drew" ? { identity: `${q} = ${nick.manager} is ${nick.status}` } : {}) };
      const all = [...new Set(TRADES.trades.flatMap(t => t.managers))];
      const hit = all.find(m => norm(m) === k) || (k.length >= 3 && all.find(m => norm(m).includes(k)));
      if (!hit) throw new Error(`no 2026 trade involves a manager matching "${String(q).slice(0, 40)}"`);
      return { name: hit };
    };
    const A = mgr(manager), B = mgr(other_manager);
    const p = player ? norm(player) : "";
    if (player && p.length < 3) return { error: "player name too short" };
    const n = trade != null ? Number(trade) : null;
    if (!p && !A && !B && n == null) {
      return { ...base, note: "every executed 2026 trade, one line each; ask with player, manager or trade for terms, rights and analysis",
        trades: TRADES.trades.map(t => ({ trade: t.trade, completed: t.completed, managers: t.managers, title: t.title })),
        rights: TRADES.rights.map(r => ({ player: r.player, trade: r.trade, rights_2027: r.rights_2027, roster_2026: r.roster_2026, status: r.status })) };
    }
    const hasP = s => p && norm(s).includes(p);
    const trades = TRADES.trades.filter(t => (n == null || t.trade === n)
      && (!A || t.managers.includes(A.name)) && (!B || t.managers.includes(B.name))
      && (!p || t.sides.some(s => hasP(s.receives)) || (Array.isArray(t.commissioner_notes) && t.commissioner_notes.some(x => hasP(x.player)))));
    const nums = new Set(trades.map(t => t.trade));
    const rights = TRADES.rights.filter(r => p ? hasP(r.player) : nums.has(r.trade));
    // Open items that name one of these managers or players (by last name: the list says "Puka", "Harrison").
    const last = s => s.replace(/ (?:Jr\.|Sr\.|II|III)$/, "").split(" ").pop();
    const terms = [A?.name, B?.name, ...rights.map(r => last(r.player))].filter(Boolean).map(norm);
    const unverified = TRADES.unverified.filter(u => terms.some(x => norm(u).includes(x)));
    return { ...base, ...(A?.identity || B?.identity ? { identity: [A?.identity, B?.identity].filter(Boolean) } : {}),
      ...(trades.length || rights.length ? {} : { note: "no 2026 trade or rights entry matches; trades outside 2026 are not covered" }),
      rights, trades, ...(unverified.length ? { unverified } : {}) };
  },

  async get_pulse(c) {
    const { data: d } = await repo(c, "data/pulse.json");
    return { source: `pulse week ${d.nfl_week}`, as_of: d.generated, season: d.season, nfl_week: d.nfl_week, week_in_progress: d.week_in_progress,
      standings: d.standings, this_week: d.this_week, free_agent_moves: d.free_agent_moves,
      trades: (d.trades || []).map(t => ({ week: t.week, managers: t.managers, adds: t.adds, drops: t.drops, picks: t.picks })) };
  },

  async get_week(c, { season, week }) {
    const s = String(season || await currentSeason(c));
    const w = Number(week);
    if (!(w >= 1 && w <= 18)) return { error: "week must be 1-18" };
    let d;
    try { d = (await repo(c, `data/week-${s}-${String(w).padStart(2, "0")}.json`)).data; }
    catch (e) { if (/budget/.test(e.message)) throw e; return { error: `no published week file for ${s} week ${w}` }; }
    const hl = x => x && { manager: x.manager, team: x.team, points: x.points };
    return { source: `week ${w}`, as_of: d.generated_at || d.generated, season: d.season, week: d.week, final: d.final, standings_through_week: d.standings_through_week,
      games: (d.games || []).map(g => ({ winner: g.winner, winner_points: g.winner_points, loser: g.loser, loser_points: g.loser_points, margin: g.margin })),
      standings: (d.standings || []).map(t => ({ manager: t.manager, team: t.team, wins: t.wins, losses: t.losses, ties: t.ties, points_for: t.points_for, points_against: t.points_against })),
      marquee: d.marquee ? Object.fromEntries(Object.entries(d.marquee).map(([k, v]) => [k, hl(v)])) : null };
  },

  async get_faab(c) {
    const [o, lg] = await Promise.all([owners(c), leagueInfo(c)]);
    const budget = Number(lg.settings?.waiver_budget) || 0;
    return { source: "Sleeper rosters", as_of: o.at, season: lg.season, waiver_budget: budget,
      teams: o.rosters.map(r => { const used = r.settings?.waiver_budget_used || 0; return { owner_id: r.owner_id, manager: nameOf(o, r.owner_id), used, remaining: budget - used }; })
        .sort((a, b) => b.remaining - a.remaining) };
  },

  async search_player(c, { name }) {
    const k = norm(name);
    if (k.length < 2) return { error: "name too short" };
    const [o, map] = await Promise.all([owners(c), playerMap(c)]);
    const hits = Object.entries(map.data.map).filter(([, p]) => norm(p.n).includes(k)).slice(0, 8);
    return { source: "rosters.json + Sleeper rosters", as_of: o.at, names_as_of: map.data.generated,
      note: hits.length ? undefined : "no rostered player matches; players not on a DFFL roster are not covered",
      players: hits.map(([pid, p]) => { const r = o.rosters.find(x => (x.players || []).includes(pid));
        return { name: p.n, pos: p.p, team: p.t, ...(p.s ? { status: p.s } : {}), manager: r ? nameOf(o, r.owner_id) : null, owner_id: r?.owner_id || null, on_ir: !!r?.reserve?.includes(pid) }; }) };
  },
};

export const TOOL_NAMES = Object.keys(T);

// Run one tool call. Always returns a string for the tool_result block.
export async function runTool(c, name, input) {
  const fn = T[name];
  if (!fn) return JSON.stringify({ error: `unknown tool ${name}` });
  try {
    const out = await fn(c, input && typeof input === "object" ? input : {});
    if (out.source) c.sources.add(out.source);
    if (out.as_of) c.asOfs.push(out.as_of);
    return JSON.stringify(out);
  } catch (e) {
    return JSON.stringify({ error: String(e?.message || e).slice(0, 200) });
  }
}

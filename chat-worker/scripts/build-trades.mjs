#!/usr/bin/env node
/**
 * One-off: writes chat-worker/data/trades-2026.json, the 2026 trade log with
 * off-Sleeper keeper rights, commissioner notes, clauses, keeper rules, 2027
 * keeper spots and historical pick values, so the chat can answer rights and
 * trade questions. Sleeper cannot record a rights transfer and keepers.json
 * rights[] is empty, so this is the only rights source the Worker has.
 *
 *   node chat-worker/scripts/build-trades.mjs
 *
 * Reads (read only; nothing in these trees is written):
 *   $TRADES_INPUTS/FACTS-season.md   every executed 2026 trade, Trade 17/18 notes, grades, pick values
 *   $TRADES_INPUTS/FACTS-short.md    clause notes (Puka, Evans, Harrison, Allen, Jeanty), 2027 spots, open items
 *   $TRADES_ARTICLE                  recaps.json holding the article every-2026-dffl-trade-through-week-nine
 *                                    (uncommitted on dev-trades-article when this was written; used as a cross-check)
 * Defaults: TRADES_INPUTS=/Users/drewkim/Desktop/dffl-worktrees/trades-inputs
 *           TRADES_ARTICLE=/Users/drewkim/Desktop/dffl-worktrees/dev-trades-article/recaps.json
 *
 * Trades, sides, dates, notes and grades are parsed from FACTS-season.md. The
 * RIGHTS table below restates FACTS terms per player; every note it quotes is
 * checked to appear verbatim in the FACTS files, and the script fails if one
 * does not. Not a weekly builder: rerun by hand when the FACTS files change,
 * then redeploy the Worker.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const INPUTS = process.env.TRADES_INPUTS || "/Users/drewkim/Desktop/dffl-worktrees/trades-inputs";
const ARTICLE = process.env.TRADES_ARTICLE || "/Users/drewkim/Desktop/dffl-worktrees/dev-trades-article/recaps.json";
const SLUG = "every-2026-dffl-trade-through-week-nine";
const OUT = new URL("../data/trades-2026.json", import.meta.url);

const season = await readFile(join(INPUTS, "FACTS-season.md"), "utf8");
const short = await readFile(join(INPUTS, "FACTS-short.md"), "utf8");
const plain = s => s.replace(/\*\*|`/g, "").replace(/\s+/g, " ").trim();
// Members never see Sleeper ids: drop transaction ids and the player ids in "(4984, QB BUF)".
const noIds = s => s.replace(/\s*\(transaction_id \d+\)/g, "").replace(/\s*\([^()]*\b(?:roster_id|owner_id|user_id)\b[^()]*\)/g, "").replace(/\((\d{3,6}), /g, "(").replace(/ \(\d{3,6}\)/g, "");
const fail = m => { throw new Error(m); };

// As-of: FACTS-short is the later file ("As of Tuesday, Nov 10, 2026, about 5:40 PM EST").
const asOf = (() => {
  const m = short.match(/As of \w+, (\w{3}) (\d+), (\d{4}), about (\d+):(\d+) (AM|PM) (EST|EDT)/) || fail("no as-of line in FACTS-short.md");
  const mon = "JanFebMarAprMayJunJulAugSepOctNovDec".indexOf(m[1]) / 3;
  const h = (Number(m[4]) % 12) + (m[6] === "PM" ? 12 : 0) + (m[7] === "EST" ? 5 : 4);
  return new Date(Date.UTC(Number(m[3]), mon, Number(m[2]), h, Number(m[5]))).toISOString();
})();

/* ------------------------------------------------------------ trades (FACTS-season §1) */
const sec1 = season.split("## 1. Every executed 2026 trade")[1]?.split("\n## 2.")[0] || fail("no §1 in FACTS-season.md");
const trades = sec1.split(/\n### Trade /).slice(1).map(block => {
  const [head, ...rest] = block.split("\n");
  const body = rest.join("\n");
  const hm = head.match(/^(\d+) — (.+)$/) || fail("bad trade heading: " + head);
  const n = Number(hm[1]);
  const done = body.match(/Complete (\w{3} \w{3} \d+, \d{4})/) || fail(`trade ${n}: no completion date`);
  const week = body.match(/`metadata` null\. Week (\d+)/);
  const sides = [...body.matchAll(/^- \*\*([\w.]+)\*\* receives: (.+)$/gm)].map(m => ({ manager: m[1], receives: noIds(plain(m[2])) }));
  if (sides.length < 2) fail(`trade ${n}: fewer than two sides`);
  const picks = body.match(/^- Picks: (.+)$/m);
  const follow = body.match(/^- Follow-on[^:]*: (.+)$/m) || body.match(/^Follow-on[^:]*: (.+)$/m);
  const notesBlock = body.split("**Commissioner notes")[1]?.split("\n\n**")[0] || "";
  const notes = /none on record/.test(notesBlock.split("\n")[0]) ? [] :
    [...notesBlock.matchAll(/^- ([A-Z][\w.' -]+?): `"([^`]*)"`(?: \(an earlier edit, on [\w.]+, said `"([^`]*)"`\))?/gm)]
      .map(m => ({ player: m[1], note: m[2], ...(m[3] ? { earlier_edit: m[3] } : {}) }));
  const grades = body.match(/^\*\*Grades:\*\* (.+)$/m) || fail(`trade ${n}: no grades line`);
  return {
    trade: n, title: hm[2], completed: done[1], ...(week ? { week: Number(week[1]) } : {}),
    managers: [...new Set(sides.map(s => s.manager))], sides,
    ...(picks && !/^none/i.test(picks[1]) ? { picks: plain(picks[1]) } : {}),
    ...(follow ? { follow_on: noIds(plain(follow[1])) } : {}),
    commissioner_notes: notes,
    analysis: { label: "analysis, not fact: FACTS-season.md letter grades as of Nov 10, 2026", grades: plain(grades[1]) },
  };
});
if (trades.length !== 18 || trades.some((t, i) => t.trade !== i + 1)) fail(`expected trades 1-18, got ${trades.map(t => t.trade)}`);

/* ------------------------------------------------------------ rights and clauses */
// Each `note` must appear verbatim (inside quotes) in FACTS-season.md or FACTS-short.md.
const RIGHTS = [
  { player: "Bijan Robinson", trade: 18, rights_2027: "drewkim", roster_2026: "Domo112",
    terms: "Bijan stays on Domo112's 2026 roster; his 2027 keeper rights went to drewkim.", cost_2027: "R1",
    note: "drew gets rights ", earlier_edit: "drew earns rights ", status: "confirmed by Drew; commissioner note" },
  { player: "Brock Bowers", trade: 18, rights_2027: "drewkim", roster_2026: "Domo112",
    terms: "Bowers went to Domo112 as a 2026-only loan; drewkim keeps his keeper rights.", cost_2027: "R4",
    note: "drew keeps rights,doesnt finish top 3 drew gets 9th instead of 7th", status: "confirmed by Drew; commissioner note",
    condition: {
      text: "If Bowers does not finish as a top-3 TE, drewkim gets Domo112's 2027 9th instead of Domo112's 2027 7th.",
      measured_by: "Bowers's own 2026 season finish among all TEs, league scoring (confirmed by Drew; not Domo's team finish)",
      status: "open",
      current: "TE2 through week 9 (weeks 1-9 scored): 146.00 points, 17.20 ahead of TE3 Isaiah Likely, 16.80 behind TE1 Trey McBride. Weeks 10-17 still to play, so not final.",
      value_gap: "historical R7 143.1 vs R9 124.5, 18.6 points" } },
  { player: "Jalen Coker", trade: 18, rights_2027: "Domo112", roster_2026: "drewkim",
    terms: "Coker went to drewkim as a 2026-only loan; Domo112 owns his keeper rights.", cost_2027: "R8",
    note: "dom owns rights ", status: "confirmed by Drew; commissioner note" },
  { player: "Antonio Williams", trade: 18, rights_2027: "Domo112", roster_2026: "Domo112",
    terms: "Williams went to Domo112 with his rights.", cost_2027: "R14",
    note: "dom gets rights", status: "confirmed by Drew; commissioner note" },
  { player: "Chris Olave", trade: 17, rights_2027: "chassinator", roster_2026: "chassinator",
    terms: "Via this trade saucebossandrew (Andrew) got chassinator's (Connor's) keeper spot: 2027 keeper spots saucebossandrew 4, chassinator 2.", cost_2027: "R1",
    note: "andrew gets connors keeper spot ", status: "confirmed by Drew (Andrew = saucebossandrew, Connor = chassinator, 4/2 spots); commissioner note" },
  { player: "Zay Flowers", trade: 17, rights_2027: "saucebossandrew", roster_2026: "chassinator",
    terms: "Commissioner note says Andrew (saucebossandrew) owns Flowers's rights. Flowers is on chassinator's 2026 roster.", cost_2027: "R2 (2026 draft round; not confirmed as the keep cost)",
    note: "andrew owns rights ", status: "commissioner note",
    unconfirmed: "How Andrew got the rights, whether they were part of Trade 17 or a separate deal, the keep cost, and whether anything else changed hands are unconfirmed." },
  { player: "Puka Nacua", trade: 12, rights_2027: "jskule23", roster_2026: "Domo112",
    terms: "Commissioner note says Joe keeps the rights; Joe = jskule23 is inferred.", cost_2027: "R12",
    note: "joe keeps rights, Puka misses 3 or more games or misses a playoff game pick becomes a third", status: "commissioner note",
    inferred: "Joe = jskule23 (email list plus the Puka/Evans/Allen notes; not a Sleeper display name)",
    condition: { text: "If Puka misses 3 or more games or misses a playoff game, the pick (Domo112's 2027 2nd, now with jskule23) becomes a third.", status: "open",
      current: "2 missed games on the season (weeks 2 and 3, both before the trade); 0 after the trade. The note does not say whether pre-trade misses count." } },
  { player: "Mike Evans", trade: 12, rights_2027: "Domo112", roster_2026: "jskule23",
    terms: "Commissioner note says Domo112 owns Evans's rights.", cost_2027: "R4",
    note: "dom owns rights, Mike Evans misses 3 or more games or misses a playoff Joe gets a 8th", status: "commissioner note",
    inferred: "Joe = jskule23",
    condition: { text: "If Evans misses 3 or more games or misses a playoff game, Joe gets an 8th.", status: "open",
      current: "2 missed games (weeks 7 and 9), both after the trade; week 8 was a bye and does not count." } },
  { player: "Marvin Harrison Jr.", trade: 12, rights_2027: "Domo112", roster_2026: "none (free agent)",
    terms: "Commissioner note says Domo112 owns Harrison's rights. Domo112 dropped Harrison on Nov 9, 2026.", cost_2027: null,
    note: "dom owns rights", status: "commissioner note",
    unconfirmed: "Whether the rights survive Domo112 dropping him on Nov 9 is unconfirmed." },
  { player: "Josh Allen", trade: 11, rights_2027: "jskule23", roster_2026: "jadencha",
    terms: "Commissioner note says Joe owns Allen's rights; Joe = jskule23 is inferred. Allen is on jadencha's 2026 roster.", cost_2027: "R2",
    note: "joe owns rights, 5th becomes 4th if finishes top 2 by end of week 17.", status: "commissioner note",
    inferred: "Joe = jskule23; if wrong, rights would default to jadencha, who rosters him",
    condition: { text: "jadencha's 2027 5th (now with jskule23) becomes a 4th if Allen finishes top 2 by end of week 17.", status: "open",
      current: "QB2 through week 9 (206.68 points), 2.46 behind QB1 Joe Burrow." } },
  { player: "Ashton Jeanty", trade: 9, rights_2027: "chassinator", roster_2026: "jadencha",
    terms: "Commissioner note (and chassinator in chat: \"And i keep rights.\") says chassinator owns Jeanty's rights.", cost_2027: "R1",
    note: "chass owns rights ", status: "commissioner note" },
];
const facts = season + "\n" + short;
for (const r of RIGHTS) for (const q of [r.note, r.earlier_edit].filter(x => x != null))
  if (!facts.includes(`"${q}"`)) fail(`${r.player}: note not found verbatim in FACTS: "${q}"`);
// Parsed Trade 17/18 notes must agree with the table. The clause notes for Trades 9, 11 and 12
// come from FACTS-short.md (FACTS-season.md had "none on record" before those screenshots).
for (const t of trades) {
  for (const cn of t.commissioner_notes) {
    const r = RIGHTS.find(x => x.player === cn.player && x.trade === t.trade);
    if (!r || r.note !== cn.note) fail(`trade ${t.trade} ${cn.player}: parsed note "${cn.note}" does not match the RIGHTS table`);
  }
  for (const r of RIGHTS) if (r.trade === t.trade && !t.commissioner_notes.some(cn => cn.player === r.player))
    t.commissioner_notes.push({ player: r.player, note: r.note, source: "FACTS-short.md clause screenshots" });
  if (!t.commissioner_notes.length) t.commissioner_notes = "none on record";
}
// Off-Sleeper terms FACTS-short.md adds to a trade. The quoted phrase must appear in FACTS.
const EXTRA = {
  2: { phrase: "paid for a keeper spot", text: "Drew says this ticket paid for a keeper spot. Who sold a 2026 or 2027 slot is not in Sleeper, and it conflicts with the confirmed 2027 spots (saucebossandrew 4, chassinator 2, everyone else 3): unresolved.", status: "unconfirmed" },
};
for (const [n, x] of Object.entries(EXTRA)) {
  if (!short.includes(x.phrase)) fail(`trade ${n}: phrase not in FACTS-short.md: ${x.phrase}`);
  trades[n - 1].off_sleeper = { text: x.text, status: x.status };
}

/* ------------------------------------------------------------ rules, spots, pick values */
const pv = {};
for (const m of season.matchAll(/\| (\d+) \| ([\d.]+) \| (\d+) \| ([\d.]+) \| (\d+) \| ([\d.]+) \|/g))
  for (const i of [1, 3, 5]) pv[m[i]] = Number(m[i + 1]);
if (Object.keys(pv).length !== 15) fail("pick value table: expected 15 rounds");
const pvShort = short.match(/R1 236\.8[^)]*/)?.[0] || "";
for (const [r, v] of Object.entries(pv)) if (!pvShort.includes(`R${r} ${v}`)) fail(`pick value R${r} ${v} differs between FACTS files`);

const regression = plain(season.match(/\*\*2027 regression rule\*\* \([^)]*\): (.+)$/m)?.[1] || fail("no regression rule"));
// First two sentences only: the spots, and that Sleeper / keepers.json do not encode them.
const spotsLine = plain(short.match(/\*\*2027 keeper spots \(Drew confirmed; these numbers win\):\*\* (.+)$/m)?.[1] || fail("no 2027 spots line"))
  .split(/(?<=\.) /).slice(0, 2).join(" ");

const unknown = short.split("## Unknown, unconfirmed, or where sources disagree")[1] || fail("no unknown list");
const unverified = [...unknown.matchAll(/^\d+\. (.+)$/gm)].map(m => plain(m[1]));
const flowersOpen = season.match(/^- \*\*Flowers rights terms beyond[^\n]+/m)?.[0];
if (flowersOpen) unverified.push(plain(flowersOpen.slice(2)));

/* ------------------------------------------------------------ article cross-check */
let article = null;
try {
  const rec = JSON.parse(await readFile(ARTICLE, "utf8"));
  const a = (rec.articles || []).find(x => x.slug === SLUG);
  if (a) {
    const heads = (a.blocks || []).filter(b => b.type === "h" && /completed/i.test(b.eyebrow || "")).length;
    if (heads && heads !== trades.length) console.warn(`warning: article lists ${heads} trades, FACTS has ${trades.length}`);
    article = { slug: a.slug, headline: a.headline, date: a.date, committed: false, trades_in_article: heads || null };
  } else console.warn(`warning: ${SLUG} not found in ${ARTICLE}`);
} catch (e) { console.warn(`warning: could not read ${ARTICLE}: ${e.message}`); }

const out = {
  generated: asOf,
  source: "trades-inputs FACTS-season.md + FACTS-short.md (read-only research files, Nov 10, 2026)",
  article,
  scope: "Every executed (complete) 2026 trade through week 9, plus off-Sleeper keeper rights and clauses. Drew's reported Bowers deal with jadencha never happened and is not listed.",
  nicknames: {
    andrew: { manager: "saucebossandrew", status: "confirmed by Drew" },
    connor: { manager: "chassinator", status: "confirmed by Drew" },
    joe: { manager: "jskule23", status: "inferred" },
  },
  status_key: {
    "confirmed by Drew": "Drew confirmed the terms",
    "commissioner note": "quoted from a commissioner player note screenshot; taken at face value, reported by the managers",
    inferred: "a reasonable reading, not on any record; say it is inferred",
    unconfirmed: "not verified; say so, never state as fact",
  },
  keeper_rules: {
    default_keepers: 3,
    spots_2027: { saucebossandrew: 4, chassinator: 2, everyone_else: 3, status: "confirmed by Drew", text: spotsLine },
    regression_2027: regression,
    matching_pick: "A keeper uses the matching-round pick. If a team no longer owns a pick of that round, it cannot keep the player unless it acquired someone else's pick of that round.",
    years_travel_with_player: "TRADE_RESETS_YEARS is false: years kept travel with the player unless a side deal says the rights sit with someone else.",
    keepers_json: "keepers.json is the start-of-2026-season keeper list (who was kept going into 2026). It is not current ownership and not current rights; its rights[] is empty.",
    cost_basis: "2027 keep cost: keepers.json nextCostRound when present (includes regression), otherwise the player's 2026 draft round.",
  },
  pick_values: { label: "historical 2023-25 non-keeper average season points by draft round, DFFL scoring (FACTS-season.md); used as pick values", rounds: pv },
  rights: RIGHTS,
  trades,
  unverified,
};
await writeFile(OUT, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${OUT.pathname}: ${trades.length} trades, ${RIGHTS.length} rights entries, ${unverified.length} open items, ${JSON.stringify(out).length} bytes`);

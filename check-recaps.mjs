/**
 * Check recaps.json's article teasers before it is pushed. Read-only; needs no
 * network, sends nothing.
 *
 *   node check-recaps.mjs        # exit 0 = fine, 1 = something to fix
 *
 * Every article needs a unique slug and a teaser in the breaking-news shape
 * (TEASER_SHAPE): plain text, at most 600 characters, no HTML, three stat lines
 * whose numbers all appear in the article, and the article's own ?a=<slug>
 * link last — the form that opens the piece on a direct load. A `tiers` block
 * (the default odds graphic) needs a title, named tiers, rows with a team and a
 * 0-100 pct, and an intro of one short line (tiersProblems).
 */
import { readFile } from "fs/promises";

export const SITE = "https://drewkim623-hash.github.io/dffl/";
export const TEASER_MAX = 600;
/** The address a teaser links to: ?a=<slug> opens the piece on a direct load. */
export const teaserLink = slug => `${SITE}?a=${encodeURIComponent(slug)}`;
export const TEASER_SHAPE = `🚨 DFFL | WEEK n      (or PRESEASON before week 1)

HEADLINE IN CAPS

<emoji> stat line 1
<emoji> stat line 2
<emoji> stat line 3

Full story 👇
${SITE}?a=<slug>`;

const plainText = o => typeof o === "string" ? o.replace(/<[^>]+>/g, " ")
  : Array.isArray(o) ? o.map(plainText).join(" ") : o && typeof o === "object" ? Object.values(o).map(plainText).join(" ") : "";
const NUM = /\d[\d,]*(?:\.\d+)?/g;
const STAT_LINE = /^\p{Extended_Pictographic}️?\s+\S/u;

/** Every problem with one article's teaser, as sentences; empty when it is fine. */
export function teaserProblems(a, slugs) {
  const out = [], t = a && a.teaser;
  if (typeof t !== "string" || !t.trim()) return ["has no teaser"];
  if (t.length > TEASER_MAX) out.push(`teaser is ${t.length} characters (limit ${TEASER_MAX})`);
  if (/<\/?[a-z][^>]*>|&[a-z#0-9]+;/i.test(t)) out.push("teaser contains HTML");
  const L = t.split("\n");
  if (L.length !== 10) return [...out, `teaser has ${L.length} lines; the shape is these 10:\n${TEASER_SHAPE}`];
  const head = /^🚨 DFFL \| (?:WEEK (\d{1,2})|PRESEASON)$/.exec(L[0]);
  if (!head) out.push(`teaser's first line is not "🚨 DFFL | WEEK n" (or PRESEASON): ${JSON.stringify(L[0])}`);
  // The kicker counts as the article's own words: "2026 · week 2 waivers" names the week.
  const body = plainText([a.headline, a.kicker, a.dek, a.standfirst, a.blocks]);
  if (head && head[1] && !new RegExp(`\\bweek ${Number(head[1])}\\b`, "i").test(body))
    out.push(`teaser says WEEK ${head[1]}, which the article never mentions`);
  if (!L[2].trim() || L[2] !== plainText(a.headline || "").toUpperCase())
    out.push("teaser's third line is not the headline in capitals");
  for (const i of [1, 3, 7]) if (L[i] !== "") out.push(`teaser line ${i + 1} must be blank`);
  // Every number on a stat line has to be one the article itself prints.
  const nums = new Set((body.match(NUM) || []).map(n => n.replace(/,/g, "")));
  for (const i of [4, 5, 6]) {
    if (!STAT_LINE.test(L[i])) out.push(`teaser line ${i + 1} is not an emoji and a stat`);
    const own = (L[i].match(NUM) || []).map(n => n.replace(/,/g, ""));
    if (!own.length) out.push(`teaser line ${i + 1} carries no number`);
    for (const n of own) if (!nums.has(n)) out.push(`teaser line ${i + 1} says ${n}, which is not in the article`);
  }
  if (L[8] !== "Full story 👇") out.push(`teaser line 9 is not "Full story 👇"`);
  if (L[9] !== teaserLink(a.slug)) out.push(`teaser's last line is not ${teaserLink(a.slug)}`);
  const m = /\?a=([^\s#&]+)$/.exec(L[9]);
  if (m && slugs && !slugs.has(decodeURIComponent(m[1]))) out.push(`teaser links to ${m[1]}, which is not an article`);
  return out;
}

/** Every problem in recaps.json's articles, prefixed with the slug. */
export function recapsProblems(j) {
  const out = [], arts = (j && j.articles) || [];
  const slugs = new Set();
  for (const a of arts) {
    if (!a.slug) out.push(`"${a.headline}": has no slug`);
    else if (slugs.has(a.slug)) out.push(`${a.slug}: slug is used twice`);
    slugs.add(a.slug);
  }
  for (const a of arts) for (const p of teaserProblems(a, slugs)) out.push(`${a.slug}: ${p}`);
  for (const a of arts) for (const b of a.blocks || []) if (b && b.type === "tiers")
    for (const p of tiersProblems(b)) out.push(`${a.slug}: ${p}`);
  return out;
}

/** The longest intro a tiers block may carry: one short line. Detail goes in `foot`. */
export const TIERS_INTRO_MAX = 80;
const pct01 = v => typeof v === "number" && v >= 0 && v <= 100;

/**
 * Every problem with one tiers block (the default odds graphic; see
 * docs/graphics-standard.md). `handles`, when given, is the set of manager
 * display_names a row's team must be one of.
 */
export function tiersProblems(b, handles) {
  const out = [];
  if (typeof b.title !== "string" || !b.title.trim()) out.push("a tiers block has no title");
  // intro/foot may also be written sub/note, the names the reference port used.
  const intro = b.intro ?? b.sub, foot = b.foot ?? b.note;
  if (intro != null && (typeof intro !== "string" || intro.length > TIERS_INTRO_MAX || /\n/.test(intro)))
    out.push(`a tiers intro is one short line (at most ${TIERS_INTRO_MAX} characters); move the detail to foot`);
  if (foot != null && typeof foot !== "string") out.push("a tiers foot must be a string");
  if (b.href != null && !/^(https:\/\/|#)/.test(b.href)) out.push("a tiers href must be https or #");
  const tiers = Array.isArray(b.tiers) ? b.tiers : [];
  if (!tiers.length) out.push("a tiers block has no tiers");
  for (const t of tiers) if (!t || typeof t.name !== "string" || !t.name.trim()) out.push("a tier has no name");
  const rows = tiers.flatMap(t => (t && t.rows) || []);
  if (!rows.length) out.push("a tiers block has no rows");
  for (const r of rows) {
    if (typeof r.team !== "string" || !r.team.trim()) { out.push("a tiers row has no team"); continue; }
    if (!pct01(r.pct)) out.push(`tiers row ${r.team} has pct ${JSON.stringify(r.pct)}, not 0-100`);
    if (r.last != null && !pct01(r.last)) out.push(`tiers row ${r.team} has last ${JSON.stringify(r.last)}, not 0-100`);
    if (r.bye != null && !pct01(r.bye)) out.push(`tiers row ${r.team} has bye ${JSON.stringify(r.bye)}, not 0-100`);
    if (r.status != null && !["bye", "in", "out"].includes(r.status)) out.push(`tiers row ${r.team} has status ${JSON.stringify(r.status)}`);
    if (r.seed != null && !(Number.isInteger(r.seed) && r.seed >= 1 && r.seed <= rows.length)) out.push(`tiers row ${r.team} has seed ${JSON.stringify(r.seed)}`);
    if (handles && handles.size && !handles.has(r.team.toLowerCase())) out.push(`tiers team ${JSON.stringify(r.team)} is not a manager`);
  }
  const seeds = rows.filter(r => r.seed != null).map(r => r.seed);
  if (new Set(seeds).size !== seeds.length) out.push("a tiers block repeats a seed");
  if (b.cutAfter && !rows.some(r => String(r.team).toLowerCase() === String(b.cutAfter).toLowerCase()))
    out.push(`tiers cutAfter ${b.cutAfter} is not one of its rows`);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const j = JSON.parse(await readFile("recaps.json", "utf8"));
  const bad = recapsProblems(j);
  for (const p of bad) console.log(`FAIL  ${p}`);
  console.log(bad.length ? `\n${bad.length} problem(s)` : `ok  ${(j.articles || []).length} articles, every teaser in shape`);
  process.exit(bad.length ? 1 : 0);
}

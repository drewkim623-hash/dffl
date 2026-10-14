/**
 * Check recaps.json's article teasers before it is pushed. Read-only; needs no
 * network, sends nothing.
 *
 *   node check-recaps.mjs        # exit 0 = fine, 1 = something to fix
 *
 * Every article needs a unique slug and a teaser in the breaking-news shape
 * (TEASER_SHAPE): plain text, at most 600 characters, no HTML, three stat lines
 * whose numbers all appear in the article, and the article's own ?a=<slug>
 * link last — the form that opens the piece on a direct load.
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
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const j = JSON.parse(await readFile("recaps.json", "utf8"));
  const bad = recapsProblems(j);
  for (const p of bad) console.log(`FAIL  ${p}`);
  console.log(bad.length ? `\n${bad.length} problem(s)` : `ok  ${(j.articles || []).length} articles, every teaser in shape`);
  process.exit(bad.length ? 1 : 0);
}

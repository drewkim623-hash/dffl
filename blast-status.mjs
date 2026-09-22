/**
 * Answer one question before a blast goes out: has the league already had this?
 *
 * The blast leads with the newest piece in recaps.json → articles[] and carries
 * the newest week in weeks[]. Neither file knows anything about email, so on a
 * quiet week the routine would cheerfully send the league a column it read four
 * days ago. data/sent-emails.json is the record of what actually reached them,
 * and this reads the two against each other.
 *
 *   node blast-status.mjs              # what would go out, and whether it is new
 *   node blast-status.mjs --json       # the same, for a script to branch on
 *   node blast-status.mjs --record ... # append a send after it has happened
 *
 * Exit codes are the point, and neither of them means "skip the week":
 *   0 — the newest piece is unsent. Compose and send it.
 *   1 — the newest piece has already been sent. WRITE A NEW ONE off current
 *       data, then send that. Never lead a blast with a column the league has
 *       already read, and never go dark instead of writing.
 * A routine can branch on that without interpreting prose.
 */
import { readFile, writeFile } from "fs/promises";

const argv = process.argv.slice(2);
const arg = k => { const i = argv.indexOf(k); return i > -1 ? argv[i + 1] : null; };
const has = k => argv.includes(k);

const LEDGER = "data/sent-emails.json";
const recaps = JSON.parse(await readFile("recaps.json", "utf8"));
const ledger = JSON.parse(await readFile(LEDGER, "utf8").catch(() => '{"sent":[]}'));

/* --------------------------------------------------------------- recording */
if (has("--record")) {
  const entry = {
    at: arg("--at") || new Date().toISOString(),
    subject: arg("--subject") || "",
    lead: arg("--lead") || null,
    alsoSent: (arg("--also") || "").split(",").map(s => s.trim()).filter(Boolean),
    recap: arg("--week") ? { season: arg("--season") || String(new Date().getFullYear()), week: Number(arg("--week")) } : null,
    to: Number(arg("--to") || 0),
    sha256: arg("--sha") || null,
    by: arg("--by") || "routine",
    note: arg("--note") || "",
  };
  if (!entry.subject) { console.error("--record needs at least --subject"); process.exit(2); }
  ledger.sent.push(entry);
  ledger.sent.sort((a, b) => String(a.at).localeCompare(String(b.at)));
  await writeFile(LEDGER, JSON.stringify(ledger, null, 1) + "\n");
  console.log(`recorded: ${entry.subject} → ${entry.to} addresses, lead ${entry.lead || "(none)"}`);
  process.exit(0);
}

/* ----------------------------------------------------------------- reading */
// Exactly the selection compose-email.mjs makes, so this cannot disagree with
// what would actually be composed.
const byDate = (recaps.articles || []).slice()
  .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
const lead = byDate[0] || null;
const week = (recaps.weeks || []).slice()
  .sort((a, b) => Number(b.season) - Number(a.season) || b.week - a.week)[0] || null;

// A slug counts as sent whether it led a blast or rode along under one.
const sentSlugs = new Set(ledger.sent.flatMap(s => [s.lead, ...(s.alsoSent || [])]).filter(Boolean));
const sentWeeks = new Set(ledger.sent.filter(s => s.recap).map(s => `${s.recap.season}w${s.recap.week}`));

const leadSent = !!(lead && sentSlugs.has(lead.slug));
const weekSent = !!(week && sentWeeks.has(`${week.season}w${week.week}`));
const unsent = byDate.filter(a => !sentSlugs.has(a.slug));
const last = ledger.sent[ledger.sent.length - 1] || null;

/**
 * A column is never reused. The blast leads with an article, and if that
 * article has already been in the league's inbox then the send is not ready —
 * not because there is nothing to say, but because the thing at the top of it
 * would be a repeat. Write a new piece off current data and send that.
 *
 * A fresh recap does not excuse a stale column. It is a reason the new piece
 * will be easy to write, not a reason to skip writing it.
 */
const verdict = leadSent ? "WRITE_NEW_ARTICLE_THEN_SEND" : "READY_TO_SEND";

const out = {
  lead: lead ? { slug: lead.slug, headline: lead.headline, date: lead.date } : null,
  leadAlreadySent: leadSent,
  recap: week ? { season: week.season, week: week.week } : null,
  recapAlreadySent: weekSent,
  newThisSend: [!leadSent && "column", !weekSent && "recap"].filter(Boolean),
  unsentArticles: unsent.map(a => ({ slug: a.slug, date: a.date })),
  lastSend: last ? { at: last.at, subject: last.subject, to: last.to } : null,
  verdict,
};

if (has("--json")) {
  console.log(JSON.stringify(out, null, 1));
} else {
  console.log(`lead piece    : ${out.lead ? `${out.lead.headline} (${out.lead.slug}, ${out.lead.date})` : "(none)"}`);
  console.log(`already sent  : ${leadSent ? "YES" : "no"}`);
  console.log(`recap carried : ${out.recap ? `${out.recap.season} week ${out.recap.week}` : "(none)"}${weekSent ? "  — already blasted" : ""}`);
  console.log(`unsent pieces : ${unsent.length ? unsent.map(a => a.slug).join(", ") : "none"}`);
  console.log(`last send     : ${last ? `${last.at} → ${last.to} addresses, "${last.subject}"` : "(never)"}`);
  console.log(`new this send : ${out.newThisSend.join(" + ") || "nothing"}`);
  console.log(`\nverdict       : ${out.verdict}`);
  if (leadSent) {
    console.log(`\nThe column this would lead with has already been sent. Write a new one off`);
    console.log(`current data and send that. Do not reuse it, and do not skip the send.`);
    if (!weekSent) console.log(`The recap is new, which is what the new piece should be built on.`);
  }
}

// 0 = the newest piece is unsent, compose and send.
// 1 = write a new piece first, then send. Never a reason to go quiet.
process.exit(leadSent ? 1 : 0);

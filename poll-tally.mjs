/**
 * Close a reply-to-vote poll, or mark its results announced.
 *
 *   node poll-tally.mjs --status                      # which poll is open, is it due
 *   node poll-tally.mjs --close <id> --votes votes.json
 *   node poll-tally.mjs --announce <id>               # after an email printed the results
 *
 * The routine reads the replies from Gmail itself (a script here cannot reach
 * Gmail) and writes what it found to votes.json as
 *   [{"from": "someone@gmail.com", "at": "<ISO time>", "text": "<first line of the reply>"}]
 * one entry per reply, quoted text and signatures already stripped. This script
 * does the counting, so the rules live in one place:
 *
 *   - only the twelve league addresses count, compared case-insensitively
 *   - the reply's text must start with an option key (case-insensitive); anything
 *     else is counted as invalid, not guessed at
 *   - one vote per address; the latest reply from an address is the one that counts
 */
import { readFile, writeFile } from "fs/promises";

const LEAGUE = [
  "drewkim623@gmail.com", "dominickreyes1@gmail.com", "jadenisxd@gmail.com", "joeskule23@gmail.com",
  "bradyrife@gmail.com", "willie124w@gmail.com", "victorthompson023@gmail.com", "matthewcolella2@gmail.com",
  "andrewcroft44@gmail.com", "connorhassan04@gmail.com", "weshowenstein@gmail.com", "moseslin2023@gmail.com",
];

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const file = "polls.json";
const data = JSON.parse(await readFile(file, "utf8"));
const polls = data.polls || [];
const today = new Date().toISOString().slice(0, 10);

/** Pure: count a list of replies against a poll's options. Exported for tests. */
export function tally(poll, replies) {
  const keys = poll.options.map(o => o.key.toUpperCase());
  const latest = new Map();
  let invalid = 0, outside = 0;
  for (const r of replies) {
    const from = String(r.from || "").toLowerCase().replace(/^.*<|>.*$/g, "").trim();
    if (!LEAGUE.includes(from)) { outside++; continue; }
    const word = String(r.text || "").trim().split(/[\s.,!?:;]+/)[0].toUpperCase();
    if (!keys.includes(word)) { invalid++; continue; }
    const prev = latest.get(from);
    if (!prev || String(r.at) > String(prev.at)) latest.set(from, { at: r.at, key: word });
  }
  const results = Object.fromEntries(keys.map(k => [k, 0]));
  for (const v of latest.values()) results[v.key]++;
  return { ...results, voters: latest.size, invalid, outside };
}

if (process.argv.includes("--status")) {
  const open = polls.filter(p => p.status === "open");
  if (!open.length) { console.log("no open poll"); process.exit(1); }
  for (const p of open) console.log(`${p.id}: open, closes ${p.closes}${p.closes <= today ? " — DUE, tally it now" : ""}\n  subject: ${p.subject}\n  thread: ${p.thread_id || "?"}\n  keys: ${p.options.map(o => o.key).join(", ")}`);
  const unannounced = polls.filter(p => p.status === "closed" && !p.announced);
  for (const p of unannounced) console.log(`${p.id}: closed, results not yet announced`);
  process.exit(open.some(p => p.closes <= today) ? 0 : 2);
}

const closeId = arg("--close");
if (closeId) {
  const p = polls.find(x => x.id === closeId);
  if (!p) throw new Error(`no poll ${closeId}`);
  if (p.status !== "open") throw new Error(`${closeId} is already ${p.status}`);
  const replies = JSON.parse(await readFile(arg("--votes"), "utf8"));
  p.results = tally(p, replies);
  p.status = "closed";
  p.closed_at = new Date().toISOString();
  await writeFile(file, JSON.stringify(data, null, 1) + "\n");
  console.log(`closed ${closeId}:`, JSON.stringify(p.results));
}

const annId = arg("--announce");
if (annId) {
  const p = polls.find(x => x.id === annId);
  if (!p || p.status !== "closed") throw new Error(`${annId} is not a closed poll`);
  p.announced = true;
  await writeFile(file, JSON.stringify(data, null, 1) + "\n");
  console.log(`announced ${annId}`);
}

/**
 * Should a new recap go to the league right now? Read-only; sends nothing.
 *
 *   node recap-guard.mjs          # prints each condition, exit 0 = send, 1 = do not
 *   node recap-guard.mjs --json   # the same, for a script
 *
 * Reads data/latest.json (written by build-week.mjs in the Action) and
 * data/sent-emails.json. The four conditions and why each exists are in
 * email-week.mjs → recapSendGuard. This never writes, never records, and never
 * touches the send path: it only answers the question.
 */
import { readFile } from "fs/promises";
import { recapSendGuard } from "./email-week.mjs";

const latest = JSON.parse(await readFile("data/latest.json", "utf8").catch(() => "{}"));
const ledger = JSON.parse(await readFile("data/sent-emails.json", "utf8").catch(() => '{"sent":[]}'));
const res = recapSendGuard({ latest, ledger, now: Date.now() });

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(res, null, 1));
} else {
  for (const c of res.checks) console.log(`${c.ok ? "pass" : "FAIL"}  ${c.id.padEnd(6)} ${c.message}`);
  console.log(res.ok
    ? `\nverdict: SEND — the ${res.recap.season} week ${res.recap.week} recap may go out.`
    : `\nverdict: DO NOT SEND — failed: ${res.failed.join(", ")}. Send nothing and say which condition failed.`);
}
process.exit(res.ok ? 0 : 1);

/**
 * Turn the committed numbers into the weekly email.
 *
 * Pure Node, no browser and no network, because the routine that sends this
 * cannot reach Sleeper or the site. Its two inputs are already in the repo:
 *
 *   data/odds-snapshot.json   what the site computed (build-email.mjs, in Actions)
 *   recaps.json               the writing, including this week's column
 *
 * Nothing here recomputes a probability. If a figure is not in the snapshot it
 * does not go in the email, which is the whole reason the two halves are split.
 *
 *   node compose-email.mjs                 # writes data/email-<season>-<week>.{html,json}
 *   node compose-email.mjs --out foo.html
 */
import { readFile, writeFile, mkdir } from "fs/promises";

const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const SITE = "https://drewkim623-hash.github.io/dffl/";
/**
 * A link that opens one piece, not the index it sits on.
 *
 * A query rather than a fragment, deliberately. Gmail rewrites every outbound
 * link through google.com/url, and a #fragment hanging off the end of that is
 * what makes Google stop and show a Redirect Notice rather than just following
 * it. ?a=<slug> survives the rewrite and lands the reader on the article.
 */
const linkTo = a => a && a.slug ? `${SITE}?a=${encodeURIComponent(a.slug)}` : `${SITE}?t=recaps`;

const D = JSON.parse(await readFile("data/odds-snapshot.json", "utf8"));
const recaps = JSON.parse(await readFile("recaps.json", "utf8").catch(() => "{}"));

const byDate = (recaps.articles || []).slice()
  .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
// The week's column leads the email; anything else recent rides along under it.
const lead = byDate[0] || null;
const also = byDate.slice(1, 3);

const pc = n => `${(n * 100).toFixed(0)}%`;
const pc1 = n => `${(n * 100).toFixed(1)}%`;
const esc = s => String(s ?? "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));
// Only <b> survives from article copy, exactly as on the site.
const rich = s => esc(s).replace(/&lt;b&gt;/g, "<b>").replace(/&lt;\/b&gt;/g, "</b>");

const movers = (D.teams || [])
  .filter(t => t.playoffNow != null)
  .map(t => ({ ...t, d: t.playoffNow - t.playoffWas }))
  .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
  .filter(t => Math.abs(t.d) >= 0.01)
  .slice(0, 5);

const marquee = (D.games || []).length
  ? D.games.slice().sort((a, b) => Math.abs(0.5 - a.pA) - Math.abs(0.5 - b.pA))[0]
  : null;

const race = (D.teams || []).filter(t => t.playoffNow != null).sort((a, b) => b.playoffNow - a.playoffNow);

const subject = lead
  ? `DFFL Week ${D.week}: ${lead.headline}`
  : marquee && !marquee.settled
    ? `DFFL Week ${D.week}: ${marquee.a} v ${marquee.b} is a coin flip`
    : `DFFL Week ${D.week}: where the board stands`;

/* ---------------------------------------------------------------- style */
/**
 * Two columns wherever two columns fit, so the whole week is a glance rather
 * than a scroll. Email has no flexbox worth trusting, so this is tables — but
 * every two-up row is a <td width="50%"> pair that a media query collapses to
 * full width on a phone, and the content in each cell is short enough to read
 * at half width even in the clients that ignore the query.
 */
const C = { ink: "#14141a", mid: "#5c5c68", faint: "#8a8a95", line: "#e4e4ea",
  bg: "#eeeef1", card: "#ffffff", blue: "#2b6fd4", red: "#c94a4a",
  green: "#137a45", gold: "#9a6600" };
const F = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const fmtOdds = o => o == null ? "—" : (o > 0 ? "+" : "") + Math.round(o);
const oddsColour = o => o == null ? C.faint : o < 0 ? C.green : C.ink;

const shell = inner => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title>
<style>
  @media only screen and (max-width:480px){
    .col{display:block!important;width:100%!important;max-width:100%!important}
    .col+.col{padding-top:10px!important}
    .pad{padding-left:14px!important;padding-right:14px!important}
    .big{font-size:21px!important}
  }
</style></head>
<body style="margin:0;padding:0;background:${C.bg};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(
  lead ? (lead.dek || lead.headline) : "The board has moved.")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:20px 10px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:620px;width:100%">
${inner}
</table></td></tr></table></body></html>`;

/** A section heading. Tight — the content should be doing the talking. */
const head2 = (title, sub) => `
  <tr><td style="padding:22px 2px 8px">
    <span style="font:800 17px/1.2 ${F};color:${C.ink};letter-spacing:-.01em">${title}</span>
    ${sub ? `<span style="font:400 12.5px/1.4 ${F};color:${C.faint};padding-left:8px">${sub}</span>` : ""}
  </td></tr>`;

/** Two cells side by side that become two rows on a phone. */
const twoUp = (a, b) => `
  <tr><td>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td class="col" width="50%" valign="top" style="padding-right:5px">${a}</td>
      <td class="col" width="50%" valign="top" style="padding-left:5px">${b || ""}</td>
    </tr></table>
  </td></tr>`;

const box = (inner, pad = "0") => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  style="background:${C.card};border:1px solid ${C.line};border-radius:10px;border-collapse:separate">
  <tr><td style="padding:${pad}">${inner}</td></tr></table>`;

/* ------------------------------------------------------------ the strip */
const biggest = movers[0];
const tile = (k, v, note) => `
  <td class="col" width="33.33%" valign="top" style="padding:0 4px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:${C.card};border:1px solid ${C.line};border-radius:10px;border-collapse:separate">
      <tr><td style="padding:11px 13px">
        <div style="font:700 9.5px/1.2 ${F};color:${C.faint};text-transform:uppercase;letter-spacing:.08em">${k}</div>
        <div style="font:800 19px/1.2 ${F};color:${C.ink};margin-top:4px;letter-spacing:-.01em">${v}</div>
        ${note ? `<div style="font:400 11px/1.35 ${F};color:${C.faint};margin-top:2px">${note}</div>` : ""}
      </td></tr></table></td>`;

const strip = `
  <tr><td style="padding-bottom:2px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${tile("Week", String(D.week), `${D.decided} played · ${D.remaining} to come`)}
      ${tile("Closest game", marquee ? pc(Math.max(marquee.pA, marquee.pB)) : "—",
        marquee ? `${esc(marquee.pA >= marquee.pB ? marquee.a : marquee.b)} favoured` : "")}
      ${tile("Biggest move", biggest ? `${biggest.d > 0 ? "▲" : "▼"} ${Math.abs(biggest.d * 100).toFixed(0)}pt` : "—",
        biggest ? esc(biggest.manager) : "")}
    </tr></table>
  </td></tr>`;

/* ------------------------------------------------------------ the column */
const columnBlock = a => {
  const firstPara = (a.blocks || []).find(b => b.type === "p");
  const firstStat = (a.blocks || []).find(b => b.type === "stat");
  return `
  <tr><td style="padding:14px 0 0">
    ${box(`
      ${a.kind === "opinion" ? `<span style="display:inline-block;font:800 9.5px/1 ${F};letter-spacing:.09em;
        text-transform:uppercase;color:${C.red};border:1px solid ${C.red};border-radius:3px;padding:4px 6px;margin-bottom:9px">Column</span>` : ""}
      ${a.kicker ? `<div style="font:700 10px/1.3 ${F};color:${C.blue};text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px">${esc(a.kicker)}</div>` : ""}
      <a href="${linkTo(a)}" style="text-decoration:none">
        <div class="big" style="font:800 25px/1.15 ${F};color:${C.ink};letter-spacing:-.022em">${esc(a.headline)}</div></a>
      ${a.dek ? `<div style="font:400 13.5px/1.5 ${F};color:${C.mid};margin-top:7px">${esc(a.dek)}</div>` : ""}
      ${firstStat ? `
      <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:13px">
        <tr><td style="padding-right:11px;font:800 28px/1 ${F};color:${C.blue};letter-spacing:-.02em;vertical-align:middle">${esc(firstStat.n)}</td>
            <td style="font:400 12px/1.45 ${F};color:${C.mid};vertical-align:middle">${rich(firstStat.text)}</td></tr>
      </table>` : ""}
      ${firstPara ? `<div style="font:400 13.5px/1.55 ${F};color:${C.ink};margin-top:12px">${rich(firstPara.text)}</div>` : ""}
      <a href="${linkTo(a)}" style="display:inline-block;margin-top:12px;font:700 13.5px/1 ${F};color:${C.blue};text-decoration:none">Read the full piece →</a>
    `, "18px 18px 16px")}
  </td></tr>`;
};

/* ------------------------------------------------- match of the week */
const marqueeBlock = g => {
  const side = (nm, pts, p, left, lead) => `
    <td width="50%" valign="top" style="padding:13px 14px;${lead ? `background:#f4faf6;` : ""}">
      <div style="font:700 14.5px/1.2 ${F};color:${C.ink}">${esc(nm)}</div>
      <div style="font:800 26px/1.15 ${F};color:${C.ink};letter-spacing:-.02em;margin-top:3px">${pts.toFixed(1)}</div>
      <div style="font:800 13px/1.2 ${F};color:${p >= 0.5 ? C.green : C.red};margin-top:4px">${pc(p)} to win</div>
      <div style="font:400 11px/1.3 ${F};color:${C.faint};margin-top:3px">${g.settled ? "all played" : `${left} still to play`}</div>
    </td>`;
  return box(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      ${side(g.a, g.aPts, g.pA, g.aLeft, g.pA >= g.pB)}
      ${side(g.b, g.bPts, g.pB, g.bLeft, g.pB > g.pA)}
    </tr></table>`);
};

/* ------------------------------------------------------------- movers */
const moverList = rows => rows.length ? box(rows.map((m, i) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="padding:9px 13px;${i ? `border-top:1px solid ${C.line};` : ""}">
      <div style="font:700 13.5px/1.2 ${F};color:${C.ink}">${esc(m.manager)}</div>
      <div style="font:400 11px/1.35 ${F};color:${C.faint};margin-top:2px">${pc(m.playoffWas)} → ${pc(m.playoffNow)}</div></td>
    <td align="right" style="padding:9px 13px;${i ? `border-top:1px solid ${C.line};` : ""}
      font:800 14px/1.2 ${F};color:${m.d > 0 ? C.green : C.red};white-space:nowrap">
      ${m.d > 0 ? "▲" : "▼"} ${Math.abs(m.d * 100).toFixed(0)}pt</td>
  </tr></table>`).join("")) : "";

/* --------------------------------------------------------------- race */
/** Six rows a side, so twelve teams read across rather than down. */
const raceHalf = rows => box(rows.map((t, i) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="padding:8px 11px;${i ? `border-top:1px solid ${C.line};` : ""}
      font:600 13px/1.2 ${F};color:${C.ink};overflow:hidden">${esc(t.manager)}
      <div style="font:400 10.5px/1.3 ${F};color:${C.faint};margin-top:2px">${pc1(t.titleNow)} title · ${t.wins.toFixed(1)} wins</div></td>
    <td align="right" style="padding:8px 11px;${i ? `border-top:1px solid ${C.line};` : ""}white-space:nowrap">
      <div style="font:800 14px/1.2 ${F};color:${C.ink}">${pc(t.playoffNow)}</div>
      <div style="font:700 11px/1.2 ${F};color:${oddsColour(t.playoffOdds)};margin-top:2px">${fmtOdds(t.playoffOdds)}</div></td>
  </tr></table>`).join(""));

/* ------------------------------------------------------------- title odds */
const titleBoard = box(race.slice(0, 6).map((t, i) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="padding:9px 13px;${i ? `border-top:1px solid ${C.line};` : ""}
      font:600 13.5px/1.2 ${F};color:${C.ink}">${esc(t.manager)}</td>
    <td align="right" style="padding:9px 13px;${i ? `border-top:1px solid ${C.line};` : ""}
      font:800 15px/1.2 ${F};color:${oddsColour(t.titleOdds)};white-space:nowrap">${fmtOdds(t.titleOdds)}
      <span style="font:400 11px/1.2 ${F};color:${C.faint};padding-left:6px">${pc1(t.titleNow)}</span></td>
  </tr></table>`).join(""));

/* ---------------------------------------------------------- injuries */
const injuryBlock = (D.hurt || []).length ? box((D.hurt.slice(0, 4)).map((h, i) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td style="padding:9px 13px;${i ? `border-top:1px solid ${C.line};` : ""}">
      <div style="font:700 13px/1.2 ${F};color:${C.ink}">${esc(h.manager)}</div>
      <div style="font:400 11px/1.35 ${F};color:${C.faint};margin-top:2px">
        ${h.players.map(p => `${esc(p.name)} <span style="color:${C.gold}">${esc(p.status)}</span>`).join(" · ")}</div></td>
    <td align="right" style="padding:9px 13px;${i ? `border-top:1px solid ${C.line};` : ""}
      font:800 13px/1.2 ${F};color:${C.red};white-space:nowrap">−${(h.cost * 100).toFixed(1)}%</td>
  </tr></table>`).join("")) : "";

/* ------------------------------------------------------- also on the site */
const alsoBlock = a => box(`
  ${a.kicker ? `<div style="font:700 9.5px/1.3 ${F};color:${C.blue};text-transform:uppercase;letter-spacing:.07em;margin-bottom:4px">${esc(a.kicker)}</div>` : ""}
  <a href="${linkTo(a)}" style="text-decoration:none">
    <div style="font:800 15px/1.25 ${F};color:${C.ink};letter-spacing:-.01em">${esc(a.headline)}</div></a>
  ${a.dek ? `<div style="font:400 12px/1.45 ${F};color:${C.faint};margin-top:5px">${esc(a.dek)}</div>` : ""}
  <a href="${linkTo(a)}" style="display:inline-block;margin-top:9px;font:700 12px/1 ${F};color:${C.blue};text-decoration:none">Read it →</a>
`, "14px 15px");

/* ------------------------------------------------------- the approve button */
/**
 * One tap to put this in front of the league.
 *
 * A mailto rather than a link to a server, because there is no server: the site
 * is static. Tapping it opens a pre-addressed reply with a subject the approval
 * routine watches for, and sending that reply is the whole approval. Nothing can
 * go to the league without a mail actually leaving this inbox.
 */
const approveSubject = `DFFL PUBLISH ${D.season}-${String(D.week).padStart(2, "0")}`;
const approveHref = `mailto:drewkim623@gmail.com?subject=${encodeURIComponent(approveSubject)}`
  + `&amp;body=${encodeURIComponent("Send it to the league.")}`;
const approveBlock = `
  <tr><td style="padding:24px 0 0">
    ${box(`
      <div style="font:800 15px/1.25 ${F};color:${C.ink}">Only you have seen this.</div>
      <div style="font:400 12.5px/1.5 ${F};color:${C.mid};margin-top:5px">
        Tap below and hit send on the reply that opens. That is the whole approval — the blast then
        goes out to all twelve managers, unchanged.</div>
      <a href="${approveHref}" style="display:block;margin-top:13px;background:${C.green};color:#ffffff;
        text-align:center;padding:14px;border-radius:9px;font:800 15px/1 ${F};text-decoration:none">
        ✓&nbsp; Send this to the league</a>
      <div style="font:400 11px/1.4 ${F};color:${C.faint};margin-top:9px;text-align:center">
        Do nothing and it stays between us.</div>
    `, "16px 16px 15px")}
  </td></tr>`;

/* ------------------------------------------------------------- assemble */
const inner = `
  <tr><td style="padding:0 2px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="font:800 27px/1 ${F};letter-spacing:-.03em;color:${C.ink}">DFFL</td>
      <td align="right" style="font:600 11.5px/1.4 ${F};color:${C.faint};text-transform:uppercase;letter-spacing:.07em">
        Week ${D.week} · ${D.season}</td>
    </tr></table>
  </td></tr>
  ${strip}
  ${lead ? columnBlock(lead) : ""}
  ${marquee ? head2("Match of the week",
    marquee.settled ? "the closest thing the week had" : "closest to a coin flip") : ""}
  ${marquee ? `<tr><td>${marqueeBlock(marquee)}</td></tr>` : ""}
  ${(movers.length || race.length) ? head2("The board", `six of twelve make it · ${D.remaining} games still to play`) : ""}
  ${(movers.length || race.length) ? twoUp(
      `<div style="font:700 10px/1.2 ${F};color:${C.faint};text-transform:uppercase;letter-spacing:.08em;padding:0 2px 6px">Moved since the draft</div>${moverList(movers.slice(0, 5))}`,
      `<div style="font:700 10px/1.2 ${F};color:${C.faint};text-transform:uppercase;letter-spacing:.08em;padding:0 2px 6px">To win it all</div>${titleBoard}`) : ""}
  ${race.length ? head2("To make the playoffs", "price, and the chance behind it") : ""}
  ${race.length ? twoUp(raceHalf(race.slice(0, 6)), raceHalf(race.slice(6, 12))) : ""}
  ${injuryBlock ? head2("Out this week", "priced into the board") : ""}
  ${injuryBlock ? `<tr><td>${injuryBlock}</td></tr>` : ""}
  ${also.length ? head2("Also on the site") : ""}
  ${also.length ? twoUp(alsoBlock(also[0]), also[1] ? alsoBlock(also[1]) : "") : ""}
  <tr><td style="padding:22px 0 0">
    <a href="${SITE}" style="display:block;background:${C.ink};color:#ffffff;text-align:center;padding:13px;
      border-radius:9px;font:700 14.5px/1 ${F};text-decoration:none">Open the full board →</a>
  </td></tr>
  ${approveBlock}
  <tr><td class="pad" style="padding:18px 4px 0;font:400 11px/1.55 ${F};color:${C.faint}">
    Prices carry the same 6% hold the site posts. Every number here was computed by the site itself,
    so the two cannot disagree. Win probabilities move while games are being played; records,
    standings and power rankings do not move until a week is finished.
  </td></tr>`;

const html = shell(inner);

const text = [
  `DFFL — Week ${D.week}, ${D.season}`,
  lead ? `\n${(lead.kicker || "COLUMN").toUpperCase()}\n${lead.headline}\n${lead.dek || ""}\n${linkTo(lead)}` : "",
  marquee ? `\nMATCH OF THE WEEK\n${marquee.a} ${marquee.aPts.toFixed(1)} (${pc(marquee.pA)}) v ${marquee.b} ${marquee.bPts.toFixed(1)} (${pc(marquee.pB)})` : "",
  movers.length ? `\nTHE BOARD MOVED\n` + movers.map(m =>
    `${m.manager}: ${pc(m.playoffWas)} -> ${pc(m.playoffNow)} (${m.d > 0 ? "+" : ""}${(m.d * 100).toFixed(0)}pt)`).join("\n") : "",
  race.length ? `\nTO MAKE THE PLAYOFFS\n` + race.map(t =>
    `${t.manager}: ${fmtOdds(t.playoffOdds)} (${pc(t.playoffNow)}) · title ${fmtOdds(t.titleOdds)}`).join("\n") : "",
  `\nApprove by replying with subject: ${approveSubject}`,
  `\n${SITE}`,
].filter(Boolean).join("\n");

await mkdir("data", { recursive: true });
const stem = `data/email-${D.season}-${String(D.week).padStart(2, "0")}`;
const out = arg("--out") || `${stem}.html`;
await writeFile(out, html);
await writeFile(`${stem}.json`, JSON.stringify({
  _comment: "Subject, plain-text fallback and the approval subject for the weekly blast.",
  season: D.season, week: D.week, generated: new Date().toISOString(),
  subject, text, body_file: out, column: lead ? lead.headline : null,
  approve_subject: approveSubject,
}, null, 1) + "\n");

console.log(`${out} — ${(html.length / 1024).toFixed(1)}KB`);
console.log(`subject: ${subject}`);
console.log(`  column: ${lead ? lead.headline : "(none)"} · ${also.length} others · `
  + `${race.length} priced · approve with "${approveSubject}"`);

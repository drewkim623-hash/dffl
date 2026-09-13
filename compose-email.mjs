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
/** A link that opens one piece, not the index it sits on. */
const linkTo = a => a && a.slug ? `${SITE}#article/${encodeURIComponent(a.slug)}` : `${SITE}#recaps`;

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

const C = { ink: "#14141a", mid: "#5c5c68", line: "#e4e4ea", bg: "#f5f5f7",
  card: "#ffffff", blue: "#2b6fd4", red: "#c94a4a", green: "#137a45", gold: "#9a6600" };
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

const row = (label, value, sub) => `
  <tr>
    <td style="padding:9px 14px;border-top:1px solid ${C.line};font:600 14px/1.3 ${FONT};color:${C.ink}">${label}
      ${sub ? `<div style="font:400 12px/1.4 ${FONT};color:${C.mid};margin-top:2px">${sub}</div>` : ""}</td>
    <td align="right" style="padding:9px 14px;border-top:1px solid ${C.line};font:700 15px/1.3 ${FONT};color:${C.ink};white-space:nowrap">${value}</td>
  </tr>`;

const section = (title, sub, inner) => `
  <tr><td style="padding:26px 0 8px">
    <div style="font:800 19px/1.2 ${FONT};color:${C.ink};letter-spacing:-.01em">${title}</div>
    ${sub ? `<div style="font:400 13px/1.5 ${FONT};color:${C.mid};margin-top:4px">${sub}</div>` : ""}
  </td></tr>
  <tr><td>${inner}</td></tr>`;

const card = inner => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  style="background:${C.card};border:1px solid ${C.line};border-radius:10px;border-collapse:separate;overflow:hidden">${inner}</table>`;

const gameCard = g => {
  const side = (nm, pts, p, left, settled) => `
    <tr>
      <td style="padding:10px 14px;font:700 15px/1.2 ${FONT};color:${C.ink}">${esc(nm)}
        <div style="font:400 11.5px/1.4 ${FONT};color:${C.mid};margin-top:2px">
          ${settled ? "all played" : `${left} still to play`}</div></td>
      <td align="right" style="padding:10px 6px;font:700 17px/1.2 ${FONT};color:${C.ink};white-space:nowrap">${pts.toFixed(1)}</td>
      <td align="right" style="padding:10px 14px;white-space:nowrap">
        <span style="display:inline-block;padding:3px 9px;border-radius:99px;font:800 12px/1.3 ${FONT};
          background:${p >= 0.5 ? "#e8f5ee" : "#fdecec"};color:${p >= 0.5 ? C.green : C.red}">${pc(p)}</span></td>
    </tr>`;
  return card(side(g.a, g.aPts, g.pA, g.aLeft, g.settled)
    + `<tr><td colspan="3" style="border-top:1px solid ${C.line};font-size:0;line-height:0">&nbsp;</td></tr>`
    + side(g.b, g.bPts, g.pB, g.bLeft, g.settled));
};

/**
 * The column, given the top of the email rather than a footnote at the bottom.
 * The email carries its opening, not the whole thing — the piece lives on the
 * site, where the charts in it actually render.
 */
const columnBlock = a => {
  const firstPara = (a.blocks || []).find(b => b.type === "p");
  const firstStat = (a.blocks || []).find(b => b.type === "stat");
  return `
  <tr><td style="padding:22px 0 0">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
      style="background:${C.card};border:1px solid ${C.line};border-radius:12px;border-collapse:separate">
      <tr><td style="padding:20px 20px 18px">
        ${a.kind === "opinion" ? `<div style="display:inline-block;font:800 10px/1 ${FONT};letter-spacing:.09em;
          text-transform:uppercase;color:${C.red};border:1px solid ${C.red};border-radius:3px;padding:4px 6px;margin-bottom:10px">Column</div>` : ""}
        ${a.kicker ? `<div style="font:700 10.5px/1.3 ${FONT};color:${C.blue};text-transform:uppercase;letter-spacing:.07em;margin-bottom:6px">${esc(a.kicker)}</div>` : ""}
        <a href="${linkTo(a)}" style="text-decoration:none">
          <div style="font:800 24px/1.2 ${FONT};color:${C.ink};letter-spacing:-.02em">${esc(a.headline)}</div></a>
        ${a.dek ? `<div style="font:400 14px/1.55 ${FONT};color:${C.mid};margin-top:8px">${esc(a.dek)}</div>` : ""}
        ${firstStat ? `
        <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:14px">
          <tr><td style="padding-right:12px;font:800 30px/1 ${FONT};color:${C.blue};letter-spacing:-.02em;vertical-align:middle">${esc(firstStat.n)}</td>
              <td style="font:400 12.5px/1.5 ${FONT};color:${C.mid};vertical-align:middle">${rich(firstStat.text)}</td></tr>
        </table>` : ""}
        ${firstPara ? `<div style="font:400 14px/1.6 ${FONT};color:${C.ink};margin-top:14px">${rich(firstPara.text)}</div>` : ""}
        <a href="${linkTo(a)}" style="display:inline-block;margin-top:14px;font:700 14px/1 ${FONT};color:${C.blue};text-decoration:none">Read the full piece →</a>
      </td></tr>
    </table>
  </td></tr>`;
};

const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(
  lead ? (lead.dek || lead.headline) : "The DFFL board has moved.")}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

  <tr><td style="padding-bottom:2px">
    <div style="font:800 30px/1 ${FONT};letter-spacing:-.03em;color:${C.ink}">DFFL</div>
    <div style="font:600 13px/1.4 ${FONT};color:${C.mid};margin-top:5px;text-transform:uppercase;letter-spacing:.06em">
      Week ${D.week} · ${D.season} season</div>
  </td></tr>

  ${lead ? columnBlock(lead) : ""}

  ${marquee ? section("Match of the week",
    marquee.settled
      ? "The closest thing the week had to a contest."
      : "The one closest to a coin flip — win probability from where the lineups actually stand, not from who happens to be ahead.",
    gameCard(marquee)) : ""}

  ${movers.length ? section("The board moved",
    "Change in playoff probability since the draft-day line.",
    card(movers.map(m => row(esc(m.manager),
      `<span style="color:${m.d > 0 ? C.green : C.red}">${m.d > 0 ? "▲" : "▼"} ${Math.abs(m.d * 100).toFixed(0)}pt</span>`,
      `${pc(m.playoffWas)} → <b style="color:${C.ink}">${pc(m.playoffNow)}</b> to make the playoffs`)).join(""))) : ""}

  ${race.length ? section("The race",
    `Six of twelve make it. ${D.decided} game${D.decided === 1 ? "" : "s"} in the book, ${D.remaining} still to play.`,
    card(race.map(t => row(esc(t.manager), pc(t.playoffNow),
      `${pc1(t.titleNow)} to win it all · ${t.wins.toFixed(1)} projected wins`)).join(""))) : ""}

  ${(D.hurt || []).length ? section("Out this week",
    "Straight from Sleeper's injury feed, and priced into the board.",
    card(D.hurt.slice(0, 5).map(h => row(esc(h.manager),
      `<span style="color:${C.red}">−${(h.cost * 100).toFixed(1)}%</span>`,
      h.players.map(p => `${esc(p.name)} <span style="color:${C.gold}">${esc(p.status)}</span>`).join(" · "))).join(""))) : ""}

  ${also.length ? section("Also on the site", "Everything else the desk has filed lately.",
    also.map(a => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:9px">
      <tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:15px 16px">
        ${a.kicker ? `<div style="font:700 10.5px/1.3 ${FONT};color:${C.blue};text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px">${esc(a.kicker)}</div>` : ""}
        <a href="${linkTo(a)}" style="text-decoration:none">
          <div style="font:800 17px/1.25 ${FONT};color:${C.ink};letter-spacing:-.01em">${esc(a.headline)}</div></a>
        ${a.dek ? `<div style="font:400 13px/1.5 ${FONT};color:${C.mid};margin-top:6px">${esc(a.dek)}</div>` : ""}
        <a href="${linkTo(a)}" style="display:inline-block;margin-top:10px;font:700 13px/1 ${FONT};color:${C.blue};text-decoration:none">Read it →</a>
      </td></tr></table>`).join("")) : ""}

  <tr><td style="padding:26px 0 0">
    <a href="${SITE}" style="display:block;background:${C.ink};color:#fff;text-align:center;padding:14px;
      border-radius:10px;font:700 15px/1 ${FONT};text-decoration:none">Open the full board →</a>
  </td></tr>

  <tr><td style="padding:20px 4px 0;font:400 11.5px/1.6 ${FONT};color:${C.mid}">
    Every number here is computed from Sleeper's own data and agrees with the site exactly.
    Win probabilities move while games are being played; records, standings and power rankings
    do not move until a week is finished.<br><br>
    You're getting this because you're in the DFFL. Reply to this email to be taken off it.
  </td></tr>

</table></td></tr></table></body></html>`;

const text = [
  `DFFL — Week ${D.week}, ${D.season}`,
  lead ? `\n${(lead.kicker || "COLUMN").toUpperCase()}\n${lead.headline}\n${lead.dek || ""}\n${linkTo(lead)}` : "",
  marquee ? `\nMATCH OF THE WEEK\n${marquee.a} ${marquee.aPts.toFixed(1)} (${pc(marquee.pA)}) v ${marquee.b} ${marquee.bPts.toFixed(1)} (${pc(marquee.pB)})` : "",
  movers.length ? `\nTHE BOARD MOVED\n` + movers.map(m =>
    `${m.manager}: ${pc(m.playoffWas)} -> ${pc(m.playoffNow)} (${m.d > 0 ? "+" : ""}${(m.d * 100).toFixed(0)}pt)`).join("\n") : "",
  race.length ? `\nTHE RACE\n` + race.map(t => `${t.manager}: ${pc(t.playoffNow)} playoffs, ${pc1(t.titleNow)} title`).join("\n") : "",
  `\n${SITE}`,
].filter(Boolean).join("\n");

await mkdir("data", { recursive: true });
const stem = `data/email-${D.season}-${String(D.week).padStart(2, "0")}`;
const out = arg("--out") || `${stem}.html`;
await writeFile(out, html);
await writeFile(`${stem}.json`, JSON.stringify({
  _comment: "Subject and plain-text fallback for the weekly blast. The routine sends body_file as the HTML body.",
  season: D.season, week: D.week, generated: new Date().toISOString(),
  subject, text, body_file: out, column: lead ? lead.headline : null,
}, null, 1) + "\n");

console.log(`${out} — ${(html.length / 1024).toFixed(1)}KB`);
console.log(`subject: ${subject}`);
console.log(`  column: ${lead ? lead.headline : "(none)"} · ${also.length} other pieces · `
  + `${(D.games || []).length} matchups · ${movers.length} movers`);

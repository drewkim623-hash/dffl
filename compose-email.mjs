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

/**
 * The week that just finished, if it has been written up.
 *
 * Between Tuesday and Thursday there is no week in flight, so "match of the
 * week" has nothing to show and the email would open on a board with no
 * football in it. The recap fills that space with the thing people actually
 * want first: what happened.
 */
const lastWeek = (recaps.weeks || []).slice()
  .sort((a, b) => Number(b.season) - Number(a.season) || b.week - a.week)[0] || null;

const byDate = (recaps.articles || []).slice()
  .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")));
// The week's column leads the email; anything else recent rides along under it.
const lead = byDate[0] || null;
/**
 * Everything else the desk filed this week.
 *
 * The midweek story watch publishes one or two pieces between blasts, and this
 * is where they reach anybody who does not visit the site. Taking "the next two
 * by date" was the crude version: on a quiet week it re-showed pieces the league
 * had already been sent. This takes only what was published since the last
 * blast, so the section is genuinely "what you missed" and disappears when
 * there is nothing.
 */
const SINCE_DAYS = 7;
const asOf = D.generated ? new Date(D.generated) : new Date();
const cutoff = new Date(asOf.getTime() - SINCE_DAYS * 864e5);
const also = byDate.slice(1).filter(a => {
  if (!a.date) return false;
  const d = new Date(a.date + "T12:00:00Z");
  return isFinite(d) && d >= cutoff;
}).slice(0, 3);

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

/**
 * A button that survives Gmail.
 *
 * An <a> styled with the `background` shorthand and white text is a coin flip:
 * Gmail strips the shorthand, keeps color:#ffffff, and you get white text on
 * white — a button-shaped hole, which is exactly what happened to the first one
 * of these that went out. The bgcolor attribute is HTML, not CSS, and nothing
 * strips it, so the colour is set three ways and the padding lives on the cell
 * rather than the link.
 */
const button = (href, label, bg, size = 15) => `
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:separate">
    <tr><td bgcolor="${bg}" align="center"
      style="background-color:${bg};background:${bg};border-radius:9px;padding:14px 12px">
      <a href="${href}" style="font:800 ${size}px/1.2 ${F};color:#ffffff;text-decoration:none;display:inline-block">${label}</a>
    </td></tr>
  </table>`;

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
      ${(() => {
        // A week in flight has a coin-flip to point at. Between Tuesday and
        // Thursday it does not, so fall back to the tightest finished result
        // rather than printing a dash where a number should be.
        if (marquee) return tile("Closest game", pc(Math.max(marquee.pA, marquee.pB)),
          `${esc(marquee.pA >= marquee.pB ? marquee.a : marquee.b)} favoured`);
        // recaps.json carries the two scores, not the gap between them.
        const gap = g => g.winner_points - g.loser_points;
        const tight = lastWeek && lastWeek.games.length
          ? lastWeek.games.slice().sort((a, b) => gap(a) - gap(b))[0] : null;
        return tile("Tightest last week", tight ? gap(tight).toFixed(2) : "—",
          tight ? `${esc(tight.winner)} over ${esc(tight.loser)}` : "");
      })()}
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

/* --------------------------------------------------------- the week's recap */
/** Six results, two across, with the lede above them. */
const recapBlock = wk => {
  const half = rows => box(rows.map((g, i) => `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
      <td style="padding:9px 12px;${i ? `border-top:1px solid ${C.line};` : ""}">
        <div style="font:700 12.5px/1.3 ${F};color:${C.ink}">${esc(g.headline)}</div>
        <div style="font:400 11px/1.4 ${F};color:${C.faint};margin-top:3px">
          <b style="color:${C.mid}">${esc(g.winner)}</b> ${g.winner_points}
          &nbsp;def&nbsp; ${esc(g.loser)} ${g.loser_points}</div></td>
    </tr></table>`).join(""));
  return `
  ${head2(`Week ${wk.week} in the book`, "every result, and how it happened")}
  <tr><td style="padding-bottom:10px">
    ${box(`<div style="font:400 13.5px/1.6 ${F};color:${C.ink}">${rich(wk.lede)}</div>`, "15px 16px")}
  </td></tr>
  ${twoUp(half(wk.games.slice(0, 3)), half(wk.games.slice(3, 6)))}
  ${(wk.around || []).length ? `
  <tr><td style="padding-top:10px">
    ${box((wk.around.slice(0, 3)).map((a, i) => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
        <td style="padding:10px 13px;${i ? `border-top:1px solid ${C.line};` : ""}">
          <div style="font:700 9.5px/1.2 ${F};color:${C.blue};text-transform:uppercase;letter-spacing:.08em">${esc(a.kind)}</div>
          <div style="font:700 13px/1.3 ${F};color:${C.ink};margin-top:4px">${esc(a.headline)}</div>
          <div style="font:400 12px/1.5 ${F};color:${C.mid};margin-top:4px">${rich(a.body)}</div></td>
      </tr></table>`).join(""))}
  </td></tr>` : ""}
  <tr><td style="padding-top:10px">
    <a href="${SITE}?t=recaps" style="font:700 13px/1 ${F};color:${C.blue};text-decoration:none">Read the whole week &rarr;</a>
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

/* ---------------------------------------------------------------- footer */
/**
 * The blast goes to the league directly, so there is no approval step and no
 * button asking for one. What replaces it is the thing a newsletter actually
 * owes its readers: who sent it and how to stop receiving it.
 */
const footerNote = `
  <tr><td style="padding:22px 0 0">
    ${box(`
      <div style="font:700 13px/1.35 ${F};color:${C.ink}">Written by the DFFL desk, Saturday evening.</div>
      <div style="font:400 12px/1.55 ${F};color:${C.mid};margin-top:6px">
        Every number is computed from Sleeper's own data by
        <a href="${SITE}" style="color:${C.blue};text-decoration:none">the league site</a>, so this and
        the site cannot disagree. Reply to this email if you would rather not get it.</div>
    `, "15px 16px")}
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
  ${lastWeek ? recapBlock(lastWeek) : ""}
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
  ${also.length ? head2(also.length === 1 ? "Also this week" : "Also this week",
    "filed since the last email") : ""}
  ${also.length ? twoUp(alsoBlock(also[0]), also[1] ? alsoBlock(also[1]) : "") : ""}
  <tr><td style="padding:22px 0 0">${button(SITE, "Open the full board &rarr;", C.ink, 14)}</td></tr>
  ${footerNote}
  <tr><td class="pad" style="padding:18px 4px 0;font:400 11px/1.55 ${F};color:${C.faint}">
    Prices carry the same 6% hold the site posts. Every number here was computed by the site itself,
    so the two cannot disagree. Win probabilities move while games are being played; records,
    standings and power rankings do not move until a week is finished.
  </td></tr>`;

/**
 * Squeeze the whitespace out before anyone has to handle this.
 *
 * The email is sent by a routine that must reproduce the body verbatim inside a
 * tool call. The first time it tried, it sent a fragment; the second attempt
 * only got there by diffing its own reconstruction and finding the differences
 * were all trailing spaces on blank lines. Whitespace between tags carries no
 * meaning here, so removing it takes that entire class of mistake off the table
 * and drops about a fifth of the bytes with it.
 *
 * Text inside a tag is never touched — only the gaps between them.
 */
function minify(h) {
  return h
    .replace(/\n\s*\n/g, "\n")          // no blank lines
    .replace(/>\s+</g, "><")             // no gaps between tags
    .replace(/\s{2,}/g, " ")             // no runs of spaces
    .replace(/\s+>/g, ">")
    .trim();
}

const html = minify(shell(inner));

const text = [
  `DFFL — Week ${D.week}, ${D.season}`,
  lead ? `\n${(lead.kicker || "COLUMN").toUpperCase()}\n${lead.headline}\n${lead.dek || ""}\n${linkTo(lead)}` : "",
  lastWeek ? `\nWEEK ${lastWeek.week} IN THE BOOK\n` + lastWeek.games.map(g =>
    `${g.winner} ${g.winner_points} def ${g.loser} ${g.loser_points} — ${g.headline}`).join("\n") : "",
  marquee ? `\nMATCH OF THE WEEK\n${marquee.a} ${marquee.aPts.toFixed(1)} (${pc(marquee.pA)}) v ${marquee.b} ${marquee.bPts.toFixed(1)} (${pc(marquee.pB)})` : "",
  movers.length ? `\nTHE BOARD MOVED\n` + movers.map(m =>
    `${m.manager}: ${pc(m.playoffWas)} -> ${pc(m.playoffNow)} (${m.d > 0 ? "+" : ""}${(m.d * 100).toFixed(0)}pt)`).join("\n") : "",
  race.length ? `\nTO MAKE THE PLAYOFFS\n` + race.map(t =>
    `${t.manager}: ${fmtOdds(t.playoffOdds)} (${pc(t.playoffNow)}) · title ${fmtOdds(t.titleOdds)}`).join("\n") : "",
  `\n${SITE}`,
].filter(Boolean).join("\n");

// The routine sending this has to reproduce it byte for byte. Give it something
// to check itself against rather than hoping.
const { createHash } = await import("crypto");
const sha = createHash("sha256").update(html, "utf8").digest("hex");

await mkdir("data", { recursive: true });
const stem = `data/email-${D.season}-${String(D.week).padStart(2, "0")}`;
const out = arg("--out") || `${stem}.html`;
await writeFile(out, html);
await writeFile(`${stem}.json`, JSON.stringify({
  _comment: "Subject, plain-text fallback and the approval subject for the weekly blast.",
  season: D.season, week: D.week, generated: new Date().toISOString(),
  subject, text, body_file: out, column: lead ? lead.headline : null,
  bytes: Buffer.byteLength(html, "utf8"), sha256: sha,
}, null, 1) + "\n");

console.log(`${out} — ${(html.length / 1024).toFixed(1)}KB, one line`);
console.log(`sha256: ${sha}`);
console.log(`subject: ${subject}`);
console.log(`  recap: ${lastWeek ? "week " + lastWeek.week : "(none)"} · column: ${lead ? lead.headline : "(none)"} · ${also.length} since last blast · `
  + `${race.length} priced`);

/**
 * Write the weekly email blast.
 *
 * The numbers in this email have to agree with the site exactly — a blast that
 * says 34% while the Odds tab says 29% is worse than no blast at all. Rather
 * than reimplement the model here and let the two drift, this drives the real
 * page in a headless browser and reads the numbers the site itself computed.
 *
 *   node build-email.mjs                       # against the published site
 *   node build-email.mjs --local               # against ./index.html
 *   node build-email.mjs --out preview.html
 *
 * Writes data/email-<season>-<week>.html — the exact body to send — plus a
 * companion .json holding the subject line and a plain-text fallback.
 *
 * The weekly routine does not generate this; it reads it, writes a sentence or
 * two of its own at the top if it has something to say, and sends it. Keeping
 * generation here means the email cannot invent a number.
 */
import { writeFile, mkdir } from "fs/promises";
import { createServer } from "http";
import { readFile } from "fs/promises";
import { extname, join } from "path";
import { chromium } from "playwright";

const LIVE = "https://drewkim623-hash.github.io/dffl/";
const arg = k => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const useLocal = process.argv.includes("--local");

/* ---------------------------------------------------------------- serve */
let server = null, base = LIVE;
if (useLocal) {
  const TYPES = { ".html": "text/html", ".json": "application/json", ".js": "text/javascript", ".png": "image/png" };
  server = createServer(async (req, res) => {
    const u = decodeURIComponent(req.url.split("?")[0]);
    const p = join(process.cwd(), u === "/" ? "index.html" : u);
    try { const b = await readFile(p); res.writeHead(200, { "content-type": TYPES[extname(p)] || "text/plain" }); res.end(b); }
    catch { res.writeHead(404); res.end(); }
  }).listen(0);
  base = `http://127.0.0.1:${server.address().port}/`;
}

/* ------------------------------------------------------- read the site */
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 120000 });
await page.click('#tabs button[data-tab="odds"]');
await page.waitForFunction(() => document.body.dataset.liveReady, null, { timeout: 180000 });

const D = await page.evaluate(() => {
  const W = window, F = W.__DFFL;
  const model = W.__ODDS, pre = W.__SIM, live = W.__LSIM, board = W.__BOARD, L = W.__LIVE;
  const season = F.DB.seasons[0];
  // nameOf() isn't on the test surface; the manager table behind it is.
  const name = uid => { const m = F.DB.mgr.get(uid); return (m && m.name) || String(uid); };

  const teams = model.teams.map((t, i) => ({
    uid: t.uid, rid: t.rid, manager: name(t.uid),
    titleWas: pre.title[i] / pre.sims,
    titleNow: live ? live.title[i] / live.sims : null,
    playoffWas: pre.playoff[i] / pre.sims,
    playoffNow: live ? live.playoff[i] / live.sims : null,
    wins: live ? live.wins[i] / live.sims : pre.wins[i] / pre.sims,
  }));

  const games = board && board.ok ? board.games.map(g => ({
    a: name(g.a.uid), b: name(g.b.uid),
    aPts: g.a.pts, bPts: g.b.pts,
    pA: g.pA, pB: g.pB, settled: g.settled,
    aLeft: g.A.toPlay + g.A.inPlay, bLeft: g.B.toPlay + g.B.inPlay,
    aFrac: g.A.frac, bFrac: g.B.frac,
  })) : [];

  const avail = W.__AVAIL || new Map();
  const hurt = model.teams.map(t => {
    const a = avail.get ? avail.get(t.rid) : null;
    return a && a.hurt.length ? {
      manager: name(t.uid), cost: 1 - a.mult,
      players: a.hurt.map(h => ({ name: (h.rec && h.rec.n) || h.pid, status: h.status })),
    } : null;
  }).filter(Boolean).sort((x, y) => y.cost - x.cost);

  return {
    season: season.season,
    week: season.liveWeek || (L && L.adjWeek) || null,
    liveWeek: season.liveWeek || null,
    decided: L ? L.decided : 0,
    remaining: L ? L.remaining + (L.pending || []).length : 0,
    teams, games, hurt,
    settled: board ? !!board.settled : true,
    nfl: board && board.nfl ? board.nfl : null,
  };
});

const articles = await page.evaluate(async () => {
  try {
    const j = await (await fetch("recaps.json", { cache: "no-cache" })).json();
    return ((j && j.articles) || []).slice()
      .sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")))
      .slice(0, 3)
      .map(a => ({ slug: a.slug, kicker: a.kicker, headline: a.headline, dek: a.dek, byline: a.byline, date: a.date }));
  } catch (e) { return []; }
});

await browser.close();
if (server) server.close();

/* ------------------------------------------------------------- compose */
const pc = n => `${(n * 100).toFixed(0)}%`;
const pc1 = n => `${(n * 100).toFixed(1)}%`;
const esc = s => String(s ?? "").replace(/[&<>"]/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[m]));

// Who has moved most since the draft-day line.
const movers = D.teams
  .filter(t => t.playoffNow != null)
  .map(t => ({ ...t, d: t.playoffNow - t.playoffWas }))
  .sort((a, b) => Math.abs(b.d) - Math.abs(a.d))
  .filter(t => Math.abs(t.d) >= 0.01)
  .slice(0, 5);

// The match of the week is the one closest to a coin flip.
const marquee = D.games.length
  ? D.games.slice().sort((a, b) => Math.abs(0.5 - a.pA) - Math.abs(0.5 - b.pA))[0]
  : null;

const race = D.teams
  .filter(t => t.playoffNow != null)
  .sort((a, b) => b.playoffNow - a.playoffNow);

const SITE = "https://drewkim623-hash.github.io/dffl/";
const subject = marquee && !marquee.settled
  ? `DFFL Week ${D.week}: ${marquee.a} v ${marquee.b} is a coin flip`
  : `DFFL Week ${D.week}: where the board stands`;

const C = { ink: "#14141a", mid: "#5c5c68", line: "#e4e4ea", bg: "#f5f5f7",
  card: "#ffffff", blue: "#2b6fd4", red: "#c94a4a", green: "#137a45", gold: "#9a6600" };

const row = (label, value, sub) => `
  <tr>
    <td style="padding:9px 14px;border-top:1px solid ${C.line};font:600 14px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink}">${label}
      ${sub ? `<div style="font:400 12px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.mid};margin-top:2px">${sub}</div>` : ""}</td>
    <td align="right" style="padding:9px 14px;border-top:1px solid ${C.line};font:700 15px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink};white-space:nowrap">${value}</td>
  </tr>`;

const section = (title, sub, inner) => `
  <tr><td style="padding:26px 0 8px">
    <div style="font:800 19px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink};letter-spacing:-.01em">${title}</div>
    ${sub ? `<div style="font:400 13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.mid};margin-top:4px">${sub}</div>` : ""}
  </td></tr>
  <tr><td>${inner}</td></tr>`;

const card = inner => `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
  style="background:${C.card};border:1px solid ${C.line};border-radius:10px;border-collapse:separate;overflow:hidden">${inner}</table>`;

const gameCard = g => {
  const side = (nm, pts, p, left, settled) => `
    <tr>
      <td style="padding:10px 14px;font:700 15px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink}">${esc(nm)}
        <div style="font:400 11.5px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.mid};margin-top:2px">
          ${settled ? "all played" : `${left} still to play`}</div></td>
      <td align="right" style="padding:10px 6px;font:700 17px/1.2 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink};white-space:nowrap">${pts.toFixed(1)}</td>
      <td align="right" style="padding:10px 14px;white-space:nowrap">
        <span style="display:inline-block;padding:3px 9px;border-radius:99px;font:800 12px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;
          background:${p >= 0.5 ? "#e8f5ee" : "#fdecec"};color:${p >= 0.5 ? C.green : C.red}">${pc(p)}</span></td>
    </tr>`;
  return card(side(g.a, g.aPts, g.pA, g.aLeft, g.settled)
    + `<tr><td colspan="3" style="border-top:1px solid ${C.line};font-size:0;line-height:0">&nbsp;</td></tr>`
    + side(g.b, g.bPts, g.pB, g.bLeft, g.settled));
};

const html = `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(subject)}</title></head>
<body style="margin:0;padding:0;background:${C.bg}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(
  marquee ? `${marquee.a} ${marquee.aPts.toFixed(1)} v ${marquee.b} ${marquee.bPts.toFixed(1)} — and the board has moved.` : "The DFFL board has moved."
)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};padding:24px 12px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%">

  <tr><td style="padding-bottom:6px">
    <div style="font:800 30px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;letter-spacing:-.03em;color:${C.ink}">DFFL</div>
    <div style="font:600 13px/1.4 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.mid};margin-top:5px;text-transform:uppercase;letter-spacing:.06em">
      Week ${D.week} · ${D.season} season</div>
  </td></tr>

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

  ${D.hurt.length ? section("Out this week",
    "Straight from Sleeper's injury feed, and priced into the board.",
    card(D.hurt.slice(0, 5).map(h => row(esc(h.manager),
      `<span style="color:${C.red}">−${(h.cost * 100).toFixed(1)}%</span>`,
      h.players.map(p => `${esc(p.name)} <span style="color:${C.gold}">${esc(p.status)}</span>`).join(" · "))).join(""))) : ""}

  ${articles.length ? section("From the desk", "Tap a headline to read it in full.",
    articles.map(a => `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:9px">
      <tr><td style="background:${C.card};border:1px solid ${C.line};border-radius:10px;padding:15px 16px">
        ${a.kicker ? `<div style="font:700 10.5px/1.3 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.blue};text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px">${esc(a.kicker)}</div>` : ""}
        <a href="${SITE}#recaps" style="text-decoration:none">
          <div style="font:800 17px/1.25 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.ink};letter-spacing:-.01em">${esc(a.headline)}</div></a>
        ${a.dek ? `<div style="font:400 13px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.mid};margin-top:6px">${esc(a.dek)}</div>` : ""}
        <a href="${SITE}#recaps" style="display:inline-block;margin-top:10px;font:700 13px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.blue};text-decoration:none">Read the full piece →</a>
      </td></tr></table>`).join("")) : ""}

  <tr><td style="padding:26px 0 0">
    <a href="${SITE}" style="display:block;background:${C.ink};color:#fff;text-align:center;padding:14px;
      border-radius:10px;font:700 15px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;text-decoration:none">
      Open the full board →</a>
  </td></tr>

  <tr><td style="padding:20px 4px 0;font:400 11.5px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:${C.mid}">
    Every number here is computed from Sleeper's own data and agrees with the site exactly.
    Win probabilities move while games are being played; records, standings and power rankings
    do not move until a week is finished.<br><br>
    You're getting this because you're in the DFFL. Reply to this email to be taken off it.
  </td></tr>

</table></td></tr></table></body></html>`;

const text = [
  `DFFL — Week ${D.week}, ${D.season}`,
  marquee ? `\nMATCH OF THE WEEK\n${marquee.a} ${marquee.aPts.toFixed(1)} (${pc(marquee.pA)}) v ${marquee.b} ${marquee.bPts.toFixed(1)} (${pc(marquee.pB)})` : "",
  movers.length ? `\nTHE BOARD MOVED\n` + movers.map(m =>
    `${m.manager}: ${pc(m.playoffWas)} -> ${pc(m.playoffNow)} (${m.d > 0 ? "+" : ""}${(m.d * 100).toFixed(0)}pt)`).join("\n") : "",
  race.length ? `\nTHE RACE\n` + race.map(t => `${t.manager}: ${pc(t.playoffNow)} playoffs, ${pc1(t.titleNow)} title`).join("\n") : "",
  articles.length ? `\nFROM THE DESK\n` + articles.map(a => `${a.headline} — ${SITE}#recaps`).join("\n") : "",
  `\n${SITE}`,
].filter(Boolean).join("\n");

await mkdir("data", { recursive: true });
const stem = `data/email-${D.season}-${String(D.week).padStart(2, "0")}`;
const out = arg("--out") || `${stem}.html`;
await writeFile(out, html);
await writeFile(`${stem}.json`, JSON.stringify({
  _comment: "Subject line, plain-text fallback and recipients for the weekly blast. The routine sends the matching .html as the body.",
  season: D.season, week: D.week, generated: new Date().toISOString(),
  subject, text, body_file: `${stem}.html`,
}, null, 1) + "\n");

console.log(`${out} — ${(html.length / 1024).toFixed(1)}KB`);
console.log(`subject: ${subject}`);
console.log(`  ${D.games.length} matchups · ${movers.length} movers · ${D.hurt.length} teams with injuries · ${articles.length} articles`);

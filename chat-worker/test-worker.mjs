// End-to-end smoke test of the Worker in node with a FAKE Anthropic.
//   node chat-worker/test-worker.mjs           (tools hit the public Sleeper API and GitHub Pages)
// No Anthropic call is ever made: fetches to api.anthropic.com are answered by
// a scripted fake that calls every tool once, then answers.
import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";
register("./test-json-hook.mjs", import.meta.url);

const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
const vars = Object.fromEntries([...toml.matchAll(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)].map(m => [m[1], m[2]]));

// Workers runtime stand-ins.
const store = new Map();
globalThis.caches = { default: {
  async match(u) { const v = store.get(String(u)); return v ? new Response(v.body, { headers: v.headers }) : undefined; },
  async put(u, r) { store.set(String(u), { body: await r.text(), headers: Object.fromEntries(r.headers) }); },
} };
const kv = new Map();
const LIMITS = { async get(k) { return kv.get(k) ?? null; }, async put(k, v) { kv.set(k, v); } };
let rlOk = true;
const CHAT_RL = { async limit() { return { success: rlOk }; } };

const realFetch = globalThis.fetch;
const outbound = [];
let script = null, modelCalls = 0;
globalThis.fetch = async (url, init) => {
  url = String(url);
  outbound.push(url);
  if (url.startsWith("https://api.anthropic.com/")) {
    modelCalls++;
    const body = JSON.parse(init.body);
    assert.equal(body.model, "claude-haiku-5-5");
    assert.equal(body.max_tokens, 1024);
    assert.equal(init.headers["x-api-key"], "test-key");
    return new Response(JSON.stringify(script(body)), { headers: { "content-type": "application/json" } });
  }
  assert.ok(!/players\/nfl/.test(url), "never fetch /players/nfl");
  assert.ok(/^https:\/\/(api\.sleeper\.app|drewkim623-hash\.github\.io\/dffl|raw\.githubusercontent\.com\/drewkim623-hash\/dffl)\//.test(url), "allowlisted host: " + url);
  return realFetch(url, init);
};

const { default: worker } = await import("./src/index.js");
const { TOOL_NAMES, runTool } = await import("./src/tools.js");
const { TOOLS } = await import("./src/prompt.js");
const env = { ...vars, ANTHROPIC_API_KEY: "test-key", LIMITS, CHAT_RL };
const waits = [];
const ctx = { waitUntil: p => waits.push(p) };
const ORIGIN = "https://drewkim623-hash.github.io";
const ask = async (q, headers = {}) => {
  const r = await worker.fetch(new Request("https://w.test/", { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body: JSON.stringify({ question: q }) }), env, ctx);
  await Promise.all(waits.splice(0));
  return { status: r.status, body: await r.json(), headers: r.headers };
};

const ARGS = {
  get_standings: {}, get_matchups: { week: 3 }, get_head_to_head: { manager_a: "jadencha", manager_b: "Domo112" },
  get_roster: { manager: "drewkim" }, get_odds_history: { manager: "jadencha" }, get_injuries: { manager: "jskule23" },
  get_projections: { manager: "drewkim" }, get_recap: { week: 9 }, get_rankings: {}, get_keepers: { manager: "bertalicious" },
  get_week: { week: 9 }, search_player: { name: "Mahomes" },
};
let n = 0;
const t = async (name, fn) => { await fn(); n++; console.log(`  ok   ${name}`); };

const results = {};
for (const name of TOOL_NAMES) {
  await t(`tool ${name} returns data, no error`, async () => {
    outbound.length = 0; modelCalls = 0;
    script = body => body.messages.length === 1
      ? { stop_reason: "tool_use", content: [{ type: "tool_use", id: "t1", name, input: ARGS[name] || {} }], usage: { input_tokens: 3000, output_tokens: 40 } }
      : (results[name] = body.messages[2].content[0].content, { stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 5000, output_tokens: 60, cache_read_input_tokens: 2500 } });
    const r = await ask(`test ${name}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.ok && r.body.asOf && r.body.sources.length, JSON.stringify(r.body));
    const out = JSON.parse(results[name]);
    assert.ok(!out.error, results[name].slice(0, 300));
    assert.ok(outbound.length <= 50, `subrequests ${outbound.length}`);
    console.log(`       ${results[name].length} chars, ${outbound.length - modelCalls} data fetches`);
  });
}
await t("head-to-head covers the snapshot seasons", async () => {
  const h = JSON.parse(results.get_head_to_head);
  assert.ok(h.games.some(g => g.season === "2022") && h.all_games.a_wins + h.all_games.b_wins > 3, JSON.stringify(h.all_games));
});
await t("spend counter adds usage × env prices", async () => {
  const k = `spend:${new Date().toISOString().slice(0, 7)}`;
  const per = (3000 * 0.10 + 40 * 0.50 + 5000 * 0.10 + 60 * 0.50 + 2500 * 0.01) / 1e6;
  assert.ok(Math.abs(Number(kv.get(k)) - per * TOOL_NAMES.length) < 1e-5, kv.get(k));
});
await t("CORS: other origins are refused before any work", async () => {
  outbound.length = 0;
  const r = await worker.fetch(new Request("https://w.test/", { method: "POST", headers: { origin: "http://localhost:8000" }, body: "{}" }), env, ctx);
  assert.equal(r.status, 403); assert.equal(r.headers.get("access-control-allow-origin"), null); assert.equal(outbound.length, 0);
  const pre = await worker.fetch(new Request("https://w.test/", { method: "OPTIONS", headers: { origin: ORIGIN } }), env, ctx);
  assert.equal(pre.status, 204); assert.equal(pre.headers.get("access-control-allow-origin"), ORIGIN);
});
await t("RATE_LIMIT: 429 and no model call", async () => {
  rlOk = false; modelCalls = 0;
  const r = await ask("hi");
  rlOk = true;
  assert.equal(r.status, 429); assert.equal(r.body.code, "RATE_LIMIT"); assert.equal(modelCalls, 0);
});
await t("SESSION_CAP after 20 questions in a UTC day, no model call", async () => {
  script = () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } });
  const first = await ask("one");
  const s = first.body.session;
  for (let i = 1; i < 20; i++) assert.equal((await ask("q", { "X-DFFL-Session": s })).status, 200);
  modelCalls = 0;
  const r = await ask("21st", { "X-DFFL-Session": s });
  assert.equal(r.body.code, "SESSION_CAP"); assert.equal(modelCalls, 0);
});
await t("MONTHLY_CAP at $5, no model call", async () => {
  kv.set(`spend:${new Date().toISOString().slice(0, 7)}`, "5.0001");
  modelCalls = 0;
  const r = await ask("hi");
  assert.equal(r.status, 402); assert.equal(r.body.code, "MONTHLY_CAP"); assert.equal(modelCalls, 0);
  kv.clear();
});
await t("tool rounds stop at 4, then the model must answer", async () => {
  modelCalls = 0;
  let sawNone = false;
  script = body => body.tool_choice?.type === "none"
    ? (sawNone = true, { stop_reason: "end_turn", content: [{ type: "text", text: "done" }], usage: { input_tokens: 10, output_tokens: 1 } })
    : { stop_reason: "tool_use", content: [{ type: "tool_use", id: "x" + body.messages.length, name: "get_nfl_state", input: {} }], usage: { input_tokens: 10, output_tokens: 1 } };
  const r = await ask("loop");
  assert.equal(r.body.answer, "done"); assert.equal(modelCalls, 5); assert.ok(sawNone);
});
await t("missing API key is a config error, no model call", async () => {
  modelCalls = 0;
  const r = await worker.fetch(new Request("https://w.test/", { method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify({ question: "x" }) }), { ...env, ANTHROPIC_API_KEY: "" }, ctx);
  const b = await r.json();
  assert.equal(b.code, "ERROR"); assert.equal(b.reason, "CONFIG"); assert.equal(modelCalls, 0);
});
await t("answers never show Sleeper ids", async () => {
  script = () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "jadencha (owner_id 850931930408001536, team Foo) is in first, ahead of Domo112, owner_id 123456789012345678, at 141.96." }], usage: { input_tokens: 10, output_tokens: 1 } });
  const r = await ask("who is first");
  assert.equal(r.body.answer, "jadencha is in first, ahead of Domo112, at 141.96.");
  const { stripIds } = await import("./src/index.js");
  assert.equal(stripIds("Scored 141.96 in week 9 (as of Nov 10)."), "Scored 141.96 in week 9 (as of Nov 10).");
});
await t("stripIds removes datetimes and ids but keeps calendar dates", async () => {
  const { stripIds } = await import("./src/index.js");
  for (const stamp of ["2026-11-10T15:13:00Z", "2026-11-10T15:13:00.000Z", "2026-11-10T15:13:00.123Z", "2026-11-10 15:13:00", "2026-11-10T15:13:00-05:00", "2026-11-10T15:13:00+0530"])
    assert.ok(!stripIds(`answer ${stamp} done`).includes(stamp), stamp);
  assert.equal(stripIds("Season began 2026-11-10."), "Season began 2026-11-10.");
  assert.equal(stripIds("Scored 141.96 in week 9 (as of Nov 10)."), "Scored 141.96 in week 9 (as of Nov 10).");
});
await t("full answer path strips timestamp and Sleeper ids", async () => {
  script = () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "At 2026-11-10T15:13:00.123Z owner_id 850931930408001536 user_id=123456789012345678 roster_id: 99999999999999999." }], usage: { input_tokens: 10, output_tokens: 1 } });
  const r = await ask("answer with internal details");
  assert.equal(r.status, 200);
  assert.doesNotMatch(r.body.answer, /2026-11-10T|owner_id|user_id|roster_id|\b\d{15,20}\b/);
});
await t("get_trades returns the specified keeper-rights terms", async () => {
  const c = { env, ctx, memo: new Map(), budget: { used: 0, max: 50 }, sources: new Set(), asOfs: [] };
  const bowersOut = JSON.parse(await runTool(c, "get_trades", { player: "Bowers" }));
  assert.ok(!bowersOut.error, JSON.stringify(bowersOut));
  const bowers = bowersOut.rights.find(x => x.player.toLowerCase().includes("bowers"));
  assert.ok(bowers, "Bowers");
  assert.match(bowers.terms, /2026-only loan/i);
  assert.match(bowers.terms, /drewkim keeps his keeper rights/i);
  assert.equal(bowers.roster_2026, "Domo112");
  assert.equal(bowers.rights_2027, "drewkim");
  assert.equal(bowers.note, "drew keeps rights,doesnt finish top 3 drew gets 9th instead of 7th");
  assert.match(bowers.condition.text, /not finish as a top-3 TE/i);
  assert.match(bowers.condition.text, /2027 9th instead of .*2027 7th/i);
  assert.match(bowers.condition.measured_by, /2026 season finish/i);
  assert.match(bowers.condition.measured_by, /league scoring/i);

  for (const [player, terms, note, roster, rights] of [
    ["Coker", "2026-only loan", "dom owns rights ", "drewkim", "Domo112"],
    ["Bijan", "2026 roster", "drew gets rights ", "Domo112", "drewkim"],
  ]) {
    const out = JSON.parse(await runTool(c, "get_trades", { player }));
    assert.ok(!out.error, JSON.stringify(out));
    const item = out.rights.find(x => x.player.toLowerCase().includes(player.toLowerCase()));
    assert.ok(item, player);
    assert.equal(item.roster_2026, roster);
    assert.equal(item.rights_2027, rights);
    assert.ok(item.terms.toLowerCase().includes(terms.toLowerCase()), item.terms);
    assert.ok(item.note === note || JSON.stringify(out.trades).includes(note), JSON.stringify(item));
  }
  const empty = JSON.parse(await runTool(c, "get_trades", {}));
  assert.ok(empty.trades.length && !empty.error);
});
await t("get_keepers explicitly means start-of-season keeper list", async () => {
  const d = TOOLS.find(x => x.name === "get_keepers").description;
  assert.match(d, /start-of-season keeper list/i);
  assert.match(d, /not current ownership/i);
  assert.match(d, /not current keeper rights/i);
  const c = { env, ctx, memo: new Map(), budget: { used: 0, max: 50 }, sources: new Set(), asOfs: [] };
  const out = JSON.parse(await runTool(c, "get_keepers", { season: "2026" }));
  assert.match(out.scope, /start-of-season keepers/i);
});
console.log(`\n${n} passed`);

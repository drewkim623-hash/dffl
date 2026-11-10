// Pure tests for the spend math and caps: node chat-worker/test-limits.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { costUsd, conservativeUsage, caps, capToolText, trimToFit, estTokens, spendKey, sessKey, corsHeaders, validSession, newSession, ALLOWED_ORIGIN } from "./src/limits.js";

// Prices from wrangler.toml [vars], so the test checks the real config.
const toml = readFileSync(new URL("./wrangler.toml", import.meta.url), "utf8");
const env = Object.fromEntries([...toml.matchAll(/^([A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)].map(m => [m[1], m[2]]));
let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok   ${name}`); };

t("model id is claude-haiku-5-5", () => assert.equal(env.MODEL, "claude-haiku-5-5"));
t("prices match the official ≤100k table", () => {
  assert.deepEqual([env.PRICE_INPUT_USD_PER_MTOK, env.PRICE_OUTPUT_USD_PER_MTOK, env.PRICE_CACHE_WRITE_5M_USD_PER_MTOK, env.PRICE_CACHE_HIT_USD_PER_MTOK], ["0.10", "0.50", "0.125", "0.01"]);
});
t("cost: 1M of each token kind", () => {
  const usd = costUsd({ input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 }, env);
  assert.ok(Math.abs(usd - (0.10 + 0.50 + 0.125 + 0.01)) < 1e-9, String(usd));
});
t("cost: a typical turn is a fraction of a cent", () => {
  const usd = costUsd({ input_tokens: 8000, output_tokens: 300, cache_read_input_tokens: 3000 }, env);
  assert.ok(Math.abs(usd - (8000 * 0.10 + 300 * 0.50 + 3000 * 0.01) / 1e6) < 1e-12);
});
t("cost: missing usage is charged at the caps", () => {
  const c = caps(env);
  assert.equal(c.maxInput, 20000); assert.equal(c.maxOutput, 1024); assert.equal(c.maxRounds, 4); assert.equal(c.monthlyUsd, 5); assert.equal(c.sessionDaily, 20);
  assert.ok(Math.abs(costUsd(conservativeUsage(c), env) - (20000 * 0.10 + 1024 * 0.50) / 1e6) < 1e-12);
});
t("cost: prices come from env, not literals", () => {
  assert.equal(costUsd({ input_tokens: 1e6 }, { ...env, PRICE_INPUT_USD_PER_MTOK: "7" }), 7);
  assert.throws(() => costUsd({ input_tokens: 1 }, {}));
});
t("tool result cap truncates and says so", () => {
  const s = "x".repeat(40000);
  const out = capToolText(s, 8000);
  assert.ok(out.length <= 32000 && /truncated/.test(out));
  assert.equal(capToolText("short", 8000), "short");
});
t("trimToFit shrinks tool results under the input cap", () => {
  const msgs = [{ role: "user", content: "q" }, { role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "y".repeat(120000) }] }];
  assert.ok(trimToFit("sys", [], msgs, 20000));
  assert.ok(estTokens(msgs) <= 20000);
});
t("keys are UTC month and day", () => {
  const d = new Date("2026-11-30T23:59:59Z");
  assert.equal(spendKey(d), "spend:2026-11");
  assert.equal(sessKey("ab", d), "sess:ab:2026-11-30");
  assert.equal(spendKey(new Date("2026-12-01T00:00:00Z")), "spend:2026-12");
});
t("CORS echoes only the Pages origin", () => {
  assert.equal(corsHeaders(ALLOWED_ORIGIN)["Access-Control-Allow-Origin"], "https://drewkim623-hash.github.io");
  assert.equal(corsHeaders("http://localhost:8000")["Access-Control-Allow-Origin"], undefined);
  assert.equal(corsHeaders("https://evil.example")["Access-Control-Allow-Origin"], undefined);
});
t("session ids are 128-bit hex", () => {
  const s = newSession();
  assert.ok(validSession(s)); assert.ok(!validSession("abc")); assert.ok(!validSession(s + "0"));
});
t("no secrets in wrangler.toml", () => assert.ok(!/sk-ant-|ANTHROPIC_API_KEY\s*=/.test(toml)));
console.log(`\n${n} passed`);

// Pure helpers for the chat Worker's limits. No Workers globals at module
// level, so node can import this file for tests.

export const ALLOWED_ORIGIN = "https://drewkim623-hash.github.io";

// UTC windows. The monthly key rolls at 00:00 UTC on the 1st, the same window
// Anthropic's console spend limit uses.
export const utcDay = (d = new Date()) => d.toISOString().slice(0, 10);
export const utcMonth = (d = new Date()) => d.toISOString().slice(0, 7);
export const spendKey = (d) => `spend:${utcMonth(d)}`;
export const sessKey = (id, d) => `sess:${id}:${utcDay(d)}`;

const num = (v, dflt) => { const n = Number(v); return Number.isFinite(n) ? n : dflt; };

// Caps from wrangler.toml [vars]; the fallbacks only matter if a var is deleted.
export function caps(env) {
  return {
    monthlyUsd: num(env.MONTHLY_CAP_USD, 5),
    maxInput: num(env.MAX_INPUT_TOKENS, 20000),
    maxOutput: num(env.MAX_OUTPUT_TOKENS, 1024),
    maxRounds: num(env.MAX_TOOL_ROUNDS, 4),
    maxToolTokens: num(env.MAX_TOOL_RESULT_TOKENS, 8000),
    sessionDaily: num(env.SESSION_DAILY_LIMIT, 20),
    maxQuestionChars: num(env.MAX_QUESTION_CHARS, 500),
  };
}

// USD for one Messages API response. Prices come from env (wrangler.toml
// [vars]), never literals here. A missing price is treated as the output
// price, the most expensive one, so a config slip over-counts, not under.
export function costUsd(usage, env) {
  const out = num(env.PRICE_OUTPUT_USD_PER_MTOK, NaN);
  const p = k => num(env[k], out);
  if (!Number.isFinite(out)) throw new Error("PRICE_OUTPUT_USD_PER_MTOK is not set");
  const u = usage || {};
  return (
    num(u.input_tokens, 0) * p("PRICE_INPUT_USD_PER_MTOK") +
    num(u.output_tokens, 0) * out +
    num(u.cache_creation_input_tokens, 0) * p("PRICE_CACHE_WRITE_5M_USD_PER_MTOK") +
    num(u.cache_read_input_tokens, 0) * p("PRICE_CACHE_HIT_USD_PER_MTOK")
  ) / 1e6;
}

// When a response has no usage block, charge as if the whole input cap went in
// at the input price and the whole output cap came out.
export function conservativeUsage(c) {
  return { input_tokens: c.maxInput, output_tokens: c.maxOutput };
}

// ~4 characters per token. Rough, but only used to keep prompts under the cap;
// the real count comes back in usage and is what gets billed.
export const estTokens = s => Math.ceil((typeof s === "string" ? s.length : JSON.stringify(s ?? "").length) / 4);

// Cap one tool result at maxTokens, saying so in the result itself.
export function capToolText(text, maxTokens) {
  const max = maxTokens * 4;
  if (text.length <= max) return text;
  return text.slice(0, max - 120) + `…[truncated: tool result was ~${estTokens(text)} tokens, cap ${maxTokens}. Ask a narrower question.]`;
}

// Estimated size of a request body (system + tools + messages).
export const promptTokens = (system, tools, messages) => estTokens(system) + estTokens(tools) + estTokens(messages);

// Shrink the largest tool_result blocks until the prompt fits under maxInput.
// Returns false if it cannot get under (the caller then stops calling tools).
export function trimToFit(system, tools, messages, maxInput) {
  for (let i = 0; i < 12 && promptTokens(system, tools, messages) > maxInput; i++) {
    let big = null;
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const b of m.content) if (b.type === "tool_result" && (!big || b.content.length > big.content.length)) big = b;
    }
    if (!big || big.content.length < 400) return false;
    big.content = big.content.slice(0, Math.floor(big.content.length / 2)) + "…[trimmed to fit the per-question input cap]";
  }
  return promptTokens(system, tools, messages) <= maxInput;
}

export function corsHeaders(origin) {
  const h = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-DFFL-Session",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
  if (origin === ALLOWED_ORIGIN) h["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
  return h;
}

// Session ids are 128 random bits as hex. Anything else is ignored and a new
// one is minted.
export const validSession = s => typeof s === "string" && /^[0-9a-f]{32}$/.test(s);
export function newSession() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return Array.from(b, x => x.toString(16).padStart(2, "0")).join("");
}

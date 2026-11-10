// DFFL "Ask the league" Worker. One POST per question:
//   { question, session? }  ->  { ok, answer, sources, asOf, session }
// Errors: { ok:false, code: "MONTHLY_CAP"|"SESSION_CAP"|"RATE_LIMIT"|"ERROR", error }
//
// Order matters: every check that can refuse a question runs before the first
// Anthropic call, so a refused question costs nothing.
import { ALLOWED_ORIGIN, caps, corsHeaders, costUsd, conservativeUsage, capToolText, trimToFit, spendKey, sessKey, validSession, newSession } from "./limits.js";
import { SYSTEM, TOOLS } from "./prompt.js";
import { toolCtx, runTool } from "./tools.js";

const ANTHROPIC = "https://api.anthropic.com/v1/messages";
const SUBREQUESTS = 50;        // Workers Free, per request
const MAX_TOOLS_PER_ROUND = 6;

// System and tools are identical on every call, so mark the end of each for
// the prompt cache. Below the model's minimum cacheable length this is a no-op.
const SYSTEM_BLOCKS = [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }];
const TOOL_DEFS = TOOLS.map((t, i) => (i === TOOLS.length - 1 ? { ...t, cache_control: { type: "ephemeral" } } : t));

export default {
  async fetch(req, env, ctx) {
    const origin = req.headers.get("Origin");
    const cors = corsHeaders(origin);
    const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json", "cache-control": "no-store" } });
    const fail = (status, code, error, extra) => reply(status, { ok: false, code, error, ...extra });

    // CORS: the GitHub Pages origin only. No localhost in production.
    if (origin !== ALLOWED_ORIGIN) return fail(403, "ERROR", "This chat only answers on the DFFL site.");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (req.method !== "POST") return fail(405, "ERROR", "POST only.");

    const c = caps(env);
    let body;
    try { body = await req.json(); } catch { return fail(400, "ERROR", "Bad request."); }
    const question = typeof body?.question === "string" ? body.question.trim() : "";
    if (!question) return fail(400, "ERROR", "Ask a question.");
    if (question.length > c.maxQuestionChars) return fail(400, "ERROR", `Keep it under ${c.maxQuestionChars} characters.`);

    // Per-IP rate limit (Rate Limiting binding, 8 / 60 s). Fails closed.
    const ip = req.headers.get("CF-Connecting-IP") || "unknown";
    if (!env.CHAT_RL || !env.LIMITS) return fail(503, "ERROR", "Chat isn't set up yet.", { reason: "CONFIG" });
    const { success } = await env.CHAT_RL.limit({ key: ip });
    if (!success) return fail(429, "RATE_LIMIT", "Too many questions at once. Wait a minute and try again.", { retryable: true });

    if (!env.ANTHROPIC_API_KEY || !env.MODEL) return fail(503, "ERROR", "Chat isn't set up yet.", { reason: "CONFIG" });

    // Session: a random id the page keeps in sessionStorage and sends back as
    // X-DFFL-Session (cross-site cookies from github.io to workers.dev are
    // blocked by Safari, so no cookie). Minting a new one is free; the IP limit
    // and the monthly cap are the real backstops.
    const sent = req.headers.get("X-DFFL-Session") || body.session;
    const session = validSession(sent) ? sent : newSession();
    const now = new Date();
    const [spentRaw, usedRaw] = await Promise.all([env.LIMITS.get(spendKey(now)), env.LIMITS.get(sessKey(session, now))]);
    const spent = Number(spentRaw) || 0, used = Number(usedRaw) || 0;

    if (spent >= c.monthlyUsd) return fail(402, "MONTHLY_CAP", "Out of questions this month", { session });
    if (used >= c.sessionDaily) return fail(429, "SESSION_CAP", `That's ${c.sessionDaily} questions today. The chat resets at midnight UTC.`, { session });

    // Count the question now, before any spend, so failures still count.
    ctx.waitUntil(env.LIMITS.put(sessKey(session, now), String(used + 1), { expirationTtl: 60 * 60 * 48 }));

    const budget = { used: 0, max: SUBREQUESTS - (c.maxRounds + 1) - 2 }; // reserve the model calls + slack
    const tc = toolCtx(env, ctx, budget);
    const messages = [{ role: "user", content: question }];
    let cost = 0, answer = "";
    try {
      for (let round = 0; ; round++) {
        let final = round >= c.maxRounds;
        if (!trimToFit(SYSTEM, TOOL_DEFS, messages, c.maxInput)) {
          if (round === 0) return fail(400, "ERROR", "That question is too long.", { session });
          final = true;
          // Tool output still too big after trimming: drop the bodies and make the model answer.
          for (const m of messages) if (Array.isArray(m.content)) for (const b of m.content) if (b.type === "tool_result") b.content = '{"error":"result dropped: over the per-question input cap"}';
        }
        const r = await fetch(ANTHROPIC, {
          method: "POST",
          headers: { "content-type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({ model: env.MODEL, max_tokens: c.maxOutput, system: SYSTEM_BLOCKS, tools: TOOL_DEFS, messages, ...(final ? { tool_choice: { type: "none" } } : {}) }),
          signal: AbortSignal.timeout(25000),
        });
        if (!r.ok) {
          console.log("anthropic", r.status, (await r.text()).slice(0, 300));
          return fail(502, "ERROR", "Couldn't reach the league books. Try again.", { session });
        }
        const data = await r.json();
        cost += costUsd(data.usage || conservativeUsage(c), env);
        const blocks = data.content || [];
        const uses = blocks.filter(b => b.type === "tool_use");
        if (data.stop_reason !== "tool_use" || !uses.length || final) {
          answer = blocks.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
          break;
        }
        messages.push({ role: "assistant", content: blocks });
        const results = await Promise.all(uses.map((u, i) => i < MAX_TOOLS_PER_ROUND
          ? runTool(tc, u.name, u.input)
          : Promise.resolve('{"error":"too many tool calls in one round"}')));
        messages.push({ role: "user", content: uses.map((u, i) => ({ type: "tool_result", tool_use_id: u.id, content: capToolText(results[i], c.maxToolTokens) })) });
      }
    } catch (e) {
      console.log("chat error", String(e?.message || e).slice(0, 300));
      return fail(502, "ERROR", "Couldn't reach the league books. Try again.", { session });
    } finally {
      // One KV write per question that reached the model. Re-read first to
      // narrow (not close) the window where two questions both add to the same
      // old total; KV is eventually consistent, so a burst can overshoot a bit.
      if (cost > 0) ctx.waitUntil((async () => {
        const k = spendKey(now);
        const cur = Number(await env.LIMITS.get(k)) || 0;
        await env.LIMITS.put(k, String(Math.round((cur + cost) * 1e6) / 1e6), { expirationTtl: 60 * 60 * 24 * 40 });
      })());
    }

    answer = stripIds(answer);
    if (!answer) answer = "I don't know — that isn't in the league data.";
    const asOf = tc.asOfs.filter(Boolean).map(String).sort()[0] || now.toISOString(); // oldest source wins
    return reply(200, { ok: true, answer, sources: [...tc.sources].slice(0, 6), asOf, session });
  },
};

// Members should never see Sleeper's internal ids, even if the model echoes one.
export function stripIds(t) {
  return String(t || "")
    .replace(/\s*\((?:[^()]*?\b(?:owner_id|user_id|roster_id)\b[^()]*?)\)/gi, "")
    .replace(/,?\s*\b(?:owner_id|user_id|roster_id)\b\s*[:=#]?\s*\d+/gi, "")
    .replace(/\b\d{15,20}\b/g, "")
    .replace(/[ \t]{2,}/g, " ").replace(/ +([,.;:!?])/g, "$1").trim();
}

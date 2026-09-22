/**
 * fetchJSON — the one way the build scripts talk to Sleeper.
 *
 * Everything in this repo runs unattended on a schedule, and Sleeper drops a
 * connection now and then. On 21 September 2026 the daily run died three
 * seconds in with `read ECONNRESET` while pulling the roster list: one reset
 * on one of five parallel calls, and the whole job failed having written
 * nothing. The endpoint was fine a minute later. The only thing actually wrong
 * was that a bare fetch gets one attempt.
 *
 * So: retry the failures worth retrying — a dropped connection, a timeout, an
 * HTTP 5xx, a 429 — and give up at once on the ones that are not. A 404 will
 * not become a 200 on the third ask, and a job that fails fast on a bad URL is
 * easier to read than one that fails slowly.
 *
 *   const state = await fetchJSON("https://api.sleeper.app/v1/state/nfl");
 *   const users = await fetchJSON(`${API}/league/${LEAGUE}/users`, { label: "users" });
 *
 * `label` is what appears in the error and the retry notice; it defaults to the
 * URL, and the callers pass the short path so the messages read as they did
 * before this existed.
 *
 * Dependency-free on purpose, like the scripts that import it: the Action has
 * no install step before the build, so anything here runs on the bare runtime.
 */

// Four attempts, 7.5s of waiting in the worst case. Long enough to outlast the
// blip that caused this; short enough that a genuinely dead endpoint does not
// hold the job open.
const BACKOFF = [500, 2000, 5000];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Worth another ask: the request never landed, took too long, or hit a server
// that is briefly unhappy. Every other status is a fact about the request
// itself, and asking again only wastes the run's time.
const worthRetrying = status => status === 408 || status === 429 || status >= 500;

// The useful half of a network error. `fetch failed` on its own says nothing;
// the code underneath it — ECONNRESET, ENOTFOUND, ETIMEDOUT — says everything.
const why = e =>
  (e && e.cause && e.cause.code) ||
  (e && e.name === "TimeoutError" && "timed out") ||
  (e && e.message) ||
  String(e);

export async function fetchJSON(url, { label = url, tries = 4, timeoutMs = 30000 } = {}) {
  let last;

  for (let attempt = 1; attempt <= tries; attempt++) {
    if (attempt > 1) await sleep(BACKOFF[Math.min(attempt - 2, BACKOFF.length - 1)]);

    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!r.ok) {
        const e = new Error(`${label} -> HTTP ${r.status}`);
        e.permanent = !worthRetrying(r.status);
        throw e;
      }
      // Parsed inside the try on purpose: a body that stops arriving half way
      // through throws here rather than above, and that is precisely the
      // failure this function exists to survive.
      return await r.json();
    } catch (e) {
      if (e.permanent) throw e;
      last = e;
      if (attempt < tries) {
        console.warn(`${label}: ${why(e)} — attempt ${attempt} of ${tries} failed, retrying`);
      }
    }
  }

  throw new Error(`${label} failed ${tries} times, last: ${why(last)}`, { cause: last });
}

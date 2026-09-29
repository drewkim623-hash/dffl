/**
 * Which recap a blast carried, for the ledger.
 *
 * The subject says "DFFL Week 3" because that is the week coming up. The recap
 * inside it is numbered by the week just played, so the same email carries the
 * week 2 recap. Copying the number out of the subject logged a recap that did
 * not exist yet, and the guard would then have called the real one "already
 * blasted" the day it was written.
 *
 * compose-email.mjs always carries the newest recap and nothing else, so that
 * is the default here and anything else has to be argued for. Pure: no files,
 * no process, nothing at import time. blast-status.mjs does the reading.
 *
 * recapSendGuard, at the bottom, is the other half: whether a new recap should
 * go out at all right now. recap-guard.mjs does the reading for that one.
 */

// Exactly the sort compose-email.mjs uses to pick lastWeek.
export function newestRecap(recaps) {
  const w = ((recaps && recaps.weeks) || []).slice()
    .sort((a, b) => Number(b.season) - Number(a.season) || b.week - a.week)[0];
  return w ? { season: String(w.season), week: Number(w.week) } : null;
}

const absent = v => v === null || v === undefined;
const flagless = v => String(v).startsWith("--");

export function resolveRecapWeek({ recaps, weekArg, seasonArg, noRecap = false, allowOlder = false }) {
  const newest = newestRecap(recaps);
  const weeks = (recaps && recaps.weeks) || [];
  const has = (season, week) => weeks.some(w => String(w.season) === season && Number(w.week) === week);
  const newestName = newest ? `${newest.season} week ${newest.week}` : null;

  if (noRecap) {
    if (!absent(weekArg)) throw new Error("--no-recap and --week contradict each other: pass one or the other.");
    return null;
  }

  let season = null;
  if (!absent(seasonArg)) {
    if (flagless(seasonArg) || !/^\d{4}$/.test(String(seasonArg)))
      throw new Error(`--season needs a four-digit year, got "${seasonArg}".`);
    season = String(seasonArg);
  }

  /* No --week: record what compose-email put in the email, which is the newest
   * recap, or nothing at all in the preseason. */
  if (absent(weekArg)) {
    if (!newest) return null;
    if (season && season !== newest.season)
      throw new Error(`--season ${season} does not match the recap the email carried: compose-email sends `
        + `the newest recap, which is ${newestName}. Drop --season, or check recaps.json.`);
    return newest;
  }

  const raw = String(weekArg);
  if (flagless(raw) || !/^[1-9]\d*$/.test(raw))
    throw new Error(`--week needs a positive whole number (the recap week just played), got "${raw}".`);
  const week = Number(raw);

  if (!newest)
    throw new Error(`--week ${week} has no recap in recaps.json — there are no recaps yet, so the email `
      + `carried none. Omit --week, or pass --no-recap.`);

  season = season || newest.season;

  /* The mix-up this exists for: the week in the subject is one past the recap. */
  if (!has(season, week)) {
    const elsewhere = weeks.find(w => String(w.season) !== season && Number(w.week) === week);
    throw new Error(`--week ${week} has no recap in recaps.json (season ${season}). --week is the recap `
      + `week just played — the newest is ${newestName} — not the "Week N" in the email subject. `
      + `An email titled "DFFL Week ${newest.week + 1}: ..." carries the week ${newest.week} recap: `
      + `record it with --week ${newest.week}, or omit --week.`
      + (elsewhere ? ` (recaps.json does have ${elsewhere.season} week ${week}; add --season `
        + `${elsewhere.season} only if that is really the recap the email carried.)` : ""));
  }

  /* A real recap, but not the one compose-email would have sent. */
  if ((season !== newest.season || week !== newest.week) && !allowOlder)
    throw new Error(`--week ${week} (${season}) is an older recap. compose-email only ever sends the newest `
      + `recap, ${newestName}, so this is almost certainly the subject/recap mix-up: record it with `
      + `--week ${newest.week}, or omit --week. --allow-older-week exists only for backfilling a send that `
      + `really went out before a newer recap was written (e.g. recording a past send with --at).`);

  return { season: String(season), week };
}

/**
 * The "which week" guard, before a new recap goes to the league.
 *
 * The routine that sends cannot reach Sleeper, so it judges from
 * data/latest.json, which build-week.mjs writes with Sleeper's state as it
 * read it and a generated_at timestamp. Four things must all hold:
 *
 *   final   latest.final is true — every NFL game that week complete and
 *           every league matchup scored.
 *   week    Sleeper's state week, as recorded, is latest.week + 1 — or it is
 *           still latest.week. Sleeper flips state.week hours after the last
 *           game (still 2 at midnight after week 2's Monday game, 3 by 07:00),
 *           so at 1 AM Tuesday "== week + 1" alone would refuse nearly every
 *           real Tuesday. "Still latest.week" is only accepted because final
 *           has to be true as well, which is the thing Sleeper's flip was
 *           standing in for. Anything else — two weeks behind, a different
 *           season, behind latest — fails.
 *   fresh   generated_at is under maxAgeHours old (12 by default). File
 *           mtimes in a git checkout mean nothing; only this timestamp does.
 *           It refreshes on every Action run once the previous week is final
 *           — including during Monday night's game — so it proves the Action
 *           ran recently, nothing more.
 *   unsent  that recap week is not already logged in data/sent-emails.json.
 *           This, with every send recorded, is what actually stops a repeat.
 *
 * The same "Sleeper hasn't flipped but the week is final" reading is what the
 * site and the email build use (effective-week.mjs), so an email sent on the
 * strength of rule 2's second branch is already titled for the next week.
 *
 * Returns every condition with ok and a sentence, so the routine can say
 * exactly which one failed. Pure: pass the parsed files and the time.
 */
export function recapSendGuard({ latest, ledger, now = Date.now(), maxAgeHours = 12 }) {
  const l = latest || {};
  const st = l.sleeper_state || {};
  const week = Number(l.week);
  const season = l.season != null ? String(l.season) : null;
  const hasWeek = Number.isInteger(week) && week >= 1 && !!season;
  const name = hasWeek ? `${season} week ${week}` : "(no week)";
  const checks = [];
  const add = (id, ok, message) => checks.push({ id, ok: !!ok, message });

  add("final", l.final === true,
    l.final === true ? `latest.json says ${name} is final`
      : `latest.json does not say ${name} is final (final is ${JSON.stringify(l.final)})`);

  const sw = Number(st.week);
  const sSeason = st.season != null ? String(st.season) : null;
  let weekOk = false, weekMsg;
  if (!hasWeek) weekMsg = "latest.json has no usable season/week";
  else if (st.week === undefined || st.week === null || !Number.isFinite(sw))
    weekMsg = "latest.json has no sleeper_state.week, so the week cannot be checked";
  else if (sSeason !== season)
    weekMsg = `Sleeper was in season ${sSeason}, latest.json is ${season}`;
  else if (sw === week + 1) { weekOk = true; weekMsg = `Sleeper had moved on to week ${sw}, one past ${name}`; }
  else if (sw === week && l.final === true) { weekOk = true; weekMsg = `Sleeper still called week ${sw} current, and it is final`; }
  else if (sw === week) weekMsg = `Sleeper still called week ${sw} current and it is not marked final`;
  else weekMsg = `Sleeper was at week ${sw}; latest.json is week ${week}, so it is ${sw > week ? "stale" : "ahead of Sleeper"}`;
  add("week", weekOk, weekMsg);

  const t = Date.parse(l.generated_at);
  const nowMs = typeof now === "number" ? now : Date.parse(now);
  const ageH = (nowMs - t) / 36e5;
  let freshOk = false, freshMsg;
  if (!l.generated_at || !Number.isFinite(t)) freshMsg = "latest.json has no generated_at";
  else if (ageH < -0.25) freshMsg = `generated_at ${l.generated_at} is in the future`;
  else if (ageH >= maxAgeHours) freshMsg = `generated_at ${l.generated_at} is ${ageH.toFixed(1)} hours old (limit ${maxAgeHours})`;
  else { freshOk = true; freshMsg = `generated_at is ${Math.max(0, ageH).toFixed(1)} hours old`; }
  add("fresh", freshOk, freshMsg);

  const sent = ((ledger && ledger.sent) || []).find(s => s && s.recap
    && String(s.recap.season) === season && Number(s.recap.week) === week);
  add("unsent", hasWeek && !sent,
    !hasWeek ? "no recap week to check against the ledger"
      : sent ? `the ${name} recap is already logged as sent (${sent.at}, "${sent.subject}")`
        : `the ${name} recap is not in data/sent-emails.json yet`);

  const failed = checks.filter(c => !c.ok);
  return { ok: failed.length === 0, recap: hasWeek ? { season, week } : null, checks, failed: failed.map(c => c.id) };
}

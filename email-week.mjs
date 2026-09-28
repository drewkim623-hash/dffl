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

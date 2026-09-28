/**
 * The effective current week — one rule for the site and the email.
 *
 * Sleeper advances state.week hours after Monday night's last game: every
 * week 2 game was final at 23:40 ET on 21 September and state.week still read
 * 2 after midnight; it read 3 by 07:03. Until it flips, the site used to treat
 * the finished week as live, and the email snapshot (build-email.mjs, which
 * reads the site) would title a 1 AM Tuesday email with the finished week and
 * show it as in progress.
 *
 * build-week.mjs marks a week final in data/latest.json once every NFL game in
 * it is complete and every league matchup is scored. So: if latest.json says
 * the week Sleeper still calls current is final, act as though Sleeper had
 * already advanced — the effective week is latest.week + 1. Otherwise
 * Sleeper's state is used exactly as it comes.
 *
 * index.html carries a byte-for-byte copy of effectiveState between the
 * effective-week:begin/end markers (it has no module loader), and
 * test-effective-week.mjs checks that the two agree. Change both or neither.
 *
 * Pure: no network, no files.
 */

/* effective-week:begin */
function effectiveState(state, latest) {
  if (!state || !latest || latest.final !== true) return state;
  const sw = Number(state.week), lw = Number(latest.week);
  if (!Number.isInteger(sw) || sw < 1 || lw !== sw) return state;
  if (String(latest.season) !== String(state.season)) return state;
  const bump = v => (Number(v) === sw ? sw + 1 : v);
  return Object.assign({}, state, {
    week: sw + 1, leg: bump(state.leg), display_week: bump(state.display_week),
    sleeper_week: sw, advanced_by: "latest.json",
  });
}
/* effective-week:end */

/** Just the number: Sleeper's week, or one past it once latest.json says it is over. */
function effectiveWeek(state, latest) {
  const s = effectiveState(state, latest);
  const w = s ? Number(s.week) : NaN;
  return Number.isFinite(w) ? w : null;
}

export { effectiveState, effectiveWeek };

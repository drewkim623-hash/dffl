#!/usr/bin/env bash
# Commit the data a workflow just built and push it to the branch, retrying.
#
#   bash publish-data.sh "<commit message>" "<rebuild commands>" <path>...
#
# Used by sleeper-poll.yml and injury-refresh.yml (weekly-data.yml keeps its
# own inline step). Stages <path>..., commits if anything changed, then up to
# PUBLISH_ATTEMPTS (default 5) times:
#   - fetch origin and rebase the commit onto it, then push;
#   - a push that fails (a transient "fatal error in commit_refs_rules", a
#     race with another push) keeps the commit and tries again after a backoff,
#     so the computed results are not thrown away;
#   - a rebase that conflicts is aborted, the tree is reset to origin and
#     <rebuild commands> rerun on top of it (they must exit 0, or this exits
#     1 with nothing pushed), then recommitted.
# A fetch that fails is waited out the same way. No force push, ever. Exits 1
# with ::error:: only when every attempt failed.
set -uo pipefail

msg="$1"; rebuild="$2"; shift 2
branch="${GITHUB_REF_NAME:-main}"
attempts="${PUBLISH_ATTEMPTS:-5}"
backoff="${PUBLISH_BACKOFF:-10}"

commit() {
  git add -A "$@"
  if git diff --staged --quiet; then return 1; fi
  git commit -q -m "$msg"
}

if ! commit "$@"; then
  echo "Nothing changed."
  exit 0
fi

for i in $(seq 1 "$attempts"); do
  if ! git fetch origin "$branch"; then
    echo "::warning::fetch of origin/$branch failed (attempt $i of $attempts)."
  elif git rebase "origin/$branch"; then
    if git push origin "HEAD:$branch"; then
      echo "Published to $branch (attempt $i of $attempts)."
      exit 0
    fi
    echo "::warning::push to $branch failed (attempt $i of $attempts); keeping the commit and retrying."
  else
    git rebase --abort || true
    echo "::warning::rebase onto origin/$branch failed (attempt $i of $attempts); regenerating on top of it."
    git reset --hard "origin/$branch"
    # Not inside an `if`: bash ignores set -e in a tested command.
    ( set -e; eval "$rebuild" ); rc=$?
    if [ "$rc" -ne 0 ]; then
      echo "::error::Rebuilding on top of origin/$branch failed; nothing pushed."
      exit 1
    fi
    if ! commit "$@"; then
      echo "Nothing changed on top of origin/$branch."
      exit 0
    fi
  fi
  if [ "$i" -lt "$attempts" ]; then sleep $((backoff * i)); fi
done

echo "::error::Could not publish to $branch after $attempts attempts; nothing pushed."
exit 1

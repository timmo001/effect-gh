#!/usr/bin/env bash
# Tooling drift: compare the reviewed tool release in tooling.yml with the
# latest release, and publish a refreshed tree as one pull request per
# release. The tooling drift workflow runs it; it works locally too.
#
#   scripts/tooling-drift.sh status         print repo, reviewed, latest and behind
#   scripts/tooling-drift.sh publish <tag>  commit the refreshed tree and open or update the pull request
#
# A pull request that only moves the pin is titled "[Pin-only] Update
# <repo> to <tag>" and gets squash auto-merge; one that changes the contract
# snapshot is titled "Update <repo> to <tag>" and waits for review.
set -euo pipefail

cd "$(dirname "$0")/.."

# Files a pin move touches; anything else in the diff makes it a content change.
pin_files="tooling.yml"
base_branch="main"
assignee="timmo001"

tool_repo() {
  sed -n 's/^ *- *repo: *\(.*\)$/\1/p' tooling.yml | head -n 1
}

tool_reviewed() {
  sed -n 's/^ *reviewed: *\(.*\)$/\1/p' | head -n 1
}

status() {
  local repo reviewed latest behind
  repo=$(tool_repo)
  reviewed=$(tool_reviewed < tooling.yml)
  latest=$(gh release view --repo "$repo" --json tagName --jq .tagName)
  behind=false
  [ "$reviewed" != "$latest" ] && behind=true
  printf 'repo=%s\nreviewed=%s\nlatest=%s\nbehind=%s\n' "$repo" "$reviewed" "$latest" "$behind"
}

body_text() {
  local repo=$1 reviewed=$2 tag=$3 pin_only=$4
  if [ "$pin_only" = true ]; then
    cat <<MARKDOWN
Moves the reviewed gh release from \`$reviewed\` to \`$tag\`. The help and \`--json\` field snapshots under \`tooling/gh\` are unchanged at this release, so only the pin moves.

Release notes: https://github.com/$repo/releases/tag/$tag
Compare: https://github.com/$repo/compare/$reviewed...$tag
MARKDOWN
  else
    cat <<MARKDOWN
Moves the reviewed gh release from \`$reviewed\` to \`$tag\` and regenerates the snapshots under \`tooling/gh\`. The snapshot diff shows the flags and \`--json\` fields that changed; check the wrappers in \`src/\` for each listed command and adjust the SDK where it relies on one of them.

Release notes: https://github.com/$repo/releases/tag/$tag
Compare: https://github.com/$repo/compare/$reviewed...$tag
MARKDOWN
  fi
}

publish() {
  local tag=$1 repo reviewed branch changed pin_only title body existing number previous_title url
  repo=$(tool_repo)
  reviewed=$(git show "HEAD:tooling.yml" | tool_reviewed)
  branch="tooling/$(printf '%s' "$repo" | tr '[:upper:]/' '[:lower:]-')"

  git add -A
  changed=$(git diff --cached --name-only)

  if [ -z "$changed" ]; then
    echo "Nothing changed for $repo $tag"
    return 0
  fi

  pin_only=true
  for file in $changed; do
    case " $pin_files " in
      *" $file "*) ;;
      *) pin_only=false ;;
    esac
  done

  if [ "$pin_only" = true ]; then
    title="[Pin-only] Update $repo to $tag"
  else
    title="Update $repo to $tag"
  fi
  body=$(body_text "$repo" "$reviewed" "$tag" "$pin_only")

  if [ "${GITHUB_ACTIONS:-}" = true ]; then
    git config user.name 'github-actions[bot]'
    git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
  fi

  git switch --quiet --force-create "$branch"
  git commit --quiet -m "$title"

  existing=$(gh pr list --head "$branch" --base "$base_branch" --state open --json number,title --jq '.[0] // empty')
  number=$(printf '%s' "$existing" | jq -r '.number // empty')
  previous_title=$(printf '%s' "$existing" | jq -r '.title // empty')

  if [ -n "$number" ] && [ "$previous_title" = "$title" ] &&
    git fetch --quiet origin "$branch" && git diff --quiet "origin/$branch" HEAD --; then
    echo "Pull request #$number already carries $title"
    return 0
  fi

  git push --force --quiet origin "HEAD:refs/heads/$branch"

  if [ -n "$number" ]; then
    gh pr edit "$number" --title "$title" --body "$body" --add-assignee "$assignee"
    url=$(gh pr view "$number" --json url --jq .url)
  else
    url=$(gh pr create --base "$base_branch" --head "$branch" --title "$title" --body "$body" --assignee "$assignee")
  fi

  if [ "$pin_only" = true ]; then
    gh pr merge --auto --squash "$url" ||
      echo "::warning::Could not enable auto-merge on $url; merge it by hand"
  elif [ -n "$number" ]; then
    gh pr merge --disable-auto "$url" || true
  fi

  # Pull requests opened with GITHUB_TOKEN do not trigger pull_request workflows.
  if [ "${TOOLING_DRIFT_DISPATCH_CI:-true}" = true ]; then
    gh workflow run ci.yml --ref "$branch"
  fi

  echo "Published $title: $url"
}

case ${1:-} in
  status) status ;;
  publish) publish "${2:?usage: scripts/tooling-drift.sh publish <tag>}" ;;
  *)
    echo "usage: scripts/tooling-drift.sh status | publish <tag>" >&2
    exit 2
    ;;
esac

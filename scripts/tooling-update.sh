#!/usr/bin/env bash
# Refresh the gh contract snapshot at a cli/cli release and record that
# release as reviewed in tooling.yml. Needs gh for the release download.
#
#   scripts/tooling-update.sh <tag>
set -euo pipefail

cd "$(dirname "$0")/.."

tag=${1:?usage: scripts/tooling-update.sh <tag>}
version=${tag#v}

case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) asset="gh_${version}_linux_amd64.tar.gz" ;;
  Linux-aarch64 | Linux-arm64) asset="gh_${version}_linux_arm64.tar.gz" ;;
  Darwin-arm64) asset="gh_${version}_macOS_arm64.zip" ;;
  Darwin-x86_64) asset="gh_${version}_macOS_amd64.zip" ;;
  *)
    echo "No gh release asset for $(uname -s) $(uname -m)" >&2
    exit 1
    ;;
esac

directory=$(mktemp -d)
trap 'rm -rf "$directory"' EXIT

gh release download "$tag" --repo cli/cli --pattern "$asset" --dir "$directory"

case $asset in
  *.zip) unzip -q "$directory/$asset" -d "$directory" ;;
  *) tar -xzf "$directory/$asset" -C "$directory" ;;
esac

executable=$(find "$directory" -type f -path '*/bin/gh' | head -n 1)

if [ -z "$executable" ]; then
  echo "The $asset archive has no bin/gh" >&2
  exit 1
fi

bun scripts/gh-contract.ts --gh "$executable"

sed -i.bak "s|^\( *reviewed: *\).*\$|\1$tag|" tooling.yml
rm tooling.yml.bak

echo "Reviewed cli/cli at $tag"

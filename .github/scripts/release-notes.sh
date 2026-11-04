#!/usr/bin/env bash
# Prints a release's notes: a link to each installer in a directory, then
# GitHub's generated change log. Fails if an expected installer is missing.
# Usage: release-notes.sh <tag> <commit sha> <installers dir>
# Needs GITHUB_REPOSITORY, and GH_TOKEN for the gh call.
set -euo pipefail
shopt -s nullglob

tag=$1
sha=$2
dir=$3

installers=(
  '*aarch64*.dmg|macOS (Apple Silicon)'
  '*x64*.dmg|macOS (Intel)'
  '*-setup.exe|Windows (setup)'
  '*.msi|Windows (MSI)'
  '*.AppImage|Linux (AppImage)'
  '*.deb|Linux (Debian, Ubuntu)'
  '*.rpm|Linux (Fedora, RHEL)'
)

echo '## Downloads'
echo
for installer in "${installers[@]}"; do
  pattern=${installer%%|*}
  label=${installer#*|}
  matches=("$dir"/$pattern)
  if [ ${#matches[@]} -eq 0 ]; then
    echo "No installer matches $pattern" >&2
    exit 1
  fi
  for file in "${matches[@]}"; do
    name=${file##*/}
    echo "- $label: [$name](https://github.com/$GITHUB_REPOSITORY/releases/download/$tag/$name)"
  done
done
echo

gh api "repos/$GITHUB_REPOSITORY/releases/generate-notes" \
  -f tag_name="$tag" -f target_commitish="$sha" --jq .body

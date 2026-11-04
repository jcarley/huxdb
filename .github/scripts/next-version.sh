#!/usr/bin/env bash
# Prints the next release version: major.minor from tauri.conf.json, and the
# patch after the highest vMAJOR.MINOR.* tag (0 when there is none).
set -euo pipefail

base=$(jq -r .version src-tauri/tauri.conf.json)
major_minor=${base%.*}

last=$(git tag --list "v$major_minor.*" | sed 's/.*\.//' | { grep -E '^[0-9]+$' || true; } | sort -n | tail -n 1)

echo "$major_minor.$((${last:--1} + 1))"

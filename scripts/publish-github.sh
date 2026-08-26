#!/usr/bin/env bash
# Create joshuagwatts/ground-control and push this folder as repo root.
# Needs GH_TOKEN, GITHUB_TOKEN, or HOLOWATTS_GH_TOKEN with repo scope.
set -euo pipefail

TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-${HOLOWATTS_GH_TOKEN:-}}}"
OWNER="${GITHUB_OWNER:-joshuagwatts}"
REPO="${GITHUB_REPO:-ground-control}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if [[ -z "$TOKEN" ]]; then
  echo "Need GH_TOKEN (or GITHUB_TOKEN / HOLOWATTS_GH_TOKEN) with repo scope." >&2
  exit 1
fi

export GH_TOKEN="$TOKEN"

if gh repo view "${OWNER}/${REPO}" >/dev/null 2>&1; then
  echo "Repo ${OWNER}/${REPO} already exists."
else
  echo "Creating ${OWNER}/${REPO}…"
  gh repo create "${OWNER}/${REPO}" \
    --public \
    --description "Ground Control — roofing field app: Super Chat, certain-only shingle LENS, hail WX"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

git -C "$ROOT" rev-parse HEAD >/dev/null 2>&1 || true
rsync -a --delete \
  --exclude node_modules \
  --exclude .git \
  "$ROOT/" "$TMP/"

git -C "$TMP" init -b main
git -C "$TMP" add -A
git -C "$TMP" commit -m "Ground Control v0.1.0 — LENS, WX hail, Super Chat"

git -C "$TMP" remote add origin "https://x-access-token:${TOKEN}@github.com/${OWNER}/${REPO}.git"
git -C "$TMP" push -u origin main --force

echo "Published: https://github.com/${OWNER}/${REPO}"

#!/usr/bin/env bash
set -euo pipefail

branch="release/live-a-direita-v0.9.9-2"
installer_url="https://raw.githubusercontent.com/Moontariun/Tumacord/${branch}/scripts/install-from-github.sh"
bootstrap_file="$(mktemp "${TMPDIR:-/tmp}/tumacord-bootstrap.XXXXXX.sh")"
trap 'rm -f -- "$bootstrap_file"' EXIT

curl --fail --show-error --location "$installer_url" --output "$bootstrap_file"
bash "$bootstrap_file" "$branch"

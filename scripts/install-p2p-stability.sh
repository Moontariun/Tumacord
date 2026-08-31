#!/usr/bin/env bash
set -euo pipefail

branch="fix/p2p-stream-stability-v0.1.1"
installer_url="https://raw.githubusercontent.com/Moontariun/Tumacord/${branch}/scripts/install-from-github.sh"

if ! command -v curl >/dev/null 2>&1; then
  echo "Dependência ausente: curl" >&2
  echo "No CachyOS: sudo pacman -S --needed curl" >&2
  exit 1
fi

curl --fail --show-error --location "$installer_url" | bash -s -- "$branch"

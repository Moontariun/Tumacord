#!/usr/bin/env bash
set -euo pipefail

repository="Moontariun/Tumacord"
source_ref="${1:-${TUMACORD_REF:-main}}"

for command_name in curl tar; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Dependência ausente: $command_name" >&2
    echo "No CachyOS: sudo pacman -S --needed curl tar" >&2
    exit 1
  fi
done

download_directory="$(mktemp -d "${TMPDIR:-/tmp}/tumacord-install.XXXXXX")"
source_archive="$download_directory/source.tar.gz"
trap 'rm -rf -- "$download_directory"' EXIT

echo "Baixando o código-fonte do Tumacord (${source_ref})…"
curl --fail --show-error --location --progress-bar \
  "https://codeload.github.com/${repository}/tar.gz/${source_ref}" \
  --output "$source_archive"
tar -xzf "$source_archive" -C "$download_directory"
source_directory="$(find "$download_directory" -mindepth 1 -maxdepth 1 -type d -name 'Tumacord-*' -print -quit)"
if [[ -z "$source_directory" || ! -x "$source_directory/scripts/install-cachyos.sh" ]]; then
  echo "O pacote de código baixado não contém o instalador esperado." >&2
  exit 1
fi

echo "Compilando e instalando localmente; o AppImage não é necessário."
"$source_directory/scripts/install-cachyos.sh"

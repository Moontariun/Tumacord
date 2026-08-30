#!/usr/bin/env bash
set -euo pipefail

repository="Moontariun/Tumacord"
api_url="https://api.github.com/repos/${repository}/releases/latest"
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/tumacord"
binary_path="$HOME/.local/bin/tumacord"
desktop_path="$HOME/.local/share/applications/tumacord.desktop"
icon_path="$HOME/.local/share/icons/hicolor/scalable/apps/tumacord.svg"

for command_name in curl jq; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Dependência ausente: $command_name" >&2
    echo "No CachyOS: sudo pacman -S --needed curl jq" >&2
    exit 1
  fi
done

release_json="$(curl --fail --silent --show-error --location \
  -H 'Accept: application/vnd.github+json' \
  -H 'X-GitHub-Api-Version: 2022-11-28' \
  "$api_url")"
version="$(jq -r '.tag_name // empty' <<<"$release_json")"
download_url="$(jq -r '.assets[] | select(.name | test("^Tumacord-.*\\.AppImage$")) | .browser_download_url' <<<"$release_json" | head -n1)"

if [[ -z "$version" || -z "$download_url" ]]; then
  echo "A versão mais recente não possui um AppImage." >&2
  exit 1
fi

installed_version="$(cat "$install_root/version" 2>/dev/null || true)"
if [[ "$installed_version" == "$version" && -x "$binary_path" ]]; then
  echo "Tumacord $version já está instalado. Baixando novamente para conferir a instalação."
fi

download_directory="$(mktemp -d "${TMPDIR:-/tmp}/tumacord-install.XXXXXX")"
downloaded_appimage="$download_directory/Tumacord.AppImage"
trap 'rm -rf -- "$download_directory"' EXIT

echo "Baixando Tumacord $version…"
curl --fail --show-error --location --progress-bar "$download_url" --output "$downloaded_appimage"
chmod +x "$downloaded_appimage"
"$downloaded_appimage" --appimage-version >/dev/null

mkdir -p "$HOME/.local/bin" "$(dirname "$desktop_path")" "$(dirname "$icon_path")" "$install_root"
install -m755 "$downloaded_appimage" "$binary_path"
curl --fail --silent --show-error --location \
  "https://raw.githubusercontent.com/${repository}/main/assets/tumacord-logo.svg" \
  --output "$icon_path"
curl --fail --silent --show-error --location \
  "https://raw.githubusercontent.com/${repository}/main/packaging/tumacord.desktop" \
  --output "$desktop_path"
printf '%s\n' "$version" > "$install_root/version"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$HOME/.local/share/icons/hicolor" >/dev/null 2>&1 || true
command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 --noincremental >/dev/null 2>&1 || true

echo "Tumacord $version instalado. Feche a versão aberta pela bandeja e inicie novamente."

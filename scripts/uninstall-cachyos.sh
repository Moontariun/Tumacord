#!/usr/bin/env bash
set -euo pipefail

icon_root="$HOME/.local/share/icons/hicolor"
rm -f "$HOME/.local/bin/tumacord" "$HOME/.local/share/applications/tumacord.desktop"
rm -f "$icon_root/scalable/apps/tumacord.svg"
for icon_size in 16 24 32 48 64 96 128 256 512; do
  rm -f "$icon_root/${icon_size}x${icon_size}/apps/tumacord.png"
done

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$icon_root" >/dev/null 2>&1 || true
command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
echo "Tumacord removido. Os dados locais do aplicativo continuam na pasta de configuração do usuário."

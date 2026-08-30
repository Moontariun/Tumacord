#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v pacman >/dev/null 2>&1; then
  echo "Este instalador é destinado ao CachyOS/Arch Linux." >&2
  exit 1
fi

packages=()
command -v node >/dev/null 2>&1 || packages+=(nodejs)
command -v npm >/dev/null 2>&1 || packages+=(npm)
command -v pactl >/dev/null 2>&1 || packages+=(libpulse)
if ! command -v pw-link >/dev/null 2>&1 || ! command -v pw-dump >/dev/null 2>&1; then
  packages+=(pipewire-audio)
fi
if ((${#packages[@]})); then
  echo "Instalando dependências: ${packages[*]}"
  sudo pacman -S --needed "${packages[@]}"
fi

if ! systemctl --user is-active --quiet pipewire.service 2>/dev/null; then
  echo "Aviso: PipeWire não parece ativo. Áudio da tela pode não funcionar." >&2
fi

cd "$project_dir"
npm ci
npm run package:linux

appimage="$(find "$project_dir/release" -maxdepth 1 -name 'Tumacord-*.AppImage' -type f -print -quit)"
if [[ -z "$appimage" ]]; then
  echo "O AppImage não foi gerado." >&2
  exit 1
fi

icon_root="$HOME/.local/share/icons/hicolor"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$icon_root/scalable/apps"
install -m755 "$appimage" "$HOME/.local/bin/tumacord"
install -m644 "$project_dir/assets/tumacord-logo.svg" "$icon_root/scalable/apps/tumacord.svg"
for icon_size in 16 24 32 48 64 96 128 256 512; do
  mkdir -p "$icon_root/${icon_size}x${icon_size}/apps"
  install -m644 "$project_dir/assets/tumacord-logo.png" "$icon_root/${icon_size}x${icon_size}/apps/tumacord.png"
done
install -m644 "$project_dir/packaging/tumacord.desktop" "$HOME/.local/share/applications/tumacord.desktop"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$icon_root" >/dev/null 2>&1 || true
command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 --noincremental >/dev/null 2>&1 || true

if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo "Adicione $HOME/.local/bin ao PATH para abrir pelo terminal. O menu de aplicativos já funcionará."
fi

echo "Tumacord instalado com servidor e descoberta automática. Procure por Tumacord no menu de aplicativos."

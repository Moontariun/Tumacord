#!/usr/bin/env bash
set -euo pipefail

trap 'status=$?; echo "Falha ao compilar/instalar o Tumacord (linha ${BASH_LINENO[0]}, código ${status})." >&2; exit "$status"' ERR

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
  sudo -- pacman --sync --needed "${packages[@]}"
  hash -r
fi

missing_commands=()
for required_command in node npm pactl pw-link pw-dump; do
  command -v "$required_command" >/dev/null 2>&1 || missing_commands+=("$required_command")
done
if ((${#missing_commands[@]})); then
  echo "A instalação de dependências terminou, mas estes comandos ainda não apareceram: ${missing_commands[*]}" >&2
  echo "Feche este terminal, abra outro e execute o instalador novamente." >&2
  exit 1
fi

if ! systemctl --user is-active --quiet pipewire.service 2>/dev/null; then
  echo "Aviso: PipeWire não parece ativo. Áudio da tela pode não funcionar." >&2
fi

cd "$project_dir"
npm ci --no-audit --no-fund
npm run package:dir

compiled_app="$project_dir/release/linux-unpacked"
if [[ ! -x "$compiled_app/tumacord" ]]; then
  echo "A compilação não gerou o executável do Tumacord." >&2
  exit 1
fi

icon_root="$HOME/.local/share/icons/hicolor"
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/tumacord"
app_dir="$install_root/app"
previous_dir="$install_root/app.previous"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$icon_root/scalable/apps" "$install_root"
next_dir="$(mktemp -d "$install_root/app.next.XXXXXX")"
trap 'rm -rf -- "$next_dir"' EXIT
cp -a "$compiled_app/." "$next_dir/"
if [[ -d "$app_dir" ]]; then
  rm -rf -- "$previous_dir"
  mv -- "$app_dir" "$previous_dir"
fi
mv -- "$next_dir" "$app_dir"
trap - EXIT
ln -sfn "$app_dir/tumacord" "$HOME/.local/bin/tumacord"
install -m644 "$project_dir/assets/tumacord-logo.svg" "$icon_root/scalable/apps/tumacord.svg"
for icon_size in 16 24 32 48 64 96 128 256 512; do
  mkdir -p "$icon_root/${icon_size}x${icon_size}/apps"
  install -m644 "$project_dir/assets/tumacord-logo.png" "$icon_root/${icon_size}x${icon_size}/apps/tumacord.png"
done
install -m644 "$project_dir/packaging/tumacord.desktop" "$HOME/.local/share/applications/tumacord.desktop"
node -p "require('./package.json').version" > "$install_root/version"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$icon_root" >/dev/null 2>&1 || true
command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 --noincremental >/dev/null 2>&1 || true

if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo "Adicione $HOME/.local/bin ao PATH para abrir pelo terminal. O menu de aplicativos já funcionará."
fi

echo "Tumacord compilado do código-fonte e instalado com servidor e descoberta automática."
echo "A instalação anterior, quando existente, ficou em $previous_dir para recuperação."
echo "Procure por Tumacord no menu de aplicativos."

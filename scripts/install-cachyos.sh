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
versions_dir="$install_root/versions"
current_link="$install_root/current"
previous_link="$install_root/previous"
app_version="$(node -p "require('./package.json').version")"
build_hash="$(sha256sum "$compiled_app/tumacord" | cut -c1-12)"
version_dir="$versions_dir/${app_version}-${build_hash}"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$versions_dir"

# Nunca substitui arquivos usados pela instância aberta. Cada build vive em
# uma pasta imutável e somente o symlink `current` é trocado atomicamente.
# Assim uma atualização durante uma call não mistura código/ASAR de versões.
if [[ ! -d "$version_dir" ]]; then
  next_dir="$(mktemp -d "$versions_dir/.next.XXXXXX")"
  trap 'rm -rf -- "$next_dir"' EXIT
  cp -a "$compiled_app/." "$next_dir/"
  mv -- "$next_dir" "$version_dir"
  trap - EXIT
fi

old_target=""
if [[ -L "$current_link" ]]; then
  old_target="$(readlink -f -- "$current_link" || true)"
elif [[ -d "$install_root/app" ]]; then
  # Migração da organização usada pelas builds 0.2.0 e anteriores.
  old_target="$install_root/app"
fi
if [[ -n "$old_target" && "$old_target" != "$version_dir" ]]; then
  ln -sfn -- "$old_target" "$previous_link"
fi
next_link="$install_root/.current.next"
rm -f -- "$next_link"
ln -s -- "$version_dir" "$next_link"
mv -Tf -- "$next_link" "$current_link"
rm -f -- "$HOME/.local/bin/tumacord"
install -m755 "$project_dir/packaging/tumacord-launcher" "$HOME/.local/bin/tumacord"
rm -f -- "$icon_root/scalable/apps/tumacord.svg"
icon_hash="$(sha256sum "$project_dir/assets/tumacord-logo.png" | cut -c1-12)"
kde_icon_name="tumacord-kde-${icon_hash}"
for icon_size in 16 24 32 48 64 96 128 256 512; do
  icon_dir="$icon_root/${icon_size}x${icon_size}/apps"
  icon_source="$project_dir/assets/icons/${icon_size}x${icon_size}/apps/tumacord.png"
  mkdir -p "$icon_dir"
  install -m644 "$icon_source" "$icon_dir/tumacord.png"
  stale_kde_icons=("$icon_dir"/tumacord-kde-*.png)
  for stale_kde_icon in "${stale_kde_icons[@]}"; do
    [[ -e "$stale_kde_icon" ]] && rm -f -- "$stale_kde_icon"
  done
  install -m644 "$icon_source" "$icon_dir/${kde_icon_name}.png"
done
install -m644 "$project_dir/packaging/tumacord.desktop" "$HOME/.local/share/applications/tumacord.desktop"
sed -i "s/^Icon=.*/Icon=${kde_icon_name}/" "$HOME/.local/share/applications/tumacord.desktop"
printf '%s\n' "$app_version" > "$install_root/version"

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$icon_root" >/dev/null 2>&1 || true
command -v xdg-icon-resource >/dev/null 2>&1 && xdg-icon-resource forceupdate --theme hicolor >/dev/null 2>&1 || true
command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 --noincremental >/dev/null 2>&1 || true

if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo "Adicione $HOME/.local/bin ao PATH para abrir pelo terminal. O menu de aplicativos já funcionará."
fi

echo "Tumacord compilado do código-fonte e instalado com servidor e descoberta automática."
if [[ -n "$old_target" && "$old_target" != "$version_dir" ]]; then
  echo "A instalação anterior ficou apontada por $previous_link para recuperação."
fi
if pgrep -x tumacord >/dev/null 2>&1; then
  echo "O Tumacord está aberto: a sessão atual não foi alterada. Feche e abra o app quando quiser aplicar a versão $app_version."
fi
echo "Procure por Tumacord no menu de aplicativos."

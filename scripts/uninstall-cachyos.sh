#!/usr/bin/env bash
set -euo pipefail

purge_data="ask"
for argument in "$@"; do
  case "$argument" in
    --purge-data) purge_data="yes" ;;
    --keep-data) purge_data="no" ;;
    --help|-h)
      echo "Uso: $0 [--keep-data | --purge-data]"
      echo "  --keep-data   remove só o aplicativo e preserva contas, mensagens e preferências"
      echo "  --purge-data  remove também todos os dados locais do Tumacord"
      exit 0
      ;;
    *) echo "Opção desconhecida: $argument" >&2; exit 2 ;;
  esac
done

if [[ "$purge_data" == "ask" ]]; then
  if [[ -t 0 ]]; then
    read -r -p "Remover também contas, mensagens, anexos, perfis e preferências locais? [s/N] " answer
    [[ "$answer" =~ ^[sSyY]$ ]] && purge_data="yes" || purge_data="no"
  else
    purge_data="no"
  fi
fi

icon_root="$HOME/.local/share/icons/hicolor"
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/tumacord"
config_root="${XDG_CONFIG_HOME:-$HOME/.config}/tumacord"
cache_root="${XDG_CACHE_HOME:-$HOME/.cache}/tumacord"

rm -f -- "$HOME/.local/bin/tumacord" "$HOME/.local/share/applications/tumacord.desktop"
rm -rf -- "$install_root"
rm -f -- "$icon_root/scalable/apps/tumacord.svg"
for icon_size in 16 24 32 48 64 96 128 256 512; do
  icon_dir="$icon_root/${icon_size}x${icon_size}/apps"
  rm -f -- "$icon_dir/tumacord.png"
  kde_icons=("$icon_dir"/tumacord-kde-*.png)
  for kde_icon in "${kde_icons[@]}"; do
    [[ -e "$kde_icon" ]] && rm -f -- "$kde_icon"
  done
done

if [[ "$purge_data" == "yes" ]]; then
  rm -rf -- "$config_root" "$cache_root"
  echo "Dados locais removidos: $config_root e $cache_root"
else
  echo "Dados locais preservados em: $config_root"
fi

command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -f -t "$icon_root" >/dev/null 2>&1 || true
command -v xdg-icon-resource >/dev/null 2>&1 && xdg-icon-resource forceupdate --theme hicolor >/dev/null 2>&1 || true
command -v kbuildsycoca6 >/dev/null 2>&1 && kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
echo "Tumacord desinstalado. O clone em Downloads não é apagado automaticamente."

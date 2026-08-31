#!/usr/bin/env bash
set -euo pipefail

trap 'status=$?; echo "Falha no instalador do Tumacord (linha ${BASH_LINENO[0]}, código ${status})." >&2; exit "$status"' ERR

repository="Moontariun/Tumacord"
repository_url="https://github.com/${repository}.git"
source_ref="${1:-${TUMACORD_REF:-main}}"

if ! command -v git >/dev/null 2>&1; then
  if command -v pacman >/dev/null 2>&1 && command -v sudo >/dev/null 2>&1; then
    echo "O Git não está instalado; instalando a dependência…"
    sudo -- pacman --sync --needed git
    hash -r
  else
    echo "Dependência ausente: git" >&2
    echo "No CachyOS: sudo pacman -S --needed git" >&2
    exit 1
  fi
fi
if ! command -v git >/dev/null 2>&1; then
  echo "O Git continuou indisponível depois da instalação. Abra um terminal novo e tente novamente." >&2
  exit 1
fi

downloads_directory=""
if command -v xdg-user-dir >/dev/null 2>&1; then
  downloads_directory="$(xdg-user-dir DOWNLOAD 2>/dev/null || true)"
fi
if [[ -z "$downloads_directory" || "$downloads_directory" != /* ]]; then
  downloads_directory="${HOME}/Downloads"
fi
mkdir -p -- "$downloads_directory"

safe_ref="${source_ref//\//-}"
safe_ref="$(printf '%s' "$safe_ref" | tr -cs 'A-Za-z0-9._-' '-')"
source_directory="${downloads_directory}/Tumacord-${safe_ref}"

choose_unused_directory() {
  local base="$1"
  local candidate="${base}-novo"
  local number=2
  while [[ -e "$candidate" ]]; do
    candidate="${base}-novo-${number}"
    number=$((number + 1))
  done
  printf '%s' "$candidate"
}

clone_fresh() {
  local destination="$1"
  echo "Clonando ${source_ref} em ${destination}…"
  git clone --filter=blob:none --single-branch --branch "$source_ref" "$repository_url" "$destination"
}

if [[ -e "$source_directory" ]]; then
  existing_remote="$(git -C "$source_directory" remote get-url origin 2>/dev/null || true)"
  if [[ "$existing_remote" != "$repository_url" && "$existing_remote" != "https://github.com/${repository}" ]]; then
    preserved_directory="$source_directory"
    source_directory="$(choose_unused_directory "$source_directory")"
    echo "A pasta ${preserved_directory} já existe e não é o clone esperado; ela será preservada."
    clone_fresh "$source_directory"
  elif [[ -n "$(git -C "$source_directory" status --porcelain 2>/dev/null)" ]]; then
    preserved_directory="$source_directory"
    source_directory="$(choose_unused_directory "$source_directory")"
    echo "O clone em ${preserved_directory} possui alterações locais; ele será preservado."
    clone_fresh "$source_directory"
  else
    echo "Atualizando o clone em ${source_directory}…"
    git -C "$source_directory" fetch --prune origin "$source_ref"
    git -C "$source_directory" checkout --detach FETCH_HEAD
  fi
else
  clone_fresh "$source_directory"
fi

if [[ ! -x "$source_directory/scripts/install-cachyos.sh" ]]; then
  echo "O clone não contém o instalador esperado." >&2
  exit 1
fi

echo "Código-fonte mantido em: ${source_directory}"
if [[ "${TUMACORD_CLONE_ONLY:-0}" == "1" ]]; then
  echo "Clone validado; compilação ignorada por TUMACORD_CLONE_ONLY=1."
  exit 0
fi
echo "Compilando e instalando localmente; o AppImage não é necessário."
"$source_directory/scripts/install-cachyos.sh"

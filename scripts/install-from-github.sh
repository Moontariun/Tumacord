#!/usr/bin/env bash
set -euo pipefail

trap 'status=$?; echo "Falha no instalador do Tumacord (linha ${BASH_LINENO[0]}, código ${status})." >&2; exit "$status"' ERR

repository="Moontariun/Tumacord"
repository_url="https://github.com/${repository}.git"
source_ref="${1:-${TUMACORD_REF:-main}}"

# O bootstrap precisa do Git antes de existir qualquer código clonado, então a
# tradução do nome do pacote é repetida aqui em forma mínima.
install_git() {
  command -v sudo >/dev/null 2>&1 || return 1
  if command -v dnf5 >/dev/null 2>&1; then sudo -- dnf5 install --assumeyes git
  elif command -v dnf >/dev/null 2>&1; then sudo -- dnf install --assumeyes git
  elif command -v pacman >/dev/null 2>&1; then sudo -- pacman --sync --needed --noconfirm git
  elif command -v apt-get >/dev/null 2>&1; then sudo -- apt-get update && sudo -- apt-get install --yes git
  elif command -v zypper >/dev/null 2>&1; then sudo -- zypper --non-interactive install git
  else return 1
  fi
  hash -r
}

if ! command -v git >/dev/null 2>&1; then
  echo "O Git não está instalado; instalando a dependência…"
  if ! install_git; then
    echo "Dependência ausente: git" >&2
    echo "No Fedora: sudo dnf install git" >&2
    echo "No CachyOS/Arch: sudo pacman -S --needed git" >&2
    echo "No Debian/Ubuntu: sudo apt install git" >&2
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

# A partir da 0.7.9 o instalador se chama `install-linux.sh`; o nome antigo
# continua no repositório para quem apontar para uma branch anterior.
installer="$source_directory/scripts/install-linux.sh"
[[ -f "$installer" ]] || installer="$source_directory/scripts/install-cachyos.sh"
if [[ ! -f "$installer" ]]; then
  echo "O clone não contém o instalador esperado." >&2
  exit 1
fi
chmod +x "$source_directory"/scripts/*.sh 2>/dev/null || true

echo "Código-fonte mantido em: ${source_directory}"
if [[ "${TUMACORD_CLONE_ONLY:-0}" == "1" ]]; then
  echo "Clone validado; compilação ignorada por TUMACORD_CLONE_ONLY=1."
  exit 0
fi
echo "Compilando e instalando localmente; o AppImage não é necessário."
bash "$installer"

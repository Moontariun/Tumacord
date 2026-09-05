#!/usr/bin/env bash
set -euo pipefail

# Instalador do Tumacord para Linux.
#
# Até a 0.7.8 este script exigia `pacman` e recusava qualquer outra
# distribuição na primeira linha — o que fazia o comando de instalação do
# README falhar no Fedora antes mesmo de baixar qualquer coisa. Agora ele
# reconhece o gerenciador de pacotes, traduz os nomes das dependências e segue
# igual em todas: compila o código, guarda a build em uma pasta imutável e
# troca somente o atalho `current`.

trap 'status=$?; echo "Falha ao compilar/instalar o Tumacord (linha ${BASH_LINENO[0]}, código ${status})." >&2; exit "$status"' ERR

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

distribution_id() {
  [[ -r /etc/os-release ]] || return 0
  # shellcheck disable=SC1091
  ( . /etc/os-release; printf '%s %s' "${ID:-}" "${ID_LIKE:-}" )
}

package_manager=""
for candidate in dnf5 dnf pacman apt-get zypper; do
  if command -v "$candidate" >/dev/null 2>&1; then
    package_manager="$candidate"
    break
  fi
done

if [[ -z "$package_manager" ]]; then
  echo "Não reconheci o gerenciador de pacotes desta distribuição ($(distribution_id))." >&2
  echo "Instale manualmente: nodejs, npm, pactl, pw-link e pw-dump; depois rode este script de novo." >&2
  exit 1
fi

# Cada distribuição embala os mesmos programas com nomes diferentes. O que
# importa é o comando existir no PATH; o nome do pacote é só o caminho até ele.
package_for() {
  local requirement="$1"
  case "$package_manager" in
    dnf|dnf5)
      case "$requirement" in
        node) echo nodejs ;;
        npm) echo npm ;;
        pactl) echo pulseaudio-utils ;;
        pipewire-tools) echo pipewire-utils ;;
        git) echo git ;;
        xdg-user-dir) echo xdg-user-dirs ;;
      esac ;;
    pacman)
      case "$requirement" in
        node) echo nodejs ;;
        npm) echo npm ;;
        pactl) echo libpulse ;;
        pipewire-tools) echo pipewire-audio ;;
        git) echo git ;;
        xdg-user-dir) echo xdg-user-dirs ;;
      esac ;;
    apt-get)
      case "$requirement" in
        node) echo nodejs ;;
        npm) echo npm ;;
        pactl) echo pulseaudio-utils ;;
        pipewire-tools) echo pipewire-bin ;;
        git) echo git ;;
        xdg-user-dir) echo xdg-user-dirs ;;
      esac ;;
    zypper)
      case "$requirement" in
        node) echo nodejs ;;
        npm) echo npm ;;
        pactl) echo pulseaudio-utils ;;
        pipewire-tools) echo pipewire-tools ;;
        git) echo git ;;
        xdg-user-dir) echo xdg-user-dirs ;;
      esac ;;
  esac
}

# Bibliotecas que o Electron carrega em tempo de execução. Uma instalação
# enxuta do Fedora costuma ter tudo pelo ambiente gráfico, mas não é garantido,
# e a falta aparece como "não abre" sem nenhuma mensagem útil.
electron_runtime_packages() {
  case "$package_manager" in
    dnf|dnf5) echo "nss nspr atk at-spi2-atk at-spi2-core cups-libs libdrm libxkbcommon libXcomposite libXdamage libXrandr libXtst mesa-libgbm alsa-lib pango cairo gtk3" ;;
    pacman) echo "nss nspr at-spi2-core libcups libdrm libxkbcommon libxcomposite libxdamage libxrandr libxtst mesa alsa-lib pango cairo gtk3" ;;
    apt-get) echo "libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libxtst6 libgbm1 libasound2 libpango-1.0-0 libcairo2 libgtk-3-0" ;;
    zypper) echo "mozilla-nss mozilla-nspr libatk-1_0-0 at-spi2-core libcups2 libdrm2 libxkbcommon0 libXcomposite1 libXdamage1 libXrandr2 libXtst6 libgbm1 libasound2 libpango-1_0-0 libcairo2 gtk3" ;;
  esac
}

install_packages() {
  local packages=("$@")
  ((${#packages[@]})) || return 0
  if ! command -v sudo >/dev/null 2>&1; then
    echo "Faltam dependências (${packages[*]}) e o sudo não está disponível." >&2
    echo "Instale-as como administrador e rode este script de novo." >&2
    exit 1
  fi
  echo "Instalando dependências: ${packages[*]}"
  case "$package_manager" in
    dnf|dnf5) sudo -- "$package_manager" install --assumeyes "${packages[@]}" ;;
    pacman) sudo -- pacman --sync --needed --noconfirm "${packages[@]}" ;;
    apt-get) sudo -- apt-get update && sudo -- apt-get install --yes "${packages[@]}" ;;
    zypper) sudo -- zypper --non-interactive install "${packages[@]}" ;;
  esac
  hash -r
}

missing_packages=()
add_missing() {
  local package
  package="$(package_for "$1")"
  [[ -n "$package" ]] && missing_packages+=("$package")
}

command -v node >/dev/null 2>&1 || add_missing node
command -v npm >/dev/null 2>&1 || add_missing npm
command -v pactl >/dev/null 2>&1 || add_missing pactl
if ! command -v pw-link >/dev/null 2>&1 || ! command -v pw-dump >/dev/null 2>&1; then
  add_missing pipewire-tools
fi
if ((${#missing_packages[@]})); then
  # A mesma dependência pode aparecer duas vezes quando um pacote entrega dois
  # comandos; repetir o nome confunde alguns gerenciadores.
  mapfile -t missing_packages < <(printf '%s\n' "${missing_packages[@]}" | awk '!seen[$0]++')
  install_packages "${missing_packages[@]}"
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

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
if (( node_major < 20 )); then
  echo "O Tumacord precisa do Node.js 20 ou mais novo; encontrei a versão $(node --version 2>/dev/null || echo desconhecida)." >&2
  echo "Atualize o pacote nodejs da sua distribuição e rode o instalador de novo." >&2
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

# Uma biblioteca faltando só aparece quando o app não abre, sem mensagem. Aqui
# a falta é detectada antes da instalação e resolvida pelo gerenciador.
if command -v ldd >/dev/null 2>&1; then
  if ldd "$compiled_app/tumacord" 2>/dev/null | grep -q 'not found'; then
    read -r -a runtime_packages <<<"$(electron_runtime_packages)"
    ((${#runtime_packages[@]})) && install_packages "${runtime_packages[@]}"
    if ldd "$compiled_app/tumacord" 2>/dev/null | grep -q 'not found'; then
      echo "Aviso: ainda faltam bibliotecas para o Electron:" >&2
      ldd "$compiled_app/tumacord" 2>/dev/null | grep 'not found' >&2 || true
    fi
  fi
fi

# O Electron recusa o próprio auxiliar de sandbox quando ele tem o bit setuid
# sem pertencer ao root — situação normal em uma build feita pelo usuário. Sem
# o bit, ele usa o sandbox por namespace do kernel, que o Fedora habilita por
# padrão. Deixar como está faria o app não abrir.
sandbox_helper="$compiled_app/chrome-sandbox"
if [[ -f "$sandbox_helper" && -u "$sandbox_helper" && "$(stat -c '%u' "$sandbox_helper")" != "0" ]]; then
  chmod u-s "$sandbox_helper"
fi
if [[ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" == "0" ]]; then
  echo "Aviso: namespaces de usuário sem privilégio estão desligados neste kernel." >&2
  echo "Se o Tumacord não abrir, habilite com: sudo sysctl -w kernel.unprivileged_userns_clone=1" >&2
fi

icon_root="$HOME/.local/share/icons/hicolor"
install_root="${XDG_DATA_HOME:-$HOME/.local/share}/tumacord"
versions_dir="$install_root/versions"
current_link="$install_root/current"
previous_link="$install_root/previous"
app_version="$(node -p "require('./package.json').version")"
# O binário do Electron é idêntico em toda build: o nosso código fica em
# resources/. Um hash só do executável fazia a pasta da versão coincidir com a
# instalação anterior, e o script pulava a cópia — reinstalar a mesma versão
# compilava tudo e mantinha o código antigo rodando.
build_hash="$( { sha256sum "$compiled_app/tumacord"; find "$compiled_app/resources" -type f -print0 | sort -z | xargs -0 sha256sum; } | sha256sum | cut -c1-12 )"
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
mkdir -p "$icon_root/scalable/apps"
rm -f -- "$icon_root/scalable/apps/tumacord.svg" "$icon_root"/scalable/apps/tumacord-kde-*.svg
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

echo "Tumacord compilado do código-fonte e instalado com servidor, descoberta automática e enlace direto."
if [[ -n "$old_target" && "$old_target" != "$version_dir" ]]; then
  echo "A instalação anterior ficou apontada por $previous_link para recuperação."
fi
if pgrep -x tumacord >/dev/null 2>&1; then
  echo "O Tumacord está aberto: a sessão atual não foi alterada. Feche e abra o app quando quiser aplicar a versão $app_version."
fi
echo "Procure por Tumacord no menu de aplicativos."

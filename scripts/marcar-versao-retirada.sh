#!/usr/bin/env bash
set -euo pipefail

# Republica as notas de uma versão já lançada, a partir do CHANGELOG.
#
# Existe por causa de uma assimetria: o CI escreve as notas da Release quando a
# tag é criada, e nunca mais. Quando um defeito só aparece depois — que é
# quando defeito costuma aparecer —, marcar a versão como retirada aqui no
# CHANGELOG não chega a lugar nenhum sozinho.
#
# E chegar importa. A partir da 0.9.0 o aplicativo lê as notas da Release para
# decidir o que oferecer: uma versão cujo texto traga o marcador
# `<!-- tumacord:versao-quebrada -->` deixa de ser oferecida por TODA cópia
# instalada, inclusive as que já estavam na rua quando o defeito apareceu. Este
# script é o que leva o marcador do CHANGELOG até lá.
#
# Uso:
#   ./scripts/marcar-versao-retirada.sh 0.8.9
#
# Ele não inventa texto: o que sobe é exatamente a seção do CHANGELOG, com o
# mesmo recorte que o `.github/workflows/release.yml` usa ao publicar.

trap 'status=$?; echo "Falha ao republicar as notas (linha ${BASH_LINENO[0]}, código ${status})." >&2; exit "$status"' ERR

versao="${1:-}"
if [[ -z "$versao" ]]; then
  echo "Uso: $0 <versão>   (exemplo: $0 0.8.9)" >&2
  exit 1
fi
versao="${versao#v}"
tag="v${versao}"

projeto="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$projeto"

command -v gh >/dev/null 2>&1 || { echo "O GitHub CLI (gh) é necessário: https://cli.github.com" >&2; exit 1; }

notas="$(mktemp)"
trap 'rm -f -- "$notas"' EXIT
awk -v version="$versao" '
  index($0, "## " version " ") == 1 { capture = 1; next }
  index($0, "## " version) == 1 && length($0) == length("## " version) { capture = 1; next }
  capture && /^## / { exit }
  capture { print }
' CHANGELOG.md > "$notas"

if [[ ! -s "$notas" ]]; then
  echo "O CHANGELOG não tem seção para a $versao; nada foi enviado." >&2
  exit 1
fi

titulo="$(awk -v version="$versao" 'index($0, "## " version) == 1 { sub(/^## /, ""); print; exit }' CHANGELOG.md)"

echo "── Notas que serão publicadas em $tag"
sed 's/^/   /' "$notas"
echo

if grep -q 'tumacord:versao-quebrada' "$notas"; then
  echo "   Esta seção traz o marcador de versão retirada: depois disto, nenhum"
  echo "   Tumacord instalado voltará a oferecer a $versao."
else
  echo "   Sem marcador de versão retirada; a $versao continuará sendo oferecida."
fi
echo

read -r -p "Republicar as notas de $tag no GitHub? [s/N] " resposta
[[ "$resposta" =~ ^[SsYy]$ ]] || { echo "Nada foi enviado."; exit 0; }

gh release view "$tag" >/dev/null 2>&1 || { echo "A Release $tag não existe no GitHub." >&2; exit 1; }
gh release edit "$tag" --title "Tumacord ${titulo:-$versao}" --notes-file "$notas"

echo "Notas de $tag republicadas."
echo "Confira em: $(gh release view "$tag" --json url --jq .url)"

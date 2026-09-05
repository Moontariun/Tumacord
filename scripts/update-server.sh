#!/usr/bin/env bash
set -euo pipefail

# Atualiza um servidor Tumacord já em produção, sem perder dados.
#
# A ordem importa e é sempre a mesma: backup primeiro, atualizar depois,
# conferir por último. Se a conferência falhar, o backup e o caminho de volta
# já existem — procurá-los depois do problema é tarde.
#
# O que este script NUNCA faz:
#   - `docker compose down -v`, que apaga o volume com contas e mensagens;
#   - descartar alteração local sua no `docker-compose.yml` ou no `.env`.
#
# Uso, dentro da pasta do servidor:
#   ./scripts/update-server.sh                    (vai para a versão publicada)
#   ./scripts/update-server.sh nome-da-branch     (vai para outra referência)
#   TUMACORD_SKIP_BACKUP=1 ./scripts/update-server.sh   (pula o backup)

trap 'status=$?; echo; echo "Falha na atualização (linha ${BASH_LINENO[0]}, código ${status}). Nada foi apagado; veja o backup acima." >&2; exit "$status"' ERR

alvo="${1:-release/turn-opt-in-v0.8.2}"
projeto="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$projeto"

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@";
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@";
  else echo "Docker Compose não encontrado." >&2; return 1; fi
}

echo "── Tumacord · atualização do servidor"
echo "   pasta: $projeto"
echo "   alvo:  $alvo"
echo

# 1. Alterações locais são suas e não podem ser descartadas em silêncio. Quem
#    trocou a imagem do relay ou ajustou uma porta precisa saber antes.
if [[ -n "$(git status --porcelain -- ':!*.env' 2>/dev/null)" ]]; then
  echo "Há alterações locais versionadas nesta pasta:" >&2
  git status --short -- ':!*.env' >&2
  echo >&2
  echo "Guarde-as antes de continuar:" >&2
  echo "  git stash push -m 'antes da atualizacao'" >&2
  echo "…e recupere depois com: git stash pop" >&2
  exit 1
fi

# 2. Quais serviços estão de pé agora. O relay só volta a subir se já estava
#    subindo — atualizar não é hora de ligar coisa nova sozinho.
perfis=()
if docker ps --format '{{.Names}}' | grep -q '^tumacord-turn$'; then
  perfis=(--profile turn)
  echo "   relay TURN está no ar; ele será mantido"
fi

# 3. Backup do volume. É a rede de segurança de tudo que vem depois.
volume="$(compose "${perfis[@]}" config --volumes 2>/dev/null | head -1 || true)"
volume_real="$(docker volume ls --format '{{.Name}}' | grep -E "tumacord.*data$" | head -1 || true)"
if [[ "${TUMACORD_SKIP_BACKUP:-0}" != "1" && -n "$volume_real" ]]; then
  arquivo="tumacord-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
  echo "── Backup de $volume_real → $arquivo"
  docker run --rm -v "$volume_real":/data -v "$projeto":/backup alpine \
    tar czf "/backup/$arquivo" -C /data .
  echo "   guardado: $projeto/$arquivo"
  echo "   (para restaurar, veja o fim deste script)"
else
  echo "── Backup ignorado${volume_real:+ por TUMACORD_SKIP_BACKUP=1}"
fi
echo

# 4. Buscar e ir para a referência pedida.
echo "── Baixando $alvo"
git fetch --prune origin "$alvo"
git checkout --detach FETCH_HEAD
versao="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"
echo "   versão no código: $versao"
echo

# 5. Subir. `up -d --build` recria só o que mudou e preserva os volumes.
echo "── Reconstruindo e subindo"
compose "${perfis[@]}" up -d --build
echo

# 6. Conferir. Um serviço que sobe e não responde é pior do que um que não sobe.
porta="$(grep -oP '^\s*-\s*"\K\d+(?=:\d+")' docker-compose.yml | head -1 || echo 4600)"
echo "── Conferindo em http://127.0.0.1:${porta}"
for tentativa in $(seq 1 30); do
  if saude="$(curl -fsS --max-time 3 "http://127.0.0.1:${porta}/api/health" 2>/dev/null)"; then
    echo "$saude" | node -e '
      let bruto = "";
      process.stdin.on("data", (pedaco) => { bruto += pedaco; });
      process.stdin.on("end", () => {
        const corpo = JSON.parse(bruto);
        const capacidades = corpo.capabilities ?? {};
        console.log("   versão no ar:", corpo.version);
        console.log("   modo:", corpo.mode, "· web:", corpo.web ? "sim" : "não");
        console.log("   HTTPS:", corpo.security?.tls ? "ativo" : "desligado", "· chave de acesso:", corpo.security?.accessKeyRequired ? "exigida" : "não exigida");
        console.log("   relay TURN:", corpo.turn ? "disponível" : "indisponível");
        const faltando = ["roles", "adminChannels", "adminUsers", "adminAudit"].filter((c) => capacidades[c] !== true);
        console.log(faltando.length ? "   ATENÇÃO: painel administrativo indisponível (" + faltando.join(", ") + ")" : "   painel administrativo: pronto");
      });
    '
    echo
    echo "── Atualização concluída."
    echo "   Contas, mensagens, anexos e canais foram preservados."
    exit 0
  fi
  sleep 2
done

echo "O servidor subiu mas não respondeu em 60 s." >&2
echo >&2
echo "Ver o que aconteceu:" >&2
echo "  docker compose logs --tail 80 tumacord-server" >&2
echo >&2
echo "Voltar para a versão anterior:" >&2
echo "  git checkout release/rendezvous-and-turn-v0.8.0 && docker compose up -d --build" >&2
echo >&2
echo "Restaurar o backup (só se necessário; substitui os dados atuais):" >&2
echo "  docker compose down" >&2
echo "  docker run --rm -v ${volume_real:-tumacord-data}:/data -v \"$projeto\":/backup alpine \\" >&2
echo "    sh -c 'rm -rf /data/* && tar xzf /backup/ARQUIVO.tar.gz -C /data'" >&2
echo "  docker compose up -d" >&2
exit 1

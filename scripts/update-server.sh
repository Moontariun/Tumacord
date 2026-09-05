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

alvo="${1:-release/compose-v2-guard-v0.8.5}"

# A pasta do servidor. Quando o script é executado do próprio repositório, ela
# sai do caminho do arquivo; quando ele chega por `curl … | bash` — que é como
# alguém o usa da primeira vez, antes de tê-lo — o arquivo não existe em disco,
# e a referência é o diretório atual.
if [[ -n "${TUMACORD_DIR:-}" ]]; then
  projeto="$TUMACORD_DIR"
elif [[ -f "${BASH_SOURCE[0]:-}" ]]; then
  projeto="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
else
  projeto="$(git rev-parse --show-toplevel 2>/dev/null || true)"
fi
if [[ -z "$projeto" || ! -f "$projeto/docker-compose.yml" ]]; then
  echo "Não encontrei a pasta do servidor Tumacord." >&2
  echo "Entre nela e rode de novo, ou aponte com: TUMACORD_DIR=/caminho/para/Tumacord" >&2
  exit 1
fi
cd "$projeto"

# O `.env` guarda a chave de acesso do servidor e não é versionado — de
# propósito. Isso significa que um clone novo nasce sem ele, e o Compose para
# antes de qualquer coisa reclamando de uma variável obrigatória.
#
# Mas o contêiner que está no ar carrega esses valores desde que foi criado.
# Reconstruir o arquivo a partir dele recupera a configuração exata, sem
# ninguém precisar lembrar de uma chave que o grupo inteiro já usa.
recuperar_env_do_conteiner() {
  local conteiner="tumacord-server"
  docker inspect "$conteiner" >/dev/null 2>&1 || return 1
  local env_atual
  env_atual="$(docker inspect "$conteiner" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null)" || return 1
  grep -q '^SERVER_ACCESS_KEY=.' <<<"$env_atual" || return 1

  {
    echo "# Recuperado automaticamente do contêiner em execução em $(date -Is)."
    echo "# Os valores são os que o servidor já usava; nada foi inventado."
    grep '^SERVER_ACCESS_KEY=' <<<"$env_atual" | sed 's/^SERVER_ACCESS_KEY=/TUMACORD_SERVER_ACCESS_KEY=/'
    grep '^ADMIN_USERNAME=' <<<"$env_atual" | sed 's/^ADMIN_USERNAME=/TUMACORD_ADMIN_USERNAME=/' || true
    grep '^TLS_CERT_FILE=' <<<"$env_atual" | sed 's/^TLS_CERT_FILE=/TUMACORD_TLS_CERT_FILE=/' || true
    grep '^TLS_KEY_FILE=' <<<"$env_atual" | sed 's/^TLS_KEY_FILE=/TUMACORD_TLS_KEY_FILE=/' || true
    grep '^TURN_URLS=' <<<"$env_atual" | sed 's/^TURN_URLS=/TUMACORD_TURN_URLS=/' || true
    grep '^TURN_SECRET=' <<<"$env_atual" | sed 's/^TURN_SECRET=/TUMACORD_TURN_SECRET=/' || true
    grep '^TURN_TTL_SECONDS=' <<<"$env_atual" | sed 's/^TURN_TTL_SECONDS=/TUMACORD_TURN_TTL_SECONDS=/' || true
  } > .env
  chmod 600 .env
  return 0
}

# O `docker-compose` v1, em Python, está fora de suporte e quebra com Docker
# Engine moderno: ele lê um campo `ContainerConfig` que as imagens novas não
# trazem mais, e morre com um traceback no meio da recriação — depois de já ter
# parado o contêiner antigo. Cair nele em silêncio seria entregar um servidor
# fora do ar com uma pilha de Python na tela.
verificar_compose() {
  if docker compose version >/dev/null 2>&1; then
    modo_compose="v2"
    return 0
  fi
  if command -v docker-compose >/dev/null 2>&1; then
    echo "Encontrei apenas o docker-compose v1 ($(docker-compose version --short 2>/dev/null || echo 'versão desconhecida'))." >&2
    echo "Ele não funciona com o Docker Engine atual: falha com KeyError: 'ContainerConfig'" >&2
    echo "no meio da recriação, deixando o serviço fora do ar." >&2
    echo >&2
    echo "Instale o plugin v2 e rode de novo:" >&2
    echo "  sudo apt-get update && sudo apt-get install -y docker-compose-plugin" >&2
    echo "  # ou, em Fedora/CachyOS: sudo dnf install docker-compose-plugin / sudo pacman -S docker-compose" >&2
    echo >&2
    echo "Confira com: docker compose version" >&2
    return 1
  fi
  echo "Docker Compose não encontrado." >&2
  return 1
}

compose() {
  docker compose "$@"
}

verificar_compose || exit 1

echo "── Tumacord · atualização do servidor"
echo "   pasta: $projeto"
echo "   alvo:  $alvo"
echo

# 0. Sem `.env`, o Compose para antes de tudo. Um clone novo sempre nasce
#    assim, porque o arquivo carrega segredo e não é versionado.
if [[ ! -f .env ]]; then
  echo "── Sem arquivo .env nesta pasta"
  if recuperar_env_do_conteiner; then
    echo "   recuperado do contêiner que já está no ar, com os valores que ele usava"
    echo "   arquivo: $projeto/.env (somente leitura do dono)"
  else
    echo >&2
    echo "Não há .env aqui e não consegui recuperá-lo de um contêiner em execução." >&2
    echo >&2
    echo "Se o servidor antigo ainda está no ar, veja a chave que ele usa:" >&2
    echo "  docker inspect tumacord-server --format '{{range .Config.Env}}{{println .}}{{end}}' | grep SERVER_ACCESS_KEY" >&2
    echo >&2
    echo "Se não, crie o arquivo a partir do exemplo — mas atenção: trocar a chave" >&2
    echo "obriga todo mundo do grupo a informar a nova ao entrar." >&2
    echo "  cp .env.example .env   # e edite a chave" >&2
    exit 1
  fi
  echo
fi

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

# 2b. Contêiner com o mesmo nome, criado por outra configuração, impede a
#     recriação — e o Compose só descobre isso no meio do caminho. Melhor
#     apontar antes, com o comando exato, do que deixar a mensagem crua.
projeto_compose="$(basename "$projeto" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9')"
for nome in tumacord-server tumacord-turn; do
  docker inspect "$nome" >/dev/null 2>&1 || continue
  dono="$(docker inspect "$nome" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null || true)"
  [[ -z "$dono" || "$dono" == "$projeto_compose" ]] && continue
  echo "O contêiner \"$nome\" pertence a outra configuração (projeto \"$dono\")." >&2
  echo "Ele impede a recriação a partir desta pasta." >&2
  echo >&2
  echo "Antes de removê-lo, guarde como ele estava configurado:" >&2
  echo "  docker inspect $nome --format '{{json .Config.Cmd}}'" >&2
  echo "  docker inspect $nome --format '{{range .Config.Env}}{{println .}}{{end}}'" >&2
  echo >&2
  echo "Depois remova e rode este script de novo:" >&2
  echo "  docker rm -f $nome" >&2
  exit 1
done

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

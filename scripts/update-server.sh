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
#   ./scripts/update-server.sh ultima             (vai para a Release mais nova do GitHub)
#   ./scripts/update-server.sh nome-da-branch     (vai para outra referência)
#   TUMACORD_SKIP_BACKUP=1 ./scripts/update-server.sh   (pula o backup)
#   TUMACORD_FORCAR=1 ./scripts/update-server.sh        (aceita versão retirada)
#
# `ultima` é o caminho de quem só quer o servidor na versão que o aplicativo
# está oferecendo para todo mundo: ele pergunta ao GitHub qual é a Release mais
# nova, pula as que estão marcadas como retiradas e vai para a tag dela. É o
# mesmo lugar de onde o aplicativo tira a atualização — o repositório do GitHub
# é a fonte, aqui e lá.
#
# E o Docker só é reconstruído quando há motivo: se o código já está na
# referência pedida e o contêiner no ar já responde com essa versão, o script
# diz isso e sai sem derrubar nada. Reiniciar um servidor que já está certo é
# derrubar a call de alguém à toa.

trap 'status=$?; echo; echo "Falha na atualização (linha ${BASH_LINENO[0]}, código ${status}). Nada foi apagado; veja o backup acima." >&2; exit "$status"' ERR

alvo="${1:-release/mesa-de-desenho-v0.9.1}"
repositorio="${TUMACORD_REPO:-Moontariun/Tumacord}"
projeto="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$projeto"

compose() {
  if docker compose version >/dev/null 2>&1; then docker compose "$@";
  elif command -v docker-compose >/dev/null 2>&1; then docker-compose "$@";
  else echo "Docker Compose não encontrado." >&2; return 1; fi
}

# A lista de Releases, uma vez só. Ela responde duas perguntas: qual é a versão
# mais nova e se a versão escolhida foi retirada.
releases_json=""
baixar_releases() {
  [[ -n "$releases_json" ]] && return 0
  command -v node >/dev/null 2>&1 || { echo "Este caminho precisa do Node para ler a resposta do GitHub. Passe a referência como argumento." >&2; return 1; }
  releases_json="$(curl -fsSL --max-time 20 \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "https://api.github.com/repos/${repositorio}/releases?per_page=20")"
}

# A marca de versão retirada é um comentário de HTML no corpo da Release, o
# mesmo que faz o aplicativo parar de oferecê-la. Publicar as notas com essa
# marca retira a versão dos dois lugares de uma vez.
consultar_releases() {
  baixar_releases || return 1
  printf '%s' "$releases_json" | TUMACORD_TAG="${2:-}" node -e '
    let bruto = "";
    process.stdin.on("data", (pedaco) => { bruto += pedaco; });
    process.stdin.on("end", () => {
      const pergunta = process.argv[1];
      const marca = /<!--\s*tumacord:versao-quebrada\s*-->/i;
      const quebradas = new Set(["0.8.9"]);
      const numero = (tag) => {
        const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(tag ?? "").trim());
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
      };
      let lista = [];
      try { lista = JSON.parse(bruto); } catch { lista = []; }
      if (!Array.isArray(lista)) lista = [];
      const retirada = (r) => marca.test(String(r.body ?? "")) || quebradas.has(String(r.tag_name ?? "").replace(/^v/, ""));
      if (pergunta === "ultima") {
        const boas = lista
          .filter((r) => r && !r.draft && !r.prerelease && numero(r.tag_name) && !retirada(r))
          .sort((a, b) => { const x = numero(a.tag_name), y = numero(b.tag_name); return y[0]-x[0] || y[1]-x[1] || y[2]-x[2]; });
        process.stdout.write(boas.length ? String(boas[0].tag_name) : "");
        return;
      }
      const alvo = String(process.env.TUMACORD_TAG ?? "").replace(/^v/, "");
      const achada = lista.find((r) => r && String(r.tag_name ?? "").replace(/^v/, "") === alvo);
      process.stdout.write(achada && retirada(achada) ? "retirada" : "");
    });
  ' "$1"
}

# `ultima` vira a tag da Release mais nova que não foi retirada. Sem resposta do
# GitHub o script para aqui: instalar "alguma coisa" seria pior do que não
# instalar nada.
if [[ "$alvo" == "ultima" || "$alvo" == "--ultima" ]]; then
  echo "── Perguntando ao GitHub qual é a versão publicada mais nova"
  alvo="$(consultar_releases ultima || true)"
  if [[ -z "$alvo" ]]; then
    echo "Não consegui descobrir a versão mais nova no GitHub." >&2
    echo "Rode de novo com a referência: ./scripts/update-server.sh release/mesa-de-desenho-v0.9.1" >&2
    exit 1
  fi
  echo "   versão publicada: $alvo"
fi

echo "── Tumacord · atualização do servidor"
echo "   pasta: $projeto"
echo "   alvo:  $alvo"
echo

# Uma versão retirada não vai para o servidor nem por engano. A checagem só
# acontece quando o alvo é uma tag: uma branch de desenvolvimento não tem
# Release, e exigir uma impediria de testar qualquer coisa.
if [[ "$alvo" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ && "${TUMACORD_FORCAR:-0}" != "1" ]]; then
  if [[ "$(consultar_releases estado "$alvo" 2>/dev/null || true)" == "retirada" ]]; then
    echo "A $alvo está marcada como retirada nas Releases e não deve ir para o servidor." >&2
    echo "Se você sabe o que está fazendo: TUMACORD_FORCAR=1 ./scripts/update-server.sh $alvo" >&2
    exit 1
  fi
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
antes="$(git rev-parse HEAD 2>/dev/null || echo '')"
git fetch --prune origin "$alvo"
git checkout --detach FETCH_HEAD
depois="$(git rev-parse HEAD 2>/dev/null || echo '')"
versao="$(node -p "require('./package.json').version" 2>/dev/null || echo '?')"
echo "   versão no código: $versao"
echo

# 5. Subir — se houver motivo.
#
# Reiniciar o contêiner derruba quem está conectado. Quando o código não mudou
# e o servidor no ar já responde com esta mesma versão, não há o que aplicar: o
# script diz isso e sai. É o "reiniciar só se necessário" de quem roda este
# script sempre que quer conferir se está em dia.
porta="$(grep -oP '^\s*-\s*"\K\d+(?=:\d+")' docker-compose.yml | head -1 || echo 4600)"
no_ar=""
if saude="$(curl -fsS --max-time 3 "http://127.0.0.1:${porta}/api/health" 2>/dev/null)"; then
  no_ar="$(printf '%s' "$saude" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).version' 2>/dev/null || echo '')"
fi
if [[ -n "$antes" && "$antes" == "$depois" && -n "$no_ar" && "$no_ar" == "$versao" ]]; then
  echo "── Nada a fazer: o código já está em $alvo e o servidor no ar responde $no_ar."
  echo "   O Docker não foi reiniciado, e ninguém foi derrubado."
  exit 0
fi

echo "── Reconstruindo e subindo"
[[ -n "$no_ar" ]] && echo "   no ar agora: $no_ar → $versao"
compose "${perfis[@]}" up -d --build
echo

# 6. Conferir. Um serviço que sobe e não responde é pior do que um que não sobe.
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
echo "  git checkout release/atualizacao-no-app-v0.9.0 && docker compose up -d --build" >&2
echo >&2
echo "Restaurar o backup (só se necessário; substitui os dados atuais):" >&2
echo "  docker compose down" >&2
echo "  docker run --rm -v ${volume_real:-tumacord-data}:/data -v \"$projeto\":/backup alpine \\" >&2
echo "    sh -c 'rm -rf /data/* && tar xzf /backup/ARQUIVO.tar.gz -C /data'" >&2
echo "  docker compose up -d" >&2
exit 1

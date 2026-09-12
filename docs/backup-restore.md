# Backup e restauração

Este guia cobre a cópia dos dados do servidor dedicado e a volta deles.

> **O que mudou na 0.9.9-1.** O guia anterior procurava o volume de dados com
> uma expressão regular sobre `docker volume ls`, pegava **o primeiro que
> combinasse**, presumia o nome `tumacord-data` e — quando não achava nenhum —
> **seguia sem backup**. E a restauração fazia `rm -rf` num caminho que nunca
> foi conferido. Os três estão corrigidos aqui, e o motivo de cada correção
> está escrito junto.

---

## Por que um `tar` do volume vivo não basta

O servidor grava `tumacord.json` de forma coordenada **dentro do processo**:
as gravações são encadeadas para que duas não intercalem. Isso protege contra
o próprio servidor se atropelar — não protege contra alguém copiar o arquivo no
meio de uma gravação.

Um `tar` do volume enquanto o servidor escreve pode capturar:

- o `tumacord.json` entre o `write` e o `rename`, ou seja, a versão antiga;
- o JSON de um instante e os anexos de outro;
- um arquivo parcial, que não abre.

Nenhuma dessas três falha de forma visível. Elas falham na restauração, meses
depois, quando já não há de onde tirar outra cópia.

**Por isso o backup pede ao servidor que pause a escrita**, copia estado e
anexos no mesmo ponto, e libera. **Sem conseguir a pausa, o procedimento
para.** Não continuar em silêncio é o ponto inteiro.

---

## Pré-requisitos

**Plataforma:** Linux, Docker Engine 24+, Compose v2.20+.
*Usuário:* no grupo `docker`, ou `root`.
*Diretório:* o do projeto (onde está o `docker-compose.yml`).

Os parâmetros, os mesmos de [Instalação na VPS](instalacao-vps.md):

```bash
export TUMACORD_DIR="/opt/tumacord"
export TUMACORD_PROJETO="tumacord"
# Onde as cópias ficam. FORA da VPS também — veja "Cópia fora da máquina".
export TUMACORD_BACKUPS="/var/backups/tumacord"
```

---

## 1. Descobrir onde os dados estão — de verdade

Nunca por nome de volume. O volume é descoberto pelo **mount real** do
contêiner em `/data`:

```bash
cd "$TUMACORD_DIR"
node tools/tumacordctl/tumacordctl.mjs instalacao --projeto "$TUMACORD_PROJETO"
```

**Saída esperada:** entre outras linhas,

```
    mount:     volume <nome-real-do-volume> → /data
...
Dados do chat: volume <nome-real-do-volume>
```

**Se a última linha disser `NÃO ENCONTRADOS`**, pare. Não há backup a fazer
porque não se sabe o que copiar, e é exatamente aqui que o guia antigo seguia
adiante.

**Se houver mais de uma instalação**, o comando recusa e pede `--projeto`.
Escolher sozinho seria escolher de qual instalação você perde os dados.

Guarde o nome para os comandos seguintes:

```bash
export TUMACORD_VOLUME="$(node tools/tumacordctl/tumacordctl.mjs instalacao --projeto "$TUMACORD_PROJETO" --json \
  | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{const i=JSON.parse(t);const m=(i.servicos["tumacord-server"]?.mounts??[]).filter(x=>x.destino==="/data");if(m.length!==1){console.error("descoberta ambígua ou vazia: "+m.length+" mounts em /data");process.exit(1)}process.stdout.write(m[0].nome||m[0].origem)})')"
echo "volume de dados: $TUMACORD_VOLUME"
```

**Se este comando falhar** com `descoberta ambígua ou vazia`, pare: há zero ou
mais de um mount em `/data`, e copiar qualquer um seria adivinhar.

---

## 2. A cópia consistente

*Efeito sobre chamadas:* a pausa de escrita dura segundos. Quem está em call
**não é desconectado** — a voz e o vídeo não passam pelo armazenamento. O que
fica em espera, nesses segundos, é o envio de mensagem e de anexo.

```bash
mkdir -p "$TUMACORD_BACKUPS"
export TUMACORD_CARIMBO="$(date -u +%Y%m%dT%H%M%SZ)"
export TUMACORD_COPIA="$TUMACORD_BACKUPS/tumacord-$TUMACORD_PROJETO-$TUMACORD_CARIMBO.tar.gz"
```

**a) Obter um token de dono.** Pausar a escrita é uma operação de dono, e não
de quem tem shell na máquina — a auditoria registra quem pediu.

```bash
# Preencha com as credenciais da conta dona. Elas ficam só nesta sessão.
read -r -s -p "senha do dono: " TUMACORD_SENHA_DONO; echo
export TUMACORD_DONO="Moontariun"   # o nome da conta dona deste servidor

export TUMACORD_TOKEN="$(curl -fsS -X POST http://127.0.0.1:4600/api/auth/login \
  -H 'content-type: application/json' \
  -d "{\"username\":\"$TUMACORD_DONO\",\"password\":\"$TUMACORD_SENHA_DONO\",\"serverKey\":\"$(grep -E '^TUMACORD_SERVER_ACCESS_KEY=' .env | cut -d= -f2-)\"}" \
  | node -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>process.stdout.write(JSON.parse(t).token??""))')"
unset TUMACORD_SENHA_DONO
test -n "$TUMACORD_TOKEN" || { echo "não consegui entrar como dono" >&2; exit 1; }
```

**b) Pausar a escrita e descarregar o que está em memória.**

```bash
curl -fsS -X POST http://127.0.0.1:4600/api/admin/pause-writes \
  -H "authorization: Bearer $TUMACORD_TOKEN" -H 'content-type: application/json' -d '{}' \
  || { echo "NÃO consegui pausar a escrita. Backup CANCELADO — um tar do volume vivo não prova consistência." >&2; exit 1; }
```

**Saída esperada:** `{"ok":true,"paused":true,"autoResumeMs":300000}`.

O `autoResumeMs` é uma rede de segurança: se este procedimento morrer no meio,
o servidor volta a gravar sozinho depois desse tempo, em vez de ficar sem
gravar para sempre. Se a sua cópia demora mais que isso, peça um tempo maior
com `-d '{"timeoutMs": 900000}'`.

> **Se o seu servidor ainda não tem esse endpoint** — instalações anteriores à
> 0.9.9-1 não têm —, use a alternativa comprovadamente consistente: **parar o
> contêiner**. Ela custa a indisponibilidade do chat pelo tempo da cópia, e é
> honesta sobre isso:
>
> ```bash
> docker compose -p "$TUMACORD_PROJETO" stop tumacord-server
> ```

**c) Copiar estado e anexos no mesmo ponto.**

```bash
docker run --rm \
  -v "$TUMACORD_VOLUME":/dados:ro \
  -v "$TUMACORD_BACKUPS":/saida \
  alpine:3.20 \
  tar -czf "/saida/$(basename "$TUMACORD_COPIA")" -C /dados .
```

**d) Liberar a escrita** (ou subir o contêiner, se você usou a alternativa):

```bash
curl -fsS -X POST http://127.0.0.1:4600/api/admin/resume-writes \
  -H "authorization: Bearer $TUMACORD_TOKEN"
# ou, se parou o contêiner:
# docker compose -p "$TUMACORD_PROJETO" start tumacord-server
```

**Saída esperada:** `{"ok":true,"paused":false}`.

> Rode este passo **mesmo se a cópia falhar**. Ele é o que devolve a escrita —
> e é por isso que ele não depende de a cópia ter dado certo.

**Verificação — a cópia abre e tem o que deveria:**

```bash
tar -tzf "$TUMACORD_COPIA" | head
tar -tzf "$TUMACORD_COPIA" | grep -q '^\./tumacord\.json$' && echo "estado presente"
tar -tzf "$TUMACORD_COPIA" | grep -c '^\./attachments/' | xargs echo "anexos:"
sha256sum "$TUMACORD_COPIA" | tee "$TUMACORD_COPIA.sha256"
```

**Se `tumacord.json` não estiver na cópia**, ela não serve. Refaça.

---

## 3. Cópia fora da máquina

Uma cópia que mora na VPS não protege contra a perda da VPS — que é o caso em
que se precisa dela.

```bash
scp "$TUMACORD_COPIA" "$TUMACORD_COPIA.sha256" outro-host:/caminho/seguro/
```

**Junto com os dados, guarde fora também:**

- as chaves privadas de assinatura (manifesto e catálogo) — sem elas não se
  publica mais nada, nem uma correção;
- o `.env` (modo 600, e **não** num repositório);
- os certificados TLS, ou a certeza de que dá para reemiti-los.

> Segredo não entra em documentação nem em log. Esta linha existe para lembrar
> que ele **precisa** existir em algum lugar seguro fora da máquina.

---

## 4. Restaurar — em destino separado primeiro

**A ordem importa e não é negociável:** restaura-se num destino separado,
valida-se lá, e só então se decide substituir.

**a) Conferir a origem antes de tocar em qualquer coisa:**

```bash
export TUMACORD_COPIA="/var/backups/tumacord/tumacord-tumacord-20260912T120000Z.tar.gz"
sha256sum -c "$TUMACORD_COPIA.sha256" || { echo "a cópia não confere com o resumo — NÃO restaure" >&2; exit 1; }
tar -tzf "$TUMACORD_COPIA" >/dev/null || { echo "a cópia não abre" >&2; exit 1; }
```

**b) Restaurar num volume novo, que não é o que está em uso:**

```bash
export TUMACORD_VOLUME_TESTE="tumacord-restauracao-$(date -u +%s)"
docker volume create "$TUMACORD_VOLUME_TESTE"
docker run --rm \
  -v "$TUMACORD_VOLUME_TESTE":/dados \
  -v "$(dirname "$TUMACORD_COPIA")":/entrada:ro \
  alpine:3.20 \
  tar -xzf "/entrada/$(basename "$TUMACORD_COPIA")" -C /dados
```

**c) Subir um servidor de teste contra esse volume, noutra porta:**

```bash
docker run --rm -d --name tumacord-restauracao \
  -v "$TUMACORD_VOLUME_TESTE":/data \
  -e DATA_DIR=/data -e PORT=4699 -e HOST=0.0.0.0 \
  -e SERVER_ACCESS_KEY=teste-de-restauracao \
  -p 127.0.0.1:4699:4699 \
  "$(docker compose -p "$TUMACORD_PROJETO" images -q tumacord-server)"
sleep 5
curl -fsS http://127.0.0.1:4699/api/health
```

**Verificação — o que precisa bater:**

```bash
# A identidade da instalação é a mesma. Se ela mudou, você restaurou outra coisa.
curl -fsS http://127.0.0.1:4699/api/health | grep -o '"installationId":"[^"]*"'
# E compare com a instalação em uso:
curl -fsS http://127.0.0.1:4600/api/health | grep -o '"installationId":"[^"]*"'
```

Confira também, pela interface em `http://127.0.0.1:4699`: as contas existem, o
histórico está lá, os anexos abrem.

**d) Limpar o ensaio:**

```bash
docker rm -f tumacord-restauracao
docker volume rm "$TUMACORD_VOLUME_TESTE"
```

---

## 5. Substituir os dados em uso

> **Leia isto antes.** Restaurar devolve a instalação ao ponto da cópia. **Tudo
> o que foi escrito depois dela — mensagens, contas, anexos — não está lá e não
> volta.** Se o problema for pontual (uma conta, um canal), prefira corrigir o
> ponto em vez de voltar tudo.

*Efeito sobre chamadas:* o chat fica fora do ar durante a troca. Avise antes.

```bash
# 1. Uma cópia do estado ATUAL, antes de substituí-lo. Se a restauração for a
#    escolha errada, é ela que permite desfazer.
#    Repita a seção 2 inteira, com carimbo novo.

# 2. Parar quem escreve.
docker compose -p "$TUMACORD_PROJETO" stop tumacord-server

# 3. Esvaziar e repopular o volume — pelo nome DESCOBERTO, nunca presumido,
#    e com o conteúdo conferido no passo 4.
docker run --rm \
  -v "$TUMACORD_VOLUME":/dados \
  -v "$(dirname "$TUMACORD_COPIA")":/entrada:ro \
  alpine:3.20 \
  sh -c 'set -e; test -f /entrada/'"$(basename "$TUMACORD_COPIA")"'; find /dados -mindepth 1 -delete; tar -xzf /entrada/'"$(basename "$TUMACORD_COPIA")"' -C /dados; test -f /dados/tumacord.json'

# 4. Subir.
docker compose -p "$TUMACORD_PROJETO" start tumacord-server
```

> **Por que `find /dados -mindepth 1 -delete` e não `rm -rf`.** O `rm -rf` do
> guia antigo recebia um caminho montado e apagava o que estivesse ali, sem
> conferir o que era. Aqui o apagamento acontece **dentro** do volume montado,
> depois de o `test -f` provar que a cópia existe, e o `test -f` final prova
> que a restauração produziu o estado. Com `set -e`, qualquer um desses falhando
> interrompe antes do passo seguinte.

**Verificação:**

```bash
curl -fsS http://127.0.0.1:4600/api/health
docker compose -p "$TUMACORD_PROJETO" logs --tail 30 tumacord-server
```

---

## Nunca faça isto

| Comando | Por quê |
|---|---|
| `docker compose down -v` | `-v` apaga os volumes. Isso não é atualizar nem reiniciar: é apagar os dados. |
| `docker system prune -a --volumes` | mesma coisa, com menos aviso |
| `rm -rf /var/lib/docker/volumes/<algo>` | um caminho errado aqui não tem volta |
| `tar` do volume com o servidor escrevendo | não prova consistência; falha só na restauração |
| restaurar direto por cima, sem ensaio | se a cópia estiver ruim, você perde as duas |

---

## Recuperação, por falha

| Falha | O que significa | O que fazer |
|---|---|---|
| não consegui pausar a escrita | servidor antigo, ou fora do ar | pare o contêiner e copie; ou corrija o servidor primeiro |
| `sha256sum -c` falha | a cópia corrompeu no transporte ou no disco | não restaure; use outra cópia |
| `tar -tzf` falha | o arquivo não abre | idem |
| `installationId` diferente | você restaurou a cópia de **outra** instalação | pare; ache a cópia certa |
| restaurou e faltam dados recentes | é o esperado: a cópia é de antes | se ainda existir, restaure a cópia do passo 5.1 |
| volume descoberto ambíguo | há duas instalações na máquina | `--projeto <nome>` em tudo |

---

## O que ainda não está automatizado

`tumacordctl backup` e `tumacordctl restore` ainda **não** estão
implementados nesta revisão; o comando diz isso e aponta para este guia em vez
de fingir que funcionou. O procedimento manual acima é o caminho suportado, e
é ele que foi ensaiado. Veja [QA da release](QA.md) para o que foi executado e
o que ficou pendente.

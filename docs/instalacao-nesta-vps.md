# A distribuição desta VPS

O que foi instalado em `200.9.155.102`, na ordem em que foi feito, e por que
cada escolha foi essa. Este documento descreve **esta** máquina — o guia
genérico, sem endereço de ninguém dentro, continua em
[Instalação na VPS](instalacao-vps.md).

Data: 13 de setembro de 2026. Versão publicada: **0.9.9-1**.

---

## O que está no ar

| Peça | Onde | Alcance | Estado |
|---|---|---|---|
| `tumacord-server` | contêiner, porta 4600 | `0.0.0.0:4600` e `tumacord.tumati.fun` pelo proxy | no ar, saudável |
| `tumacord-updates` | contêiner, porta 4300 | só `127.0.0.1` e a rede do proxy | no ar, catálogo na sequência 1 |
| administração | contêiner, porta 4301 | só `127.0.0.1` | nunca sai da máquina |
| `coturn` | contêiner, rede do host | 3478 UDP/TCP | no ar |
| proxy HTTPS | Nginx Proxy Manager | 80 e 443 | serve o chat; **falta o host de updates** |

Ambiente de publicação: a máquina do Renan, em `~/.tumacord-publicacao`. As
chaves privadas **não** estão na VPS, e não devem estar: a VPS guarda e serve o
que já chegou assinado, e comprometê-la não dá a ninguém a capacidade de
entregar um binário como oficial.

---

## As chaves

Geradas fora da VPS, uma para cada estrago possível:

| Escopo | `keyId` | Se vazar |
|---|---|---|
| `manifest` | `d1f0d8034f5c599348968c00e4e3ffb6` | quem tem entrega **código** como oficial |
| `catalog` | `6c9e6185a61f0f604da3754dbeaa85e4` | quem tem **esconde** uma versão boa ou reoferece uma velha |

```bash
node tools/publisher/publish.mjs keys generate --dir ~/.tumacord-publicacao
node tools/publisher/publish.mjs keys trusted  --dir ~/.tumacord-publicacao --out /tmp/chaves.json
ssh vps "curl -fsS -X POST http://127.0.0.1:4301/admin/keys \
  -H 'content-type: application/json' --data-binary @-" < /tmp/chaves.json
```

Só a metade pública viajou — o comando `keys trusted` aborta se encontrar
material privado no documento, e essa recusa foi exercida de propósito antes de
publicar qualquer coisa.

---

## A origem ficou embutida na build, e foi preciso escrever o gerador

`desktop/update-origin.cjs` nasce com `BUILT_IN_ORIGIN` e `BUILT_IN_KEYS`
vazios, e os comentários dele citam um `scripts/gerar-origem.mjs` que **não
existia no repositório**. Sem ele, os pacotes saem sem saber de onde atualizar:
o aplicativo mostra "não tem origem configurada" e para aí — nenhuma tela chama
`saveUpdateOrigin`, então não havia como configurar depois.

O gerador foi escrito nesta entrega:

```bash
node scripts/gerar-origem.mjs --origin https://updates.tumati.fun --keys /tmp/chaves.json
node scripts/gerar-origem.mjs --mostrar     # o que está gravado
node scripts/gerar-origem.mjs --limpar      # volta ao estado do repositório
```

Ele recusa, e cada recusa foi exercida:

| Recusa | Motivo |
|---|---|
| `http` para fora | uma build assim entrega o catálogo e a credencial a quem estiver no caminho, e o erro só aparece na máquina de quem instalou |
| documento com material privado | um executável distribuído com a chave de assinatura dentro acaba com a distribuição inteira |
| falta o escopo `manifest` ou `catalog` | a build sairia capaz de verificar metade do caminho |

**Por que embutir.** A origem e as chaves respondem "em quem este executável
confia para instalar código nesta máquina". Se elas chegassem pela rede, entrar
num servidor qualquer seria entregar a ele essa capacidade.

---

## A release 0.9.9-1

Compilada na máquina de publicação, **depois** de gravar a origem — os pacotes
da primeira compilação foram descartados justamente porque saíram sem ela.

```bash
npm ci && npm run package:linux
node tools/publisher/publish.mjs manifest --version 0.9.9-1 \
  --commit 4c044626e25cdbd897ca1af31154e9b0198c4c4e \
  --packages release/ --dir ~/.tumacord-publicacao --out /tmp/manifest.json
```

| Pacote | Tamanho | SHA-256 (início) |
|---|---|---|
| `tumacord-0.9.9-1.tar.gz` | 119 758 922 B | `97173c80…` |
| `Tumacord-0.9.9-1.AppImage` | 125 890 628 B | `44e3cc5e…` |

**Não há pacote de Windows**, e isso é dito em vez de escondido: o componente
nativo de áudio é compilado com as ferramentas C++ do Visual Studio, e não sai
de um clone em Linux. Quem estiver no Windows verá a versão anunciada e **sem
botão de aplicar** — o que é melhor do que "não há atualização", que mandaria
procurar defeito no lugar errado. Quando houver uma máquina Windows, rode
`npm run package:windows` e republique o manifesto com os quatro pacotes.

Os bytes e os documentos:

```bash
rsync -av release/ vps:/var/lib/docker/volumes/tumacord_tumacord-pacotes/_data/releases/0.9.9-1/
ssh vps "cd /home/Tumacord && node tools/tumacordctl/tumacordctl.mjs releases import  --manifest /tmp/manifest.json"
ssh vps "cd /home/Tumacord && node tools/tumacordctl/tumacordctl.mjs releases publish --catalog  /tmp/catalog.json"
```

Os dois SHA-256 foram conferidos no destino antes da importação. Catálogo
publicado na **sequência 1**, válido até 20/09/2026 — um catálogo vence de
propósito, para que uma retirada sempre alcance quem está na rua.

---

## Como o proxy alcança a 4300, e por que de um jeito torto

A 4300 é publicada **só em `127.0.0.1`**: o desenho quer que o proxy HTTPS seja
o único caminho de fora. Só que o Nginx Proxy Manager desta máquina roda em
contêiner, em outra rede Docker — e `127.0.0.1` dentro do contêiner dele é ele
mesmo. O chat não tem esse problema porque a 4600 está publicada em `0.0.0.0` e
o proxy a alcança pelo IP público.

Abrir a 4300 em `0.0.0.0` resolveria e estaria errado: o catálogo passaria a
responder na internet em HTTP puro, e uma credencial de dispositivo atravessaria
a rede em claro.

O que foi feito: o contêiner de atualizações entrou **também** na rede do proxy,
por `docker-compose.override.yml` em `/home/Tumacord`:

```yaml
services:
  tumacord-updates:
    networks: [default, proxy]

networks:
  proxy:
    external: true
    name: nginx-proxy-manager_default
```

Assim o proxy o alcança por **nome** (`tumacord-updates:4300`), sem IP para
envelhecer, e nada novo é publicado na internet. O override não é versionado de
propósito: ele descreve a rede desta máquina, o Compose o junta sozinho, e
trocar a versão do Tumacord não o apaga. `default` continua na lista — omiti-lo
tiraria o serviço da rede do próprio projeto.

Só o contêiner de atualizações foi recriado. O chat não foi tocado, que é
exatamente a razão de os dois serem contêineres separados.

---

## O que falta: o host do proxy

Este é o único passo que não foi feito, porque ele exige a sessão do Nginx
Proxy Manager. Em `https://ng.tumati.fun`, **Hosts → Proxy Hosts → Add**:

| Campo | Valor |
|---|---|
| Domain Names | `updates.tumati.fun` |
| Scheme | `http` |
| Forward Hostname / IP | `tumacord-updates` |
| Forward Port | `4300` |
| Block Common Exploits | ligado |
| Websockets Support | desligado (o serviço não usa) |
| SSL → Certificate | **Request a new SSL certificate** |
| SSL → Force SSL, HTTP/2 | ligados |

Na aba **Advanced**, cole:

```nginx
# Um pacote tem ~120 MB. Com o buffering ligado, o nginx copia o arquivo
# inteiro para disco antes de entregá-lo; desligado, os bytes passam direto.
proxy_buffering off;
proxy_request_buffering off;
# Um download em conexão ruim leva mais do que os 60 s do padrão.
proxy_read_timeout 300s;
proxy_send_timeout 300s;
```

O DNS já resolve: `*.tumati.fun` aponta para esta máquina.

**Verificação — e ela não é opcional:**

```bash
curl -fsS https://updates.tumati.fun/v1/health
curl -s -o /dev/null -w '%{http_code}\n' https://updates.tumati.fun/v1/catalog
```

O primeiro responde `{"ok":true,...,"sequence":1,...}`. O segundo tem de
responder **401**. Se ele responder o catálogo sem credencial, pare: algo no
proxy está contornando a autorização.

---

## O caminho do cliente, exercido

Antes de o HTTPS existir, o caminho inteiro foi exercido contra o serviço de
verdade, por um túnel para a 4300 e com os **módulos reais do aplicativo** —
`update-source.cjs`, `update-origin.cjs` e `update-check.cjs`, os mesmos
arquivos que vão dentro do pacote. Nada de mock.

| Verificação | Resultado |
|---|---|
| origem e duas chaves embutidas no `app.asar` | ✓ |
| catálogo recusado sem credencial | 401, com a mensagem em português |
| convite virou credencial de dispositivo | ✓ |
| o mesmo convite usado duas vezes | recusado |
| catálogo assinado verificado contra as chaves embutidas | ✓ sequência 1 |
| catálogo de sequência anterior (replay) | recusado (`replayed`) |
| catálogo assinado por chave desconhecida | recusado (`bad-signature`) |
| manifesto igual ao que o catálogo prometeu | ✓ |
| download de 120 MB com tamanho e SHA-256 conferidos | ✓ em 1,9 s |
| credencial revogada volta a receber 401 | ✓ |

O dispositivo criado para essa verificação foi revogado no fim. Os 84 testes de
`updateCheck`, `updater`, `distribution` e `updateService` passam com a origem
gravada.

**O que não foi exercido:** aplicar uma atualização numa instalação real — nem
pelo aplicativo (trocar o atalho `current`, substituir o AppImage), nem pelo
`tumacordctl server apply`. Continua sendo o procedimento marcado como NÃO
EXECUTADO no [QA](QA.md).

---

## Autorizar um dispositivo

Um convite por máquina, de uso único, por canal privado — nunca pelo chat que
ele mesmo atualiza:

```bash
ssh vps "cd /home/Tumacord && node tools/tumacordctl/tumacordctl.mjs devices enroll --label 'Windows do Caio'"
```

No aplicativo, o botão de atualização da barra de cima pede o convite quando não
há credencial. O primeiro convite — `Fedora do Renan` — está em
`~/.tumacord-publicacao/convites/`, modo 600, e vale 24 h.

> **No Linux sem chaveiro a inscrição é pedida de novo.** A credencial é
> guardada pelo `safeStorage` do Electron; quando o chaveiro não está
> disponível, o aplicativo **não** grava o token em claro — ele pede o convite
> outra vez. É a escolha certa e custa um convite a mais.

---

## O que fazer backup, e o que é insubstituível

| O que | Onde | Se perder |
|---|---|---|
| chaves privadas de assinatura | máquina de publicação, `~/.tumacord-publicacao` | **não se publica mais nada**, nem uma correção, e não há como recriá-las |
| `catalog-state.json` | a mesma pasta | a sequência anda para trás e o catálogo é recusado pelos dois lados — recuperável por `state import` |
| `tumacord_tumacord-data` | VPS | contas e mensagens |
| `tumacord_tumacord-catalogo` | VPS | catálogo, manifestos e autorizações de dispositivo |
| `tumacord_tumacord-pacotes` | VPS | os bytes das versões (recompiláveis, mas o SHA-256 muda) |
| `docker-compose.override.yml` | `/home/Tumacord` | o proxy perde o caminho até a 4300 |

A pasta de publicação é **uma só**, e é por isso que ela sai da máquina no
backup: publicar às cegas produziria uma sequência que anda para trás.

---

## Arrumações feitas de passagem

- `/home/Tumacord/.env` estava `644` — legível por qualquer usuário da máquina,
  com a chave de acesso e o segredo do TURN dentro. Agora está `600`, como o
  guia pede.
- O `doctor` passou limpo antes e depois: `Nada impede a operação.`

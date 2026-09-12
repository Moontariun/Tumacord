# Publicação privada

Como uma versão sai do código e chega aos aplicativos, sem passar pelo GitHub
em nenhum momento do caminho do usuário.

---

## O desenho, em uma frase

O código e os binários são publicados numa Release **privada**; a VPS importa
esses artefatos, valida tudo, e promove um catálogo assinado; os aplicativos
consultam **só a VPS**.

```
 ambiente de publicação          VPS                         aplicativos
 ──────────────────────          ───                         ───────────
 build + assina  ──────────►  importa e confere
 (chave privada)               guarda em /pacotes
                               publica o catálogo  ──────►  consulta /v1/catalogo
                                                            baixa /v1/artefatos/…
                                                            confere assinatura
```

**Os aplicativos não consultam o GitHub** — nem para verificar, nem para
baixar, nem no primeiro download de um cliente novo. Todos os pacotes de uma
versão promovida já estão locais e validados antes de ela ser promovida.

**A VPS não assina nada.** A chave privada vive no ambiente de publicação. A
VPS guarda e serve o que já chegou assinado, e sabe apenas conferir — comprometê-la
não dá a ninguém a capacidade de entregar um binário como oficial.

---

## As duas chaves, e por que são duas

| Chave | Assina | Se vazar |
|---|---|---|
| **manifesto** | os pacotes de uma release | quem tem entrega **código** como oficial |
| **catálogo** | o que está publicado e o que foi retirado | quem tem **esconde** uma versão boa ou reoferece uma velha |

Não é o mesmo estrago, então não é a mesma chave. Quem pode retirar uma versão
do ar não precisa poder assinar um binário novo.

### Gerar as chaves

*Onde:* no ambiente de publicação — **nunca** na VPS.
*Usuário:* o seu, com o diretório em modo `700`.

```bash
mkdir -p ~/.tumacord-publicacao && chmod 700 ~/.tumacord-publicacao
node -e '
const { generateSigningKey } = require("./dist-server/version-helpers.cjs");
' 2>/dev/null || node --import tsx -e '
import { generateSigningKey } from "./shared/distributionCrypto.ts";
import { writeFileSync } from "node:fs";
for (const escopo of ["manifesto", "catalogo"]) {
  const chave = generateSigningKey();
  writeFileSync(`${process.env.HOME}/.tumacord-publicacao/${escopo}.json`, JSON.stringify(chave, null, 2), { mode: 0o600 });
  console.log(`${escopo}: keyId ${chave.keyId}`);
}
'
chmod 600 ~/.tumacord-publicacao/*.json
```

**Saída esperada:** duas linhas com `keyId` de 32 caracteres hexadecimais.

> O `keyId` é derivado da própria chave pública (SHA-256 dela). Ele não é
> escolhido, então uma chave nova não consegue se apresentar com o id de uma
> antiga — e duas cópias da mesma chave sempre têm o mesmo id, o que torna a
> rotação verificável.

### Registrar as chaves públicas na VPS

*Onde:* na VPS. Só a metade **pública** viaja.

```bash
# Monte o documento com as duas públicas e seus escopos, e envie.
curl -fsS -X POST http://127.0.0.1:4301/admin/chaves \
  -H 'content-type: application/json' \
  -d '{"keys":[
        {"keyId":"<id-manifesto>","algorithm":"ed25519","publicKey":"<spki-base64>","scope":["manifest"]},
        {"keyId":"<id-catalogo>","algorithm":"ed25519","publicKey":"<spki-base64>","scope":["catalog"]}
      ]}'
```

**Verificação:**

```bash
curl -fsS http://127.0.0.1:4300/v1/chaves
```

**Confira que nenhuma chave privada aparece na saída.** Elas não deveriam ter
saído da sua máquina.

---

## Publicar uma versão

### 1. Produzir os binários

Cada plataforma no seu ambiente:

| Pacote | Onde é produzido | Por quê |
|---|---|---|
| `tumacord-<versão>.tar.gz` | Linux | `npm run package:linux` |
| `Tumacord-<versão>.AppImage` | Linux | idem |
| `Tumacord-<versão>-Setup.exe` | **Windows** | precisa do componente nativo de áudio |
| `Tumacord-<versão>-portable.exe` | **Windows** | idem |

> **Os binários de Windows não saem de um clone em Linux.** O componente nativo
> é compilado com as ferramentas C++ do Visual Studio, e `npm run package:windows`
> chama `native/windows/audio-helper/build.ps1`. Não há atalho — um pacote de
> Windows produzido sem ele sai sem o roteamento de áudio por processo.

### 2. Montar e assinar o manifesto

O manifesto descreve cada pacote: OS, arquitetura, formato, jeito de instalar,
tamanho, SHA-256 e o caminho dentro do armazenamento privado.

```bash
export TUMACORD_VERSAO="0.9.9-1"
export TUMACORD_COMMIT="$(git rev-parse HEAD)"
node tools/publicador/montar-manifesto.mjs \
  --versao "$TUMACORD_VERSAO" \
  --commit "$TUMACORD_COMMIT" \
  --canal stable \
  --pacotes release/ \
  --chave ~/.tumacord-publicacao/manifesto.json \
  --saida /tmp/manifesto-$TUMACORD_VERSAO.json
```

**Verificação:** o manifesto precisa ter um pacote por jeito de instalar que
você produziu, e o SHA-256 de cada um precisa bater com o arquivo.

> **O caminho de cada pacote é relativo ao armazenamento** — nunca uma URL.
> Guardar URL num documento assinado deixaria um manifesto mandar o aplicativo
> buscar binário em outro domínio.

### 3. Enviar os bytes e importar o manifesto

```bash
# Os arquivos, para o armazenamento privado da VPS.
rsync -av --progress release/ vps:/var/lib/docker/volumes/<projeto>_tumacord-pacotes/_data/releases/$TUMACORD_VERSAO/

# O manifesto, pela administração local.
scp /tmp/manifesto-$TUMACORD_VERSAO.json vps:/tmp/
ssh vps "cd /opt/tumacord && node tools/tumacordctl/tumacordctl.mjs releases importar --manifesto /tmp/manifesto-$TUMACORD_VERSAO.json"
```

**Saída esperada:** `Manifesto da release <id> importado e conferido.`

**Se ele for recusado**, o motivo é dito: `unknown-key` (a chave não está
registrada), `key-wrong-scope` (você assinou o manifesto com a chave de
catálogo), `bad-signature` (o documento mudou depois de assinado).

### 4. Validar em homologação, antes de promover

O catálogo é o que muda o que os aplicativos veem. **Não promova sem ter
instalado a versão em algum lugar.**

```bash
# Publique primeiro no canal de teste.
node tools/publicador/montar-catalogo.mjs --canal test --incluir "$TUMACORD_VERSAO" \
  --chave ~/.tumacord-publicacao/catalogo.json --saida /tmp/catalogo-teste.json
node tools/tumacordctl/tumacordctl.mjs releases publicar --catalogo /tmp/catalogo-teste.json
```

Instale numa máquina de homologação apontando o canal `test` e verifique.

### 5. Promover

```bash
node tools/publicador/montar-catalogo.mjs --canal stable --incluir "$TUMACORD_VERSAO" \
  --chave ~/.tumacord-publicacao/catalogo.json --saida /tmp/catalogo.json
node tools/tumacordctl/tumacordctl.mjs releases publicar --catalogo /tmp/catalogo.json
```

**Saída esperada:** `Catálogo publicado na sequência <N>.`

A promoção é **atômica**: o catálogo inteiro troca de uma vez, e não existe
instante em que alguém leia metade dele.

### O que a publicação recusa

| Recusa | Motivo |
|---|---|
| `sequence-not-advancing` | a sequência precisa crescer a cada publicação |
| `manifest-missing` | uma entrada não tem manifesto importado |
| `duplicate-version` | a mesma versão duas vezes no canal |
| `reused-version` | esse número já foi publicado apontando para outra release |
| `key-wrong-scope` | você assinou o catálogo com a chave de manifesto |

> **`reused-version` é a recusa que evita mais estrago.** Reaproveitar `0.9.9-1`
> para outra release faria metade do grupo estar numa 0.9.9-1 e a outra metade
> noutra, com o mesmo nome, e sem jeito de distinguir.

---

## Retirar uma versão

Retirar quer dizer: nenhuma cópia instalada volta a oferecê-la, e ninguém
consegue baixá-la de novo — inclusive as máquinas que já estavam na rua quando
o defeito apareceu. A release **não** é apagada, os bytes continuam no
armazenamento, e quem já tem o arquivo continua com ele.

```bash
node tools/tumacordctl/tumacordctl.mjs releases retirar rel_0991 \
  --motivo "o áudio sai errado no Windows"
```

O comando devolve o catálogo **a assinar** — ele não publica, porque a VPS não
assina. Assine no ambiente de publicação e publique de volta:

```bash
node tools/publicador/assinar.mjs --entrada catalogo-retirada.json \
  --chave ~/.tumacord-publicacao/catalogo.json --saida catalogo-assinado.json
node tools/tumacordctl/tumacordctl.mjs releases publicar --catalogo catalogo-assinado.json
```

**O motivo não é enfeite:** ele aparece na tela de quem tentar instalar e na
lista do painel do servidor.

---

## Autorizar dispositivos

Cada aplicativo precisa de uma credencial para baixar. Ela é obtida por
**convite de uso único**, passado por canal privado.

```bash
node tools/tumacordctl/tumacordctl.mjs devices convidar --rotulo "Windows do Caio"
node tools/tumacordctl/tumacordctl.mjs devices listar
node tools/tumacordctl/tumacordctl.mjs devices revogar <deviceId> --motivo "máquina perdida"
```

> **Por que não um segredo embutido no executável.** Ele seria o mesmo para
> todo mundo, vazaria no primeiro `strings`, e não poderia ser revogado sem
> trocar o executável de todos.

Uma credencial de download **só baixa**: ela não publica, não retira versão e
não aplica nada no servidor.

---

## Rotação e revogação de chaves

**Rotação sem janela cega:** durante a troca, os documentos saem assinados pela
chave velha **e** pela nova. Quem só conhece a velha verifica; quem já só
conhece a nova também. Depois que todos os clientes conhecem a nova, a velha
sai.

```bash
# 1. Gere a nova. 2. Registre as duas como confiáveis na VPS.
# 3. Publique assinando com as duas por um ciclo.
# 4. Marque a antiga como revogada e publique de novo, só com a nova.
```

**Revogação:** uma chave com `revokedAt` para de valer imediatamente, e o
motivo é dito na recusa. Os documentos que ela assinou **param de ser aceitos**
— por isso a revogação vem sempre acompanhada de uma republicação assinada
pela chave que ficou.

**Recuperação:** as chaves privadas fazem parte do backup fora da máquina.
Sem elas não se publica mais nada, nem uma correção — e não há como recriá-las:
a chave é o que prova a autoria, e uma chave nova precisa ser distribuída aos
clientes antes de valer.

---

## Entrada manual, sem GitHub

O serviço aceita um **bundle de publicação** já gerado e assinado, para operar
quando o GitHub não estiver disponível ou não for usado:

```bash
# Os bytes.
rsync -av bundle/pacotes/ vps:/var/lib/docker/volumes/<projeto>_tumacord-pacotes/_data/
# Os documentos.
node tools/tumacordctl/tumacordctl.mjs releases importar --manifesto bundle/manifesto.json
node tools/tumacordctl/tumacordctl.mjs releases publicar --catalogo bundle/catalogo.json
```

Nada nesse caminho consulta a rede além da própria VPS.

---

## O que ainda não está implementado

`tools/publicador/` — `montar-manifesto.mjs`, `montar-catalogo.mjs` e
`assinar.mjs` — **não** existe nesta revisão. Os contratos que ele produziria
estão definidos e testados em `shared/distribution.ts` e
`tests/distribution.test.ts`, e o serviço já aceita, confere e recusa os
documentos corretamente (`tests/updateService.integration.test.ts`).

O que falta é a ferramenta que monta os documentos a partir de uma pasta de
binários. Até lá, os documentos precisam ser montados à mão seguindo os tipos
de `shared/distribution.ts`.

Veja [QA da release](QA.md) para o que foi executado e o que ficou pendente.

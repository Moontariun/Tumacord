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
                               publica o catálogo  ──────►  consulta /v1/catalog
                                                            baixa /v1/artifacts/…
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
*Usuário:* o seu. A pasta nasce em modo `700` e os arquivos em `600`.

```bash
node tools/publisher/publish.mjs keys generate --dir ~/.tumacord-publicacao
```

**Saída esperada:** duas linhas com `keyId` de 32 caracteres hexadecimais, uma
para `manifest` e outra para `catalog`.

**Se já houver chave na pasta**, o comando **recusa** e não sobrescreve:
substituir uma chave em uso invalidaria tudo o que ela assinou, e não há como
desfazer isso. Para trocar de chave, leia [Rotação e revogação](#rotação-e-revogação-de-chaves).

> O `keyId` é derivado da própria chave pública (SHA-256 dela). Ele não é
> escolhido, então uma chave nova não consegue se apresentar com o id de uma
> antiga — e duas cópias da mesma chave sempre têm o mesmo id, o que torna a
> rotação verificável.

### Registrar as chaves públicas na VPS

Só a metade **pública** viaja.

```bash
node tools/publisher/publish.mjs keys trusted --dir ~/.tumacord-publicacao --out /tmp/chaves.json
scp /tmp/chaves.json vps:/tmp/
ssh vps "curl -fsS -X POST http://127.0.0.1:4301/admin/keys -H 'content-type: application/json' -d @/tmp/chaves.json"
```

**Verificação:**

```bash
ssh vps "curl -fsS http://127.0.0.1:4300/v1/keys"
```

O comando `keys trusted` confere, antes de escrever, que nenhuma chave privada
entrou no documento — e **aborta** se encontrar uma. É barato e evita o pior
erro possível.

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
export TUMACORD_VERSAO="0.9.10"
node tools/publisher/publish.mjs manifest \
  --version "$TUMACORD_VERSAO" \
  --commit "$(git rev-parse HEAD)" \
  --packages release/ \
  --out /tmp/manifest-$TUMACORD_VERSAO.json
```

**Saída esperada:** a release, o commit, o canal, e uma linha por pacote com o
nome e o tamanho.

**O que ele recusa, e por quê:**

| Recusa | Motivo |
|---|---|
| versão fora da convenção | publicar sob uma etiqueta que o aplicativo não sabe ordenar produz uma versão que ninguém recebe |
| dois arquivos para o mesmo alvo | escolher entre eles seria adivinhar, e o erro apareceria na máquina de quem instalou |
| pacote vazio | um arquivo de zero byte não é um pacote |
| nenhum pacote da versão | a pasta de build é de outra versão |

**Faltar um formato não é erro**, e é dito: uma build só de Linux é legítima.
Quem estiver nos formatos ausentes verá a versão anunciada e sem botão de
aplicar — o que é melhor do que "não há atualização", que mandaria procurar
defeito no lugar errado.

As notas saem do `CHANGELOG.md`, da seção daquela versão, com o mesmo recorte
que o CI usa. Use `--changelog <arquivo>` para apontar outro.

> **O caminho de cada pacote é relativo ao armazenamento** — nunca uma URL.
> Guardar URL num documento assinado deixaria um manifesto mandar o aplicativo
> buscar binário em outro domínio.

### 3. Enviar os bytes e importar o manifesto

Os bytes vão para `releases/<versão>/` dentro do armazenamento privado, que é o
caminho que o manifesto declara.

```bash
# Descubra o volume real, sem presumir o nome:
ssh vps "cd /opt/tumacord && node tools/tumacordctl/tumacordctl.mjs install show --project tumacord"

rsync -av release/ vps:/var/lib/docker/volumes/<volume-de-pacotes>/_data/releases/$TUMACORD_VERSAO/

scp /tmp/manifest-$TUMACORD_VERSAO.json vps:/tmp/
ssh vps "cd /opt/tumacord && node tools/tumacordctl/tumacordctl.mjs releases import --manifest /tmp/manifest-$TUMACORD_VERSAO.json"
```

**Saída esperada:** `Manifesto da release <id> importado e conferido.`

**Se ele for recusado**, o motivo é dito: `unknown-key` (a chave não está
registrada), `key-wrong-scope` (você assinou o manifesto com a chave de
catálogo), `bad-signature` (o documento mudou depois de assinado).

### 4. Validar em homologação, antes de promover

O catálogo é o que muda o que os aplicativos veem. **Não promova no canal
estável sem ter instalado a versão em algum lugar.**

```bash
node tools/publisher/publish.mjs catalog \
  --manifest /tmp/manifest-$TUMACORD_VERSAO.json --channel test \
  --out /tmp/catalog-teste.json
scp /tmp/catalog-teste.json vps:/tmp/
ssh vps "cd /opt/tumacord && node tools/tumacordctl/tumacordctl.mjs releases publish --catalog /tmp/catalog-teste.json"
```

Instale numa máquina de homologação apontando o canal `test` e verifique.

### 5. Promover

```bash
node tools/publisher/publish.mjs catalog \
  --manifest /tmp/manifest-$TUMACORD_VERSAO.json \
  --out /tmp/catalog.json
scp /tmp/catalog.json vps:/tmp/
ssh vps "cd /opt/tumacord && node tools/tumacordctl/tumacordctl.mjs releases publish --catalog /tmp/catalog.json"
```

**Saída esperada:** `Catálogo publicado na sequência <N>.`

A promoção é **atômica**: o catálogo inteiro troca de uma vez, e não existe
instante em que alguém leia metade dele.

> **O estado do catálogo mora no ambiente de publicação**, em
> `~/.tumacord-publicacao/catalog-state.json`, porque só lá ele pode ser
> produzido. Isso significa **um** ambiente de publicação, e esse arquivo faz
> parte do backup. Se ele se perder, veja
> [Recuperar o estado do catálogo](#recuperar-o-estado-do-catálogo).

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
node tools/publisher/publish.mjs withdraw \
  --release rel_stable_0-9-10 \
  --reason "o áudio sai errado no Windows" \
  --out /tmp/catalog-retirada.json

scp /tmp/catalog-retirada.json vps:/tmp/
ssh vps "cd /opt/tumacord && node tools/tumacordctl/tumacordctl.mjs releases publish --catalog /tmp/catalog-retirada.json"
```

**O motivo não é enfeite:** ele aparece na tela de quem tentar instalar e na
lista do painel do servidor. Sem ele o comando recusa — uma versão que some sem
explicação faz a pessoa achar que o problema é dela.

A retirada aumenta a sequência do catálogo **sem oferecer nada novo**. Ela nunca
vira um convite para voltar a uma versão anterior: o aplicativo não aceita
downgrade automático.

## Recuperar o estado do catálogo

Se a pasta de publicação se perder — e as chaves vierem do backup —, o estado
do catálogo é reconstruído a partir do que está publicado:

```bash
ssh vps "curl -fsS http://127.0.0.1:4301/admin/catalog" > /tmp/publicado.json
node tools/publisher/publish.mjs state import --from /tmp/publicado.json
```

**Saída esperada:** `Estado do catálogo importado: sequência <N>.`

**Por que isso importa:** publicar às cegas produziria uma sequência que anda
para trás, e um catálogo assim é recusado pelo serviço **e** pelos clientes —
depois de já ter sido assinado. O comando também recusa importar um estado mais
antigo do que o local, pelo mesmo motivo.

## Autorizar dispositivos

Cada aplicativo precisa de uma credencial para baixar. Ela é obtida por
**convite de uso único**, passado por canal privado.

```bash
node tools/tumacordctl/tumacordctl.mjs devices enroll --label "Windows do Caio"
node tools/tumacordctl/tumacordctl.mjs devices listar
node tools/tumacordctl/tumacordctl.mjs devices revoke <deviceId> --reason "máquina perdida"
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
node tools/tumacordctl/tumacordctl.mjs releases import --manifest bundle/manifesto.json
node tools/tumacordctl/tumacordctl.mjs releases publish --catalog bundle/catalogo.json
```

Nada nesse caminho consulta a rede além da própria VPS.

---

## O que foi exercido, e o que não foi

O caminho de publicação acima está implementado e exercido de ponta a ponta em
`tests/publisher.integration.test.ts`: uma pasta de build vira release assinada,
é importada e publicada, e o aplicativo a recebe e a baixa.

O outro lado da operação também existe nesta entrega: o executor que aplica uma
release ao servidor ([Atualização do servidor](atualizacao-servidor.md)),
`tumacordctl backup` e `restore` ([Backup e restauração](backup-restore.md)), e
o painel do dono, que conversa com o executor por socket.

**Nenhum deles foi exercido contra uma VPS de verdade.** Os testes sobem o
executor num socket real e conferem a conversa com o painel, mas substituem o
Docker e o git nas etapas que trocariam a versão de um servidor em uso. Aplicar
uma release numa instalação real é o procedimento marcado como NÃO EXECUTADO no
QA.

Veja [QA da release](QA.md) para o que foi executado e o que ficou pendente.

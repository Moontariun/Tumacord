# Atualização do servidor dedicado

Trocar a versão do `tumacord-server` e da web, preservando os dados.

> **O que mudou na 0.9.9-1.** O guia anterior falava de uma migração `0.8.1`
> que não existe mais, mandava fazer `rollback` para `0.8.0` no README enquanto
> o script voltava para `0.9.6`, e recomendava `git pull` num clone que está em
> *detached HEAD*. Os três estão corrigidos aqui. O rollback passou a ser para
> o **deployment anterior registrado**, e não para um número escrito à mão.

---

## Antes de tudo

*Plataforma:* Linux, Docker Engine 24+, Compose v2.20+.
*Usuário:* no grupo `docker`, ou `root`.
*Diretório:* o do projeto.

```bash
export TUMACORD_DIR="/opt/tumacord"
export TUMACORD_PROJETO="tumacord"
# A referência EXATA a aplicar. Sempre uma tag — nunca uma branch.
export TUMACORD_REF="v0.9.9-1"
```

> **Por que nunca uma branch.** Uma branch muda de significado entre o momento
> em que você lê o comando e o momento em que ele roda. "A mais recente" não é
> um endereço: é uma promessa sobre o futuro.

**Efeito sobre chamadas:** o chat fica fora do ar entre parar e subir —
tipicamente menos de um minuto, mais o tempo de compilar a imagem. **Avise o
grupo antes.** Quem estiver em call cai.

---

## 1. Preflight

```bash
cd "$TUMACORD_DIR"
node tools/tumacordctl/tumacordctl.mjs doctor --projeto "$TUMACORD_PROJETO"
```

**Só siga com código de saída 0.** Cada falha vem com o que resolver. As duas
que mais aparecem:

- **volume de dados não encontrado** — não aplique. Sem saber onde os dados
  estão, o backup não acontece, e um backup que não aconteceu só avisa na hora
  de restaurar;
- **espaço em disco** — aplicar precisa de espaço para o backup **e** para a
  imagem nova.

---

## 2. Backup

Não pule. O procedimento completo, com a pausa de escrita que dá o ponto
consistente, está em [Backup e restauração](backup-restore.md#2-a-cópia-consistente).

Guarde o caminho da cópia: ele é o caminho de volta se algo der errado.

```bash
echo "$TUMACORD_COPIA"
```

---

## 3. Registrar o deployment atual

Isto é o que torna o rollback possível **sem adivinhar um número**.

```bash
cd "$TUMACORD_DIR"
mkdir -p /var/lib/tumacord/deployments
cat > "/var/lib/tumacord/deployments/anterior.json" <<JSON
{
  "registradoEm": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "commit": "$(git rev-parse HEAD)",
  "ref": "$(git describe --tags --always HEAD)",
  "imagem": "$(docker compose -p "$TUMACORD_PROJETO" images -q tumacord-server)",
  "copia": "${TUMACORD_COPIA:-NENHUMA}"
}
JSON
cat "/var/lib/tumacord/deployments/anterior.json"
```

**Saída esperada:** o JSON, com `commit` e `imagem` preenchidos. Se `imagem`
sair vazio, o serviço não está de pé — resolva antes.

---

## 4. Trazer a referência exata

**Não use `git pull`.** O clone está em *detached HEAD*, e `git pull` ali ou
falha ou traz outra coisa.

```bash
cd "$TUMACORD_DIR"
git fetch --tags --force origin
git checkout --detach "$TUMACORD_REF"
```

**Verificação — obrigatória:**

```bash
git describe --exact-match --tags HEAD   # precisa imprimir exatamente $TUMACORD_REF
git rev-parse HEAD                        # anote: é o commit que vai rodar
git status --porcelain                    # precisa sair vazio
```

**Se `git status` não sair vazio**, há alteração local no checkout. Ele deveria
ser descartável — descubra o que mudou antes de seguir, porque `checkout` pode
tê-la perdido.

**Se `describe` falhar** com `no tag exactly matches`, você não está na
referência que pensa. Pare.

---

## 5. Aplicar

```bash
cd "$TUMACORD_DIR"
docker compose -p "$TUMACORD_PROJETO" up -d --build tumacord-server tumacord-atualizacoes
```

**Saída esperada:** `Started` para os dois serviços.

---

## 6. Validar — versão, e não só "respondeu 200"

Um `HTTP 200` diz que **algum** servidor respondeu. Ele não diz que é o servidor
certo, nem que é a versão que você acabou de aplicar. O guia anterior parava
aqui, e era por isso que uma atualização podia "dar certo" sem ter acontecido.

```bash
# 1. O endpoint INTERNO, sem passar pelo proxy: ele responde sobre este contêiner.
docker compose -p "$TUMACORD_PROJETO" exec -T tumacord-server \
  node -e 'fetch("http://127.0.0.1:4600/api/health").then(r=>r.json()).then(j=>console.log(JSON.stringify(j)))'
```

**Verifique, na saída:**

| Campo | O que precisa ser |
|---|---|
| `version` | exatamente a versão de `$TUMACORD_REF`, sem o `v` |
| `installationId` | **o mesmo de antes**. Se mudou, os dados não são os mesmos |
| `commit` | o `git rev-parse HEAD` do passo 4 |

```bash
# 2. Os dados continuam lá.
docker compose -p "$TUMACORD_PROJETO" exec -T tumacord-server \
  sh -c 'ls -la /data/tumacord.json && ls /data/attachments | wc -l'
```

```bash
# 3. E o caminho PÚBLICO, que é outro teste: ele exercita o proxy e o TLS.
curl -fsS "https://$TUMACORD_DOMINIO_CHAT/api/health" | head -c 200; echo
```

**Só considere a atualização feita quando os três passarem.**

---

## 7. Rollback — para o deployment anterior registrado

Se a validação falhar, volte. **Não** para um número escrito num guia: para o
que você registrou no passo 3.

```bash
export TUMACORD_ANTERIOR="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/var/lib/tumacord/deployments/anterior.json","utf8")).commit)')"
echo "voltando para $TUMACORD_ANTERIOR"

cd "$TUMACORD_DIR"
git checkout --detach "$TUMACORD_ANTERIOR"
docker compose -p "$TUMACORD_PROJETO" up -d --build tumacord-server tumacord-atualizacoes
```

**Valide igual ao passo 6**, conferindo que a `version` é a anterior.

### Quando o rollback do binário não basta

Voltar o código **não** volta os dados. Se a versão nova migrou o schema, a
anterior pode não saber ler o que ela escreveu.

| Situação | O que fazer |
|---|---|
| a versão nova não migrou nada | o rollback acima resolve |
| migrou, e a anterior lê o formato novo | idem |
| migrou, e a anterior **não** lê | restaure a cópia do passo 2 — e leia o aviso abaixo |

> **Restaurar dados devolve a instalação ao ponto da cópia.** Tudo o que foi
> escrito depois dela — mensagens, contas, anexos — não volta. O procedimento
> está em [Backup e restauração](backup-restore.md#5-substituir-os-dados-em-uso),
> e ele pede confirmação explícita justamente por isso.

O `CHANGELOG.md` de cada versão diz se ela migrou dados.

---

## O executor, para atualizar pelo painel

O painel do dono mostra as versões publicadas e pede a aplicação. Quem aplicaria
é o **executor**, um serviço systemd no host — e não o contêiner, que não
consegue reconstruir a si mesmo.

> ### NÃO IMPLEMENTADO nesta revisão
>
> O executor **não** existe ainda. `packaging/servidor/tumacord-executor.service`
> está versionado como o desenho dele — com as permissões restritas e a
> interface local que ele terá —, mas o programa que a unidade chamaria ainda
> não foi escrito. **Não habilite essa unidade**: ela falharia ao subir.
>
> Enquanto isso: `TUMACORD_SELF_UPDATE` deve continuar em `0`, e a atualização
> é o procedimento manual desta página. Ligar a variável sem o executor faz o
> painel mostrar as versões e a aplicação falhar — que é exatamente a
> inconsistência que o `.env.example` anterior carregava, e por isso ela está
> escrita aqui em vez de escondida.

Quando ele existir, o contrato já está definido: ele escuta numa interface
local restrita, recebe **argumentos estruturados** — uma release por
identificador exato, validada contra o catálogo aprovado — e nunca um comando,
uma URL ou um caminho vindos do navegador. O socket do Docker não é montado no
contêiner de chat em nenhuma hipótese.

## Quando algo falha

| Sintoma | O que fazer |
|---|---|
| `describe --exact-match` falha | você não está na tag; refaça o passo 4 |
| `git status` não sai vazio | há alteração local; investigue antes |
| build falha | `docker compose logs`; o código anterior ainda está de pé |
| sobe mas `version` é a antiga | a imagem não foi reconstruída: `--build` foi esquecido |
| `installationId` mudou | os dados não são os mesmos. **Pare** e confira o mount |
| responde interno mas não público | o problema é proxy ou TLS, não o servidor |
| não sobe de jeito nenhum | rollback (passo 7) e investigue com o serviço anterior de pé |

---

## O que ainda é manual

`tumacordctl server apply` e `tumacordctl server rollback` **não** estão
implementados nesta revisão. O comando diz isso e aponta para esta página, em
vez de fingir que funcionou. Os passos acima são o caminho suportado.

Veja [QA da release](QA.md) para o que foi executado e o que ficou pendente.

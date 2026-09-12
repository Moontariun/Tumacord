# Solução de problemas

Sintomas concretos, o que cada um costuma significar, e o que fazer. Os
comandos usam os parâmetros de [Instalação na VPS](instalacao-vps.md).

---

## Primeiro: o preflight

Antes de qualquer investigação, pergunte à máquina:

```bash
cd "$TUMACORD_DIR"
node tools/tumacordctl/tumacordctl.mjs doctor --projeto "$TUMACORD_PROJETO"
```

Ele não muda nada, pode rodar com gente na call, e **não imprime o valor de
variável nenhuma** — a saída dele pode ser colada num relato.

Para o retrato completo da instalação:

```bash
node tools/tumacordctl/tumacordctl.mjs instalacao --projeto "$TUMACORD_PROJETO"
```

---

## Servidor

### O `docker compose up` recusa citando uma variável

O `.env` está incompleto. O erro nomeia qual. Veja
[Configuração](configuracao.md).

### O contêiner sobe e cai em laço

```bash
docker compose -p "$TUMACORD_PROJETO" logs --tail 80 tumacord-server
```

Causas comuns: `DATA_DIR` apontando para um caminho sem permissão de escrita;
`tumacord.json` corrompido; porta já ocupada.

### `/api/health` responde, mas com a versão antiga

A imagem não foi reconstruída. `docker compose up -d` sozinho reutiliza a
imagem existente — é preciso `--build`.

```bash
docker compose -p "$TUMACORD_PROJETO" up -d --build tumacord-server
```

### `installationId` mudou depois de uma operação

**Pare.** Os dados não são os mesmos: ou o volume trocou, ou você restaurou a
cópia de outra instalação. Não escreva mais nada até entender.

```bash
node tools/tumacordctl/tumacordctl.mjs instalacao --projeto "$TUMACORD_PROJETO"
```

Confira qual volume está montado em `/data`.

---

## Atualizações

### `/v1/catalog` responde 401

Normal: ele exige credencial de dispositivo. Se responde **sem** credencial,
pare — algo no proxy está contornando a autorização.

### O aplicativo diz "não há catálogo publicado"

Nada foi promovido ainda. Veja [Publicação privada](publicacao-privada.md).

### O aplicativo diz que a credencial venceu

Ele tenta renovar sozinho. Se não conseguir, a credencial foi revogada ou o
prazo passou muito — peça um convite novo:

```bash
node tools/tumacordctl/tumacordctl.mjs devices convidar --rotulo "<a máquina>"
```

Renovar exige credencial que ainda vale, de propósito: aceitar uma vencida ou
revogada devolveria acesso a quem o dono acabou de tirar.

### Download recusado com 410

A versão foi retirada. O motivo aparece na mensagem, e ela não volta a ser
baixável — a retirada precisa alcançar as máquinas que já estavam na rua.

### Download recusado com 409 `size-mismatch`

O arquivo no armazenamento não é o que o manifesto assinado descreve. Servir
assim entregaria bytes que ninguém assinou. Reenvie o pacote correto.

### Download com 503 `busy`

O teto de downloads simultâneos foi atingido. Ele existe porque a VPS divide
rede com o chat e com o TURN. Ajuste `TUMACORD_UPDATES_MAX_DOWNLOADS` se a
máquina aguenta mais.

---

## Windows

### O instalador não abre e o app fechava sozinho

Corrigido na 0.9.9-1. Até a 0.9.8, uma falha de lançamento derrubava o processo
principal com `spawn ... EACCES`. Agora a falha é tratada e dita.

### "A instalação precisa da sua confirmação de administrador"

Você cancelou o UAC. Nada foi alterado, o aplicativo continua aberto na versão
de antes, e o instalador continua no disco.

### "O Windows recusou a execução do instalador"

`EACCES` **não prova uma causa única** — elevação necessária, antivírus e
política de máquina chegam todos assim. O arquivo está guardado; o caminho
aparece na mensagem. Execute-o à mão:

1. abra a pasta indicada;
2. clique com o botão direito no `Tumacord-<versão>-Setup.exe`;
3. **Executar como administrador**.

### "O instalador no disco não confere com o que foi verificado"

O arquivo mudou entre baixar e aplicar. Ele **não** foi executado. Baixe de
novo.

### A versão numérica no Windows não mudou

Se `0.9.9` e `0.9.9-1` aparecem como o mesmo número, os campos derivados do
`package.json` estão fora de sincronia:

```bash
node scripts/generate-version.mjs --check
```

Veja [Versionamento](versionamento.md#a-versão-numérica-do-windows).

---

## Call e live

### A live cai e só volta reabrindo o aplicativo

Corrigido na 0.9.9-1. O pedido de assistir era emitido uma vez, no clique, e
todo enlace refeito nascia sem ele — a tela parava de ser enviada e o ciclo se
realimentava. Agora a inscrição é reafirmada quando o enlace pode tê-la
perdido.

Se acontecer numa versão já atualizada, colete: modo (P2P ou dedicado), se
houve troca de host, e o que o console mostra em `[media]`.

### Recebo a tela de alguém sem ter pedido

Não deveria acontecer a partir da 0.9.9-1: a tela só entra no enlace de quem
assinou aquela transmissão. Relate com a versão dos dois lados.

### Mutei alguém e continuo ouvindo

Verifique se os dois lados estão na 0.9.9-1. Se persistir, relate: o silêncio
é escrito na faixa recebida, e há caminhos em que o navegador a reabilita.

---

## TURN

### A call não fecha entre duas redes

O relay pode não estar de pé, ou não estar anunciando o endereço público.

```bash
docker compose -p "$TUMACORD_PROJETO" --profile turn ps
docker compose -p "$TUMACORD_PROJETO" logs --tail 40 coturn
```

Confira `TUMACORD_TURN_PUBLIC_IP`: sem ele, o relay anuncia o endereço interno
e ninguém de fora o alcança.

### O coturn sobe e sai com 255, em laço

Alguma opção removida na série 4.17 — `--no-cli`, `--no-dtls`,
`--no-loopback-peers`. Veja [Configuração](configuracao.md#opções-do-coturn).

### Preciso de TURN na 443

Não cabe nesta máquina: a 443 já é o HTTPS do proxy, e Nginx comum não
multiplexa TURN e HTTP no mesmo socket. Isso exige um segundo IP ou um
multiplexador de protocolo. Veja
[Configuração](configuracao.md#portas-do-turn).

---

## Contas

### "Esse nome já pertenceu a alguém neste servidor"

O nome está reservado por uma conta que existiu. A reserva impede que quem
chega depois herde a identidade de quem saiu. Recuperar exige um procedimento
do dono — informar uma senha nova não é prova de ser a mesma pessoa.

### Há contas duplicadas de antes da 0.9.9-1

O servidor as **detecta** na subida e as reporta, sem escolher uma vencedora:
descartar a mais nova ou escolher "a última senha" apagaria a conta de alguém
em silêncio. O relatório sai sem hash e sem senha, e a resolução é do dono.

---

## Quando nada disso serve

Colete, nesta ordem:

```bash
node tools/tumacordctl/tumacordctl.mjs doctor --projeto "$TUMACORD_PROJETO" --json > /tmp/doctor.json
node tools/tumacordctl/tumacordctl.mjs instalacao --projeto "$TUMACORD_PROJETO" --json > /tmp/instalacao.json
docker compose -p "$TUMACORD_PROJETO" logs --tail 200 > /tmp/logs.txt
```

Nenhum dos três carrega valor de variável. Confira `/tmp/logs.txt` antes de
enviar: os logs da aplicação não imprimem segredo, mas um log de terceiros
pode.

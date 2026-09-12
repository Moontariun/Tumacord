# Instalar o Tumacord numa VPS

Este guia instala, do zero, o servidor dedicado **e** o serviço que distribui
as atualizações — os dois na mesma máquina, como o desenho da 0.9.9-1 prevê.

> **Antes de começar.** Nenhum endereço, domínio ou caminho está escrito aqui.
> Todos são parâmetros que você preenche no passo 1, e todo comando abaixo os
> usa por variável. Um guia com o IP de alguém dentro dele acaba instalando na
> máquina errada.

---

## O que este guia entrega

| Peça | Onde | Porta | Para quê |
|---|---|---|---|
| `tumacord-server` | contêiner | 4600 | chat, call, web |
| `tumacord-updates` | contêiner | 4300 (público), 4301 (local) | catálogo e download dos pacotes |
| `coturn` | contêiner, opcional | 3478 UDP/TCP, 5349 TLS | relay de mídia quando não há caminho direto |
| proxy HTTPS | host | 443 | TLS e os dois domínios |

**Por que o serviço de atualizações é um contêiner separado:** ele precisa
continuar de pé enquanto o `tumacord-server` reinicia, que é exatamente o
momento de uma atualização. No mesmo contêiner, ele cairia junto com o que
atualiza.

---

## Pré-requisitos

**Plataforma:** Linux com systemd. Testado nas versões abaixo; outras
provavelmente funcionam, mas não foram exercitadas.

| Ferramenta | Versão mínima | Como conferir |
|---|---|---|
| Docker Engine | 24 | `docker --version` |
| Docker Compose | v2.20 | `docker compose version` |
| git | 2.34 | `git --version` |
| Nginx (ou outro proxy) | 1.22 | `nginx -v` |

**Usuário:** um usuário no grupo `docker`, ou `root`. Os comandos abaixo dizem
qual usar em cada caso.

**Rede:** as portas 80 e 443 alcançáveis de fora, para o certificado e para o
tráfego. A 4300 e a 4301 **não** são publicadas para a internet — o proxy é
quem expõe a 4300, e a 4301 nunca sai do laço local.

**Acesso ao código:** uma *deploy key* de leitura do repositório privado. Ela é
suficiente: não é preciso — nem desejável — colocar a senha pessoal do GitHub
na VPS. Veja [Credenciais](#credenciais-quem-provisiona-o-quê).

---

## 1. Os parâmetros

Anote estes valores antes de qualquer comando. Eles aparecem em todo o resto do
guia com estes nomes exatos.

```bash
# O domínio do chat. É o que as pessoas digitam no aplicativo.
export TUMACORD_DOMINIO_CHAT="chat.exemplo.com"

# O domínio das atualizações. Separado do chat de propósito: trocar de VPS ou
# reinstalar o chat não pode derrubar a capacidade de atualizar.
export TUMACORD_DOMINIO_UPDATES="updates.exemplo.com"

# Onde o checkout vai morar. Ele é DESCARTÁVEL: nada de dados vive aqui.
export TUMACORD_DIR="/opt/tumacord"

# O nome do projeto Compose. Ele entra no nome dos volumes, então escolha e
# não mude: mudar depois cria volumes novos e vazios ao lado dos antigos.
export TUMACORD_PROJETO="tumacord"

# A referência exata a instalar: uma TAG, nunca uma branch.
export TUMACORD_REF="v0.9.9-1"
```

> **Por que uma tag e não uma branch.** Uma branch muda de significado entre o
> momento em que você lê este guia e o momento em que o comando roda. A tag é
> um commit e continua sendo o mesmo commit amanhã.

---

## 2. Obter o código

*Diretório:* qualquer um. *Usuário:* o dono de `$TUMACORD_DIR`.

```bash
sudo mkdir -p "$TUMACORD_DIR" && sudo chown "$USER" "$TUMACORD_DIR"
git clone --branch "$TUMACORD_REF" --depth 1 git@github.com:Moontariun/Tumacord.git "$TUMACORD_DIR"
```

**Saída esperada:** `Cloning into '/opt/tumacord'...` seguido de
`Note: switching to '<commit>'` (detached HEAD — é o esperado: você está numa
tag, não numa branch).

**Verificação — e ela não é opcional:**

```bash
cd "$TUMACORD_DIR" && git rev-parse HEAD && git describe --exact-match --tags HEAD
```

A segunda linha precisa imprimir exatamente `$TUMACORD_REF`. Se ela falhar com
`no tag exactly matches`, você não está na tag que pensa que está — pare aqui.

> **Não rode `git pull` neste diretório.** O clone está em *detached HEAD*, e
> `git pull` ali ou falha ou traz outra coisa. Para trocar de versão, veja
> [Atualização do servidor](atualizacao-servidor.md).

---

## 3. A configuração

*Diretório:* `$TUMACORD_DIR`. *Usuário:* o dono do diretório.

```bash
cd "$TUMACORD_DIR"
cp .env.example .env
chmod 600 .env
```

Abra `.env` e preencha. Cada variável está explicada em
[Configuração](configuracao.md); as obrigatórias são:

| Variável | O que é | Se faltar |
|---|---|---|
| `TUMACORD_SERVER_ACCESS_KEY` | a chave que o grupo usa para entrar | o `docker compose up` recusa a subir |
| `TUMACORD_ADMIN_USERNAME` | o nome que nasce dono do servidor | a primeira conta criada vira dona |

Gere a chave de acesso com algo que não seja adivinhável:

```bash
printf 'TUMACORD_SERVER_ACCESS_KEY=%s\n' "$(openssl rand -base64 24)" >> .env
```

**Verificação:**

```bash
docker compose -p "$TUMACORD_PROJETO" config >/dev/null && echo "configuração válida"
```

**Se falhar** com `required variable ... is missing a value`, a variável citada
não está no `.env`. O erro nomeia qual.

---

## 4. Subir os serviços

*Diretório:* `$TUMACORD_DIR`. *Usuário:* no grupo `docker`.

```bash
cd "$TUMACORD_DIR"
docker compose -p "$TUMACORD_PROJETO" up -d --build tumacord-server tumacord-updates
```

**Saída esperada:** duas linhas terminando em `Started`. A compilação da
primeira vez leva alguns minutos.

**Verificação:**

```bash
docker compose -p "$TUMACORD_PROJETO" ps
curl -fsS http://127.0.0.1:4600/api/health | head -c 200; echo
curl -fsS http://127.0.0.1:4300/v1/health | head -c 200; echo
```

O primeiro `curl` responde um JSON com `installationId`. O segundo responde
`{"ok":true,"service":"tumacord-updates",...}` com `"catalog":null` — é o
esperado: ainda não há nada publicado.

**Efeito sobre dados e chamadas:** nenhum. Esta é uma instalação nova.

---

## 5. O preflight

Antes de considerar a instalação pronta, pergunte à máquina se ela está.

```bash
cd "$TUMACORD_DIR"
node tools/tumacordctl/tumacordctl.mjs doctor --project "$TUMACORD_PROJETO"
```

**Saída esperada:** uma lista de verificações terminando em
`Nada impede a operação.` e código de saída 0.

Ele confere: os serviços de pé, o mount **real** dos dados (e não um nome de
volume presumido), o espaço no disco que de fato contém esses dados, as
permissões de leitura, as portas publicadas e se a porta de administração
escapou para fora.

**Ele não muda nada** e pode rodar a qualquer momento, inclusive com gente na
call. E não imprime o valor de variável nenhuma — só os nomes —, então a saída
pode ser colada num relato de problema.

**Se houver falha (`×`)**, cada uma vem com o que resolver, e o código de saída
é 1. Resolva antes de seguir.

---

## 6. O proxy HTTPS

*Diretório:* qualquer um. *Usuário:* `root`.

Dois domínios, dois blocos. A configuração versionada está em
`packaging/proxy/tumacord.conf.exemplo`; copie e substitua os domínios.

```bash
sudo cp "$TUMACORD_DIR/packaging/proxy/tumacord.conf.exemplo" /etc/nginx/sites-available/tumacord.conf
sudo sed -i "s/DOMINIO_CHAT/$TUMACORD_DOMINIO_CHAT/g; s/DOMINIO_UPDATES/$TUMACORD_DOMINIO_UPDATES/g" /etc/nginx/sites-available/tumacord.conf
sudo ln -sf /etc/nginx/sites-available/tumacord.conf /etc/nginx/sites-enabled/tumacord.conf
sudo nginx -t
```

**Saída esperada:** `syntax is ok` e `test is successful`.

Os certificados, com certbot:

```bash
sudo certbot --nginx -d "$TUMACORD_DOMINIO_CHAT" -d "$TUMACORD_DOMINIO_UPDATES"
sudo systemctl reload nginx
```

**Verificação:**

```bash
curl -fsS "https://$TUMACORD_DOMINIO_CHAT/api/health" | head -c 120; echo
curl -fsS "https://$TUMACORD_DOMINIO_UPDATES/v1/health" | head -c 120; echo
```

**Se o segundo responder 401**, está certo: o catálogo exige credencial. Se ele
responder o catálogo **sem** credencial, pare — algo no proxy está contornando
a autorização.

---

## 7. TURN, quando for preciso

O relay só entra quando algum caminho direto não se forma. Ele é opcional e
fica fora do padrão porque é a única peça que carrega mídia — e, portanto,
banda.

```bash
cd "$TUMACORD_DIR"
docker compose -p "$TUMACORD_PROJETO" --profile turn up -d coturn
```

**Portas:** 3478 (UDP e TCP) e, quando você configurar TLS, 5349.

> **Sobre TURN na 443.** Ele **não** cabe na 443 desta máquina: a 443 já é o
> HTTPS do proxy, e Nginx com `proxy_pass` comum não multiplexa TURN e HTTP no
> mesmo socket. Se você precisa de TURN na 443 — redes corporativas que só
> liberam essa porta —, isso exige um segundo IP, ou um multiplexador de
> protocolo na frente dos dois. Não há atalho aqui, e o guia não finge que há.

Veja [Configuração](configuracao.md#turn) para `TUMACORD_TURN_REALM`,
`TUMACORD_TURN_SECRET` e `TUMACORD_TURN_PUBLIC_IP`.

---

## 8. A conta do dono

Abra `https://$TUMACORD_DOMINIO_CHAT` e crie a conta com exatamente o nome que
está em `TUMACORD_ADMIN_USERNAME`. Ela nasce dona.

**Verificação:** o ícone de escudo aparece na barra superior.

> A partir da 0.9.9-1, o nome configurado **não** promove uma conta nova a
> qualquer momento: ele decide quem nasce dono quando o servidor ainda não tem
> ninguém. Trocar a variável depois não transfere a propriedade — isso é uma
> operação autorizada, e está em [Configuração](configuracao.md).

---

## 9. Preparar a distribuição

Neste ponto o chat funciona, mas ainda não há atualizações publicadas. O
caminho está em [Publicação privada](publicacao-privada.md); o resumo:

1. gerar as chaves de assinatura **fora da VPS**, no ambiente de publicação;
2. registrar as chaves públicas no serviço;
3. importar a release e publicar o catálogo;
4. autorizar os dispositivos com convites de uso único.

Para autorizar o primeiro dispositivo:

```bash
cd "$TUMACORD_DIR"
node tools/tumacordctl/tumacordctl.mjs devices enroll --label "Windows do Caio"
```

**Saída esperada:** um convite, e o aviso de que ele vale uma vez e não é
mostrado de novo. Passe por canal privado — ele não deve ir para o chat que
ele mesmo atualiza.

---

## Credenciais: quem provisiona o quê

| Credencial | Onde vive | Quem provisiona | Para quê |
|---|---|---|---|
| deploy key de leitura | VPS, `~/.ssh/` do usuário do serviço | dono do repositório | `git clone` do código |
| credencial de leitura dos assets | ambiente de publicação | dono do repositório | baixar os binários da Release privada |
| chave privada de **manifesto** | ambiente de publicação, nunca na VPS | dono | assinar os pacotes |
| chave privada de **catálogo** | ambiente de publicação, nunca na VPS | dono | recomendar e retirar versões |
| `TUMACORD_SERVER_ACCESS_KEY` | `.env` da VPS, modo 600 | operador | entrar no chat |
| convite de dispositivo | gerado na VPS, entregue por canal privado | dono | autorizar um aplicativo a baixar |

**A senha pessoal do GitHub não entra em lugar nenhum desta tabela.** Uma
deploy key de leitura faz o trabalho do clone e pode ser revogada sozinha.

**As duas chaves de assinatura são separadas de propósito.** Quem pode retirar
uma versão do ar não precisa poder assinar um binário novo: uma chave de
catálogo comprometida esconde uma versão boa, uma de manifesto entrega código.
Não é o mesmo estrago.

---

## Quando algo falha

| Sintoma | Provável causa | O que fazer |
|---|---|---|
| `docker compose up` recusa citando variável | `.env` incompleto | o erro nomeia a variável; preencha |
| `doctor` diz que não achou instalação | rodou fora do diretório, ou o projeto tem outro nome | `--projeto <nome>`; veja `docker compose ls` |
| `doctor` acha mais de uma instalação | há outra na mesma máquina | `--projeto <nome>`. Ele não escolhe sozinho de propósito |
| `curl` da saúde não responde | o contêiner não subiu | `docker compose -p "$TUMACORD_PROJETO" logs tumacord-server` |
| `/v1/health` responde e `/v1/catalog` dá 401 | normal | o catálogo exige credencial de dispositivo |
| `/v1/catalog` responde **sem** credencial | o proxy está contornando a autorização | pare e confira o bloco do proxy |

Mais casos em [Solução de problemas](solucao-de-problemas.md).

---

## Onde continuar

- [Configuração](configuracao.md) — cada variável, o que ela faz, e o que muda se faltar
- [Publicação privada](publicacao-privada.md) — assinar, importar e publicar
- [Atualização do servidor](atualizacao-servidor.md) — trocar a versão em uso
- [Backup e restauração](backup-restore.md) — cópia consistente e restauração ensaiada
- [Versionamento](versionamento.md) — a convenção `0.9.9-1` e por que ela não é SemVer

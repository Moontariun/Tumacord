# Configuração

Cada variável que o Tumacord consome, o que ela faz, e o que muda se ela
faltar. Esta página é a fonte de verdade: `.env.example` traz as mesmas
variáveis, e nada é consumido sem estar aqui.

*Arquivo:* `.env`, no diretório do projeto, modo `600`.
*Quem lê:* o `docker compose` interpola o arquivo inteiro ao subir.

---

## Servidor dedicado

| Variável | Obrigatória | Padrão | O que faz | Se faltar |
|---|---|---|---|---|
| `TUMACORD_SERVER_ACCESS_KEY` | **sim** | — | a chave que o grupo digita para entrar | o `docker compose up` **recusa a subir**, citando a variável |
| `TUMACORD_ADMIN_USERNAME` | não | `Moontariun` | o nome que nasce dono quando o servidor ainda não tem ninguém | a primeira conta criada vira dona |
| `TUMACORD_TLS_CERT_FILE` | não | vazio | certificado, quando o servidor faz TLS sozinho | o servidor fala HTTP; use o proxy |
| `TUMACORD_TLS_KEY_FILE` | não | vazio | a chave do certificado | idem |

**Sobre `TUMACORD_ADMIN_USERNAME`:** ele decide quem nasce dono, e não promove
uma conta a qualquer momento. Trocar a variável depois **não** transfere a
propriedade — isso é uma operação autorizada, feita pelo painel.

Gere a chave de acesso com algo não adivinhável:

```bash
printf 'TUMACORD_SERVER_ACCESS_KEY=%s\n' "$(openssl rand -base64 24)" >> .env
```

---

## Serviço de atualizações

| Variável | Obrigatória | Padrão | O que faz |
|---|---|---|---|
| `TUMACORD_UPDATES_PORT` | não | `4300` | a porta pública, atrás do proxy |
| `TUMACORD_UPDATES_ADMIN_PORT` | não | `4301` | importar, publicar, retirar — **nunca** publicada para fora |
| `TUMACORD_UPDATES_STATE_DIR` | não | `/estado` | catálogo, manifestos, dispositivos, chaves confiáveis |
| `TUMACORD_UPDATES_STORAGE_DIR` | não | `/pacotes` | os bytes dos pacotes, fora de qualquer webroot |
| `TUMACORD_UPDATES_MAX_DOWNLOADS` | não | `6` | downloads simultâneos |

**Sobre o teto de downloads:** a VPS divide rede, CPU e disco com o chat e com
o TURN. Sem teto, um mutirão de atualização tira a call de todo mundo — e o
serviço existe justamente para não obrigar a escolher entre as duas coisas.

**Sobre a porta 4301:** ela fica em `127.0.0.1` no `docker-compose.yml`. O
`tumacordctl doctor` **falha** se ela estiver publicada para fora, porque isso
exporia importar, publicar e retirar no lugar mais exposto do sistema.

---

## TURN

O relay só entra quando nenhum caminho direto se forma. Ele é opcional e sobe
com o perfil: `docker compose --profile turn up -d coturn`.

| Variável | Obrigatória com o perfil | O que faz |
|---|---|---|
| `TUMACORD_TURN_URLS` | sim | o que o servidor anuncia aos clientes, ex.: `turn:updates.exemplo.com:3478` |
| `TUMACORD_TURN_SECRET` | sim | o segredo compartilhado que gera credenciais temporárias |
| `TUMACORD_TURN_REALM` | sim | o realm do coturn; use o domínio |
| `TUMACORD_TURN_PUBLIC_IP` | sim | o IP público da VPS; sem ele o relay anuncia o endereço interno |
| `TUMACORD_TURN_TTL_SECONDS` | não | validade da credencial temporária (padrão 28800) |

O servidor só anuncia TURN quando `TUMACORD_TURN_URLS` **e**
`TUMACORD_TURN_SECRET` existem. Sem elas a call continua funcionando por todo
caminho direto; o que se perde é a reserva.

### Portas do TURN

| Porta | Protocolo | Quando |
|---|---|---|
| 3478 | UDP e TCP | sempre, com o perfil ligado |
| 5349 | TLS | quando você configurar certificado para o coturn |
| 443 | — | **não**, nesta máquina |

**Por que a 443 não:** ela já é o HTTPS do proxy. Nginx com `proxy_pass` comum
não multiplexa TURN e HTTP no mesmo socket — essa é a inconsistência que o guia
anterior carregava. Se você precisa de TURN na 443 (redes que só liberam essa
porta), isso exige um **segundo IP** ou um multiplexador de protocolo na frente
dos dois. Não há atalho, e esta página não finge que há.

### Opções do coturn

As opções do `docker-compose.yml` são as da série **4.17**, que é a fixada.
Três que mudaram e quebram se copiadas de guias antigos:

- `--no-cli` — **removida**: na 4.17 o CLI já nasce desligado, e a opção antiga
  vira erro no log;
- `--no-dtls` — **removida**: DTLS só sobe com `--dtls`;
- `--no-loopback-peers` — **removida**: a 4.17 nega loopback por padrão e só
  aceita o inverso. Mantê-la fazia o turnserver imprimir o help e sair com 255,
  em laço de reinício. A proteção não se perde: `127.0.0.0/8` e `::1` estão nas
  faixas negadas.

**Renovação de certificado:** o coturn não recarrega o certificado sozinho.
Depois de uma renovação, reinicie-o:

```bash
docker compose -p "$TUMACORD_PROJETO" restart coturn
```

---

## Atualização automática do servidor

No `.env` do projeto:

| Variável | Padrão | O que faz |
|---|---|---|
| `TUMACORD_SELF_UPDATE` | `0` | permite o dono trocar a versão do servidor pelo painel |
| `TUMACORD_EXECUTOR_TOKEN` | vazio | o segredo do executor, tirado de `/var/lib/tumacord/executor/executor.token` |
| `COMPOSE_FILE` | comentada | `docker-compose.yml:docker-compose.executor.yml` monta o socket do executor no chat |

Na unidade systemd do executor (`packaging/servidor/tumacord-executor.service`):

| Variável | Exemplo | O que faz |
|---|---|---|
| `TUMACORD_PROJETO` | `tumacord` | qual instalação ele opera; nunca vem do pedido |
| `TUMACORD_EXECUTOR_STATE` | `/var/lib/tumacord/executor` | trabalhos, registro dos deployments e o segredo |
| `TUMACORD_EXECUTOR_SOCKET` | `/var/lib/tumacord/run/executor.sock` | onde o chat o encontra; recusado no ramo do estado |
| `TUMACORD_BACKUP_DIR` | `/var/lib/tumacord/backups` | a cópia antes de cada aplicação; vazio desliga a aplicação pelo painel |
| `TUMACORD_UPDATES_ADMIN` | `http://127.0.0.1:4301` | de onde ele lê o catálogo e o manifesto |

> **Importante, e o guia antigo errava aqui.** Ligar `TUMACORD_SELF_UPDATE`
> **não** torna uma instalação Docker autoatualizável. O contêiner não consegue
> reconstruir a si mesmo: quem faz isso é o **executor**, que roda no host. Sem
> o executor instalado, o painel mostra as versões e a aplicação falha.
>
> A instalação do executor está em [Atualização do servidor](atualizacao-servidor.md).

---

## O que nunca entra no `.env`

- chaves privadas de assinatura — elas vivem no ambiente de publicação, nunca
  na VPS;
- tokens de dispositivo — eles são gerados pelo serviço e guardados por hash;
- a senha pessoal do GitHub — o clone usa deploy key de leitura.

---

## Conferir a configuração

```bash
cd "$TUMACORD_DIR"
docker compose -p "$TUMACORD_PROJETO" config >/dev/null && echo "válida"
node tools/tumacordctl/tumacordctl.mjs doctor --project "$TUMACORD_PROJETO"
```

O `doctor` lista os **nomes** das variáveis definidas e nunca os valores: a
saída dele pode ser colada num relato de problema.

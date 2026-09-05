# Relatório da 0.8.2 — o relay fora do ar, e o relay como escolha

Duas coisas nesta versão: um defeito de produção que estava calado desde a
0.8.0, e uma mudança de política sobre quem decide usar o relay.

O que está aqui foi verificado no servidor de produção (`200.9.155.102`, Ubuntu
22.04, Docker 29.1.3) e em contêiner descartável na mesma máquina. O que não foi
verificado está dito como tal na seção 7.

## 1. O defeito

`docker ps -a` no servidor:

```
tumacord-turn   Restarting (255) 37 seconds ago   coturn/coturn:4.17-alpine
```

`docker inspect` dava `RestartCount=298`. A primeira linha de `docker logs`:

```
turnserver: unrecognized option: no-loopback-peers
```

O turnserver não ignora opção desconhecida: imprime o help inteiro e sai com
255. Com `restart: unless-stopped`, isso vira laço de reinício.

`--no-loopback-peers` foi **removido** do coturn. A 4.17 nega loopback por
padrão e só aceita a opção inversa, `--allow-loopback-peers` — confirmado no
`turnserver -h` da própria imagem:

```
--allow-loopback-peers   Allow peers on the loopback addresses (127.x.x.x and ::1).
--no-multicast-peers     Disallow peers on well-known broadcast addresses (...)
```

`--no-multicast-peers` continua existindo. Só a de loopback caiu.

## 2. Por que ninguém percebeu

Três coisas se somaram:

1. `restart: unless-stopped` reiniciava em silêncio. Sem olhar `docker ps`, não
   havia sinal;
2. `/api/health` respondia `"turn":true`. O servidor anuncia relay com base nas
   variáveis do `.env`, não em o relay estar de pé. **Ele distribuía credenciais
   para uma coisa que não existia**;
3. o relay é, por definição, último recurso. Quem tinha caminho direto — quase
   todo mundo — nunca chegou perto dele. Quem não tinha via a call não fechar,
   sem erro nenhum na tela.

O relay **nunca funcionou**. Na 0.8.0 e na 0.8.1 a imagem era
`coturn/coturn:4.6-alpine`, tag que não existe no Docker Hub (a numeração saltou
de 4.5 para 4.17): falhava antes, no `pull`. Corrigida a imagem, passou a falhar
no argumento. Não houve versão em que ele subisse.

## 3. Correções no `docker-compose.yml`

| Opção | O que houve | Ação |
| --- | --- | --- |
| `--no-loopback-peers` | removida do coturn | retirada |
| `--no-cli` | depreciada; CLI já nasce desligado | retirada |
| `--no-dtls` | depreciada; DTLS só sobe com `--dtls` | retirada |
| `--no-tls` | válida | mantida |
| `--no-multicast-peers` | válida | mantida |
| `--no-software-attribute` | marcada depreciada, ainda aceita | mantida |
| `${TUMACORD_TURN_*:?}` | derrubava `up` sem o perfil | virou `:-` |

As duas depreciadas saíram junto porque são o mesmo defeito um estágio antes: a
opção depreciada de hoje é a removida de amanhã.

A proteção contra loopback não se perdeu. Ela já estava explícita nas linhas
`--denied-peer-ip=127.0.0.0-127.255.255.255` e `--denied-peer-ip=::1`, e a 4.17
nega loopback por padrão.

Sobre a interpolação: o Compose interpola o arquivo inteiro antes de olhar para
os perfis, então `${VAR:?...}` dentro do serviço `coturn` derrubava
`docker compose up -d` de quem nunca pediu relay. Com `:-`, quem sobe o perfil
sem `.env` preenchido recebe o erro do coturn, que é específico.

Verificação, na mesma máquina, com os argumentos corrigidos:

```
INFO Coturn Version Coturn-4.17.2 'Gorst'
INFO Black listing: 127.0.0.0-127.255.255.255
INFO Black listing: ::1
```

## 4. O relay virou opt-in

Antes, um servidor com relay configurado fazia todo cliente usá-lo como último
recurso. Ninguém tinha pedido.

O relay é o único caminho em que a mídia passa por uma máquina de terceiro —
cifrada de ponta a ponta por DTLS-SRTP, mas passando, e gastando banda dela.
Quem precisa dele é a minoria que não fecha caminho direto: os dois lados em
CGNAT simétrico, sem IPv6. Decisão dessa minoria, e só para ela.

Nova preferência `turnEnabled`, padrão `false`, no mesmo caminho que
`stunEnabled` já usava:

| Arquivo | Papel |
| --- | --- |
| `desktop/network-preferences.cjs` | fonte da verdade, em disco |
| `src/lib/networkPreferences.ts` | espelho síncrono no renderer |
| `src/vite-env.d.ts` | tipo da ponte |
| `src/lib/iceServers.ts` | o portão: relay só entra com a chave ligada |
| `src/App.tsx` | a caixa, e o efeito que busca credencial |

Duas decisões que valem registro:

- **o portão fica em `iceServers()`**, e não só em quem busca a credencial,
  porque é por ali que toda `RTCPeerConnection` passa. Uma credencial obtida
  antes de desligar não vira candidato depois;
- **desligado, nada é buscado, e o que estava em mãos é esquecido na hora.**
  Credencial que não se pede é credencial que não existe; e desligar precisa
  valer no ato, não na próxima renovação.

Ligar não muda a ordem de nada: o ICE compara candidatos por prioridade, e um
par direto sempre vence um par por relay.

## 5. Testes

Sete testes novos. Três deles guardam o `docker-compose.yml`, e os três
**reprovam o arquivo da 0.8.1** — verificado trocando o arquivo e rodando:

```
✖ a imagem do relay usa uma tag que existe de verdade
✖ o relay não passa ao coturn nenhuma opção removida ou depreciada
✖ subir só o servidor não exige as variáveis do relay
```

Os outros quatro cobrem a preferência: o padrão desligado (`iceServers` e
`network-preferences`), a credencial em mãos não virando candidato com a chave
desligada, e o caso sem STUN e sem relay devolvendo lista vazia em vez de cair
no relay.

Suíte completa: **347 passam, 0 falham**. `npm run typecheck` limpo.

## 6. Atualizar

No servidor:

```bash
cd /home/Tumacord && git pull && docker compose --profile turn up -d
```

O `docker-compose.yml` é a única peça que muda para o relay. Nenhuma migração
de dados, nenhum volume tocado.

Confira depois:

```bash
docker ps --filter name=tumacord-turn --format '{{.Status}}'
docker logs tumacord-turn | head -3
ss -lnup | grep 3478
```

`Up`, sem `unrecognized option`, e algo escutando em 3478.

Para voltar atrás, `git checkout` da versão anterior e `up -d` de novo. O
cliente antigo continua funcionando contra o servidor novo: `turnEnabled`
ausente cai no padrão pela higienização, que é o mesmo `false`.

## 7. Implantação e verificação em produção

Implantado em `200.9.155.102` na mesma sessão. `docker compose v2` foi instalado
antes (`apt-get install docker-compose-v2`, 2.40.3), e adotou o projeto e o
volume que o v1 já usava — `tumacord` e `tumacord_tumacord-data` —, então nada
de dado foi recriado.

Depois de `git pull` e `docker compose --profile turn up -d --build`:

| Verificação | Resultado |
| --- | --- |
| `tumacord-turn` | `Up`, `RestartCount=0` (era 298) |
| Log do coturn | sem `unrecognized option`, sem ERRO de depreciada |
| Escuta | `200.9.155.102:3478`, UDP e TCP |
| Alcance pela internet | STUN Binding respondido de fora da máquina |
| `/api/health` | `version: 0.8.2` |
| **Alocação e relay reais** | `turnutils_uclient -y -n 10`: **0% de perda**, RTT médio 0,25 ms |

O último item é o que importa: uma alocação TURN autenticada pelo esquema
`use-auth-secret`, com tráfego atravessando o relay de ponta a ponta.

### Um susto que não era defeito

O primeiro teste de tráfego perdeu **100% dos pacotes**. A suspeita foi o bloco
de descoberta no log:

```
WARNING NO EXPLICIT RELAY ADDRESS(ES) ARE CONFIGURED
Relay address to use: 200.9.155.102
Relay address to use: 172.18.0.1
Relay address to use: 10.119.148.91
...
Total: 6 relay addresses discovered
```

Seis endereços, incluindo pontes do Docker e o IP privado. A hipótese era que
uma alocação pudesse cair em um deles e virar um relay que ninguém alcança.

**A hipótese está falsificada.** Doze alocações seguidas foram amostradas e
**todas** vieram em `200.9.155.102`: o coturn amarra o endereço de relay ao
endereço em que o cliente chegou. A perda vinha do cliente de teste, que sem
`-L` escolhia um endereço privado como origem — e endereço privado está na lista
de destinos proibidos, que é a proteção funcionando como projetado. Com `-L`
apontando para o IP público, a mesma configuração de produção dá 0% de perda.

Fica registrado porque o bloco de descoberta assusta quem for ler o log depois.
Não há ação a tomar.

## 8. O que continua sem verificação

- **duas pessoas reais em uma call passando pelo relay.** Exige dois pares sem
  caminho direto entre si; não dá para produzir a partir daqui. O que existe é
  a prova acima, que é do relay, não da call;
- **a caixa nas configurações com clique de verdade.** Ela é exercitada pelos
  testes de preferência, não pela interface;
- **o cliente desktop empacotado.** A build web foi refeita no contêiner e o
  servidor responde 0.8.2; o AppImage sai pelo workflow.

## 9. Risco conhecido

O `--no-software-attribute` está marcado `DEPRECATED` no help da 4.17, mas é
aceito. Ficou porque removê-lo faz o servidor anunciar a própria versão. É o
próximo candidato a virar `unrecognized option` — o teste-guarda da seção 5 vai
pegá-lo quando isso acontecer, desde que alguém rode a suíte antes de implantar.

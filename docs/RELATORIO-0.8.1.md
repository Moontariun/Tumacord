# Relatório da 0.8.1 — estabilidade de mídia e painel de administração

Base: `release/rendezvous-and-turn-v0.8.0` (commit `5ec8b80`).
Branch: `release/stability-and-admin-v0.8.1`.

Linha de base antes de qualquer alteração: **219 testes, typecheck ok, build ok**.
Estado ao final: **338 testes, typecheck ok, build ok**.

---

## 1. Arquitetura encontrada antes das alterações

Uma engine de mídia só. Existe **uma única** criação de `RTCPeerConnection` no
projeto inteiro (`src/hooks/useVoice.ts`), com `iceServers` vindo da mesma
função para todos os modos. O `iceServers: []` que se temia era o estado da
0.7.8 e já não existia.

Sinalização por Socket.IO, com a mesma superfície de eventos nos três modos; o
que muda é apenas a URL. O "adaptador de sinalização" desenhado no pedido já
existia de fato, sem nome.

Administração: dois endpoints (`/api/admin/overview`, `/api/admin/users/:id/disconnect`),
`isAdmin` derivado de uma variável de ambiente comparada a cada requisição, e
canal como `{ id, name, type }`.

## 2. Inconsistências P2P × servidor

Nenhuma na engine de mídia — confirmado por leitura e pela contagem de
construções de `RTCPeerConnection`. As inconsistências estavam **fora** dela:

- `TUMACORD_DIRECT_KEY` só existe no modo P2P, o que fazia o portão de acesso
  ficar inativo no servidor dedicado e deixava `/api/peer/attachments` aberto;
- a replicação de histórico rodava nos dois modos, embora só faça sentido no
  P2P;
- `channel:create` e `chat:sync:push` não verificavam papel em modo servidor.

## 3. Causa raiz do bug do microfone

**A hipótese inicial foi falsificada por medição.** Suspeitava-se de que o
cancelamento de eco do Chromium exigisse uma referência de reprodução já
aberta, e que abrir o Discord fornecesse isso sem querer.

`scripts/diagnose-microphone.cjs` mediu oito combinações em Fedora 44 /
PipeWire 1.6.8, com a fonte em `suspended` antes de cada captura: eco ligado e
desligado, com e sem saída ativa antes, com e sem filtro neural, e cinco ciclos
seguidos. **As oito capturaram sinal.** O nó do PipeWire sai de `suspended`
sozinho.

Captura e processamento estão, portanto, fora de suspeita nesta máquina. O que
sobrou foram as camadas seguintes — e nelas foram encontrados três defeitos
reais (seção 5), todos capazes de produzir exatamente o sintoma relatado.

**Não é possível afirmar qual deles causou o episódio específico** sem uma call
entre duas máquinas. O que se pode afirmar é que os três eram defeitos e que os
três produzem o sintoma.

## 4. Causa raiz dos bugs de live e rejoin

**Três laços diferentes** aplicavam faixas a peers — ao criar o enlace, ao
iniciar uma captura e ao trocar o microfone —, cada um com a própria regra de
`addTrack` contra `replaceTrack`. Qual caminho era tomado dependia de qual laço
chegasse primeiro, e por isso o segundo ciclo de live não se comportava como o
primeiro.

Somado a isso, `leave()` não zerava a saúde do microfone (seção 5), o que fazia
a chamada seguinte começar com o orçamento de recuperação já gasto.

## 5. Outros bugs encontrados

1. **Watchdog no contexto errado** — o caminho neural media a energia no
   medidor do próprio processamento, mas a checagem perguntava se o
   AudioContext *compartilhado* estava rodando. Com o compartilhado suspenso, a
   recuperação automática se desligava sozinha no caminho que é padrão.
2. **Faixa que nasce `muted`** — `onmute` marca a transição; se ela ocorreu
   antes de existir ouvinte, o caso ficava invisível.
3. **`ignoreOffer` travado** — desarmado só em dois caminhos de sucesso. Uma
   colisão sem resposta descartava **todo** candidato ICE seguinte daquele
   enlace, e ele chegava a `connected` sem mídia.
4. **Saúde do microfone sobrevivendo à saída** — orçamento gasto e marca de
   último sinal velha, causando recuperação desligada e recaptura espúria.
5. **`onOffer` criando enlace após a saída** — único handler sem a verificação
   que os outros já tinham; gerava `RTCPeerConnection` zumbi.
6. **`applyOrder` desfazendo a reordenação** — delegava a normalização, que
   reordenava pela posição antiga. Encontrado pelo próprio teste.
7. **Quatro furos de autorização** — seção 9.

## 6. Arquitetura de mídia depois

A engine continua única, como estava; não houve refactor cosmético.

O que foi acrescentado:

- `src/lib/peerMediaSync.ts` — uma pergunta, uma resposta: dado o estado local
  e os senders do enlace, quais ações aplicar. Reaproveita sender livre antes de
  criar, limpa sender preso a faixa morta, e distingue troca de dispositivo de
  abertura de trilha nova;
- `syncLocalMediaToPeer` — enlace novo reconstrói o estado **atual**, sem
  depender de ter presenciado o evento que o criou;
- reconciliação a cada dez segundos, aplicando apenas reparos que não mudam a
  topologia;
- `src/lib/mediaDiagnostics.ts` — seis camadas, apontando a primeira quebrada;
- `src/lib/iceDiagnostics.ts` — par ICE vencedor e resumo agregado sem endereço.

A camada de integração com o sistema (`pactl`, `pw-link`, `pw-dump`) continua
fora da engine, terminando em `MediaStream`. É o que permitirá Windows depois
sem tocar na lógica de peers.

## 7. Mudanças no painel administrativo

Quatro áreas: visão geral, canais, usuários e registro. Estados de carregando,
erro com "tentar de novo", vazio e sucesso em cada uma. Toda ação sem volta
pede confirmação **dizendo o que vai acontecer**. Segredos aparecem apenas como
configurados ou não.

## 8. Endpoints e eventos acrescentados

| Método | Rota |
| --- | --- |
| GET | `/api/admin/users` |
| POST | `/api/admin/users/:id/role` |
| DELETE | `/api/admin/users/:id` |
| GET | `/api/admin/audit` |
| POST | `/api/admin/channels` |
| PATCH | `/api/admin/channels/:id` |
| DELETE | `/api/admin/channels/:id` |
| POST | `/api/admin/channels/order` |
| POST | `/api/admin/categories` |
| PATCH | `/api/admin/categories/:id` |
| DELETE | `/api/admin/categories/:id` |
| POST | `/api/admin/categories/order` |

Evento novo: `server:channels`, difundido a cada mudança.
`/api/health` passou a declarar `capabilities`.

## 9. Modelo de permissões

`owner`, `admin`, `member`. Persistido com a conta.

- só dono mexe em dono;
- nenhuma operação pode zerar a contagem de donos;
- admin gerencia canais, categorias e membros;
- member não alcança nada administrativo.

Furos fechados: `channel:create` sem verificação · `chat:sync:push` injetando
canais · `/api/peer/attachments` sem sessão · login sem limite de tentativas ·
histórico P2P enviado ao servidor dedicado.

## 10. Migrações

- **Papéis**: `TUMACORD_ADMIN_USERNAME` elege o dono na primeira subida e
  depois perde o poder. Nome inexistente → conta mais antiga assume. Servidor
  vazio → primeira conta nasce dona.
- **Canais**: quem não tem posição recebe uma, na ordem em que já estava.
- **Categorias e auditoria**: listas novas, começam vazias.

Nenhuma remove dado. Todas gravam só se algo mudou.

## 11. Arquivos principais alterados

Novos: `server/roles.ts`, `server/channels.ts`, `server/audit.ts`,
`server/rateLimit.ts`, `src/lib/peerMediaSync.ts`, `src/lib/mediaDiagnostics.ts`,
`src/lib/iceDiagnostics.ts`, `src/lib/capabilities.ts`,
`src/components/AdminPanel.tsx`, `scripts/diagnose-microphone.cjs`, `docs/QA.md`.

Alterados: `src/hooks/useVoice.ts`, `src/lib/microphoneHealth.ts`,
`src/lib/rtcPolicy.ts`, `src/App.tsx`, `server/index.ts`, `server/store.ts`,
`shared/types.ts`, `README.md`, `CHANGELOG.md`.

## 12. Testes adicionados

`peerMediaSync` (14) · `mediaDiagnostics` (22) · `iceDiagnostics` (11) ·
`roles` (14) · `channels` (14) · `audit` (7) · `rateLimit` (8) ·
`capabilities` (6) · `adminApi.integration` (7) · `adminAuthorization.integration` (7)
· acréscimos em `microphoneHealth` e `rtcPolicy`.

## 13. Resultado dos testes

```
npm test      338 testes, 338 passando, 0 falhando
typecheck     ok
build         ok
```

Nenhum teste existente foi removido ou afrouxado. Três precisaram ser
corrigidos porque codificavam a suposição antiga de que não havia papéis.

## 14 e 15. Matrizes

Em `docs/QA.md`, com os marcadores definidos. Nada marcado como testado sem
execução.

## 16. Testes manuais ainda necessários

Tudo que atravessa a rede entre duas máquinas: microfone em call real, ciclo de
live com dois clientes, entrar durante a live, sair e voltar, reconexão da
sinalização, e o par ICE em cada modo. O painel de diagnóstico existe
justamente para essa sessão render evidência.

## 17. Riscos e limitações

- **A causa do episódio específico do microfone não está confirmada.** Três
  defeitos compatíveis foram corrigidos; qual agiu, só a call real dirá;
- a reconciliação periódica nunca foi executada contra uma call real;
- os laços de `attachStream` e `ensureMicrophone` não foram substituídos pelo
  planejador. Foi decisão consciente: eles carregam ajuste de bitrate,
  verificação de geração e rollback, e trocá-los sem poder testar uma call
  trocaria bugs conhecidos por desconhecidos. A reconciliação os cobre por
  convergência;
- o piso de sinal de 0,006 fica perto da saída do filtro neural em ambiente
  silencioso;
- perder a conta dona exige editar o JSON do volume para recuperar.

## 18. Compatibilidade

Cliente 0.8.1 em servidor 0.8.0: o painel avisa o que falta e por quê, em vez
de erro sem explicação. Cliente antigo em servidor 0.8.1: `isAdmin` continua
publicado, derivado do papel.

## 19, 20 e 21. Atualizar, atualizar o cliente e voltar atrás

Em `README.md`, seção "Atualizar um servidor existente", incluindo o backup do
volume e o aviso de que `docker compose down -v` apaga os dados e nunca é uma
atualização.

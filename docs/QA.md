# QA das releases

Este arquivo acumula a evidência de cada versão. **Cada seção é a evidência da
versão que a produziu** — as seções antigas não valem como validação de uma
entrega nova, e estão preservadas como foram escritas.

A seção corrente está no topo. Para operar hoje, comece pelo
[README](../README.md) e pelos guias em `docs/`.

Os marcadores são fixos, e nenhum é usado sem o que ele afirma:

- **TESTADO** — executado, com resultado observado;
- **ANALISADO** — verificado lendo o código, sem execução;
- **NÃO EXECUTADO** — o código existe e ninguém rodou. Vem sempre com o
  procedimento e o critério de aceite;
- **FALHOU** — executado e não passou;
- **NÃO IMPLEMENTADO** — não existe nesta entrega.

---

## 0.9.9-1 — revisão de manutenção

### Ambiente

| | |
|---|---|
| Sistema | CachyOS, Linux 7.2.3-1-cachyos |
| Node | v26.8.1 |
| npm | 12.0.2 |
| git | 2.55.0 |
| Docker | 29.7.2 |
| Docker Compose | 5.5.1 |
| PowerShell | **indisponível** neste ambiente |
| Windows | **indisponível** neste ambiente |
| Segunda máquina | **indisponível** neste ambiente |
| VPS | **não fornecida** nesta auditoria |

### Linha de base e resultado

| | Base (`v0.9.9`, commit `271f460`) | Esta entrega |
|---|---|---|
| Testes | **663** aprovados | **952** aprovados |
| Typecheck | limpo | limpo |
| `npm run build` | ok | ok (web, servidor e serviço de atualizações) |

> A linha de base foi medida nesta máquina, na tag `v0.9.9` exata, antes de
> qualquer alteração. Os 663 testes anteriores **não** cobriam os requisitos
> desta revisão. Os 289 casos novos cobrem o que ela acrescentou ou corrigiu;
> os que provam a correção de um defeito reprovam no código anterior.

### O que foi TESTADO

| Área | Evidência | Onde |
|---|---|---|
| Ordem de versões, vetores da convenção, inválidos, sufixos 2/10, limites, etiquetas | 18 casos | `tests/version.test.ts` |
| Adaptação CJS em dia com a fonte, e decidindo igual nos mesmos vetores | regera e compara | `tests/version.test.ts` |
| Versão numérica do Windows **contra o electron-builder real** | `0.9.9-1` dava `0.9.9.0`; agora dá `0.9.9.1` | `tests/version.test.ts` |
| Inscrição da live: enlace refeito reemite, intenção sobrevive, live nova exige nova escolha | 12 casos | `tests/liveSubscription.test.ts` |
| Tela não vaza para quem não assinou; fechar a live não é desfeito pela reconciliação | plano antigo e novo lado a lado | `tests/liveSubscription.test.ts` |
| Unicidade de conta: 6 pedidos simultâneos → 1 conta | medido nos dois caminhos: antigo cria 6, novo cria 1 | `tests/accountUniqueness.test.ts` |
| Reserva de nome sobrevive à remoção e ao reinício | 14 casos | `tests/accountUniqueness.test.ts` |
| Duplicatas legadas detectadas sem escolher vencedora, relatório sem hash | | `tests/accountUniqueness.test.ts` |
| Pausa de escrita: pendentes terminam, novas esperam, nada se perde | | `tests/accountUniqueness.test.ts` |
| Lançador do Windows: `EACCES` assíncrono tratado, falha síncrona tratada, sem duplo desfecho | 13 casos | `tests/windowsInstaller.test.ts` |
| Caminho do instalador não vira comando, verbo de elevação correto | | `tests/windowsInstaller.test.ts` |
| Contratos da distribuição: forma canônica, assinatura, escopo de chave, rotação, revogação | 28 casos | `tests/distribution.test.ts` |
| Catálogo vencido, repetido, torto; retirada que não vira downgrade | | `tests/distribution.test.ts` |
| Escolha de pacote por OS/arquitetura/formato; manifesto ambíguo não vira sorteio | | `tests/distribution.test.ts` |
| Serviço de atualizações, unidades: autorização, convites, Range, limites, estado | 31 casos | `tests/updateService.test.ts` |
| Serviço de atualizações, **de pé, por HTTP** | 15 casos | `tests/updateService.integration.test.ts` |
| **Cliente falando com o serviço privado, pela rede** | 15 casos | `tests/updateSource.integration.test.ts` |
| **O `Updater` do aplicativo, ligado ao serviço privado** | 8 casos | `tests/updaterPrivate.integration.test.ts` |
| ↳ procura, acha e baixa; inscrição por convite; sem credencial não procura | | idem |
| ↳ a sequência do catálogo é guardada e sobrevive ao reinício | | idem |
| ↳ versão retirada some da oferta e o motivo aparece | | idem |
| ↳ credencial revogada some do disco e a tela pede convite novo | | idem |
| ↳ sem chaveiro, a inscrição vale na sessão e isso é dito | | idem |
| ↳ **nenhum arquivo do caminho de atualização aponta para o GitHub** | | idem |
| **O ciclo inteiro: build → release assinada → publicada → app recebe** | 10 casos | `tests/publisher.integration.test.ts` |
| ↳ as notas saem do CHANGELOG e chegam assinadas ao aplicativo | | idem |
| ↳ a retirada publicada alcança o aplicativo | | idem |
| ↳ número publicado não vira conteúdo diferente; sequência sempre cresce | | idem |
| ↳ chave privada não vaza no documento público; gerar por cima é recusado | | idem |
| ↳ o estado do catálogo é recuperável, e importar um mais antigo é recusado | | idem |
| Reconhecimento de pacotes e montagem do catálogo | 21 casos | `tests/publisherPackages.test.ts` |
| ↳ ambiguidade **para** a publicação em vez de virar sorteio | | idem |
| ↳ o pacote da versão anterior na mesma pasta não entra nesta release | | idem |
| ↳ catálogo, manifesto e pacote sem tocar no GitHub | | idem |
| ↳ retomada real: cancela no meio, continua, e o SHA-256 remontado confere | | idem |
| ↳ chave desconhecida, catálogo repetido, catálogo vencido no relógio do cliente | | idem |
| ↳ manifesto que não é o que o catálogo prometeu; pacote trocado | | idem |
| ↳ credencial revogada, renovação, convite inventado, versão retirada | | idem |
| ↳ nenhuma rota de conteúdo anônima; HEAD e Range sob a mesma autorização | | idem |
| ↳ retomada em dois pedaços que remontam o arquivo com o mesmo SHA-256 | | idem |
| ↳ revogação corta na hora; retirada devolve 410 a quem já tinha a URL | | idem |
| ↳ nenhuma resposta devolve token, convite ou hash; nenhum redirect | | idem |
| ↳ quem assina catálogo não publica manifesto, e vice-versa | | idem |
| Descoberta de instalação estruturada; ambiguidade para a operação | 25 casos | `tests/tumacordctl.test.ts` |
| Preflight: sem mount em `/data` **falha** em vez de seguir sem backup | | `tests/tumacordctl.test.ts` |
| Valores de variáveis nunca saem da descoberta | | `tests/tumacordctl.test.ts` |
| Anexos: preferência do P2P não atravessa para o dedicado | 6 casos | `tests/attachmentSync.test.ts` |
| Criação de canal: socket e API produzem o mesmo canal, com posição e auditoria | integração com servidor real | `tests/adminAuthorization.integration.test.ts` |
| Cópia: o volume é o mount real de `/data`; sem mount ou com dois, **para** | 22 casos | `tests/executor.test.ts` |
| ↳ o token vai por ambiente e chega ao contêiner (`-e T`); nunca na linha de comando | | idem |
| ↳ o lock exclui entre processos; lock órfão é dito, e não removido | | idem |
| ↳ pedido repetido não vira segundo deploy; o trabalho sobrevive ao processo | | idem |
| ↳ segredo não entra no trabalho gravado nem no log | | idem |
| ↳ só release publicada é aplicável; validar compara versão, commit e `installationId` | | idem |
| **O executor de pé, num socket e numa porta** | 14 casos | `tests/executorService.integration.test.ts` |
| ↳ sem segredo nada sai; recusa escutar fora do laço local | | idem |
| ↳ socket no ramo do estado é recusado antes de criar arquivo; não apaga o que não é socket | | idem |
| ↳ nenhuma rota aceita comando, caminho ou URL; corpo grande demais é recusado | | idem |
| ↳ sem destino de cópia, a aplicação é recusada antes de qualquer conferência | | idem |
| **O painel do dono falando com um executor, por socket** | 17 casos | `tests/selfUpdate.test.ts` |
| ↳ só o `releaseId` atravessa; etiqueta malformada não gera consulta | | idem |
| ↳ depois de o servidor reiniciar, o painel retoma o trabalho do executor | | idem |
| ↳ executor fora do ar não declara a atualização como falha | | idem |
| Oferta de versões a partir do catálogo assinado, e não do GitHub | 18 casos | `tests/serverUpdate.test.ts` |
| O segredo do executor abre **só** a pausa de escrita, no servidor de verdade | 2 casos | `tests/adminAuthorization.integration.test.ts` |
| Documentação: links, arquivos, variáveis, serviços, versões; comandos, opções e campos citados existem | 13 casos | `tests/documentacao.test.ts` |
| `docker compose config` com e sem `docker-compose.executor.yml`; sem segredo, recusa dizendo de onde tirá-lo | validado | manual, nesta máquina |
| `npm run build` (web + servidor + serviço) | ok | manual, nesta máquina |
| `npm run package:linux` | produziu os dois pacotes com a revisão no nome | manual, nesta máquina |

**Pacotes de Linux produzidos e conferidos nesta máquina:**

| Arquivo | Tamanho | Conferência |
|---|---|---|
| `release/Tumacord-0.9.9-1.AppImage` | 126 419 499 B | ELF executável x86-64 |
| `release/tumacord-0.9.9-1.tar.gz` | 120 210 059 B | abre, 95 entradas, raiz `tumacord-0.9.9-1/` |

O nome do arquivo carrega a revisão — o que confirma, do lado do
empacotamento, que `0.9.9-1` não colide com `0.9.9`. Os pacotes **não** foram
instalados nem executados: isso exige uma máquina limpa e está na lista de
**NÃO EXECUTADO**.

### O que foi ANALISADO

| Item | Por que não foi executado |
|---|---|
| `native/windows/audio-helper/build.ps1` | não há PowerShell nesta máquina. O **script** é conferido por teste; a execução é Windows |
| Configuração do proxy (`packaging/proxy/`) | `nginx -t` exige Nginx instalado e certificados |
| Unidade systemd do executor | instalá-la exige o usuário `tumacord` e `/var/lib/tumacord` nesta máquina. O programa que ela chama é testado de pé, num socket |

### NÃO EXECUTADO — com procedimento e critério

Cada item abaixo tem o que fazer e o que observar. Enquanto eles não forem
executados, **o gate correspondente fica pendente**.

| Item | Procedimento | Critério de aceite |
|---|---|---|
| Instalação limpa numa VPS | [Instalação na VPS](instalacao-vps.md) | `doctor` sai 0; `/api/health` e `/v1/health` respondem; `/v1/catalog` dá 401 sem credencial |
| Atualização de instalação antiga com projeto/volume não padrão | [Atualização do servidor](atualizacao-servidor.md) | `version` e `commit` batem; `installationId` **inalterado** |
| Backup e restauração ensaiados | [Backup e restauração](backup-restore.md) | restauração em volume separado sobe e mostra o mesmo `installationId` |
| Falha e rollback | idem, seção 7 | volta ao deployment registrado, e a versão confirma |
| Publicação e importação offline | [Publicação privada](publicacao-privada.md) | catálogo promovido; aplicativo recebe a versão |
| Executor instalado, painel ligado por socket | [Atualização do servidor](atualizacao-servidor.md), "O executor" | o painel lista as versões do catálogo; aplicar gera um trabalho com `backup` e `validate` em `ok` |
| Aplicação que falha na validação | idem | o trabalho termina `failed` em `validate`, e `server rollback` volta ao deployment registrado |
| Cópia pelo executor, pausando a escrita do servidor real | [Backup e restauração](backup-restore.md) | a auditoria registra `executor` em `server.pause-writes` e `server.resume-writes` |
| Migração para uma segunda VPS | ainda sem runbook próprio | — |
| Windows: usuário comum e administrador, UAC aceito e cancelado | [Testar no Windows](windows-testing.md) | EACCES **não** derruba o app; UAC cancelado mantém o app aberto |
| Windows: arquivo bloqueado, caminho com espaço e acento, portable | idem | cada causa é distinguida na mensagem |
| Windows: instalação por máquina preservada | idem | escopo, appId, atalhos e dados no lugar |
| Linux: AppImage e instalação gerenciada | — | substituição depois da verificação; anterior preservado |
| Dedicado + Windows/Linux numa call | — | voz, câmera e tela funcionam entre os dois |
| P2P entre máquinas, troca de host, TURN | — | a live **não** cai na troca de host |
| Tráfego confirmando que live não assistida não recebe mídia | `chrome://webrtc-internals` | zero bytes de vídeo de tela para quem não assinou |
| Mute individual que não persistia | relato do usuário | mutar alguém vale quando ela entra na call depois |

### NÃO IMPLEMENTADO nesta entrega

| Item | Onde está dito |
|---|---|
| Identidade P2P com claims verificáveis | — |
| Runbook de migração de VPS | — |

> **A consequência prática:** o caminho de atualização do aplicativo **não
> passa mais pelo GitHub** — isso é verificado por teste, arquivo a arquivo, em
> código que roda. O aplicativo consulta a origem configurada nele, verifica
> assinatura e frescor, e baixa por identificador.
>
> A publicação também está fechada: `tools/publisher/` monta e assina os
> documentos a partir de uma pasta de build, e o ciclo inteiro — build, release
> assinada, importação, promoção, e o aplicativo recebendo e baixando — é
> exercido em `tests/publisher.integration.test.ts`.
>
> O executor que aplica uma release ao servidor dedicado também existe, e o
> painel do dono conversa com ele por socket. Ele **não** foi exercido contra
> uma VPS: os testes substituem o Docker e o git nas etapas que trocariam a
> versão de um servidor em uso.
>
> E a **ponte manual continua sendo o caminho para a primeira distribuição**:
> um aplicativo 0.9.9 instalado hoje não tem como receber a 0.9.9-1 pelo
> caminho novo, porque ele ainda é o aplicativo antigo. Quem está na 0.9.9
> instala a 0.9.9-1 à mão uma vez; da 0.9.9-1 em diante o caminho novo vale.

### Observações da execução

- **Instabilidade sob carga.** `tests/serverAuthority.integration.test.ts`
  reprovou uma vez (`apagar um canal de voz tira da call quem estava dentro`,
  15,8 s) numa execução da suíte completa e passou isolado e nas execuções
  seguintes. Os testes de integração sobem servidores reais, e a suíte ficou
  mais pesada com os novos. É contenção, não regressão — mas está registrado
  porque um teste instável esconde uma regressão no dia em que ela chegar.
  Na rodada final a suíte inteira passou de primeira: 952 casos, 29 s.
- **Defeitos achados antes de chegarem a uma VPS.** Três, no caminho novo, e
  cada um tem agora um teste que reprova se ele voltar: o `docker exec` da
  pausa não repassava o token ao contêiner (`-e T`), e a pausa falharia em toda
  instalação; a aplicação declarava uma cópia prévia que não fazia; e o chat,
  dentro do contêiner, não alcançaria um executor escutando no `127.0.0.1` do
  host — por isso a conversa passou a ser por socket.

### Funções que não podiam regredir

Verificadas pela suíte existente, que continua inteira: login e identidade,
chat e histórico, editar e excluir, anexos autorizados, sessões, voz, mute,
deafen, câmera, tela e áudio de tela, convites, dono e papéis, persistência e
handoff P2P. **952 aprovados, nenhuma falha.**

---


## Evidência das versões anteriores

> **Daqui para baixo é histórico.** Cada seção é a evidência da versão que a
> produziu, preservada como foi escrita, com o ambiente e os marcadores
> daquela época. **Nada abaixo vale como validação da 0.9.9-1** — o que vale
> para esta entrega está na seção acima.
>
> Os marcadores antigos (`TESTADO AUTOMATICAMENTE`, `VALIDADO POR ANÁLISE`,
> `IMPLEMENTADO — REQUER TESTE MANUAL`) correspondem aos atuais `TESTADO`,
> `ANALISADO` e `NÃO EXECUTADO`.

### Experimento do microfone — executado (0.8.1)

Instrumento: `node scripts/diagnose-microphone.cjs`. Abre uma janela Electron
invisível, captura o microfone e mede a energia que realmente entra. Nada é
gravado: só a energia agregada.

Executado em **Fedora 44, KDE/Wayland, PipeWire 1.6.8, USB PnP Sound Device**,
com o microfone ocioso e a fonte em `suspended` antes de cada medição.

| Cenário | Cancelamento de eco | Saída de áudio antes | Filtro neural | Resultado |
| --- | --- | --- | --- | --- |
| A | ligado | não | não | **COM SINAL** (RMS máx. 0,024) |
| B | desligado | não | não | **COM SINAL** (0,031) |
| C | ligado | sim | não | **COM SINAL** (0,025) |
| D | desligado | sim | não | **COM SINAL** (0,015) |
| E | ligado | não | **sim** | **COM SINAL** (saída 0,007) |
| G | ligado | não | não | **COM SINAL nos 5 ciclos** |
| H | ligado | não | **sim** | **COM SINAL nos 5 ciclos** |

### O que isso derruba

A hipótese de que o cancelamento de eco do Chromium precisaria de uma
referência de reprodução já aberta — que seria o que abrir o Discord fornece
sem querer — **está falsificada**. O cenário A é exatamente essa condição e
capturou sinal normalmente. A × C não mostram diferença.

Também está descartado que o PipeWire deixe a fonte inutilizável quando
suspensa: o nó saiu de `suspended` para `idle` sozinho na captura.

E repetir a captura cinco vezes no mesmo processo não degrada nada, com ou sem
filtro neural.

### O que isso deixa de pé

Captura e processamento estão saudáveis nesta máquina. Restam as camadas
seguintes — **track, sender, peer** —, que é exatamente onde viviam os três
laços divergentes de aplicação de faixas, agora substituídos pelo planejador
único e pela reconciliação periódica.

Confirmar isso exige uma call real entre duas máquinas: nenhum experimento
local chega até a camada `peer`.

### Observação de calibragem

O filtro neural atenua o ruído ambiente de ~0,025 para ~0,005 de RMS — é o
trabalho dele. Isso deixa a saída perto do piso de 0,006 que o aplicativo usa
para decidir "tem sinal". A checagem de saúde mede a **entrada** no caminho
neural, então não há falso positivo; mas o piso é apertado e vale revisitar se
aparecerem recapturas sem motivo.

---

### Mídia — requer duas máquinas

Rodar cada bloco pelo menos **três vezes**. "Funcionou uma vez" não conta.

### Microfone

- [ ] entrar na call com microfone — o outro escuta
- [ ] entrar mudo e ativar depois
- [ ] mute/unmute dez vezes seguidas
- [ ] trocar de microfone durante a call
- [ ] escolher "Padrão do sistema" e trocar o padrão no sistema
- [ ] desconectar o microfone USB durante a call
- [ ] reconectar o mesmo microfone
- [ ] abrir o Discord durante a call e fechar depois

### Live

- [ ] `start → stop → start → stop → start` sem reiniciar o app
- [ ] A transmite, B entra **depois** — B recebe
- [ ] B sai durante a live e volta — B volta a receber
- [ ] A sai da call e volta, e transmite de novo
- [ ] live com áudio, depois live sem áudio
- [ ] trocar o perfil de qualidade durante a live

### Sinalização

- [ ] derrubar a rede de B por 30 s e devolver
- [ ] reiniciar o servidor dedicado durante uma call
- [ ] host sai no modo P2P e outro assume

### Caminho ICE

Conferir em cada modo qual par venceu (o app registra em `[webrtc]`):

- [ ] P2P na mesma rede → esperado `host`
- [ ] servidor dedicado, redes diferentes → esperado `srflx`
- [ ] com TURN e UDP bloqueado → esperado `relay`

---

### Matriz de mídia

A mesma engine serve os três modos — existe **uma única** criação de
`RTCPeerConnection` no projeto, com a mesma configuração ICE. O que muda entre
os modos é só a URL da sinalização. Por isso a coluna não altera o
comportamento da mídia, e o que precisa de teste manual precisa nos três.

| | P2P | Dedicado | Dedicado + TURN |
| --- | --- | --- | --- |
| Microfone inicial | REQUER TESTE MANUAL | REQUER TESTE MANUAL | REQUER TESTE MANUAL |
| Mute/unmute | REQUER TESTE MANUAL | REQUER TESTE MANUAL | REQUER TESTE MANUAL |
| Recuperação do microfone | VALIDADO POR ANÁLISE | VALIDADO POR ANÁLISE | VALIDADO POR ANÁLISE |
| Troca de microfone | TESTADO AUTOMATICAMENTE¹ | TESTADO AUTOMATICAMENTE¹ | TESTADO AUTOMATICAMENTE¹ |
| Câmera | REQUER TESTE MANUAL | REQUER TESTE MANUAL | REQUER TESTE MANUAL |
| Live start | REQUER TESTE MANUAL | REQUER TESTE MANUAL | REQUER TESTE MANUAL |
| Live stop/start ×5 | TESTADO AUTOMATICAMENTE¹ | TESTADO AUTOMATICAMENTE¹ | TESTADO AUTOMATICAMENTE¹ |
| Entrar durante a live | TESTADO AUTOMATICAMENTE¹ | TESTADO AUTOMATICAMENTE¹ | TESTADO AUTOMATICAMENTE¹ |
| Sair e voltar | VALIDADO POR ANÁLISE | VALIDADO POR ANÁLISE | VALIDADO POR ANÁLISE |
| Reconexão da sinalização | REQUER TESTE MANUAL | REQUER TESTE MANUAL | REQUER TESTE MANUAL |
| Caminho ICE registrado | TESTADO AUTOMATICAMENTE¹ | TESTADO AUTOMATICAMENTE¹ | TESTADO AUTOMATICAMENTE¹ |

¹ A **lógica** é testada de forma determinística, sem WebRTC: o planejador de
faixas, o diagnóstico por camada e a leitura do par ICE são funções puras sobre
um retrato do estado. O que nenhum teste local alcança é a camada `peer`, que
exige duas máquinas em redes diferentes.

### Matriz administrativa

| | Estado |
| --- | --- |
| Criar canal de texto | TESTADO AUTOMATICAMENTE |
| Criar canal de voz | TESTADO AUTOMATICAMENTE |
| Editar canal | TESTADO AUTOMATICAMENTE |
| Excluir canal | TESTADO AUTOMATICAMENTE |
| Último canal de texto protegido | TESTADO AUTOMATICAMENTE |
| Reordenar canais | TESTADO AUTOMATICAMENTE |
| Categorias: criar, renomear, excluir | TESTADO AUTOMATICAMENTE |
| Apagar categoria não apaga canal | TESTADO AUTOMATICAMENTE |
| Gerenciar usuários | TESTADO AUTOMATICAMENTE |
| Proteção do último dono | TESTADO AUTOMATICAMENTE |
| Admin não promove a dono | TESTADO AUTOMATICAMENTE |
| Autorização no backend | TESTADO AUTOMATICAMENTE |
| Registro de auditoria, com recusas | TESTADO AUTOMATICAMENTE |
| Persistência entre reinícios | TESTADO AUTOMATICAMENTE |
| Atualização em tempo real na tela | IMPLEMENTADO — REQUER TESTE MANUAL |
| Painel em servidor 0.8.0 (capabilities) | TESTADO AUTOMATICAMENTE (lógica) |

---

### Autorização — já executado

| Item | Estado |
| --- | --- |
| Usuário comum não cria canal | TESTADO AUTOMATICAMENTE |
| Sincronização não injeta canais | TESTADO AUTOMATICAMENTE |
| Anexo entre pares exige sessão fora da rede local | TESTADO AUTOMATICAMENTE (política) |
| Limite de tentativas de login | TESTADO AUTOMATICAMENTE |
| Histórico P2P não vai para servidor dedicado | VALIDADO POR ANÁLISE |

---

### Atualização pelo aplicativo — 0.9.0

A parte que decide — qual versão oferecer, se ela foi retirada, qual arquivo
serve para cada jeito de instalação — roda sem rede e sem disco e está coberta
por teste. A parte que aplica foi exercitada contra um disco de verdade, em
pasta temporária, nos caminhos do Linux. **O que nenhum teste daqui prova é o
Windows**: nem o instalador NSIS abrindo, nem o portable sendo trocado.

| Item | Estado |
| --- | --- |
| 0.8.9 nunca é oferecida, e quem está nela é avisado | TESTADO AUTOMATICAMENTE |
| Marcador nas notas retira uma versão que a cópia não conhecia | TESTADO AUTOMATICAMENTE |
| 0.8.10 > 0.8.9 na comparação de versão | TESTADO AUTOMATICAMENTE |
| Cada tipo de instalação recebe o arquivo certo | TESTADO AUTOMATICAMENTE |
| Só `https` e só GitHub para baixar | TESTADO AUTOMATICAMENTE |
| Nome de arquivo baixado não escapa da pasta | TESTADO AUTOMATICAMENTE |
| Linux gerenciado: pasta nova, troca do atalho, `previous` preservado | TESTADO AUTOMATICAMENTE (disco real) |
| AppImage substituído no lugar | TESTADO AUTOMATICAMENTE (disco real) |
| Portable novo guardado ao lado do que roda | TESTADO AUTOMATICAMENTE |
| "O que mudou" aparece uma vez e fica marcado no disco | TESTADO AUTOMATICAMENTE |
| SHA-256 conferido antes de aplicar | VALIDADO POR ANÁLISE |
| Instalador do Windows abre e o app fecha para ele | IMPLEMENTADO — REQUER TESTE MANUAL |
| Reabrir na versão nova pelo atalho `current` | IMPLEMENTADO — REQUER TESTE MANUAL |
| Atualizar com uma call aberta sem interromper a call | IMPLEMENTADO — REQUER TESTE MANUAL |
| Consulta ao GitHub na abertura, sem atrasar a janela | IMPLEMENTADO — REQUER TESTE MANUAL |

### Mensagens, som, servidor e o que saiu — 0.9.9

| Item | Estado |
| --- | --- |
| Editar chega a todo mundo e o texto novo é o que fica | TESTADO AUTOMATICAMENTE (servidor real) |
| Apagar deixa lápide, e a lápide não carrega texto nem anexo | TESTADO AUTOMATICAMENTE (servidor real) |
| Ninguém edita nem apaga a mensagem de outra pessoa | TESTADO AUTOMATICAMENTE (servidor real) |
| P2P: a cópia antiga não ressuscita o que foi apagado | TESTADO AUTOMATICAMENTE (servidor real, em modo P2P) |
| P2P: exclusão feita offline alcança quem ainda tinha a mensagem | TESTADO AUTOMATICAMENTE (servidor real, em modo P2P) |
| P2P: edição feita offline vence o texto guardado, e o inverso não | TESTADO AUTOMATICAMENTE (servidor real, em modo P2P) |
| No P2P a identidade de quem edita é o apelido, não o id | TESTADO AUTOMATICAMENTE (modelo) |
| Empate de revisão e horário resolve a favor de apagar | TESTADO AUTOMATICAMENTE (modelo) |
| Editar e apagar pela interface, com a confirmação | TESTADO NO APLICATIVO (servidor dedicado real) |
| Prévia da imagem antes de qualquer upload | IMPLEMENTADO — REQUER TESTE MANUAL (depende de escolher arquivo) |
| Entrar no app não entra na call | TESTADO NO APLICATIVO (sessão restaurada, nenhuma call aberta) |
| A call retomada não é guardada no chaveiro | TESTADO AUTOMATICAMENTE (armazenamento simulado) |

**Atualizar o servidor pelo painel**

| Item | Estado |
| --- | --- |
| Só o dono; administrador é recusado | TESTADO AUTOMATICAMENTE (servidor real) |
| Desligado por padrão, com o motivo dito | TESTADO AUTOMATICAMENTE (servidor real) |
| A tentativa é registrada antes de acontecer | TESTADO AUTOMATICAMENTE (servidor real) |
| Corpo sem etiqueta de texto é recusado na porta | TESTADO AUTOMATICAMENTE (servidor real) |
| Só a forma `vX.Y.Z` é aceita; branch, caminho e comando não | TESTADO AUTOMATICAMENTE (modelo) |
| Etiqueta bem formada que não está publicada é recusada | TESTADO AUTOMATICAMENTE (modelo) |
| Versão retirada aparece na lista, dita, e não é aplicável | TESTADO AUTOMATICAMENTE (modelo) |
| A escolha padrão é a mais nova acima da atual, nunca um passo atrás | TESTADO AUTOMATICAMENTE (modelo) |
| Sem `scripts/` ou sem `.git`, recusa antes do backup | TESTADO AUTOMATICAMENTE (modelo) |
| A lista de versões chega do GitHub e aparece no seletor | TESTADO NO APLICATIVO (servidor real, com o recurso ligado) |
| **Aplicar de verdade uma versão** | **REQUER TESTE MANUAL** — nenhum caso executa o script, e executá-lo trocaria o código desta cópia |
| Reinício do servidor no meio da atualização | REQUER TESTE MANUAL |

**Sons**

Medidos no aplicativo, com um analisador no mesmo ponto em que os sons entram
na mistura. Pico e RMS por evento, com o volume de feedback em 80%:

| Evento | Pico | RMS |
| --- | --- | --- |
| connect | 0,298 | 0,0562 |
| callJoin | 0,320 | 0,0518 |
| callLeave | 0,201 | 0,0426 |
| peerJoin | 0,166 | 0,0251 |
| peerLeave | 0,140 | 0,0215 |
| message | 0,132 | 0,0211 |
| messageSent | 0,097 | 0,0107 |
| notification | 0,167 | 0,0272 |
| error | 0,244 | 0,0403 |
| mute | 0,163 | 0,0209 |
| unmute | 0,173 | 0,0223 |
| deafen | 0,219 | 0,0266 |
| undeafen | 0,175 | 0,0278 |
| streamStart | 0,267 | 0,0468 |
| streamStop | 0,216 | 0,0323 |
| host | 0,233 | 0,0502 |
| update | 0,167 | 0,0296 |

Nenhum passa de 0,32 de pico, então nada satura. A diferença que sobra é de
propósito: os eventos frequentes e leves ficam entre 0,021 e 0,028 de RMS, os
acontecimentos entre 0,032 e 0,056, e `messageSent` é o mais discreto de todos.
Na primeira medição ele saía a 0,003 — sete vezes abaixo de `message`, na
prática inaudível — e `connect` a 0,076, três vezes e meia acima do resto; os
dois foram corrigidos e remedidos.

O que **não** foi medido é o timbre, que não tem número: ele foi construído
(parciais, envelope, ruído de ataque, cauda) e julgado de ouvido.

**O que saiu**

| Item | Estado |
| --- | --- |
| Nenhuma referência a telestração em código, teste ou empacotamento | TESTADO AUTOMATICAMENTE (a suíte compila e passa sem os arquivos) |
| A mesa de desenho compartilhada continua inteira | TESTADO AUTOMATICAMENTE (18 casos contra servidor real) |
| A janela sobreposta do Windows não é mais aberta por nada | VALIDADO POR ANÁLISE (o IPC e o módulo saíram) |

### Entrada reformulada e contas guardadas — 0.9.8

| Item | Estado |
| --- | --- |
| Sair de uma conta P2P convertida da gaveta antiga não a traz de volta | TESTADO AUTOMATICAMENTE (armazenamento simulado) |
| "Esquecer tudo" depois da conversão não ressuscita a gaveta antiga | TESTADO AUTOMATICAMENTE (armazenamento simulado) |
| A gaveta antiga continua no disco: só a conversão acontece uma vez | TESTADO AUTOMATICAMENTE (armazenamento simulado) |
| Descartar desfaz só o que aquela tentativa de recuperação escreveu | TESTADO AUTOMATICAMENTE (armazenamento simulado) |
| Sair enquanto a recuperação do P2P está no ar | VALIDADO POR ANÁLISE (a corrida é estreita e não foi provocada) |
| Duas colunas cabem sem rolagem (1280 × 800, servidor + duas contas) | TESTADO NO NAVEGADOR (860 × 448 px, era 420 × 1325 px) |
| Cadastro cabe sem rolagem na mesma janela | TESTADO NO NAVEGADOR (860 × 523 px, era 420 × 1406 px) |
| Coluna única abaixo de 880 px de largura | TESTADO NO NAVEGADOR (520 px: empilha e rola) |
| "x" com confirmação esquece o destino e persiste | TESTADO NO NAVEGADOR (chaveiro relido depois do clique) |
| Foto do perfil na conta guardada | TESTADO NO NAVEGADOR (imagem servida pelo endereço do destino) |
| Cada conta guardada diz se é P2P ou de servidor dedicado | TESTADO AUTOMATICAMENTE (etiqueta) + TESTADO NO NAVEGADOR |
| O nome padrão do servidor embutido não vira nome de grupo | TESTADO AUTOMATICAMENTE (etiqueta) |
| Faixa de portas dos testes fora da faixa efêmera do sistema | TESTADO AUTOMATICAMENTE (lido de `ip_local_port_range`) |
| A reprovação intermitente "servidor encerrou (1)" acabou | **NÃO PROVADO** — ela é intermitente, e só o CI pode dizer |
| Foto vinda do que este computador já baixou, com o host desligado | IMPLEMENTADO — REQUER TESTE MANUAL (exige o app instalado) |
| Inicial no lugar da foto quando nenhum candidato responde | TESTADO NO NAVEGADOR |

O que foi medido na tela foi lido no navegador, com o modo servidor dedicado e
duas contas guardadas. O caminho da foto pelo cache local só existe no
aplicativo instalado — no navegador ele nem é tentado — e por isso está dito
como pendente.

### Live por escolha explícita — 0.9.7

| Item | Estado |
| --- | --- |
| Pedido de assistir só atravessa dentro da mesma call | TESTADO AUTOMATICAMENTE (servidor real) |
| Quem está fora da call não alcança quem transmite | TESTADO AUTOMATICAMENTE (servidor real) |
| Parar de assistir é dito a quem transmite | TESTADO AUTOMATICAMENTE (servidor real) |
| Consentimento é por transmissão, não por pessoa | VALIDADO POR ANÁLISE (a comparação é pelo id da transmissão) |
| Quem entra no meio da live recebe o anúncio | VALIDADO POR ANÁLISE (`syncLocalMediaToPeer` envia a meta sem as faixas) |
| Inscrição some quando a transmissão termina | VALIDADO POR ANÁLISE |
| **Mídia não sai da máquina de quem transmite antes do "sim"** | **REQUER TESTE EM DUAS MÁQUINAS** |
| Renegociação ao assinar e ao cancelar | REQUER TESTE EM DUAS MÁQUINAS |
| Áudio da live separado da voz depois da mudança | REQUER TESTE EM DUAS MÁQUINAS |
| Reconexão no meio de uma live assinada | REQUER TESTE EM DUAS MÁQUINAS |

Nada nesta tabela marcado como testado envolve WebRTC entre computadores: o que
foi exercitado aqui é a sinalização, contra um servidor de verdade. A metade de
mídia — as faixas entrando e saindo do enlace — depende de duas máquinas e está
dita como pendente.

### Chaveiro de contas e convites — 0.9.6

| Item | Estado |
| --- | --- |
| Entrar em um destino não apaga o que os outros lembram | TESTADO AUTOMATICAMENTE (chaveiro) |
| Trocar de conta mantém a conta guardada | TESTADO NO APLICATIVO (aparece em "Continuar em") |
| Retomar conta guardada sem digitar nada | TESTADO NO APLICATIVO |
| Sair da conta encerra só aquela | TESTADO NO APLICATIVO + chaveiro |
| Esquecer um destino leva sessão e chave dele | TESTADO AUTOMATICAMENTE (chaveiro) |
| As quatro combinações de lembrar sessão e chave | TESTADO AUTOMATICAMENTE (chaveiro) |
| Chave de servidor separada da chave de convite P2P | TESTADO AUTOMATICAMENTE (migração do campo antigo) |
| Sessão da gaveta única anterior é convertida, não perdida | TESTADO AUTOMATICAMENTE |
| Convite reaproveita sessão do destino, sem senha | VALIDADO POR ANÁLISE (`enterInvitedCall`) |
| Convite para destino novo não apaga contas guardadas | VALIDADO POR ANÁLISE + login falho não esvaziou o chaveiro no app |
| Login falho não esvazia o chaveiro | TESTADO NO APLICATIVO |
| Chave guardada volta ao campo mascarado | IMPLEMENTADO — REQUER TESTE MANUAL |
| Dois servidores dedicados no app real | REQUER TESTE MANUAL (a CSP do cliente web bloqueia origem cruzada; no desktop não há essa restrição) |
| Armazenamento nativo protegido para a chave | FORA DESTA VERSÃO |
| Instabilidade conhecida: "revogar bloqueia as próximas operações" reprovou 1 vez em 4 rodadas da suíte completa, e passa sempre isolado | EM OBSERVAÇÃO |
| Procurar continua disponível com versão já encontrada | VALIDADO POR ANÁLISE (fases em que o botão aparece) |
| Quem está muito atrás recebe direto a mais nova | TESTADO AUTOMATICAMENTE |
| Parada obrigatória é oferecida antes da mais nova | TESTADO AUTOMATICAMENTE |
| Parada já passada não segura mais ninguém | TESTADO AUTOMATICAMENTE |
| Parada quebrada não prende num degrau ruim | TESTADO AUTOMATICAMENTE |
| Download válido sobrevive a procurar de novo | VALIDADO POR ANÁLISE |
| Marcador do resumo chega ao aplicativo | TESTADO AUTOMATICAMENTE (era removido antes de chegar) |

### Isolamento por origem e notas resumidas — 0.9.5

| Item | Estado |
| --- | --- |
| Dois servidores dedicados não compartilham cache | TESTADO AUTOMATICAMENTE (servidor real) |
| Dedicado e P2P não compartilham cache | TESTADO AUTOMATICAMENTE (identidade e servidor real) |
| Cache local não é servido como histórico do grupo | TESTADO AUTOMATICAMENTE (servidor real) |
| Cache exige origem: sem ela nada entra nem sai | TESTADO AUTOMATICAMENTE (servidor real) |
| Instalação declara identidade estável e única | TESTADO AUTOMATICAMENTE (dois servidores reais) |
| Identidade sobrevive à troca de endereço | TESTADO AUTOMATICAMENTE |
| Grupo P2P continua o mesmo na troca de host | TESTADO AUTOMATICAMENTE |
| Histórico anterior não é apagado | VALIDADO POR ANÁLISE (nada remove `store.messages`) |
| Histórico anterior não chega a quem vem de fora | VALIDADO POR ANÁLISE (`readableMessages` filtra por origem da conexão) |
| Histórico anterior continua visível nesta máquina | IMPLEMENTADO — REQUER TESTE MANUAL |
| Aviso de versão mostra resumo curto | TESTADO AUTOMATICAMENTE (leitor) + conferido no texto da 0.9.5 |
| Versão sem resumo mostra o texto inteiro | TESTADO AUTOMATICAMENTE |
| Troca P2P → dedicado → outro dedicado → P2P no app real | IMPLEMENTADO — REQUER TESTE MANUAL |

### Autoridade do servidor dedicado — 0.9.4

| Item | Estado |
| --- | --- |
| Conta comum não insere mensagem assinada por outra | TESTADO AUTOMATICAMENTE (servidor real) |
| Conversa de grupo P2P não entra no dedicado | TESTADO AUTOMATICAMENTE (servidor real) |
| Perfil não é definido por pacote de replicação no dedicado | TESTADO AUTOMATICAMENTE (servidor real) |
| Perfil pelo caminho certo (`PUT /api/profile`) continua chegando a todos | TESTADO AUTOMATICAMENTE (servidor real) |
| Mídia de perfil sem dono não é servida | TESTADO AUTOMATICAMENTE (servidor real) |
| P2P: replicação preserva histórico na troca de host | TESTADO AUTOMATICAMENTE (servidor P2P real) |
| P2P: cópia antiga de perfil não substitui a nova | TESTADO AUTOMATICAMENTE (servidor P2P real) |
| Limite da call aplicado na entrada | TESTADO AUTOMATICAMENTE (servidor real) |
| Administração entra em call cheia | TESTADO AUTOMATICAMENTE (servidor real) |
| Vaga liberada quando alguém sai | TESTADO AUTOMATICAMENTE (servidor real) |
| Canal apagado tira da call quem estava dentro | TESTADO AUTOMATICAMENTE (servidor real) |
| Aviso de remoção chegando na interface | IMPLEMENTADO — REQUER TESTE MANUAL |
| Cache local separado por origem (Prioridade 1-A) | FORA DESTA VERSÃO |

### Traço e exclusão de mesas — 0.9.3

| Item | Estado |
| --- | --- |
| Arrasto no ritmo de uma mão produzia um ponto | REPRODUZIDO (servidor real, 1 operação de 1 ponto) |
| O mesmo arrasto depois da correção | TESTADO NO APLICATIVO (1 traço, 14 pontos, trajeto inteiro) |
| Confirmação no meio do arrasto não encerra o traço | TESTADO AUTOMATICAMENTE (6 casos) |
| Excluir pede confirmação e diz o que não alcança | TESTADO NO APLICATIVO |
| Quem não gerencia não exclui | TESTADO AUTOMATICAMENTE (servidor real) |
| Exclusão sobrevive ao reinício do servidor | TESTADO AUTOMATICAMENTE (servidor reiniciado) |
| Mesa excluída não aceita entrada nem desenho | TESTADO AUTOMATICAMENTE (servidor real) |
| Devolução na troca de host não ressuscita a excluída | TESTADO AUTOMATICAMENTE (servidor P2P real) |
| Mesa some da lista de quem está no canal | TESTADO NO APLICATIVO |
| Mensagem do teto global fala em excluir | VALIDADO POR ANÁLISE |
| Traço com caneta física e pressão | FORA DESTA VERSÃO |
| Arrasto com dois clientes desenhando ao mesmo tempo | IMPLEMENTADO — REQUER TESTE MANUAL |

### Bandeja, mesa e atualização — 0.9.2

| Item | Estado |
| --- | --- |
| Fechar a janela esconde em vez de encerrar | TESTADO AUTOMATICAMENTE (política) |
| Sair pelo menu da bandeja encerra de verdade | TESTADO AUTOMATICAMENTE (política) |
| Sair nunca fica desabilitado com a janela escondida | TESTADO AUTOMATICAMENTE (política) |
| No macOS fechar a janela continua fechando a janela | TESTADO AUTOMATICAMENTE (política) |
| Ícone aparecendo no painel do KDE e restaurando a janela | IMPLEMENTADO — REQUER TESTE MANUAL |
| Call e live continuam vivas com a janela escondida | IMPLEMENTADO — REQUER TESTE MANUAL |
| Servidor anterior à 0.9.1 não responde a `board:create` | TESTADO AUTOMATICAMENTE (servidor 0.9.0 real) |
| O servidor declara `boards` e `boardPersistence` | TESTADO AUTOMATICAMENTE (servidor real, dedicado e P2P) |
| Contra servidor velho, o motivo aparece e o botão some | TESTADO NO APLICATIVO (cliente 0.9.1 servido pelo servidor 0.9.0) |
| Criar mesa contra servidor novo continua funcionando | TESTADO NO APLICATIVO |
| Pedido da mesa sem resposta termina com explicação | VALIDADO POR ANÁLISE (prazo de 8 s em toda conversa da mesa) |
| Pasta de downloads não acumula versão baixada | TESTADO AUTOMATICAMENTE |
| Varredura não toca em download em andamento | TESTADO AUTOMATICAMENTE |
| Instalador do Windows apagado na abertura seguinte | IMPLEMENTADO — REQUER TESTE MANUAL |
| Configurações de desenho refeitas | TESTADO NO APLICATIVO |

### Mesa de desenho compartilhada — 0.9.1

| Item | Estado |
| --- | --- |
| Três pessoas desenham ao mesmo tempo e convergem | TESTADO AUTOMATICAMENTE (servidor real) |
| Quem entra depois vê os desenhos anteriores | TESTADO AUTOMATICAMENTE (servidor real) |
| Reconectar e reenviar o mesmo lote não duplica traços | TESTADO AUTOMATICAMENTE (servidor real) |
| Passar de 64 traços não apaga os primeiros | TESTADO AUTOMATICAMENTE (servidor real e modelo) |
| No teto, a recusa é explícita e nada é descartado | TESTADO AUTOMATICAMENTE |
| Desfazer não apaga o trabalho alheio | TESTADO AUTOMATICAMENTE (servidor real e modelo) |
| Borracha: cada um apaga os seus; quem gerencia, os demais | TESTADO AUTOMATICAMENTE (servidor real) |
| Observador não desenha, e a recusa vem do servidor | TESTADO AUTOMATICAMENTE (servidor real) |
| Revogação bloqueia a operação seguinte de quem já está conectado | TESTADO AUTOMATICAMENTE (servidor real) |
| Bloquear a mesa impede todo mundo, menos quem gerencia | TESTADO AUTOMATICAMENTE (servidor real) |
| Limpar tudo chega a quem reconecta depois | TESTADO AUTOMATICAMENTE (servidor real) |
| Salvar e reabrir no dedicado preserva o conteúdo | TESTADO AUTOMATICAMENTE (servidor reiniciado de verdade) |
| A mesa chega ao disco sem encerramento gracioso | TESTADO AUTOMATICAMENTE (processo derrubado por SIGKILL) |
| P2P: a mesa sobrevive à troca de host | TESTADO AUTOMATICAMENTE (dois servidores P2P reais) |
| Servidor dedicado recusa mesa vinda de fora | TESTADO AUTOMATICAMENTE (servidor real) |
| Lacuna de revisão vira pedido de recuperação | TESTADO AUTOMATICAMENTE (modelo) |
| Compactar o histórico não apaga traço visível | TESTADO AUTOMATICAMENTE (modelo) |
| Coordenadas iguais em janelas de tamanhos diferentes | TESTADO AUTOMATICAMENTE (modelo) |
| Desenhar, desfazer, apagar e limpar pela interface | TESTADO NO APLICATIVO (dois clientes no mesmo servidor) |
| Bloquear rebaixa o outro cliente na hora | TESTADO NO APLICATIVO (dois clientes no mesmo servidor) |
| Exportação em PNG | TESTADO NO APLICATIVO (imagem gerada, 44 KB) |
| Pausa da pintura com a janela em segundo plano | TESTADO NO APLICATIVO |
| Cursor alheio chega e não entra no histórico | TESTADO AUTOMATICAMENTE (servidor real) |
| Cursor sumindo da tela depois que a pessoa para | IMPLEMENTADO — REQUER TESTE MANUAL |
| Caneta com pressão / tela sensível ao toque | FORA DESTA VERSÃO |
| Desenhar em uma mesa aberta durante uma call real | IMPLEMENTADO — REQUER TESTE MANUAL |

### Desenho só na transmissão do Windows — 0.9.0

| Item | Estado |
| --- | --- |
| Servidor recusa traço para quem não declara o sistema | TESTADO AUTOMATICAMENTE (servidor real) |
| Cliente anterior à 0.9.0 é tratado como "não recebe" | TESTADO AUTOMATICAMENTE (servidor real) |
| Permitir não basta: o sistema decide primeiro | TESTADO AUTOMATICAMENTE (servidor real) |
| `drawSupported` começa falso ao entrar na call | TESTADO AUTOMATICAMENTE |
| Sobreposição recusada fora do Windows | VALIDADO POR ANÁLISE |
| Lápis translúcido na live de quem está no Linux | IMPLEMENTADO — REQUER TESTE MANUAL |
| Desenhar do Linux na live de quem está no Windows | IMPLEMENTADO — REQUER TESTE MANUAL |

# Checklist de QA — 0.8.1

Este arquivo separa o que já foi provado do que ainda depende de duas máquinas
reais. Os marcadores são fixos:

- **TESTADO AUTOMATICAMENTE** — há teste no `npm test` cobrindo isso;
- **VALIDADO POR ANÁLISE** — verificado lendo o código, sem execução;
- **IMPLEMENTADO — REQUER TESTE MANUAL** — o código existe, ninguém executou;
- **FALHOU** — executado e não passou.

Nada aqui é marcado como testado sem execução. Plataformas oficiais: **Fedora**
e **CachyOS/Arch** (mesma pilha: PipeWire, WirePlumber, xdg-desktop-portal,
KDE/Wayland).

---

## Experimento do microfone — executado

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

## Mídia — requer duas máquinas

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

## Matriz de mídia

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

## Matriz administrativa

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

## Autorização — já executado

| Item | Estado |
| --- | --- |
| Usuário comum não cria canal | TESTADO AUTOMATICAMENTE |
| Sincronização não injeta canais | TESTADO AUTOMATICAMENTE |
| Anexo entre pares exige sessão fora da rede local | TESTADO AUTOMATICAMENTE (política) |
| Limite de tentativas de login | TESTADO AUTOMATICAMENTE |
| Histórico P2P não vai para servidor dedicado | VALIDADO POR ANÁLISE |

---

## Atualização pelo aplicativo — 0.9.0

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

## Entrada reformulada e contas guardadas — 0.9.8

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

## Live por escolha explícita — 0.9.7

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

## Chaveiro de contas e convites — 0.9.6

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

## Isolamento por origem e notas resumidas — 0.9.5

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

## Autoridade do servidor dedicado — 0.9.4

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

## Traço e exclusão de mesas — 0.9.3

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

## Bandeja, mesa e atualização — 0.9.2

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

## Mesa de desenho compartilhada — 0.9.1

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

## Desenho só na transmissão do Windows — 0.9.0

| Item | Estado |
| --- | --- |
| Servidor recusa traço para quem não declara o sistema | TESTADO AUTOMATICAMENTE (servidor real) |
| Cliente anterior à 0.9.0 é tratado como "não recebe" | TESTADO AUTOMATICAMENTE (servidor real) |
| Permitir não basta: o sistema decide primeiro | TESTADO AUTOMATICAMENTE (servidor real) |
| `drawSupported` começa falso ao entrar na call | TESTADO AUTOMATICAMENTE |
| Sobreposição recusada fora do Windows | VALIDADO POR ANÁLISE |
| Lápis translúcido na live de quem está no Linux | IMPLEMENTADO — REQUER TESTE MANUAL |
| Desenhar do Linux na live de quem está no Windows | IMPLEMENTADO — REQUER TESTE MANUAL |

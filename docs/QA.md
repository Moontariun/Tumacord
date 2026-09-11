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
| P2P: a mesa sobrevive à troca de host | TESTADO AUTOMATICAMENTE (dois servidores P2P reais) |
| Servidor dedicado recusa mesa vinda de fora | TESTADO AUTOMATICAMENTE (servidor real) |
| Lacuna de revisão vira pedido de recuperação | TESTADO AUTOMATICAMENTE (modelo) |
| Compactar o histórico não apaga traço visível | TESTADO AUTOMATICAMENTE (modelo) |
| Coordenadas iguais em janelas de tamanhos diferentes | TESTADO AUTOMATICAMENTE (modelo) |
| Desenhar, desfazer, apagar e limpar pela interface | TESTADO NO APLICATIVO (dois clientes no mesmo servidor) |
| Bloquear rebaixa o outro cliente na hora | TESTADO NO APLICATIVO (dois clientes no mesmo servidor) |
| Exportação em PNG | TESTADO NO APLICATIVO (imagem gerada, 44 KB) |
| Pausa da pintura com a janela em segundo plano | TESTADO NO APLICATIVO |
| Cursor de outra pessoa aparecendo e sumindo | IMPLEMENTADO — REQUER TESTE MANUAL |
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

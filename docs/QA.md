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

Preencher com os marcadores acima ao executar.

| | P2P | Dedicado | Dedicado + TURN |
| --- | --- | --- | --- |
| Microfone inicial | | | |
| Mute/unmute | | | |
| Recuperação do microfone | | | |
| Troca de microfone | | | |
| Câmera | | | |
| Live start | | | |
| Live stop/start | | | |
| Entrar durante a live | | | |
| Sair e voltar | | | |
| Reconexão da sinalização | | | |

---

## Autorização — já executado

| Item | Estado |
| --- | --- |
| Usuário comum não cria canal | TESTADO AUTOMATICAMENTE |
| Sincronização não injeta canais | TESTADO AUTOMATICAMENTE |
| Anexo entre pares exige sessão fora da rede local | TESTADO AUTOMATICAMENTE (política) |
| Limite de tentativas de login | TESTADO AUTOMATICAMENTE |
| Histórico P2P não vai para servidor dedicado | VALIDADO POR ANÁLISE |

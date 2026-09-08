# Relatório 0.8.9 — estabilidade gráfica e orçamento de captura

Trabalho feito sobre a `release/windows-audio-v0.8.8` (commit `0de391e`, que
contém a tag `v0.8.8` = `fd2e274`). Base do repositório de desenvolvimento
identificada antes de começar: `main` estava em `0fd04f9`, ancestral da branch
0.8.8, sem alterações locais pendentes.

Este documento separa três coisas que o relatório anterior misturava: **o que
foi medido**, **o que foi corrigido** e **o que continua sem validação**.

---

## 1. Causa confirmada por medição

### 1.1 Não existe encoder de vídeo por hardware nesta máquina

Medido com Electron 41.10.7 / Chromium 146.0.7680.216, NVIDIA 610.57.04,
CachyOS 7.2.2, KDE/KWin 6.7.4, Wayland, RTX 3070. Leitura feita **depois** do
evento `gpu-info-update`, que é quando `getGPUFeatureStatus()` passa a valer:

```
gpu_compositing : enabled
video_decode    : enabled
video_encode    : disabled_software      <-- não há encoder de vídeo por hardware
vulkan          : disabled_off
webgl           : enabled
direct_rendering_display_compositor : disabled_off_ok
```

`getGPUInfo('complete')` devolve **zero** perfis de encode acelerado.

O que isso encerra: a ausência da bandeira VA-API para NVIDIA nunca provou nem
desmentiu NVENC — e agora a pergunta está respondida por medição, não por
leitura de código. **Forçar VA-API, `VaapiOnNvidiaGPUs`, Vulkan ou furar a lista
de bloqueio não criaria um encoder que não existe.** Nenhuma dessas bandeiras
foi ligada.

### 1.2 O custo real: o quadro precisa VOLTAR da GPU para a CPU

Com encoder de software e composição por GPU ligada, cada quadro capturado
precisa ser lido da memória da GPU antes de o encoder poder tocá-lo. Essa
viagem é trabalho de GPU — a mesma GPU do jogo.

Medição A/B, mesma cena, mesmo codec (VP8 por software), mesma resolução de
saída (480×270), execuções **alternadas** para não confundir com carga variável
da máquina:

| Execução | Backend | `gpu_compositing` | ms por quadro codificado | FPS entregue |
| --- | --- | --- | ---: | ---: |
| rep-1 | Wayland (hint auto) | `enabled` | **43,0** | 18 |
| rep-1 | X11 (`--ozone-platform=x11`) | `disabled_software` | **1,7** | 30 |
| rep-2 | Wayland | `enabled` | **42,7** | 18 |
| rep-2 | X11 | `disabled_software` | **1,4** | 30 |
| rep-3 | Wayland | `enabled` | **42,7** | 17 |
| rep-3 | X11 | `disabled_software` | **1,5** | 31 |

O contraste podia ser "Wayland contra X11". Não é. Isolando a variável — mesmo
backend Wayland, apenas `--disable-gpu-compositing`:

| Execução | Backend | `gpu_compositing` | ms por quadro | FPS |
| --- | --- | --- | ---: | ---: |
| nogpucomp-1 | **Wayland** | `disabled_software` | **1,50** | 30 |
| nogpucomp-2 | **Wayland** | `disabled_software` | **1,59** | 30 |

**A variável é a composição por GPU combinada com encoder de software, não o
backend de janelas.** Cinco pares de execuções, diferença de ~28×.

Esse custo escala com pixels. 43 ms para 480×270 (129.600 px). Um quadro
1920×1080 tem 16× mais pixels. Um orçamento de 16,7 ms por quadro (60 FPS) não
tem como caber. Isso é coerente com os 8 FPS relatados no jogo — mas **os 8 FPS
continuam sendo relato, não benchmark**: veja a seção 4.

### 1.3 Como isso encadeia com os erros de buffer dos registros

Os registros de 08/09 às 15:48:48–49 (`Failed to create BO with modifiers`,
`Cannot create bo with format=RGBA_8888 and usage=Scanout|Rendering|Texturing`,
mais 35 `Failed to allocate NVKMS memory for GEM object` na mesma janela) são
falhas de alocação de *buffer object* no caminho GBM/Ozone/Wayland. É
exatamente o caminho que a viagem GPU→CPU acima usa. Com o Enshrouded segurando
cerca de 5 GB de 8 GB de VRAM, essas alocações passam a falhar.

Isto é **encadeamento coerente com evidência**, não prova fechada: os registros
não dizem qual superfície disparou a primeira falha, e não reproduzi a falha com
o jogo aberto.

### 1.4 A sobreposição de desenho tira o foco do teclado no KDE/Wayland

Achado novo, encontrado durante este trabalho e **confirmado pelo usuário**, que
viu os traços na tela e não conseguia digitar enquanto a sonda rodava.

Medido com janelas pequenas, abrindo a sobreposição enquanto outra janela tinha
o foco:

| Variante testada | Janela anterior manteve o foco? | Sobreposição ficou com o foco? |
| --- | --- | --- |
| configuração atual (com fallback `show()`) | **não** | não |
| sem o fallback `show()` | **não** | não |
| `type: 'notification'` | **não** | não |
| `type: 'toolbar'` | **não** | não |
| `type: 'dock'` | **não** | não |
| sem `alwaysOnTop` | **não** | não |
| sem `visibleOnAllWorkspaces` | **não** | não |
| opaca (sem `transparent`) | **não** | não |
| `parent` da janela principal | **não** | não |

Em todas, o foco de teclado sai de quem estava digitando e **não vai para
ninguém**. Não encontrei combinação de opções do Electron que evite isso no
KWin/Wayland: a superfície certa para uma sobreposição seria `layer-shell`, que
o Chromium não expõe.

Consequência prática: quem estiver jogando perde o controle do jogo no instante
em que alguém aponta algo na live.

---

## 2. O que foi corrigido

### 2.1 A qualidade escolhida passou a controlar a captura

Até a 0.8.8, `CAPTURE_ENVELOPE` era sempre `ultra60`: **todo perfil pedia
captura 1440p60**, e trocar a qualidade só mexia no encoder de cada peer.
Escolher 720p30 num monitor 1440p continuava capturando 1440p60 e mandava o
encoder reduzir cada quadro — por software, com a viagem GPU→CPU da seção 1.2 em
tamanho cheio.

Agora cada perfil pede o próprio teto, e o pedido chega à faixa que já existe
por `applyConstraints` — **sem tocar na sessão do portal**: trocar a qualidade
nunca pede a tela de novo.

O que este código **não** promete:

- que o navegador aceite (pode rejeitar; três recusas fecham o caminho e o
  perfil volta a valer só no encoder, como na 0.8.8);
- que aceitar signifique mudar (pode aceitar e ignorar; isso é detectado
  comparando `getSettings()` antes e depois, e o pedido entra numa lista para
  não ser repetido em laço);
- que a economia seja total. **O compositor continua produzindo o quadro do
  monitor.** O que sai é o custo de conversão, cópia, viagem GPU→CPU e
  redimensionamento; quando o FPS cai, sai também o quadro inteiro.

A interface passou a mostrar o que a captura **entregou**, não o que foi pedido:
um 720p que não reduziu a captura diz "captura 2560×1440 · 60 FPS acima do
pedido 1280×720 · 30 FPS; o encoder ainda reduz o restante". Era exatamente a
mentira que a 0.8.8 contava em silêncio.

Subir de qualidade respeita o que a fonte já provou entregar e nunca repede a
seleção de tela.

### 2.2 Orçamento de FPS separado de congestionamento de rede

`src/lib/localPressure.ts` distingue quatro pressões que antes se pareciam:

| Fonte | Como é reconhecida | O que faz |
| --- | --- | --- |
| `network` | RTT, perda, estimativa de banda *enquanto o teto está em uso* | nada aqui — quem cuida é o controlador de bitrate |
| `encode` | `qualityLimitationReason: cpu`, ou tempo médio por quadro × número de enlaces estourando o orçamento | reduz o teto de FPS |
| `capture` | quadros largados antes do encoder, ou FPS capturado bem abaixo do pedido | reduz o teto de FPS |
| `render` | quadros recebidos decodificados e descartados na pintura | reduz o teto de FPS |

Histerese nos dois sentidos: duas amostras (~4 s) para descer um degrau
(60→48→30→20→15), oito (~16 s) para subir um. Aperto severo desce dois degraus.
O número de espectadores entra na conta — cada enlace tem o próprio encoder, e
três a 10 ms por quadro não cabem em 16,7 ms.

**A voz nunca entra nessa conta.** Nenhum caminho deste controlador toca em
sender de áudio.

Sem encoder por hardware medido, a live **abre** um degrau abaixo e sobe se a
folga aparecer, em vez de descobrir o teto depois de a imagem já ter estragado.

### 2.3 Estado desejado separado do estado aplicado

O defeito das linhas 1888–1896 da 0.8.8: `lastScaleChangeAt`, `screenBitrate` e
`screenScale` eram escritos **antes** de `setParameters` resolver. Uma rejeição
deixava o estado dizendo que a mudança valeu, e a decisão seguinte partia de um
número que nunca existiu no encoder.

Agora `desired*` é intenção e `screenApplied` é fato, escrito só depois do
sucesso (`src/lib/senderTuning.ts`, testado). Junto vieram duas regras: comando
obsoleto é descartado em vez de aplicado (duas trocas de qualidade seguidas não
mandam a primeira para o encoder depois da segunda), e a repetição tem teto de
três recusas.

### 2.4 Trabalho visual separado da continuidade da chamada

O aplicativo nasce com `disable-backgrounding-occluded-windows`,
`disable-renderer-backgrounding` e `backgroundThrottling: false`. As três
existem por um bom motivo, e continuam. O preço é que `document.hidden` **não
funciona** aqui: uma janela minimizada continua se dizendo visível.

Medido nesta máquina, com as três bandeiras ligadas como o aplicativo as usa:

| Fase | `isVisible()` | `isMinimized()` | `document.hidden` | `visibilityState` | Estado calculado |
| --- | --- | --- | --- | --- | --- |
| mostrada e em foco | true | false | **false** | **visible** | `active` |
| **minimizada** | false | true | **false** | **visible** | `hidden` |
| restaurada | true | false | **false** | **visible** | `background` → `active` |
| **escondida** | false | false | **false** | **visible** | `hidden` |
| mostrada de novo | true | false | **false** | **visible** | `active` |

`document.hidden` é `false` e `visibilityState` é `"visible"` em **todas** as
fases, inclusive minimizada e escondida. Uma correção baseada neles não faria
absolutamente nada neste aplicativo — isso está medido, não suposto. O processo
principal, por outro lado, acerta os três casos.

Quem sabe agora é o processo principal (`desktop/window-activity.cjs`), que
pergunta ao compositor e manda três estados ao renderer: `active`,
`background`, `hidden` — mais `detachedVisible`, que é o que garante que
minimizar o Tumacord com a live solta na tela **não** apaga a live.

Com isso: animações param sem foco; desfoque, animação e pintura de prévia param
com a janela escondida; áudio, transporte, captura e a janela solta continuam.

### 2.5 Pintura orientada a mudança na sobreposição de desenho

A sobreposição limpava e redesenhava o monitor inteiro num
`requestAnimationFrame` recursivo que nunca parava — inclusive com desenho
persistente parado, e na taxa do monitor.

Medido no monitor 1080p desta máquina (o de 180 Hz mostra o mesmo padrão, e é
onde o número antigo chega a 180/s):

| Estado | 0.8.8 | 0.8.9 |
| --- | ---: | ---: |
| nenhum traço | 149 pinturas/s | **0/s** |
| traço persistente parado | 178/s | **0/s** |
| traço desvanecendo | 180/s | **30/s** (cadência própria) |
| depois de expirar | 179/s | **0/s** (para sozinha) |

O recurso de desenho é o mesmo: nenhum traço deixa de aparecer, nenhum
desvanecimento deixa de acontecer. A camada de dentro do aplicativo
(`DrawingLayer`) ganhou lista de dependências — ela repintava a cada render do
componente pai — e um `ResizeObserver` no lugar disso.

### 2.6 A sobreposição sobre a área de trabalho virou opcional, desligada no Linux

Consequência direta do achado 1.4. No Windows ela continua ligada por padrão
(`setContentProtection` a tira da própria captura e ela não disputa o teclado).
No Linux nasce desligada, com o motivo escrito na tela.

**O desenho continua inteiro**: o traço aparece dentro do Tumacord para quem
transmite e dentro do vídeo para quem assiste. O que não aparece é a cópia sobre
a área de trabalho.

Junto: uma pausa no desenho passou a **esvaziar** a sobreposição em vez de
fechá-la, com carência de 8 s. Cada mapeamento de janela custava um foco de
teclado; uma rajada de traços com pausas custava vários.

### 2.7 Recuperação gradual para falha de apresentação

A 0.8.8 tinha um gatilho só: o processo GPU cair duas vezes em dez minutos. Uma
interface que para de pintar com todo mundo vivo não acionava nada — e o arquivo
de saúde desta máquina não tem nenhum evento no dia da falha.

Agora o renderer mede a própria cadência de pintura
(`src/lib/presentationHealth.ts`) e o processo principal decide o degrau:

```
none  →  reduce-effects  →  software-composite  →  xwayland  →  safe-gpu
```

- `reduce-effects` acontece dentro da sessão, sem reiniciar nada;
- `software-composite` tira a composição **desta janela** da GPU — é o degrau
  que a medição da seção 1.2 justifica, e vale só para o processo do Tumacord;
- `xwayland` é **comparação de backend**, não correção (fora do Linux a escada
  pula esse degrau em vez de empurrar bandeira de outro sistema);
- `safe-gpu` continua sendo o último recurso.

Carência de dois minutos entre degraus, um degrau por vez, e os que precisam de
bandeira nova valem na **próxima abertura** — reiniciar no meio de uma chamada é
pior que a falha. Três aberturas saudáveis devolvem um degrau: uma mitigação que
fica para sempre é uma mitigação que ninguém revalidou.

### 2.8 Diagnóstico

Opt-in, coletado só quando alguém aperta o botão em Configurações →
Diagnóstico. Ele responde o que a 0.8.8 não respondia: backend de janelas
efetivo (não o *hint*), `getGPUFeatureStatus` depois do `gpu-info-update`,
`getGPUInfo` com tratamento de falha, métricas por processo, estado real das
janelas, captura pedida contra captura efetiva, codec negociado, implementação
de encoder/decoder quando o navegador informa, quadros capturados / largados /
codificados / enviados / decodificados / descartados, tempo médio de encode e
decode **por diferença**, congelamentos, bitrate e `qualityLimitationReason`.

Estatística ausente aparece como **desconhecida**, nunca como zero. Composição
acelerada, encode por hardware e decode por hardware aparecem em três linhas
separadas — foram confundidos antes.

O relatório não carrega SDP, endereço IP, candidato ICE, convite, chave, nome de
janela capturada nem nome de usuário. Há teste que passa uma linha de comando
com `/home/renan/...`, IP e segredo e verifica que nada disso sobrevive.

### 2.9 Preferência de codec, só com motivo medido

`setCodecPreferences` é usado **apenas** quando a medição diz que não há encoder
por hardware, e **nunca** trunca a lista: ela é reordenada. Truncar é como se
quebra uma chamada — o outro lado pode não ter o que sobrou. Reordenando, quem
não quiser o primeiro escolhe o segundo, e a compatibilidade bilateral fica
preservada por construção. Sem medição, a escolha continua sendo do Chromium.

### 2.10 Duas correções para "tela preta / live não desenhada"

- A janela solta da live não tinha política de autoplay própria. Bastava uma
  pausa (troca de faixa, renegociação) para o `play()` seguinte precisar de um
  gesto que ninguém dá numa janela sem controles — e a live solta ficava preta.
  Agora ela nasce com `autoplayPolicy: 'no-user-gesture-required'`, como a
  principal.
- Um vigia de pintura no elemento de vídeo. "Live preta" são três estados
  diferentes que se pareciam: elemento pausado, faixa que nunca decodifica, e
  quadros decodificados que **não são pintados** — que é o que acontece quando o
  Chromium não consegue alocar o buffer gráfico do quadro, exatamente o
  `Failed to create BO with modifiers` dos registros. Só o terceiro não aparece
  em `readyState`; a assinatura dele é `totalVideoFrames` parado com a faixa
  viva e o elemento tocando. A recuperação é local: reatar a mesma faixa ao
  mesmo elemento, sem renegociar, sem reconstruir enlace, sem tocar no áudio.

---

## 3. VSync

Investigado sem partir da conclusão de que precisa ser desligado, e **nada foi
desligado**. Não há `--disable-gpu-vsync`, `--disable-frame-rate-limit`, nem
qualquer mexida no compositor — antes ou depois desta versão.

O que foi feito foi separar três números que estavam sendo tratados como um:

- **FPS da transmissão** — quadros que o encoder produziu, do relatório WebRTC;
- **cadência da interface** — quadros que a janela do Tumacord pintou, medida
  pelo `PaintMonitor`;
- **apresentação do jogo** — quadros que o jogo mandou ao compositor. Não é
  nosso, não é medido aqui, e nenhum número daqui pode ser lido como se fosse.

A medição da seção 1.2 mostra que a queda de FPS observada na sonda não vinha de
VSync: com VSync intocado nos dois lados do teste, só trocar a composição levou
o mesmo cenário de 17–18 para 30 quadros por segundo.

---

## 4. O que NÃO foi validado

Esta seção é a mais importante do documento. **Build passando e teste unitário
passando não são prova de que a queda para 8 FPS foi resolvida.**

### 4.1 Linux

| Cenário pedido | Estado |
| --- | --- |
| Enshrouded rodando, FPS médio e 1% lows, antes/depois | **não executado** — não abri o jogo |
| Matriz jogo sozinho / jogo+app ocioso / só enviando / só recebendo / envio+recepção | **não executada** |
| 15 minutos contínuos em envio+recepção | **não executado** |
| Ciclos repetidos de abrir/fechar live e pop-out | **não executado** |
| Um e vários peers | **não executado** — não havia segundo peer |
| Comparação com Discord e VDO.Ninja sob condições equivalentes | **não executada** |
| Captura real pelo portal do PipeWire | **não medida** — abrir o seletor do portal exige um clique da pessoa, e eu não tomei essa decisão sozinho |

A medição A/B da seção 1.2 usou uma fonte de `canvas.captureStream()`, não a
captura de tela pelo portal. O mecanismo é análogo (quadro na GPU alimentando um
encoder de software) mas **não é o mesmo caminho**, e o número de 43 ms é
daquele caminho, não uma previsão para a captura de tela.

A máquina também estava com outra carga durante as medições (`gpu-screen-recorder`
ativo, Discord, Brave, `load average` ~7, GPU entre 40% e 99%). Isso não
invalida o **contraste** — as execuções foram alternadas e repetidas cinco vezes
— mas invalidaria qualquer número absoluto lido isoladamente.

### 4.2 Windows

**Nada foi executado em Windows.** Não há máquina Windows nesta sessão, e o
componente nativo de áudio exige MSVC. Os artefatos do Windows saem do job
`windows-latest` do CI, que compila o helper, faz a sondagem dele, empacota
NSIS e portable e roda `typecheck` e a suíte inteira — mas **não** exercita
interface, captura, encoder, DWM nem chamada real.

Portanto, sobre Windows, esta versão só pode dizer:

- as correções compartilhadas (captura, prévias, desenho, adaptação, ciclo de
  vida, diagnóstico) valem lá porque são código compartilhado;
- só o que depende de API nativa foi separado por plataforma: a escada pula o
  degrau `xwayland` fora do Linux, `ozoneSwitches` e `streamingFeatures`
  devolvem lista vazia fora do Linux, e a sobreposição de desenho continua
  ligada por padrão só no Windows;
- **nenhuma bandeira de Linux foi reaproveitada no Windows**;
- o áudio da live no Windows não foi tocado: a exclusão de Tumacord/Discord, a
  captura de processos que surgem ou reiniciam, os limites do buffer, a
  recuperação limitada e o encerramento do auxiliar ao parar a live continuam
  como estavam, e os testes existentes deles seguem passando.

**As evidências de GBM/NVKMS são do Linux. Elas não são diagnóstico do Windows.**

### 4.3 Os dois sintomas relatados durante o trabalho

**Tela preta na versão portable do Windows ao ver stream pelo servidor.** Não
reproduzido aqui. Duas correções concretas entraram (2.10) e o diagnóstico agora
distingue os três estados de "preto". **Continua pendente de validação em
Windows real.**

**Live não desenhada na tela de quem está no Linux/Wayland.** No caso limpo, o
vídeo *pinta*: a sonda de laço WebRTC ponta-a-ponta nesta máquina devolveu
2304 de 2304 pixels não pretos no elemento e 360.000 pixels não pretos na
captura da janela. Ou seja, **não é uma falha universal desta configuração** — é
condicional, e a hipótese com mais evidência é a falha de alocação de buffer sob
pressão de VRAM (seção 1.3). O vigia de pintura recupera esse caso. **Não
reproduzi a condição de falha**, porque ela exige o jogo ocupando a VRAM.

---

## 5. Como reproduzir as medições

As sondas usadas estão descritas aqui para quem quiser repetir; elas não fazem
parte do pacote.

1. **Aceleração**: abrir o Tumacord e ler `logs/runtime-health.log` em
   `userData`. A linha `gpu-feature-status` traz composição, encode e decode
   separados. Ou usar Configurações → Diagnóstico → *Coletar diagnóstico
   gráfico*.
2. **A/B de composição**: rodar duas vezes o mesmo cenário, uma com o padrão e
   outra com `TUMACORD_SOFTWARE_COMPOSITE=1`, e comparar `tempo médio de
   encode` no relatório.
3. **Backend**: `TUMACORD_OZONE=x11` para a comparação com XWayland. Lembrar que
   nesta máquina o X11 **também** perde a composição por GPU, então ele não
   isola só o backend.
4. **Sobreposição**: contar `clearRect` na página da sobreposição nos quatro
   estados (sem traço, persistente parado, desvanecendo, depois de expirar).

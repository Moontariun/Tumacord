# Arquitetura do Tumacord

```text
Cada app ── servidor embutido :3927 (IPv4+IPv6) + descoberta UDP :3928
    │
    ├── um app anuncia a call e atua como host lógico
    ├── na mesma rede: broadcast/multicast encontra o host sozinho
    ├── fora dela: convite aponta um servidor; sem servidor, não há convite
    ├── somente 1 conversa de texto + 1 call no modo P2P
    ╰══ WebRTC direto entre todos os participantes (DTLS-SRTP), com ICE/STUN

Servidor de encontro Docker :4600
    │
    ├── API + Socket.IO + interface web no mesmo endereço
    ├── contas persistentes, chave de acesso e painel do administrador
    ├── alcançado só por conexão de saída: atravessa CGNAT dos dois lados
    ├── coturn opcional: relay TURN com credencial temporária
    ╰══ WebRTC direto entre os participantes (DTLS-SRTP); relay só se preciso
```

## Fluxo de host

O primeiro membro recebe `isHost=true`. Cada participante calcula periodicamente o RTT do par ICE realmente selecionado em cada conexão e publica a mediana, sem misturar rotas antigas ou deixar um único pico distorcer a eleição. Publica também uma nota de alcance de 0 a 100, vinda da sondagem do enlace direto.

Na saída do host, o servidor escolhe primeiro pela nota de alcance e só depois pelo menor `pingMs`, usando ordem de entrada e ID como desempate determinístico. A sinalização mora no host: um host rápido e inalcançável deixaria a call inteira sem porta de entrada.

Em uma saída normal, o host antigo anuncia o vencedor e seu endpoint antes da troca. Em uma queda abrupta, todos usam o último snapshot e chegam deterministicamente ao mesmo vencedor. O vencedor muda para seu servidor local; os demais autenticam e reentram automaticamente após uma pequena janela de eleição. Como toda instalação já está pronta para servir, não há configuração manual.

## Descoberta

O desktop envia probes e anúncios a cada segundo por UDP `3928`, tanto nos endereços de broadcast de cada interface IPv4 quanto no grupo multicast `239.255.42.99`. O endereço do host vem do pacote recebido, nunca de texto digitado pelo usuário. Anúncios expiram em 3,5 segundos. O anúncio carrega a chave do enlace direto, de modo que entrar por uma call vista na própria rede continua sendo um clique. Com o ZeroTier desligado nas preferências, o adaptador dele sai da lista de interfaces usadas aqui.

## Encontro e relay

Existe um caso que nenhuma travessia resolve: os dois lados atrás de CGNAT com NAT simétrico e sem IPv6. Não há endereço para furar. Para ele, o servidor de encontro inverte o sentido da conexão — os dois clientes ligam *para fora*, que é o que atravessa CGNAT — e o coturn entra como último recurso do ICE.

O convite não carrega endereço de máquina nenhuma: só a call, o servidor e o segredo. Desde a 0.8.3 essa é a única forma que existe. Havia uma segunda, que anunciava os endereços de entrada do host e fazia quem recebia correr atrás deles; ela exigia que alguém do grupo fosse alcançável da internet — IPv4 público, porta aberta ou IPv6 — e quase nunca era. Um convite indica um jeito só de entrar.

As credenciais de TURN seguem o esquema `use-auth-secret` do coturn (draft-uberti-behave-turn-rest-00): usuário é `<validade>:<nome>` e senha é o HMAC-SHA1 disso com um segredo compartilhado, em base64. Nenhum dos dois lados armazena senha; o coturn recalcula e compara. A renovação acontece com cinco minutos de folga, para uma credencial não vencer no meio de uma reconexão.

A ordem entre caminho direto e relay não é decidida por nós: o ICE compara candidatos por prioridade e um par direto sempre vence um par por relay. O relay entra quando nenhum direto se forma, e sai de cena se um direto aparecer depois.

Um relay que aceita qualquer destino vira uma porta para a rede interna da máquina que o hospeda. As faixas privadas, de loopback, de CGNAT e de multicast ficam proibidas como destino na configuração do coturn.

## Enlace direto

`desktop/nat.cjs` implementa STUN (RFC 5389), NAT-PMP (RFC 6886) e PCP (RFC 6887) em JavaScript puro; `desktop/upnp.cjs` cobre UPnP-IGD por SSDP, HTTP e SOAP. `desktop/direct-link.cjs` combina os três em um relatório: endereços de entrada, se há IPv6 global, se o IPv4 está em CGNAT, se o NAT mantém a mesma porta externa para destinos diferentes, e qual porta foi aberta no roteador.

Duas consultas STUN pela mesma porta local decidem o comportamento do NAT: endereço público igual nas duas significa mapeamento independente do destino, e é isso que permite ao ICE furar CGNAT. A ordem das tentativas de mapeamento é PCP, NAT-PMP e UPnP — o PCP primeiro porque é o único que uma operadora pode atender no próprio equipamento de CGNAT. A regra é renovada na metade do prazo e devolvida ao encerrar o aplicativo.

O convite (`shared/directLink.ts`) é um JSON compacto em base64url com prefixo `TUMA1`, dígito de verificação e prazo de 12 horas. Ele carrega a call, o servidor de encontro e a chave. Quem recebe confere que o servidor responde pela call certa e entra por lá.

A porta exposta é protegida por um conjunto de chaves aceitas. Endereços de loopback, RFC 1918, link-local e ULA entram sem chave, como a descoberta por broadcast sempre permitiu; o espaço de CGNAT fica de fora dessa confiança de propósito, porque carrega assinantes desconhecidos do mesmo provedor. `/api/direct/hello` devolve um HMAC do nonce por chave aceita, o que deixa o convidado conferir que alcançou a call certa sem revelar chave nenhuma.

## Mídia

Cada par tem um `RTCPeerConnection`. Microfone, câmera e tela são streams separados; o áudio do sistema, quando disponível, segue no mesmo stream da tela. A sinalização troca somente SDP, candidatos ICE e metadados de stream. Não há gravação nem retransmissão no servidor.

O envio da tela faz uma única captura no envelope máximo de 1440p60. As qualidades 1080p60, 1440p60, 1440p30, 1080p30, 720p30 e 480p15 são aplicadas dinamicamente nos `RTCRtpSender`s, sem reabrir o portal nem trocar a faixa capturada. A preferência fica persistida localmente. Cada enlace acompanha RTT, perda, capacidade estimada do caminho ativo, tempo de codificação e limitações reportadas pelo WebRTC. Perfis de 30/60 FPS usam a dica de conteúdo `motion` e `maintain-framerate`. Em congestionamento, o bitrate cai rapidamente; sob pressão de CPU/GPU ou congelamento informado pelo receptor, `scaleResolutionDownBy` reduz a resolução temporariamente para preservar movimento e áudio. Depois de amostras saudáveis, bitrate e resolução voltam gradualmente. Somente o enlace afetado é reconstruído.

Cada `RTCPeerConnection` recebe a lista de servidores STUN das preferências de rede. Sem ela — o estado até a 0.7.8 — o navegador só oferece o endereço da própria interface, e a call só funciona dentro de uma mesma rede. O desktop habilita `WebRTCPipeWireCapturer` e desabilita `WebRtcHideLocalIpsWithMdns`, garantindo que o IPv6 global, o endereço da rede local e, quando ligado, o adaptador ZeroTier apareçam entre os candidatos de host. Em Intel/AMD no Linux também habilita o encoder VA-API; a flag experimental de NVIDIA não é forçada. Duas quedas reais do processo GPU em dez minutos acionam uma reinicialização única sem aceleração de hardware, independentemente do fabricante. A execução seguinte volta ao caminho acelerado, evitando transformar uma falha transitória em uma penalidade permanente.

## Saúde do microfone

Uma faixa de microfone pode parar de entregar amostras sem terminar: `readyState` segue `live` e `enabled` segue `true`. `src/lib/microphoneHealth.ts` classifica três situações — faixa marcada como `muted` pelo sistema, dispositivo padrão que virou outro aparelho, e captura que abre sem receber amostra — e decide entre esperar, refazer a captura ou avisar. Energia exatamente zero é falha de captura e vale três segundos de espera; energia baixa é sala quieta e mantém a janela de vinte e cinco segundos. São no máximo três recapturas automáticas, com intervalo mínimo entre elas.

O roteador de áudio da live guarda os dispositivos padrão do sistema antes de carregar os módulos do PipeWire e os devolve se um nó do Tumacord for promovido a padrão. Os próprios nós pedem `priority.session=0` para não serem escolhidos.

No CachyOS/KDE Wayland, o Electron usa o portal de captura e o PipeWire tanto no P2P quanto ao se conectar ao servidor dedicado. O modo escolhido altera sinalização e persistência, não o pipeline local de tela e áudio. O roteador de áudio tolera portas que desaparecem entre o snapshot e a criação do link: mantém o barramento vivo e tenta somente o enlace afetado novamente, sem encerrar a track nativa de captura.

## Áudio da transmissão: dois mecanismos, uma faixa

O que impede a voz da call de voltar pela live não é cancelamento de eco — é o roteamento. A aplicação que reproduz a call nunca é capturada, então o laço não chega a existir. Os dois sistemas resolvem isso de formas diferentes, e `desktop/screen-audio.cjs` esconde a diferença atrás de uma API única. O campo `mode` do resultado de `prepare` é o que a distingue: `device` significa que há uma entrada de áudio para abrir por nome, `stream` significa que o PCM chega por um canal do processo principal.

No **Linux**, `desktop/audio-router.cjs` monta um `module-null-sink` e uma `module-remap-source` no PipeWire e liga nele os fluxos de saída que não são de call. O renderer abre essa fonte com `getUserMedia`.

No **Windows**, `desktop/windows-audio-router.cjs` conversa com um processo auxiliar em C++ (`native/windows/audio-helper/`) que usa `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` — a API oficial de loopback por processo, disponível a partir do Windows 10 build 19041. Uma captura por árvore de processo; janela compartilhada captura a árvore daquele processo, monitor inteiro captura as árvores de todas as sessões de áudio permitidas. A decisão de quais entram mora em `desktop/windows-audio-policy.cjs`, em JavaScript, porque é a parte que precisa de teste. O helper só executa a lista — e recusa, sempre, a própria árvore de quem o iniciou.

O PCM sai do helper em quadros binários, atravessa um `MessageChannelMain` dedicado (cem mensagens por segundo não passam por `ipcRenderer.invoke`) e vira faixa em `src/lib/screenAudioBridge.ts`: um `AudioWorklet` com anel de tamanho fechado, correção de deriva de relógio e limitador, ligado a um `MediaStreamAudioDestinationNode`. Esse contexto nunca se conecta a `destination` — reproduzir localmente o áudio da própria live criaria um caminho de retorno pelo cancelamento de eco do microfone.

Os dois caminhos terminam em uma `MediaStreamTrack` de áudio comum dentro do mesmo `MediaStream` da tela. Para o outro lado da call não há diferença alguma: chega uma faixa WebRTC normal, e a mesma SDP, os mesmos metadados de transmissão e a mesma telestração valem nos dois sistemas.

Quando o Windows não oferece loopback por processo, a preparação falha com um código conhecido e a transmissão segue **sem áudio**. Não há reserva de propósito: a alternativa seria capturar o dispositivo inteiro, que é exatamente o defeito que este caminho existe para evitar.

## Servidor dedicado e segurança

O contêiner serve `dist-web`, API e Socket.IO na porta `4600`; o servidor embutido do desktop define `TUMACORD_SERVE_WEB=0`. O modo dedicado exige a chave configurada pelo operador, armazena somente o hash dos tokens de sessão e deriva senhas com `scrypt`. HTTPS/WSS é ativado quando certificado e chave TLS são fornecidos. A mídia nunca é retransmitida pelo servidor e continua cifrada com DTLS-SRTP.

O nome administrativo é configurável por `ADMIN_USERNAME` e vale apenas no servidor dedicado. O painel expõe estado do serviço, canais e usuários conectados; ações administrativas exigem uma sessão autenticada desse usuário.

## Desenho sobre a transmissão

As coordenadas viajam como fração de 0 a 1 do quadro capturado, nunca em pixels: quem desenha em uma janela de 600 px e quem transmite em 4K precisam ver o traço no mesmo lugar do *conteúdo*. `shared/telestration.ts` guarda essa conversão, o prazo do traço e os tetos que protegem contra um cliente falante; o servidor reenvia cada traço para a sala inteira com um balde por socket.

Duas permissões decidem se um traço passa, e as duas moram no servidor:

- `allowDraw` — a preferência de quem transmite, publicada no estado de voz;
- `drawSupported` — o *sistema* de quem transmite, que só é verdadeiro no Windows. `desktop/drawing-overlay.cjs` abre uma janela sem moldura sobre o monitor capturado para o traço aparecer na área de trabalho de verdade; no Windows ela não rouba foco e sai da captura por `setContentProtection`, e no Linux ela faz as duas coisas erradas — tira o foco do teclado de quem está jogando e volta dentro da captura do portal do PipeWire. O processo principal recusa a sobreposição fora do Windows, e o servidor recusa o traço: esconder o lápis é conveniência da interface, não proteção.

Ausência de `drawSupported` é lida como "não recebe": um cliente anterior à 0.9.0 não declara o sistema, e adivinhar o sistema de alguém para pintar na área de trabalho dele seria a escolha errada.

## Mesa de desenho compartilhada

A mesa é o oposto do desenho sobre a live em quase tudo. Aquilo é apontamento — vive dentro do vídeo, tem prazo, e depende de uma janela sobreposta que só se comporta no Windows. A mesa é o trabalho: ela fica, ela é o motivo de estarem ali, e ela é desenhada dentro do próprio app, sem overlay e sem live, o que a torna igual no Linux e no Windows.

`shared/whiteboard.ts` é o modelo, e é puro: coordenadas de documento (a folha tem tamanho próprio, independente de qualquer janela), as operações, os limites e a função que aplica uma operação a um quadro. Zoom e deslocamento são estado local de quem olha; a folha é a única coisa compartilhada.

**Operação, e não imagem.** O que viaja é "traço tal, destes pontos, desta cor", em pedaços, conforme a mão anda — nunca um quadro inteiro a cada movimento. Cada pedaço leva um id próprio: é ele que faz a retentativa de uma reconexão não virar traço duplo.

**Revisão densa.** `server/whiteboards.ts` ordena: cada operação aceita ganha o próximo número, e **recusa não gasta número**. Com isso quem recebe separa três casos com uma comparação — a revisão esperada chegou (aplica), uma que já passou voltou (ignora), ou saltou (pede recuperação). Deduplicação e detecção de lacuna saem do mesmo lugar.

**Quem recebe não reavalia permissão.** A permissão foi decidida quando a operação foi aceita. Refazer a conta do lado de quem recebe faria os quadros divergirem — a borracha de quem gerencia a mesa, por exemplo, seria recusada por todo mundo, e o traço apagado reapareceria só na tela dos outros. `applyOrderedOp` existe para marcar esse contrato.

**Snapshot mais o que veio depois.** Entrar atrasado e reconectar são o mesmo caminho: "estou na revisão tal, me diga o que mudou". A resposta é a diferença, ou o quadro inteiro quando a pessoa ficou para trás do snapshot. Compactar troca *histórico* por snapshot — nunca traço por espaço — porque o snapshot já carrega tudo o que está visível.

**Nada some sozinho.** O desenho sobre a live guarda 64 traços e descarta o mais antigo; aqui o teto recusa a operação nova com uma mensagem e preserva o que está na folha. Desfazer age sobre um objeto identificado e do próprio autor, nunca sobre "o último item da lista".

No dedicado, as mesas são gravadas no arquivo do servidor (gravação adiada em um segundo, mais uma descarga no encerramento, para o último traço não cair na janela entre a mão levantar e o arquivo ser escrito). No P2P nada é gravado: quem ordena é o host, e a mesa atravessa a troca de host porque quem estava nela devolve o snapshot ao servidor novo. Essa devolução é recusada por um servidor dedicado e exige, no P2P, que quem entrega esteja na call daquele host agora.

## Atualização do aplicativo

A fonte é o repositório do GitHub, e ela é a mesma para o aplicativo e para o servidor. `desktop/update-check.cjs` recebe a lista de Releases já baixada e devolve uma decisão — sem rede e sem disco, para poder ser testada inteira: qual versão oferecer, se ela foi retirada (lista embutida ou o marcador `<!-- tumacord:versao-quebrada -->` no corpo da Release), qual arquivo serve para o jeito daquela instalação (`linux-managed`, `linux-appimage`, `windows-installed`, `windows-portable`, `unknown`) e quais são as notas da versão instalada.

`desktop/updater.cjs` é a parte que precisa de rede e de disco: só `https` e só GitHub, cada redirecionamento conferido de novo, tamanho e SHA-256 conferidos antes de qualquer coisa ser executada, e um caminho de aplicação por tipo de instalação. No Linux gerenciado ele repete o que o instalador faz — build nova em pasta imutável, troca atômica do atalho `current`, anterior apontada por `previous` —, o que permite atualizar sem interromper a call em andamento.

A procura acontece uma vez, na abertura, com a janela já de pé. Baixar e aplicar são cliques da interface (`src/components/UpdatePanel.tsx`); nada é automático. `update-state.json`, na pasta de dados do usuário, guarda três coisas: se a procura ao abrir está ligada, qual versão foi ignorada e qual versão já teve o "o que mudou" mostrado — é o que faz o changelog aparecer uma vez por versão, venha a atualização de onde vier.

No servidor, `scripts/update-server.sh` lê as mesmas Releases: `ultima` resolve a versão publicada mais nova que não foi retirada, o script recusa uma tag marcada como retirada antes de tocar no Docker, e só reconstrói quando o código mudou ou quando a versão no ar é outra — reiniciar um contêiner que já está certo derruba a call de alguém à toa.

## Replicação pessoal

Mensagens e perfis são mesclados entre os computadores online. Perfis usam o nome normalizado como identidade P2P e `updatedAt` como revisão: avatar, banner, bio e cor mais recentes vencem. As mídias de perfil são publicadas no host atual e baixadas para o servidor embutido de cada desktop, permitindo que qualquer participante assuma como host sem voltar para uma foto antiga.

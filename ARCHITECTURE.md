# Arquitetura do Tumacord

```text
Cada app ── servidor embutido :3927 (IPv4+IPv6) + descoberta UDP :3928
    │
    ├── um app anuncia a call e atua como host lógico
    ├── na mesma rede: broadcast/multicast encontra o host sozinho
    ├── fora dela: convite com os caminhos do host (IPv6, IPv4 mapeado) + chave
    ├── somente 1 conversa de texto + 1 call no modo P2P
    ╰══ WebRTC direto entre todos os participantes (DTLS-SRTP), com ICE/STUN

Servidor dedicado Docker :4600
    │
    ├── API + Socket.IO + interface web no mesmo endereço
    ├── contas persistentes, chave de acesso e painel do administrador
    ╰══ WebRTC direto entre os participantes (DTLS-SRTP)
```

## Fluxo de host

O primeiro membro recebe `isHost=true`. Cada participante calcula periodicamente o RTT do par ICE realmente selecionado em cada conexão e publica a mediana, sem misturar rotas antigas ou deixar um único pico distorcer a eleição. Publica também uma nota de alcance de 0 a 100, vinda da sondagem do enlace direto.

Na saída do host, o servidor escolhe primeiro pela nota de alcance e só depois pelo menor `pingMs`, usando ordem de entrada e ID como desempate determinístico. A sinalização mora no host: um host rápido e inalcançável deixaria a call inteira sem porta de entrada.

Em uma saída normal, o host antigo anuncia o vencedor e seu endpoint antes da troca. Em uma queda abrupta, todos usam o último snapshot e chegam deterministicamente ao mesmo vencedor. O vencedor muda para seu servidor local; os demais autenticam e reentram automaticamente após uma pequena janela de eleição. Como toda instalação já está pronta para servir, não há configuração manual.

## Descoberta

O desktop envia probes e anúncios a cada segundo por UDP `3928`, tanto nos endereços de broadcast de cada interface IPv4 quanto no grupo multicast `239.255.42.99`. O endereço do host vem do pacote recebido, nunca de texto digitado pelo usuário. Anúncios expiram em 3,5 segundos. O anúncio carrega a chave do enlace direto, de modo que entrar por uma call vista na própria rede continua sendo um clique. Com o ZeroTier desligado nas preferências, o adaptador dele sai da lista de interfaces usadas aqui.

## Enlace direto

`desktop/nat.cjs` implementa STUN (RFC 5389), NAT-PMP (RFC 6886) e PCP (RFC 6887) em JavaScript puro; `desktop/upnp.cjs` cobre UPnP-IGD por SSDP, HTTP e SOAP. `desktop/direct-link.cjs` combina os três em um relatório: endereços de entrada, se há IPv6 global, se o IPv4 está em CGNAT, se o NAT mantém a mesma porta externa para destinos diferentes, e qual porta foi aberta no roteador.

Duas consultas STUN pela mesma porta local decidem o comportamento do NAT: endereço público igual nas duas significa mapeamento independente do destino, e é isso que permite ao ICE furar CGNAT. A ordem das tentativas de mapeamento é PCP, NAT-PMP e UPnP — o PCP primeiro porque é o único que uma operadora pode atender no próprio equipamento de CGNAT. A regra é renovada na metade do prazo e devolvida ao encerrar o aplicativo.

O convite (`shared/directLink.ts`) é um JSON compacto em base64url com prefixo `TUMA1`, dígito de verificação e prazo de 12 horas. Ele carrega os caminhos do host e a chave da call. Quem recebe tenta os caminhos em paralelo, escalonados — rede local, IPv6, IPv4 mapeado —, e o primeiro que responder vence.

A porta exposta é protegida por um conjunto de chaves aceitas. Endereços de loopback, RFC 1918, link-local e ULA entram sem chave, como a descoberta por broadcast sempre permitiu; o espaço de CGNAT fica de fora dessa confiança de propósito, porque carrega assinantes desconhecidos do mesmo provedor. `/api/direct/hello` devolve um HMAC do nonce por chave aceita, o que deixa o convidado conferir que alcançou a call certa sem revelar chave nenhuma.

## Mídia

Cada par tem um `RTCPeerConnection`. Microfone, câmera e tela são streams separados; o áudio do sistema, quando disponível, segue no mesmo stream da tela. A sinalização troca somente SDP, candidatos ICE e metadados de stream. Não há gravação nem retransmissão no servidor.

O envio da tela faz uma única captura no envelope máximo de 1440p60. As qualidades 1080p60, 1440p60, 1440p30, 1080p30, 720p30 e 480p15 são aplicadas dinamicamente nos `RTCRtpSender`s, sem reabrir o portal nem trocar a faixa capturada. A preferência fica persistida localmente. Cada enlace acompanha RTT, perda, capacidade estimada do caminho ativo, tempo de codificação e limitações reportadas pelo WebRTC. Perfis de 30/60 FPS usam a dica de conteúdo `motion` e `maintain-framerate`. Em congestionamento, o bitrate cai rapidamente; sob pressão de CPU/GPU ou congelamento informado pelo receptor, `scaleResolutionDownBy` reduz a resolução temporariamente para preservar movimento e áudio. Depois de amostras saudáveis, bitrate e resolução voltam gradualmente. Somente o enlace afetado é reconstruído.

Cada `RTCPeerConnection` recebe a lista de servidores STUN das preferências de rede. Sem ela — o estado até a 0.7.8 — o navegador só oferece o endereço da própria interface, e a call só funciona dentro de uma mesma rede. O desktop habilita `WebRTCPipeWireCapturer` e desabilita `WebRtcHideLocalIpsWithMdns`, garantindo que o IPv6 global, o endereço da rede local e, quando ligado, o adaptador ZeroTier apareçam entre os candidatos de host. Em Intel/AMD no Linux também habilita o encoder VA-API; a flag experimental de NVIDIA não é forçada. Duas quedas reais do processo GPU em dez minutos acionam uma reinicialização única sem aceleração de hardware, independentemente do fabricante. A execução seguinte volta ao caminho acelerado, evitando transformar uma falha transitória em uma penalidade permanente.

## Saúde do microfone

Uma faixa de microfone pode parar de entregar amostras sem terminar: `readyState` segue `live` e `enabled` segue `true`. `src/lib/microphoneHealth.ts` classifica três situações — faixa marcada como `muted` pelo sistema, dispositivo padrão que virou outro aparelho, e captura que abre sem receber amostra — e decide entre esperar, refazer a captura ou avisar. Energia exatamente zero é falha de captura e vale três segundos de espera; energia baixa é sala quieta e mantém a janela de vinte e cinco segundos. São no máximo três recapturas automáticas, com intervalo mínimo entre elas.

O roteador de áudio da live guarda os dispositivos padrão do sistema antes de carregar os módulos do PipeWire e os devolve se um nó do Tumacord for promovido a padrão. Os próprios nós pedem `priority.session=0` para não serem escolhidos.

No CachyOS/KDE Wayland, o Electron usa o portal de captura e o PipeWire tanto no P2P quanto ao se conectar ao servidor dedicado. O modo escolhido altera sinalização e persistência, não o pipeline local de tela e áudio. O roteador de áudio tolera portas que desaparecem entre o snapshot e a criação do link: mantém o barramento vivo e tenta somente o enlace afetado novamente, sem encerrar a track nativa de captura.

## Servidor dedicado e segurança

O contêiner serve `dist-web`, API e Socket.IO na porta `4600`; o servidor embutido do desktop define `TUMACORD_SERVE_WEB=0`. O modo dedicado exige a chave configurada pelo operador, armazena somente o hash dos tokens de sessão e deriva senhas com `scrypt`. HTTPS/WSS é ativado quando certificado e chave TLS são fornecidos. A mídia nunca é retransmitida pelo servidor e continua cifrada com DTLS-SRTP.

O nome administrativo é configurável por `ADMIN_USERNAME` e vale apenas no servidor dedicado. O painel expõe estado do serviço, canais e usuários conectados; ações administrativas exigem uma sessão autenticada desse usuário.

## Replicação pessoal

Mensagens e perfis são mesclados entre os computadores online. Perfis usam o nome normalizado como identidade P2P e `updatedAt` como revisão: avatar, banner, bio e cor mais recentes vencem. As mídias de perfil são publicadas no host atual e baixadas para o servidor embutido de cada desktop, permitindo que qualquer participante assuma como host sem voltar para uma foto antiga.

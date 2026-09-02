# Arquitetura do Tumacord

```text
Cada app ── servidor embutido :3927 + descoberta UDP :3928
    │
    ├── um app anuncia a call e atua como host lógico
    ├── os demais encontram esse host por broadcast/multicast no ZeroTier
    ├── somente 1 conversa de texto + 1 call no modo P2P
    ╰══ WebRTC direto entre todos os participantes (DTLS-SRTP)

Servidor dedicado Docker :4600
    │
    ├── API + Socket.IO + interface web no mesmo endereço
    ├── contas persistentes, chave de acesso e painel do administrador
    ╰══ WebRTC direto entre os participantes (DTLS-SRTP)
```

## Fluxo de host

O primeiro membro recebe `isHost=true`. Cada participante calcula periodicamente o RTT do par ICE realmente selecionado em cada conexão e publica a mediana, sem misturar rotas antigas ou deixar um único pico distorcer a eleição. Na saída do host, o servidor seleciona o menor `pingMs`, usando ordem de entrada e ID apenas como desempate determinístico.

Em uma saída normal, o host antigo anuncia o vencedor e seu endpoint antes da troca. Em uma queda abrupta, todos usam o último snapshot e chegam deterministicamente ao mesmo vencedor. O vencedor muda para seu servidor local; os demais autenticam e reentram automaticamente após uma pequena janela de eleição. Como toda instalação já está pronta para servir, não há configuração manual.

## Descoberta

O desktop envia probes e anúncios a cada segundo por UDP `3928`, tanto nos endereços de broadcast de cada interface IPv4 quanto no grupo multicast `239.255.42.99`. O endereço do host vem do pacote recebido, nunca de texto digitado pelo usuário. Anúncios expiram em 3,5 segundos.

## Mídia

Cada par tem um `RTCPeerConnection`. Microfone, câmera e tela são streams separados; o áudio do sistema, quando disponível, segue no mesmo stream da tela. A sinalização troca somente SDP, candidatos ICE e metadados de stream. Não há gravação nem retransmissão no servidor.

O envio da tela acompanha RTT, perda e capacidade estimada do caminho ativo separadamente para cada espectador. Em congestionamento, o bitrate cai rapidamente para preservar movimento e áudio; depois de três amostras saudáveis, volta gradualmente até a qualidade escolhida. Se vídeo e pacotes pararem de sair apesar de a conexão continuar marcada como ativa, somente aquele enlace é reconstruído.

O desktop habilita `WebRTCPipeWireCapturer` e desabilita `WebRtcHideLocalIpsWithMdns`, garantindo que o adaptador ZeroTier apareça entre os candidatos de host.

No CachyOS/KDE Wayland, o Electron usa o portal de captura e o PipeWire tanto no P2P quanto ao se conectar ao servidor dedicado. O modo escolhido altera sinalização e persistência, não o pipeline local de tela e áudio.

## Servidor dedicado e segurança

O contêiner serve `dist-web`, API e Socket.IO na porta `4600`; o servidor embutido do desktop define `TUMACORD_SERVE_WEB=0`. O modo dedicado exige a chave configurada pelo operador, armazena somente o hash dos tokens de sessão e deriva senhas com `scrypt`. HTTPS/WSS é ativado quando certificado e chave TLS são fornecidos. A mídia nunca é retransmitida pelo servidor e continua cifrada com DTLS-SRTP.

O nome administrativo é configurável por `ADMIN_USERNAME` e vale apenas no servidor dedicado. O painel expõe estado do serviço, canais e usuários conectados; ações administrativas exigem uma sessão autenticada desse usuário.

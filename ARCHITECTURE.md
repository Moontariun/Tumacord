# Arquitetura do Tumacord

```text
Cada app ── servidor embutido :3927 + descoberta UDP :3928
    │
    ├── um app anuncia a call e atua como host lógico
    ├── os demais encontram esse host por broadcast/multicast no ZeroTier
    ╰══ WebRTC direto entre todos os participantes (DTLS-SRTP)
```

## Fluxo de host

O primeiro membro recebe `isHost=true`. Cada participante calcula periodicamente o RTT dos pares WebRTC e publica seu ping médio. Na saída do host, o servidor seleciona o menor `pingMs`, usando ordem de entrada e ID apenas como desempate determinístico.

Em uma saída normal, o host antigo anuncia o vencedor e seu endpoint antes da troca. Em uma queda abrupta, todos usam o último snapshot e chegam deterministicamente ao mesmo vencedor. O vencedor muda para seu servidor local; os demais autenticam e reentram automaticamente após uma pequena janela de eleição. Como toda instalação já está pronta para servir, não há configuração manual.

## Descoberta

O desktop envia probes e anúncios a cada segundo por UDP `3928`, tanto nos endereços de broadcast de cada interface IPv4 quanto no grupo multicast `239.255.42.99`. O endereço do host vem do pacote recebido, nunca de texto digitado pelo usuário. Anúncios expiram em 3,5 segundos.

## Mídia

Cada par tem um `RTCPeerConnection`. Microfone, câmera e tela são streams separados; o áudio do sistema, quando disponível, segue no mesmo stream da tela. A sinalização troca somente SDP, candidatos ICE e metadados de stream. Não há gravação nem retransmissão no servidor.

O desktop habilita `WebRTCPipeWireCapturer` e desabilita `WebRtcHideLocalIpsWithMdns`, garantindo que o adaptador ZeroTier apareça entre os candidatos de host.

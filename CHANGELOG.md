# Histórico de versões

## 0.1.1 — estabilidade P2P

- cálculo de ping usa apenas a rota ICE ativa e a mediana entre participantes;
- bitrate da transmissão se adapta a latência, perda e capacidade disponível por espectador;
- enlace de live sem tráfego é reconstruído sem derrubar a call inteira;
- renegociação e retorno à call preservam o estado da transmissão;
- instalador da branch mantém o clone na pasta de Downloads do sistema e não depende de AppImage.

## 0.1.0 — versão inicial

- chamadas P2P com voz, câmera e compartilhamento de tela;
- descoberta automática pela rede local e ZeroTier;
- troca dinâmica de host por latência;
- áudio da tela isolado da call no PipeWire;
- perfis, chat distribuído, anexos e servidor dedicado opcional;
- AppImage para CachyOS/Arch e servidor Docker na porta 4600.

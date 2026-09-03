# Histórico de versões

## 0.5.0 — correção da transmissão e auditoria de estabilidade

- a qualidade padrão da live agora é 1080p60, a preferência sobrevive ao relogin e as opções exibem somente resolução e FPS;
- trocar a qualidade ajusta os encoders WebRTC existentes sem recapturar nem pedir a seleção da tela novamente;
- corrigida a corrida de metadados que podia deixar apenas um espectador preso em “Aguardando a faixa de vídeo…” durante a reconstrução do enlace;
- encerramento da call invalida capturas pendentes, impedindo câmera, microfone ou tela de reaparecerem depois da saída;
- parâmetros de qualidade são serializados por enlace e reaplicados depois da conexão caso o Chromium ainda não aceitasse a configuração inicial;
- trocas de câmera e microfone reconciliam peers reconstruídos durante a operação, sem manter faixas antigas ou exigir nova entrada na call;
- candidatos ICE antecipados continuam na fila, enquanto candidatos de uma oferta descartada durante glare deixam de contaminar a negociação aceita;
- eleição de host deixa de bloquear uma segunda migração legítima ocorrida poucos segundos após a anterior;
- descoberta UDP acompanha interfaces Wi-Fi/ZeroTier que aparecem ou desaparecem e mantém o shutdown idempotente;
- perfis distribuídos só publicam metadados depois dos arquivos e usam desempate determinístico quando duas edições têm o mesmo horário;
- anexos preservam nome e MIME antes mesmo do envio da mensagem, limitam o corpo depois de autenticar e rejeitam cabeçalhos inválidos;
- o desktop restringe permissões à janela principal, bloqueia navegação externa inesperada e usa uma versão do Electron sem os alertas conhecidos pela auditoria de dependências;
- falhas transitórias ao ligar uma saída ao PipeWire não desmontam mais o barramento que o Chromium está capturando, e a frequência de inspeção do grafo foi reduzida;
- quedas repetidas do processo GPU são registradas e fazem o Electron reiniciar uma única sessão em modo gráfico seguro, em NVIDIA, AMD ou Intel, voltando a testar aceleração na abertura seguinte;
- adicionados testes de regressão para sinalização multi-peer, migração normal e abrupta, qualidade, dispositivos, discovery, perfis, anexos e autorização administrativa.

## 0.4.0 — estabilidade de mídia, sessão e perfis distribuídos (afetada)

> **Aviso:** a v0.4.0 está quebrada no compartilhamento de tela. Uma corrida entre `rtc:resync` e `rtc:stream-meta` pode deixar espectadores em “Aguardando a faixa de vídeo…”, a qualidade inicial pode ficar abaixo do perfil escolhido e certas trocas de qualidade recapturam a fonte. Use a v0.5.0.

- transmissão 1440p prioriza movimento e FPS, com adaptação conjunta de bitrate e resolução quando o encoder, a rede ou o decodificador ficam pressionados;
- receptores detectam live congelada, avisam o transmissor e reconstroem somente o enlace afetado, sem reiniciar a call;
- VA-API é habilitado em AMD/Intel no Linux; NVIDIA usa o caminho validado pelo Chromium e o fallback adaptativo, sem forçar flags experimentais;
- avatar, banner, bio e cor são replicados entre os computadores online, incluindo os arquivos, e a edição mais recente substitui cópias antigas;
- retorno de um espectador republica metadados e mantém o estado AO VIVO do transmissor;
- saídas virtuais `default` e `communications` do Chromium foram consolidadas em uma única opção funcional “Padrão do sistema”;
- todas as qualidades de alta resolução agora usam a nomenclatura 1440p;
- encerramento do UDP de descoberta tornou-se idempotente, eliminando `ERR_SOCKET_DGRAM_NOT_RUNNING` ao fechar.
- sessão P2P persistida se recupera silenciosamente no host local quando o host anterior deixa de existir;
- live continua em uma miniatura móvel sobre o chat, sem perder o áudio nem os volumes escolhidos;
- controles da call e lista de pessoas foram reorganizados para não se sobrepor em Full HD ou janela dividida; o volume individual abre somente ao clicar no participante da call.

## 0.3.0 — interface responsiva e servidor web seguro

- palco de vídeo elástico, sem corte ao redimensionar ou dividir a janela, com controles e tipografia retrabalhados;
- modo P2P simplificado para uma conversa e uma call, preservando descoberta ZeroTier e troca dinâmica de host;
- contêiner dedicado passa a hospedar a versão web na porta 4600; o servidor embutido não expõe páginas;
- mesma captura PipeWire/Wayland de tela com áudio no P2P e no servidor dedicado;
- chave de acesso do servidor, senhas com `scrypt`, tokens persistidos como hash, HTTPS/WSS opcional e mídia DTLS-SRTP;
- conta local pode ser provisionada automaticamente no servidor com as mesmas credenciais;
- painel de administração para `Moontariun` por padrão, configurável pelo host;
- nova marca de tomate/telefone fornecida para o projeto, com fundo realmente transparente, ícones coloridos do KDE regenerados e variante branca exclusiva para a bandeja;
- número da versão visível no login, configurações e diagnóstico administrativo;
- encerramento idempotente do socket de descoberta, sem a janela `ERR_SOCKET_DGRAM_NOT_RUNNING` ao sair;
- testes integrados dos dois modos, autenticação, autorização, sinalização de áudio da tela e entrega web.

## 0.2.1 — ciclo de áudio e reconexão

- correções de ciclo de vida do microfone e da live para que mute não encerre a mídia remota;
- recuperação de áudio, renegociação e estado de transmissão após reconexões;
- instalação versionada para atualizar sem substituir os arquivos usados pela sessão aberta.

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

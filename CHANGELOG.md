# Histórico de versões

## 0.7.0 — abertura nítida da live, seletores próprios e presença enxuta

**Transmissão**

- as dicas de bitrate passaram a viajar na descrição **remota**: o Chromium recusa editar codecs na própria SDP local, então na 0.6.0 elas caíam no fallback e a live continuava abrindo borrada. Agora o encoder já nasce perto do perfil escolhido;
- nos primeiros nove segundos a transmissão segura a resolução enquanto o bitrate sobe. Passada essa janela o perfil volta a mandar, então 60 FPS continua priorizando fluidez para jogo;
- o ponto de partida subiu para 85% do perfil e o piso para 35%.

**Áudio e microfone**

- um microfone escolhido nas configurações que recusa a captura agora cai para o padrão do sistema com aviso, em vez de deixar a pessoa falando sem que ninguém ouça;
- o aplicativo avisa quando o microfone está aberto mas não capta som nenhum;
- o monitor de fala passou a dividir o mesmo `AudioContext` do restante do aplicativo.

**Interface**

- os seletores deixaram de usar o `<select>` nativo, cujo popup ignora o tema escuro no Linux e abria com as opções em branco. A lista agora é desenhada pelo Tumacord, com teclado e sem ser cortada pelo rodapé;
- rodapé da call reorganizado: estado da malha, qualidade e áudio da live viraram pastilhas da mesma altura, alinhadas, que quebram para a linha de baixo em vez de espremer o texto;
- o botão de mutar a live não troca mais o rótulo, então nada muda de tamanho ao clicar;
- a lista da direita mostra só quem está online, sem repetir o estado da chamada;
- o topo da barra lateral mostra apenas a marca Tumacord;
- novo ícone de bandeja: contorno fino em vez do desenho preenchido, ainda em branco;
- a live solta passou a abrir em uma janela de documento própria — a janela nativa de vídeo do Chromium escurecia a imagem com a barra de controles dele sempre que recebia foco.

**Desktop**

- o Chromium não trata mais a janela coberta pela live flutuante como oculta, então a imagem não escurece nem engasga quando a janela solta ganha foco.

**Correções aplicadas ainda na 0.7.0**

- escolher microfone ou saída de áudio derrubava o som da call: `AudioContext.setSinkId` reinicia a saída inteira do contexto e, com todo o áudio do aplicativo compartilhando um contexto, a pessoa parava de ouvir até voltar para "Padrão do sistema". A saída escolhida passou a sair por um elemento dedicado, sem tocar no grafo, e a troca acontece em um único ponto do aplicativo em vez de uma vez por elemento de mídia;
- o botão "Reconectar" escapava da borda da pastilha da malha quando o texto não cabia;
- a live solta ganhou uma janela real do Electron, sempre acima dos outros aplicativos, para hosts onde nenhuma das APIs de picture-in-picture do Chromium existe — era o caso do erro "não consegui soltar a live";
- novo desenho do ícone de bandeja: silhueta de tomate com o telefone em negativo, geometria simétrica, legível a 24 px;
- a marca no topo da barra lateral ocupa a faixa inteira;
- a auditoria de dependências do CI tolera indisponibilidade do registro npm, que reprovou a primeira build desta versão.

## 0.6.0 — estabilidade real da live, áudio previsível e interface redesenhada (afetada)

> **Aviso:** na v0.6.0 as dicas de bitrate não chegavam ao encoder, então a live ainda abria borrada; os seletores nativos abriam com as opções em branco no Linux e a live solta escurecia ao receber foco. Use a v0.7.0.

**Transmissão e enlace**

- a live abre já no perfil escolhido: as dicas de bitrate (`start`/`min`/`max`) passaram a viajar na SDP e o controlador adaptativo ignora a estimativa de banda nos primeiros dez segundos, quando o Chromium ainda sobe a partir de ~300 kbps — antes ela abria borrada e levava mais de um minuto para melhorar sozinha;
- a recuperação de enlace virou uma escada: primeiro ICE restart, que preserva o decodificador do espectador, e só depois de duas tentativas a reconstrução completa da conexão; derrubar a `RTCPeerConnection` era o que causava a tela preta e a saída da call em série;
- as estatísticas de "sem tráfego" só valem com o enlace conectado e fora da janela de doze segundos após uma recuperação, então uma renegociação normal deixou de ser lida como falha;
- uma faixa de áudio em `muted` (o que acontece em toda renegociação) não derruba mais o enlace depois de quatro segundos;
- o receptor deixou de avisar "live congelada" nos primeiros segundos da transmissão, quando o decodificador apenas espera o keyframe — esse aviso fazia o transmissor reduzir a resolução logo na abertura;
- perfis de 30 FPS ou menos passam a priorizar resolução (`detail` + `maintain-resolution`) e os de 60 FPS continuam priorizando fluidez;
- a câmera ganhou teto próprio de bitrate para não disputar a banda reservada à live.

**Áudio**

- todo o áudio de saída passa por um único `AudioContext`. A versão anterior criava um por participante, mais um por live, mais o monitor de fala, mais os sons de feedback: em uma call com duas pessoas e uma transmissão o limite do Chromium estourava, `new AudioContext()` passava a lançar dentro de um efeito do React e a árvore inteira caía;
- o botão de mutar a live realmente muta: o controle deixou de ser um `<label>` ambíguo, o ganho vai a zero exato e a própria faixa recebida é silenciada, valendo para o palco, para a miniatura e para a janela flutuante;
- o filtro neural do microfone é monitorado: se o worklet WASM travar, o áudio volta pelo caminho simples em vez de sair mudo para quem ouve;
- entrar na call não é mais cancelado quando uma captura de microfone é substituída no meio do caminho.

**Dispositivos e qualidade**

- as entradas virtuais `default` e `communications` do Chromium saíram da lista de microfones — fim das opções duplicadas "Padrão" e "default" — e o mesmo hardware publicado por dois back-ends aparece uma vez só;
- as qualidades de transmissão passam a ser listadas em ordem crescente: 480p15, 720p30, 1080p30, 1080p60, 1440p30 e 1440p60.

**Interface**

- ícones desenhados na própria base, em uma grade única de 24 px com traço consistente, no lugar da biblioteca externa; nenhum emoji na interface;
- o botão de desconectar virou um botão de verdade, com área clicável, borda e estado de foco;
- a live pode ser solta em uma janela flutuante que fica sobre os outros aplicativos, com o Tumacord minimizado; o áudio, o volume e o mute continuam valendo para ela;
- acabamento geral de profundidade, bordas, foco e barras de rolagem mantendo a paleta original;
- uma falha de renderização não apaga mais a janela inteira: o erro fica contido na área afetada, a sessão continua e dá para tentar de novo sem relogar.

**Desktop**

- o renderizador que morre é recarregado automaticamente (até três vezes em cinco minutos) em vez de deixar a janela preta;
- o Chromium não estrangula mais timers e mídia com a janela minimizada.

## 0.5.0 — correção da transmissão e auditoria de estabilidade (afetada)

> **Aviso:** a v0.5.0 reconstrói o enlace WebRTC por sintomas passageiros, o que produz tela preta e saídas da call em sequência; a lista de microfones repete as entradas virtuais do Chromium e o botão de mutar a live não silencia. Use a v0.6.0.

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

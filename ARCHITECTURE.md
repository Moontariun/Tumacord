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

## Desenho sobre a transmissão — removido

Até a 0.9.8 era possível rabiscar por cima da transmissão de alguém. Isso
**saiu na 0.9.9**, e com ele saíram `shared/telestration.ts` e
`desktop/drawing-overlay.cjs`, que esta seção descrevia.

O motivo foi o desequilíbrio entre o que o recurso prometia e onde ele
funcionava: a sobreposição só se comportava no Windows. No Linux ela roubava o
foco do teclado de quem estava jogando e voltava para dentro da captura do
portal do PipeWire, de modo que o traço aparecia espelhado dentro do próprio
vídeo. Um recurso que só existe em metade das máquinas do grupo é um recurso
que ninguém combina de usar.

O desenho do Tumacord passou a ser a **mesa compartilhada**, abaixo: ela é
desenhada dentro do próprio aplicativo, não depende de live nem de call, e é
igual no Linux e no Windows.

## Mesa de desenho compartilhada

A mesa é o oposto do desenho sobre a live em quase tudo. Aquilo é apontamento — vive dentro do vídeo, tem prazo, e depende de uma janela sobreposta que só se comporta no Windows. A mesa é o trabalho: ela fica, ela é o motivo de estarem ali, e ela é desenhada dentro do próprio app, sem overlay e sem live, o que a torna igual no Linux e no Windows.

`shared/whiteboard.ts` é o modelo, e é puro: coordenadas de documento (a folha tem tamanho próprio, independente de qualquer janela), as operações, os limites e a função que aplica uma operação a um quadro. Zoom e deslocamento são estado local de quem olha; a folha é a única coisa compartilhada.

**Operação, e não imagem.** O que viaja é "traço tal, destes pontos, desta cor", em pedaços, conforme a mão anda — nunca um quadro inteiro a cada movimento. Cada pedaço leva um id próprio: é ele que faz a retentativa de uma reconexão não virar traço duplo.

**Revisão densa.** `server/whiteboards.ts` ordena: cada operação aceita ganha o próximo número, e **recusa não gasta número**. Com isso quem recebe separa três casos com uma comparação — a revisão esperada chegou (aplica), uma que já passou voltou (ignora), ou saltou (pede recuperação). Deduplicação e detecção de lacuna saem do mesmo lugar.

**Quem recebe não reavalia permissão.** A permissão foi decidida quando a operação foi aceita. Refazer a conta do lado de quem recebe faria os quadros divergirem — a borracha de quem gerencia a mesa, por exemplo, seria recusada por todo mundo, e o traço apagado reapareceria só na tela dos outros. `applyOrderedOp` existe para marcar esse contrato.

**Snapshot mais o que veio depois.** Entrar atrasado e reconectar são o mesmo caminho: "estou na revisão tal, me diga o que mudou". A resposta é a diferença, ou o quadro inteiro quando a pessoa ficou para trás do snapshot. Compactar troca *histórico* por snapshot — nunca traço por espaço — porque o snapshot já carrega tudo o que está visível.

**Nada some sozinho.** O desenho sobre a live guarda 64 traços e descarta o mais antigo; aqui o teto recusa a operação nova com uma mensagem e preserva o que está na folha. Desfazer age sobre um objeto identificado e do próprio autor, nunca sobre "o último item da lista".

No dedicado, as mesas são gravadas no arquivo do servidor. A gravação é na borda de subida — a primeira mudança vai ao disco na hora, e as seguintes são juntadas numa janela de meio segundo —, mais uma descarga no encerramento. Adiar também a primeira seria apostar num encerramento gracioso que nem todo sistema oferece: no Windows um processo morto por `kill` não passa por manipulador nenhum. Assim, o pior caso de uma queda sem aviso é meio segundo de traço em cima de uma mesa já gravada, e não a mesa inteira. No P2P nada é gravado: quem ordena é o host, e a mesa atravessa a troca de host porque quem estava nela devolve o snapshot ao servidor novo. Essa devolução é recusada por um servidor dedicado e exige, no P2P, que quem entrega esteja na call daquele host agora.

## Atualização do aplicativo

A fonte é o **serviço de atualizações desta instalação**, na mesma VPS do servidor dedicado — e não o GitHub. O aplicativo não consulta o GitHub nem para verificar, nem para baixar, nem para aplicar.

A origem vem do ambiente, de um arquivo local ou da build (`desktop/update-origin.cjs`), e nunca da rede: uma origem que chegasse numa resposta de servidor seria um jeito de trocar de onde vem o código. O dispositivo precisa estar autorizado: um convite de uso único vira uma credencial só de download, guardada com `safeStorage` (`desktop/update-credentials.cjs`) e revogável pelo dono.

`desktop/update-check.cjs` recebe o catálogo e os manifestos já baixados e devolve uma decisão — sem rede e sem disco, para poder ser testada inteira: qual versão oferecer, se ela foi retirada, e qual artefato serve para o jeito daquela instalação (`linux-managed`, `linux-appimage`, `windows-installed`, `windows-portable`, `unknown`). Catálogo e manifesto são assinados com chaves de escopos separados, e a sequência do catálogo só anda para frente: um catálogo antigo reapresentado é recusado.

`desktop/update-source.cjs` é a parte que fala com a rede, e não segue redirecionamento. `desktop/updater.cjs` orquestra, e tem um caminho de aplicação por tipo de instalação. No Linux gerenciado ele repete o que o instalador faz — build nova em pasta imutável, troca atômica do atalho `current`, anterior apontada por `previous` —, o que permite atualizar sem interromper a call em andamento. No Windows o instalador é aberto com elevação (`desktop/windows-installer.cjs`): `spawn` não eleva, e um NSIS por máquina aberto sem elevação falhava com `EACCES` e derrubava o processo principal.

A procura acontece uma vez, na abertura, com a janela já de pé. Baixar e aplicar são cliques da interface (`src/components/UpdatePanel.tsx`); nada é automático. `update-state.json`, na pasta de dados do usuário, guarda as preferências da procura e a maior sequência de catálogo já aceita.

No servidor, quem troca a versão é o executor, descrito na seção *Atualizar o servidor pelo painel*, mais abaixo.

## Janela, bandeja e encerramento

Fechar a janela esconde; quem encerra o aplicativo é o item **Sair** do menu da bandeja. A distinção existe porque a janela é quem sustenta a call, a captura de tela e a live flutuante: destruí-la e recriá-la derrubaria a sessão de mídia de quem só queria tirar a janela da frente. Até a 0.9.1 fechar destruía a janela, `window-all-closed` chamava `app.quit()` e o ícone da bandeja ia junto — ele existia sem nunca ter um aplicativo vivo para trazer de volta.

A decisão mora em `desktop/tray-policy.cjs`, separada do Electron, porque é uma decisão e se testa sem abrir janela nenhuma. Um marcador ligado em `before-quit` é o que autoriza a janela a fechar de verdade — é por ele que passam tanto o **Sair** quanto o reinício da atualização. No macOS a regra é outra, e continua sendo a do sistema: fechar a janela fecha a janela, e `activate` reabre.

A pasta de downloads da atualização (`updates`, dentro dos dados do aplicativo) é varrida na abertura e depois de cada aplicação. Um pacote passa dos noventa megabytes, e três caminhos deixavam um para trás: o instalador do Windows, que não pode ser apagado enquanto roda; o download que ninguém aplicou, já que a fase não sobrevive ao fechamento; e a sobra de uma tentativa interrompida. A varredura guarda só o arquivo que ainda pode ser aplicado, nunca toca em download em andamento, e o que estiver em uso some na abertura seguinte.

## Replicação pessoal

Mensagens e perfis são mesclados entre os computadores online. Perfis usam o nome normalizado como identidade P2P e `updatedAt` como revisão: avatar, banner, bio e cor mais recentes vencem. As mídias de perfil são publicadas no host atual e baixadas para o servidor embutido de cada desktop, permitindo que qualquer participante assuma como host sem voltar para uma foto antiga.

## Identidade no P2P

No dedicado a conta é uma só, e o servidor decide. No P2P cada computador tem o próprio servidor embutido, e a troca de host faz todo mundo autenticar de novo no de quem assumiu. Até a 0.9.9 a conta nascia lá com a senha de quem chegasse primeiro — e, como no P2P a identidade de uma mensagem é o nome normalizado, com ela vinha o direito de editar e apagar as mensagens de outra pessoa.

Cada desktop tem um par Ed25519 (`desktop/identity-key.cjs`), guardado pelo chaveiro do sistema e, sem chaveiro, num arquivo com permissão 0600 — o que é dito. A página nunca assina nada: ela pede ao processo principal, por campos, uma prova de login, um claim ou uma liberação. O texto assinado é montado lá, com um domínio por propósito, pelas regras de `shared/identity.ts`, que o gerador entrega ao processo principal em CJS. Um arquivo ilegível ou um chaveiro que não abre deixam a identidade indisponível e dizem por quê; gerar outra chave por cima tiraria da pessoa o próprio nome, sem aviso.

O grupo de um claim é o SHA-256 da chave do convite, e não a chave. O login P2P pede um desafio de uso único, amarrado ao nome e ao grupo. Com o nome livre, o cliente manda também o claim, e o host só dá sessão depois de gravá-lo e conferir que ele ficou como titular: dois logins simultâneos pelo mesmo nome saem com um dono só.

A precedência entre dois claims do mesmo nome é `firstSeenAt`, carimbado por cada host ao receber, e não o `issuedAt` assinado: atrasar o relógio não compra um nome. Dois dispositivos que reivindicaram o mesmo nome com o grupo dividido deixam o nome em disputa, e a disputa não é resolvida em silêncio — entra quem o host viu primeiro, marcado como provisório, e o outro é recusado até alguém liberar. Uma liberação assinada fica guardada para sempre; sem ela, o claim antigo voltaria por reapresentação.

Os registros viajam à parte do chat, nos eventos `identity:push` e `identity:records`, em páginas pela sequência de chegada de cada host. Cada cliente guarda o que vê no próprio servidor embutido, e é isso que faz um host novo já conhecer os nomes quando a troca cai nele. Um host anterior a esta versão não responde a esses eventos e não anuncia `identityClaims`; um aplicativo anterior continua entrando com um nome livre e é recusado, com o motivo, num nome que já tem dono.

A senha continua sendo de cada host, e ela só cede ao titular confirmado de um nome: uma conta criada num host por outra pessoa, antes de o claim chegar, não tranca o dono para fora. Um titular provisório não tem esse poder.

O que isto **não** cobre: o perfil replicado — foto, bio e cor — continua decidido pelo nome e pela data, sem assinatura.

## Interface: o que a tela diz, e onde

A regra do projeto, a partir da 0.9.8: **texto explicativo não fica ao lado do
controle**. Um botão, uma caixa de marcar ou um campo carrega o nome da coisa;
a explicação, quando existe, vive na dica que aparece com o ponteiro parado
(`title`). Um aplicativo de conversa não é um tutorial, e um parágrafo embaixo
de cada opção faz a tela crescer até precisar de rolagem para entrar.

O que isso quer dizer na prática:

- o rótulo diz **o que é**, em uma a três palavras, sem repetir o ícone;
- a dica diz **o que acontece** ou **onde aquilo fica guardado**, em uma frase;
- nada de `<small>` embaixo de botão, de caixa de marcar ou de campo;
- avisos permanentes (segurança, estado da conexão) viram uma linha curta com
  ícone, não um cartão com título e parágrafo;
- o que só interessa depois de um erro aparece **depois do erro**, não antes.

A tela de entrada é o exemplo: ela era uma coluna só, e em servidor dedicado com
contas guardadas media 420 × 1325 px — rolagem numa janela de 800 px de altura.
Agora são duas colunas, 860 × 448 px, sem rolagem; o texto que explicava cada
campo continua todo lá, no ponteiro.

## Contas guardadas neste computador

A coluna esquerda da entrada lista o que `keyring.ts` lembra, por destino. Cada
linha traz a foto do perfil daquela sessão, uma pastilha dizendo se ela é **P2P**
ou de **servidor** dedicado, e um **x** que esquece aquele destino — sessão e
chave —, com uma confirmação antes, porque não há como desfazer.

O modo vem escrito porque o nome não o carrega: `originLabel` devolve modo e
lugar separados justamente para a tela poder dizer os dois. `describeOrigin`
devolve a mesma coisa por extenso ("no servidor dedicado Casa do Tuma"), para
caber no meio de uma frase — a confirmação e as dicas usam essa forma.

O *lugar* de um grupo P2P **não** é o `serverName`. No P2P o servidor é o
embutido de quem hospeda, e ele só se chama outra coisa se alguém definiu
`SERVER_NAME`; o padrão é "Tumacord", igual em todo grupo, e usá-lo dava a
todos os grupos o mesmo nome. Um grupo é "Rede local" ou "Por convite", e um
nome escolhido de verdade continua valendo. No dedicado o nome vale sempre,
porque lá quem hospeda o escolheu.

A foto não vem do endereço relativo que o resto do app usa: na entrada não há
sessão aberta, e esse endereço não aponta para lugar nenhum. `SavedAvatar`
tenta primeiro o que este computador já baixou (`/api/local/attachments`, que
funciona com o host do grupo desligado) e depois o servidor daquele destino.
Falhando as duas, vale a inicial do nome — um círculo vazio seria pior.

## Mensagens depois de enviadas

Editar e apagar valem para o autor, e a conferência é do servidor — esconder o
botão é conveniência, não permissão. No P2P a identidade é o apelido
normalizado, e não o `id`: cada host tem o próprio cadastro, e sem isso trocar
de host tirava de você o direito de apagar as suas mensagens.

A parte difícil é a replicação. O merge antigo olhava só o `id` — quem já
conhecia a mensagem ignorava a que chegava —, e isso bastava enquanto uma
mensagem era imutável. Com edição e exclusão vira o pior comportamento
possível: quem apagou vê a mensagem voltar no primeiro pacote de quem ainda
tinha a cópia antiga.

`shared/messageSync.ts` resolve com uma revisão por mensagem: **quem tem mais
revisão vence**. Apagar é uma revisão como outra qualquer, e é daí que vem a
prioridade — não de um tratamento especial, mas de ser sempre mais nova que a
cópia guardada. A lápide fica no lugar do conteúdo, porque sem ela não há como
distinguir "foi apagada" de "ainda não recebi", e é a segunda leitura que
ressuscita. O que a lápide não guarda é o texto nem o anexo.

A regra vale nos três lugares por onde uma mensagem passa: o histórico do
servidor (`mergeMessages`), o espelho local de cada computador (`mergeMirror`)
e a lista em tela (`mergeVisible`). Valesse em dois, o terceiro desfaria.

## Atualizar o servidor pelo painel

É a ação mais perigosa do projeto — ela troca o código que está rodando —, e
por isso está cercada em camadas, nenhuma delas na interface:

- **desligada por padrão.** `TUMACORD_SELF_UPDATE=1` é uma decisão de quem
  hospeda. Um servidor que ganhou esta versão não passa a aceitar troca de
  código porque atualizou;
- **é do dono.** Administrador cuida de canais e de gente;
- **quem aplica está fora do contêiner.** O chat não executa nada: ele pede ao
  executor (`tools/tumacordctl/executor.mjs`), um serviço systemd no host. Um
  contêiner não reconstrói a si mesmo, e montar o socket do Docker dentro dele
  entregaria a máquina a quem comprometesse o chat;
- **a conversa é por socket Unix.** O executor escuta num socket que o
  `docker-compose.executor.yml` monta no chat. Não há porta para alcançar pela
  rede, e o executor recusa subir com o socket no mesmo ramo do diretório do
  estado, onde mora o segredo;
- **o navegador só manda uma etiqueta.** A lista vem do catálogo assinado do
  serviço de atualizações desta VPS, e não do GitHub. A etiqueta é conferida
  contra ela na leitura e de novo na hora de aplicar; o que segue para o
  executor é só o `releaseId`, e a referência de git é derivada lá, do
  manifesto assinado;
- **copia antes, valida depois.** A aplicação pausa a escrita e copia o volume
  antes de tocar no código, e só marca sucesso depois de conferir versão,
  commit e `installationId` pelo endpoint interno. Sem destino de cópia, o
  executor não aplica nada;
- **uma por vez, com estado em disco.** O lock é um arquivo criado com `wx`, e
  cada trabalho grava as etapas. A aplicação reinicia justamente o chat, e o
  painel retoma o trabalho do executor quando volta;
- **registrada antes de acontecer.** A tentativa entra na auditoria antes de
  qualquer coisa — uma atualização que derruba o servidor no meio não deixaria
  rastro se o registro viesse depois.

## Sons

Sintetizados na hora, sem arquivo de áudio: o Tumacord não embarca som de
ninguém. Até a 0.9.8 era um oscilador por nota ligado a um ganho, o que toca a
nota certa e soa como bipe. Desde a 0.9.9 cada nota é uma pilha de parciais
levemente desafinados, com um filtro que fecha conforme ela decai, um sopro de
ruído no ataque e um envio para uma cauda de reverberação gerada por código —
os quatro pedaços que separam "instrumento" de "frequência ligando".

Os eventos que soavam iguais deixaram de soar: silenciar o microfone e fechar o
ouvido são coisas diferentes, e você entrando na call não é a mesma notícia que
alguém entrando nela. Os níveis foram medidos no aplicativo, e estão em
`docs/QA.md`.


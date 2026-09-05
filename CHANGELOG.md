# Histórico de versões

## 0.8.2 — a imagem do relay existe, e atualizar o servidor virou um comando

- **`coturn/coturn:4.6-alpine` não existe.** A numeração do coturn saltou de 4.5 para 4.17, e a tag inventada na 0.8.0 só apareceria na máquina de quem fosse hospedar, como `manifest unknown` no primeiro `docker compose --profile turn up`. Passa a usar `4.17-alpine`, e um teste trava o formato para a próxima tag errada falhar no CI e não na produção de alguém;
- **`scripts/update-server.sh`** faz, nesta ordem: backup do volume, atualização, conferência. A ordem não é estética — procurar o backup depois do problema é tarde. Ele para se houver alteração local no `docker-compose.yml`, porque quem trocou a imagem do relay ou ajustou uma porta precisa saber antes; mantém o relay subindo apenas se ele já estava; e, quando o servidor não responde em sessenta segundos, imprime o caminho de volta e o de restauração em vez de deixar alguém procurar;
- ele nunca usa `docker compose down -v`. Há teste conferindo isso, e a verificação precisou distinguir o comando da explicação sobre o comando — o script documenta justamente que não o usa;
- funciona também por `curl … | bash`, que é como alguém o executa da primeira vez, antes de tê-lo em disco.

## 0.8.1 — estabilidade de mídia auditada e um painel de administração de verdade

**O bug do microfone: o que a medição derrubou**

- a suspeita era que o cancelamento de eco do Chromium precisasse de uma referência de reprodução já aberta, e que abrir o Discord fornecesse isso sem querer. **A hipótese está falsificada.** `scripts/diagnose-microphone.cjs` mede a energia que realmente entra, em oito combinações — eco ligado e desligado, com e sem saída ativa antes, com e sem filtro neural, e cinco ciclos seguidos. Em Fedora 44 com PipeWire 1.6.8, as oito capturaram sinal. O nó do PipeWire sai de `suspended` sozinho;
- isso deixa captura e processamento fora de suspeita e joga o defeito para as camadas seguintes — track, sender e peer —, que é onde os defeitos abaixo foram encontrados.

**Três defeitos de ciclo de vida, todos com a mesma assinatura: sinalizador de curta duração guardado como estado permanente**

- **`ignoreOffer` ficava travado.** Ele marca que descartamos uma oferta perdida em uma colisão — e, com ela, os candidatos ICE daquela geração. Só era desarmado em dois caminhos de sucesso. Bastava uma colisão sem resposta para todo candidato ICE seguinte daquele enlace ser descartado, e o enlace chegava a `connected` **sem mídia nenhuma** — o pior sintoma possível, porque a interface diz que está tudo bem. Agora ele cai quando a negociação volta a estável, por evento;
- **sair da call não zerava a saúde do microfone.** O orçamento de recapturas gasto na chamada anterior continuava gasto, deixando a recuperação automática desligada na seguinte — justamente quando alguém sai e volta por causa de áudio. E a marca de último sinal, velha, disparava uma recaptura espúria na entrada;
- **`onOffer` criava enlace depois de sair.** Era o único handler sem a verificação que os outros já tinham. Uma oferta em trânsito no instante da saída criava um `RTCPeerConnection` que ninguém mais fecharia.

**Mídia: uma pergunta, uma resposta**

- havia **três laços** aplicando faixas a peers, cada um com a própria regra de `addTrack` contra `replaceTrack`; qual caminho era tomado dependia de quem chegasse primeiro. `planPeerMediaSync` responde uma vez só, e o ciclo `start → stop → start → stop → start` virou teste — incluindo a verificação de que o número de senders não cresce;
- **reconciliação periódica**: a cada dez segundos o enlace é comparado com o estado atual da mídia local e reparado. Um enlace novo reconstrói o estado atual sem depender de ter presenciado o evento que o criou;
- **diagnóstico por camada** — captura, processamento, faixa, envio, enlace, recepção — apontando a primeira quebrada. "Sem medida" é estado próprio: sala silenciosa e captura morta deixam de ser a mesma coisa;
- **caminho ICE registrado**: direto por host, direto furando o NAT, ou pelo relay, com família do endereço e RTT.

**Segurança: quatro furos fechados antes de qualquer tela nova**

- `channel:create` **não verificava nada** — qualquer usuário autenticado criava canal no servidor dedicado;
- `chat:sync:push` era o segundo caminho para o mesmo estrago, por sincronização;
- `/api/peer/attachments` entregava arquivo **sem pedir login**. A rota nasceu para a troca entre pares no P2P; no servidor dedicado ficava aberta na internet, enquanto a mesma rota autenticada exigia sessão;
- **doze senhas erradas seguidas levavam 595 ms e nenhuma barreira.** O limite agora é por par usuário/origem — só por IP puniria um NAT compartilhado, só por usuário permitiria distribuir entre máquinas;
- e o que mais incomodava na prática: **o histórico do P2P era enviado ao servidor dedicado em toda conexão**, guardado lá e distribuído a todos. A replicação existe para o P2P; fora dele, não.

**Papéis: owner, admin, member**

- ser administrador era ter o nome igual a uma variável de ambiente. Promover alguém exigia reiniciar o contêiner, e mudar a variável trocava silenciosamente quem manda no servidor;
- a regra que sustenta o resto: **um servidor nunca fica sem dono.** Toda operação que zeraria a contagem é recusada, inclusive um dono tentando se rebaixar sendo o último. E só dono mexe em dono;
- a migração usa a variável uma vez, para eleger o dono inicial, e depois ela perde o poder: apontá-la para outra conta amanhã não promove ninguém.

**Painel de administração**

- quatro áreas: visão geral, canais, usuários e registro;
- canais ganharam categoria, posição, tópico e limite de pessoas — todos opcionais, para instalações da 0.8.0 carregarem sem conversão;
- ordenação por inteiro esparso: dois administradores arrastando ao mesmo tempo produzem uma ordem inesperada, **nunca um canal perdido**;
- o último canal de texto não pode ser apagado, e apagar categoria **solta** os canais em vez de levá-los junto;
- **registro de auditoria**, incluindo as ações recusadas — são elas que explicam por que algo não funcionou. A redação corta o que parece segredo e prefere apagar demais a deixar passar;
- toda ação sem volta pede confirmação dizendo o que vai acontecer, em vez de um "tem certeza?" genérico;
- nada na interface autoriza nada: o mesmo pedido feito à mão continua recusado.

**Compatibilidade**

- `/api/health` passou a declarar `capabilities`. Comparar versão como texto responde a pergunta errada — uma instalação parada ou um fork quebram a dedução. O cliente novo em servidor antigo diz o que falta e o que fazer, em vez de dar erro sem explicação.

## 0.8.0 — servidor de encontro e relay TURN: a call deixa de depender de alguém ser alcançável

**O problema que sobrava**

A 0.7.9 tirou o ZeroTier do caminho, mas manteve uma exigência: alguém precisava aceitar conexão vinda da internet, seja por IPv6, seja por uma porta aberta no roteador. Um teste real mostrou os três jeitos falhando de uma vez — um lado sem IPv6 nenhum, o outro com um UPnP que dizia ter aberto a porta e não abriu. Não havia código que resolvesse: sem endereço alcançável, não há o que furar.

**A inversão**

- **servidor de encontro.** Os dois lados abrem conexão *de saída* até ele, exatamente como abrir um site — e é isso que atravessa CGNAT, porque a internet nunca precisa iniciar uma conexão para dentro da casa de ninguém. Ele é o mesmo contêiner que já existia como "servidor dedicado"; o que mudou é que agora o convite sabe apontar para ele;
- **o convite deixou de carregar endereço de máquina.** Nesse modo ele leva só a call e o segredo que dá direito de entrar. Quem recebe não precisa de porta aberta, UPnP, IPv6 nem ZeroTier;
- um convite indica **um jeito só** de entrar. Misturar encontro e enlace direto no mesmo grupo partiria a call em duas, cada metade sinalizando em um lugar diferente;
- o campo de convite passou a valer também na tela de entrada em modo servidor: colar o código leva ao lugar certo sozinho, sem escolher modo nem digitar endereço.

**Relay TURN**

- **coturn entrou no `docker-compose`**, atrás do perfil `turn`. Ele é a rede de segurança para o caso em que nem o ICE atravessa: os dois lados em CGNAT simétrico. Fica fora do padrão porque só faz sentido em máquina com IP público e é a única peça que chega a carregar mídia — e, portanto, banda;
- as credenciais são temporárias, no esquema `use-auth-secret`: o servidor assina um prazo com o segredo compartilhado e o coturn recalcula o mesmo HMAC. Nenhuma senha é armazenada dos dois lados, e uma credencial que vaze deixa de valer no prazo. A renovação acontece com cinco minutos de folga, para não vencer no meio de uma reconexão;
- a mídia continua cifrada de ponta a ponta por DTLS-SRTP. O relay encaminha datagramas opacos: ele sabe que dois endereços trocam bytes, não o que os bytes dizem;
- **um relay que aceita qualquer destino vira uma porta para a rede interna de quem o hospeda.** As faixas privadas, de loopback, de CGNAT e de multicast ficam proibidas como destino;
- `/api/turn` exige sessão. Um relay aberto seria usado por quem passasse na frente.

**O que não mudou**

- caminho direto continua tendo preferência, e não por lógica nossa: o ICE compara candidatos por prioridade e um par direto sempre vence um par por relay. O relay entra quando nenhum direto se forma, e sai de cena se um direto aparecer depois;
- rede local continua se descobrindo sozinha, sem servidor nenhum no meio;
- ZeroTier continua sendo opção, não exigência;
- quem não quiser manter servidor algum continua com o enlace direto da 0.7.9, que resolve boa parte dos casos.

## 0.7.11 — o botão de copiar o convite volta a copiar

- **o processo principal negava a permissão de escrita na área de transferência.** Ele autorizava só `media` e `display-capture`, e `navigator.clipboard.writeText` precisa de `clipboard-sanitized-write`: a promessa era rejeitada e o botão não fazia nada. A leitura da área de transferência continua negada — colar um convite é uma ação da pessoa, e o aplicativo não precisa ler o que está copiado;
- além de autorizar, o botão ganhou uma reserva: se a escrita direta falhar por qualquer motivo, o campo é selecionado e a cópia sai pelo caminho antigo, que não passa por permissão. Quando as duas formas falham, o aviso diz que o texto ficou selecionado e pede Ctrl+C, em vez de falhar em silêncio.

## 0.7.10 — o código de convite para de mudar sozinho

- **o convite era remontado a cada quadro da interface.** O código saía do corpo do render e carimbava `issuedAt` com o relógio a cada chamada; como a tela da call re-renderiza a cada atualização de ping e de participantes, o texto inteiro mudava várias vezes por segundo. O prazo sempre foi de doze horas e um código antigo nunca deixou de funcionar, mas era impossível acreditar nisso olhando para a tela — e o valor mudando embaixo da seleção atrapalhava até copiar;
- agora o convite é gerado uma vez e guardado. Enquanto a call, a chave e os endereços de entrada forem os mesmos, é o mesmo texto: reabrir a janela mostra o código de novo, e o que já foi enviado continua valendo. Um endereço novo — a porta que o roteador abriu, por exemplo — gera um convite novo, como deve ser;
- a renovação acontece só quando falta menos de uma hora para vencer, para ninguém receber um código que expira no bolso.

## 0.7.9 — P2P sem ZeroTier, instalação no Fedora e microfone que se recupera sozinho (afetada)

> **Aviso:** nesta versão o código de convite era regerado a cada atualização da tela e parecia mudar sozinho. Corrigido na v0.7.10.

**Enlace direto: a call sem ZeroTier**

- **a lista de servidores ICE estava vazia.** Sem ela o navegador só oferecia o endereço da própria interface, e por isso a call exigia que todo mundo estivesse na mesma rede — na prática, dentro do ZeroTier. Com STUN o Chromium aprende o endereço público, gera candidato refletido e fura o NAT sozinho, inclusive boa parte do CGNAT. A mídia continua cifrada de ponta a ponta por DTLS-SRTP e não passa por servidor nenhum: o STUN só informa o endereço;
- **o servidor embutido passou a escutar em `::`**, o que abre a entrada por IPv6 na mesma porta. É o caminho mais limpo justamente para quem está atrás de CGNAT, onde o IPv4 nunca aceita conexão de fora. Em um sistema sem IPv6 a abertura volta para IPv4 sozinha, em vez de o servidor não subir;
- o aplicativo pede uma porta ao roteador por **PCP, NAT-PMP e UPnP**, nessa ordem. O PCP vem primeiro porque é o único que uma operadora pode atender no próprio equipamento de CGNAT; o UPnP vem por último por ser o mais lento, ainda que seja o mais comum nos roteadores domésticos. A regra é renovada na metade do prazo e devolvida ao fechar o app;
- **convite em vez de rede virtual.** O host gera um código com os caminhos por onde aceita entrada e a chave que protege a porta; quem recebe cola e entra. Os caminhos são tentados em paralelo, com a rede local primeiro, IPv6 depois e o IPv4 mapeado por último — o primeiro que responder vence;
- **a porta exposta à internet exige o convite.** Quem chega de um endereço da própria rede continua entrando sem nada, como a descoberta por broadcast sempre fez; de fora, sem a chave, a API inteira responde 403. O host ainda devolve um HMAC do nonce, para o convidado conferir que alcançou a call certa e não um endereço que trocou de dono;
- a chave é da call, não da máquina: quem entra por um convite passa a aceitá-lo também, e por isso a troca automática de host não invalida o código que já circulou;
- **quem assume a call quando o host sai passou a ser escolhido pelo alcance**, e não só pelo menor ping. Um host rápido e inalcançável deixava a call inteira sem porta de entrada.

**ZeroTier virou opção**

- em **Configurações › Rede e conexão** há agora uma chave para ligar ou desligar o ZeroTier. Desligado — o padrão —, o adaptador dele fica fora da descoberta e da call; ligado, tudo funciona como antes. Também dá para desligar a travessia por STUN e a abertura de porta no roteador;
- a mesma tela mostra o diagnóstico de alcance deste computador: IPv6 disponível, CGNAT, se o NAT é atravessável e qual porta foi aberta.

**Instalação**

- **o instalador recusava qualquer distribuição sem `pacman` na primeira linha**, e era exatamente isso que fazia o comando do README falhar no Fedora. Agora ele reconhece `dnf`/`dnf5`, `pacman`, `apt-get` e `zypper`, e traduz os nomes dos pacotes de cada uma (`pipewire-utils` no Fedora, `pipewire-audio` no Arch, `pipewire-bin` no Debian);
- se faltar uma biblioteca do Electron, o instalador percebe pelo `ldd` e instala o conjunto certo da distribuição, em vez de deixar o aplicativo simplesmente não abrir;
- o auxiliar de sandbox do Chromium perde o bit setuid quando ele não pertence ao root — situação normal em uma build feita pelo usuário e outro motivo para o app não abrir no Fedora;
- `install-cachyos.sh` e `uninstall-cachyos.sh` continuam existindo como atalho para os nomes novos, `install-linux.sh` e `uninstall-linux.sh`.

**Microfone**

- **a fonte virtual da live podia virar o microfone padrão do sistema.** Ela entra no grafo do PipeWire como qualquer outra fonte, e o gerenciador de sessão a promovia a padrão: quem estava com "Padrão do sistema" parava de ser ouvido no instante em que começava a transmitir. Os nós da live agora pedem prioridade zero e, se ainda assim forem promovidos, o padrão anterior é devolvido;
- **uma faixa de microfone pode parar de entregar som sem nunca terminar.** O `readyState` continua `live`, o `enabled` continua `true`, e só quem escuta percebe. O aplicativo passou a tratar os três casos: a faixa marcada como `muted` pelo sistema, o dispositivo padrão que virou outro aparelho e a captura que abre sem receber amostra nenhuma;
- energia exatamente zero é falha de captura e é reconhecida em três segundos; energia baixa é sala quieta e continua com a janela de vinte e cinco segundos. Em vez de só avisar, o Tumacord refaz a captura sozinho — que é exatamente o que trocar o dispositivo à mão fazia. São no máximo três tentativas, com intervalo entre elas, e o aviso só aparece se nenhuma resolver;
- **refazer a captura com a mesma preferência não fazia nada:** havia um atalho que devolvia o fluxo quebrado quando o dispositivo escolhido não mudava. Era por isso que a única saída era trocar de dispositivo e voltar;
- a saída do `pactl` passou a ser lida com `LC_ALL=C`. Em português os campos vêm traduzidos e o leitor preso ao inglês não enxergava nada.

## 0.7.8 — menos piscadas na transmissão e volume por pessoa funcionando

**Artefatos e piscadas na live**

- **a própria adaptação era a origem das piscadas.** Toda mudança de `scaleResolutionDownBy` obriga o encoder a se reconfigurar: sai um keyframe e, com ele, um quadro visivelmente quadriculado. Com uma amostra a cada dois segundos e um controlador que muda de ideia com frequência, isso virava piscada constante — e a 0.7.7, ao acelerar a volta da resolução, aumentou o número dessas reconfigurações. Agora a escala só se move quando a diferença importa (0,2 ou mais) e depois de segurar doze segundos; um salto grande, que indica aperto real, continua imediato;
- o teto de bitrate era reaplicado por diferenças de 50 kbps — 0,6% em um perfil de 8 Mbps, ou seja, ruído. Passou a exigir 10% de diferença;
- o estado do encoder passou a guardar o que foi realmente aplicado, e não o que o controlador gostaria de aplicar. Sem isso, a decisão seguinte partiria de um valor que o encoder nunca recebeu.

**Volume de cada pessoa na call**

- **o controle não fazia efeito porque cada faixa tinha o próprio limitador**, com limiar de −1,5 dBFS e razão 20:1. Na prática isso devolvia 0,9 dB de diferença entre 100% e 200%: a metade de cima do controle não existia, e a de baixo vinha achatada. O limitador saiu de cada faixa e virou um só, no fim da mistura, apenas para impedir estouro;
- mídia sem dono identificado caía no volume padrão e ignorava o ajuste. Agora o participante é resolvido pela lista da call quando o enlace ainda não trouxe o perfil.

**Interface**

- os participantes na barra da esquerda não mostram mais o ping; essa informação vive na lista de presença, à direita.

## 0.7.7 — a live para de embaçar sozinha, e o palco responde melhor

**Estabilidade da imagem**

- **tela parada deixou de ser lida como congestionamento.** A estimativa de banda do Chromium não mede a capacidade do enlace em abstrato: ela cresce a partir do que realmente sai. Com a tela parada o envio despenca e a estimativa junto — e o controlador cortava o teto até o piso (960 kbps em um perfil de 8 Mbps). Bastava a cena voltar a se mexer para a live aparecer borrada, com ping baixo o tempo todo, e ainda levava vários segundos para subir de novo. Agora a estimativa só pesa quando estamos de fato usando o teto; perda e latência continuam valendo sempre;
- **o encoder deixou de ser dado como atrasado em cena normal de jogo.** A 60 FPS o orçamento é de 16,7 ms por quadro, e a marca de pressão estava em 13,7 ms — fácil de encostar sem que nada esteja errado. A pressão agora só conta ao encostar no orçamento inteiro;
- a resolução caía em duas amostras e voltava em seis, de 0,15 em 0,15: um engasgo isolado custava quase um minuto de imagem borrada. A volta passou a ser em três amostras, de 0,25 em 0,25.

**Palco**

- clicar duas vezes na transmissão amplia dentro do app e clicar de novo volta à grade;
- na tela cheia real o botão de voltar à grade fica desabilitado, em vez de responder sem efeito;
- o painel de volume individual fecha ao clicar fora dele ou com Esc.

**Texto**

- as menções a "turma" saíram do aplicativo e da documentação; onde fazia falta, agora se lê "grupo".

## 0.7.6 — soltar a live volta a funcionar e a bandeja usa a marca colorida

- **soltar a live parou de funcionar na 0.7.5.** Ao dar um nome próprio para a janela de cada mídia, o processo principal continuou autorizando apenas o nome exato `tumacord-live`: toda tentativa era negada e sobrava o aviso de que não deu para soltar. Agora qualquer janela da família `tumacord-live…` é autorizada, e tela e câmera podem sair juntas, cada uma na sua;
- o ícone da bandeja passou a ser o logo oficial do Tumacord, colorido — o mesmo do menu de aplicativos. A variante em preto e branco foi descartada.

## 0.7.5 — rodapé refeito, presença com ping e marca oficial na bandeja (afetada)

> **Aviso:** nesta versão a opção de soltar a live foi negada pelo processo principal e não funcionava. Corrigido na v0.7.6.

**Rodapé da call**

- refeito do zero. Eram três grupos soltos, cada um com altura e alinhamento próprios; agora é um bloco único em três colunas, com os controles no centro exato do palco e o que é contextual acompanhando as bordas. Em palco estreito os rótulos somem antes de o bloco quebrar em duas linhas;
- **a barra de estado da malha saiu.** Ela ocupava espaço para oferecer um botão de reconectar que a recuperação automática já dispensa — o aplicativo continua reconstruindo enlaces sozinho, em silêncio.

**Presença**

- a lista da direita mostra o ping de quem está na call, ao lado do nome.

**Janela solta**

- o alfinete saiu: a barra de título do sistema já oferece "manter acima", e a janela continua abrindo acima das outras;
- cada mídia solta abre a própria janela. Com um nome só, soltar a câmera reaproveitava a janela da tela e o primeiro vídeo sumia;
- ampliar outro quadro não desmonta mais o quadro que está solto — antes isso levava a janela flutuante junto;
- se o quadro de origem foi remontado enquanto a janela estava aberta (uma reconstrução de enlace troca o MediaStream), o vídeo volta para o quadro que está em tela em vez de se perder;
- fechar o Tumacord fecha as janelas soltas, que desde a 0.7.4 não são mais filhas da principal.

**Bandeja**

- o ícone passou a ser a própria marca do Tumacord em preto e branco, derivada do logo oficial: a silhueta do tomate com o telefone vazado.

## 0.7.4 — microfone audível desde a abertura, alfinete que segura e rodapé sem sobreposição

**Microfone**

- **o microfone podia abrir mudo para os outros e só começar a funcionar depois de mexer nas configurações.** Sem um gesto do usuário o Chromium mantém o `AudioContext` do filtro neural suspenso: a faixa continua "live" e habilitada, mas o worklet não processa nada e só silêncio chega do outro lado. Trocar o dispositivo acontecia depois de um clique e por isso "consertava". Agora a captura confirma que o processamento está mesmo rodando e, se não estiver, cai na hora para o caminho simples — que não depende de contexto nenhum;
- o vigia do microfone passou a reconhecer um contexto suspenso. Antes ele comparava a energia antes e depois do filtro, e um contexto parado não move nenhum dos dois medidores: a falha ficava invisível para ele.

**Janela solta da live**

- **o alfinete não segurava a janela.** Uma janela aberta pela principal nasce como filha dela no Electron: acompanha a janela-mãe, some quando ela é minimizada e não consegue subir acima de outro programa. Agora ela é solta do pai assim que aparece, e o alfinete volta a valer;
- no aplicativo instalado a janela do Electron passou a ser a primeira opção, à frente do picture-in-picture do Chromium — só a janela do Electron aceita o alfinete;
- a câmera de quem está na call também pode ser solta em janela, com o mesmo alfinete.

**Rodapé da call**

- o seletor de qualidade saía por cima da borda da pastilha: o rótulo não encolhia e o seletor tinha largura mínima própria, então a soma passava do espaço disponível. Agora a pastilha dimensiona pelo conteúdo e nada escapa;
- os botões da call ficaram só com o ícone, em quadrados iguais. Os rótulos truncavam ("Ativar microf…") e agora vivem na dica de cada botão.

## 0.7.3 — a call volta ao que funcionava e a live solta ganha o alfinete

- **a "Call Geral" voltou ao comportamento da 0.7.1.** A mudança da 0.7.2, que fazia a call de quem está na rede aparecer dentro do canal de voz, não funcionou na prática e foi desfeita por inteiro: a seção "Calls na rede" está de volta no topo da barra lateral e entrar no canal volta a abrir a call deste computador. A descoberta também voltou a anunciar apenas a contagem de participantes;
- **a janela solta da live ganhou um alfinete.** O botão fica na própria janela e alterna entre mantê-la acima de todos os aplicativos — inclusive sobre um jogo em tela cheia — e deixá-la se comportar como uma janela comum. Ela abre fixada;
- o mudo e o volume por pessoa continuam valendo só para a voz, com a transmissão mantendo o próprio controle, e a lista de presença da direita continua sem reagir a quem está falando. Essas duas partes da 0.7.2 foram mantidas.

## 0.7.2 — a call de quem está na rede vira a call da turma (revertida)

> **Aviso:** a mudança da call da rede não funcionou na prática e foi desfeita na v0.7.3. O mudo por pessoa e a lista de presença sem piscar continuam valendo.

**A call da turma**

- a seção "Calls na rede" saiu. Quando alguém da rede local ou do ZeroTier está em uma call, ela aparece como a própria "Call da turma", já com as pessoas dentro — do jeito que o Discord mostra;
- clicar no canal de voz ou em "Entrar na call" leva para o host onde a turma está reunida. Antes isso abria a sala vazia do servidor local enquanto todo mundo conversava em outro host, e parecia que o botão não funcionava;
- o anúncio de descoberta passou a carregar a lista de participantes, e não só a contagem. O que chega pela rede é limpo e limitado antes de virar interface;
- migrar para a call de outra pessoa entra na conversa mesmo quando este cliente já havia retomado uma call antes.

**Áudio e presença**

- dá para silenciar uma pessoa sem silenciar a transmissão dela: o mudo e o volume individuais valem para a voz, e a live continua com o próprio controle;
- a lista de presença da direita não reage mais a quem está falando — isso é papel da barra da esquerda, junto da call.

## 0.7.1 — o instalador passa a entregar o que compilou

- **reinstalar a mesma versão não trocava o código.** O `install-cachyos.sh` identificava cada build pelo sha256 do executável do Electron, que é idêntico em toda compilação porque o código do Tumacord vive em `resources/app.asar`. A pasta da versão coincidia com a da instalação anterior, o script pulava a cópia e apenas reapontava o atalho `current` para a build velha: o instalador compilava tudo e descartava o resultado. Agora o identificador cobre também o conteúdo de `resources/`;
- por causa disso, quem instalou a 0.7.0 e reinstalou depois nunca recebeu as correções de áudio e da janela solta publicadas na sequência. Elas chegam nesta versão.

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

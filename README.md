# Tumacord 🍅

O Tumacord é um chat pessoal de voz, vídeo e texto para um grupo pequeno. Ele roda no seu próprio computador e envia a mídia diretamente entre os participantes com WebRTC — sem serviço no meio.

Na mesma rede as calls aparecem sozinhas, sem configurar nada. Para chamar alguém de fora, é preciso um servidor: o convite aponta para ele, e os dois lados chegam por conexão de saída. O ZeroTier continua disponível como opção que se liga nas configurações.

## Documentação

Este README é a entrada. Cada procedimento de operação mora num guia próprio,
e é lá que ele está completo — com plataforma, diretório, usuário, comando,
saída esperada, efeito sobre dados e chamadas, e o que fazer em cada falha.

| Guia | Para quê |
|---|---|
| [Instalação na VPS](docs/instalacao-vps.md) | subir o dedicado e o serviço de atualizações do zero |
| [Configuração](docs/configuracao.md) | cada variável, o que ela faz, e o que muda se faltar |
| [Atualização do servidor](docs/atualizacao-servidor.md) | trocar a versão em uso, validar e voltar atrás |
| [Backup e restauração](docs/backup-restore.md) | cópia consistente e restauração ensaiada |
| [Publicação privada](docs/publicacao-privada.md) | assinar, importar, promover e retirar versões |
| [Versionamento](docs/versionamento.md) | a convenção `0.9.9-1` e por que ela não é SemVer |
| [Solução de problemas](docs/solucao-de-problemas.md) | sintomas concretos e o que fazer |
| [QA da release](docs/QA.md) | o que foi testado, o que foi analisado e o que ficou pendente |
| [Compilar no Windows](docs/windows-build.md) | produzir os pacotes de Windows |
| [Testar no Windows](docs/windows-testing.md) | roteiro de verificação na máquina real |

Os documentos em `docs/` com prefixo `RELATORIO-` ou `AUDITORIA-` são
**históricos**: eles preservam a evidência da versão que os produziu e não
descrevem o comportamento de agora. Cada um diz isso no topo.

## O que já funciona

- cadastro e login explícitos com usuário + senha;
- no modo P2P, um único canal de texto e uma única call, sem botões ou canais redundantes;
- call de baixa latência em malha WebRTC;
- **enlace direto sem ZeroTier**: travessia de NAT por ICE/STUN, entrada por IPv6 e abertura de porta no roteador por PCP, NAT-PMP ou UPnP;
- **servidor de encontro opcional**, alcançado só por conexão de saída: funciona atrás de CGNAT sem abrir porta em lugar nenhum, e com relay TURN para o caso em que nem o ICE atravessa;
- convite em código que aponta o servidor da call e leva a chave de entrada;
- **mesas de desenho compartilhadas**: um quadro em branco dentro do app, criado por alguém e aberto a quem enxerga o canal — sem depender de live nem de call, e igual no Linux e no Windows. É o desenho do Tumacord: rabiscar por cima da transmissão de alguém saiu na 0.9.9;
- **editar e apagar mensagem**, com a mudança tendo prioridade na replicação do P2P: uma exclusão alcança quem estava offline, e a cópia antiga não a desfaz;
- **prévia antes de enviar**: a imagem escolhida aparece no compositor e só sai deste computador quando você aperta enviar;
- descoberta automática de calls na rede local, sem copiar IP;
- ZeroTier opcional, ligado ou desligado em **Configurações › Rede e conexão**;
- servidor completo embutido em toda instalação;
- o primeiro a entrar vira host; se ele sair, assume quem tem o melhor alcance de entrada — com o ping como desempate — e a sinalização migra automaticamente;
- câmera e live permanecem ativas ao reconectar ou quando outra pessoa sai e volta para a call;
- reconexão WebRTC automática com fila de candidatos ICE, renegociação pendente e reconstrução do enlace quando a rota da rede muda;
- diagnóstico da malha P2P na call, com estado por enlace, ping médio e botão para reconstruir todas as rotas sem sair da call nem encerrar a live;
- microfone a 48 kHz com cancelamento de eco, supressão neural GTCRN em WebAssembly, corte de ruído grave, compressor de voz e ganho automático;
- detecção e seleção de microfone, saída de áudio e câmera;
- câmera e compartilhamento de tela;
- ao clicar em **Transmitir tela**, o Tumacord primeiro pede qualidade e áudio e abre o seletor de tela/janela uma única vez;
- captura de áudio opcional na transmissão, com Tumacord, Discord e a voz da call sempre de fora para não devolver a chamada pela live — no Linux por um barramento temporário do PipeWire, no Windows por captura WASAPI por aplicação: transmitindo uma janela vai só o som daquela aplicação, transmitindo um monitor vai o som do sistema menos os aplicativos de chamada;
- aplicativo Windows com instalador NSIS e alternativa portátil, sem exigir Node, npm nem redistribuível do Visual C++ na máquina de quem instala;
- perfis 1080p60, 1440p60, 1440p30, 1080p30, 720p30 e 480p15, com preferência persistente e troca dinâmica durante a live sem recapturar nem selecionar a tela novamente;
- volume individual por participante e pela live, de 0 a 200%, com ganho real de até +18 dB e limitador contra estouro;
- dois modos para a live: **Ampliar dentro do app**, mantendo barras e controles, e **Tela cheia real**. A tela cheia da janela inteira ficou só no F11, sem botão na barra;
- **atualização pelo próprio aplicativo**, procurada a cada abertura e aplicada quando você quiser, com o que mudou aparecendo uma vez depois de cada versão nova;
- ao abrir o chat durante uma live, ela continua tocando em uma miniatura móvel e redimensionável, preservando mute e volume;
- layout responsivo para janela dividida: em meia tela a lista de membros recolhe, os controles compactam e múltiplas lives se empilham sem esmagar o vídeo;
- indicador **AO VIVO** no nome de quem transmite, recuperação visível quando a mídia atrasa e opção de sair apenas da live sem abandonar a call;
- mensagens mescladas entre os participantes online e guardadas localmente, de modo que alguém que entra depois recebe o histórico disponível;
- anexos de até 25 MB com prévia leve, download manual e opção de manter os arquivos completos sincronizados neste PC;
- perfis com avatar estático ou GIF, banner, descrição e cor personalizada, replicados entre os hosts pelo usuário e pela edição mais recente;
- **tela de entrada em duas colunas**: à esquerda a marca e as contas que este computador lembra, à direita o formulário — sem rolagem, com endereço e chave lado a lado e usuário e senha lado a lado, e virando uma coluna só em janela estreita;
- contas guardadas com a **foto do perfil** e um **x** para esquecer cada destino — a sessão e a chave dele —, com confirmação antes;
- login com escolha entre **P2P automático** e **Servidor dedicado**;
- opção **Continuar conectado**, inclusive após reiniciar o servidor dedicado. Entrar no Tumacord não entra na call: quem decide isso é você;
- **atualizar o servidor pelo painel do dono**, escolhendo entre as versões publicadas nas Releases — desligado por padrão, e descrito em [ARCHITECTURE.md](ARCHITECTURE.md);
- **dezessete sons próprios**, sintetizados no aplicativo e sem arquivo de áudio embarcado: entrar, entrar na call, alguém entrando ou saindo, mensagem recebida e enviada, aviso, erro, microfone, ouvido, transmissão, troca de host e versão nova — com volume configurável e um botão para ouvir cada um;
- microfone que se recupera sozinho quando o sistema silencia a faixa, troca o dispositivo padrão ou abre a captura sem sinal;
- aplicativo Electron instalável no Fedora, CachyOS/Arch, Debian/Ubuntu e openSUSE, e cliente web servido pelo contêiner dedicado;
- ícone no menu de aplicativos e na bandeja, com o Tumacord continuando em execução quando a janela é fechada: o ícone traz a janela de volta, e **Sair** é o único encerramento de verdade;
- versão instalada visível no login e nas configurações;
- **papéis de servidor** — dono, administrador e membro —, persistidos e com proteção contra deixar o servidor sem dono;
- **painel de administração** com quatro áreas: visão geral, canais, usuários e registro de auditoria;
- canais com categoria, posição, tópico e limite de pessoas, editáveis pelo painel e aplicados em tempo real;
- **diagnóstico de mídia por camada** — captura, processamento, faixa, envio, enlace e recepção — com botão de copiar sem token nem endereço;
- interface original inspirada na organização familiar de apps de comunidade, sem copiar a marca do Discord;
- **explicação no ponteiro, não ao lado do controle**: o rótulo diz o que a coisa é e a dica diz o que acontece, sem parágrafo embaixo de cada opção — a regra está em [ARCHITECTURE.md](ARCHITECTURE.md), na seção *Interface*.

## Instalação no Linux

O instalador atende **Fedora, CachyOS/Arch, Debian/Ubuntu e openSUSE**: ele reconhece o gerenciador de pacotes e traduz os nomes das dependências de cada distribuição.

### Pelo GitHub

Para instalar ou atualizar compilando o código mais recente:

```bash
curl -fsSL https://raw.githubusercontent.com/Moontariun/Tumacord/release/ja-volto-v0.12.0/scripts/install-v0.12.0.sh | bash
```

Este comando instala a v0.9.9-1 a partir da branch separada `0.9.9-1`. As versões anteriores permanecem isoladas em suas próprias branches e não devem mais ser usadas.

Até a 0.7.8 este comando falhava fora do Arch: o instalador recusava a máquina na primeira linha se não encontrasse `pacman`. Agora ele reconhece `dnf`/`dnf5`, `pacman`, `apt-get` e `zypper`, instala as dependências com o nome certo de cada distribuição (`pipewire-utils` no Fedora, `pipewire-audio` no Arch, `pipewire-bin` no Debian) e, se faltar alguma biblioteca do Electron, percebe pelo `ldd` e resolve antes de instalar.

O script baixa primeiro um bootstrap temporário e então clona/compila exatamente a branch `0.9.9-1`, sem cair na `main` e sem depender de um pipe aninhado. O clone permanece na pasta de Downloads configurada pelo sistema (por exemplo, `~/Downloads/Tumacord-0.9.9-1`). O instalador guarda cada build em uma pasta imutável dentro de `~/.local/share/tumacord/versions` e troca apenas o atalho `current`; por isso, atualizar enquanto o app está aberto não mistura arquivos nem interrompe a call. O atalho executável fica em `~/.local/bin/tumacord`, e o AppImage não participa da instalação nem da atualização. A versão anterior permanece apontada por `~/.local/share/tumacord/previous` para recuperação.

Para instalar outra branch, use o instalador genérico e passe o ref depois de `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/Moontariun/Tumacord/release/ja-volto-v0.12.0/scripts/install-from-github.sh | bash -s -- nome-da-branch
```

### Atualização pelo próprio aplicativo

A partir da 0.9.0 o Tumacord procura uma versão nova **toda vez que abre** e
mostra um botão na barra de cima quando encontra alguma. Ele para por aí:
baixar é um clique e aplicar é outro, na hora que você escolher. Nada é
instalado sozinho — trocar de versão no meio de uma call custaria a call.

No Linux instalado por este script, aplicar coloca a build nova em uma pasta
própria e troca só o atalho `current`, exatamente como o instalador faz: **a
call aberta não é interrompida** e a versão nova passa a valer ao reabrir. No
AppImage o arquivo é substituído no lugar. No Windows, o instalador da versão
nova é aberto e o Tumacord fecha para ele poder trabalhar; no portátil, o
executável novo fica guardado ao lado do atual, porque o Windows não deixa
substituir um `.exe` em uso.

Versões marcadas como retiradas — a **0.8.9** é uma delas — nunca são
oferecidas, e quem estiver rodando uma delas é avisado disso pelo aplicativo.

Procurar ao abrir pode ser desligado na própria tela de atualização; o botão de
procurar continua onde está. O comando de instalação acima e a página de
Releases continuam valendo e aparecem escritos dentro dessa tela.

**O que mudou, uma vez por versão.** Na primeira abertura depois de uma
atualização, o Tumacord mostra as notas daquela versão — o mesmo texto que está
na página de Releases do GitHub, que é para onde o CHANGELOG é publicado. Isso
vale para qualquer caminho de atualização: pelo botão, pelo comando de
instalação ou trocando o arquivo à mão. Fechar a tela é o que a marca como lida,
e ela não volta até a próxima versão.

O AppImage continua disponível como alternativa portátil nas **Releases** e nos artefatos de cada build do GitHub Actions. Ele serve para quem preferir baixar e executar um arquivo isolado, mas é opcional.

### A partir do código

No terminal, dentro desta pasta:

```bash
chmod +x scripts/*.sh
./scripts/install-linux.sh
```

É o mesmo comando em qualquer distribuição suportada. O instalador gera o diretório nativo do Electron, instala em `~/.local/share/tumacord` e cria o atalho do menu. Cada cópia já contém o servidor, o detector de calls, o enlace direto e o mecanismo de eleição de host. `./scripts/install-cachyos.sh` continua funcionando como atalho para o mesmo script.

Para remover o aplicativo e escolher interativamente se os dados locais serão apagados, execute:

```bash
./scripts/uninstall-linux.sh
```

Também é possível decidir diretamente:

```bash
./scripts/uninstall-linux.sh --keep-data
./scripts/uninstall-linux.sh --purge-data
```

`--purge-data` remove também contas locais, histórico, anexos, perfis, sessão e preferências em `~/.config/tumacord` e `~/.cache/tumacord`. O clone na pasta de Downloads é preservado para não apagar código sem confirmação separada.

## Instalação no Windows

Duas formas, e as duas contêm tudo: **não é preciso instalar Node, npm nem
nenhum redistribuível do Visual C++**.

### Instalador (recomendado)

Baixe `Tumacord-0.9.9-1-Setup.exe` nas [Releases](https://github.com/Moontariun/Tumacord/releases)
e execute. O instalador pede uma única confirmação do Windows (UAC), deixa
escolher a pasta e cria os atalhos no Menu Iniciar e na área de trabalho. O
Tumacord aparece em **Aplicativos instalados**, com desinstalador próprio.

Instalar uma versão nova por cima da anterior preserva conta, mensagens,
anexos, perfis e preferências. Se o aplicativo estiver aberto, o instalador
avisa e o encerra antes de continuar.

### Portátil

`Tumacord-0.9.9-1-portable.exe` roda sem instalar nada. É a opção para pendrive
ou para uma máquina onde não se pode instalar programas. Em troca, ele não cria
atalhos e **não configura o firewall** — a primeira vez que o Tumacord escutar
na rede, o Windows mostrará o próprio aviso, e é preciso marcar **Redes
privadas** e permitir para a descoberta de calls na rede local funcionar.

### Requisitos

- Windows 10 versão 2004 (build 19041) ou mais novo, **64 bits**;
- Windows 11 é a plataforma testada e recomendada;
- para transmitir com áudio isolado por aplicação, build 19041 é o mínimo
  absoluto. Abaixo disso a transmissão funciona **sem áudio**, e o aplicativo
  diz isso na tela.

### Como funciona o áudio da transmissão

Ao clicar em **Transmitir tela**, você escolhe a qualidade e se quer áudio, e
só então escolhe a janela ou o monitor. O que entra na live depende dessa
escolha:

- **uma janela** → só o som daquela aplicação. Você transmite um jogo e quem
  assiste ouve o jogo, e nada além dele;
- **um monitor inteiro** → o som do sistema, **menos** o Tumacord, o Discord
  (incluindo Canary e PTB) e os processos de áudio deles.

Em qualquer um dos dois casos, a voz das pessoas da call — a do Tumacord e a do
Discord — nunca entra na transmissão. Isso não é cancelamento de eco: essas
aplicações simplesmente nunca são capturadas. Quem está na sua call não vai
ouvir a própria voz voltando, e a pessoa com quem você fala no Discord não é
retransmitida para quem assiste.

O Tumacord **não** mexe no volume do Discord, não muta nada globalmente, não
troca o dispositivo de áudio padrão do Windows e não instala driver de áudio
virtual. Nada de VB-Cable, VoiceMeeter ou parecidos.

Se a sua versão do Windows não oferecer esse isolamento, você verá:

> Nesta versão do Windows, o áudio da aplicação não pode ser isolado com
> segurança. A transmissão continuará sem áudio.

Não há reserva nesse caso, e é de propósito: a única alternativa técnica seria
capturar o dispositivo inteiro, e é exatamente isso que devolveria a call para
dentro da transmissão.

### Firewall

O instalador cria duas regras no Windows Defender Firewall, presas ao
executável do Tumacord e válidas apenas nos perfis **Privado** e **Domínio**:

- `Tumacord - sinalizacao (TCP 3927)`;
- `Tumacord - descoberta na rede local (UDP 3928)`, limitada à sua sub-rede.

O perfil **Público** nunca é liberado, o firewall nunca é desligado, e nenhuma
porta é aberta para "qualquer programa". As regras são removidas quando você
desinstala. Para conferir ou remover à mão, em um PowerShell como
administrador:

```powershell
netsh advfirewall firewall show rule name="Tumacord - sinalizacao (TCP 3927)"
netsh advfirewall firewall delete rule name="Tumacord - sinalizacao (TCP 3927)"
```

### Assinatura e o aviso do SmartScreen

A build oficial é assinada com Authenticode quando o mantenedor tem um
certificado configurado — o instalador, o portátil, o executável principal e o
componente de áudio, todos com carimbo de tempo. Você pode conferir:

```powershell
Get-AuthenticodeSignature .\Tumacord-0.9.9-1-Setup.exe | Format-List Status, SignerCertificate
```

`Status` precisa ser `Valid`.

Sendo honesto sobre o SmartScreen: **assinar não faz o aviso desaparecer de
imediato.** O SmartScreen decide por reputação, que se acumula com downloads e
instalações ao longo do tempo, por identidade de publisher. Um aplicativo novo,
de um publisher novo, pode ver o aviso mesmo assinado corretamente. A cada
versão publicada com a mesma identidade, isso melhora.

O que este projeto **não** faz e você não deve fazer: desligar o SmartScreen,
o Defender, o Smart App Control ou o UAC. Se você não confia no arquivo,
confira o SHA-256 publicado em `SHA256SUMS-windows.txt` na Release antes de
executar.

### Onde ficam os arquivos

| O quê | Onde |
| --- | --- |
| aplicativo instalado | `C:\Program Files\Tumacord` |
| conta, mensagens, anexos e preferências | `%APPDATA%\Tumacord` |
| dados do servidor embutido | `%APPDATA%\Tumacord\server-data` |
| registro de falhas | `%APPDATA%\Tumacord\logs\runtime-health.log` |

O diagnóstico completo está em **Configurações › Diagnóstico**, com um botão
para copiar. O texto copiado não carrega token, chave, credencial, endereço IP
nem nome de aplicativo ou título de janela — pode ser colado numa conversa.

### Desinstalar

Por **Configurações do Windows › Aplicativos › Aplicativos instalados ›
Tumacord › Desinstalar**, ou pelo atalho do Menu Iniciar. As regras de firewall
saem junto.

A pasta `%APPDATA%\Tumacord` é preservada de propósito: apagar conta, histórico
e anexos é uma decisão sua, e você pode remover essa pasta à mão depois.

### Limites conhecidos no Windows

- o isolamento de áudio por aplicação exige Windows 10 build 19041 ou mais
  novo. Em versões anteriores a transmissão vai sem áudio, com aviso na tela;
- não há build para ARM64 nem para 32 bits;
- ao transmitir **uma janela**, o desenho de quem assiste aparece dentro do
  aplicativo, e não sobreposto ao desktop: com uma janela não dá para saber onde
  ela está na tela. Transmitindo o **monitor inteiro**, o traço aparece sobre o
  desktop de verdade. Desde a 0.9.0 isso é exclusividade do Windows — veja
  abaixo;
- o portátil não configura o firewall — a permissão é dada no aviso do próprio
  Windows, na primeira execução.

Para compilar, assinar e publicar, veja
[`docs/windows-build.md`](docs/windows-build.md). A matriz de teste manual está
em [`docs/windows-testing.md`](docs/windows-testing.md).

## Mesa de desenho compartilhada

Uma pessoa clica no `+` de **Mesas de desenho**, dá um nome e recebe um quadro
em branco. As demais veem o anúncio no canal e escolhem **entrar na mesa**.

Isto é diferente de [desenhar sobre a transmissão](#desenho-sobre-a-transmissão).
Aquilo é apontamento: mora dentro do vídeo, tem prazo e, por causa da janela
sobreposta, só funciona na live de quem está no Windows. **A mesa é desenhada
dentro do próprio app** — não depende de live, não depende de overlay, não
depende nem da call estar aberta, e funciona igual no Linux e no Windows.

Se a call estiver acontecendo, ela continua. Desenhar não interrompe a voz, e a
voz não é necessária para desenhar.

### O que a primeira versão oferece

Caneta, sete cores e cinco espessuras; borracha que apaga o traço inteiro;
desfazer o seu próprio traço; zoom e deslocamento da folha; lista de quem está
na mesa; e exportação em PNG.

O zoom e o deslocamento são **locais**: a folha tem coordenadas próprias, e
aproximar para olhar um canto não move a visão de mais ninguém. Duas pessoas em
janelas de tamanhos diferentes veem o traço no mesmo lugar do desenho.

### Quem gerencia

Quem criou a mesa — e, no servidor dedicado, quem administra o servidor — pode
bloquear novos desenhos, aceitar ou recusar observadores, tirar e devolver a
permissão de desenhar de uma pessoa, limpar o quadro, encerrar a atividade e
arquivar a mesa guardando o conteúdo.

**Limpar tudo pede confirmação**, porque apaga o trabalho do grupo. Tirar a
permissão de alguém vale na operação seguinte, e não na próxima vez que a
pessoa entrar.

### O que a mesa não faz

- **desfazer não apaga o trabalho alheio.** Ele age sobre um objeto seu e
  identificado, não sobre o último item da lista — que quase sempre é de outra
  pessoa. A borracha segue a mesma regra: cada um apaga os seus, e quem
  gerencia apaga os dos outros;
- **nada some sozinho para liberar espaço.** Ao encostar no limite de traços ou
  de armazenamento, a mesa recusa a operação nova com uma mensagem. O que já
  está desenhado fica;
- **a recusa mora no servidor.** Esconder um botão é conveniência para quem
  está olhando, não autorização: observador, mesa bloqueada e permissão
  revogada são verificados do lado de lá.

### Entrar depois, cair e voltar

Quem entra no meio recebe o quadro em uma revisão conhecida mais tudo o que
veio depois, inclusive o que aconteceu enquanto a tela carregava. Quem cai e
volta diz até onde chegou e recebe só a diferença — ou o quadro inteiro, se
ficou para trás demais. Cada pedaço de traço tem identidade própria, então uma
reconexão que reenvia o que já mandou **não desenha duas vezes**.

### No dedicado e no P2P

No **servidor dedicado** a mesa é gravada e volta inteira quando o servidor
reinicia. Arquivar preserva o conteúdo.

No **P2P** quem ordena as operações é o host. A mesa atravessa a troca de host:
o servidor do próximo sobe vazio e quem estava nela devolve o quadro. Ela vive
enquanto o grupo estiver reunido — isso está escrito dentro da própria mesa,
junto ao botão de exportar — e some quando a última pessoa sai. Ela também não
atravessa para fora do grupo: um servidor dedicado recusa qualquer mesa vinda
de fora.

## Enlace direto: a call sem ZeroTier

### Na mesma rede

Nada muda e nada precisa ser configurado. Abra o Tumacord: se ninguém estiver em call, o botão mostra **Abrir minha call** e você vira host. Nos outros computadores, a lateral mostra **Calls na rede** com o host, a quantidade de pessoas e o ping; um clique entra.

### Fora da rede, pela internet

1. Quem já está na call abre **Enlace direto › Convidar pela internet** e copia o código.
2. Quem vai entrar cola o código em **Entrar por convite**, ou no campo de convite da tela de entrada.
3. Pronto. O código aponta o servidor daquela call e leva o segredo que dá direito de entrar; ele vale por 12 horas.

O convite não carrega endereço de máquina nenhuma. Ele diz onde a call se
encontra, e os dois lados chegam lá por conexão *de saída* — que é o que
atravessa CGNAT sem ninguém precisar abrir porta. A descrição antiga, de um
código que trazia os endereços do host para quem recebia correr atrás deles,
saiu na 0.8.3 junto com aquele caminho.

| Caminho | Como funciona | Quando entra |
| --- | --- | --- |
| Rede local | descoberta por broadcast/multicast, como sempre | mesma rede, sem convite nenhum |
| Servidor de encontro | o convite aponta o servidor; os dois lados ligam para fora | fora da rede local |
| Mídia por ICE/STUN | voz, câmera e tela furam o NAT diretamente entre os dois | sempre que a sinalização estiver de pé |
| Relay TURN | último recurso, ligado por quem precisa | nenhum caminho direto se forma |

A parte pesada — voz, câmera e tela — atravessa CGNAT por conta própria com ICE/STUN, que é a mesma travessia que jogos e chamadas usam. Os servidores STUN só informam qual é o seu endereço público: eles não veem nem transportam a conversa, que continua cifrada de ponta a ponta por DTLS-SRTP.

O que precisa de um caminho de entrada é a **sinalização**, que mora no host. Por isso, quando o host sai, assume automaticamente quem tem o melhor alcance, não apenas o menor ping. Se ninguém do grupo tiver IPv6 nem porta aberta, o app diz isso com todas as letras em **Configurações › Rede e conexão** — e aí o ZeroTier resolve.

### Segurança da porta exposta

Sem ZeroTier, a porta de sinalização passa a aceitar conexão vinda da internet. Quem chega de um endereço da própria rede continua entrando sem nada, como a descoberta por broadcast sempre fez; de fora, sem a chave do convite, a API inteira responde `403`. O host ainda devolve um HMAC do nonce apresentado, de modo que quem convida prova ser quem diz ser, e um endereço que trocou de dono não recebe usuário e senha de ninguém.

A chave é da call, não da máquina: quem entra por um convite passa a aceitá-lo também. É isso que mantém o código válido quando o host muda no meio da conversa.

### ZeroTier, agora opcional

Em **Configurações › Rede e conexão** existe a chave **Usar a rede ZeroTier**. Desligada — o padrão —, o adaptador do ZeroTier fica fora da descoberta e da call. Ligada, tudo funciona como nas versões anteriores: instale o ZeroTier em todos os computadores, entre na mesma rede, autorize os membros no painel e use o Tumacord normalmente.

Vale ligar quando o grupo já usa uma rede ZeroTier ou quando ninguém consegue ser alcançado pelo enlace direto — o caso de todos estarem em CGNAT sem IPv6.

Na mesma tela ficam a travessia por STUN e a abertura de porta no roteador, que também podem ser desligadas, além do diagnóstico deste computador: IPv6 disponível, CGNAT, se o NAT é atravessável e qual porta foi aberta.

E ali também fica **Usar o relay do servidor (TURN)**, **desligada por padrão**. O relay é o único caminho em que a mídia passa por uma máquina de terceiro — cifrada de ponta a ponta, mas passando, e gastando banda dessa máquina. Quem precisa dele é a minoria que não fecha caminho direto de jeito nenhum: os dois lados em CGNAT simétrico e sem IPv6. Por isso a escolha é de cada pessoa, e não do servidor: ter um relay anunciado não obriga ninguém a usá-lo. Ligada, a chave não muda a ordem das coisas — o ICE continua preferindo qualquer par direto, e o relay só entra quando nenhum se forma.

### Firewall

Libere TCP `3927` (sinalização) e UDP `3928` (descoberta) na rede local. Convidar pela internet não depende mais de nada chegar até este computador: o convite aponta um servidor, e os dois lados vão até ele.

### Quando nada direto funciona

Existe um caso que nenhuma travessia resolve sozinha: os dois lados atrás de CGNAT, com NAT simétrico e sem IPv6. Não há endereço para furar. Também existe o caso comum de o roteador dizer que abriu a porta por UPnP e ela não responder de fora.

Para isso a 0.8.0 traz o **servidor de encontro**, descrito na seção seguinte. Com ele, ninguém precisa ser alcançável: os dois lados abrem conexão *de saída*, que é o que atravessa CGNAT sem abrir porta em lugar nenhum.

## Servidor de encontro e TURN

Esta é a forma que funciona **independentemente de CGNAT, UPnP, porta aberta ou IPv6**. Ela custa uma máquina com IP público — uma VPS pequena basta —, e em troca elimina toda a negociação de alcance.

A ideia é separar duas coisas que costumam ser confundidas:

- **sinalização** é o combinado inicial: quem está na call, e a troca de SDP e candidatos ICE. É pouco tráfego e passa pelo servidor;
- **mídia** é voz, câmera e tela. Sempre que houver um caminho direto, ela vai direto de um computador ao outro e **não toca no servidor**.

```text
                   servidor de encontro
                    (HTTPS/WSS :4600)
                    /               \
              sinalização        sinalização
                  /                   \
            você  ──────── WebRTC ──────── seu amigo
                        mídia direta

           e só quando nenhum caminho direto se forma:
            você  ───────── TURN ───────── seu amigo
```

Os dois lados **abrem conexão de saída** para o servidor, exatamente como abrir um site. É por isso que funciona atrás de CGNAT: o que não funciona é a internet iniciar uma conexão para dentro da sua casa, e aqui isso nunca acontece.

O convite não carrega endereço de máquina nenhuma — só a call, o servidor e o segredo que dá direito de entrar. Desde a 0.8.3 é a única forma de convite que existe.

### Subindo

Numa máquina com IP público e um nome apontado para ela:

```bash
cp .env.example .env
# edite TUMACORD_SERVER_ACCESS_KEY e, se for usar relay, as variáveis TURN
docker compose up -d --build
```

Isso já entrega o encontro e a sinalização. Para incluir o relay TURN:

```bash
docker compose --profile turn up -d
```

O relay fica fora do perfil padrão de propósito: ele só faz sentido em uma máquina com IP público e é a única peça que chega a carregar mídia — e, portanto, banda.

### Variáveis do relay

| Variável | Para que serve |
| --- | --- |
| `TUMACORD_TURN_URLS` | o que o aplicativo anuncia, ex. `turn:turn.seudominio.com:3478` |
| `TUMACORD_TURN_SECRET` | segredo compartilhado entre o servidor e o coturn |
| `TUMACORD_TURN_REALM` | domínio do relay, ex. `turn.seudominio.com` |
| `TUMACORD_TURN_PUBLIC_IP` | IP público da máquina; sem ele o coturn anuncia o IP interno |
| `TUMACORD_TURN_TTL_SECONDS` | validade das credenciais (padrão: 8 horas) |

Nenhuma senha de TURN é armazenada. O servidor assina um prazo com o segredo compartilhado e entrega uma credencial temporária; o coturn recalcula o mesmo HMAC e compara. Uma credencial que vaze deixa de valer quando o prazo acaba.

Libere no firewall da VPS: `3478/udp`, `3478/tcp` e a faixa `49160-49200/udp`.

> **Ao mexer no `command:` do coturn.** Uma opção que o turnserver não reconhece não é ignorada: ele imprime o help e sai com 255, e o `restart: unless-stopped` transforma isso em laço de reinício silencioso — `docker ps` mostra `Restarting`, e o servidor continua anunciando um relay que não existe. Foi o que aconteceu com `--no-loopback-peers`, removido do coturn (hoje loopback é negado por padrão, e a opção que existe é a inversa, `--allow-loopback-peers`). Depois de qualquer mudança ali, confira `docker logs tumacord-turn | head -3`: a primeira linha diz qual opção ele não entendeu.

### `turns:` na porta 443

Em redes que bloqueiam UDP — trabalho, faculdade, alguns celulares — só TURN sobre TLS atravessa. Ele fica desligado por padrão porque exige certificado válido, e um coturn que não encontra o arquivo sobe quebrado. Para ligar, coloque o certificado em `./certs`, remova `--no-tls` e `--no-dtls` do serviço `coturn` no `docker-compose.yml`, acrescente:

```yaml
      - --tls-listening-port=443
      - --cert=/certs/turn.crt
      - --pkey=/certs/turn.key
```

e inclua `turns:turn.seudominio.com:443?transport=tcp` em `TUMACORD_TURN_URLS`.

### Quanto de banda o relay usa

Só as calls que **não** conseguem caminho direto passam por ele. Quando passam, o custo é real: uma transmissão de tela em 1080p60 no perfil de 8 Mbps consome cerca de 3,6 GB por hora, por espectador relayado. Vale dimensionar a VPS pensando nisso, ou reduzir o perfil de qualidade quando o relay estiver em uso.

### O que o servidor enxerga

Ele vê quem entrou, quando, e a sinalização. **Não vê a conversa**: a mídia é cifrada de ponta a ponta por DTLS-SRTP, com as chaves negociadas entre os participantes. Quando o relay é usado, ele encaminha datagramas opacos — sabe que dois endereços trocam bytes, não o que os bytes dizem. Configure `TUMACORD_TLS_CERT_FILE` e `TUMACORD_TLS_KEY_FILE` para que a sinalização também viaje por HTTPS/WSS.

## Servidor dedicado com Docker

O contêiner dedicado mantém as contas e mensagens, faz a sinalização WebRTC e também hospeda a interface web — é o mesmo serviço descrito acima. O servidor embutido do modo P2P não publica a versão web. Antes da primeira inicialização, crie a chave do servidor:

```bash
cp .env.example .env
# edite TUMACORD_SERVER_ACCESS_KEY no arquivo .env
docker compose up -d --build
```

Abra `http://IP-DO-SERVIDOR:4600` no navegador ou selecione **Servidor dedicado** no app e informe esse endereço e a chave. A primeira entrada com uma combinação local de usuário e senha cria a conta correspondente no servidor; as entradas seguintes autenticam essa conta. O usuário definido por `TUMACORD_ADMIN_USERNAME` — `Moontariun` por padrão — recebe o painel de administração apenas nesse modo.

O arquivo `docker-compose.yml` publica a porta TCP `4600`, executa o processo como usuário sem privilégios, verifica a saúde do serviço, limita os logs e mantém contas, sessões, perfis, mensagens e anexos no volume `tumacord-data`. Senhas usam `scrypt`, tokens são armazenados somente como hashes SHA-256, a chave do servidor é comparada em tempo constante e voz, câmera e tela usam DTLS-SRTP do WebRTC. Para acompanhar:

```bash
docker compose logs -f tumacord-server
```

Para verificar a saúde sem abrir o app:

```bash
curl http://127.0.0.1:4600/api/health
```

Nesse modo não há troca dinâmica do endereço do host: o contêiner mantém a sinalização e os dados, enquanto voz, câmera e tela continuam trafegando diretamente entre os participantes por WebRTC.

Em uma rede privada, o próprio limite da rede protege o tráfego até o servidor. Se a porta `4600` for exposta à internet, configure também `TUMACORD_TLS_CERT_FILE` e `TUMACORD_TLS_KEY_FILE` com caminhos de certificado e chave dentro da pasta `certs`; assim, login, chat e sinalização usam HTTPS/WSS. A chave do servidor não substitui HTTPS em uma rede pública.

## Áudio da transmissão no CachyOS

O compartilhamento de tela usa PipeWire. O instalador garante os utilitários `pactl`, `pw-link` e `pw-dump`; confirme apenas que estes serviços estão ativos:

```bash
systemctl --user status pipewire pipewire-pulse wireplumber
```

No KDE/Wayland, mantenha também `xdg-desktop-portal` e `xdg-desktop-portal-kde` instalados. Ao clicar em **Transmitir tela**, escolha a qualidade e marque **Transmitir áudio da fonte** quando quiser som; desmarque para transmitir apenas o vídeo. Isso também funciona ao selecionar a tela inteira.

Quando o áudio é marcado, o Tumacord cria sozinho um barramento temporário, duplica para ele os aplicativos comuns e captura seu monitor. As saídas do próprio Tumacord, do Discord e do mecanismo de voz WebRTC são excluídas antes da captura. Assim, a pessoa que vê sua live recebe jogo, navegador e demais sons do sistema, mas não escuta a própria voz voltando pela transmissão. Ao encerrar a live, o barramento e todas as ligações são removidos automaticamente; não há ajuste manual no painel de áudio.

Na captura pela janela do navegador, fora do aplicativo Electron, o comportamento depende do que o seletor do navegador e o portal do sistema disponibilizarem. O isolamento automático descrito acima é parte do aplicativo desktop para CachyOS.

Se o processo gráfico do Electron cair repetidamente, o Tumacord registra somente o tipo da falha e reinicia uma sessão em modo gráfico seguro. Esse fallback vale para NVIDIA, AMD e Intel e não fica preso: na abertura seguinte a aceleração volta a ser testada. Para isolar manualmente um problema de driver, também é possível iniciar uma sessão com `TUMACORD_DISABLE_GPU=1 tumacord`; os eventos técnicos ficam em `logs/runtime-health.log` dentro do diretório de dados do aplicativo. Esse modo é diagnóstico/reserva, pois codificação por CPU pode reduzir a qualidade em salas maiores.

Se o microfone parar de sair — faixa silenciada pelo sistema, dispositivo padrão trocado ou captura aberta sem sinal —, o Tumacord refaz a captura sozinho, no máximo três vezes, e só avisa se nenhuma delas resolver. A fonte virtual criada para o áudio da live também deixou de poder virar o microfone padrão do sistema, que era o motivo de começar uma transmissão às vezes deixar você mudo.

Para evitar eco físico, use fones. O cancelamento de eco fica sempre habilitado no microfone. A opção **Supressão neural de ruído** ativa localmente o GTCRN, seguida de filtro passa-altas e compressor; se o AudioWorklet não puder iniciar, o Tumacord ativa automaticamente a supressão nativa do Chromium como reserva.

## Desenvolvimento

```bash
npm install
npm run dev
```

Em outro terminal:

```bash
npm run desktop:dev
```

Testes e verificação:

```bash
npm test
npm run typecheck
npm run build
```

Todo push e pull request executa `.github/workflows/release.yml`, repete testes e tipagem, compila o AppImage opcional e o guarda como artefato. As tags Git `v*` também publicam o AppImage e o pacote `.tar.gz` na Release correspondente.

O servidor embutido P2P escuta em `::` na porta `3927` — IPv4 e IPv6 na mesma porta —, mas não serve páginas web. A imagem Docker usa `4600` e entrega API, sinalização e interface web. O modo de desenvolvimento da interface usa `http://localhost:5173`.

## Limites intencionais

O Tumacord usa malha WebRTC, ótima para um grupo pequeno (aproximadamente 2–8 pessoas, dependendo do upload de quem transmite). Uma sala grande precisaria de um SFU como mediasoup ou LiveKit. Não há recuperação de senha nem moderação avançada; a mídia é cifrada pelo próprio WebRTC, mas o chat armazenado no servidor não possui criptografia ponta a ponta adicional.

Os hashes de senha usam `scrypt`. O histórico é replicado por mesclagem entre os computadores online, não é um banco global com consenso: mensagens disponíveis nos pares são preservadas, mas apagar ou editar mensagens distribuídas ainda não faz parte desta versão. Arquivos só permanecem garantidos enquanto o host atual ou algum participante que os sincronizou estiver disponível.

## Atualizar um servidor existente

A 0.8.1 muda o formato guardado — canais ganham posição, contas ganham papel, e o registro de auditoria passa a existir. **A migração é automática e não apaga nada.**

```bash
./scripts/update-server.sh
```

Ele faz backup do volume, busca a versão publicada, reconstrói preservando o
relay se ele já estava no ar, e confere se o servidor voltou a responder — nessa
ordem, porque procurar o backup depois do problema é tarde. Se houver alteração
local sua no `docker-compose.yml`, ele para e avisa em vez de descartá-la.

Para ir direto à versão que o aplicativo está oferecendo para todo mundo:

```bash
./scripts/update-server.sh ultima
```

Ele pergunta ao GitHub qual é a Release mais nova, **pula as que estão marcadas
como retiradas** — a 0.8.9 é uma delas — e vai para a tag dela. É a mesma fonte
que o aplicativo consulta: o repositório do GitHub vale para os dois lados.

O Docker só é reconstruído quando há motivo. Se o código já está na referência
pedida e o servidor no ar já responde com essa versão, o script diz isso e sai
sem derrubar ninguém — dá para rodá-lo só para conferir se está em dia.

À mão, se preferir:

```bash
git pull
docker compose up -d --build
```

O que acontece na primeira subida:

- canais sem posição recebem uma, na ordem em que já estavam;
- o nome apontado por `TUMACORD_ADMIN_USERNAME` vira **dono** do servidor. Se esse nome não existir entre as contas, a conta mais antiga assume — um servidor sem dono não teria como ganhar um;
- daí em diante o papel é dado: **trocar a variável não troca mais o dono.**

Contas, mensagens, anexos, perfis e canais existentes são preservados. Faça um backup do volume antes, como em qualquer atualização:

```bash
docker run --rm -v tumacord-data:/data -v "$PWD":/backup alpine tar czf /backup/tumacord-backup.tar.gz -C /data .
```

**Nunca use `docker compose down -v` para atualizar** — a flag `-v` apaga o volume com todos os dados.

### Retirar uma versão publicada

Quando um defeito aparece depois do lançamento — que é quando defeito costuma
aparecer —, marcar a versão no CHANGELOG não chega sozinho a lugar nenhum: o CI
escreve as notas da Release quando a tag nasce, e nunca mais.

```bash
./scripts/marcar-versao-retirada.sh 0.8.9
```

O script mostra o que vai publicar, pede confirmação e republica as notas
daquela Release a partir do CHANGELOG. Se a seção trouxer o comentário
`<!-- tumacord:versao-quebrada -->`, **toda cópia instalada** para de oferecer
aquela versão — inclusive as que já estavam na rua — e o
`./scripts/update-server.sh` passa a recusá-la. A Release não é apagada: quem
precisar do arquivo continua achando.

### Voltar atrás

```bash
git checkout release/rendezvous-and-turn-v0.8.0
docker compose up -d --build
```

O servidor 0.8.0 ignora os campos que não conhece — posição, papel e auditoria ficam guardados sem efeito, e voltam a valer se você atualizar de novo. Se precisar restaurar o backup:

```bash
docker compose down
docker run --rm -v tumacord-data:/data -v "$PWD":/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/tumacord-backup.tar.gz -C /data"
docker compose up -d
```

No lado do cliente, cada build fica em uma pasta imutável e a anterior continua apontada por `~/.local/share/tumacord/previous`:

```bash
ln -sfn "$(readlink -f ~/.local/share/tumacord/previous)" ~/.local/share/tumacord/current
```

# Histórico de versões

## 0.13.0 — publicar virou largar o arquivo numa pasta

<!-- tumacord:resumo -->
O servidor passou a olhar duas pastas — `linux/` e `windows/` — e a publicar sozinho o que estiver nelas. Largar o pacote por FTP ou `wget` é a publicação inteira. E o aplicativo ganhou uma lista para instalar versões antigas quando você quiser.

**Publicar por pasta**

- O serviço varre `<armazenamento>/linux/` e `<armazenamento>/windows/`, lê a versão do **nome do arquivo**, calcula os resumos e gera o catálogo assinado sozinho. Sem importar, sem promover, sem comando nenhum.
- **Não há convenção nova.** São exatamente os nomes que o `electron-builder` já produz: `tumacord-0.13.0.tar.gz`, `Tumacord-0.13.0.AppImage`, `Tumacord-0.13.0-Setup.exe`, `Tumacord-0.13.0-portable.exe`.
- Nome fora do padrão é **ignorado e dito no log**, em vez de virar uma versão com número errado — que é pior do que não aparecer.
- A varredura roda no arranque e a cada minuto. `POST /admin/scan` varre na hora, para quem não quer esperar. A porta de administração continua sem sair do laço local: varredura é trabalho de disco, e trabalho de disco disparado de fora é um jeito de derrubar servidor.
- Uma varredura que encontra o mesmo de antes **não gasta sequência**. Republicar a cada minuto faria o número crescer sem parar e cada cliente rebaixaria o que já tinha aceitado sem nada ter acontecido.
- Dois arquivos para o mesmo alvo param **aquela versão**, e só ela: as outras continuam sendo oferecidas.
- O caminho antigo continua existindo. Sem chaves em `TUMACORD_UPDATES_SIGNING_DIR`, o serviço se comporta exatamente como antes e serve o que foi importado de fora.

**O que isto custa, dito em voz alta**

A chave que assina passa a viver **no servidor**, porque é ele que publica agora. Quem entrar nele passa a poder entregar um binário como oficial; antes isso exigia a chave, que estava fora.

A assinatura continua protegendo o caminho entre o servidor e o aplicativo — proxy trocado, espelho, DNS sequestrado. O que ela deixou de proteger é o servidor contra si mesmo. É o preço de "largar o arquivo e pronto", e não existe desvio: ou alguém assina no momento do drop, ou quem assina é o servidor.

**Instalar uma versão antiga**

- Um interruptor em Atualizações lista tudo o que o servidor oferece e deixa escolher uma versão anterior. Ele nasce desligado: a pergunta normal é "tem versão nova?", e uma lista de tudo o que já existiu na frente de quem só quer atualizar é ruído.
- A versão instalada aparece marcada, e uma versão sem pacote para aquela máquina aparece desabilitada em vez de sumir — escondê-la faria a pessoa procurar no servidor o que ela está vendo lá e não achar aqui.
- **A procura automática continua nunca oferecendo downgrade.** Voltar de versão passou a ser possível por um clique numa lista, e continua sendo uma decisão — não algo que acontece sozinho ao abrir o aplicativo.

## 0.12.2 — o aplicativo já nasce sabendo onde procurar atualização

<!-- tumacord:resumo -->
A origem das atualizações e as chaves confiáveis do grupo passaram a vir embutidas no código. Quem instala pelo script deixa de precisar de um arquivo escrito à mão em cada máquina.

- Até aqui, `install-linux.sh` compilava do código-fonte e o aplicativo saía **sem saber onde procurar** — a tela de atualização dizia "este Tumacord não sabe onde procurar atualização", e resolver exigia escrever `update-origin.json` na pasta de configuração de cada pessoa. Um passo manual por máquina é um passo que metade do grupo não dá.
- A restrição existia porque o repositório era **público**, e um repositório público não carrega o domínio de ninguém. Ele passou a ser privado, e com isso a razão desapareceu enquanto o custo continuava.
- O arquivo gerado pelo `gerar-origem.mjs` continua tendo precedência, para quem empacota apontando para outro serviço. E o embutido virou injetável, para o teste conseguir exercitar "esta build não tem origem" sem depender de qual build está na máquina que roda a suíte.

## 0.12.1 — a tela de atualização parou de apontar para o GitHub

<!-- tumacord:resumo -->
O bloco "também dá para atualizar como sempre" saiu da tela de atualização.

- Ele oferecia dois caminhos que deixaram de valer: um comando que **compila do código-fonte** e um link para a página de Releases do GitHub. Os aplicativos não buscam mais nada no GitHub desde a 0.9.4, e o repositório pode ser privado.
- Oferecer uma saída que não é mais a saída manda a pessoa para o lugar errado justamente quando ela está com problema — que é quando ela lê aquele bloco.

## 0.12.0 — "já volto" sobre a transmissão, e o silêncio que não se perde

<!-- tumacord:resumo -->
Um cartão de "já volto" que aparece sobre a sua transmissão quando você precisa sair um instante, com texto e cor que você escolhe. E o silêncio de uma pessoa passou a sobreviver a ela sair e voltar da call.

**O aviso de "já volto"**

- Um botão na barra da call põe um cartão sobre a **sua** transmissão. Quem está assistindo vê o recado no lugar da tela, e sabe que você saiu — em vez de continuar esperando uma resposta que não vem.
- O texto é seu, configurável em Voz e vídeo, com teto de 48 caracteres. Ele quebra em até três linhas em vez de virar reticências: com uma linha só, um quadro estreito cortava "Fui buscar café" no meio, e um recado pela metade não é um recado.
- Cinco temas de cor, com prévia do tamanho real do cartão. Escolher cor olhando uma bolinha não responde "como isto vai ficar sobre a minha transmissão".
- **Só o texto e o NOME do tema atravessam a rede — nunca uma cor.** Cor vinda de fora terminaria num atributo `style`, que é onde não se coloca entrada de terceiro. O receptor procura o nome numa lista fechada, e o que não estiver nela cai no padrão em vez de virar CSS. O texto é limitado pelo servidor também, e não só pelo cliente.
- O cartão cobre a imagem de propósito. Uma tarja discreta num canto seria lida como enfeite.

**Silenciar uma pessoa passou a sobreviver a ela sair e voltar**

Dois furos, e nenhum deles estava na preferência — ela sempre foi guardada certo. O problema era aplicá-la:

- **A faixa de áudio era reaberta na saída do elemento de mídia.** Ela é um objeto compartilhado, e reabri-la sempre devolvia o som de alguém que continua mudo: o próximo elemento montado sobre a mesma faixa a herdava ligada. Agora ela só volta a tocar se a pessoa não estiver silenciada.
- **O silêncio dependia de o peer já estar completo.** Existe um instante, logo depois de alguém entrar, em que o dono da mídia ainda não chegou — e nesse instante o silêncio não encontrava a quem se aplicar. Agora a sala serve de rede de segurança: o `socketId` sempre existe, e o dono é encontrado por ele.

O comportamento continua o mesmo em quem ele afeta: **vale só para você**. A preferência vive nesta máquina, e nada é enviado ao servidor nem à outra pessoa.

## 0.11.0 — a live diz quem está vendo, e atualizar deixou de pedir convite

<!-- tumacord:resumo -->
Atualizar não exige mais um convite por máquina — o que finalmente faz o Windows conseguir se atualizar sozinho. E a transmissão ganhou o que faltava: quem está vendo, som quando alguém entra ou sai, e uma barra de controles que some em vez de ficar por cima da imagem.

**Atualizar deixou de exigir um passo manual em cada máquina**

- O serviço de atualizações ganhou `TUMACORD_UPDATES_PUBLIC_READ=1`: baixar catálogo, manifesto e pacote passa a não exigir credencial de dispositivo. O convite de uso único continua funcionando, e desligar a variável volta a exigi-lo.
- **O que isso troca, exatamente:** quem souber o endereço passa a poder baixar. Só isso. Catálogo e manifesto continuam assinados por uma chave que não vive no servidor — ninguém entrega um binário como oficial por saber o endereço. A administração (importar, publicar, retirar) continua na 4301, que nunca sai do laço local. O que se perde é o sigilo dos binários, que num repositório público já não existia, e a revogação por máquina, que nunca impediu ninguém de pegar o pacote com outra pessoa do grupo.
- O aplicativo passou a **tentar sem credencial** em vez de recusar de antemão. Num serviço aberto ele simplesmente atualiza; num fechado, a recusa chega como 401 e é aí — e só aí — que o convite é pedido.
- `/v1/health` passou a dizer em qual modo o serviço está, para o operador conferir num `curl` em vez de deduzir.

**A transmissão diz quem está vendo**

- Um selo compacto no canto de cada transmissão mostra os espectadores: as iniciais de até três e um `+N` para o resto, com os nomes por extenso ao passar o mouse. Ele aparece em **todas** as lives da call, e não só na sua — numa call com três transmissões, saber que ninguém está na sua e todo mundo está na do lado é a informação que faz alguém parar de falar sozinho.
- Na sua própria transmissão o selo aparece mesmo com ninguém vendo, mostrando zero. Na dos outros, uma plateia vazia não é anunciada para a sala.
- A informação sai do estado de voz que já era transmitido: cada pessoa declara o que está assistindo, e a lista de espectadores é o inverso disso. Guardar as duas metades faria as duas divergirem — alguém sai da call e some de um lado sem sumir do outro.
- Dois efeitos sonoros novos avisam quando alguém abre ou fecha **a sua** live. Eles são de propósito mais discretos que os de entrar e sair da call: tocam enquanto você está apresentando, que é o pior momento para um som chamativo.

**A barra de controles sai da frente**

- Os controles de cada transmissão aparecem quando o mouse passa e somem sozinhos depois de alguns segundos. Uma barra fixa come a parte de baixo da imagem o tempo todo, e é justamente ali que costuma estar o que se quer ver. Em tela cheia ela também some, que é onde ela mais atrapalha.
- O botão de volume da transmissão passou a aparecer **só em tela cheia** — é o único lugar onde o controle de volume normal não está ao alcance. Fora dela ele era um botão a mais cobrindo a imagem para fazer o que já dava para fazer.
- Em telas de toque, sem ponteiro para revelar nada, a barra continua fixa.

**Silenciar uma pessoa passou a silenciar tudo o que vem dela**

- O botão silenciava só a voz; o áudio da transmissão daquela pessoa continuava tocando, o que fazia o botão parecer quebrado. Agora ele cobre os dois.
- Continua valendo **só para você**: a preferência vive nesta máquina, nada é enviado ao servidor nem à outra pessoa, e ninguém mais é afetado.

**Cada efeito sonoro tem interruptor próprio**

- A tela de voz e vídeo passou a ligar e desligar os efeitos um a um, além do interruptor geral que continua valendo por cima de todos. O botão de ouvir toca mesmo com o efeito desligado — é ouvindo que se decide se ele merece voltar.
- A preferência guarda os efeitos **desligados**, e não os ligados: com a lista dos ligados, um efeito novo nasceria mudo para quem já usa o aplicativo e ninguém descobriria que ele existe.

## 0.10.0 — SemVer, e a VPS busca a release no GitHub privado

<!-- tumacord:resumo -->
A convenção de versão passou a ser SemVer 2.0.0, e a VPS ganhou um comando que busca os pacotes de uma etiqueta no repositório privado do GitHub — sem que nenhum aplicativo instalado carregue credencial do GitHub dentro de si.

**A versão agora é SemVer**

- `MAJOR.MINOR.PATCH`, com pré-versão depois de `-` e metadado de build depois de `+`, sem dialeto. Quem chega ao projeto já sabe ler, e qualquer ferramenta de fora concorda com a ordem.
- **O sufixo inverteu de sentido.** Até a 0.9.9-2, `-N` era a revisão de manutenção e vinha *depois* da versão que corrigia. Sob SemVer é pré-versão, e vem antes. Uma correção da 0.9.9 agora se chama **0.9.10**.
- **A troca não deixa ninguém para trás**, por aritmética: `0.10.0` é maior que `0.9.9-1` nas duas leituras. As cópias em campo leem pela regra antiga e recebem esta versão do mesmo jeito. `tests/version.test.ts` fixa esse requisito para que a próxima pessoa a mexer na ordenação o encontre antes de quebrá-lo.
- No Windows, o quarto campo passou a ser sempre zero: sob SemVer duas versões publicáveis nunca compartilham `major.minor.patch`, então não há o que desempatar. Uma **pré-versão é recusada** ali — ela teria de virar um número menor que `x.y.z.0`, que não existe, e o instalador trataria a rc e a final como a mesma coisa.
- O publicador recusa promover uma pré-versão ao canal estável sem `--aceitar-pre-versao`. Agora que `1.0.0-rc.1` é um número legítimo, nada na forma dele impede o engano — só o canal separa ensaio de público.

**A VPS busca no GitHub; a assinatura continua sendo sua**

- `tumacordctl releases fetch v0.10.0` baixa os pacotes daquela etiqueta do repositório **privado**, confere tamanho e SHA-256 contra o que a API anunciou, guarda no armazenamento da VPS e escreve um **recibo**. Ele não assina nada.
- `publish.mjs manifest --recibo <arquivo>` monta e assina o manifesto a partir desse recibo, no ambiente de publicação. A chave privada continua fora da VPS: invadi-la não dá a ninguém a capacidade de entregar um binário como oficial.
- **O token do GitHub vive só na VPS**, em `/etc/tumacord/github-token` ou em `TUMACORD_GITHUB_TOKEN`. É o que permite o repositório continuar privado sem embutir uma credencial do GitHub em cada executável distribuído — que vazaria no primeiro `strings` e não poderia ser revogada sem trocar o aplicativo de todo mundo.
- O `Authorization` **não** acompanha o redirecionamento do download. Em repositório privado o asset é servido por um 302 para o armazenamento, e mandar o cabeçalho junto entregaria o token a outro host. O salto é seguido à mão para que essa decisão fique escrita.
- O serviço `tumacord-updates` continua sem falar com o GitHub. Quem busca é o `tumacordctl`, no host: dar saída para a internet e um token ao serviço que guarda e serve os pacotes trocaria uma propriedade de segurança por conveniência.

**Empacotar deixou de sujar a árvore de trabalho**

- `scripts/gerar-origem.mjs` passou a escrever `desktop/update-origin.generated.cjs`, que não é versionado, em vez de editar o fonte. `scripts/empacotar.mjs` grava esse arquivo antes de empacotar e o apaga depois — inclusive quando o empacotamento falha.
- Sem isso, a máquina que empacota ficava com a origem gravada no fonte, e o teste que pergunta "e quando não há origem configurada?" passava a depender de qual foi a última build feita ali.

## 0.9.9-2 — o "Assistir" sai de cima da lista

<!-- tumacord:resumo -->
O botão de assistir a uma live deixou de ocupar uma linha própria embaixo do nome e passou a ficar à direita dele, na mesma linha — como no Discord.

- Cada transmissão que começava acrescentava uma linha à lista de quem está na call, e empurrava todo mundo abaixo para baixo. Com três pessoas transmitindo, a lista crescia três linhas e quem você procurava saía da tela. Agora a lista tem uma linha por pessoa, transmitindo ou não.
- O rótulo visível encurtou para caber ao lado do nome: "Entrar e assistir" virou "Entrar". A frase inteira continua sendo dita por `title` e passou a ser dita também por `aria-label` — encurtar o que um leitor de tela anuncia teria sido trocar informação por espaço, e não é a mesma economia.
- Um nome comprido encolhe com reticências em vez de empurrar o botão para a linha de baixo. Isso exigiu `flex-basis: 0` no botão do nome: com a base automática, o navegador prefere quebrar a linha a comprimir o conteúdo, que era exatamente o defeito que esta versão veio desfazer.
- O painel de volume de cada pessoa continua ocupando uma linha inteira quando é aberto. Ele é o único item da linha que precisa disso, e é por isso que a linha admite quebra.
- `scripts/gerar-origem.mjs` passou a existir. O `desktop/update-origin.cjs` já o citava em comentário, mas o arquivo não estava no repositório: é ele que grava na build a origem das atualizações e as chaves públicas em que aquela build confia. Sem ele um pacote sai sem saber de onde atualizar, e nenhuma tela do aplicativo configura isso depois.

Nada mudou no que a live faz: o anúncio continua não abrindo nada sozinho na área principal, e quem decide o que ocupa a tela continua sendo quem assiste.

## 0.9.9-1 — a revisão de manutenção passa a existir, e a ordem para de mentir

<!-- tumacord:resumo -->
Uma correção pequena deixou de exigir uma versão grande: `0.9.9-1` é a versão seguinte à `0.9.9`, e o aplicativo, o servidor e os scripts agora concordam sobre isso.

- A regra de ordenação de versões passou a ter uma implementação só, em `shared/version.ts`. Antes ela estava escrita quatro vezes, e as cópias divergiam: `0.9.9-1` era lida como ensaio e ficava *abaixo* da `0.9.9`, de modo que quem estava na `0.9.9` nunca seria oferecido a correção dela.
- No Windows, a revisão passou a ter número próprio: `0.9.9` vira `0.9.9.0` e `0.9.9-1` vira `0.9.9.1`. Os dois davam o mesmo número antes, e o sistema tratava a atualização como reinstalação da mesma coisa.
- `alpha`, `beta`, `rc` e `+build` saíram da convenção de versão. Quem é ensaio passou a ser decidido pelo canal, que é um campo separado — misturar as duas coisas obrigava a ler o mesmo `-1` como "antes" num caso e "depois" no outro.
- Uma versão malformada deixou de ser lida como "é a mesma versão". Ela era o suficiente para convencer um cliente de que ele já estava em dia.
- O CI parou de marcar como ensaio toda etiqueta com hífen, e passou a recusar etiqueta fora da convenção antes de publicar.
- **O aplicativo deixou de buscar atualização no GitHub.** Ele consulta a distribuição privada do grupo, na mesma VPS do servidor: catálogo assinado, manifesto assinado, e o pacote baixado por identificador — nunca por uma URL que veio pela rede. Um servidor de chat não muda essa origem nem a chave confiável.
- Cada dispositivo é autorizado por um convite de uso único, que o dono cria e passa por canal privado. A credencial só baixa, é revogável na hora, e fica no chaveiro do sistema — sem chaveiro, ela vale para a sessão e o aplicativo diz isso.
- A retirada de uma versão passou a morar só no catálogo assinado. Antes ela era um comentário de HTML nas notas da Release, e uma segunda autoridade sobre o que está retirado é sempre a que alguém consegue forjar.
- O download retoma de onde parou, e o resumo conferido é o de tudo o que está no disco.
- Uma pasta de build vira release assinada por um comando: `tools/publisher/` confere cada pacote, tira as notas do CHANGELOG, assina o manifesto e monta o catálogo. Dois arquivos para o mesmo alvo **param** a publicação em vez de virar sorteio, e um número já publicado não volta a ser usado para conteúdo diferente.
- O servidor dedicado passou a ser atualizado por um **executor** que roda no host, e não pelo contêiner, que se reiniciava no meio da própria troca. O painel do dono lista as versões do catálogo assinado, e só o identificador da release atravessa: a referência de git é tirada do manifesto, lá no host.
- Aplicar uma versão exige a cópia dos dados antes. `tumacordctl backup` pausa a escrita, copia e confere o arquivo; `tumacordctl restore` ensaia num volume separado e para se a cópia for de outra instalação.
- **No P2P, um nome passou a pertencer a quem o reivindicou com a chave do próprio dispositivo.** Na troca de host, a conta nascia no servidor novo com a senha de quem chegasse primeiro — e, com ela, o direito de editar e apagar as mensagens de outra pessoa. Um aplicativo anterior continua entrando com um nome livre, e é recusado, com o motivo, num nome que já tem dono.
- Um nome reivindicado por dois dispositivos enquanto o grupo estava dividido fica em disputa, e a disputa não é resolvida em silêncio: entra quem aquele host viu primeiro, marcado como provisório, até um dos dois liberar o nome.

## 0.9.9 — a mensagem deixa de ser definitiva, e o aplicativo ganha ouvido

<!-- tumacord:resumo -->
Dá para editar e apagar mensagem, e a mudança tem prioridade: uma exclusão alcança quem estava offline e a cópia antiga não a desfaz.

- A imagem escolhida aparece no compositor antes de sair do seu computador — escolher não envia nada.
- Entrar no Tumacord deixou de entrar na call sozinho.
- Os dezessete sons do aplicativo foram refeitos do zero. Silenciar o microfone e fechar o ouvido passaram a soar diferente, e você entrando na call não soa mais igual a alguém entrando nela.
- O dono do servidor pode trocar a versão dele pelo painel, escolhendo entre as publicadas — desligado por padrão.
- O desenho por cima da transmissão de alguém saiu. O desenho do Tumacord é a mesa compartilhada, que continua inteira.
<!-- /tumacord:resumo -->

**Editar e apagar**

Passar o ponteiro sobre uma mensagem sua mostra dois botões. Editar abre o texto
ali mesmo — Enter salva, Esc desiste — e deixa um "(editada)" ao lado. Apagar
pergunta antes, porque não volta.

Quem pode é o autor, e quem confere é o servidor: esconder o botão do outro lado
é conveniência, não permissão. No P2P a identidade é o apelido, e não o `id` —
cada host tem o próprio cadastro, e sem isso trocar de host tiraria de você o
direito de apagar as suas próprias mensagens.

**A parte difícil: a replicação**

O merge do P2P olhava só o identificador da mensagem — quem já a conhecia
ignorava a que chegava. Isso bastava enquanto uma mensagem era imutável. Com
edição e exclusão vira o pior comportamento possível: quem apaga vê a mensagem
voltar no primeiro encontro com alguém que ainda tinha a cópia antiga.

Agora cada mensagem carrega uma revisão, e **quem tem mais revisão vence**.
Apagar é uma revisão como outra qualquer — a prioridade não vem de um
tratamento especial, vem de ser sempre mais nova que a cópia guardada. No lugar
do conteúdo fica uma lápide, que não carrega o texto nem o anexo: sem ela não
haveria como distinguir "foi apagada" de "ainda não recebi", e é a segunda
leitura que ressuscita.

A regra vale nos três lugares por onde uma mensagem passa: o histórico do
servidor, o espelho local de cada computador e a lista em tela. Valesse em
dois, o terceiro desfaria.

**A prévia vem antes do upload**

Escolher um arquivo mandava ele embora na hora, e o compositor mostrava um nome.
Agora escolher não envia nada: a imagem aparece no compositor, do tamanho de
uma miniatura, e o arquivo só sai deste computador quando você aperta enviar.
Desistir é fechar o cartão, e não há o que desfazer do outro lado.

**Entrar no Tumacord não é entrar na call**

A call que a sessão estava retomando era gravada no chaveiro. Ela existe para o
agora — um convite aponta uma call, uma troca de host reaponta a mesma —, e
guardada ela fazia o aplicativo entrar sozinho naquela call em toda abertura
seguinte. Para sempre, porque nada a apagava. Agora entrar na call é uma
escolha sua, e o convite continua levando direto ao lugar certo.

**Os sons, refeitos**

Eram um oscilador por nota ligado a um ganho. Isso toca a nota certa e soa como
bipe, e o motivo é conhecido: uma senoide não tem timbre, sem ataque não há
percussão, sem cauda o som morre na parede e um envelope quadrado estala.

Cada nota passou a ser uma pilha de parciais levemente desafinados entre si,
com um filtro que fecha conforme ela decai — é esse fechamento que separa
"macio" de "estridente" —, um sopro de ruído no ataque e um envio para uma
cauda de reverberação gerada por código. No fim de tudo, um compressor suave,
para que nenhum evento fique mais alto que os outros. Tudo continua sintetizado
no aplicativo: o Tumacord não embarca arquivo de som de ninguém.

A paleta também cresceu, porque havia coisas diferentes soando igual. Silenciar
o microfone e fechar o ouvido tocavam o mesmo par de notas; você entrando na
call soava idêntico a alguém entrando nela. Agora são dezessete sons, todos na
mesma tonalidade — é isso que faz um conjunto soar como um produto e não como
uma coleção de bipes —, e **Configurações › Voz e vídeo** tem um botão para
ouvir cada um.

**Atualizar o servidor pelo painel**

O dono de um servidor dedicado vê uma aba **Versão**, com todas as versões
publicadas nas Releases do projeto, consultadas pelo próprio servidor. Escolher
uma e confirmar faz o servidor fazer backup do volume, trocar o código e
reiniciar.

É a ação mais perigosa do projeto, e está cercada em camadas — nenhuma delas na
interface:

- **desligada por padrão.** Ligar é uma decisão de quem hospeda, com
  `TUMACORD_SELF_UPDATE=1`. Um servidor que ganhou esta versão não passa a
  aceitar troca de código porque atualizou;
- **é do dono.** Administrador cuida de canais e de gente;
- **o navegador só manda uma etiqueta**, e ela é conferida contra a lista que o
  próprio servidor buscou — na leitura e de novo na hora de aplicar. Não há
  caminho, branch, endereço, repositório nem comando vindo da tela;
- **o que roda é fixo**, com a etiqueta passada como argumento e nunca por
  shell;
- **uma por vez, com limite**, e a tentativa entra na auditoria antes de
  qualquer coisa acontecer — uma atualização que derruba o servidor no meio não
  deixaria rastro se o registro viesse depois.

Dentro do contêiner isso não funciona, e ele diz o motivo: a imagem carrega só
o código compilado. Serve para quem roda o servidor direto no host, a partir do
clone do repositório.

**O desenho sobre a transmissão saiu**

Ele nasceu na 0.8.7 e nunca funcionou inteiro: na 0.9.0 virou exclusividade do
Windows, porque no Linux a janela que pintava o traço roubava o foco do teclado
de quem estava jogando e ainda voltava dentro da própria captura. Duas coisas
diferentes carregavam o mesmo nome, e a que ficou é a que funciona igual nos
dois sistemas.

**A mesa de desenho compartilhada continua inteira** — ela nunca dependeu de
live, de call nem de janela sobreposta. O que saiu foi o rabisco por cima da
transmissão de alguém: o botão do lápis no quadro, a aba de Desenho nas
configurações, a janela sobreposta do Windows e a sinalização dos traços.

**Validação**

663 testes passam. Doze cobrem mensagem editada e apagada — seis contra um
servidor de verdade, incluindo os três caminhos de replicação do P2P. Vinte e
um cobrem a atualização do servidor, entre o que decide e o que recusa: nenhum
deles executa o script, porque executá-lo trocaria o código desta cópia, e isso
está dito como manual em `docs/QA.md`. A tela foi exercitada no aplicativo
rodando contra um servidor dedicado real: entrar sem cair na call, enviar,
editar, e a lista de versões chegando do GitHub.

Os sons foram medidos com um analisador no ponto em que eles entram na mistura,
e a tabela está em `docs/QA.md`. A medição encontrou dois defeitos reais e os
dois foram corrigidos: `messageSent` saía sete vezes abaixo de `message`, na
prática inaudível, e `connect` três vezes e meia acima do resto. O timbre não
tem número — ele foi construído e julgado de ouvido, e isso está dito.

## 0.9.8 — a entrada cabe na tela, e as contas guardadas são suas

<!-- tumacord:resumo -->
A tela de entrada foi refeita. Onde havia uma coluna que descia até precisar de rolagem, agora há duas que cabem na tela.

- As contas guardadas aparecem com a foto do perfil, dizendo se cada uma é P2P ou de servidor dedicado, e com um "x" para esquecer.
- Sair de uma conta do modo P2P passou a funcionar: ela voltava sozinha na abertura seguinte.
- O texto que explicava cada campo virou dica no ponteiro. Nada se perdeu, e a tela ficou limpa.
- Um grupo P2P aparece como "Rede local" ou "Por convite", e não mais com o nome padrão do servidor, igual em todos.
<!-- /tumacord:resumo -->

**A entrada em duas colunas**

A tela crescia para baixo a cada coisa nova: escolha de modo, endereço, chave,
convite, duas caixas de "lembrar" com um parágrafo cada, aviso de segurança,
contas guardadas, rodapé explicando o modo escolhido. Em servidor dedicado, com
duas contas guardadas, o cartão media 420 × 1325 px — rolagem numa janela de 800
px de altura, para entrar em um aplicativo de conversa.

Agora são duas: à esquerda a marca e o que este computador lembra, à direita o
formulário, com endereço e chave lado a lado e usuário e senha lado a lado. O
mesmo caso mede 860 × 448 px e não rola. Abaixo de 880 px de largura as duas
colunas viram uma e os pares de campo desempilham, que é o que a janela dividida
e a tela pequena precisam.

**As contas guardadas, com rosto e com saída**

Cada conta lembrada aparece com a foto do perfil daquela sessão. Ela não
aparecia: a tela de entrada não tem sessão aberta, e o endereço que o resto do
aplicativo usa para buscar uma foto é relativo — ali ele não aponta para lugar
nenhum. A busca agora tenta primeiro o que este computador já baixou, que é o
único caminho que funciona com o host do grupo desligado, e depois o servidor
daquele destino. Falhando as duas, vale a inicial do nome; um círculo vazio
seria pior.

Cada linha também diz, escrito, se aquela conta é **P2P** ou de **servidor**
dedicado. O nome sozinho não dizia: um servidor chamado "Casa do Tuma" aparecia
como "Casa do Tuma" e um grupo P2P como "Grupo de Tumacord" — escolher entre
eles era adivinhar.

E o nome do grupo P2P deixou de ser "Tumacord". No P2P o servidor é o embutido
de quem hospeda, que só se chama outra coisa se alguém definiu `SERVER_NAME` —
ou seja, quase nunca. O nome que aparecia ali era o padrão, igual em todos os
grupos, e não identificava nenhum. Agora um grupo P2P aparece como **Rede
local** ou **Por convite**, e o nome só ocupa a linha quando alguém escolheu
um. No servidor dedicado o nome continua, porque lá ele foi escolhido por quem
hospeda. O endereço daquele destino fica na dica do ponteiro.

Ao lado de cada uma há um **x**, que esquece aquele destino — a sessão e a chave
guardada dele — depois de uma confirmação, porque não há como desfazer. Até aqui
o único jeito de tirar uma conta da lista era entrar nela para poder sair.

**Sair do P2P não estava saindo**

Sair de uma conta do modo P2P apagava a sessão e, um instante depois, ela estava
de volta.

A gaveta única de até a 0.9.5 continua no disco de propósito: apagá-la e errar
na conversão custaria a sessão de quem atualizou. O que faltava era registrar
que a conversão **já aconteceu**. Sem esse registro ela rodava a cada leitura do
chaveiro, e a leitura seguinte a um "sair" repunha a sessão que acabara de ser
encerrada. No P2P a sessão antiga e a nova caem no mesmo destino — `grupo:` —,
então era exatamente ali que o efeito aparecia. "Esquecer tudo" tinha o mesmo
destino.

Havia um segundo caminho, também só do P2P: quando o socket cai, o aplicativo
se reautentica sozinho no servidor embutido, e autenticar grava. Sair da conta
enquanto essa tentativa estava no ar gravava de volta o que a pessoa tinha
acabado de encerrar. Agora a tentativa que chega tarde desfaz o que escreveu —
e só o que ela escreveu: uma troca de host que tenha ocupado aquele destino no
meio do caminho fica onde está.

**Menos texto ao lado dos controles**

Vale para o projeto inteiro, a partir daqui: explicação não fica ao lado do
controle. O rótulo diz o que a coisa é; a explicação vive na dica que aparece
com o ponteiro parado. Um aplicativo de conversa não é um jogo que precisa de
tutorial, e o parágrafo embaixo de cada opção era metade da altura daquela tela.

Nada foi removido do que se podia ler — "a chave fica guardada neste
computador, só para este servidor", "reabre o Tumacord nesta conta sem pedir a
senha de novo", o que cada modo de conexão significa: tudo continua escrito, no
ponteiro. A regra está em `ARCHITECTURE.md`, na seção *Interface*.

**A reprovação intermitente do CI, diagnosticada**

"servidor encerrou (1)" reprovava a validação sem dizer por quê, sempre em um
arquivo que ninguém tinha tocado, e passava ao rodar de novo. Estava anotada
como suspeita de carga desde a 0.9.6.

Não era carga. As portas dos testes eram sorteadas entre 20.000 e 60.000, e o
comentário do próprio arquivo dizia que essa faixa estava "fora do que o sistema
entrega sozinho para portas efêmeras" — o que é falso: no Linux o padrão é
32768–60999. Dois terços das candidatas eram justamente portas que o núcleo pode
dar a qualquer conexão de saída.

Entre conferir a porta e o servidor de teste ligá-la passa a inicialização de um
processo Node inteiro, e nesse intervalo a suíte está abrindo dezenas de
conexões para `127.0.0.1`. Uma delas recebia do núcleo exatamente a porta
reservada; o servidor encontrava a porta ocupada e saía. A reserva entre
processos que existe desde a 0.9.6 não cobria isso — ela impede que outra suíte
pegue a porta, não que o núcleo a entregue a um cliente.

A faixa agora termina antes de onde as efêmeras começam, lido de
`ip_local_port_range` quando o sistema o expõe. E os servidores de teste passaram
a guardar o erro padrão: da próxima vez, "encerrou (1)" vem com o motivo escrito.

**Validação**

662 testes passam, em três execuções completas da suíte. Quatro novos cobrem o
chaveiro encostado no armazenamento do navegador: sair de uma conta convertida
da gaveta antiga, "esquecer tudo" depois da conversão, a gaveta antiga que
continua no disco e o descarte de uma sessão que ninguém adotou. Quatro cobrem a etiqueta de cada destino — com nome, sem
nome, e com o nome padrão do servidor embutido, que não vira nome de grupo.
Dois cobrem a faixa de portas dos testes contra a do sistema. A tela foi medida
no navegador, nos dois modos e nas duas larguras; o que está dito acima em
pixels foi lido da tela, não estimado.

O que **não** foi provado aqui: que a reprovação intermitente acabou. Ela é
intermitente, e três suítes verdes na minha máquina não são prova — a máquina
onde ela aparecia é a do CI. O que está provado é que a faixa não encosta mais
na do sistema, e que a próxima ocorrência dirá o motivo em vez de só o código.

## 0.9.7 — a live só começa quando você diz que quer

<!-- tumacord:resumo -->
Uma transmissão que começa não aparece mais sozinha na sua tela. Ela se anuncia, e você escolhe assistir.

- Enquanto você não escolhe, a imagem nem sai da máquina de quem transmite — não é só o vídeo que fica escondido.
- Parar de assistir encerra aquela transmissão para você e mantém a voz da call normal.
- Entrar numa call onde já existe uma live mostra o aviso do mesmo jeito.
<!-- /tumacord:resumo -->

**Assistir virou uma escolha, e a escolha vale de verdade**

Antes, a transmissão de alguém começava a chegar assim que era aberta: a mídia
atravessava a rede e a tela aparecia sozinha. Quem não queria assistir podia
esconder o quadro — mas os bytes continuavam vindo.

Agora quem transmite **anuncia** e não envia. As faixas da tela só entram no
enlace de quem pediu para assistir, e saem quando o pedido é desfeito. Esconder
um elemento de vídeo nunca foi controlar o recebimento; a inscrição é.

A voz continua igual em qualquer caso. Assistir ou não assistir não interrompe
a conversa, e a câmera também não muda: ela é parte da conversa, não uma
transmissão que alguém abre.

**Cada transmissão é uma transmissão**

O "sim" se refere àquela live, e não à pessoa. Se quem transmite encerrar e
abrir outra, o aviso volta a aparecer — ninguém consente com uma tela que ainda
não existia.

**Entrar no meio de uma live**

Quem chega depois recebe o mesmo aviso, porque o anúncio é enviado a todo mundo
que entra na call. O que não é enviado é a imagem.

## 0.9.6 — suas contas param de se atropelar

<!-- tumacord:resumo -->
Entrar em um servidor deixou de apagar as outras contas que você já tinha. Cada uma fica guardada no seu lugar, e voltar para qualquer uma é um clique na tela de entrada.

- Trocar de conta e sair da conta passaram a ser coisas diferentes: trocar mantém a conta guardada, sair encerra só aquela.
- Um convite para um lugar onde você já entrou não pede senha de novo — e nunca mais derruba as suas outras contas.
- Dá para pedir que o Tumacord lembre a chave de um servidor, separado de manter a conta conectada.
- O botão de procurar atualização continua funcionando mesmo com uma versão já encontrada, e quem está muito atrás instala direto a mais nova.
<!-- /tumacord:resumo -->

**Uma gaveta por destino**

Até aqui havia uma gaveta só. Entrar em um servidor dedicado escrevia por cima
do que o modo P2P lembrava; voltar para o P2P escrevia por cima do servidor. E
um convite para um destino diferente derrubava tudo — inclusive contas que nada
tinham a ver com aquele convite.

Agora cada destino tem a própria gaveta, endereçada pela mesma identidade
estável que separa o histórico: a instalação, no dedicado; o convite do grupo,
no P2P. A tela de entrada mostra as contas guardadas, e retomar qualquer uma
não passa por autenticação nenhuma.

**Quatro ações, quatro efeitos**

- **trocar de conta** fecha a gaveta e deixa a conta dentro dela;
- **sair da conta** encerra a sessão deste destino e não toca nas outras;
- **esquecer este destino** apaga a sessão e a chave dele;
- **esquecer tudo** esvazia o chaveiro.

**A chave do servidor ficou separada da sessão**

Elas eram a mesma coisa guardada no mesmo campo — e, pior, o mesmo campo
servia para a chave de acesso de um servidor e para a chave de convite de um
grupo P2P. Agora cada uma tem o seu lugar, e lembrar uma não é lembrar a outra:
as quatro combinações existem e valem.

A chave continua mascarada no campo, guardada por servidor, e desmarcar a opção
apaga a que estiver guardada. Vale dizer que mascarar o campo não protege o que
está no disco — armazenamento nativo protegido é um passo seguinte.

**Procurar atualização continua disponível**

O botão de procurar sumia assim que uma versão era encontrada — e enquanto
ninguém aplicava, outra podia sair sem que houvesse como saber. Agora ele só
some enquanto algo está acontecendo (procurando, baixando, aplicando), que é
quando ele não teria o que fazer. A procura ao abrir continua como era.

Procurar de novo com uma versão **já baixada** não joga o download fora: se a
oferta continua sendo a mesma versão, o arquivo no disco continua valendo.

**Pular versões, e quando não dá**

Quem está muito atrás recebe direto a mais nova — sem instalar sete versões no
caminho. Isso já era assim; o que faltava era poder procurar de novo para
descobrir que apareceu algo mais novo.

Às vezes pular não é possível: uma versão que converte dados só a partir do
formato imediatamente anterior precisa ser instalada antes das seguintes. Essa
versão passa a poder se declarar, e quem está abaixo dela passa por ela
primeiro — com a tela dizendo qual é a mais nova e por que o caminho passa ali.

**Convite: primeiro o destino, depois a autenticação**

O convite era resolvido depois de decidir a autenticação, e exigia a senha
guardada. Sem ela, derrubava a sessão. Agora o destino é resolvido primeiro: se
já existe conta aberta nele, ela é reaproveitada; se não existe, a tela explica
e leva à entrada **sem apagar nenhuma das contas guardadas**.

## 0.9.5 — cada conversa fica no lugar dela

<!-- tumacord:resumo -->
O que você conversa em um servidor agora fica guardado só para aquele servidor.
Antes, o histórico de todos os lugares ia para o mesmo canto do seu computador
— e podia reaparecer no grupo errado.

- Conversas de servidores diferentes não se misturam mais, nem com as do P2P.
- O histórico que já estava guardado antes desta versão continua aí para você,
  e deixa de ser enviado a outras pessoas.
- O aviso de versão nova agora mostra um resumo curto; os detalhes ficam na
  página da versão.
<!-- /tumacord:resumo -->

**O que este computador guarda, e de onde veio**

O Tumacord guarda no seu computador uma cópia do que você viu: é o que faz o
histórico aparecer rápido e sobreviver quando o host de um grupo P2P sai.

Essa cópia era guardada no mesmo lugar que o servidor embutido usa para
hospedar — um pote só, sem etiqueta. Na prática: a conversa de um servidor
dedicado era espelhada ali e passava a ser servida, e republicada, como se
fosse do grupo P2P desta máquina. Guardar e hospedar são responsabilidades
diferentes, e agora moram em lugares diferentes.

Cada cópia passa a levar a origem de onde veio, e a origem é uma identidade
estável — não o nome nem o endereço, que mudam e coincidem. Um servidor
dedicado declara a própria identidade, que continua a mesma se ele mudar de
endereço; um grupo P2P é identificado pelo convite, que continua o mesmo quando
o host troca de máquina.

**O histórico anterior a esta versão**

Ele está misturado e não há como saber de onde veio cada linha. Por isso ele
**não é apagado nem publicado**: quem continua vendo é quem está nesta máquina,
e para quem chega de fora ele não existe.

**O aviso de versão nova ficou curto**

A janela que abre dizendo o que mudou passa a mostrar um resumo de poucas
linhas. O texto completo — por que cada decisão foi tomada, o que estava errado
antes — continua inteiro na página da versão, que é onde ele serve para alguma
coisa.

## 0.9.4 — no dedicado, quem responde é o servidor

Esta versão sai da **0.9.3** e fecha três buracos de autoridade no servidor
dedicado. Nenhum deles aparecia no uso normal; os três apareciam para quem
fosse procurar.

**Mensagem assinada por outra pessoa**

A sincronização entre computadores existe para o P2P: quando o host troca de
máquina, cada participante devolve ao host novo o que tem, e a mensagem vem
assinada por quem a escreveu — porque é mesmo de outra pessoa.

No dedicado esse mesmo caminho estava aberto, e o autor vinha do pacote e não
da sessão. **Qualquer conta autenticada podia inserir no histórico uma mensagem
assinada por qualquer outra.** Junto vinha a segunda metade do problema: a
conversa inteira de um grupo P2P podia ser despejada dentro da comunidade.

Agora o dedicado não mescla pacote de replicação nenhum. Ali quem responde pelo
histórico e pelos perfis é o servidor, e ele já tem os dois: a mensagem chega
por `chat:send` e o perfil por `PUT /api/profile`, cada um com o autor
conferido. A outra metade da sincronização — **receber** o que o servidor tem —
continua igual nos dois modos, porque ela sempre foi legítima.

No P2P nada muda: a replicação continua sendo o que segura o histórico e os
perfis na troca de host, inclusive a regra de que uma cópia antiga não
substitui uma mais nova.

**O limite de pessoas da call não era aplicado**

O painel guardava o limite e a entrada nunca o consultava: a call aceitava todo
mundo, e quem o configurou não tinha como saber. Agora ele vale no servidor,
que é quem admite na sala.

Quem já está dentro não é expulso por um limite que baixou depois, e a
administração entra assim mesmo — um canal cheio não pode trancar do lado de
fora quem precisa mediar o que está acontecendo lá dentro.

**Canal apagado deixava gente na call**

Apagar um canal de voz com gente dentro deixava essas pessoas em uma sala de um
canal que já não existe: a interface não mostrava mais o canal, e sair dele
virava um problema. Agora elas são tiradas da call, avisadas do motivo, e a
sala fica vazia de verdade.

## 0.9.3 — o traço volta a ser um traço

Esta versão sai da **0.9.2** e conserta o que estava quebrado na mesa.

**Arrastar desenhava um ponto**

Clicar deixava um ponto; arrastar deixava o mesmo ponto e mais nada. Um arrasto
de 240 pixels chegava ao servidor como **uma operação, de um ponto** — o resto
da mão era descartado em silêncio.

A causa não era o ponteiro, a coordenada nem o desenho. Duas coisas diferentes
moravam no mesmo lugar: *o traço que a mão está fazendo* e *o eco desenhado na
tela enquanto a confirmação não volta*. O eco era apagado assim que o quadro
confirmado alcançava o que já tinha sido enviado — e numa rede local isso leva
milissegundos, **no meio do arrasto**. A partir dali cada movimento não tinha
mais em que se apoiar.

Agora são duas coisas separadas, com uma regra: **enquanto a caneta estiver
encostada, nada esquece o traço.** O mesmo arrasto que virava um ponto agora
chega inteiro.

Vale a pena dizer por que isso passou: um teste em laço apertado desenha a
linha certinha, porque nele a confirmação nunca chega no meio do movimento. Só
o ritmo de uma mão reproduz. É esse ritmo que o teste novo percorre.

**Excluir uma mesa, de verdade**

Havia limpar, encerrar e arquivar — nenhum deles apagava a mesa. Agora há
**excluir**, e ele é o único sem volta:

- **limpar** esvazia a folha e a mesa continua lá;
- **encerrar** para os desenhos e todo mundo continua vendo;
- **arquivar** tira da lista do dia a dia guardando o conteúdo;
- **excluir** apaga a mesa e o que foi desenhado nela, para todo mundo.

A exclusão pergunta antes, é gravada na hora e não volta: nem no reinício do
servidor, nem quando alguém que ainda tinha o quadro na memória tenta devolvê-lo
na troca de host do P2P. O que já foi exportado em PNG continua com quem salvou
— isso a exclusão não alcança, e a tela diz isso.

**Uma mensagem que mandava fazer a coisa errada**

O teto de mesas do servidor dizia *"Arquive alguma antes de criar outra"* e
continuava contando as arquivadas. Agora ele fala em excluir, que é o que
realmente libera espaço. O teto por canal continua liberando com o arquivamento,
porque ele conta só as mesas abertas.

**Auditoria**

Esta versão vem com `docs/AUDITORIA-0.9.2.md`: o que foi reproduzido, o que foi
confirmado lendo o código, o que não foi olhado, e qual é a próxima etapa
recomendada — com a evidência de cada coisa.

## 0.9.2 — a janela fechada não fecha o Tumacord

Esta versão sai da **0.9.1** e conserta três coisas que apareceram em uso.

**O ícone da bandeja passou a servir para alguma coisa**

Ele existia desde antes, e não adiantava nada: fechar a janela destruía a
janela, e o aplicativo inteiro ia junto — inclusive o ícone. Não havia nada
para trazer de volta.

Agora **fechar a janela esconde**. O Tumacord continua rodando, o ícone fica lá,
e clicar nele traz a janela de volta. O menu do ícone tem "Abrir", "Ocultar" e
**"Sair do Tumacord"**, que é a única saída de verdade.

Esconder, e não destruir, é o ponto: a janela é quem sustenta a call, a captura
de tela e a live flutuante. Fechá-la de verdade e recriá-la derrubaria a sessão
de mídia de quem só queria tirar a janela da frente. Da primeira vez que a
janela some, um aviso curto explica para onde ela foi.

No macOS nada muda: ali fechar a janela e manter o aplicativo no Dock é o que o
sistema espera.

**"Criar mesa" não fica mais preso em "Criando…"**

Quem atualizou o aplicativo e não atualizou o servidor clicava em criar e ficava
esperando para sempre. O motivo não era erro nenhum: era **silêncio**. Um
servidor que não conhece o pedido simplesmente não responde, e a espera não
tinha prazo.

Duas coisas mudaram. O servidor agora **declara** que tem mesas, e o aplicativo
pergunta antes de oferecer o botão: contra um servidor anterior à 0.9.1, onde o
"+" ficava, aparece *"Este servidor ainda não tem mesas de desenho — atualize o
servidor"*. E toda conversa da mesa ganhou prazo: se a resposta não vem, aparece
uma explicação em vez de uma espera infinita.

**Os arquivos de atualização param de se acumular**

O Tumacord baixa a versão nova para `updates`, dentro da pasta de dados do
aplicativo. Depois de aplicada, o arquivo era apagado no Linux — mas não em dois
casos: o **instalador do Windows**, que não pode ser apagado enquanto está
rodando, e qualquer download que alguém tenha feito e nunca aplicado. Cada um
desses passa dos noventa megabytes, e eles ficavam lá para sempre.

Agora a pasta é varrida na abertura e logo depois de cada atualização aplicada.
O que está em uso resiste à varredura e some na abertura seguinte; um download
em andamento nunca é tocado.

**As configurações de desenho foram refeitas**

A seção se chamava "Desenho na tela" e falava só de rabiscar sobre a
transmissão de alguém. No Linux ela era uma página inteira sobre um recurso que
não funciona ali — uma caixa desmarcada e desabilitada, e três parágrafos
explicando por quê.

Agora ela se chama **Desenho** e separa as duas coisas que passaram a existir: a
**mesa**, que é um quadro do grupo e não tem configuração nenhuma ali (quem a
criou manda nela, de dentro dela), e o **apontamento** sobre uma transmissão,
que continua sendo o que sempre foi. Onde o apontamento não funciona, uma linha
diz isso e acabou.

## 0.9.1 — uma mesa de desenho para o grupo

Esta versão sai da **0.9.0** e acrescenta uma coisa: um quadro em branco dentro
do app, onde várias pessoas desenham ao mesmo tempo.

**O que muda no dia a dia**

Na barra dos canais apareceu **Mesas de desenho**. Você clica no `+`, dá um
nome, e recebe uma folha em branco. Quem enxerga aquele canal recebe o anúncio
e escolhe **entrar na mesa** — ninguém é arrastado para dentro dela.

A mesa **não depende de live**. Não é preciso estar transmitindo a tela, não é
preciso estar em call, e não existe janela sobreposta ao jogo no meio do
caminho. É por isso que ela funciona igual no Linux e no Windows: o desenho
acontece dentro do Tumacord, e não sobre a área de trabalho de alguém.

Se a call estiver acontecendo, ela continua acontecendo. A voz não é
interrompida para desenhar, e desenhar não exige a voz.

**O que dá para fazer nesta primeira versão**

Caneta, sete cores, cinco espessuras. Borracha que apaga **o traço inteiro**,
nunca um pedaço dele. Desfazer o seu próprio traço. Zoom e deslocamento da
folha. Lista de quem está na mesa. Exportar o quadro em PNG.

O zoom é **seu**. Aproximar para olhar um canto não arrasta a visão de mais
ninguém: a folha tem coordenadas próprias, e cada pessoa olha para ela de onde
quiser, em qualquer tamanho de janela.

**Quem criou a mesa manda nela**

Bloquear novos desenhos, aceitar ou recusar observadores, tirar e devolver a
permissão de desenhar de uma pessoa, limpar o quadro, encerrar e — no servidor
dedicado — arquivar guardando o conteúdo.

**Limpar tudo pergunta antes.** Ele apaga o trabalho do grupo, e não só o seu.

Tirar a permissão de alguém vale na operação seguinte, e não na próxima vez que
a pessoa entrar: quem foi rebaixado a observador para de desenhar na hora,
continuando a ver o quadro.

**Desfazer nunca apaga o trabalho alheio**

Desfazer age sobre um objeto identificado e **seu** — não sobre "o último item
da lista", que quase sempre é de outra pessoa. A borracha segue a mesma regra:
cada um apaga os seus, e quem gerencia a mesa apaga os dos outros. A recusa
mora no servidor, não na interface: esconder um botão é conveniência, não
autorização.

**Nada some sozinho para liberar espaço**

O desenho sobre a live guarda no máximo 64 traços e joga fora o mais antigo —
o que é correto para um apontamento que ia sumir de qualquer jeito, e seria
destruição numa mesa. Aqui o teto é outro, e o comportamento no teto é outro:
ao encostar no limite, **a operação nova é recusada com uma mensagem** e o que
já está desenhado continua exatamente onde estava.

**Entrar atrasado, cair e voltar**

Quem entra no meio recebe o quadro em uma revisão conhecida mais tudo o que
aconteceu depois — inclusive o que aconteceu enquanto a tela carregava. Quem
cai e volta diz até onde chegou e recebe só a diferença; se ficou para trás
demais, recebe o quadro inteiro.

Cada pedaço de traço viaja com identidade própria, e é por isso que uma
reconexão que reenvia o que já tinha enviado **não desenha duas vezes**.

**No servidor dedicado, a mesa fica**

Ela é gravada no arquivo do servidor e volta inteira quando ele reinicia. A
gravação acontece já na primeira operação e não espera a mão parar, então a
mesa não depende de o servidor ser desligado com educação — e quando ele é,
ele grava antes de sair.

**No P2P, a mesa dura enquanto o grupo durar**

Quem ordena as operações é o host, que é o mesmo processo rodando na máquina de
quem abriu a call. Se o host sair, o servidor do próximo sobe vazio e quem
estava na mesa devolve o quadro — a mesa atravessa a troca de host e o grupo
continua de onde parou.

Isso está dito na tela, dentro da própria mesa, junto com o botão de exportar:
**ela não é guardada em servidor nenhum** e some quando a última pessoa sai. E
ela não atravessa para fora do grupo: um servidor dedicado recusa qualquer mesa
vinda de fora, e no P2P só quem está na call agora devolve a mesa dela.

**Detalhes que não aparecem, mas se sentem**

- o cursor das outras pessoas aparece enquanto elas mexem e some quando param;
  ele não entra no histórico e não sobrevive a um recarregamento;
- com a janela em segundo plano, a mesa para de pintar e de mandar cursor —
  a sincronização continua, então voltar não mostra um quadro velho;
- o traço sai da sua mão na hora, sem esperar a ida e a volta pela rede;
- o histórico é compactado em snapshot quando cresce, e **compactar troca
  histórico por snapshot, nunca traço por espaço**.

## 0.9.0 — o aplicativo avisa quando existe versão nova

Esta versão sai da **0.8.8**, não da 0.8.9. A 0.8.9 foi retirada (veja abaixo), e
o que ela mexeu em captura, qualidade e diagnóstico gráfico não vem junto: ela
continua na branch `release/graphics-and-capture-v0.8.9` para quem quiser
retomar aquele trabalho a partir de uma base medida.

**Descobrir que existe versão nova deixou de depender de alguém avisar**

Até aqui, saber que saiu uma versão dependia de alguém dizer no grupo. Quem não
visse a mensagem ficava para trás — e foi assim que gente ficou parada em versão
com defeito conhecido.

Agora o Tumacord olha as Releases publicadas **toda vez que abre**. Só isso: uma
consulta e uma comparação. Nada é baixado, nada é instalado, nada acontece
sozinho — a hora errada de trocar de versão é no meio de uma call, e é durante
uma call que este aplicativo é usado.

**Baixar é um clique; aplicar é outro, quando você quiser**

O botão fica na barra de cima e é sempre o mesmo botão: com uma versão esperando
ele ganha um ponto, e sem nada a fazer ele continua sendo por onde se procura de
novo. Dentro dele estão a versão oferecida, o que mudou nela, o tamanho do
arquivo e um botão por vez — baixar, depois aplicar. "Agora não" cala o aviso
daquela versão, e ele volta na próxima.

**Aplicar faz coisas diferentes, e cada uma é dita antes**

- **Linux instalado pelo script:** a build nova entra em uma pasta própria e só
  o atalho `current` é trocado, de uma vez. É exatamente o que o instalador já
  fazia. **A call aberta não é interrompida:** a sessão continua lendo a pasta
  antiga, que ninguém tocou, e a versão nova vale ao reabrir. A anterior fica
  apontada por `previous`, que é o caminho de volta;
- **AppImage:** o arquivo é substituído no lugar. A sessão aberta continua
  inteira porque ela já está montada;
- **Windows instalado:** o instalador é aberto e o Tumacord fecha para ele poder
  substituir a instalação. O Windows pede confirmação, como sempre;
- **Windows portátil:** um executável em uso não pode ser substituído. O novo
  fica guardado ao lado do atual e a troca é sua, com o aplicativo fechado;
- **Cópia de origem desconhecida:** o aviso existe, o botão de aplicar não. Não
  há como adivinhar onde escrever sem arriscar escrever no lugar errado.

**Versão marcada como quebrada não é oferecida a ninguém**

Uma versão pode ser condenada de duas formas: pela lista embutida no aplicativo
e por uma marca nas notas da Release — e as notas de cada Release saem deste
CHANGELOG. Marcar aqui e republicar as notas faz **toda cópia instalada** parar
de oferecer aquela versão, inclusive as que já estavam na rua quando o defeito
apareceu.

Quem já estiver rodando uma versão condenada é avisado disso na cara, e o aviso
não some quando ignorado: ignorar não conserta.

**O que mudou nesta versão, uma vez**

Na primeira abertura depois de atualizar, o texto da Release aparece uma vez —
não importa se a atualização veio pelo botão, pelo comando de instalação ou de
alguém trocando o arquivo à mão. O Markdown é lido em blocos e desenhado como
texto: **nada do que chega pela rede vira HTML**.

**O cuidado com o que é baixado e executado**

O endereço do arquivo vem de uma resposta da rede, e um instalador é um
executável. Por isso: só `https`, só GitHub, e cada redirecionamento conferido de
novo; tamanho conferido e SHA-256 comparado com o resumo publicado antes de
qualquer coisa rodar; teto de tamanho; e o nome do arquivo higienizado antes de
virar caminho em disco.

**Os caminhos de sempre continuam existindo**

O comando de instalação e a página de Releases estão escritos dentro da própria
tela de atualização — inclusive quando não há arquivo para o jeito daquela
cópia, que é justamente quando eles são a única saída.

Procurar ao abrir pode ser desligado; o botão de procurar continua ali.

**Desenhar na tela dos outros virou coisa do Windows**

A janela que pinta o traço sobre a área de trabalho é o que dá sentido a
desenhar na live de alguém: quem transmite continua olhando para o jogo, não
para o Tumacord, e é lá que o traço precisa aparecer. No Windows ela se
comporta — não rouba foco, e sai da própria captura por
`setContentProtection`.

No Linux, não. Ela tira o foco do teclado de quem estava jogando e não devolve
para ninguém, e o portal do PipeWire não sabe deixá-la fora da captura: o traço
volta dentro do próprio vídeo. Quem estava transmitindo perdia o controle do
jogo no instante em que alguém apontava alguma coisa.

Então a permissão deixou de ser só uma preferência de quem transmite. **O
sistema de quem transmite decide primeiro**, e só o Windows recebe desenho:

- transmitindo do Windows, tudo como antes;
- transmitindo do Linux, ninguém desenha na sua live. Quem assiste vê o lápis
  **desabilitado** no canto do seu quadro, translúcido, dizendo por quê — em vez
  de um botão que sumiu sem explicação ou de um traço que não chega;
- você, no Linux, continua desenhando na transmissão de quem está no Windows;
- a recusa mora no servidor, não na interface: nem um cliente modificado pinta
  na área de trabalho de quem não pode receber;
- um cliente anterior à 0.9.0 não declara em que sistema está, e por isso é
  tratado como quem não recebe. Adivinhar o sistema de alguém para pintar na
  área de trabalho dele seria a escolha errada.

**Um botão de tela cheia a menos**

Havia dois botões de maximizar fazendo coisas diferentes: o da barra de cima
punha a *janela* em tela cheia, e o do canto de cada live punha o *vídeo*. O
primeiro saiu. Ele continua no **F11**, como em qualquer navegador, e o da live
— que é o que alguém quer numa call — continua exatamente onde estava.

## 0.8.9 — retirada

<!-- tumacord:versao-quebrada -->

> **Não instale esta versão.** As resoluções e o FPS da transmissão saem
> errados. Ela foi publicada com a validação final pendente — o jogo não foi
> medido com a live aberta, não houve teste com um segundo participante e nada
> foi executado em uma máquina Windows de verdade — e o defeito apareceu em uso.
> Use a **0.9.0**. Quem estiver nela será avisado pelo próprio aplicativo a
> partir da 0.9.0; quem estiver na 0.8.9 precisa atualizar pelo comando de
> instalação ou pela página de Releases.

Ela tentou consertar um problema real e medido: no CachyOS/KDE, abrir um jogo com
uma live sendo enviada e outra sendo assistida corrompia a interface e derrubava
o jogo para perto de 8 FPS. A medição encontrou o motivo — encoder de vídeo por
software com composição por GPU ligada, 43 ms por quadro contra 1,5 ms — e a
resposta foi fazer o perfil de qualidade valer também para a captura, que até a
0.8.8 pedia 1440p60 em todo perfil.

A resposta estava certa na explicação e errada no resultado: a qualidade
escolhida deixou de ser respeitada, e a live passou a sair em resolução e
cadência que ninguém pediu.

O trabalho não foi jogado fora. Ele continua na branch
`release/graphics-and-capture-v0.8.9`, com a medição inteira em
`docs/RELATORIO-0.8.9.md`, e é de lá que a correção deve sair — a partir de
números que já existem, e não de outro chute.

## 0.8.8 — o Windows para de devolver a call pela live

Até aqui, o áudio da transmissão no Windows saía do loopback do Chromium: uma
cópia do dispositivo de saída inteiro. Ele funcionava — e carregava junto o
Discord, o próprio Tumacord e a voz de quem estava na call. Quem transmitia com
áudio devolvia a chamada para dentro da live, e a única defesa era pedir para
todo mundo usar fone.

Agora o Windows captura por **aplicação**, não por dispositivo. E ganhou um
instalador de verdade.

**O que entra no áudio da live**

- **transmitindo uma janela**: só o som daquela aplicação. Um jogo compartilhado
  leva o som do jogo, e nada além dele — nem o navegador atrás, nem a
  notificação de outro programa;
- **transmitindo um monitor inteiro**: o som do sistema, menos o Tumacord, o
  Discord (com Canary e PTB) e os processos de áudio deles;
- nos dois casos, a voz da call — a do Tumacord e a do Discord — nunca é
  capturada. Não é cancelamento de eco: essas aplicações simplesmente não
  entram na captura. O laço é cortado na origem, que é o único lugar onde ele
  some de verdade;
- os sons de interface do próprio Tumacord também ficam de fora.

**O que o Tumacord não faz para conseguir isso**

- não muta o Discord, não mexe no volume dele e não o fecha;
- não troca o dispositivo de áudio padrão do Windows;
- não instala driver de áudio virtual. Nada de VB-Cable, VoiceMeeter ou
  equivalente;
- não pede para ninguém configurar o Mixer de Volume à mão.

A captura é feita com a API oficial de loopback por processo do Windows
(`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`), por um processo auxiliar de
14 KB que vem dentro do pacote, sobe junto com a live e morre com ela.

**Quando o Windows não sabe isolar**

Loopback por processo existe a partir do Windows 10 build 19041. Em versões
anteriores, o aplicativo detecta isso — tentando uma ativação de verdade, não
comparando número de build — e diz:

> Nesta versão do Windows, o áudio da aplicação não pode ser isolado com
> segurança. A transmissão continuará sem áudio.

O vídeo continua funcionando. **Não existe reserva**, e é de propósito: a única
alternativa técnica seria voltar a capturar o dispositivo inteiro, que é
exatamente o defeito que esta versão corrige. Transmitir sem áudio é honesto;
transmitir devolvendo a call não é.

**A lista acompanha o que acontece durante a live**

- um jogo aberto no meio da transmissão entra no som sozinho;
- o Discord aberto no meio da transmissão **não** entra;
- um programa que fecha sai sem engasgar a live;
- um programa que reinicia é capturado de novo com o processo novo;
- pai e filho da mesma aplicação viram uma captura só — antes disso seria o
  mesmo som somado consigo mesmo;
- a identificação é por processo e árvore de processos, nunca por título de
  janela.

**Instalador de verdade no Windows**

- `Tumacord-0.8.8-Setup.exe`, instalador NSIS assistido: escolha de pasta,
  atalhos no Menu Iniciar e na área de trabalho, registro em **Aplicativos
  instalados** e desinstalador próprio;
- `Tumacord-0.8.8-portable.exe` continua existindo como alternativa;
- ícone `.ico` com sete tamanhos, em vez de uma imagem esticada;
- instalar por cima preserva conta, mensagens, anexos, perfis e preferências.
  Com o aplicativo aberto, o instalador avisa e o encerra antes de continuar;
- uma única confirmação do Windows, durante a instalação. Nenhuma ao abrir;
- **nada precisa estar instalado na máquina**: nem Node, nem npm, nem
  redistribuível do Visual C++.

**Firewall**

Duas regras criadas pelo instalador, presas ao executável do Tumacord e
limitadas aos perfis Privado e de Domínio: TCP 3927 para a sinalização e
UDP 3928 para a descoberta na rede local, esta restrita à própria sub-rede. O
perfil Público nunca é liberado, o firewall nunca é desligado, e as regras são
removidas na desinstalação — mas não na atualização.

**Assinatura**

A pipeline aceita certificado Authenticode tradicional ou Azure Trusted
Signing, assina executável principal, instalador, portátil e o componente
nativo, usa carimbo de tempo e depois **verifica** com `Get-AuthenticodeSignature`.
Com a variável `TUMACORD_REQUIRE_SIGNING`, uma release sem assinatura falha em
vez de sair torta. Nenhum certificado, senha ou token entra no repositório.

Sobre o SmartScreen, sem promessa vazia: assinar não faz o aviso sumir de
imediato. A reputação se constrói por downloads ao longo do tempo, na mesma
identidade de publisher. O que o projeto não faz, em hipótese alguma, é sugerir
desligar SmartScreen, Defender, Smart App Control ou UAC.

**Windows e Linux continuam a mesma call**

Nada de protocolo paralelo. SDP, ICE, STUN, TURN, Socket.IO, sinalização,
eventos, metadados de transmissão, telestração, reconexão, migração de host e
chat são exatamente os mesmos. Para quem está do outro lado chega uma faixa de
áudio WebRTC comum — não há como saber se ela nasceu de um barramento do
PipeWire ou de uma captura WASAPI.

A implementação do Linux **não foi tocada**. Ela continua montando o barramento
temporário no PipeWire, continua deixando Tumacord e Discord de fora, continua
não virando microfone padrão do sistema, e todos os testes dela continuam
passando. O que mudou foi a existência de uma camada por plataforma
(`LinuxScreenAudioBridge` e `WindowsScreenAudioRouter`) atrás da mesma API.

**Diagnóstico**

Configurações › Diagnóstico agora mostra também o áudio da transmissão:
mecanismo em uso, captura ativa ou não, se o isolamento por aplicação está
disponível, quantas aplicações entraram, quantas ficaram de fora e por quê,
faltas e descartes do amortecedor, e reinícios do componente. Sem nome de
aplicativo, sem título de janela, sem endereço — o relatório continua colável
em qualquer conversa.

**Dois defeitos do desenho, corrigidos**

- **não dava para sair do modo de desenho.** A camada de desenho cobre o quadro
  inteiro e ficava *acima* dos botões do quadro: o lápis que liga o modo era o
  único jeito de desligá-lo, e ele estava embaixo da própria camada que tinha
  acabado de ligar. Os botões passaram para cima, e **Esc** virou uma segunda
  saída — a que não depende de acertar um alvo pequeno;
- **no Linux/Wayland o traço não aparecia para quem estava transmitindo.** A
  janela sobreposta ao desktop recebia os traços por IPC no mesmo instante em
  que era criada, antes de a página terminar de carregar. `webContents.send`
  para uma página que ainda não carregou não enfileira nada: a mensagem se
  perdia, e a sobreposição ficava em branco. No Windows o carregamento é rápido
  o bastante para a maioria dos traços chegar; no Wayland, onde mapear a janela
  demora mais, ela nunca chegava a pintar. Agora o traço mais recente fica
  guardado e é pintado assim que a página existe;
- ainda no Wayland: alguns compositores ignoram `showInactive` numa janela não
  focável, e a sobreposição existia sem ninguém a ver. Quando isso acontece, um
  `show` normal é tentado em seguida.

**Compatibilidade**

- nenhuma mudança em convite, sinalização, banco de dados, API ou portas;
- um cliente 0.8.7 e um 0.8.8 conversam normalmente na mesma call;
- o servidor dedicado não precisa ser atualizado para esta versão;
- a build do Windows passou a sair de um runner Windows de verdade, porque
  agora há código nativo para compilar. O pipeline do Linux não mudou.

## 0.8.7 — desenhar na tela de quem está transmitindo

Quem assiste a uma transmissão pode rabiscar em cima dela para apontar alguma
coisa. O traço aparece para quem transmite, para quem desenhou e para todo mundo
que estiver vendo a mesma live — e, quando o que se compartilha é o monitor
inteiro, ele aparece **sobre o desktop de verdade**, não só dentro do Tumacord.
É o que permite continuar olhando para o jogo ou para o editor e ainda ver o que
estão apontando.

**A permissão é de quem transmite**

- em **Configurações › Desenho na tela**, a chave **Deixar quem assiste desenhar na minha transmissão**. Desligada, o lápis some do quadro para quem está vendo, o que já estava desenhado é apagado na hora, e o servidor passa a **recusar** qualquer traço destinado à sua tela — nem um cliente modificado desenha nela. Esconder o botão é conveniência; quem decide é o servidor, a mesma regra que já vale no painel de administração;
- religar volta a funcionar na hora, sem precisar sair e entrar na call.

**Quanto tempo o traço fica, incluindo "para sempre"**

- quatro escolhas: **3 s**, **6 s** (padrão), **15 s** e **não apagar sozinho**. Também de quem transmite, porque é a mesma tela e a mesma decisão;
- com prazo, o traço desaparece suave em vez de piscar — o desvanecimento é um terço da vida, no máximo dois segundos;
- **sem prazo**, o desenho fica parado até alguém limpar. São três os caminhos: quem desenhou limpa o próprio traço, quem transmite limpa tudo pelo borrachinha no canto do quadro, e tudo é apagado quando a transmissão termina. Um teto de 64 traços é o que impede a tela de virar um borrão depois de meia hora.

**As mecânicas**

- **arrastar** faz um traço; **um toque sem arrastar** deixa um apontador que pulsa e some — o "olha aqui" mais curto que existe;
- **cada pessoa desenha na própria cor**, que começa igual à cor de destaque do perfil e pode ser trocada em uma paleta de seis. Dá para saber quem apontou o quê sem legenda nenhuma;
- o traço sai com um contorno escuro por baixo: sem ele um traço claro some sobre um fundo claro, que é metade do que se transmite;
- o lápis liga e desliga o modo de desenho por quadro. Desligado, a camada não intercepta clique nenhum — o duplo clique que amplia e o arrasto da janela flutuante continuam como sempre.

**Coordenadas que significam a mesma coisa nas duas pontas**

- um ponto viaja como fração de 0 a 1 do quadro capturado, nunca em pixels. Quem desenha em uma janela de 600 px e quem transmite em 4K veem o traço no mesmo lugar do conteúdo;
- as barras pretas do `object-fit: contain` são descontadas: sem isso o traço escorrega, e o erro cresce quanto mais diferentes forem as duas janelas. Clique na barra preta não vira traço.

**A janela sobreposta ao desktop**

- transparente, sem moldura, sempre no topo, sem roubar foco e deixando o clique passar. Ela cobre o monitor que está sendo capturado;
- **só para monitor inteiro.** Capturando uma janela, o quadro é aquela janela — e não dá para saber onde ela está na tela nem se ela se moveu desde então. Nesse caso a sobreposição não abre e o desenho continua aparecendo dentro do aplicativo, que é onde as coordenadas fecham;
- transparência, alfinete e clique-passante dependem do compositor. Toda chamada de enfeite é tentada e esquecida: um KDE, GNOME ou DWM que recuse não derruba nada, e a camada de dentro do aplicativo continua funcionando.

**Limites, que é onde mora a proteção**

- um balde de fichas por socket no servidor: a mão de quem desenha passa, a inundação de um cliente adulterado não — cada mensagem é reenviada para a sala inteira;
- coordenada fora da faixa é grampeada, cor que não é `#rrggbb` cai na cor padrão, traço interminável é cortado em 600 pontos, e nada disso derruba o servidor;
- só se desenha sobre uma transmissão que existe, de alguém que está na mesma call e que permite. Limpar tudo é só de quem transmite.

**Compatibilidade**

- `allowDraw` e `drawLifetime` são campos novos e opcionais no estado de voz. Um cliente anterior à 0.8.7 não os envia, e ausência é lida como permitido — o padrão de quem tem a versão nova. Ele simplesmente não desenha nem vê traço;
- nada mudou em convite, sinalização de mídia, banco de dados ou API;
- 448 testes, contra 404 na 0.8.6. Os 44 novos cobrem geometria, prazo, limites, e o fluxo inteiro contra um servidor de verdade — inclusive a recusa com a opção desligada.

## 0.8.6 — o aparelho removido volta a sumir da lista

Validação de release da 0.8.5. Ela encontrou **um** defeito, e ele tinha sido
introduzido pela própria correção anterior.

**A proteção contra o seletor piscando não tinha prazo**

- a 0.8.5 parou o seletor de microfone, saída e câmera de esvaziar sozinho durante as rajadas de `devicechange` do PipeWire: um tipo que viesse vazio mantinha os aparelhos que já se conhecia;
- só que essa preservação valia para sempre. **Quem tem um único microfone e o desconecta produz uma enumeração vazia que está CERTA** — e o aparelho continuava no seletor indefinidamente. Escolhê-lo falhava e caía no padrão do sistema com um aviso. Um defeito trocado por outro;
- reproduzido: mil enumerações vazias seguidas e o `mic-usb` ainda listado;
- agora a preservação é uma **janela de oito segundos**. Dentro dela, vazio é o navegador não contando; passada ela, vazio é a verdade. Oito segundos cobrem com folga a sacudida do grafo do PipeWire, que se assenta em um a três segundos e é o que a montagem do barramento da live provoca;
- e um detalhe que a janela sozinha não resolvia: `devicechange` só chega quando algo muda. Desconectar o único microfone dispara um evento e mais nenhum — a janela venceria sem ninguém olhar. Quem preserva agora agenda um único reexame para o instante em que o prazo termina.

**O resto da validação não encontrou defeito, e isso foi verificado, não presumido**

- **teste de mutação**: os 16 defeitos corrigidos na 0.8.5 foram recolocados um a um no código, e em todos os casos a suíte reprovou. Um teste que passa com o bug de volta não protege nada; nenhum destes passou;
- **convite**: 24 casos — código com espaço, quebra de linha e minúsculas; token curto, longo e fora do alfabeto; esquema, porta, credencial embutida e caminho inválidos no servidor; convite longo vencido; servidor fora do ar, lento, respondendo 404, 500, JSON sem `callId` e HTML de portal de wifi. Nenhum código inválido é resgatado pelo caminho de reserva, e nenhum deles chega a virar consulta de rede;
- **endereço da interface**: caminhos com espaço, acento, `%`, parênteses e `C:\Program Files`. O `#` mereceu caso próprio: era o único em que a concatenação `file://` parecia certa e apontava para outro arquivo. A guarda de navegação continua recusando qualquer endereço que não seja o do próprio aplicativo, inclusive `file:///etc/passwd`, `javascript:` e `data:`;
- **servidor embutido quebrado**, medido no aplicativo empacotado: a janela abre, o erro fica registrado no diagnóstico com o caminho que faltou, a tentativa acontece uma única vez e o processo segue de pé. Não há retry previsto pela arquitetura, e nenhum foi inventado aqui;
- 404 testes, contra 389 na 0.8.5.

**Compatibilidade**

- nada mudou em convite, sinalização, banco de dados ou API. A única mudança de comportamento é a lista de dispositivos deixar de guardar um aparelho ausente por mais de oito segundos;
- `preserveKnownDevices` passou a devolver `{ devices, absence, recheckInMs }` em vez de um vetor. É uma função interna da interface, não faz parte de nenhum contrato entre máquinas.

## 0.8.5 — a interface para de sumir sob carga, e o convite curto passa a ser aceito

Esta versão é o resultado de uma auditoria da 0.8.4. Ela não muda formato de
convite, protocolo, dados persistidos nem API pública: um servidor 0.8.4 e um
cliente 0.8.5 continuam se entendendo nos dois sentidos, e a 0.8.4 segue
instalável a partir da branch dela.

**O convite curto não era aceito pela própria interface**

- o servidor da 0.8.4 emite `TUMA2~servidor~TOKEN`, e a interface não sabia lê-lo. **Entrar por convite** conferia o código com `readInvite`, que só entende o formato `TUMA1`, e recusava antes de tentar alcançar o servidor: *"Código inválido ou vencido. Peça um convite novo ao host."* — para um código emitido segundos antes. A tela de entrada tinha o mesmo furo, porque só chamava `resolveInvite`;
- os dois caminhos passam agora por `inviteFormat` e `resolveAnyInvite`, que conhecem os dois formatos. Os campos deixaram de anunciar `TUMA1.…` como exemplo. O fluxo inteiro — servidor emite, interface reconhece, login entra — virou teste contra um servidor de verdade.

**Interface sob carga alta: atraso deixou de significar "não existe"**

O relato era de opções e botões que somem e voltam quando a máquina está ocupada. A causa é a mesma em quatro lugares: um valor que demorou, falhou por timeout ou chegou fora de ordem virava `null`, `[]` ou `false` — e a tela lia isso como ausência definitiva.

- **a lista de dispositivos era substituída por completo a cada `devicechange`.** No Linux esse evento chega em rajada: o PipeWire sacode o grafo quando outro programa abre ou solta uma captura, e o próprio Tumacord carrega e descarrega módulos ao montar o barramento de áudio da live. Nessas janelas `enumerateDevices()` responde uma lista curta ou vazia, e o seletor de microfone, saída e câmera ficava só com "Padrão do sistema" antes de voltar sozinho. Agora um tipo que veio vazio mantém o que já se sabia; um tipo que veio com pelo menos um aparelho é aceito inteiro, para um aparelho desligado continuar sumindo. E duas enumerações em voo deixaram de poder gravar uma por cima da outra;
- **o painel de administração tratava um `/api/health` que falhou como um servidor velho.** Os dois produziam o mesmo objeto — nenhuma capability —, e o painel inteiro era substituído por "este servidor ainda não tem gerenciamento de canais, gerenciamento de usuários e registro de auditoria". No meio de uma sessão em que a pessoa acabara de usar o painel. `readCapabilities` passou a distinguir "respondeu" de "não respondeu", e o que o servidor já declarou saber fazer sobrevive a uma consulta perdida;
- **toda ação administrativa apagava a tela antes de recarregar.** `loading` virava verdadeiro, as listas sumiam e voltavam; e duas recargas cruzadas podiam terminar com a mais velha por cima da mais nova. Agora o valor anterior fica em tela enquanto a leitura corre, e resposta de geração antiga é descartada;
- **uma sondagem de rede que não deu certo anunciava "sem entrada", "IPv6 ausente" e "NAT não medido"**, e a tela chegava a dizer que a verificação "está disponível apenas no aplicativo instalado" — dentro do aplicativo instalado. O último relatório bem-sucedido continua em tela, com o aviso de que a medição nova não respondeu;
- a regra ficou em `src/lib/freshness.ts`, com seis estados em vez de dois — desconhecido, carregando, disponível, atualizando, envelhecido e falho — e um número por pergunta, para resposta atrasada não vencer resposta nova. Uma simulação de respostas embaralhadas com falhas no meio guarda as invariantes.

**Salvar o perfil derrubava a call**

- `onLogout` era criada a cada renderização e entrava nas dependências do efeito que abre o socket. Trocar o avatar muda a sessão, a sessão re-renderiza o `App`, a função muda de identidade — e o efeito derrubava o socket, o hook de voz perdia a conexão e a malha inteira era reconstruída. O mesmo valia para a troca de host e para a entrada por uma call vista na rede.

**Windows**

- **`file://` colado a um caminho de arquivo** só dá certo no Linux, onde o caminho já começa com `/` e completa as três barras. No Windows o resultado (`file://C:\…`) é normalizado pelo navegador para `file:///C:/…`, e a comparação de `will-navigate` — que guarda o texto original — deixa de bater e passa a recusar a navegação legítima do próprio aplicativo. Um caminho de instalação com espaço ou acento quebra igual no Linux. Agora o endereço vem de `pathToFileURL`;
- `WebRTCPipeWireCapturer`, `WaylandWindowDecorations` e `ozone-platform-hint` são do Linux e eram ligados em todo sistema. Fora do Linux a lista sai vazia.

**Falhas que deixavam o aplicativo mudo**

- **o servidor embutido que não subia levava a janela junto.** A falha subia por uma promessa que ninguém tratava, e o resto da inicialização — inclusive `createWindow` — não corria: o aplicativo abria e não mostrava nada, sem uma linha explicando. Agora a falha é registrada no diagnóstico, o modo P2P fica indisponível e a janela abre, com o servidor dedicado ainda ao alcance;
- **pedir um convite ao servidor não tinha prazo.** Um servidor que aceita a conexão e não responde deixava a janela em "Pedindo um código ao servidor…" para sempre. Oito segundos, e depois o formato longo como reserva. O painel de administração ganhou o mesmo tipo de prazo;
- **o relatório de alcance vazio não trazia `score`**, que é o que a interface envia ao servidor na eleição de host. O servidor recusava o valor por não ser número, e uma sondagem que falhou deixava o computador sem nota de alcance nenhuma.

**Coisas menores, todas medidas**

- `store.touchUser` existia sem nenhum ponto de chamada: o painel mostrava "visto ⟨data⟩" desde a 0.8.1 e o campo nunca era preenchido. Agora entrar carimba, no máximo uma vez por minuto;
- o aviso de calls descobertas era enviado a **todas** as janelas, incluindo a janela solta da live, que não tem preload nem ouvinte — trabalho de IPC gasto a cada segundo durante uma transmissão;
- a leitura inicial de calls podia chegar depois de um aviso mais novo e devolver à tela uma lista vencida;
- o indicador de conexão continuava dizendo "conectado" durante a troca de host, que é o momento em que não há socket nenhum;
- o README ainda descrevia o convite que carregava os endereços do host — caminho removido na 0.8.3, e contradito pelo próprio README algumas linhas abaixo.

**Compatibilidade**

- nada mudou em convite, sinalização, banco de dados ou API. Atualizar é trocar a instalação; voltar para a 0.8.4 é reinstalar a partir da branch dela, sem conversão de dados;
- `npm test` passa com 389 testes, contra 354 na 0.8.4. Os 35 novos guardam exatamente o que esta versão corrige.

## 0.8.4 — convite de 35 caracteres e build portátil de Windows

**O convite encolheu 85%**

- ele chegava a **240 caracteres**, e quase metade era a chave de acesso do servidor — longa, e viajando dentro de algo feito para colar em conversa;
- agora o servidor emite: `POST /api/invite` devolve um token de doze caracteres e guarda só o hash, com prazo de doze horas. O código vira **`TUMA2~call.exemplo.com~7K3P9QXM2W4V`** — **35 caracteres**, ou 38 para servidor caseiro em IP e porta;
- **a chave do servidor parou de circular.** O token vale como chave de acesso com escopo daquele convite e some do arquivo quando vence;
- o alfabeto exclui `I`, `L`, `O`, `U`, `0` e `1`, que são o que se erra ditando um código ao telefone. Espaço, hífen e minúsculas são aceitos na leitura;
- emitir exige sessão, porque convidar é ato de quem já entrou. O formato `TUMA1` continua sendo lido, e um servidor anterior à 0.8.4 faz o cliente cair de volta nele.

**Windows: build portátil**

- novo alvo `portable` no electron-builder e `npm run package:windows`. O `electron-builder` cruza de Linux para win32, então o CI publica o `.exe` junto com o AppImage;
- **o áudio da live tem caminho próprio no Windows.** `desktop/audio-router.cjs` monta um barramento no PipeWire, o que só existe no Linux. No Windows o Chromium entrega o loopback do sistema no mesmo `getUserMedia` do vídeo, com `chromeMediaSource: 'desktop'` no ramo de áudio — sem barramento a montar nem a desmontar;
- o roteador de áudio ganhou guarda de plataforma: fora do Linux ele recusa em vez de procurar `pactl`, e parar deixou de chamar `pw-link`. Antes não havia **nenhum** `process.platform` nesse caminho;
- a plataforma passou a ser exposta pelo preload, que é como o renderer escolhe entre os dois caminhos.

> **O que não foi verificado:** o `.exe` foi gerado e é um PE32 válido de 87 MB, mas **não foi executado**. Áudio da live no Windows e chamada entre Windows e Linux exigem uma máquina Windows para provar.

**Sobre o enlace direto, que não voltou**

Medido nesta rede antes de decidir: o roteador tem WAN em `100.64.0.98` — **CGNAT**. O UPnP funciona e mapeia a porta, mas só no roteador de casa; atrás dele continua o NAT da operadora. O código estava certo em recusar esse caminho. O IPv6 tem endereço e rota, mas **100% de perda** — configurado e não roteado, o que é do provedor. O NAT é `endpoint-independent`, então a mídia atravessa; o que não atravessa é a conexão **de entrada** que um convite por endereço exigiria.

## 0.8.3 — mutar o Discord não derruba mais o microfone, e o convite exige um servidor

**O microfone: o que a medição encontrou**

- ao mutar, o Discord **não silencia o stream de captura — ele o destrói**. Medido no PipeWire: o `WEBRTC VoiceEngine` some inteiro da lista de quem captura, e volta ao desmutar;
- o WirePlumber tropeça no mesmo instante: `failed to activate item: Object activation aborted: PipeWire proxy destroyed`, e três `assertion 'self != NULL' failed` logo depois. Quem estiver capturando do **mesmo dispositivo** leva o solavanco, e a faixa daqui pisca `muted` antes de voltar sozinha;
- **a reação do Tumacord era pior que o defeito.** Sair de `muted` dependia só do evento `unmute` — justamente o que se perde no meio da sacudida. O estado ficava preso, e 1,2 s depois vinha a recaptura: a faixa caía e era recriada em **todos** os enlaces, renegociando com todo mundo, até três vezes. Era isso que a pessoa sentia como "mutei o Discord e o microfone quebrou";
- agora o monitor confere `muted` **por leitura** a cada segundo, e não só por evento: faixa que voltou limpa o estado sem recapturar; faixa que continua muda segue para a recuperação como antes. A folga sobe de 1,2 s para 3 s, tempo de o grafo reassentar;
- **e o Tumacord parou de girar o volume alheio.** A captura principal pedia `autoGainControl: true`. No Linux isso não é ganho interno: o Chromium mexe no volume da **fonte** no PipeWire, que é do dispositivo e vale para todos. Com o Discord na mesma entrada, dois AGCs disputavam o mesmo botão — e a fonte desta máquina terminou em **28% (−32,95 dB)** com todos os streams em 100%, valor que o `module-device-restore` guarda entre reinícios. A captura crua já pedia `false`; esta era a última metade do aplicativo ainda na disputa.

**O convite agora exige um servidor**

- o código `TUMA1` tinha duas formas. Com `server`, apontava um servidor de encontro; sem, carregava a lista de endereços desta máquina e quem recebesse corria atrás deles. **A segunda saiu**: ela exigia que alguém do grupo fosse alcançável da internet — IPv4 público, porta aberta no roteador ou IPv6 — e quase nunca era;
- removidos: `paths` do convite e as tabelas que os codificavam, `orderPaths`, `pathToUrl` e a corrida escalonada de caminhos. `buildInvite` não recebe mais o relatório de alcance e passa a exigir servidor e chave;
- **um convite da 0.8.2 que só trazia endereços é recusado na leitura.** Aceitar produziria uma sessão sem destino;
- na rede local nada muda: as calls continuam aparecendo sozinhas, sem convite nenhum.

**O que continua existindo, porque continua servindo**

- `probeDirectHost` e `/api/direct/hello`, que o convite por servidor usa para provar a chave;
- `adoptDirectKey`, que o P2P na rede local ainda usa;
- o relatório de alcance, que alimenta o painel de rede e a eleição de host.

## 0.8.2 — o relay estava fora do ar desde que nasceu, e agora é escolha de cada um

**O caminho de instalação apontava para a versão anterior**

- o README mandava copiar `install-v0.8.1.sh`, da branch da 0.8.1. Pior do que um comando quebrado: ele funcionava, e instalava a versão errada em silêncio;
- **`scripts/update-server.sh` sem argumento tinha como alvo padrão a branch da 0.8.1** — rodá-lo no servidor rebaixaria a instalação e traria o coturn de volta ao laço de reinício descrito abaixo;
- um teste novo amarra README, instalador e atualizador à versão do `package.json`: ele lê a versão, exige que exista `install-v<versão>.sh`, extrai a branch de dentro desse script e cobra que README e atualizador apontem para ela. Verificado que **reprova o estado anterior**, restaurando os arquivos e rodando.

**O relay nunca subiu. Nem uma vez.**

- `tumacord-turn` estava em laço de reinício no servidor de produção — **298 reinícios**, saindo com 255 a cada tentativa. A primeira linha do log dizia: `turnserver: unrecognized option: no-loopback-peers`. O coturn **removeu** essa opção; hoje ele nega loopback por padrão e só aceita a inversa, `--allow-loopback-peers`. Uma opção desconhecida não é ignorada — o turnserver imprime o help e sai;
- o sintoma era invisível do lado de fora. `restart: unless-stopped` reiniciava em silêncio, e o `/api/health` continuava respondendo `"turn":true`: **o servidor distribuía credenciais para um relay que não existia**. Quem caía no caso em que só o relay salva não via erro nenhum — a call simplesmente não fechava;
- junto saíram `--no-cli` e `--no-dtls`, que o coturn 4.17 já trata como depreciadas. São a mesma classe de defeito, só que ainda no estágio anterior: a opção depreciada de hoje é a removida de amanhã. `--no-tls` e `--no-multicast-peers` continuam válidas e continuam lá; a proibição de loopback não se perdeu, porque `127.0.0.0/8` e `::1` já estavam negados explicitamente;
- **três testes passaram a guardar isso**, e os três reprovam o `docker-compose.yml` da 0.8.1: a tag da imagem, a lista de opções proibidas e a interpolação obrigatória.

**Subir o servidor sem relay voltou a funcionar**

- as variáveis de TURN usavam `${VAR:?...}` dentro do serviço `coturn`. O Compose interpola o arquivo **inteiro** antes de olhar para os perfis, então `docker compose up -d` — sem `--profile turn` — falhava para quem nunca quis relay nenhum. Agora quem sobe o perfil sem preencher o `.env` recebe o erro do próprio coturn, que é específico e aparece na hora certa.

**O relay virou uma escolha de cada pessoa, e nasce desligada**

- nova chave **Usar o relay do servidor (TURN)** em **Configurações › Rede e conexão**, **desligada por padrão**. Antes, um servidor com relay configurado fazia todo mundo usá-lo como último recurso, sem ninguém ter pedido;
- a razão de ser opt-in é o que o relay faz: é o único caminho em que a mídia passa por uma máquina de terceiro — cifrada de ponta a ponta, mas passando, e gastando banda dela. Ligar é decisão de quem não fecha caminho direto, e vale só para essa pessoa;
- **desligada, nenhuma credencial é pedida**: credencial que não se busca é credencial que não existe. E desligar esquece a que já estava em mãos, para valer no ato em vez de na próxima renovação;
- a checagem fica em `iceServers()`, o ponto por onde toda `RTCPeerConnection` passa, e não só em quem busca — uma credencial que sobrou não vira candidato depois;
- ligar não muda a ordem de nada: o ICE continua comparando candidatos por prioridade, e um par direto sempre vence um par por relay.

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

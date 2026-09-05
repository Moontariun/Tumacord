# Tumacord 🍅

O Tumacord é um chat pessoal de voz, vídeo e texto para um grupo pequeno. Ele roda no seu próprio computador e envia a mídia diretamente entre os participantes com WebRTC — sem serviço no meio.

A partir da 0.7.9 o **enlace direto** substitui o ZeroTier como caminho padrão: na mesma rede as calls continuam aparecendo sozinhas, e fora dela basta um código de convite. O ZeroTier continua disponível como opção que se liga nas configurações.

## O que já funciona

- cadastro e login explícitos com usuário + senha;
- no modo P2P, um único canal de texto e uma única call, sem botões ou canais redundantes;
- call de baixa latência em malha WebRTC;
- **enlace direto sem ZeroTier**: travessia de NAT por ICE/STUN, entrada por IPv6 e abertura de porta no roteador por PCP, NAT-PMP ou UPnP;
- **servidor de encontro opcional**, alcançado só por conexão de saída: funciona atrás de CGNAT sem abrir porta em lugar nenhum, e com relay TURN para o caso em que nem o ICE atravessa;
- convite em código para entrar de qualquer rede, com chave que protege a porta exposta à internet;
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
- captura de áudio opcional por um barramento temporário do PipeWire: jogos, navegador e outros aplicativos entram na live, enquanto Tumacord, Discord e seus mecanismos de voz ficam de fora para não devolver a call pela transmissão;
- perfis 1080p60, 1440p60, 1440p30, 1080p30, 720p30 e 480p15, com preferência persistente e troca dinâmica durante a live sem recapturar nem selecionar a tela novamente;
- volume individual por participante e pela live, de 0 a 200%, com ganho real de até +18 dB e limitador contra estouro;
- dois modos para a live: **Ampliar dentro do app**, mantendo barras e controles, e **Tela cheia real**;
- ao abrir o chat durante uma live, ela continua tocando em uma miniatura móvel e redimensionável, preservando mute e volume;
- layout responsivo para janela dividida: em meia tela a lista de membros recolhe, os controles compactam e múltiplas lives se empilham sem esmagar o vídeo;
- indicador **AO VIVO** no nome de quem transmite, recuperação visível quando a mídia atrasa e opção de sair apenas da live sem abandonar a call;
- mensagens mescladas entre os participantes online e guardadas localmente, de modo que alguém que entra depois recebe o histórico disponível;
- anexos de até 25 MB com prévia leve, download manual e opção de manter os arquivos completos sincronizados neste PC;
- perfis com avatar estático ou GIF, banner, descrição e cor personalizada, replicados entre os hosts pelo usuário e pela edição mais recente;
- login com escolha entre **P2P automático** e **Servidor dedicado**;
- opção **Continuar conectado**, inclusive após reiniciar o servidor dedicado;
- feedbacks sonoros distintos para entrada, saída, mensagem, mute, início/fim de live e troca de host, com volume configurável;
- microfone que se recupera sozinho quando o sistema silencia a faixa, troca o dispositivo padrão ou abre a captura sem sinal;
- aplicativo Electron instalável no Fedora, CachyOS/Arch, Debian/Ubuntu e openSUSE, e cliente web servido pelo contêiner dedicado;
- ícone no menu de aplicativos e na bandeja do KDE, com atalho para abrir ou sair;
- versão instalada visível no login e nas configurações;
- **papéis de servidor** — dono, administrador e membro —, persistidos e com proteção contra deixar o servidor sem dono;
- **painel de administração** com quatro áreas: visão geral, canais, usuários e registro de auditoria;
- canais com categoria, posição, tópico e limite de pessoas, editáveis pelo painel e aplicados em tempo real;
- **diagnóstico de mídia por camada** — captura, processamento, faixa, envio, enlace e recepção — com botão de copiar sem token nem endereço;
- interface original inspirada na organização familiar de apps de comunidade, sem copiar a marca do Discord.

## Instalação no Linux

O instalador atende **Fedora, CachyOS/Arch, Debian/Ubuntu e openSUSE**: ele reconhece o gerenciador de pacotes e traduz os nomes das dependências de cada distribuição.

### Pelo GitHub

Para instalar ou atualizar compilando o código mais recente:

```bash
curl -fsSL https://raw.githubusercontent.com/Moontariun/Tumacord/release/stability-and-admin-v0.8.1/scripts/install-v0.8.1.sh | bash
```

Este comando instala a v0.8.1 a partir da branch separada `release/stability-and-admin-v0.8.1`. As versões anteriores permanecem isoladas em suas próprias branches e não devem mais ser usadas.

Até a 0.7.8 este comando falhava fora do Arch: o instalador recusava a máquina na primeira linha se não encontrasse `pacman`. Agora ele reconhece `dnf`/`dnf5`, `pacman`, `apt-get` e `zypper`, instala as dependências com o nome certo de cada distribuição (`pipewire-utils` no Fedora, `pipewire-audio` no Arch, `pipewire-bin` no Debian) e, se faltar alguma biblioteca do Electron, percebe pelo `ldd` e resolve antes de instalar.

O script baixa primeiro um bootstrap temporário e então clona/compila exatamente a branch v0.8.1, sem cair na `main` e sem depender de um pipe aninhado. O clone permanece na pasta de Downloads configurada pelo sistema (por exemplo, `~/Downloads/Tumacord-release-stability-and-admin-v0.8.1`). O instalador guarda cada build em uma pasta imutável dentro de `~/.local/share/tumacord/versions` e troca apenas o atalho `current`; por isso, atualizar enquanto o app está aberto não mistura arquivos nem interrompe a call. O atalho executável fica em `~/.local/bin/tumacord`, e o AppImage não participa da instalação nem da atualização. A versão anterior permanece apontada por `~/.local/share/tumacord/previous` para recuperação.

Para instalar outra branch, use o instalador genérico e passe o ref depois de `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/Moontariun/Tumacord/release/stability-and-admin-v0.8.1/scripts/install-from-github.sh | bash -s -- nome-da-branch
```

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

## Enlace direto: a call sem ZeroTier

### Na mesma rede

Nada muda e nada precisa ser configurado. Abra o Tumacord: se ninguém estiver em call, o botão mostra **Abrir minha call** e você vira host. Nos outros computadores, a lateral mostra **Calls na rede** com o host, a quantidade de pessoas e o ping; um clique entra.

### Fora da rede, pela internet

1. Quem já está na call abre **Enlace direto › Convidar pela internet** e copia o código.
2. Quem vai entrar cola o código em **Entrar por convite**, ou no campo de convite da tela de entrada.
3. Pronto. O código carrega os endereços por onde aquele computador aceita entrada e a chave que protege a porta; ele vale por 12 horas.

O Tumacord tenta os caminhos em paralelo, nesta ordem:

| Caminho | Como funciona | Quando entra |
| --- | --- | --- |
| Rede local | descoberta por broadcast/multicast, como sempre | mesma rede |
| IPv6 | endereço IPv6 global do host, sem NAT no meio | ambos com IPv6 — o caso típico de quem está em CGNAT |
| IPv4 mapeado | porta pedida ao roteador por PCP, NAT-PMP ou UPnP | roteador que atende algum desses protocolos |
| Mídia por ICE/STUN | voz, câmera e tela furam o NAT diretamente | sempre que a sinalização estiver de pé |

A parte pesada — voz, câmera e tela — atravessa CGNAT por conta própria com ICE/STUN, que é a mesma travessia que jogos e chamadas usam. Os servidores STUN só informam qual é o seu endereço público: eles não veem nem transportam a conversa, que continua cifrada de ponta a ponta por DTLS-SRTP.

O que precisa de um caminho de entrada é a **sinalização**, que mora no host. Por isso, quando o host sai, assume automaticamente quem tem o melhor alcance, não apenas o menor ping. Se ninguém do grupo tiver IPv6 nem porta aberta, o app diz isso com todas as letras em **Configurações › Rede e conexão** — e aí o ZeroTier resolve.

### Segurança da porta exposta

Sem ZeroTier, a porta de sinalização passa a aceitar conexão vinda da internet. Quem chega de um endereço da própria rede continua entrando sem nada, como a descoberta por broadcast sempre fez; de fora, sem a chave do convite, a API inteira responde `403`. O host ainda devolve um HMAC do nonce apresentado, de modo que quem convida prova ser quem diz ser, e um endereço que trocou de dono não recebe usuário e senha de ninguém.

A chave é da call, não da máquina: quem entra por um convite passa a aceitá-lo também. É isso que mantém o código válido quando o host muda no meio da conversa.

### ZeroTier, agora opcional

Em **Configurações › Rede e conexão** existe a chave **Usar a rede ZeroTier**. Desligada — o padrão —, o adaptador do ZeroTier fica fora da descoberta e da call. Ligada, tudo funciona como nas versões anteriores: instale o ZeroTier em todos os computadores, entre na mesma rede, autorize os membros no painel e use o Tumacord normalmente.

Vale ligar quando o grupo já usa uma rede ZeroTier ou quando ninguém consegue ser alcançado pelo enlace direto — o caso de todos estarem em CGNAT sem IPv6.

Na mesma tela ficam a travessia por STUN e a abertura de porta no roteador, que também podem ser desligadas, além do diagnóstico deste computador: IPv6 disponível, CGNAT, se o NAT é atravessável e qual porta foi aberta.

### Firewall

Libere TCP `3927` (sinalização) e UDP `3928` (descoberta). Para receber convites pela internet **no modo P2P puro**, o TCP `3927` precisa chegar até este computador — é justamente isso que a abertura automática de porta tenta resolver. Em uma configuração doméstica padrão costuma funcionar sem regras extras.

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

O convite gerado nesse modo não carrega endereço de máquina nenhuma — só a call e o segredo que dá direito de entrar.

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

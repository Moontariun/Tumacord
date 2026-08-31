# Tumacord 🍅

O Tumacord é um chat pessoal de voz, vídeo e texto para uma turma pequena. Ele roda no seu próprio computador, usa o ZeroTier para colocar os amigos na mesma rede e envia a mídia diretamente entre os participantes com WebRTC.

## O que já funciona

- cadastro e login explícitos com usuário + senha;
- um único espaço da turma, com canais de texto e voz, mensagens persistidas e presença online;
- call de baixa latência em malha WebRTC;
- descoberta automática de calls na rede local/ZeroTier, sem copiar IP;
- servidor completo embutido em toda instalação;
- o primeiro a entrar vira host; se ele sair, o participante com menor ping médio assume e a sinalização migra automaticamente;
- câmera e live permanecem ativas ao reconectar ou quando outra pessoa sai e volta para a call;
- reconexão WebRTC automática com fila de candidatos ICE, renegociação pendente e reconstrução do enlace quando a rota ZeroTier/Wi-Fi muda;
- diagnóstico da malha P2P na call, com estado por enlace, ping médio e botão para reconstruir todas as rotas sem sair da call nem encerrar a live;
- microfone a 48 kHz com cancelamento de eco, supressão neural GTCRN em WebAssembly, corte de ruído grave, compressor de voz e ganho automático;
- detecção e seleção de microfone, saída de áudio e câmera;
- câmera e compartilhamento de tela;
- ao clicar em **Transmitir tela**, o Tumacord primeiro pede qualidade e áudio; só depois abre o seletor de tela/janela;
- captura de áudio opcional por um barramento temporário do PipeWire: jogos, navegador e outros aplicativos entram na live, enquanto Tumacord, Discord e seus mecanismos de voz ficam de fora para não devolver a call pela transmissão;
- perfis Fonte (1080p60), 2.5K (1440p60 e 1440p30), Alta (1080p30), Equilibrada (720p30) e Econômica (480p15), com ajuste adaptativo para manter a transmissão estável;
- volume individual por participante e pela live, de 0 a 200%, com ganho real de até +10 dB e limitador contra estouro;
- dois modos para a live: **Ampliar dentro do app**, mantendo barras e controles, e **Tela cheia real**;
- layout responsivo para janela dividida: em meia tela a lista de membros recolhe, os controles compactam e múltiplas lives se empilham sem esmagar o vídeo;
- indicador **AO VIVO** no nome de quem transmite, recuperação visível quando a mídia atrasa e opção de sair apenas da live sem abandonar a call;
- mensagens mescladas entre os participantes online e guardadas localmente, de modo que alguém que entra depois recebe o histórico disponível;
- anexos de até 25 MB com prévia leve, download manual e opção de manter os arquivos completos sincronizados neste PC;
- perfis com avatar estático ou GIF, banner, descrição e cor personalizada;
- login com escolha entre **P2P automático** e **Servidor dedicado**;
- opção **Continuar conectado**, inclusive após reiniciar o servidor dedicado;
- feedbacks sonoros distintos para entrada, saída, mensagem, mute, início/fim de live e troca de host, com volume configurável;
- aplicativo Electron instalável no CachyOS/Arch e cliente web opcional;
- ícone no menu de aplicativos e na bandeja do KDE, com atalho para abrir ou sair;
- interface original inspirada na organização familiar de apps de comunidade, sem copiar a marca do Discord.

## Instalação no CachyOS

### Pelo GitHub

Para instalar ou atualizar compilando o código mais recente:

```bash
curl -fsSL https://raw.githubusercontent.com/Moontariun/Tumacord/feat/professional-ui-server-v0.2.0/scripts/install-professional-ui.sh | bash
```

Este comando é específico da branch `feat/professional-ui-server-v0.2.0`: ele baixa primeiro um script temporário e então clona/compila exatamente essa branch, sem cair na `main` e sem depender de um pipe aninhado. O clone permanece na pasta de Downloads configurada pelo sistema (por exemplo, `~/Downloads/Tumacord-feat-professional-ui-server-v0.2.0`). O instalador coloca a instalação em `~/.local/share/tumacord/app`, com atalho em `~/.local/bin/tumacord`; o AppImage não participa da instalação nem da atualização. Uma instalação anterior fica em `~/.local/share/tumacord/app.previous` para recuperação.

Para instalar outra branch, use o instalador genérico e passe o ref depois de `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/Moontariun/Tumacord/feat/professional-ui-server-v0.2.0/scripts/install-from-github.sh | bash -s -- nome-da-branch
```

O AppImage continua disponível como alternativa portátil nas **Releases** e nos artefatos de cada build do GitHub Actions. Ele serve para quem preferir baixar e executar um arquivo isolado, mas é opcional.

### A partir do código

No terminal, dentro desta pasta:

```bash
chmod +x scripts/*.sh
./scripts/install-cachyos.sh
```

É o mesmo comando para todos. O instalador gera o diretório nativo do Electron, instala em `~/.local/share/tumacord/app` e cria o atalho do menu. Cada cópia já contém o servidor, o detector de calls e o mecanismo de eleição de host.

Para remover o aplicativo e escolher interativamente se os dados locais serão apagados, execute:

```bash
./scripts/uninstall-cachyos.sh
```

Também é possível decidir diretamente:

```bash
./scripts/uninstall-cachyos.sh --keep-data
./scripts/uninstall-cachyos.sh --purge-data
```

`--purge-data` remove também contas locais, histórico, anexos, perfis, sessão e preferências em `~/.config/tumacord` e `~/.cache/tumacord`. O clone na pasta de Downloads é preservado para não apagar código sem confirmação separada.

## Configuração do ZeroTier

1. Instale o ZeroTier em todos os computadores, entre na mesma rede e autorize os membros no painel da rede.
2. Abra o Tumacord. Se ninguém estiver em call, o botão mostra **Abrir minha call** e você vira host.
3. Nos outros computadores, entre normalmente. Dentro do servidor, a lateral mostra **Calls na rede** com o host, quantidade de pessoas e ping; basta clicar na call para entrar.
4. Se o host sair ou fechar o app, o participante disponível com menor ping médio assume. Todos veem a coroa mudar e a sinalização reconecta ao servidor embutido do novo host.

O cliente desktop deixa os IPs das interfaces visíveis ao ICE do WebRTC. Isso é importante para o adaptador ZeroTier; a mídia continua criptografada pelo DTLS-SRTP do WebRTC e não passa pelo servidor.

Se houver firewall, libere TCP `3927` (sinalização), UDP `3928` (descoberta) e tráfego UDP entre os membros na interface ZeroTier. A rede ZeroTier precisa permitir broadcast/multicast. Em uma configuração doméstica padrão isso costuma funcionar sem regras extras.

## Servidor dedicado com Docker

Na tela de login, selecione **Servidor dedicado** e informe o endereço, por exemplo `http://10.0.0.20:4600`. Para subir o servidor:

```bash
docker compose up -d --build
```

O arquivo `docker-compose.yml` publica a porta TCP `4600`, executa o processo como usuário sem privilégios, verifica a saúde do serviço, limita os logs e mantém contas, sessões, perfis, mensagens e anexos no volume `tumacord-data`. Para acompanhar:

```bash
docker compose logs -f tumacord-server
```

Para verificar a saúde sem abrir o app:

```bash
curl http://127.0.0.1:4600/api/health
```

Nesse modo não há troca dinâmica do endereço do host: o contêiner mantém a sinalização e os dados, enquanto voz, câmera e tela continuam trafegando diretamente entre os participantes por WebRTC.

## Áudio da transmissão no CachyOS

O compartilhamento de tela usa PipeWire. O instalador garante os utilitários `pactl`, `pw-link` e `pw-dump`; confirme apenas que estes serviços estão ativos:

```bash
systemctl --user status pipewire pipewire-pulse wireplumber
```

No KDE/Wayland, mantenha também `xdg-desktop-portal` e `xdg-desktop-portal-kde` instalados. Ao clicar em **Transmitir tela**, escolha a qualidade e marque **Transmitir áudio da fonte** quando quiser som; desmarque para transmitir apenas o vídeo. Isso também funciona ao selecionar a tela inteira.

Quando o áudio é marcado, o Tumacord cria sozinho um barramento temporário, duplica para ele os aplicativos comuns e captura seu monitor. As saídas do próprio Tumacord, do Discord e do mecanismo de voz WebRTC são excluídas antes da captura. Assim, a pessoa que vê sua live recebe jogo, navegador e demais sons do sistema, mas não escuta a própria voz voltando pela transmissão. Ao encerrar a live, o barramento e todas as ligações são removidos automaticamente; não há ajuste manual no painel de áudio.

Na captura pela janela do navegador, fora do aplicativo Electron, o comportamento depende do que o seletor do navegador e o portal do sistema disponibilizarem. O isolamento automático descrito acima é parte do aplicativo desktop para CachyOS.

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

O servidor embutido P2P fica em `http://0.0.0.0:3927`; a imagem Docker usa `4600`. O modo de desenvolvimento da interface usa `http://localhost:5173`.

## Limites intencionais

O Tumacord usa malha P2P, ótima para uma turma pequena (aproximadamente 2–8 pessoas, dependendo do upload do host de cada stream). Uma sala grande precisaria de um SFU como mediasoup ou LiveKit. Não há recuperação de senha, moderação avançada ou criptografia ponta a ponta adicional — escolhas conscientes para manter este projeto pessoal simples.

Os hashes de senha usam `scrypt`. O histórico é replicado por mesclagem entre os computadores online, não é um banco global com consenso: mensagens disponíveis nos pares são preservadas, mas apagar ou editar mensagens distribuídas ainda não faz parte desta versão. Arquivos só permanecem garantidos enquanto o host atual ou algum participante que os sincronizou estiver disponível.

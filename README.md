# Tumacord 🍅

O Tumacord é um chat pessoal de voz, vídeo e texto para uma turma pequena. Ele roda no seu próprio computador, usa o ZeroTier para colocar os amigos na mesma rede e envia a mídia diretamente entre os participantes com WebRTC.

## O que já funciona

- cadastro e login explícitos com usuário + senha;
- no modo P2P, um único canal de texto e uma única call, sem botões ou canais redundantes;
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
- aplicativo Electron instalável no CachyOS/Arch e cliente web servido pelo contêiner dedicado;
- ícone no menu de aplicativos e na bandeja do KDE, com atalho para abrir ou sair;
- versão instalada visível no login e nas configurações;
- painel administrativo no modo servidor para o usuário configurado (por padrão, `Moontariun`);
- interface original inspirada na organização familiar de apps de comunidade, sem copiar a marca do Discord.

## Instalação no CachyOS

### Pelo GitHub

Para instalar ou atualizar compilando o código mais recente:

```bash
curl -fsSL https://raw.githubusercontent.com/Moontariun/Tumacord/release/p2p-media-profile-stability-v0.4.0/scripts/install-v0.5.0.sh | bash
```

Este comando instala a v0.5.0 corrigida a partir da mesma branch de manutenção `release/p2p-media-profile-stability-v0.4.0`. A v0.4.0 anterior está marcada como afetada por falhas de transmissão e não deve mais ser usada. O script baixa primeiro um bootstrap temporário e então clona/compila exatamente essa branch, sem cair na `main` e sem depender de um pipe aninhado. O clone permanece na pasta de Downloads configurada pelo sistema (por exemplo, `~/Downloads/Tumacord-release-p2p-media-profile-stability-v0.4.0`). O instalador guarda cada build em uma pasta imutável dentro de `~/.local/share/tumacord/versions` e troca apenas o atalho `current`; por isso, atualizar enquanto o app está aberto não mistura arquivos nem interrompe a call. O atalho executável fica em `~/.local/bin/tumacord`, e o AppImage não participa da instalação nem da atualização. A versão anterior permanece apontada por `~/.local/share/tumacord/previous` para recuperação.

Para instalar outra branch, use o instalador genérico e passe o ref depois de `bash -s --`:

```bash
curl -fsSL https://raw.githubusercontent.com/Moontariun/Tumacord/release/p2p-media-profile-stability-v0.4.0/scripts/install-from-github.sh | bash -s -- nome-da-branch
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

O contêiner dedicado mantém as contas e mensagens, faz a sinalização WebRTC e também hospeda a interface web. O servidor embutido do modo P2P não publica a versão web. Antes da primeira inicialização, crie a chave da turma:

```bash
cp .env.example .env
# edite TUMACORD_SERVER_ACCESS_KEY no arquivo .env
docker compose up -d --build
```

Abra `http://IP-DO-SERVIDOR:4600` no navegador ou selecione **Servidor dedicado** no app e informe esse endereço e a chave. A primeira entrada com uma combinação local de usuário e senha cria a conta correspondente no servidor; as entradas seguintes autenticam essa conta. O usuário definido por `TUMACORD_ADMIN_USERNAME` — `Moontariun` por padrão — recebe o painel de administração apenas nesse modo.

O arquivo `docker-compose.yml` publica a porta TCP `4600`, executa o processo como usuário sem privilégios, verifica a saúde do serviço, limita os logs e mantém contas, sessões, perfis, mensagens e anexos no volume `tumacord-data`. Senhas usam `scrypt`, tokens são armazenados somente como hashes SHA-256, a chave da turma é comparada em tempo constante e voz, câmera e tela usam DTLS-SRTP do WebRTC. Para acompanhar:

```bash
docker compose logs -f tumacord-server
```

Para verificar a saúde sem abrir o app:

```bash
curl http://127.0.0.1:4600/api/health
```

Nesse modo não há troca dinâmica do endereço do host: o contêiner mantém a sinalização e os dados, enquanto voz, câmera e tela continuam trafegando diretamente entre os participantes por WebRTC.

Em uma rede ZeroTier privada, o túnel da rede já protege o tráfego até o servidor. Se a porta `4600` for exposta fora dessa rede, configure também `TUMACORD_TLS_CERT_FILE` e `TUMACORD_TLS_KEY_FILE` com caminhos de certificado e chave dentro da pasta `certs`; assim, login, chat e sinalização usam HTTPS/WSS. A chave da turma não substitui HTTPS em uma rede pública.

## Áudio da transmissão no CachyOS

O compartilhamento de tela usa PipeWire. O instalador garante os utilitários `pactl`, `pw-link` e `pw-dump`; confirme apenas que estes serviços estão ativos:

```bash
systemctl --user status pipewire pipewire-pulse wireplumber
```

No KDE/Wayland, mantenha também `xdg-desktop-portal` e `xdg-desktop-portal-kde` instalados. Ao clicar em **Transmitir tela**, escolha a qualidade e marque **Transmitir áudio da fonte** quando quiser som; desmarque para transmitir apenas o vídeo. Isso também funciona ao selecionar a tela inteira.

Quando o áudio é marcado, o Tumacord cria sozinho um barramento temporário, duplica para ele os aplicativos comuns e captura seu monitor. As saídas do próprio Tumacord, do Discord e do mecanismo de voz WebRTC são excluídas antes da captura. Assim, a pessoa que vê sua live recebe jogo, navegador e demais sons do sistema, mas não escuta a própria voz voltando pela transmissão. Ao encerrar a live, o barramento e todas as ligações são removidos automaticamente; não há ajuste manual no painel de áudio.

Na captura pela janela do navegador, fora do aplicativo Electron, o comportamento depende do que o seletor do navegador e o portal do sistema disponibilizarem. O isolamento automático descrito acima é parte do aplicativo desktop para CachyOS.

Se o processo gráfico do Electron cair repetidamente, o Tumacord registra somente o tipo da falha e reinicia uma sessão em modo gráfico seguro. Esse fallback vale para NVIDIA, AMD e Intel e não fica preso: na abertura seguinte a aceleração volta a ser testada. Para isolar manualmente um problema de driver, também é possível iniciar uma sessão com `TUMACORD_DISABLE_GPU=1 tumacord`; os eventos técnicos ficam em `logs/runtime-health.log` dentro do diretório de dados do aplicativo. Esse modo é diagnóstico/reserva, pois codificação por CPU pode reduzir a qualidade em salas maiores.

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

O servidor embutido P2P fica em `http://0.0.0.0:3927`, mas não serve páginas web. A imagem Docker usa `4600` e entrega API, sinalização e interface web. O modo de desenvolvimento da interface usa `http://localhost:5173`.

## Limites intencionais

O Tumacord usa malha WebRTC, ótima para uma turma pequena (aproximadamente 2–8 pessoas, dependendo do upload de quem transmite). Uma sala grande precisaria de um SFU como mediasoup ou LiveKit. Não há recuperação de senha nem moderação avançada; a mídia é cifrada pelo próprio WebRTC, mas o chat armazenado no servidor não possui criptografia ponta a ponta adicional.

Os hashes de senha usam `scrypt`. O histórico é replicado por mesclagem entre os computadores online, não é um banco global com consenso: mensagens disponíveis nos pares são preservadas, mas apagar ou editar mensagens distribuídas ainda não faz parte desta versão. Arquivos só permanecem garantidos enquanto o host atual ou algum participante que os sincronizou estiver disponível.

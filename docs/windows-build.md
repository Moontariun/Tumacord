# Build, assinatura e release no Windows

Documento de manutenção. Quem só quer instalar o Tumacord deve ler a seção
**Instalação no Windows** do `README.md`.

## O que existe

A partir da 0.8.8 a distribuição do Windows tem três peças:

| Peça | Onde vive | O que é |
| --- | --- | --- |
| `tumacord-audio-helper.exe` | `native/windows/audio-helper/` | processo auxiliar em C++ que captura áudio por aplicação com WASAPI |
| `Tumacord-<versão>-Setup.exe` | `release/` | instalador NSIS assistido, por máquina |
| `Tumacord-<versão>-portable.exe` | `release/` | executável único, sem instalação |

## Compilar em uma máquina Windows

Requisitos:

- Windows 10 20H1 (build 19041) ou mais novo — 64 bits;
- Node.js 22 ou mais novo;
- **Build Tools do Visual Studio 2022** com o workload *Desktop development with
  C++* e um Windows SDK. Só isso: o helper não usa CMake, nem vcpkg, nem
  nenhuma biblioteca externa.

```powershell
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Microsoft.VisualStudio.2022.BuildTools -e --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621"
```

Depois, dentro do repositório:

```powershell
npm ci
npm run typecheck
npm test
npm run package:windows
```

`package:windows` faz, nesta ordem: interface (`vite build`), servidor
(`esbuild`), componente nativo (`cl.exe`) e por fim o electron-builder com os
alvos `nsis` e `portable`. Os artefatos saem em `release/`.

Para desenvolvimento, sem empacotar:

```powershell
npm run build:native:win
npm run dev
npm run desktop:dev
```

`desktop:dev` sobe o Electron apontando para o Vite. O helper é procurado em
`native/windows/audio-helper/build/`, então basta ter rodado
`npm run build:native:win` uma vez.

Passos avulsos, quando só uma peça mudou:

```powershell
npm run build:native:win     # só o componente nativo
npm run build:icon:win       # regera assets/tumacord.ico a partir de assets/icons
npx electron-builder --win nsis --publish never
npx electron-builder --win portable --publish never
```

O script do helper aceita uma build de depuração, com símbolos e sem
otimização:

```powershell
powershell -ExecutionPolicy Bypass -File native/windows/audio-helper/build.ps1 -Configuration Debug
```

O helper compila com `/MT`: a CRT entra estaticamente no binário e a máquina de
quem instalou **não** precisa de nenhum redistribuível do Visual C++.

### Conferir o componente sozinho

```powershell
release\win-unpacked\resources\audio-helper\tumacord-audio-helper.exe --probe
```

A saída é um quadro binário: oito bytes de cabeçalho (`TA`, tipo, tamanho) e
um JSON como `{"event":"probe","protocol":1,"processLoopback":true,"build":26100}`.
`processLoopback: false` significa que aquele Windows não oferece captura por
processo — e é exatamente nesse caso que o aplicativo transmite sem áudio em
vez de cair no loopback do dispositivo inteiro.

## Arquitetura do áudio do Windows

```
   janela ou monitor escolhido no seletor do Tumacord
                        │
      (processo principal valida o id contra a lista que ele mesmo ofereceu)
                        │
   desktop/windows-audio-router.cjs  ── decide ──  desktop/windows-audio-policy.cjs
                        │                            (bloqueio, árvore, dedupe)
                        │  comandos de uma linha por stdin
                        ▼
       tumacord-audio-helper.exe   (uma captura WASAPI por árvore de processo)
                        │  quadros binários por stdout
                        ▼
   processo principal  ──  MessageChannelMain  ──▶  renderer
                                                       │
                                        src/lib/screenAudioBridge.ts
                                                       │
                                   AudioWorklet (anel, deriva, limitador)
                                                       │
                                     MediaStreamAudioDestinationNode
                                                       │
                                          uma MediaStreamTrack normal
                                                       │
                                                  sender WebRTC
```

Pontos que não são óbvios e que existem por um motivo:

- **quem decide não é o helper.** A política de bloqueio mora em JavaScript
  (`desktop/windows-audio-policy.cjs`) porque é a parte que mais precisa de
  teste, e teste de política não pode depender de ter um Discord aberto. O
  helper só executa a lista que recebe. A única decisão dele é uma recusa: ele
  nunca captura a própria árvore de quem o iniciou, aconteça o que acontecer
  com a lista;
- **a unidade de captura é a árvore, não o processo.** Jogos e navegadores
  tocam som por processos auxiliares. Capturar a árvore resolve isso — e obriga
  a deduplicar, porque capturar pai e filho entregaria o mesmo som duas vezes;
- **a mistura sai em float sem limitador.** Float aguenta a soma de dezenas de
  aplicações; quem precisa caber em ±1 é a faixa que vai para o Opus. O corte
  acontece uma única vez, no `AudioWorklet`, onde pode ser testado sem áudio de
  verdade (`tests/screenAudioWorklet.test.ts`);
- **o contexto de áudio nunca se conecta a `destination`.** Reproduzir
  localmente o áudio da própria live criaria um caminho de retorno pelo
  cancelamento de eco do microfone;
- **o protocolo é binário nos dois sentidos que importam.** Cem mensagens por
  segundo durante a live inteira não passam por `ipcRenderer.invoke`: elas vão
  por um `MessageChannelMain` dedicado.

O protocolo entre o processo principal e o helper está descrito em
`native/windows/audio-helper/protocol.h`. Comandos são texto de uma linha
(`SCAN`, `WINDOW <hwnd>`, `CAPTURE <pid,pid>`, `STOP`, `QUIT`); as respostas
são quadros com cabeçalho de oito bytes, tipo 1 para PCM (float32 estéreo
48 kHz) e tipo 2 para eventos JSON. O helper não tem analisador de JSON de
propósito — ele nunca precisa interpretar entrada estruturada.

## Code signing

Nada de certificado, senha, chave ou token entra no repositório. O workflow
`.github/workflows/windows.yml` aceita dois caminhos e usa o primeiro que
estiver configurado.

### Caminho 1 — certificado Authenticode tradicional (OV/EV, arquivo `.pfx`)

| Segredo | Conteúdo |
| --- | --- |
| `WINDOWS_CERTIFICATE` | o `.pfx` inteiro, em base64 |
| `WINDOWS_CERTIFICATE_PASSWORD` | a senha do `.pfx` |

Para gerar o base64 a partir do arquivo:

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("caminho\do\certificado.pfx")) | Set-Clipboard
```

O electron-builder lê esses valores como `CSC_LINK` e `CSC_KEY_PASSWORD` e
assina o executável principal e o instalador. O componente nativo é assinado
antes, com o `signtool` do Windows SDK, porque recursos extras não passam pelo
assinador do empacotador — e trocar um binário dentro de um instalador já
assinado quebraria a assinatura dele.

### Caminho 2 — Azure Trusted Signing

| Segredo | Conteúdo |
| --- | --- |
| `AZURE_TENANT_ID` | id do tenant |
| `AZURE_CLIENT_ID` | id do app registration |
| `AZURE_CLIENT_SECRET` | segredo do app registration |

| Variável (`vars`, não é segredo) | Conteúdo |
| --- | --- |
| `AZURE_SIGNING_ENDPOINT` | por exemplo `https://eus.codesigning.azure.net` |
| `AZURE_SIGNING_ACCOUNT` | nome da conta de assinatura |
| `AZURE_SIGNING_PROFILE` | nome do perfil de certificado |

O app registration precisa do papel **Trusted Signing Certificate Profile
Signer** na conta de assinatura.

### Exigir assinatura numa release

Defina a variável de repositório `TUMACORD_REQUIRE_SIGNING` como `1`. A partir
daí, uma build de tag (`v*`) que produza qualquer artefato sem assinatura
**falha** com a mensagem dizendo o que falta. Sem essa variável, uma tag sem
segredos ainda gera os artefatos e registra um aviso — que é o comportamento
adequado enquanto ainda não existe certificado.

Builds de branch e de pull request nunca exigem assinatura.

### Conferir a assinatura de um arquivo já baixado

```powershell
Get-AuthenticodeSignature .\Tumacord-0.8.8-Setup.exe | Format-List Status, StatusMessage, SignerCertificate
```

`Status` precisa ser `Valid`. O workflow roda essa mesma verificação no
instalador, no portable, no `Tumacord.exe` e no helper.

### SmartScreen, com honestidade

Assinatura Authenticode **não** garante que o SmartScreen deixe de avisar. A
reputação é construída por download e por instalação ao longo do tempo, por
identidade de publisher. Um certificado EV começa com reputação melhor do que
um OV, e a Microsoft Store passa ao largo do aviso — mas nenhum EXE novo, de um
publisher novo, escapa do aviso só por estar assinado. Manter **a mesma
identidade de publisher** entre versões é o que faz a reputação acumular; trocar
de certificado a cada release zera esse acúmulo.

O que não se faz aqui, em nenhuma hipótese: desligar SmartScreen, Defender,
Smart App Control ou UAC, nem sugerir que alguém faça isso.

## Gerar uma release

1. Atualize `package.json` (`version`), `CHANGELOG.md`, `README.md` e crie
   `scripts/install-v<versão>.sh` apontando para a branch nova. O teste
   `README, instalador e atualizador seguem a versão do package.json`
   reprova se qualquer um deles ficar para trás;
2. `npm test && npm run typecheck`;
3. commit e push da branch de release;
4. crie e envie a tag:

```bash
git tag -a v0.8.8 -m "Tumacord 0.8.8"
git push origin v0.8.8
```

O job `appimage` (Linux) cria a Release lendo as notas do `CHANGELOG.md` e
anexa AppImage e tar.gz. O job `windows` anexa `Setup.exe`, `portable.exe` e
`SHA256SUMS-windows.txt` na mesma tag.

## Microsoft Store

O projeto está preparado para uma publicação futura na Store sem mudar nada da
arquitetura: o electron-builder gera `appx`/`msix` a partir do mesmo
`win-unpacked`, e o helper de áudio funciona igual porque não instala driver
nem serviço.

O que impede a publicação hoje é externo ao código: uma conta de desenvolvedor
Microsoft e a identidade de publisher emitida por ela. **A distribuição pelo
GitHub continua obrigatória** — a Store é conveniência, não dependência, e o
aplicativo nunca deve exigir a Store para funcionar.

## Firewall

O instalador cria duas regras, presas ao executável do Tumacord e limitadas aos
perfis Privado e de Domínio:

- `Tumacord - sinalizacao (TCP 3927)`;
- `Tumacord - descoberta na rede local (UDP 3928)`, restrita a `LocalSubnet`.

Elas são removidas na desinstalação, e não na atualização. O perfil Público
nunca é liberado: conexão vinda da internet por encaminhamento de porta chega
pela interface da rede local, que o Windows classifica como Privada ou de
Domínio, então o enlace direto continua funcionando sem expor a máquina numa
rede aberta.

Para inspecionar ou remover à mão:

```powershell
netsh advfirewall firewall show rule name="Tumacord - sinalizacao (TCP 3927)"
netsh advfirewall firewall delete rule name="Tumacord - sinalizacao (TCP 3927)"
```

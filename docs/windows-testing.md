# Matriz de aceitação do Windows

O que a automação **não** consegue provar: que duas pessoas se ouvem, que a voz
de uma não volta pela transmissão da outra, e que o traço aparece no lugar
certo. Isso pede duas máquinas e alguém olhando.

Esta matriz existe para que essa verificação seja sempre a mesma. Marque cada
linha; uma linha que falha vira defeito, não observação.

**A ordem das prioridades, quando algo entrar em conflito:**

1. sem eco nem retorno de voz;
2. estabilidade da call;
3. compatibilidade Windows ↔ Linux;
4. tela + áudio corretos;
5. qualidade e latência.

Nunca troque um item de cima por um de baixo. Em particular: se a única forma
de sair com áudio for capturar o dispositivo inteiro, **saia sem áudio**.

## O que o `npm test` já cobre

Não repita à mão o que a automação já garante:

| Coberto por | O quê |
| --- | --- |
| `tests/windowsAudioPolicy.test.ts` | Discord, DiscordCanary, DiscordPTB e Tumacord fora da lista; processo auxiliar bloqueado pelo ancestral; pai e filho viram uma captura só; sessão encerrada e sons do sistema fora; processo que reinicia; teto de capturas; identificador de janela; serialização dos comandos; decodificador de quadros partidos |
| `tests/windowsAudioRouter.test.ts` | ciclo de vida (preparar, preparar de novo, parar duas vezes); janela que sumiu; janela de aplicativo bloqueado; sistema sem isolamento recusando em vez de cair no loopback; Discord que abre no meio da live; aplicativo novo que entra; componente que morre e é reconstruído; diagnóstico sem nome de aplicativo |
| `tests/screenAudioWorklet.test.ts` | soma de várias aplicações sem estourar ±1; anel com teto; deriva de relógio devolvida; falta de dados; taxa de contexto diferente |
| `tests/screenAudioPlatform.test.ts` | Linux continua no PipeWire e não recebe nada do Windows |
| `tests/windowsPackaging.test.ts` | alvos NSIS e portable; ícone multirresolução; componente nativo empacotado; dados preservados na atualização; regras de firewall criadas e removidas, sem perfil público |

## Preparação

- **Windows A** — Windows 11 x64, Tumacord instalado pelo `Setup.exe`;
- **Windows B** — segunda máquina Windows, para o Caso 1;
- **Linux C** — instalação pelo `install-v0.8.8.sh`, com PipeWire;
- fone de ouvido em uma das máquinas e **caixas de som** em outra: o eco
  acústico só aparece com caixas;
- Discord instalado no Windows A, com uma segunda conta para o Caso 4.

Antes de cada caso, feche a live anterior e confirme no Gerenciador de Tarefas
que **nenhum `tumacord-audio-helper.exe` sobrou**.

---

## Caso 1 — Windows A ↔ Windows B

| # | Passo | Esperado | OK |
| --- | --- | --- | --- |
| 1.1 | os dois entram na mesma call | ambos aparecem na lista, voz nos dois sentidos | ☐ |
| 1.2 | A fala com caixas de som ligadas | B não ouve a própria voz de volta | ☐ |
| 1.3 | ligar câmera nos dois | vídeo nos dois sentidos, sem congelar | ☐ |
| 1.4 | A transmite uma janela **sem** áudio | B vê o vídeo; a live não tem faixa de áudio nenhuma | ☐ |
| 1.5 | A transmite uma janela **com** áudio (um jogo ou o navegador tocando algo) | B ouve aquela aplicação; vídeo e áudio sincronizados | ☐ |
| 1.6 | ainda em 1.5, B fala | A ouve B; **B não ouve a própria voz pela live** | ☐ |
| 1.7 | ainda em 1.5, tocar som em outro programa | B **não** ouve o outro programa | ☐ |
| 1.8 | A transmite o **monitor inteiro** com áudio | B ouve os programas do sistema | ☐ |
| 1.9 | ainda em 1.8, B fala | **B não ouve a própria voz de volta** | ☐ |
| 1.10 | trocar a qualidade durante a live (1080p60 → 720p30 → 1440p60) | a imagem muda; o áudio **não** corta e não duplica | ☐ |
| 1.11 | encerrar a live | o helper some da lista de processos em até 3 s | ☐ |

## Caso 2 — Windows A ↔ Linux C

| # | Passo | Esperado | OK |
| --- | --- | --- | --- |
| 2.1 | os dois na mesma call | voz nos dois sentidos, sem eco | ☐ |
| 2.2 | câmera nos dois | vídeo nos dois sentidos | ☐ |
| 2.3 | Windows transmite tela para o Linux | Linux vê e ouve | ☐ |
| 2.4 | Linux transmite tela para o Windows | Windows vê e ouve | ☐ |
| 2.5 | as duas lives ao mesmo tempo | ambos veem as duas; nenhuma voz retorna | ☐ |
| 2.6 | Linux desenha sobre a live do Windows | o traço aparece nas duas telas, no mesmo ponto do conteúdo | ☐ |
| 2.7 | Windows desenha sobre a live do Linux | idem | ☐ |
| 2.8 | Windows transmitindo o monitor inteiro, Linux desenha | o traço aparece **sobre o desktop real** do Windows | ☐ |
| 2.9 | Windows transmitindo uma janela, Linux desenha | o traço aparece dentro do aplicativo, sem sobreposição no desktop (é o comportamento correto: não se sabe onde a janela está) | ☐ |
| 2.10 | derrubar o Wi-Fi de um lado por 10 s e devolver | a call se reconstrói sozinha; a live volta sem recomeçar | ☐ |
| 2.11 | repetir 2.3 e 2.4 forçando relay (TURN ligado dos dois lados) | funciona igual, com mais latência | ☐ |

## Caso 3 — o Linux não pode regredir

| # | Passo | Esperado | OK |
| --- | --- | --- | --- |
| 3.1 | Linux transmite com áudio para o Windows | o áudio chega; Tumacord e Discord continuam fora | ☐ |
| 3.2 | no Linux, `pactl list short modules` durante a live | existem `module-null-sink` e `module-remap-source` do Tumacord | ☐ |
| 3.3 | encerrar a live no Linux | os dois módulos somem | ☐ |
| 3.4 | no Linux, conferir o microfone padrão do sistema | continua o dispositivo real, **não** a fonte da live | ☐ |
| 3.5 | abrir um jogo no meio da live do Linux | o som dele entra na live | ☐ |

## Caso 4 — Discord e Tumacord ao mesmo tempo (o teste que mais importa)

No **Windows A**:

| # | Passo | Esperado | OK |
| --- | --- | --- | --- |
| 4.1 | entrar numa call do Discord com outra pessoa | voz normal no Discord | ☐ |
| 4.2 | entrar numa call do Tumacord com B ou C | voz normal no Tumacord | ☐ |
| 4.3 | transmitir um **jogo com áudio** no Tumacord | quem assiste ouve o jogo | ☐ |
| 4.4 | a pessoa do Discord fala | quem assiste a live **não** ouve nada dela | ☐ |
| 4.5 | a pessoa da call do Tumacord fala | quem assiste **não** ouve a própria voz retornando | ☐ |
| 4.6 | conferir o Discord | continua tocando normalmente, no volume de sempre | ☐ |
| 4.7 | conferir o Mixer de Volume do Windows | nada foi mudado por ninguém além da pessoa | ☐ |
| 4.8 | conferir o dispositivo de saída padrão | continua o mesmo de antes | ☐ |
| 4.9 | repetir 4.3 a 4.5 transmitindo o **monitor inteiro** | mesmo resultado | ☐ |
| 4.10 | **abrir** o Discord no meio de uma live de monitor | o Discord não entra no áudio da live | ☐ |
| 4.11 | **fechar** o Discord no meio da live | a live não engasga nem cai | ☐ |
| 4.12 | tocar um som de interface do Tumacord (entrar/sair alguém) | quem assiste **não** ouve esse som | ☐ |

Em Configurações › Diagnóstico, durante 4.9, o relatório precisa mostrar
`aplicações excluídas` maior que zero com o motivo `blocked-executable`.

## Caso 5 — a fonte fecha

| # | Passo | Esperado | OK |
| --- | --- | --- | --- |
| 5.1 | transmitir uma janela com áudio e **fechar aquele programa** | o Tumacord não trava nem fecha; a call continua | ☐ |
| 5.2 | logo depois de 5.1 | a live para ou fica em estado recuperável, com mensagem clara | ☐ |
| 5.3 | conferir os processos | nenhum `tumacord-audio-helper.exe` sobrou | ☐ |
| 5.4 | iniciar outra live em seguida | funciona normalmente | ☐ |
| 5.5 | transmitir um programa, **fechar e reabrir** o programa | a captura acompanha o processo novo, ou a live para com mensagem — nunca fica muda em silêncio | ☐ |

## Caso 6 — dispositivos mudando

| # | Passo | Esperado | OK |
| --- | --- | --- | --- |
| 6.1 | remover o fone USB durante a call | a call **não** cai; o áudio migra ou avisa | ☐ |
| 6.2 | reconectar o fone | volta a funcionar sem sair da call | ☐ |
| 6.3 | trocar o dispositivo de saída padrão durante uma live com áudio | a live continua com som; nenhuma faixa duplicada aparece | ☐ |
| 6.4 | trocar o dispositivo de entrada padrão | o microfone se recupera sozinho | ☐ |
| 6.5 | fone Bluetooth trocando de perfil (A2DP ↔ HFP) | a call sobrevive | ☐ |
| 6.6 | desconectar um monitor HDMI durante uma live daquele monitor | o Tumacord não trava; a live para ou migra com mensagem | ☐ |
| 6.7 | conectar um monitor novo | ele aparece no seletor na próxima transmissão | ☐ |
| 6.8 | suspender e retomar o Windows durante a call | a call se reconstrói; a live volta ou avisa | ☐ |

## Caso 7 — rede

| # | Passo | Esperado | OK |
| --- | --- | --- | --- |
| 7.1 | duas máquinas na mesma LAN, sem convite | a call aparece sozinha na descoberta | ☐ |
| 7.2 | conectar por convite, sem servidor dedicado | entra por enlace direto | ☐ |
| 7.3 | conectar por servidor dedicado | entra pela sinalização do servidor | ☐ |
| 7.4 | forçar relay TURN dos dois lados | conecta, com mais latência | ☐ |
| 7.5 | derrubar e devolver a rede de um lado | reconecta sozinho, sem sair da call | ☐ |
| 7.6 | o host sair da call | outra pessoa assume e a sinalização migra | ☐ |
| 7.7 | conferir as regras de firewall (`netsh advfirewall firewall show rule name=all \| findstr Tumacord`) | as duas regras existem, nos perfis Privado/Domínio | ☐ |

## Caso 8 — instalação em um Windows limpo

| # | Passo | Esperado | OK |
| --- | --- | --- | --- |
| 8.1 | executar `Tumacord-0.8.8-Setup.exe` | um único prompt de UAC, durante a instalação | ☐ |
| 8.2 | conferir a pasta escolhida | o instalador permitiu escolher | ☐ |
| 8.3 | abrir pelo Menu Iniciar e pelo atalho da área de trabalho | os dois abrem o aplicativo | ☐ |
| 8.4 | conferir **Aplicativos instalados** | aparece "Tumacord 0.8.8", com ícone e editor | ☐ |
| 8.5 | entrar numa call, mandar mensagem, fechar e abrir de novo | a sessão e as mensagens continuam lá | ☐ |
| 8.6 | abrir uma segunda vez com o aplicativo já aberto | a janela existente vem para a frente; **não** abre uma segunda instância | ☐ |
| 8.7 | instalar por cima (mesma versão ou mais nova) com o app aberto | o instalador encerra o app com aviso e conclui | ☐ |
| 8.8 | depois de 8.7, abrir o aplicativo | conta, mensagens e preferências preservadas | ☐ |
| 8.9 | conferir o firewall depois da atualização | as regras não foram duplicadas | ☐ |
| 8.10 | desinstalar | o aplicativo sai; as regras de firewall somem | ☐ |
| 8.11 | depois de desinstalar, conferir `%APPDATA%\Tumacord` | os dados do usuário continuam lá (remoção é decisão de quem usa) | ☐ |
| 8.12 | rodar o `portable.exe` numa máquina sem instalação | abre e funciona; a transmissão com áudio também | ☐ |
| 8.13 | conferir que a máquina **não** tem Node, npm nem Visual C++ Redistributable | o aplicativo funciona mesmo assim | ☐ |

## Caso 9 — assinatura

| # | Passo | Esperado | OK |
| --- | --- | --- | --- |
| 9.1 | `Get-AuthenticodeSignature .\Tumacord-0.8.8-Setup.exe` | `Status = Valid` | ☐ |
| 9.2 | idem para o `portable.exe` | `Status = Valid` | ☐ |
| 9.3 | idem para `Tumacord.exe` e `resources\audio-helper\tumacord-audio-helper.exe` da pasta instalada | `Status = Valid` nos dois | ☐ |
| 9.4 | conferir o publisher em todos | é o mesmo, e o mesmo da versão anterior | ☐ |
| 9.5 | conferir o carimbo de tempo | presente e válido | ☐ |
| 9.6 | conferir o SHA-256 do arquivo baixado contra `SHA256SUMS-windows.txt` | confere | ☐ |

Enquanto não houver certificado configurado, 9.1 a 9.5 falham por projeto —
o workflow avisa em vez de fingir. Veja `docs/windows-build.md`.

## Caso 10 — desempenho e vazamento

Com **1080p60 + áudio + call de três pessoas**, durante pelo menos 30 minutos:

| # | O quê | Esperado | OK |
| --- | --- | --- | --- |
| 10.1 | CPU do processo principal do Tumacord | estável, sem subir ao longo do tempo | ☐ |
| 10.2 | CPU do `tumacord-audio-helper.exe` | baixa e estável | ☐ |
| 10.3 | memória dos dois | sem crescimento contínuo | ☐ |
| 10.4 | contagem de handles (Gerenciador de Tarefas › Detalhes) | sem crescimento contínuo | ☐ |
| 10.5 | número de processos auxiliares | um helper, e só | ☐ |
| 10.6 | Configurações › Diagnóstico, campo `amortecedor` | faltas e descartes param de crescer depois do início | ☐ |
| 10.7 | encerrar a live e conferir de novo | memória volta perto do patamar anterior | ☐ |

## Caso 11 — GPU e captura

| # | Passo | Esperado | OK |
| --- | --- | --- | --- |
| 11.1 | minimizar o Tumacord durante uma live | a captura continua, sem escurecer nem engasgar | ☐ |
| 11.2 | soltar a live em janela flutuante e cobri-la | idem | ☐ |
| 11.3 | a janela compartilhada ganhar e perder foco | a imagem continua | ☐ |
| 11.4 | a aplicação compartilhada entrar em tela cheia | a captura acompanha | ☐ |
| 11.5 | monitores com DPI diferentes | a imagem não corta nem estica | ☐ |
| 11.6 | repetir num host NVIDIA, num AMD e num Intel | funciona nos três | ☐ |

## Windows 10

O isolamento por aplicação exige **Windows 10 20H1 (build 19041)** ou mais
novo. Abaixo disso a sondagem responde `processLoopback: false`, o vídeo
continua funcionando e o aplicativo diz, com estas palavras:

> Nesta versão do Windows, o áudio da aplicação não pode ser isolado com
> segurança. A transmissão continuará sem áudio.

Não existe reserva. A única alternativa técnica seria capturar o dispositivo
inteiro, e é exatamente isso que devolveria a call para dentro da live.

| # | Passo | Esperado | OK |
| --- | --- | --- | --- |
| W.1 | rodar o `--probe` num Windows 10 anterior à 20H1 | `processLoopback: false` | ☐ |
| W.2 | transmitir com áudio marcado nessa máquina | o vídeo vai, o aviso aparece, e nenhuma faixa de áudio é criada | ☐ |
| W.3 | conferir que nada da call vazou | quem assiste não ouve voz nenhuma | ☐ |

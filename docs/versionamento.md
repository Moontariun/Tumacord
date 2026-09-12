# Versionamento

A convenção de versão do Tumacord, por escrito, porque ela **não é SemVer** e
a diferença muda quem recebe qual atualização.

---

## A regra

```text
0.9.9 < 0.9.9-1 < 0.9.9-2 < 0.9.9-10 < 0.9.10 < 1.0.0 < 1.0.0-1
```

Uma versão é a tupla `(major, minor, patch, revision)`:

| Campo | Onde aparece | Sem ele |
|---|---|---|
| `major` | `**0**.9.9-1` | obrigatório |
| `minor` | `0.**9**.9-1` | obrigatório |
| `patch` | `0.9.**9**-1` | obrigatório na forma canônica |
| `revision` | `0.9.9-**1**` | é zero |

O sufixo `-N` é a **revisão de manutenção**: um inteiro positivo que vem
*depois* da versão que ele corrige. `0.9.9-1` é a correção da 0.9.9, não um
ensaio para ela.

---

## Por que não é SemVer

No SemVer, `0.9.9-1` é uma **pré-versão** e vem *antes* de `0.9.9` —
exatamente o contrário do que este projeto precisa. Se a ordenação de SemVer
valesse aqui, quem estivesse na 0.9.9 nunca receberia a 0.9.9-1: o aplicativo
concluiria que já está numa versão mais nova.

Foi o que aconteceu. Até a 0.9.9 a regra de ordenação estava escrita quatro
vezes — no aplicativo, no servidor e em dois scripts — e as cópias divergiram.

**Por isso:**

- nenhum comparador de SemVer decide nada neste projeto;
- nenhuma ordenação alfabética, tampouco — ela diria que `0.8.9` é maior que
  `0.8.10`, e esta numeração já passou por `0.7.10` e `0.7.11`;
- a implementação é **uma só**: [`shared/version.ts`](../shared/version.ts).
  A adaptação CJS que o Electron precisa é gerada por
  `scripts/gerar-versao.mjs`, e `tests/version.test.ts` falha se as duas
  divergirem.

> Uma biblioteca de atualização que ordene por SemVer precisa de adaptação
> explícita antes de ser adotada — e a adaptação precisa ser testada com os
> vetores desta página.

---

## O que não faz parte

`alpha`, `beta`, `rc` e `+build` **não são versões deste projeto**. Uma
etiqueta como `v0.9.9-rc1` é recusada na leitura, no CI e na publicação.

O motivo é a ambiguidade: misturar as duas convenções obrigaria a ler o mesmo
`-1` como "antes" num caso e "depois" no outro, e a leitura certa dependeria de
adivinhar a intenção de quem marcou a etiqueta.

**Quem é ensaio é decidido pelo canal**, que é um campo separado e explícito do
catálogo: `stable` ou `test`. Uma versão de ensaio tem um número normal e mora
no canal de ensaio.

---

## Forma canônica

| Escrita | Aceita como entrada? | Forma canônica |
|---|---|---|
| `0.9.9-1` | sim | `0.9.9-1` |
| `v0.9.9-1` | sim | `0.9.9-1` |
| `V0.9.9-1` | sim | `0.9.9-1` |
| ` 0.9.9-1 ` | sim | `0.9.9-1` |
| `1.0` | sim, **só como entrada** | `1.0.0` |
| `01.0.0` | **não** | — |
| `0.9.9-01` | **não** | — |
| `0.9.9-0` | **não** | — |
| `0.9.9-rc1` | **não** | — |
| `1.0.0+build7` | **não** | — |

Zeros à esquerda são recusados porque duas escritas para a mesma versão
seriam duas etiquetas apontando para o mesmo lugar — e é assim que se publica
conteúdo diferente sob o mesmo número sem ninguém notar.

**Limites:** cada campo vai até **65535**. O limite não é estético: a versão
numérica do Windows tem quatro campos de 16 bits, e recusar na leitura é melhor
do que descobrir no empacotamento que a etiqueta publicada não tem
representação no instalador — quando os binários já foram feitos.

---

## Entrada malformada é erro

Comparar um texto que não é uma versão **lança**. Ele não é "igual" a coisa
nenhuma.

A versão anterior devolvia `0` para lixo, e `0` quer dizer "são a mesma
versão": uma entrada corrompida do catálogo fazia o cliente concluir que já
estava em dia.

---

## A versão numérica do Windows

`0.9.9` vira `0.9.9.0` e `0.9.9-1` vira `0.9.9.1`.

**Isto precisa ser configurado, e não acontece sozinho.** Com `version` =
`0.9.9-1`, o electron-builder produz `0.9.9.0` — o **mesmo número** da 0.9.9 —
porque ele lê `parseInt("9-1")` como 9 e preenche o quarto campo com o número
de build, que é zero por padrão. Duas versões diferentes com o mesmo número
fazem o Windows tratar a atualização como reinstalação da mesma coisa.

O `scripts/gerar-versao.mjs` deriva `build.buildNumber` e `build.buildVersion`
do `package.json` a partir da versão do produto. `tests/version.test.ts`
verifica isso **contra o electron-builder de verdade**, e não contra uma
suposição sobre o que ele faz.

O componente nativo de áudio segue a mesma regra, em
`native/windows/audio-helper/build.ps1`.

---

## Etiquetas e publicação

A etiqueta publicada é `v` + forma canônica: `v0.9.9`, `v0.9.9-1`, `v1.0.0`.

O CI recusa etiqueta fora da convenção **antes** de publicar. E ele não infere
canal pelo formato: até a 0.9.9, toda etiqueta com hífen era marcada como
prerelease, o que rebaixaria justamente a correção mais estável que existe no
momento em que sai. O canal vem de `TUMACORD_CANAL`, que é explícito.

**Um número já publicado não volta a ser usado para conteúdo diferente.**
Reaproveitar `0.9.9-1` para outra release faria metade do grupo estar numa
0.9.9-1 e a outra metade noutra, com o mesmo nome, e sem jeito de saber qual é
qual olhando a versão. O serviço de distribuição recusa isso na publicação.

---

## Downgrade

O aplicativo **nunca** oferece uma versão mais antiga do que a instalada, e
nunca aplica uma sozinho. Voltar atrás é uma operação legítima — mas é uma
decisão de quem opera, com autorização, e não algo que um catálogo possa
provocar.

Retirar uma versão aumenta a sequência do catálogo sem oferecer nada novo. A
sequência do catálogo e a ordem da versão do produto respondem perguntas
diferentes: uma diz "este catálogo é mais recente", a outra diz "esta build é
mais nova".

---

## Versões bloqueadas

| Versão | Motivo | Desde |
|---|---|---|
| `0.8.9` | as resoluções e o FPS da transmissão saem errados | embutido no aplicativo |

A lista embutida resolve o passado: uma versão que já estava quebrada quando a
cópia foi compilada. O futuro é resolvido pelo **catálogo assinado**, que essa
lista, por definição, não conhece.

Retiradas novas moram só no catálogo. Até a 0.9.9 elas eram declaradas por um
marcador em comentário de HTML nas notas da Release — uma segunda autoridade
sobre o que está retirado, e a segunda autoridade é sempre a que alguém
consegue forjar.

---

## Onde a regra é exercida

| Consumidor | Como |
|---|---|
| aplicativo (Electron) | `desktop/version.generated.cjs`, gerado da fonte |
| servidor dedicado | `shared/serverUpdate.ts`, que importa a fonte |
| serviço de distribuição | `shared/distribution.ts`, que importa a fonte |
| empacotamento Windows | `scripts/gerar-versao.mjs` → `package.json` |
| componente nativo | `native/windows/audio-helper/build.ps1` |
| CI | `desktop/version.generated.cjs`, no passo de publicar |

Os vetores desta página são exercidos em `tests/version.test.ts`, e os mesmos
vetores passam pela fonte **e** pela adaptação gerada.

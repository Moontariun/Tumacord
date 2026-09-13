# Versionamento

A convenção de versão do Tumacord é **SemVer 2.0.0**, desde a 0.10.0. Este
documento diz o que isso significa aqui, o que mudou em relação à convenção
própria que existia até a 0.9.9-2, e por que a troca não deixou ninguém para
trás.

---

## A regra

```text
0.9.9 < 0.9.10 < 0.10.0 < 1.0.0-alpha < 1.0.0-alpha.1 < 1.0.0-beta < 1.0.0-rc.1 < 1.0.0 < 1.0.1
```

`MAJOR.MINOR.PATCH`, com pré-versão opcional depois de `-` e metadado de build
opcional depois de `+`. É a especificação pública, sem dialeto.

| Parte | Exemplo | O que é |
|---|---|---|
| `major` | **1**.2.3 | quebra compatibilidade |
| `minor` | 1.**2**.3 | funcionalidade nova, compatível |
| `patch` | 1.2.**3** | correção, compatível |
| pré-versão | 1.2.3-**rc.1** | vem **antes** da 1.2.3 |
| build | 1.2.3+**abc** | não participa da ordem |

**Uma correção da 0.9.9 chama-se 0.9.10.** Não `0.9.9-1`.

---

## O que mudou, e o que custou

Até a 0.9.9-2 o sufixo `-N` era a **revisão de manutenção** e vinha *depois* da
versão que corrigia: `0.9.9-1` era a correção da 0.9.9. Sob SemVer isso se
inverte — `0.9.9-1` passa a ser uma pré-versão da 0.9.9, e portanto anterior a
ela.

A inversão é real e é o preço declarado da troca. O que ela **não** faz é
deixar alguém sem atualização, por um motivo aritmético:

```text
0.10.0 > 0.9.9-1     pela regra antiga   ✓
0.10.0 > 0.9.9-1     pela regra nova     ✓
```

As cópias instaladas em campo estão na 0.9.9-1 e leem pela regra antiga; as
novas leem por esta. Como `0.10.0` é maior nas duas, a 0.10.0 alcança todo
mundo. `tests/version.test.ts` fixa exatamente isso, para que a próxima pessoa
que mexer na ordenação descubra o requisito antes de quebrá-lo.

A inversão só voltaria a machucar se uma versão nova usasse `-N` para dizer
"depois". Não use. Use o `patch`.

---

## Pré-versão e canal são coisas diferentes

Uma pré-versão diz o que o **número** é. O canal (`stable`, `test`) diz para
**quem** ele é oferecido. São perguntas separadas e ficam em campos separados.

Publicar `1.0.0-rc.1` no canal estável é possível, é quase sempre um engano, e
por isso o publicador **recusa** sem `--aceitar-pre-versao`:

```bash
node tools/publisher/publish.mjs catalog --manifest /tmp/manifest.json --channel test
```

O motivo não é só higiene. Veja a seção do Windows.

---

## O quarto campo, e o Windows

A versão numérica do Windows tem quatro campos de 16 bits. Sob SemVer o quarto
é sempre **zero**: duas versões publicáveis nunca compartilham o mesmo
`major.minor.patch`, então não há o que desempatar.

**Uma pré-versão não tem número de Windows.** `1.2.3-rc.1` teria de virar um
número *menor* que `1.2.3.0`, e não existe número menor com quatro campos não
negativos terminando em zero. Se as duas saíssem como `1.2.3.0`, o Windows
trataria a troca da rc pela final como reinstalação da mesma coisa — e quem
instalou a rc ficaria preso nela.

Por isso `windowsVersion()` **lança** para pré-versão, e
`scripts/generate-version.mjs` recusa gerar os campos do electron-builder para
uma. O erro aparece antes de qualquer binário existir, e não na máquina de quem
instalou.

Pré-versão de Windows se distribui como portátil, ou não se distribui.

---

## Onde a regra mora

`shared/version.ts` é a **única** implementação. O aplicativo, o servidor, o
publicador, os scripts e os testes leem daqui.

O processo principal do Electron carrega `desktop/*.cjs` sem bundler e não
consegue importar TypeScript, então existe uma segunda cópia em CJS — mas ela é
**gerada** por `scripts/generate-version.mjs`, e `tests/version.test.ts` falha
se as duas divergirem. Antes da 0.9.9-1 a regra estava escrita quatro vezes à
mão, e as cópias divergiram: é o defeito que a geração existe para impedir.

```bash
node scripts/generate-version.mjs           # escreve
node scripts/generate-version.mjs --check   # só confere (CI)
```

---

## O que é recusado, e por quê

| Recusa | Motivo |
|---|---|
| `01.0.0`, `1.0.0-rc.01` | zero à esquerda: duas escritas para a mesma versão são duas etiquetas para o mesmo lugar |
| `1.2.3.4` | SemVer tem três campos; um quarto não tem como ser ordenado |
| `1.0.0-`, `1.0.0+` | sufixo anunciado e vazio |
| acima de 65535 em qualquer campo | não cabe no campo de 16 bits do Windows |
| texto que não é versão | comparar lixo **lança**; devolver `0` diria "são a mesma versão", e foi assim que uma entrada corrompida do catálogo já convenceu um cliente de que estava em dia |

`1.0` é aceito **como entrada** e normalizado para `1.0.0`, porque gente
escreve `1.0`. Ele nunca sai assim.

---

## A etiqueta publicada

`v` seguido da forma canônica: `v0.10.0`, `v1.0.0-rc.1`. O `v` é aceito na
entrada em qualquer lugar que leia versão, e nunca aparece na forma canônica.

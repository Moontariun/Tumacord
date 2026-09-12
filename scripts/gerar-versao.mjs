#!/usr/bin/env node
// Gera a adaptação CJS da política de versão a partir de `shared/version.ts`.
//
// O processo principal do Electron carrega `desktop/*.cjs` cru, sem passar por
// bundler: ele não consegue importar o módulo TypeScript. Até a 0.9.9 a saída
// desse impasse foi escrever a mesma regra de ordenação duas vezes, à mão — e
// as duas cópias divergiram, que é o defeito que a 0.9.9-1 corrige. Aqui a
// segunda cópia continua existindo, porque tem de existir, mas ela é
// **gerada**: `tests/version.test.ts` regera e compara, e falha se alguém
// editar a saída em vez da fonte.
//
// O mesmo script também mantém em dia os campos do electron-builder que
// dependem da versão. Eles não podem ser deduzidos por ele sozinho: com
// `version` = `0.9.9-1`, o electron-builder produz a versão numérica
// `0.9.9.0` — o **mesmo número** da 0.9.9, porque ele lê `parseInt("9-1")`
// como 9 e preenche o quarto campo com o número de build, que é zero. Duas
// versões diferentes com o mesmo número no Windows fazem a atualização parecer
// reinstalação da mesma coisa. `buildNumber` é a revisão, e é isso que põe o
// `.1` no lugar certo.
//
// Uso:
//   node scripts/gerar-versao.mjs           escreve os arquivos
//   node scripts/gerar-versao.mjs --check    só confere, sem escrever (CI)

import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projeto = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fonte = resolve(projeto, 'shared/version.ts');
const destino = resolve(projeto, 'desktop/version.generated.cjs');
const pacote = resolve(projeto, 'package.json');

const AVISO = `// ATENÇÃO: arquivo gerado por scripts/gerar-versao.mjs a partir de
// shared/version.ts. Não edite aqui — a edição seria perdida na próxima
// geração, e \`tests/version.test.ts\` falha quando os dois divergem.
//
// A política de versão do Tumacord tem uma implementação só. Esta é a
// adaptação CJS dela, para o processo principal do Electron, que carrega
// \`desktop/*.cjs\` sem bundler.
`;

export function gerar() {
  const { outputFiles } = buildSync({
    entryPoints: [fonte],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    write: false,
    legalComments: 'none',
  });
  return `${AVISO}\n${outputFiles[0].text}`;
}

/**
 * Os campos do `package.json` que precisam acompanhar a versão do produto.
 *
 * `buildNumber` é a revisão de manutenção. Ele é o quarto campo da versão
 * numérica do Windows, e sem ele `0.9.9-1` e `0.9.9` viram o mesmo número.
 * `buildVersion` é fixado para o electron-builder não montar `0.9.9-1.1`
 * concatenando os dois.
 */
export function camposDoPacote(version) {
  const { revision, text } = lerVersao(version);
  return { buildNumber: String(revision), buildVersion: text };
}

// A leitura da versão pela implementação única, sem depender de bundler: o
// mesmo texto gerado para o CJS é avaliado aqui.
let lido = null;
function lerVersao(version) {
  if (!lido) {
    const modulo = { exports: {} };
    new Function('module', 'exports', 'require', gerar())(modulo, modulo.exports, () => {});
    lido = modulo.exports;
  }
  return lido.requireVersion(version);
}

function sincronizarPacote(escrever) {
  const bruto = readFileSync(pacote, 'utf8');
  const json = JSON.parse(bruto);
  const desejado = camposDoPacote(json.version);
  const atualBuild = { buildNumber: json.build?.buildNumber, buildVersion: json.build?.buildVersion };
  if (atualBuild.buildNumber === desejado.buildNumber && atualBuild.buildVersion === desejado.buildVersion) return { mudou: false };
  if (!escrever) return { mudou: true, desejado };
  json.build = { ...json.build, ...desejado };
  // Reescreve preservando a indentação de dois espaços do arquivo.
  writeFileSync(pacote, `${JSON.stringify(json, null, 2)}\n`);
  return { mudou: true, desejado };
}

// Só a invocação direta escreve ou encerra o processo. Os testes importam
// `gerar()` para comparar com o arquivo em disco, e um `process.exit` no topo
// deste módulo encerraria a suíte inteira no meio.
function principal() {
  const conferir = process.argv.includes('--check');
  const gerado = gerar();
  const atual = (() => {
    try { return readFileSync(destino, 'utf8'); } catch { return null; }
  })();

  let falhou = false;
  if (gerado !== atual) {
    if (conferir) {
      console.error('desktop/version.generated.cjs está fora de sincronia com shared/version.ts.');
      falhou = true;
    } else {
      writeFileSync(destino, gerado);
      console.log('desktop/version.generated.cjs gerado a partir de shared/version.ts.');
    }
  } else if (!conferir) {
    console.log('desktop/version.generated.cjs já está em dia.');
  }

  const pacoteResultado = sincronizarPacote(!conferir);
  if (pacoteResultado.mudou) {
    if (conferir) {
      console.error(`package.json: build.buildNumber/buildVersion deveriam ser ${JSON.stringify(pacoteResultado.desejado)}.`);
      falhou = true;
    } else {
      console.log(`package.json: build.buildNumber=${pacoteResultado.desejado.buildNumber}, build.buildVersion=${pacoteResultado.desejado.buildVersion}.`);
    }
  } else if (!conferir) {
    console.log('package.json já está em dia.');
  }

  if (falhou) console.error('Rode: node scripts/gerar-versao.mjs');
  return falhou ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(principal());
}

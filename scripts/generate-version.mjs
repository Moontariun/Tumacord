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
//   node scripts/generate-version.mjs           escreve os arquivos
//   node scripts/generate-version.mjs --check    só confere, sem escrever (CI)

import { buildSync } from 'esbuild';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageFile = resolve(projectRoot, 'package.json');

/**
 * O que é gerado, e de onde.
 *
 * O processo principal do Electron carrega `desktop/*.cjs` sem bundler: ele
 * não importa TypeScript. Cada entrada aqui é uma regra que precisa existir
 * dos dois lados e **não pode divergir** — a política de versão e os contratos
 * da distribuição. `tests/version.test.ts` regera e compara.
 */
const MODULES = [
  { fonte: 'shared/version.ts', destino: 'desktop/version.generated.cjs' },
  { fonte: 'shared/distribution.ts', destino: 'desktop/distribution.generated.cjs' },
  { fonte: 'shared/distributionCrypto.ts', destino: 'desktop/distribution-crypto.generated.cjs' },
];

const source = resolve(projectRoot, MODULES[0].fonte);
const destination = resolve(projectRoot, MODULES[0].destino);

const GENERATED_NOTICE = `// ATENÇÃO: arquivo gerado por scripts/generate-version.mjs a partir de
// shared/version.ts. Não edite aqui — a edição seria perdida na próxima
// geração, e \`tests/version.test.ts\` falha quando os dois divergem.
//
// A política de versão do Tumacord tem uma implementação só. Esta é a
// adaptação CJS dela, para o processo principal do Electron, que carrega
// \`desktop/*.cjs\` sem bundler.
`;

/** Gera a adaptação CJS de um módulo TypeScript. */
export function generateModule(relativePath) {
  const { outputFiles } = buildSync({
    entryPoints: [resolve(projectRoot, relativePath)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    write: false,
    legalComments: 'none',
  });
  return `${GENERATED_NOTICE}\n${outputFiles[0].text}`;
}

export function generate() {
  const { outputFiles } = buildSync({
    entryPoints: [source],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    target: 'node20',
    write: false,
    legalComments: 'none',
  });
  return `${GENERATED_NOTICE}\n${outputFiles[0].text}`;
}

/**
 * Os campos do `package.json` que precisam acompanhar a versão do produto.
 *
 * `buildNumber` é a revisão de manutenção. Ele é o quarto campo da versão
 * numérica do Windows, e sem ele `0.9.9-1` e `0.9.9` viram o mesmo número.
 * `buildVersion` é fixado para o electron-builder não montar `0.9.9-1.1`
 * concatenando os dois.
 */
export { MODULES as MODULOS };

export function packageFields(version) {
  const { revision, text } = readVersion(version);
  return { buildNumber: String(revision), buildVersion: text };
}

// A leitura da versão pela implementação única, sem depender de bundler: o
// mesmo texto gerado para o CJS é avaliado aqui.
let parsed = null;
function readVersion(version) {
  if (!parsed) {
    const loadedModule = { exports: {} };
    new Function('module', 'exports', 'require', generate())(loadedModule, loadedModule.exports, () => {});
    parsed = loadedModule.exports;
  }
  return parsed.requireVersion(version);
}

function syncPackageJson(shouldWrite) {
  const raw = readFileSync(packageFile, 'utf8');
  const json = JSON.parse(raw);
  const desired = packageFields(json.version);
  const currentBuild = { buildNumber: json.build?.buildNumber, buildVersion: json.build?.buildVersion };
  if (currentBuild.buildNumber === desired.buildNumber && currentBuild.buildVersion === desired.buildVersion) return { mudou: false };
  if (!shouldWrite) return { mudou: true, desejado: desired };
  json.build = { ...json.build, ...desired };
  // Reescreve preservando a indentação de dois espaços do arquivo.
  writeFileSync(packageFile, `${JSON.stringify(json, null, 2)}\n`);
  return { mudou: true, desejado: desired };
}

// Só a invocação direta escreve ou encerra o processo. Os testes importam
// `gerar()` para comparar com o arquivo em disco, e um `process.exit` no topo
// deste módulo encerraria a suíte inteira no meio.
function runCli() {
  const checkOnly = process.argv.includes('--check');
  const generated = generate();
  const current = (() => {
    try { return readFileSync(destination, 'utf8'); } catch { return null; }
  })();

  let failed = false;
  void generated;
  void current;
  for (const loadedModule of MODULES) {
    const output = generateModule(loadedModule.fonte);
    const filePath = resolve(projectRoot, loadedModule.destino);
    const onDisk = (() => {
      try { return readFileSync(filePath, 'utf8'); } catch { return null; }
    })();
    if (output === onDisk) {
      if (!checkOnly) console.log(`${loadedModule.destino} já está em dia.`);
      continue;
    }
    if (checkOnly) {
      console.error(`${loadedModule.destino} está fora de sincronia com ${loadedModule.fonte}.`);
      failed = true;
      continue;
    }
    writeFileSync(filePath, output);
    console.log(`${loadedModule.destino} gerado a partir de ${loadedModule.fonte}.`);
  }

  const packageOutcome = syncPackageJson(!checkOnly);
  if (packageOutcome.mudou) {
    if (checkOnly) {
      console.error(`package.json: build.buildNumber/buildVersion deveriam ser ${JSON.stringify(packageOutcome.desejado)}.`);
      failed = true;
    } else {
      console.log(`package.json: build.buildNumber=${packageOutcome.desejado.buildNumber}, build.buildVersion=${packageOutcome.desejado.buildVersion}.`);
    }
  } else if (!checkOnly) {
    console.log('package.json já está em dia.');
  }

  if (failed) console.error('Rode: node scripts/generate-version.mjs');
  return failed ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runCli());
}

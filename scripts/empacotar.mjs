#!/usr/bin/env node
// Empacota, com a origem das atualizações gravada só durante o empacotamento.
//
// ## Por que existe um invólucro em vez de um `&&` no `package.json`
//
// A origem e as chaves confiáveis precisam estar **dentro** do pacote, e por
// isso são escritas em `desktop/update-origin.generated.cjs` antes de o
// electron-builder rodar. O que elas não podem é **ficar** na árvore de
// trabalho depois: com o arquivo lá, `npm test` deixa de conseguir perguntar
// "e quando não há origem configurada?" — a resposta passa a depender de qual
// foi a última build feita naquela máquina, e um teste que depende disso não
// prova nada.
//
// Daí o `finally`: o arquivo é apagado mesmo quando o empacotamento falha, que
// é justamente quando ele ficaria para trás sem ninguém notar.
//
// ## De onde vêm os valores
//
//   TUMACORD_UPDATE_ORIGIN   o endereço do serviço de atualizações
//   TUMACORD_UPDATE_KEYS     caminho do documento de chaves públicas
//
// Sem as duas, o pacote sai **sem** origem — e isso é dito em voz alta, não
// suposto. Um pacote assim é legítimo (é o que um clone produz), mas quem o
// instalar não terá de onde atualizar, e é melhor saber disso agora do que
// depois de distribuir.
//
// USO
//   node scripts/empacotar.mjs --linux
//   node scripts/empacotar.mjs --windows

import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.join(AQUI, '..');
const GERADO = path.join(RAIZ, 'desktop', 'update-origin.generated.cjs');

const ALVOS = {
  '--linux': ['--linux', 'AppImage', 'tar.gz', '--publish', 'never'],
  '--windows': ['--win', 'nsis', 'portable', '--publish', 'never'],
  '--dir': ['--linux', 'dir', '--publish', 'never'],
};

function rodar(comando, argumentos) {
  const resultado = spawnSync(comando, argumentos, { cwd: RAIZ, stdio: 'inherit', shell: process.platform === 'win32' });
  if (resultado.status !== 0) {
    throw new Error(`${comando} ${argumentos.join(' ')} terminou com ${resultado.status ?? resultado.signal}`);
  }
}

const alvo = process.argv[2];
if (!ALVOS[alvo]) {
  console.error(`Uso: node scripts/empacotar.mjs ${Object.keys(ALVOS).join(' | ')}`);
  process.exit(1);
}

const origem = process.env.TUMACORD_UPDATE_ORIGIN ?? '';
const chaves = process.env.TUMACORD_UPDATE_KEYS ?? '';

try {
  if (origem && chaves) {
    rodar(process.execPath, [path.join(AQUI, 'gerar-origem.mjs'), '--origin', origem, '--keys', chaves]);
  } else {
    // Dito, e não suposto: um pacote sem origem instala e nunca atualiza.
    console.warn('\n⚠ TUMACORD_UPDATE_ORIGIN e TUMACORD_UPDATE_KEYS não estão definidas.');
    console.warn('  O pacote vai sair SEM origem de atualizações: quem o instalar não terá de onde atualizar.\n');
  }
  rodar('npx', ['electron-builder', ...ALVOS[alvo]]);
} finally {
  // Mesmo com falha acima. É exatamente no caminho de erro que o arquivo
  // ficaria para trás e passaria a contaminar os testes daquela máquina.
  if (existsSync(GERADO)) {
    rmSync(GERADO, { force: true });
    console.log('Origem gravada removida da árvore de trabalho.');
  }
}

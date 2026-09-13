#!/usr/bin/env node
// Grava na build a origem das atualizações e as chaves em que ela confia.
//
// `desktop/update-origin.cjs` nasce com as duas constantes vazias, e é assim
// que o repositório é publicado: ele não traz o domínio de ninguém. Quem
// empacota é que decide de onde aquela build vai buscar atualização, e este é
// o comando que grava a decisão — o mesmo que os comentários daquele arquivo
// já citavam.
//
// **Por que embutir, e não configurar depois.** A origem e as chaves são a
// resposta para "em quem este executável confia para instalar código nesta
// máquina". Se elas chegassem pela rede — num convite, numa resposta de API,
// num socket —, entrar num servidor qualquer seria entregar a ele essa
// capacidade. Embutidas, elas viajam dentro do aplicativo e um servidor não as
// muda.
//
// Só a metade **pública** das chaves entra aqui. O comando recusa qualquer
// documento onde apareça material privado: um executável distribuído com a
// chave de assinatura dentro acabaria com a distribuição inteira, e é o tipo
// de erro que só se descobre depois.
//
// USO
//   node scripts/gerar-origem.mjs --origin https://updates.exemplo.com \
//                                 --keys /caminho/chaves.json
//   node scripts/gerar-origem.mjs --mostrar     (o que está gravado agora)
//   node scripts/gerar-origem.mjs --limpar      (volta ao estado do repositório)
//
// O comando é idempotente: rodar de novo com os mesmos valores não muda nada,
// e rodar com valores diferentes substitui os anteriores por inteiro. Ele
// nunca acumula chave — uma chave que saiu da lista sai da build.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ARQUIVO = path.join(AQUI, '..', 'desktop', 'update-origin.cjs');

// Os dois pontos exatos do arquivo que este comando reescreve. Casar a
// declaração inteira — e exigir que ela apareça uma vez só — é o que impede
// que uma mudança no arquivo faça a gravação cair no lugar errado em silêncio.
const ALVO_ORIGEM = /^const BUILT_IN_ORIGIN = .*;$/m;
const ALVO_CHAVES = /^const BUILT_IN_KEYS = [\s\S]*?^\];$|^const BUILT_IN_KEYS = \[\];$/m;

/** Palavras que denunciam material privado num documento de chaves. */
const MARCAS_DE_PRIVADO = /"?(privateKey|private_key|secretKey|secret|seed)"?\s*:/i;

function erro(mensagem) {
  console.error(mensagem);
  process.exit(1);
}

function lerArgumentos(argv) {
  const opcoes = { origin: '', keys: '', mostrar: false, limpar: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--origin') opcoes.origin = argv[++i] ?? '';
    else if (arg === '--keys') opcoes.keys = argv[++i] ?? '';
    else if (arg === '--mostrar') opcoes.mostrar = true;
    else if (arg === '--limpar') opcoes.limpar = true;
    else if (arg === '--help' || arg === '-h') opcoes.ajuda = true;
    else erro(`Opção desconhecida: ${arg}`);
  }
  return opcoes;
}

/**
 * A mesma regra do aplicativo, e de propósito.
 *
 * `https` sempre; `http` só em `localhost`, que é homologação na própria
 * máquina. Gravar aqui um `http` para fora produziria uma build que entrega o
 * catálogo e a credencial a quem estiver no caminho — e o erro só apareceria
 * na máquina de quem instalou.
 */
function origemAceitavel(candidata) {
  let url;
  try {
    url = new URL(String(candidata));
  } catch {
    return '';
  }
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol !== 'http:') return '';
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  return local ? url.origin : '';
}

function conferirChave(chave, indice) {
  const onde = `chave #${indice + 1}`;
  if (!chave || typeof chave !== 'object') erro(`${onde}: não é um objeto.`);
  for (const campo of ['keyId', 'algorithm', 'publicKey']) {
    if (typeof chave[campo] !== 'string' || !chave[campo]) erro(`${onde}: falta ${campo}.`);
  }
  if (!Array.isArray(chave.scope) || !chave.scope.length) erro(`${onde}: falta o escopo.`);
  return {
    keyId: chave.keyId,
    algorithm: chave.algorithm,
    publicKey: chave.publicKey,
    scope: [...chave.scope],
    // `notBefore`, `notAfter` e `revokedAt` só entram quando existem: gravar
    // campos vazios faria uma chave sem prazo parecer uma chave com prazo.
    ...(chave.notBefore ? { notBefore: chave.notBefore } : {}),
    ...(chave.notAfter ? { notAfter: chave.notAfter } : {}),
    ...(chave.revokedAt ? { revokedAt: chave.revokedAt } : {}),
  };
}

async function lerChaves(caminho) {
  const bruto = await readFile(caminho, 'utf8');
  if (MARCAS_DE_PRIVADO.test(bruto)) {
    erro(`${caminho} contém material privado. Use a saída de \`publish.mjs keys trusted\`, que só tem a metade pública.`);
  }
  let documento;
  try {
    documento = JSON.parse(bruto);
  } catch (causa) {
    erro(`${caminho} não é JSON válido: ${causa.message}`);
  }
  const chaves = Array.isArray(documento) ? documento : documento.keys;
  if (!Array.isArray(chaves) || !chaves.length) {
    // Uma build com origem e sem chave não verifica nada. Aceitar isso seria
    // trocar a verificação por um endereço.
    erro(`${caminho} não traz chave nenhuma. Uma origem sem chave confiável não verifica documento algum.`);
  }
  const escopos = new Set(chaves.flatMap((chave) => chave.scope ?? []));
  for (const necessario of ['manifest', 'catalog']) {
    if (!escopos.has(necessario)) {
      // Faltar um escopo não é erro de digitação: a build sairia capaz de
      // verificar metade do caminho, e a outra metade só falharia na máquina
      // de quem instalou.
      erro(`Nenhuma chave com escopo "${necessario}". A build precisa poder verificar o catálogo e os manifestos.`);
    }
  }
  return chaves.map(conferirChave);
}

function gravar(fonte, origem, chaves) {
  if ((fonte.match(ALVO_ORIGEM) ?? []).length !== 1) {
    erro('Não encontrei a declaração de BUILT_IN_ORIGIN em desktop/update-origin.cjs.');
  }
  if (!ALVO_CHAVES.test(fonte)) {
    erro('Não encontrei a declaração de BUILT_IN_KEYS em desktop/update-origin.cjs.');
  }
  const chavesEscritas = chaves.length
    ? `const BUILT_IN_KEYS = ${JSON.stringify(chaves, null, 2).replace(/\n/g, '\n')};`
    : 'const BUILT_IN_KEYS = [];';
  return fonte
    .replace(ALVO_ORIGEM, `const BUILT_IN_ORIGIN = ${JSON.stringify(origem)};`)
    .replace(ALVO_CHAVES, chavesEscritas);
}

function mostrar(fonte) {
  const origem = ALVO_ORIGEM.exec(fonte)?.[0] ?? '(não encontrada)';
  const chaves = ALVO_CHAVES.exec(fonte)?.[0] ?? '(não encontradas)';
  console.log(origem);
  console.log(chaves);
}

async function principal() {
  const opcoes = lerArgumentos(process.argv.slice(2));
  const fonte = await readFile(ARQUIVO, 'utf8');

  if (opcoes.ajuda) {
    console.log(await readFile(fileURLToPath(import.meta.url), 'utf8').then((texto) => texto.split('\n').slice(1, 30).join('\n')));
    return;
  }
  if (opcoes.mostrar) {
    mostrar(fonte);
    return;
  }
  if (opcoes.limpar) {
    await writeFile(ARQUIVO, gravar(fonte, '', []), 'utf8');
    console.log('Origem e chaves apagadas: a build volta a não ter de onde atualizar.');
    return;
  }

  const origem = origemAceitavel(opcoes.origin);
  if (!origem) {
    erro(opcoes.origin
      ? `Origem inválida (${opcoes.origin}): use https, ou http apenas em localhost.`
      : 'Falta --origin. Use --mostrar para ver o que está gravado.');
  }
  if (!opcoes.keys) erro('Falta --keys: o documento de chaves públicas que esta build vai confiar.');
  const chaves = await lerChaves(opcoes.keys);

  await writeFile(ARQUIVO, gravar(fonte, origem, chaves), 'utf8');
  console.log(`Origem gravada na build: ${origem}`);
  for (const chave of chaves) console.log(`  confia em ${chave.keyId}  [${chave.scope.join(', ')}]`);
  console.log('\nEsta build passa a buscar atualização só nesse endereço, e só aceita');
  console.log('documento assinado por essas chaves. Nenhum servidor muda isso.');
}

principal().catch((causa) => erro(causa.stack ?? String(causa)));

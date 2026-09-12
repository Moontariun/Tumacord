#!/usr/bin/env node
// O publicador: onde uma versão vira uma release assinada.
//
// Ele roda no **ambiente de publicação**, e nunca na VPS. A diferença não é de
// conveniência: a chave privada que assina os binários vive aqui, e a VPS
// guarda e serve o que já chegou assinado sem saber assinar nada. Comprometer
// a VPS não dá a ninguém a capacidade de entregar um binário como oficial.
//
// O que ele produz:
//
//   · **manifesto** — o que é aquela versão e quais pacotes ela tem, com
//     tamanho, SHA-256 e o caminho dentro do armazenamento privado;
//   · **catálogo** — o que está publicado agora, por canal, com sequência
//     própria e validade;
//   · o documento de **chaves públicas** que a VPS registra para poder
//     conferir os dois.
//
// O que ele **não** faz: não fala com o GitHub, não sobe bytes sozinho e não
// publica nada. Ele escreve arquivos; quem os leva para a VPS é o operador,
// pelo `tumacordctl`. Separar isso mantém a publicação como um ato deliberado.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { copyFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { buildManifest, notesFromChangelog, scanPackages } from './lib/packages.mjs';
import { emptyCatalog, validateNext, withRelease, withWithdrawal } from './lib/catalog.mjs';

const require_ = createRequire(import.meta.url);
const { CONTRACT_VERSION } = require_('../../desktop/distribution.generated.cjs');
const { documentDigest, generateSigningKey, signDocument } = require_('../../desktop/distribution-crypto.generated.cjs');
const { requireVersion } = require_('../../desktop/version.generated.cjs');

const TOOL_VERSION = '0.9.9-1';

/** Quanto tempo um catálogo vale. Curto o bastante para uma retirada alcançar. */
const CATALOG_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const HELP = `tumacord-publish ${TOOL_VERSION} — produzir uma release assinada

USO
  node tools/publisher/publish.mjs <comando> [opções]

COMANDOS
  keys generate --dir <pasta>
        Gera os dois pares de chaves: um para assinar manifestos (os binários) e
        outro para assinar o catálogo (o que está publicado e o que foi
        retirado). São duas de propósito — uma chave de catálogo comprometida
        esconde uma versão boa; uma de manifesto entrega código.

  keys trusted --dir <pasta> [--out <arquivo>]
        Escreve o documento de chaves PÚBLICAS para a VPS registrar. Nada de
        privado sai desta pasta.

  manifest --version <x.y.z[-n]> --commit <sha> --packages <pasta> --dir <pasta>
           [--channel stable|test] [--changelog CHANGELOG.md] [--out <arquivo>]
        Lê a pasta de build, confere cada pacote e assina o manifesto.

  catalog --manifest <arquivo> --dir <pasta> [--channel stable|test] [--out <arquivo>]
        Publica a versão daquele manifesto no catálogo e o assina.

  withdraw --release <releaseId> --reason "<motivo>" --dir <pasta>
           [--channel stable|test] [--out <arquivo>]
        Retira uma versão. Ela para de ser oferecida e de poder ser baixada,
        inclusive por quem já estava na rua.

  state import --from <arquivo> --dir <pasta>
        Recupera o estado do catálogo a partir do que está publicado na VPS
        (\`curl .../admin/catalog\`). Use quando a pasta de publicação for
        perdida — publicar às cegas produziria uma sequência que anda para trás.

OPÇÕES GERAIS
  --dir <pasta>   Onde moram as chaves e o estado do catálogo.
                  Padrão: ~/.tumacord-publicacao
  --help          Esta ajuda. Vale também por comando.

ONDE ESTÁ DOCUMENTADO
  Publicação privada ....... docs/publicacao-privada.md
  Versionamento ............ docs/versionamento.md
`;

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) { positionals.push(raw); continue; }
    const name = raw.slice(2);
    if (name === 'help') { options.help = true; continue; }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) { options[name] = true; continue; }
    options[name] = next;
    index += 1;
  }
  return { positionals, options };
}

function publishDir(options) {
  const raw = typeof options.dir === 'string' ? options.dir : path.join(process.env.HOME ?? '.', '.tumacord-publicacao');
  return path.resolve(raw);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value, mode = 0o600) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  return filePath;
}

/** As chaves de publicação, lidas da pasta. */
async function loadKeys(directory) {
  const load = async (name) => {
    try {
      return await readJson(path.join(directory, `${name}.json`));
    } catch {
      throw new Error(`Não achei a chave de ${name} em ${directory}. Gere as chaves com \`keys generate --dir ${directory}\`.`);
    }
  };
  return { manifest: await load('manifest'), catalog: await load('catalog') };
}

const statePath = (directory) => path.join(directory, 'catalog-state.json');

async function loadCatalogState(directory) {
  try {
    return await readJson(statePath(directory));
  } catch {
    // Primeira publicação: um catálogo vazio, na sequência zero.
    return emptyCatalog({ contract: CONTRACT_VERSION, ttlMs: CATALOG_TTL_MS });
  }
}

// ── Comandos ────────────────────────────────────────────────────────────────

async function keysCommand(positionals, options) {
  const sub = positionals[0] ?? '';
  const directory = publishDir(options);

  if (sub === 'generate') {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const created = [];
    for (const scope of ['manifest', 'catalog']) {
      const target = path.join(directory, `${scope}.json`);
      try {
        await readFile(target);
        // Sobrescrever uma chave em uso invalidaria tudo o que ela assinou, e
        // não há como desfazer isso.
        console.error(`Já existe uma chave de ${scope} em ${target}. Apague-a à mão se a intenção é mesmo trocá-la — e leia a rotação em docs/publicacao-privada.md antes.`);
        return 1;
      } catch { /* não existe, que é o esperado */ }
      const key = generateSigningKey();
      await writeJson(target, key);
      created.push({ scope, keyId: key.keyId });
    }
    console.log(`Chaves geradas em ${directory} (modo 600):\n`);
    for (const { scope, keyId } of created) console.log(`  ${scope.padEnd(9)} keyId ${keyId}`);
    console.log('\nA parte PRIVADA não sai desta pasta, e ela faz parte do backup fora da máquina:');
    console.log('sem ela não se publica mais nada, nem uma correção.');
    console.log(`\nRegistre as públicas na VPS: \`keys trusted --dir ${directory}\``);
    return 0;
  }

  if (sub === 'trusted') {
    const keys = await loadKeys(directory);
    const document = {
      keys: [
        { keyId: keys.manifest.keyId, algorithm: keys.manifest.algorithm, publicKey: keys.manifest.publicKey, scope: ['manifest'] },
        { keyId: keys.catalog.keyId, algorithm: keys.catalog.algorithm, publicKey: keys.catalog.publicKey, scope: ['catalog'] },
      ],
    };
    // Uma conferência que custa nada e evita o pior erro possível.
    const text = JSON.stringify(document);
    if (text.includes(keys.manifest.privateKey) || text.includes(keys.catalog.privateKey)) {
      console.error('ABORTADO: o documento de chaves públicas continha uma chave privada.');
      return 1;
    }
    const out = typeof options.out === 'string' ? path.resolve(options.out) : '';
    if (out) {
      await writeJson(out, document, 0o644);
      console.log(`Chaves públicas em ${out}. Registre na VPS com:`);
      console.log(`  curl -fsS -X POST http://127.0.0.1:4301/admin/keys -H 'content-type: application/json' -d @${out}`);
    } else {
      console.log(JSON.stringify(document, null, 2));
    }
    return 0;
  }

  console.error(`Subcomando desconhecido: ${sub || '(nenhum)'}. Use generate ou trusted.`);
  return 1;
}

async function manifestCommand(options) {
  const directory = publishDir(options);
  const channel = options.channel === 'test' ? 'test' : 'stable';

  if (typeof options.version !== 'string') { console.error('Informe --version <x.y.z[-n]>.'); return 1; }
  if (typeof options.commit !== 'string' || !/^[0-9a-f]{7,40}$/i.test(options.commit)) {
    console.error('Informe --commit <sha>: é o commit exato de onde esta release saiu, e ele é conferido depois no `/api/health` do servidor.');
    return 1;
  }
  if (typeof options.packages !== 'string') { console.error('Informe --packages <pasta>: a pasta de build, normalmente `release/`.'); return 1; }

  // A versão passa pela convenção do produto antes de qualquer outra coisa:
  // publicar sob uma etiqueta que o aplicativo não sabe ordenar produz uma
  // versão que ninguém recebe.
  let version;
  try {
    version = requireVersion(options.version).text;
  } catch (error) {
    console.error(String(error?.message ?? error));
    console.error('A convenção está em docs/versionamento.md.');
    return 1;
  }

  const keys = await loadKeys(directory);
  const found = await scanPackages(path.resolve(options.packages), version);

  if (found.ambiguous.length) {
    console.error('Publicação PARADA: a pasta de pacotes está ambígua.\n');
    for (const item of found.ambiguous) {
      console.error(`  ${item.installKind}: ${item.files.join(', ')}${item.reason ? ` (${item.reason})` : ''}`);
    }
    console.error('\nEscolher entre eles seria adivinhar, e o erro apareceria na máquina de quem instalou.');
    return 1;
  }
  if (!found.artifacts.length) {
    console.error(`Nenhum pacote da ${version} em ${options.packages}. Os nomes esperados vêm do \`artifactName\` do package.json.`);
    return 1;
  }

  const { title, notes } = await notesFromChangelog(
    path.resolve(typeof options.changelog === 'string' ? options.changelog : 'CHANGELOG.md'),
    version,
  );

  const manifest = buildManifest({
    version, commit: options.commit.toLowerCase(), channel,
    artifacts: found.artifacts, title, notes,
    keyId: keys.manifest.keyId, contract: CONTRACT_VERSION,
  });
  const signed = signDocument(manifest, [keys.manifest]);

  const out = path.resolve(typeof options.out === 'string' ? options.out : path.join(directory, `manifest-${version}.json`));
  await writeJson(out, signed, 0o644);

  console.log(`Manifesto da ${version} assinado em ${out}\n`);
  console.log(`  release   ${manifest.releaseId}`);
  console.log(`  commit    ${manifest.commit}`);
  console.log(`  canal     ${channel}`);
  for (const artifact of manifest.artifacts) {
    console.log(`  pacote    ${artifact.installKind.padEnd(18)} ${artifact.fileName} (${artifact.size} B)`);
  }
  if (found.missing.length) {
    // Faltar um formato é legítimo — nem toda release tem pacote de Windows —,
    // mas precisa ser uma decisão, e não uma surpresa.
    console.log(`\n  SEM PACOTE para: ${found.missing.join(', ')}`);
    console.log('  Quem estiver nesses formatos verá a versão anunciada e sem botão de aplicar.');
  }
  console.log('\nOs bytes precisam ir para o armazenamento da VPS, sob:');
  console.log(`  releases/${version}/`);
  return 0;
}

async function catalogCommand(options) {
  const directory = publishDir(options);
  const channel = options.channel === 'test' ? 'test' : 'stable';
  if (typeof options.manifest !== 'string') { console.error('Informe --manifest <arquivo.json>: o manifesto já assinado.'); return 1; }

  const keys = await loadKeys(directory);
  const signedManifest = await readJson(path.resolve(options.manifest));
  const manifest = signedManifest.payload;
  if (!manifest?.releaseId) { console.error('Esse arquivo não parece um manifesto assinado.'); return 1; }

  const current = await loadCatalogState(directory);
  let next;
  try {
    next = withRelease(current, {
      manifest,
      // O resumo do manifesto entra no catálogo: sem ele, um serviço poderia
      // servir o manifesto assinado de **outra** versão — os dois autênticos,
      // e o par errado.
      manifestSha256: documentDigest(manifest),
      channel,
      ttlMs: CATALOG_TTL_MS,
    });
  } catch (error) {
    console.error(String(error?.message ?? error));
    return 1;
  }

  const problem = validateNext(next, current);
  if (problem) { console.error(problem); return 1; }

  const signed = signDocument(next, [keys.catalog]);
  const out = path.resolve(typeof options.out === 'string' ? options.out : path.join(directory, `catalog-${next.sequence}.json`));
  await writeJson(out, signed, 0o644);
  // O estado só avança depois de o documento existir em disco.
  await writeJson(statePath(directory), next);

  console.log(`Catálogo assinado em ${out}\n`);
  console.log(`  sequência ${current.sequence} → ${next.sequence}`);
  console.log(`  vale até  ${next.expiresAt}`);
  for (const entry of next.channels[channel].entries) {
    console.log(`  ${entry.state === 'withdrawn' ? '×' : '·'} ${entry.version.padEnd(12)} ${entry.releaseId}`);
  }
  console.log('\nPublique na VPS com:');
  console.log(`  node tools/tumacordctl/tumacordctl.mjs releases publish --catalog ${out}`);
  console.log('\nO catálogo é o que muda o que os aplicativos veem. Instale a versão em');
  console.log('algum lugar antes de promover no canal estável.');
  return 0;
}

async function withdrawCommand(options) {
  const directory = publishDir(options);
  const channel = options.channel === 'test' ? 'test' : 'stable';
  if (typeof options.release !== 'string') { console.error('Informe --release <releaseId>.'); return 1; }
  if (typeof options.reason !== 'string' || !options.reason.trim()) {
    console.error('Informe --reason "<motivo>": ele aparece na tela de quem tentar instalar.');
    return 1;
  }

  const keys = await loadKeys(directory);
  const current = await loadCatalogState(directory);
  let next;
  try {
    next = withWithdrawal(current, { releaseId: options.release, reason: options.reason, channel, ttlMs: CATALOG_TTL_MS });
  } catch (error) {
    console.error(String(error?.message ?? error));
    return 1;
  }

  const signed = signDocument(next, [keys.catalog]);
  const out = path.resolve(typeof options.out === 'string' ? options.out : path.join(directory, `catalog-${next.sequence}.json`));
  await writeJson(out, signed, 0o644);
  await writeJson(statePath(directory), next);

  console.log(`Retirada assinada em ${out}\n`);
  console.log(`  release   ${options.release}`);
  console.log(`  motivo    ${options.reason.trim()}`);
  console.log(`  sequência ${current.sequence} → ${next.sequence}`);
  console.log('\nA partir da publicação:');
  console.log('  · o aplicativo deixa de oferecer essa versão e diz o motivo;');
  console.log('  · downloads novos dela são recusados, inclusive de quem tem o endereço;');
  console.log('  · quem já baixou continua com o arquivo — retirar não apaga disco de ninguém.');
  console.log(`\nPublique com:\n  node tools/tumacordctl/tumacordctl.mjs releases publish --catalog ${out}`);
  return 0;
}

async function stateCommand(positionals, options) {
  const sub = positionals[0] ?? '';
  const directory = publishDir(options);
  if (sub !== 'import') { console.error(`Subcomando desconhecido: ${sub || '(nenhum)'}. Use \`state import\`.`); return 1; }
  if (typeof options.from !== 'string') {
    console.error('Informe --from <arquivo.json>: o catálogo publicado, obtido na VPS com');
    console.error('  curl -fsS http://127.0.0.1:4301/admin/catalog > catalogo-publicado.json');
    return 1;
  }
  const signed = await readJson(path.resolve(options.from));
  const catalog = signed?.payload ?? signed;
  if (!catalog || !Number.isSafeInteger(catalog.sequence)) {
    console.error('Esse arquivo não parece um catálogo.');
    return 1;
  }
  const current = await loadCatalogState(directory);
  if (catalog.sequence < current.sequence) {
    // Importar um catálogo mais antigo do que o estado local faria a próxima
    // publicação andar para trás — e ela seria recusada pelo serviço e pelos
    // clientes, depois de já ter sido assinada.
    console.error(`O estado local está na sequência ${current.sequence} e esse catálogo está na ${catalog.sequence}.`);
    console.error('Importar andaria para trás. Confira se o arquivo é mesmo o que está publicado.');
    return 1;
  }
  await writeJson(statePath(directory), catalog);
  console.log(`Estado do catálogo importado: sequência ${catalog.sequence}.`);
  return 0;
}

async function main(argv) {
  const { positionals, options } = parseArgs(argv);
  const command = positionals[0] ?? '';
  const rest = positionals.slice(1);

  if (options.help || !command) { console.log(HELP); return options.help ? 0 : 1; }

  try {
    switch (command) {
      case 'keys': return await keysCommand(rest, options);
      case 'manifest': return await manifestCommand(options);
      case 'catalog': return await catalogCommand(options);
      case 'withdraw': return await withdrawCommand(options);
      case 'state': return await stateCommand(rest, options);
      case 'version': console.log(TOOL_VERSION); return 0;
      default:
        console.error(`Comando desconhecido: ${command}\n`);
        console.log(HELP);
        return 1;
    }
  } catch (error) {
    console.error(String(error?.message ?? error));
    return 1;
  }
}

export { CATALOG_TTL_MS, HELP, main, parseArgs, publishDir };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

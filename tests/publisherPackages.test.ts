import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildManifest, matchArtifacts, notesFromChangelog, patternsFor, scanPackages, sha256OfFile } from '../tools/publisher/lib/packages.mjs';
import { emptyCatalog, validateNext, withRelease, withWithdrawal } from '../tools/publisher/lib/catalog.mjs';
import { CONTRACT_VERSION } from '../shared/distribution';

// O reconhecimento dos pacotes e a montagem do catálogo, sem serviço e sem
// rede. É aqui que mora a regra que mais evita estrago: **nada de "o primeiro
// arquivo com nome parecido"**. Um erro nessa escolha não aparece na
// publicação — aparece na máquina de quem instalou, como um instalador do
// Windows entregue a uma cópia de Linux.

async function comPasta(corpo: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), 'tumacord-pacotes-'));
  try {
    await corpo(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const NOMES = [
  'tumacord-0.9.10.tar.gz',
  'Tumacord-0.9.10.AppImage',
  'Tumacord-0.9.10-Setup.exe',
  'Tumacord-0.9.10-portable.exe',
];

async function escrever(dir: string, nomes: string[], tamanho = 1024): Promise<void> {
  for (const nome of nomes) await writeFile(path.join(dir, nome), Buffer.alloc(tamanho, 7));
}

// ── Reconhecimento ─────────────────────────────────────────────────────────

test('cada jeito de instalar tem um padrão exato', () => {
  const kinds = patternsFor('0.9.10').map((spec) => spec.installKind).sort();
  assert.deepEqual(kinds, ['linux-appimage', 'linux-managed', 'windows-installed', 'windows-portable']);
  // O padrão inclui a versão: uma pasta de build com o pacote da versão
  // anterior não pode contribuir com ele para esta release.
  const [tar] = patternsFor('0.9.10').filter((spec) => spec.installKind === 'linux-managed');
  assert.equal(tar.pattern.test('tumacord-0.9.10.tar.gz'), true);
  assert.equal(tar.pattern.test('tumacord-0.9.9.tar.gz'), false);
  assert.equal(tar.pattern.test('tumacord-0.9.10-1.tar.gz'), false);
});

test('uma pasta completa produz os quatro pacotes, com resumo e tamanho', async () => {
  await comPasta(async (dir) => {
    await escrever(dir, NOMES, 2048);
    const { artifacts, missing, ambiguous } = await scanPackages(dir, '0.9.10');
    assert.deepEqual(ambiguous, []);
    assert.deepEqual(missing, []);
    assert.equal(artifacts.length, 4);
    for (const artifact of artifacts) {
      assert.match(artifact.sha256, /^[0-9a-f]{64}$/);
      assert.equal(artifact.size, 2048);
      // O caminho é relativo ao armazenamento privado, e nunca uma URL.
      assert.equal(artifact.storagePath, `releases/0.9.10/${artifact.fileName}`);
      assert.equal(artifact.storagePath.includes('://'), false);
    }
  });
});

// Com os padrões de hoje — exatos, ancorados — dois nomes não casam com o
// mesmo alvo, e num diretório os nomes são únicos. A defesa existe para o dia
// em que um padrão ganhar um sufixo de arquitetura: é ela que impede a escolha
// de virar sorteio. Ela é exercida aqui pela lista de nomes, que é o que
// `scanPackages` passa adiante.
test('dois nomes para o mesmo alvo param a publicação, em vez de virar sorteio', () => {
  const comDuplicata = ['tumacord-0.9.10.tar.gz', 'tumacord-0.9.10.tar.gz'];
  const resultado = matchArtifacts(comDuplicata, '0.9.10');
  assert.equal(resultado.ambiguous.length, 1);
  assert.equal(resultado.ambiguous[0].installKind, 'linux-managed');
  assert.deepEqual(resultado.ambiguous[0].files, comDuplicata);
  // E o alvo ambíguo **não** entra nos escolhidos: nada é publicado dele.
  assert.equal(resultado.chosen.some((item: { spec: { installKind: string } }) => item.spec.installKind === 'linux-managed'), false);
});

test('a lista de nomes decide igual ao disco', () => {
  const resultado = matchArtifacts(NOMES, '0.9.10');
  assert.deepEqual(resultado.ambiguous, []);
  assert.deepEqual(resultado.missing, []);
  assert.equal(resultado.chosen.length, 4);
  // Nomes de outra versão e lixo da pasta não entram.
  const sujo = matchArtifacts([...NOMES, 'tumacord-0.9.9.tar.gz', 'latest.yml', 'builder-debug.yml'], '0.9.10');
  assert.equal(sujo.chosen.length, 4);
  assert.deepEqual(sujo.ambiguous, []);
});

test('um pacote vazio não vira artefato: ele vira ambiguidade dita', async () => {
  await comPasta(async (dir) => {
    await escrever(dir, NOMES);
    await writeFile(path.join(dir, 'tumacord-0.9.10.tar.gz'), Buffer.alloc(0));
    const { artifacts, ambiguous } = await scanPackages(dir, '0.9.10');
    assert.equal(artifacts.length, 3);
    assert.equal(ambiguous.length, 1);
    assert.equal(ambiguous[0].installKind, 'linux-managed');
    assert.match(ambiguous[0].reason ?? '', /vazio/);
  });
});

test('faltar um formato é dito, e não vira surpresa', async () => {
  await comPasta(async (dir) => {
    // Uma build só de Linux é legítima — mas precisa ser uma decisão.
    await escrever(dir, NOMES.filter((nome) => !nome.endsWith('.exe')));
    const { artifacts, missing } = await scanPackages(dir, '0.9.10');
    assert.equal(artifacts.length, 2);
    assert.deepEqual(missing.sort(), ['windows-installed', 'windows-portable']);
  });
});

test('o pacote da versão anterior na mesma pasta não entra nesta release', async () => {
  await comPasta(async (dir) => {
    await escrever(dir, ['tumacord-0.9.9.tar.gz', 'Tumacord-0.9.9-Setup.exe']);
    const { artifacts, missing } = await scanPackages(dir, '0.9.10');
    assert.equal(artifacts.length, 0);
    assert.equal(missing.length, 4);
  });
});

test('uma pasta que não existe falha dizendo qual', async () => {
  await assert.rejects(() => scanPackages('/caminho/que/nao/existe', '0.9.10'), /pasta de pacotes/);
});

test('o resumo é o do conteúdo, e dois conteúdos diferentes não colidem', async () => {
  await comPasta(async (dir) => {
    const a = path.join(dir, 'a.bin');
    const b = path.join(dir, 'b.bin');
    await writeFile(a, Buffer.alloc(4096, 1));
    await writeFile(b, Buffer.alloc(4096, 2));
    const [resumoA, resumoB] = [await sha256OfFile(a), await sha256OfFile(b)];
    assert.match(resumoA, /^[0-9a-f]{64}$/);
    assert.notEqual(resumoA, resumoB);
    assert.equal(await sha256OfFile(a), resumoA, 'o mesmo conteúdo dá o mesmo resumo');
  });
});

// ── Manifesto ──────────────────────────────────────────────────────────────

test('o manifesto não carrega o caminho local dos arquivos', async () => {
  await comPasta(async (dir) => {
    await escrever(dir, NOMES);
    const { artifacts } = await scanPackages(dir, '0.9.10');
    const manifest = buildManifest({
      version: '0.9.10', commit: 'a'.repeat(40), channel: 'stable',
      artifacts, keyId: 'chave-1', contract: CONTRACT_VERSION,
    });
    const texto = JSON.stringify(manifest);
    // O caminho da máquina de quem publicou não interessa a ninguém, e ele
    // revelaria a estrutura de pastas dessa máquina a quem baixar.
    assert.equal(texto.includes(dir), false);
    assert.equal(texto.includes('sourcePath'), false);
    assert.equal(manifest.releaseId, 'rel_stable_0-9-10');
    for (const artifact of manifest.artifacts) assert.equal(artifact.signatureKeyId, 'chave-1');
  });
});

test('as notas saem do CHANGELOG, e só a seção da versão', async () => {
  await comPasta(async (dir) => {
    const changelog = path.join(dir, 'CHANGELOG.md');
    await writeFile(changelog, [
      '# Histórico de versões', '',
      '## 0.9.10 — a próxima', '', '<!-- tumacord:resumo -->', 'Uma coisa mudou.', '',
      '## 0.9.9 — a de antes', '', 'Outra coisa, que não é desta versão.', '',
    ].join('\n'));

    const { title, notes } = await notesFromChangelog(changelog, '0.9.10');
    assert.equal(title, 'Tumacord 0.9.10 — a próxima');
    assert.match(notes, /Uma coisa mudou/);
    assert.equal(notes.includes('não é desta versão'), false, 'a seção seguinte não entra');
    // Os comentários saem: eles são recado para quem escreve o CHANGELOG.
    assert.equal(notes.includes('tumacord:resumo'), false);
  });
});

test('sem seção no CHANGELOG, não há notas inventadas', async () => {
  await comPasta(async (dir) => {
    const changelog = path.join(dir, 'CHANGELOG.md');
    await writeFile(changelog, '# Histórico de versões\n\n## 0.9.9 — a de antes\n\nCoisa.\n');
    assert.deepEqual(await notesFromChangelog(changelog, '0.9.10'), { title: '', notes: '' });
    assert.deepEqual(await notesFromChangelog('/nao/existe.md', '0.9.10'), { title: '', notes: '' });
  });
});

// ── Catálogo ───────────────────────────────────────────────────────────────

const TTL = 7 * 24 * 60 * 60 * 1000;
const agora = Date.parse('2026-09-20T12:00:00.000Z');

const manifesto = (version: string, releaseId = `rel_stable_${version.replace(/[^0-9a-z]/gi, '-')}`) => ({
  contract: CONTRACT_VERSION, releaseId, version, channel: 'stable' as const,
  commit: '0'.repeat(40), createdAt: new Date(agora).toISOString(), artifacts: [],
});

test('a primeira publicação parte da sequência zero e vai para um', () => {
  const vazio = emptyCatalog({ contract: CONTRACT_VERSION, now: agora, ttlMs: TTL });
  assert.equal(vazio.sequence, 0);
  const proximo = withRelease(vazio, { manifest: manifesto('0.9.10'), manifestSha256: 'a'.repeat(64), channel: 'stable', now: agora, ttlMs: TTL });
  assert.equal(proximo.sequence, 1);
  assert.equal(proximo.channels.stable.entries.length, 1);
  assert.equal(proximo.channels.stable.entries[0].state, 'published');
  assert.equal(proximo.channels.stable.entries[0].manifestSha256, 'a'.repeat(64));
});

test('republicar a mesma release sob o mesmo número é permitido', () => {
  // É o que acontece ao renovar a validade do catálogo.
  const primeiro = withRelease(emptyCatalog({ contract: CONTRACT_VERSION, now: agora, ttlMs: TTL }), {
    manifest: manifesto('0.9.10'), manifestSha256: 'a'.repeat(64), channel: 'stable', now: agora, ttlMs: TTL,
  });
  const segundo = withRelease(primeiro, {
    manifest: manifesto('0.9.10'), manifestSha256: 'a'.repeat(64), channel: 'stable', now: agora + 1000, ttlMs: TTL,
  });
  assert.equal(segundo.sequence, 2);
  assert.equal(segundo.channels.stable.entries.length, 1);
  // A data da primeira publicação é preservada: ela é quando a versão saiu.
  assert.equal(segundo.channels.stable.entries[0].publishedAt, primeiro.channels.stable.entries[0].publishedAt);
});

test('o mesmo número apontando para outra release é recusado', () => {
  const primeiro = withRelease(emptyCatalog({ contract: CONTRACT_VERSION, now: agora, ttlMs: TTL }), {
    manifest: manifesto('0.9.10'), manifestSha256: 'a'.repeat(64), channel: 'stable', now: agora, ttlMs: TTL,
  });
  assert.throws(
    () => withRelease(primeiro, { manifest: manifesto('0.9.10', 'rel_stable_outra'), manifestSha256: 'b'.repeat(64), channel: 'stable', now: agora, ttlMs: TTL }),
    /não volta a ser usado para conteúdo diferente/,
  );
});

test('retirar aumenta a sequência sem oferecer nada novo', () => {
  const publicado = withRelease(emptyCatalog({ contract: CONTRACT_VERSION, now: agora, ttlMs: TTL }), {
    manifest: manifesto('0.9.10'), manifestSha256: 'a'.repeat(64), channel: 'stable', now: agora, ttlMs: TTL,
  });
  const retirado = withWithdrawal(publicado, { releaseId: 'rel_stable_0-9-10', reason: 'o áudio sai errado', channel: 'stable', now: agora, ttlMs: TTL });
  assert.equal(retirado.sequence, publicado.sequence + 1);
  assert.equal(retirado.channels.stable.entries[0].state, 'withdrawn');
  assert.equal(retirado.channels.stable.entries[0].withdrawn?.reason, 'o áudio sai errado');
  // A entrada continua na lista, dita. Sumir faria quem conferisse concluir
  // que o aplicativo está atrasado.
  assert.equal(retirado.channels.stable.entries.length, 1);
});

test('uma retirada sem motivo é recusada', () => {
  const publicado = withRelease(emptyCatalog({ contract: CONTRACT_VERSION, now: agora, ttlMs: TTL }), {
    manifest: manifesto('0.9.10'), manifestSha256: 'a'.repeat(64), channel: 'stable', now: agora, ttlMs: TTL,
  });
  // O motivo aparece na tela de quem tentar instalar. Sem ele, a pessoa vê uma
  // versão sumir e não sabe se o problema é dela.
  assert.throws(() => withWithdrawal(publicado, { releaseId: 'rel_stable_0-9-10', reason: '  ', channel: 'stable', now: agora, ttlMs: TTL }), /motivo/);
});

test('retirar o que não está publicado é recusado', () => {
  const vazio = emptyCatalog({ contract: CONTRACT_VERSION, now: agora, ttlMs: TTL });
  assert.throws(() => withWithdrawal(vazio, { releaseId: 'rel_stable_0-9-10', reason: 'x', channel: 'stable', now: agora, ttlMs: TTL }), /não está publicada/);
});

test('a validação recusa sequência que não cresce e versão duplicada', () => {
  const atual = { ...emptyCatalog({ contract: CONTRACT_VERSION, now: agora, ttlMs: TTL }), sequence: 5 };
  assert.match(validateNext({ ...atual, sequence: 5 }, atual), /precisa crescer/);
  assert.match(validateNext({ ...atual, sequence: 4 }, atual), /precisa crescer/);
  assert.equal(validateNext({ ...atual, sequence: 6 }, atual), '');

  const duplicado = {
    ...atual, sequence: 6,
    channels: {
      stable: { entries: [
        { releaseId: 'a', version: '0.9.10', state: 'published', publishedAt: '', manifestSha256: '' },
        { releaseId: 'b', version: '0.9.10', state: 'published', publishedAt: '', manifestSha256: '' },
      ] },
      test: { entries: [] },
    },
  };
  assert.match(validateNext(duplicado, atual), /duas vezes/);
});

test('uma parada obrigatória do manifesto entra na entrada do catálogo', () => {
  const comParada = { ...manifesto('0.9.10'), requiredStop: { reason: 'ela converte os dados do formato anterior' } };
  const proximo = withRelease(emptyCatalog({ contract: CONTRACT_VERSION, now: agora, ttlMs: TTL }), {
    manifest: comParada, manifestSha256: 'a'.repeat(64), channel: 'stable', now: agora, ttlMs: TTL,
  });
  assert.deepEqual(proximo.channels.stable.entries[0].requiredStop, { reason: 'ela converte os dados do formato anterior' });
});

test('os canais são independentes', () => {
  const noTeste = withRelease(emptyCatalog({ contract: CONTRACT_VERSION, now: agora, ttlMs: TTL }), {
    manifest: { ...manifesto('0.9.11'), channel: 'test' as never }, manifestSha256: 'c'.repeat(64), channel: 'test', now: agora, ttlMs: TTL,
  });
  assert.equal(noTeste.channels.test.entries.length, 1);
  assert.equal(noTeste.channels.stable.entries.length, 0, 'publicar no ensaio não mexe no estável');
});

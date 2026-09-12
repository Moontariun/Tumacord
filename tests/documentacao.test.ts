import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// A documentação como critério de aceite.
//
// O relato que originou esta revisão foi ter de improvisar comandos por causa
// de inconsistências do guia: um link para um arquivo que não existe, um
// comando que aponta para a versão anterior, uma variável citada que ninguém
// consome. Nada disso aparece numa revisão por leitura — aparece na hora em
// que alguém segue o guia.
//
// Estes casos conferem o que dá para conferir por máquina. Eles **não**
// substituem o ensaio dos procedimentos, que está registrado em docs/QA.md.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(repoRoot, 'docs');

function markdownFiles(): string[] {
  const found = [path.join(repoRoot, 'README.md'), path.join(repoRoot, 'ARCHITECTURE.md')];
  for (const name of readdirSync(docs)) {
    if (name.endsWith('.md')) found.push(path.join(docs, name));
  }
  return found.filter((filePath) => existsSync(filePath));
}

const documents = markdownFiles().map((filePath) => ({
  filePath: filePath,
  // Sempre com barra: no Windows o separador é a barra invertida, e as
  // conferências abaixo reconhecem os relatórios históricos por `docs/`.
  relative: path.relative(repoRoot, filePath).split(path.sep).join('/'),
  text: readFileSync(filePath, 'utf8'),
}));

/** Todo arquivo do projeto que pode consumir uma variável de ambiente. */
function readSources(): string[] {
  const texts: string[] = [];
  const folders = ['server', 'services', 'scripts', 'tools', 'packaging', 'desktop'];
  const extensions = /\.(ts|tsx|cjs|mjs|js|sh|ps1|yml|yaml|service|conf)$/;
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (extensions.test(entry.name)) texts.push(readFileSync(fullPath, 'utf8'));
    }
  };
  for (const folder of folders) {
    const fullPath = path.join(repoRoot, folder);
    if (existsSync(fullPath)) visit(fullPath);
  }
  for (const file of ['docker-compose.yml', 'Dockerfile', 'Dockerfile.updates']) {
    const fullPath = path.join(repoRoot, file);
    if (existsSync(fullPath)) texts.push(readFileSync(fullPath, 'utf8'));
  }
  return texts;
}

test('há documentos para conferir', () => {
  assert.ok(documents.length >= 6, `só encontrei ${documents.length} documentos`);
});

// ── Links internos ─────────────────────────────────────────────────────────

test('todo link markdown local aponta para um arquivo que existe', () => {
  const broken: string[] = [];
  for (const doc of documents) {
    for (const match of doc.text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const target = match[1];
      // Links externos e âncoras puras não são conferidos aqui.
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const withoutAnchor = target.split('#')[0];
      if (!withoutAnchor) continue;
      const resolved = path.resolve(path.dirname(doc.filePath), withoutAnchor);
      if (!existsSync(resolved)) broken.push(`${doc.relative} → ${target}`);
    }
  }
  assert.deepEqual(broken, [], `links para arquivos que não existem:\n  ${broken.join('\n  ')}`);
});

test('todo caminho de arquivo citado em crase existe', () => {
  // Só os que parecem caminho do projeto: com barra e extensão conhecida.
  const broken: string[] = [];
  for (const doc of documents) {
    const lines = doc.text.split('\n');
    for (const match of doc.text.matchAll(/`([a-zA-Z0-9_./-]+\/[a-zA-Z0-9_.-]+\.(ts|tsx|cjs|mjs|json|sh|ps1|yml|md|service|conf))`/g)) {
      const target = match[1];
      if (target.startsWith('http') || target.includes('<') || target.includes('$')) continue;
      // Exemplos genéricos e caminhos de dentro do contêiner não são do repo.
      if (/^(\/|node_modules|dist-|release\/|bundle\/|~|etc\/|var\/|tmp\/|opt\/)/.test(target)) continue;
      if (target.endsWith('.exemplo')) continue;
      if (existsSync(path.join(repoRoot, target))) continue;
      // Citar um arquivo que **deixou de existir**, dizendo que ele saiu, é
      // documentação correta — e é melhor do que apagar o parágrafo e deixar
      // quem procura pelo nome antigo sem resposta. O que não pode é citá-lo
      // como se ele ainda estivesse lá.
      const lineIndex = doc.text.slice(0, match.index).split('\n').length - 1;
      const surrounding = lines.slice(Math.max(0, lineIndex - 3), lineIndex + 4).join(' ');
      if (/\bsa[ií]ram?\b|removid|deixaram? de existir|não existe mais/i.test(surrounding)) continue;
      broken.push(`${doc.relative} cita ${target}`);
    }
  }
  assert.deepEqual(broken, [], `arquivos citados que não existem:\n  ${broken.join('\n  ')}`);
});

// ── Nada de versão desatualizada ───────────────────────────────────────────

test('nenhum documento manda instalar uma versão que não é a desta entrega', () => {
  const { version } = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { version: string };
  const wrong: string[] = [];
  for (const doc of documents) {
    // Um comando de instalação que aponta para a versão anterior é pior do que
    // um comando quebrado: ele funciona, e instala a coisa errada em silêncio.
    // Um relatório de época é evidência, e a evidência não é reescrita: ele
    // cita o comando da versão dele porque foi ele que rodou. O que ele
    // precisa é se identificar como histórico, e isso é conferido abaixo.
    if (/^docs\/(RELATORIO|AUDITORIA)-/.test(doc.relative)) continue;
    for (const match of doc.text.matchAll(/install-v(\d+\.\d+\.\d+(?:-\d+)?)\.sh/g)) {
      if (match[1] !== version) wrong.push(`${doc.relative}: install-v${match[1]}.sh`);
    }
  }
  assert.deepEqual(wrong, [], `instaladores de outra versão:\n  ${wrong.join('\n  ')}`);
});

// ── As variáveis citadas são consumidas de verdade ────────────────────────

test('toda variável do .env.example é consumida em algum lugar do código', () => {
  const example = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  const declared = [...new Set([...example.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((match) => match[1]))];
  assert.ok(declared.length > 0, 'o .env.example precisa declarar variáveis');

  // A varredura é do projeto inteiro, e não de uma lista escrita à mão: uma
  // lista incompleta faz o teste acusar variável órfã que na verdade tem dono.
  const sources = readSources().join('\n');

  const orphans = declared.filter((name) => !sources.includes(name));
  assert.deepEqual(orphans, [], `declaradas no .env.example e consumidas por ninguém:\n  ${orphans.join('\n  ')}`);
});

test('toda variável obrigatória do compose está no .env.example', () => {
  const compose = readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const example = readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
  // As que o compose exige com `:?` derrubam o `up` quando faltam.
  const required = [...new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]+):\?/g)].map((match) => match[1]))];
  const missing = required.filter((name) => !example.includes(name));
  assert.deepEqual(missing, [], `exigidas pelo compose e ausentes do .env.example:\n  ${missing.join('\n  ')}`);
});

// ── Serviços e portas citados batem com o compose ─────────────────────────

test('todo serviço citado nos guias existe no docker-compose.yml', () => {
  const compose = readFileSync(path.join(repoRoot, 'docker-compose.yml'), 'utf8');
  const services = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]);
  assert.ok(services.includes('tumacord-server'), 'o serviço do chat mudou de nome?');

  const cited = new Set<string>();
  for (const doc of documents) {
    for (const match of doc.text.matchAll(/docker compose[^\n`]*?\b(tumacord-[a-z-]+|coturn)\b/g)) {
      cited.add(match[1]);
    }
  }
  const nonexistent = [...cited].filter((name) => !services.includes(name));
  assert.deepEqual(nonexistent, [], `serviços citados que não existem no compose:\n  ${nonexistent.join('\n  ')}`);
});

// ── Todo comando prometido pela documentação existe ───────────────────────

test('todo `tumacordctl` citado nos guias existe de verdade', () => {
  // Um comando que a documentação promete e que não existe é a reclamação que
  // originou esta revisão. Agora que eles existem, a garantia inverte: cada
  // comando citado precisa ter rota no CLI.
  const cli = readFileSync(path.join(repoRoot, 'tools/tumacordctl/tumacordctl.mjs'), 'utf8');
  const missing: string[] = [];
  for (const doc of documents) {
    for (const match of doc.text.matchAll(/tumacordctl\s+([a-z]+)/g)) {
      const command = match[1];
      // `--help` e `version` são do próprio CLI; o resto precisa de case.
      if (command === 'version') continue;
      if (!cli.includes(`case '${command}':`)) missing.push(`${doc.relative}: tumacordctl ${command}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], 'comandos citados na documentação que o CLI não tem');
});

test('as opções citadas nos guias são opções que o CLI lê', () => {
  // `--projeto` em vez de `--project` não falha: o CLI ignora a opção
  // desconhecida e opera a instalação errada. Isso é pior do que um erro.
  const cli = readFileSync(path.join(repoRoot, 'tools/tumacordctl/tumacordctl.mjs'), 'utf8');
  const known = new Set(
    [...cli.matchAll(/options(?:\.([a-zA-Z]+)|\['([a-z-]+)'\])/g)].map((match) => match[1] ?? match[2]),
  );
  known.add('help');

  const unknownOptions: string[] = [];
  for (const doc of documents) {
    for (const line of doc.text.split('\n')) {
      if (!line.includes('tumacordctl')) continue;
      for (const match of line.matchAll(/--([a-z][a-z-]*)/g)) {
        if (!known.has(match[1])) unknownOptions.push(`${doc.relative}: --${match[1]}`);
      }
    }
  }
  assert.deepEqual([...new Set(unknownOptions)], [], 'opções citadas na documentação que o CLI não lê');
});

test('os campos de `install show --json` citados nos guias são os que ele produz', () => {
  // Um guia que lê `i.servicos[...]` de uma saída que traz `services` produz um
  // script que falha em silêncio, e o operador segue achando que tem o volume.
  const discovery = readFileSync(path.join(repoRoot, 'tools/tumacordctl/lib/discovery.mjs'), 'utf8');
  const absent: string[] = [];
  for (const doc of documents) {
    for (const line of doc.text.split('\n')) {
      if (!line.includes('install show') || !line.includes('--json')) continue;
      // As chaves usadas no trecho que consome a saída.
      for (const match of doc.text.matchAll(/\bi\.([a-zA-Z]+)|\bm\[0\]\.([a-zA-Z]+)|x\.([a-zA-Z]+)\s*===/g)) {
        const field = match[1] ?? match[2] ?? match[3];
        if (!discovery.includes(`${field}:`) && !discovery.includes(`${field},`)) absent.push(`${doc.relative}: ${field}`);
      }
    }
  }
  assert.deepEqual([...new Set(absent)], [], 'campos citados que a descoberta não produz');
});

// ── Nenhum segredo na documentação ────────────────────────────────────────

test('nenhum documento carrega um segredo de verdade', () => {
  const suspects: string[] = [];
  for (const doc of documents) {
    // Chave privada em qualquer formato.
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(doc.text)) suspects.push(`${doc.relative}: chave privada`);
    // Uma variável de segredo com valor literal preenchido.
    for (const match of doc.text.matchAll(/^(?:export )?(TUMACORD_SERVER_ACCESS_KEY|TUMACORD_TURN_SECRET)=(.+)$/gm)) {
      const value = match[2].trim();
      // Placeholder, substituição de comando e vazio são aceitáveis.
      if (/^["']?(\$|<|\.\.\.|$)/.test(value) || value === '""' || value === "''") continue;
      suspects.push(`${doc.relative}: ${match[1]} com valor literal`);
    }
  }
  assert.deepEqual(suspects, [], `possíveis segredos na documentação:\n  ${suspects.join('\n  ')}`);
});

// ── O README é a entrada única ────────────────────────────────────────────

test('o README aponta para os guias correntes', () => {
  const readme = readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  for (const guide of ['instalacao-vps', 'configuracao', 'atualizacao-servidor', 'backup-restore', 'publicacao-privada', 'versionamento', 'solucao-de-problemas']) {
    assert.ok(readme.includes(`docs/${guide}.md`), `o README não aponta para docs/${guide}.md`);
  }
});

test('documentos históricos se identificam como históricos', () => {
  // Preservar a evidência original é certo; apresentá-la como o guia atual
  // não é. Quem abre um relatório de 0.8.1 precisa saber que ele é de 0.8.1.
  for (const name of readdirSync(docs)) {
    if (!/^(RELATORIO|AUDITORIA)-/.test(name)) continue;
    const text = readFileSync(path.join(docs, name), 'utf8');
    assert.match(
      text.slice(0, 1200),
      /hist[óo]rico|documento de época|preservad|não .{0,20}guia atual/i,
      `${name} não se identifica como histórico logo no começo`,
    );
  }
});

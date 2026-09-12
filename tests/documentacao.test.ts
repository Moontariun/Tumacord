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

const raiz = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const docs = path.join(raiz, 'docs');

function arquivosMarkdown(): string[] {
  const encontrados = [path.join(raiz, 'README.md'), path.join(raiz, 'ARCHITECTURE.md')];
  for (const nome of readdirSync(docs)) {
    if (nome.endsWith('.md')) encontrados.push(path.join(docs, nome));
  }
  return encontrados.filter((caminho) => existsSync(caminho));
}

const documentos = arquivosMarkdown().map((caminho) => ({
  caminho,
  relativo: path.relative(raiz, caminho),
  texto: readFileSync(caminho, 'utf8'),
}));

/** Todo arquivo do projeto que pode consumir uma variável de ambiente. */
function lerFontes(): string[] {
  const textos: string[] = [];
  const pastas = ['server', 'services', 'scripts', 'tools', 'packaging', 'desktop'];
  const extensoes = /\.(ts|tsx|cjs|mjs|js|sh|ps1|yml|yaml|service|conf)$/;
  const visitar = (diretorio: string) => {
    for (const entrada of readdirSync(diretorio, { withFileTypes: true })) {
      if (entrada.name === 'node_modules' || entrada.name.startsWith('.')) continue;
      const completo = path.join(diretorio, entrada.name);
      if (entrada.isDirectory()) visitar(completo);
      else if (extensoes.test(entrada.name)) textos.push(readFileSync(completo, 'utf8'));
    }
  };
  for (const pasta of pastas) {
    const completo = path.join(raiz, pasta);
    if (existsSync(completo)) visitar(completo);
  }
  for (const arquivo of ['docker-compose.yml', 'Dockerfile', 'Dockerfile.atualizacoes']) {
    const completo = path.join(raiz, arquivo);
    if (existsSync(completo)) textos.push(readFileSync(completo, 'utf8'));
  }
  return textos;
}

test('há documentos para conferir', () => {
  assert.ok(documentos.length >= 6, `só encontrei ${documentos.length} documentos`);
});

// ── Links internos ─────────────────────────────────────────────────────────

test('todo link markdown local aponta para um arquivo que existe', () => {
  const quebrados: string[] = [];
  for (const documento of documentos) {
    for (const achado of documento.texto.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const alvo = achado[1];
      // Links externos e âncoras puras não são conferidos aqui.
      if (/^(https?:|mailto:|#)/.test(alvo)) continue;
      const semAncora = alvo.split('#')[0];
      if (!semAncora) continue;
      const resolvido = path.resolve(path.dirname(documento.caminho), semAncora);
      if (!existsSync(resolvido)) quebrados.push(`${documento.relativo} → ${alvo}`);
    }
  }
  assert.deepEqual(quebrados, [], `links para arquivos que não existem:\n  ${quebrados.join('\n  ')}`);
});

test('todo caminho de arquivo citado em crase existe', () => {
  // Só os que parecem caminho do projeto: com barra e extensão conhecida.
  const quebrados: string[] = [];
  for (const documento of documentos) {
    const linhas = documento.texto.split('\n');
    for (const achado of documento.texto.matchAll(/`([a-zA-Z0-9_./-]+\/[a-zA-Z0-9_.-]+\.(ts|tsx|cjs|mjs|json|sh|ps1|yml|md|service|conf))`/g)) {
      const alvo = achado[1];
      if (alvo.startsWith('http') || alvo.includes('<') || alvo.includes('$')) continue;
      // Exemplos genéricos e caminhos de dentro do contêiner não são do repo.
      if (/^(\/|node_modules|dist-|release\/|bundle\/|~|etc\/|var\/|tmp\/|opt\/)/.test(alvo)) continue;
      if (alvo.endsWith('.exemplo')) continue;
      if (existsSync(path.join(raiz, alvo))) continue;
      // Citar um arquivo que **deixou de existir**, dizendo que ele saiu, é
      // documentação correta — e é melhor do que apagar o parágrafo e deixar
      // quem procura pelo nome antigo sem resposta. O que não pode é citá-lo
      // como se ele ainda estivesse lá.
      const indice = documento.texto.slice(0, achado.index).split('\n').length - 1;
      const vizinhanca = linhas.slice(Math.max(0, indice - 3), indice + 4).join(' ');
      if (/\bsa[ií]ram?\b|removid|deixaram? de existir|não existe mais/i.test(vizinhanca)) continue;
      quebrados.push(`${documento.relativo} cita ${alvo}`);
    }
  }
  assert.deepEqual(quebrados, [], `arquivos citados que não existem:\n  ${quebrados.join('\n  ')}`);
});

// ── Nada de versão desatualizada ───────────────────────────────────────────

test('nenhum documento manda instalar uma versão que não é a desta entrega', () => {
  const { version } = JSON.parse(readFileSync(path.join(raiz, 'package.json'), 'utf8')) as { version: string };
  const errados: string[] = [];
  for (const documento of documentos) {
    // Um comando de instalação que aponta para a versão anterior é pior do que
    // um comando quebrado: ele funciona, e instala a coisa errada em silêncio.
    // Um relatório de época é evidência, e a evidência não é reescrita: ele
    // cita o comando da versão dele porque foi ele que rodou. O que ele
    // precisa é se identificar como histórico, e isso é conferido abaixo.
    if (/^docs\/(RELATORIO|AUDITORIA)-/.test(documento.relativo)) continue;
    for (const achado of documento.texto.matchAll(/install-v(\d+\.\d+\.\d+(?:-\d+)?)\.sh/g)) {
      if (achado[1] !== version) errados.push(`${documento.relativo}: install-v${achado[1]}.sh`);
    }
  }
  assert.deepEqual(errados, [], `instaladores de outra versão:\n  ${errados.join('\n  ')}`);
});

// ── As variáveis citadas são consumidas de verdade ────────────────────────

test('toda variável do .env.example é consumida em algum lugar do código', () => {
  const exemplo = readFileSync(path.join(raiz, '.env.example'), 'utf8');
  const declaradas = [...new Set([...exemplo.matchAll(/^#?\s*([A-Z][A-Z0-9_]+)=/gm)].map((achado) => achado[1]))];
  assert.ok(declaradas.length > 0, 'o .env.example precisa declarar variáveis');

  // A varredura é do projeto inteiro, e não de uma lista escrita à mão: uma
  // lista incompleta faz o teste acusar variável órfã que na verdade tem dono.
  const fontes = lerFontes().join('\n');

  const orfas = declaradas.filter((nome) => !fontes.includes(nome));
  assert.deepEqual(orfas, [], `declaradas no .env.example e consumidas por ninguém:\n  ${orfas.join('\n  ')}`);
});

test('toda variável obrigatória do compose está no .env.example', () => {
  const compose = readFileSync(path.join(raiz, 'docker-compose.yml'), 'utf8');
  const exemplo = readFileSync(path.join(raiz, '.env.example'), 'utf8');
  // As que o compose exige com `:?` derrubam o `up` quando faltam.
  const exigidas = [...new Set([...compose.matchAll(/\$\{([A-Z][A-Z0-9_]+):\?/g)].map((achado) => achado[1]))];
  const faltando = exigidas.filter((nome) => !exemplo.includes(nome));
  assert.deepEqual(faltando, [], `exigidas pelo compose e ausentes do .env.example:\n  ${faltando.join('\n  ')}`);
});

// ── Serviços e portas citados batem com o compose ─────────────────────────

test('todo serviço citado nos guias existe no docker-compose.yml', () => {
  const compose = readFileSync(path.join(raiz, 'docker-compose.yml'), 'utf8');
  const servicos = [...compose.matchAll(/^ {2}([a-z][a-z0-9-]*):$/gm)].map((achado) => achado[1]);
  assert.ok(servicos.includes('tumacord-server'), 'o serviço do chat mudou de nome?');

  const citados = new Set<string>();
  for (const documento of documentos) {
    for (const achado of documento.texto.matchAll(/docker compose[^\n`]*?\b(tumacord-[a-z-]+|coturn)\b/g)) {
      citados.add(achado[1]);
    }
  }
  const inexistentes = [...citados].filter((nome) => !servicos.includes(nome));
  assert.deepEqual(inexistentes, [], `serviços citados que não existem no compose:\n  ${inexistentes.join('\n  ')}`);
});

// ── O que é declarado como não implementado não é prometido como pronto ───

test('o que não está implementado é dito nos guias que o citam', () => {
  // Um comando que a documentação promete e que não existe é a reclamação que
  // originou esta revisão. Enquanto ele não existe, o guia precisa dizer.
  const promessas: { guia: string; comando: string }[] = [
    { guia: 'docs/backup-restore.md', comando: 'tumacordctl backup' },
    { guia: 'docs/atualizacao-servidor.md', comando: 'tumacordctl server apply' },
  ];
  for (const { guia, comando } of promessas) {
    const texto = readFileSync(path.join(raiz, guia), 'utf8');
    if (!texto.includes(comando)) continue;
    assert.match(
      texto,
      /não.{0,4}est(á|ão)\s+implementad|NÃO IMPLEMENTADO/i,
      `${guia} cita \`${comando}\` sem dizer que ele ainda não existe`,
    );
  }
});

// ── Nenhum segredo na documentação ────────────────────────────────────────

test('nenhum documento carrega um segredo de verdade', () => {
  const suspeitos: string[] = [];
  for (const documento of documentos) {
    // Chave privada em qualquer formato.
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(documento.texto)) suspeitos.push(`${documento.relativo}: chave privada`);
    // Uma variável de segredo com valor literal preenchido.
    for (const achado of documento.texto.matchAll(/^(?:export )?(TUMACORD_SERVER_ACCESS_KEY|TUMACORD_TURN_SECRET)=(.+)$/gm)) {
      const valor = achado[2].trim();
      // Placeholder, substituição de comando e vazio são aceitáveis.
      if (/^["']?(\$|<|\.\.\.|$)/.test(valor) || valor === '""' || valor === "''") continue;
      suspeitos.push(`${documento.relativo}: ${achado[1]} com valor literal`);
    }
  }
  assert.deepEqual(suspeitos, [], `possíveis segredos na documentação:\n  ${suspeitos.join('\n  ')}`);
});

// ── O README é a entrada única ────────────────────────────────────────────

test('o README aponta para os guias correntes', () => {
  const readme = readFileSync(path.join(raiz, 'README.md'), 'utf8');
  for (const guia of ['instalacao-vps', 'configuracao', 'atualizacao-servidor', 'backup-restore', 'publicacao-privada', 'versionamento', 'solucao-de-problemas']) {
    assert.ok(readme.includes(`docs/${guia}.md`), `o README não aponta para docs/${guia}.md`);
  }
});

test('documentos históricos se identificam como históricos', () => {
  // Preservar a evidência original é certo; apresentá-la como o guia atual
  // não é. Quem abre um relatório de 0.8.1 precisa saber que ele é de 0.8.1.
  for (const nome of readdirSync(docs)) {
    if (!/^(RELATORIO|AUDITORIA)-/.test(nome)) continue;
    const texto = readFileSync(path.join(docs, nome), 'utf8');
    assert.match(
      texto.slice(0, 1200),
      /hist[óo]rico|documento de época|preservad|não .{0,20}guia atual/i,
      `${nome} não se identifica como histórico logo no começo`,
    );
  }
});

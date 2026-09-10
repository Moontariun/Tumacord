import assert from 'node:assert/strict';
import test from 'node:test';
import { describePublished, formatBytes, readReleaseNotes } from '../src/lib/releaseNotes';

// O texto vem da página de Releases do GitHub, que é texto escrito por nós mas
// que chega pela rede. Ele é lido em blocos e desenhado como texto: a regra que
// não se negocia é que nada dele vira HTML.

test('o Markdown do CHANGELOG vira blocos legíveis', () => {
  const blocos = readReleaseNotes([
    '## 0.9.0 — a manchete',
    '',
    'Um parágrafo escrito em duas',
    'linhas, como o CHANGELOG escreve.',
    '',
    '**Um subtítulo**',
    '',
    '- primeiro item;',
    '- segundo item.',
    '',
    '> uma citação',
  ].join('\n'));
  assert.deepEqual(blocos, [
    { kind: 'heading', text: '0.9.0 — a manchete' },
    { kind: 'paragraph', text: 'Um parágrafo escrito em duas linhas, como o CHANGELOG escreve.' },
    { kind: 'heading', text: 'Um subtítulo' },
    { kind: 'item', text: 'primeiro item;' },
    { kind: 'item', text: 'segundo item.' },
    { kind: 'quote', text: 'uma citação' },
  ]);
});

test('marcação de ênfase e de código some do texto, e o link mantém o endereço', () => {
  const [negrito] = readReleaseNotes('Isto é **importante** e isto é `código`.');
  assert.equal(negrito.text, 'Isto é importante e isto é código.');
  const [link] = readReleaseNotes('Veja as [Releases](https://github.com/Moontariun/Tumacord/releases) do projeto.');
  assert.equal(link.text, 'Veja as Releases (https://github.com/Moontariun/Tumacord/releases) do projeto.');
});

test('um asterisco solto continua sendo um asterisco', () => {
  const [bloco] = readReleaseNotes('A conta era 3 * 4 e o resultado não mudou.');
  assert.equal(bloco.text, 'A conta era 3 * 4 e o resultado não mudou.');
});

test('notas vazias não viram bloco nenhum', () => {
  for (const vazio of ['', '   \n\n  ', null, undefined, 42]) {
    assert.deepEqual(readReleaseNotes(vazio), [], `virou bloco com ${JSON.stringify(vazio)}`);
  }
});

// Uma tag que chegasse pela rede seria desenhada como texto pelo React, mas
// ela não pode nem virar um bloco com cara de marcação interpretada.
test('HTML no meio das notas continua sendo texto', () => {
  const [bloco] = readReleaseNotes('<script>alert(1)</script> e nada mais');
  assert.equal(bloco.kind, 'paragraph');
  assert.equal(bloco.text, '<script>alert(1)</script> e nada mais');
});

test('o tamanho do arquivo é dito em quem vai esperar por ele', () => {
  assert.equal(formatBytes(0), '');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 kB');
  assert.equal(formatBytes(5.5 * 1024 * 1024), '5,5 MB');
  assert.equal(formatBytes(118 * 1024 * 1024), '118 MB');
  assert.equal(formatBytes(2 * 1024 * 1024 * 1024), '2,0 GB');
});

test('a data da versão vira o que ela significa para quem está decidindo', () => {
  const agora = Date.parse('2026-09-10T15:00:00Z');
  assert.equal(describePublished('2026-09-10T09:00:00Z', agora), 'publicada hoje');
  assert.equal(describePublished('2026-09-09T09:00:00Z', agora), 'publicada ontem');
  assert.equal(describePublished('2026-09-01T09:00:00Z', agora), 'publicada há 9 dias');
  assert.match(describePublished('2026-01-01T09:00:00Z', agora), /^publicada em /);
  assert.equal(describePublished('data inventada', agora), '');
});

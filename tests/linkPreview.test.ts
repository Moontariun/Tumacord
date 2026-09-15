import assert from 'node:assert/strict';
import test from 'node:test';
import { LinkPreviewer, decodeEntities, isPublicAddress, normalizePreviewUrl, parsePreviewHtml } from '../server/linkPreview.js';
import { previewableLinks, splitLinks } from '../src/lib/links.js';

test('endereços internos nunca são buscados', () => {
  for (const interno of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '224.0.0.1']) {
    assert.equal(isPublicAddress(interno), false, interno);
  }
  for (const publico of ['8.8.8.8', '200.9.155.102', '2606:4700:4700::1111']) {
    assert.equal(isPublicAddress(publico), true, publico);
  }
});

test('só http e https, sem credencial, nas portas padrão, e nunca um host local', () => {
  assert.equal(normalizePreviewUrl('https://example.com/a#b')?.href, 'https://example.com/a');
  for (const recusado of ['file:///etc/passwd', 'javascript:alert(1)', 'http://localhost/', 'http://127.0.0.1:4301/admin', 'http://[::1]/', 'https://user:senha@example.com/', 'http://example.com:8080/', 'http://printer.local/', 42, '']) {
    assert.equal(normalizePreviewUrl(recusado), null, String(recusado));
  }
});

test('lê título, descrição, site e imagem dos metadados da página', () => {
  const html = `<html><head>
    <title>Título da aba</title>
    <meta property="og:title" content="Um jogo &amp; tanto">
    <meta name="description" content='Descrição   longa
      em duas linhas'>
    <meta property="og:site_name" content="Loja">
    <meta property="og:image" content="/capa.png">
  </head></html>`;
  const meta = parsePreviewHtml(html, new URL('https://loja.example/produto/1'));
  assert.deepEqual(meta, { title: 'Um jogo & tanto', description: 'Descrição longa em duas linhas', siteName: 'Loja', imageUrl: 'https://loja.example/capa.png' });
});

test('sem metadado de site, o nome é o domínio; sem og:title, vale o título da aba', () => {
  const meta = parsePreviewHtml('<title>Só a aba</title>', new URL('https://www.example.com/'));
  assert.equal(meta.title, 'Só a aba');
  assert.equal(meta.siteName, 'example.com');
  assert.equal(meta.imageUrl, undefined);
});

test('imagem com esquema estranho fica de fora', () => {
  const meta = parsePreviewHtml('<meta property="og:image" content="javascript:alert(1)"><meta property="og:title" content="x">', new URL('https://example.com/'));
  assert.equal(meta.imageUrl, undefined);
});

test('entidades numéricas e nomeadas são decodificadas', () => {
  assert.equal(decodeEntities('Caf&#233; &#x2014; &quot;ok&quot; &lt;3'), 'Café — "ok" <3');
});

test('a mesma prévia pedida várias vezes é buscada uma vez só', async () => {
  let buscas = 0;
  const previewer = new LinkPreviewer(async (url) => { buscas += 1; return { url: url.href, title: 't' }; });
  await Promise.all([previewer.preview('https://example.com/x'), previewer.preview('https://example.com/x#outra-ancora')]);
  assert.equal(buscas, 1);
  assert.equal(await previewer.preview('http://127.0.0.1/'), null);
  assert.equal(buscas, 1, 'endereço recusado nem chega a buscar');
});

test('o texto vira pedaços, e a pontuação no fim não entra no link', () => {
  const partes = splitLinks('olha isso: https://example.com/a?b=1. e www.site.com.br!');
  assert.deepEqual(partes.map((parte) => [parte.kind, parte.text]), [
    ['text', 'olha isso: '], ['link', 'https://example.com/a?b=1'], ['text', '. e '], ['link', 'www.site.com.br'], ['text', '!'],
  ]);
  assert.equal(partes[3].href, 'https://www.site.com.br');
});

test('parêntese só é do link quando abriu dentro dele', () => {
  assert.equal(splitLinks('(ver https://pt.wikipedia.org/wiki/Café_(bebida))')[1].text, 'https://pt.wikipedia.org/wiki/Café_(bebida)');
  assert.equal(splitLinks('(https://example.com)')[1].text, 'https://example.com');
});

test('as prévias pegam os primeiros links distintos', () => {
  assert.deepEqual(previewableLinks('https://a.com https://a.com https://b.com https://c.com'), ['https://a.com', 'https://b.com']);
  assert.deepEqual(previewableLinks('sem link nenhum'), []);
});

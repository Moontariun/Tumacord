import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInvite, forgetCachedInvite, type DirectReport } from '../src/lib/directLink';
import { DIRECT_INVITE_TTL_MS, decodeInvite } from '../shared/directLink';

const call = { callId: 'call-geral', callName: 'Call do grupo', hostUsername: 'Moontariun' };

function reportWith(paths: DirectReport['paths'], key = 'chave-de-convite-com-tamanho-suficiente'): DirectReport {
  return {
    grade: 'ipv6',
    score: 60,
    paths,
    ipv6: true,
    cgnat: true,
    natMapping: 'endpoint-independent',
    key,
    port: 3927,
    checkedAt: 0,
    zeroTier: [],
  };
}

const base = reportWith([
  { kind: 'lan', host: '192.168.0.4', port: 3927, via: 'interface' },
  { kind: 'ipv6', host: '2804:14d:1::a', port: 3927, via: 'interface' },
]);

// O defeito relatado: a tela da call re-renderiza a cada atualização de ping, e
// o convite era montado no corpo do render com `Date.now()`. O código mudava
// por inteiro várias vezes por segundo, e mudar o valor embaixo da seleção
// atrapalhava até copiar.
test('o mesmo convite sai igual mesmo com o tempo correndo entre as chamadas', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const primeiro = buildInvite(base, call, inicio);
  assert.ok(primeiro);
  for (const passo of [1, 500, 60_000, 10 * 60_000, 3 * 60 * 60_000]) {
    assert.equal(buildInvite(base, call, inicio + passo), primeiro, `mudou depois de ${passo} ms`);
  }
});

test('dez minutos de call não produzem um código diferente a cada segundo', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const codigos = new Set<string>();
  for (let segundo = 0; segundo <= 600; segundo += 1) {
    const codigo = buildInvite(base, call, inicio + segundo * 1_000);
    if (codigo) codigos.add(codigo);
  }
  assert.equal(codigos.size, 1);
});

test('o prazo continua sendo de doze horas, e não é reiniciado a cada leitura', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const codigo = buildInvite(base, call, inicio);
  const depois = buildInvite(base, call, inicio + 30 * 60_000);
  assert.equal(depois, codigo);
  const decodificado = decodeInvite(codigo!);
  assert.equal(decodificado?.ttlMs, DIRECT_INVITE_TTL_MS);
  assert.equal(decodificado?.issuedAt, inicio, 'a data de emissão precisa ser a da primeira geração');
});

test('perto do vencimento o convite é renovado, com uma hora de folga', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const codigo = buildInvite(base, call, inicio);
  const aindaFolgado = buildInvite(base, call, inicio + DIRECT_INVITE_TTL_MS - 60 * 60_000 - 1);
  assert.equal(aindaFolgado, codigo);
  const renovado = buildInvite(base, call, inicio + DIRECT_INVITE_TTL_MS - 60 * 60_000);
  assert.notEqual(renovado, codigo);
  assert.equal(decodeInvite(renovado!)?.issuedAt, inicio + DIRECT_INVITE_TTL_MS - 60 * 60_000);
});

test('mudar um endereço de entrada gera um convite novo', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const codigo = buildInvite(base, call, inicio);
  const comPortaMapeada = reportWith([...base.paths, { kind: 'ipv4', host: '189.40.12.7', port: 52_100, via: 'pcp' }]);
  const novo = buildInvite(comPortaMapeada, call, inicio + 1_000);
  assert.notEqual(novo, codigo);
  assert.equal(decodeInvite(novo!)?.paths.length, 3);
});

test('trocar a chave ou a call também gera um convite novo', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const codigo = buildInvite(base, call, inicio);
  assert.notEqual(buildInvite(reportWith(base.paths, 'outra-chave-de-convite-suficientemente-longa'), call, inicio), codigo);
  forgetCachedInvite();
  buildInvite(base, call, inicio);
  assert.notEqual(buildInvite(base, { ...call, callId: 'outra-call' }, inicio), codigo);
});

test('sem caminho de entrada ou sem chave não existe convite para mostrar', () => {
  forgetCachedInvite();
  assert.equal(buildInvite(reportWith([]), call, 1), null);
  assert.equal(buildInvite(reportWith(base.paths, ''), call, 1), null);
});

test('a ordem em que os caminhos chegam não muda o código', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const codigo = buildInvite(base, call, inicio);
  const invertido = reportWith([...base.paths].reverse());
  assert.equal(buildInvite(invertido, call, inicio + 5_000), codigo);
});

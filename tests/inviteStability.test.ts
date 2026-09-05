import assert from 'node:assert/strict';
import test from 'node:test';
import { buildInvite, forgetCachedInvite } from '../src/lib/directLink';
import { DIRECT_INVITE_TTL_MS, decodeInvite } from '../shared/directLink';

// Desde a 0.8.3 o convite é a call mais o servidor de encontro mais a chave.
// A estabilidade continua sendo a mesma exigência: o código não pode mudar
// embaixo de quem está tentando copiá-lo.
const call = {
  callId: 'call-geral',
  callName: 'Call do grupo',
  hostUsername: 'Moontariun',
  server: 'https://call.exemplo.com',
  key: 'chave-de-convite-com-tamanho-suficiente',
};

// O defeito relatado: a tela da call re-renderiza a cada atualização de ping, e
// o convite era montado no corpo do render com `Date.now()`. O código mudava
// por inteiro várias vezes por segundo, e mudar o valor embaixo da seleção
// atrapalhava até copiar.
test('o mesmo convite sai igual mesmo com o tempo correndo entre as chamadas', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const primeiro = buildInvite(call, inicio);
  assert.ok(primeiro);
  for (const passo of [1, 500, 60_000, 10 * 60_000, 3 * 60 * 60_000]) {
    assert.equal(buildInvite(call, inicio + passo), primeiro, `mudou depois de ${passo} ms`);
  }
});

test('dez minutos de call não produzem um código diferente a cada segundo', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const codigos = new Set<string>();
  for (let segundo = 0; segundo <= 600; segundo += 1) {
    const codigo = buildInvite(call, inicio + segundo * 1_000);
    if (codigo) codigos.add(codigo);
  }
  assert.equal(codigos.size, 1);
});

test('o prazo continua sendo de doze horas, e não é reiniciado a cada leitura', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const codigo = buildInvite(call, inicio);
  const depois = buildInvite(call, inicio + 30 * 60_000);
  assert.equal(depois, codigo);
  const decodificado = decodeInvite(codigo!);
  assert.equal(decodificado?.ttlMs, DIRECT_INVITE_TTL_MS);
  assert.equal(decodificado?.issuedAt, inicio, 'a data de emissão precisa ser a da primeira geração');
});

test('perto do vencimento o convite é renovado, com uma hora de folga', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const codigo = buildInvite(call, inicio);
  const aindaFolgado = buildInvite(call, inicio + DIRECT_INVITE_TTL_MS - 60 * 60_000 - 1);
  assert.equal(aindaFolgado, codigo);
  const renovado = buildInvite(call, inicio + DIRECT_INVITE_TTL_MS - 60 * 60_000);
  assert.notEqual(renovado, codigo);
  assert.equal(decodeInvite(renovado!)?.issuedAt, inicio + DIRECT_INVITE_TTL_MS - 60 * 60_000);
});

test('trocar a chave ou a call gera um convite novo', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const codigo = buildInvite(call, inicio);
  assert.notEqual(buildInvite({ ...call, key: 'outra-chave-com-tamanho-suficiente' }, inicio), codigo);
  forgetCachedInvite();
  buildInvite(call, inicio);
  assert.notEqual(buildInvite({ ...call, callId: 'outra-call' }, inicio), codigo);
});

test('trocar o servidor de encontro gera um convite novo', () => {
  forgetCachedInvite();
  const inicio = 1_757_000_000_000;
  const codigo = buildInvite(call, inicio);
  const outro = buildInvite({ ...call, server: 'https://outra.exemplo.com' }, inicio + 1_000);
  assert.notEqual(outro, codigo);
  assert.equal(decodeInvite(outro!)?.server, 'https://outra.exemplo.com');
});

// Sem servidor não há convite. Antes existia a alternativa de anunciar os
// endereços desta máquina; ela saiu na 0.8.3 porque exigia que alguém do grupo
// fosse alcançável da internet, e quase nunca era.
test('sem servidor ou sem chave não existe convite para mostrar', () => {
  forgetCachedInvite();
  assert.equal(buildInvite({ ...call, server: undefined }, 1), null);
  forgetCachedInvite();
  assert.equal(buildInvite({ ...call, key: '' }, 1), null);
  forgetCachedInvite();
  assert.equal(buildInvite({ ...call, server: 'ftp://call.exemplo.com' }, 1), null, 'endereço que não é HTTP não vira convite');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { addressFamily, describeSelectedPath, selectedCandidatePath, summarizePaths, type RtcStatLike } from '../src/lib/iceDiagnostics';

function relatorio(local: Partial<RtcStatLike>, remote: Partial<RtcStatLike>, pair: Partial<RtcStatLike> = {}): RtcStatLike[] {
  return [
    { type: 'candidate-pair', id: 'par', state: 'succeeded', nominated: true, localCandidateId: 'l', remoteCandidateId: 'r', ...pair },
    { type: 'local-candidate', id: 'l', candidateType: 'host', protocol: 'udp', address: '192.168.0.4', ...local },
    { type: 'remote-candidate', id: 'r', candidateType: 'host', protocol: 'udp', address: '192.168.0.9', ...remote },
    { type: 'transport', id: 't' },
  ];
}

test('mesma rede aparece como caminho direto por host', () => {
  const path = selectedCandidatePath(relatorio({}, {}));
  assert.deepEqual({ local: path?.local, remote: path?.remote, relayed: path?.relayed, family: path?.family }, {
    local: 'host', remote: 'host', relayed: false, family: 'IPv4',
  });
  assert.match(describeSelectedPath(path), /direto, sem NAT/);
});

test('NAT furado por STUN aparece como srflx, e continua direto', () => {
  const path = selectedCandidatePath(relatorio(
    { candidateType: 'srflx', address: '189.40.12.7' },
    { candidateType: 'srflx', address: '200.1.2.3' },
  ));
  assert.equal(path?.relayed, false);
  assert.equal(path?.local, 'srflx');
  assert.match(describeSelectedPath(path), /furando o NAT/);
});

// A distinção que interessa para a conta de banda do servidor.
test('basta um lado pelo relay para a mídia estar passando pelo TURN', () => {
  const soLocal = selectedCandidatePath(relatorio({ candidateType: 'relay', address: '203.0.113.10' }, {}));
  assert.equal(soLocal?.relayed, true);
  const soRemoto = selectedCandidatePath(relatorio({}, { candidateType: 'relay' }));
  assert.equal(soRemoto?.relayed, true);
  assert.match(describeSelectedPath(soLocal), /relay TURN/);
});

test('IPv6 é reconhecido pelo formato do endereço', () => {
  const path = selectedCandidatePath(relatorio({ address: '2804:14d:1::a' }, { address: '2804:14d:2::b' }));
  assert.equal(path?.family, 'IPv6');
  assert.match(describeSelectedPath(path), /IPv6/);
});

test('a família sai do endereço mesmo sem campo dedicado', () => {
  assert.equal(addressFamily('189.40.12.7'), 'IPv4');
  assert.equal(addressFamily('2804:14d:1::a'), 'IPv6');
  assert.equal(addressFamily('::1'), 'IPv6');
  assert.equal(addressFamily(''), 'unknown');
  assert.equal(addressFamily(undefined), 'unknown');
  assert.equal(addressFamily('exemplo.com'), 'unknown');
});

test('o campo `ip` antigo é aceito quando `address` não vem', () => {
  const path = selectedCandidatePath([
    { type: 'candidate-pair', id: 'par', state: 'succeeded', nominated: true, localCandidateId: 'l', remoteCandidateId: 'r' },
    { type: 'local-candidate', id: 'l', candidateType: 'relay', protocol: 'tcp', ip: '203.0.113.10' },
    { type: 'remote-candidate', id: 'r', candidateType: 'srflx', ip: '189.40.12.7' },
  ]);
  assert.equal(path?.family, 'IPv4');
  assert.equal(path?.protocol, 'tcp');
  assert.equal(path?.relayed, true);
});

test('o par marcado como selecionado tem prioridade sobre o meramente bem-sucedido', () => {
  const path = selectedCandidatePath([
    { type: 'candidate-pair', id: 'antigo', state: 'succeeded', localCandidateId: 'l1', remoteCandidateId: 'r1' },
    { type: 'candidate-pair', id: 'atual', selected: true, localCandidateId: 'l2', remoteCandidateId: 'r2' },
    { type: 'local-candidate', id: 'l1', candidateType: 'relay', address: '203.0.113.10' },
    { type: 'local-candidate', id: 'l2', candidateType: 'host', address: '192.168.0.4' },
    { type: 'remote-candidate', id: 'r1', candidateType: 'relay' },
    { type: 'remote-candidate', id: 'r2', candidateType: 'host' },
  ]);
  assert.equal(path?.local, 'host', 'o par em uso é o que vale');
  assert.equal(path?.relayed, false);
});

test('sem par escolhido ainda, a resposta é honesta em vez de inventada', () => {
  assert.equal(selectedCandidatePath([{ type: 'transport', id: 't' }]), null);
  assert.equal(selectedCandidatePath([]), null);
  assert.match(describeSelectedPath(null), /ainda não escolhido/);
});

test('par sem candidato correspondente não vira acusação de relay', () => {
  const path = selectedCandidatePath([
    { type: 'candidate-pair', id: 'par', state: 'succeeded', nominated: true, localCandidateId: 'sumiu', remoteCandidateId: 'tambem' },
  ]);
  assert.deepEqual({ local: path?.local, remote: path?.remote, relayed: path?.relayed }, { local: 'unknown', remote: 'unknown', relayed: false });
});

test('o tempo de ida e volta vem em milissegundos quando informado', () => {
  const path = selectedCandidatePath(relatorio({}, {}, { currentRoundTripTime: 0.0234 }));
  assert.equal(path?.roundTripMs, 23);
  assert.equal(selectedCandidatePath(relatorio({}, {}))?.roundTripMs, undefined);
});

// Agregado para o painel: nenhum endereço sai daqui, só a contagem.
test('o resumo separa direto de relay sem expor endereço nenhum', () => {
  const resumo = summarizePaths([
    { local: 'host', remote: 'host', protocol: 'udp', family: 'IPv6', relayed: false },
    { local: 'srflx', remote: 'srflx', protocol: 'udp', family: 'IPv4', relayed: false },
    { local: 'relay', remote: 'srflx', protocol: 'tcp', family: 'IPv4', relayed: true },
    null,
  ]);
  assert.deepEqual(resumo, { total: 4, direct: 2, relayed: 1, ipv6: 1, unknown: 1 });
  assert.equal(JSON.stringify(resumo).includes('.'), false, 'o resumo não pode carregar endereço');
});

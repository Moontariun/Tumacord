import assert from 'node:assert/strict';
import test from 'node:test';
import {
  betterHost,
  checksumOf,
  classifyIpv4,
  classifyIpv6,
  decodeInvite,
  describeReachability,
  encodeInvite,
  expandIpv6,
  gradeFor,
  inviteExpired,
  isTrustedLocalAddress,
  isZeroTierInterface,
  orderPaths,
  pathToUrl,
  reachabilityScore,
  type DirectInvite,
  type DirectPath,
} from '../shared/directLink';

test('classificação de IPv4 separa CGNAT de rede local e de endereço público', () => {
  assert.equal(classifyIpv4('127.0.0.1'), 'loopback');
  assert.equal(classifyIpv4('192.168.0.10'), 'private');
  assert.equal(classifyIpv4('172.16.4.1'), 'private');
  assert.equal(classifyIpv4('172.32.4.1'), 'public');
  assert.equal(classifyIpv4('10.147.17.9'), 'private');
  assert.equal(classifyIpv4('100.64.3.9'), 'cgnat');
  assert.equal(classifyIpv4('100.128.3.9'), 'public');
  assert.equal(classifyIpv4('169.254.9.9'), 'link-local');
  assert.equal(classifyIpv4('189.40.12.7'), 'public');
  assert.equal(classifyIpv4('300.1.1.1'), null);
  assert.equal(classifyIpv4('nao-e-ip'), null);
});

test('IPv6 é expandido antes de ser classificado', () => {
  assert.deepEqual(expandIpv6('::1'), [0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(expandIpv6('2804:14d:1::a'), [0x2804, 0x14d, 1, 0, 0, 0, 0, 0xa]);
  assert.deepEqual(expandIpv6('::ffff:192.168.0.1'), [0, 0, 0, 0, 0, 0xffff, 0xc0a8, 0x0001]);
  assert.equal(expandIpv6('2804::1::2'), null);
  assert.equal(expandIpv6('12345::1'), null);
  assert.equal(classifyIpv6('::1'), 'loopback');
  assert.equal(classifyIpv6('fe80::1%wlan0'), 'link-local');
  assert.equal(classifyIpv6('fd00::1'), 'unique-local');
  assert.equal(classifyIpv6('2804:14d:1::a'), 'global');
});

test('só endereços da própria rede dispensam o convite; CGNAT não é rede local', () => {
  assert.equal(isTrustedLocalAddress('127.0.0.1'), true);
  assert.equal(isTrustedLocalAddress('::ffff:192.168.15.4'), true);
  assert.equal(isTrustedLocalAddress('10.147.17.9'), true);
  assert.equal(isTrustedLocalAddress('fd00::9'), true);
  assert.equal(isTrustedLocalAddress('100.100.4.5'), false);
  assert.equal(isTrustedLocalAddress('189.40.12.7'), false);
  assert.equal(isTrustedLocalAddress('2804:14d:1::a'), false);
});

test('interface do ZeroTier é reconhecida pelo nome e pela faixa padrão', () => {
  assert.equal(isZeroTierInterface('ztyorlqm7u'), true);
  assert.equal(isZeroTierInterface('zt0'), true);
  assert.equal(isZeroTierInterface('wlan0', '10.147.17.9'), true);
  assert.equal(isZeroTierInterface('wlan0', '192.168.0.4'), false);
  assert.equal(isZeroTierInterface('eth0'), false);
});

test('a nota de alcance ordena IPv4 aberto acima de mapeado, IPv6 e rede local', () => {
  assert.equal(reachabilityScore({ grade: 'open', natMapping: 'open' }), 100);
  assert.equal(reachabilityScore({ grade: 'mapped', natMapping: 'endpoint-independent' }), 85);
  assert.equal(reachabilityScore({ grade: 'ipv6', natMapping: 'symmetric' }), 60);
  assert.equal(reachabilityScore({ grade: 'lan', natMapping: 'unknown' }), 30);
  assert.equal(reachabilityScore({ grade: 'blocked', natMapping: 'symmetric' }), 0);
});

test('a graduação exige que exista um caminho do tipo correspondente', () => {
  const ipv4: DirectPath = { kind: 'ipv4', host: '189.40.12.7', port: 3927, via: 'pcp' };
  const ipv6: DirectPath = { kind: 'ipv6', host: '2804:14d:1::a', port: 3927, via: 'interface' };
  const lan: DirectPath = { kind: 'lan', host: '192.168.0.4', port: 3927, via: 'interface' };
  assert.equal(gradeFor({ paths: [ipv4, lan], publicIpv4Interface: true, ipv6: false, mapped: false }), 'open');
  assert.equal(gradeFor({ paths: [ipv4, lan], publicIpv4Interface: false, ipv6: false, mapped: true }), 'mapped');
  assert.equal(gradeFor({ paths: [ipv6, lan], publicIpv4Interface: false, ipv6: true, mapped: false }), 'ipv6');
  assert.equal(gradeFor({ paths: [lan], publicIpv4Interface: false, ipv6: true, mapped: true }), 'lan');
  assert.equal(gradeFor({ paths: [], publicIpv4Interface: true, ipv6: true, mapped: true }), 'blocked');
});

test('a ordem de tentativa é rede local, IPv6 e depois IPv4, sem repetição', () => {
  const paths: DirectPath[] = [
    { kind: 'ipv4', host: '189.40.12.7', port: 3927, via: 'upnp' },
    { kind: 'ipv6', host: '2804:14d:1::a', port: 3927, via: 'interface' },
    { kind: 'lan', host: '192.168.0.4', port: 3927, via: 'interface' },
    { kind: 'lan', host: '192.168.0.4', port: 3927, via: 'interface' },
    { kind: 'ipv4', host: '189.40.12.7', port: 0, via: 'upnp' },
  ];
  assert.deepEqual(orderPaths(paths).map((path) => path.kind), ['lan', 'ipv6', 'ipv4']);
  assert.deepEqual(orderPaths(paths, { ipv6Available: false }).map((path) => path.kind), ['lan', 'ipv4']);
});

test('a URL do caminho põe o IPv6 entre colchetes', () => {
  assert.equal(pathToUrl({ kind: 'ipv6', host: '2804:14d:1::a', port: 3927, via: 'interface' }), 'http://[2804:14d:1::a]:3927');
  assert.equal(pathToUrl({ kind: 'ipv4', host: '189.40.12.7', port: 3927, via: 'pcp' }), 'http://189.40.12.7:3927');
  assert.equal(pathToUrl({ kind: 'lan', host: '192.168.0.4', port: 3927, via: 'interface' }), 'http://192.168.0.4:3927');
});

const invite: DirectInvite = {
  version: 1,
  callId: 'call-geral',
  callName: 'Call do grupo 🍅',
  hostUsername: 'Moontariun',
  key: 'ZmFrZS1jaGF2ZS1kZS1jb252aXRlLTMy',
  paths: [
    { kind: 'ipv6', host: '2804:14d:1::a', port: 3927, via: 'interface' },
    { kind: 'ipv4', host: '189.40.12.7', port: 41_827, via: 'pcp' },
    { kind: 'lan', host: '192.168.0.4', port: 3927, via: 'interface' },
  ],
  issuedAt: 1_757_000_000_000,
  ttlMs: 43_200_000,
};

test('o convite sobrevive à ida e à volta, inclusive com emoji no nome', () => {
  const code = encodeInvite(invite);
  assert.match(code, /^TUMA1\.[A-Za-z0-9_-]+\.[a-z0-9]+$/);
  assert.deepEqual(decodeInvite(code), invite);
  assert.deepEqual(decodeInvite(`  ${code.replace('TUMA1', 'tuma1')}\n`), invite, 'espaço em volta e prefixo em minúsculas continuam válidos');
});

test('convite truncado, adulterado ou sem caminho é recusado', () => {
  const code = encodeInvite(invite);
  assert.equal(decodeInvite(code.slice(0, -3)), null);
  assert.equal(decodeInvite(code.replace('TUMA1', 'TUMA2')), null);
  assert.equal(decodeInvite('qualquer coisa'), null);
  const semCaminho = encodeInvite({ ...invite, paths: [] });
  assert.equal(decodeInvite(semCaminho), null);
  const chaveCurta = encodeInvite({ ...invite, key: 'curta' });
  assert.equal(decodeInvite(chaveCurta), null);
});

test('caminho com endereço inválido é descartado sem derrubar o convite inteiro', () => {
  const code = encodeInvite({
    ...invite,
    paths: [{ kind: 'ipv4', host: '999.1.1.1', port: 3927, via: 'pcp' }, invite.paths[0]],
  });
  const decoded = decodeInvite(code);
  assert.deepEqual(decoded?.paths, [invite.paths[0]]);
});

test('o checksum muda quando um byte do corpo muda', () => {
  assert.notEqual(checksumOf('abcdef'), checksumOf('abcdeg'));
  assert.equal(checksumOf('abcdef').length, 7);
});

test('convite vencido é reconhecido pelo prazo, e prazo zero nunca vence', () => {
  assert.equal(inviteExpired(invite, invite.issuedAt + 1000), false);
  assert.equal(inviteExpired(invite, invite.issuedAt + invite.ttlMs + 1), true);
  assert.equal(inviteExpired({ ...invite, ttlMs: 0 }, Number.MAX_SAFE_INTEGER), false);
});

test('a eleição de host prefere quem é alcançável e usa o ping como desempate', () => {
  const cgnat = { id: 'a', pingMs: 8, reachability: 0 };
  const ipv6 = { id: 'b', pingMs: 40, reachability: 60 };
  const mapeado = { id: 'c', pingMs: 55, reachability: 85 };
  assert.deepEqual([cgnat, ipv6, mapeado].sort(betterHost).map((member) => member.id), ['c', 'b', 'a']);
  const empate = [{ id: 'y', pingMs: 30, reachability: 60 }, { id: 'x', pingMs: 12, reachability: 60 }];
  assert.deepEqual(empate.sort(betterHost).map((member) => member.id), ['x', 'y']);
});

test('cada grau de alcance explica em português o que o usuário pode fazer', () => {
  const base = { paths: [], ipv6: true, cgnat: true, natMapping: 'endpoint-independent' as const };
  assert.match(describeReachability({ ...base, grade: 'ipv6' }), /CGNAT/);
  assert.match(describeReachability({ ...base, grade: 'mapped', mappedVia: 'pcp' }), /PCP/);
  assert.match(describeReachability({ ...base, grade: 'blocked' }), /ZeroTier/);
  assert.match(describeReachability({ ...base, grade: 'lan' }), /rede local/);
  assert.match(describeReachability({ ...base, grade: 'open' }), /convite/);
});

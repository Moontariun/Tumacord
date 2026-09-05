import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const require = createRequire(import.meta.url);
const preferences = require('../desktop/network-preferences.cjs') as {
  DEFAULTS: Record<string, unknown>;
  sanitize: (input: unknown) => Record<string, unknown>;
  readNetworkPreferences: (file: string) => Record<string, unknown>;
  writeNetworkPreferences: (file: string, value: unknown) => Record<string, unknown>;
};

function withTemporaryDirectory<T>(run: (directory: string) => T): T {
  const directory = mkdtempSync(path.join(tmpdir(), 'tumacord-preferences-'));
  try {
    return run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('o padrão deixa o ZeroTier desligado e a travessia de NAT ligada', () => {
  assert.equal(preferences.DEFAULTS.zeroTierEnabled, false);
  assert.equal(preferences.DEFAULTS.stunEnabled, true);
  assert.equal(preferences.DEFAULTS.portMapping, true);
});

test('o relay nasce desligado, e ligar sobrevive ao reinício', () => {
  assert.equal(preferences.DEFAULTS.turnEnabled, false);
  assert.equal(preferences.sanitize({ turnEnabled: 'sim' }).turnEnabled, false, 'só booleano liga o relay');
  assert.equal(preferences.sanitize({ turnEnabled: true }).turnEnabled, true);
  withTemporaryDirectory((directory) => {
    const file = path.join(directory, 'network-preferences.json');
    preferences.writeNetworkPreferences(file, { ...preferences.readNetworkPreferences(file), turnEnabled: true });
    assert.equal(preferences.readNetworkPreferences(file).turnEnabled, true);
  });
});

test('valores estranhos caem no padrão em vez de derrubar o aplicativo', () => {
  const sanitized = preferences.sanitize({ zeroTierEnabled: 'sim', portMapping: null, stunServers: 'texto', directKey: 'curta' });
  assert.equal(sanitized.zeroTierEnabled, false);
  assert.equal(sanitized.portMapping, true);
  assert.deepEqual(sanitized.stunServers, preferences.DEFAULTS.stunServers);
  assert.equal(sanitized.directKey, '', 'chave curta demais é descartada em vez de virar um segredo fraco');
  assert.deepEqual(preferences.sanitize(null), { ...preferences.DEFAULTS });
});

test('a lista de STUN é limpa, aparada e limitada a oito entradas', () => {
  const many = Array.from({ length: 20 }, (_value, index) => `  stun:servidor${index}:3478 `);
  const sanitized = preferences.sanitize({ stunServers: [...many, '', 42] });
  assert.equal((sanitized.stunServers as string[]).length, 8);
  assert.equal((sanitized.stunServers as string[])[0], 'stun:servidor0:3478');
});

test('a chave do convite é criada uma vez e sobrevive à releitura', () => {
  withTemporaryDirectory((directory) => {
    const file = path.join(directory, 'network-preferences.json');
    const first = preferences.readNetworkPreferences(file);
    assert.equal(typeof first.directKey, 'string');
    assert.ok((first.directKey as string).length >= 22);
    assert.equal(preferences.readNetworkPreferences(file).directKey, first.directKey);
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).directKey, first.directKey);
  });
});

test('arquivo corrompido devolve o padrão e ganha uma chave nova', () => {
  withTemporaryDirectory((directory) => {
    const file = path.join(directory, 'network-preferences.json');
    writeFileSync(file, '{ isto não é json', 'utf8');
    const recovered = preferences.readNetworkPreferences(file);
    assert.equal(recovered.zeroTierEnabled, false);
    assert.ok((recovered.directKey as string).length >= 22);
  });
});

test('gravar preserva a chave e aplica a preferência nova', () => {
  withTemporaryDirectory((directory) => {
    const file = path.join(directory, 'network-preferences.json');
    const initial = preferences.readNetworkPreferences(file);
    const updated = preferences.writeNetworkPreferences(file, { ...initial, zeroTierEnabled: true });
    assert.equal(updated.zeroTierEnabled, true);
    assert.equal(updated.directKey, initial.directKey);
    assert.equal(preferences.readNetworkPreferences(file).zeroTierEnabled, true);
  });
});

test('um caminho impossível de gravar ainda devolve a preferência para esta sessão', () => {
  withTemporaryDirectory((directory) => {
    // Um arquivo comum no lugar da pasta: criar o diretório falha com ENOTDIR,
    // que é o mesmo desfecho de um disco cheio ou sem permissão.
    const blocker = path.join(directory, 'bloqueio');
    writeFileSync(blocker, 'não sou uma pasta', 'utf8');
    const sanitized = preferences.writeNetworkPreferences(path.join(blocker, 'preferencias.json'), { zeroTierEnabled: true });
    assert.equal(sanitized.zeroTierEnabled, true);
  });
});

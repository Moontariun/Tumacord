import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SelfUpdater, selfUpdateConfig, unavailableReason } from '../server/selfUpdate';

// A atualização do servidor pelo painel, do lado que decide se ela acontece.
//
// Nenhum caso aqui executa o script: o que se prova é o contrário — que os
// caminhos de recusa fecham antes de qualquer execução. Executar de verdade
// trocaria o código desta cópia do repositório, e está dito como manual em
// `docs/QA.md`.

function pastaComScript(): string {
  const raiz = mkdtempSync(path.join(tmpdir(), 'tumacord-self-update-'));
  mkdirSync(path.join(raiz, 'scripts'), { recursive: true });
  writeFileSync(path.join(raiz, 'scripts', 'update-server.sh'), '#!/usr/bin/env bash\nexit 0\n');
  mkdirSync(path.join(raiz, '.git'), { recursive: true });
  return raiz;
}

test('o padrão é desligado, e ele é dito', () => {
  const config = selfUpdateConfig({}, pastaComScript());
  assert.equal(config.enabled, false);
  assert.match(unavailableReason(config), /desligada/);
});

// Um servidor que ganhou esta versão não passa a aceitar troca de código
// porque atualizou: ligar isso é uma decisão de quem hospeda.
test('ligado, ainda é preciso ter o script no lugar', () => {
  const semScript = mkdtempSync(path.join(tmpdir(), 'tumacord-sem-script-'));
  assert.match(unavailableReason(selfUpdateConfig({ TUMACORD_SELF_UPDATE: '1' }, semScript)), /update-server\.sh/);
  assert.equal(unavailableReason(selfUpdateConfig({ TUMACORD_SELF_UPDATE: '1' }, pastaComScript())), '');
});

// É o caso do contêiner: a imagem carrega só o código compilado. O script faz
// `git fetch` e `git checkout`, e sem repositório ele falharia no meio —
// depois de já ter feito o backup.
test('sem repositório não há o que atualizar, e a recusa vem antes do backup', () => {
  const semGit = mkdtempSync(path.join(tmpdir(), 'tumacord-sem-git-'));
  mkdirSync(path.join(semGit, 'scripts'), { recursive: true });
  writeFileSync(path.join(semGit, 'scripts', 'update-server.sh'), '#!/usr/bin/env bash\nexit 0\n');
  assert.match(unavailableReason(selfUpdateConfig({ TUMACORD_SELF_UPDATE: '1' }, semGit)), /clone do repositório/);
});

// O repositório é de quem hospeda e nunca chega pelo pedido: escolher o
// repositório no navegador seria escolher de onde vem o código que vai rodar.
test('um repositório mal formado fecha o caminho', () => {
  const config = selfUpdateConfig({ TUMACORD_SELF_UPDATE: '1', TUMACORD_REPO: 'https://exemplo/x; rm -rf /' }, pastaComScript());
  assert.match(unavailableReason(config), /dono\/projeto/);
});

test('o prazo do script fica entre um minuto e uma hora, venha o que vier', () => {
  const raiz = pastaComScript();
  assert.equal(selfUpdateConfig({ TUMACORD_SELF_UPDATE_TIMEOUT_MS: '1' }, raiz).timeoutMs, 60_000);
  assert.equal(selfUpdateConfig({ TUMACORD_SELF_UPDATE_TIMEOUT_MS: '999999999' }, raiz).timeoutMs, 3_600_000);
  assert.equal(selfUpdateConfig({ TUMACORD_SELF_UPDATE_TIMEOUT_MS: 'abacaxi' }, raiz).timeoutMs, 60_000);
});

// Com o recurso desligado nada é buscado e nada é executado: a recusa vem
// antes até da rede.
test('desligado, nem uma etiqueta publicada é aplicada', async () => {
  const updater = new SelfUpdater(selfUpdateConfig({}, pastaComScript()));
  const resultado = await updater.start('v0.9.8', '0.9.7');
  assert.equal(resultado.ok, false);
  assert.match(resultado.ok === false ? resultado.error : '', /desligada/);
  assert.equal(updater.snapshot().status, 'idle', 'nada começou');
});

test('ligado, uma etiqueta malformada morre antes de qualquer consulta', async () => {
  const updater = new SelfUpdater(selfUpdateConfig({ TUMACORD_SELF_UPDATE: '1' }, pastaComScript()));
  for (const tentativa of ['main', 'v0.9.9; rm -rf /', '../../etc/passwd', 'V1.2.3', '']) {
    const resultado = await updater.start(tentativa, '0.9.7');
    assert.equal(resultado.ok, false, `${JSON.stringify(tentativa)} não pode ser aceito`);
    assert.equal(updater.snapshot().status, 'idle');
  }
});

test('o estado começa parado e não inventa uma atualização', () => {
  const updater = new SelfUpdater(selfUpdateConfig({}, pastaComScript()));
  assert.deepEqual(updater.snapshot(), { status: 'idle', tag: '', startedAt: '', finishedAt: '', log: '' });
  assert.equal(updater.running, false);
});

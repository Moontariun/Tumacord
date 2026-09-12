import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Entregar o instalador do Windows ao Windows, sem derrubar o Tumacord.
//
// O print da 0.9.8 mostra o processo principal caindo com
// `spawn ...Tumacord-0.9.9-Setup.exe EACCES` como exceção não tratada. Duas
// coisas erradas, uma dentro da outra: não havia ouvinte de `error` — e um
// `'error'` sem ouvinte fecha o processo —, e `spawn` chama `CreateProcess`,
// que não eleva. O instalador é NSIS `perMachine`, ou seja, pede administrador
// no manifesto, e `CreateProcess` recusa um executável assim.
//
// Nada aqui certifica UAC nem instalação de verdade: isso é máquina Windows, e
// está registrado como tal em docs/QA.md. O que estes casos provam é o
// contrato do lançador — que ele trata cada falha, classifica o que dá para
// classificar, e **em nenhum caminho deixa um evento sem ouvinte**.

const require_ = createRequire(import.meta.url);
const {
  ELEVATION_SCRIPT,
  classifyLaunchFailure,
  defaultPowerShell,
  failureMessage,
  launchElevatedInstaller,
  verifyInstallerFile,
} = require_('../desktop/windows-installer.cjs') as {
  ELEVATION_SCRIPT: string;
  classifyLaunchFailure: (input: Record<string, unknown>) => string;
  defaultPowerShell: (env: Record<string, string>) => string;
  failureMessage: (cause: string) => string;
  launchElevatedInstaller: (file: string, options: Record<string, unknown>) => Promise<{ started: boolean; pid?: number; cause?: string; error?: string }>;
  verifyInstallerFile: (file: string, expected?: string, options?: Record<string, unknown>) => { ok: boolean; cause?: string; size?: number };
};

/** Um filho de processo fingido, com os mesmos eventos que o real emite. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void; matou: boolean };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.matou = false;
  child.kill = () => { child.matou = true; };
  return child;
}

// ── O crash do print ───────────────────────────────────────────────────────

test('um EACCES assíncrono vira falha tratada, e não exceção que fecha o app', async () => {
  const child = fakeChild();
  const pending = launchElevatedInstaller('C:\\updates\\Tumacord-0.9.9-1-Setup.exe', {
    spawnFn: () => child,
    env: { SystemRoot: 'C:\\Windows' },
  });
  // Exatamente o evento do print. Sem ouvinte, o Node o lança como exceção não
  // tratada e o processo principal morre.
  const failure = Object.assign(new Error('spawn C:\\updates\\Tumacord-0.9.9-1-Setup.exe EACCES'), { code: 'EACCES' });
  child.emit('error', failure);

  const outcome = await pending;
  assert.equal(outcome.started, false);
  assert.equal(outcome.cause, 'access-denied');
  assert.match(outcome.error ?? '', /EACCES/, 'o erro original é preservado para o suporte');
});

test('uma falha síncrona de spawn também é tratada', async () => {
  const outcome = await launchElevatedInstaller('C:\\updates\\Setup.exe', {
    spawnFn: () => { throw Object.assign(new Error('spawn powershell.exe ENOENT'), { code: 'ENOENT' }); },
    env: { SystemRoot: 'C:\\Windows' },
  });
  assert.equal(outcome.started, false);
  // ENOENT do próprio spawn é o PowerShell que falta, não o instalador.
  assert.equal(outcome.cause, 'launcher-missing');
});

test('a operação não termina duas vezes quando erro e fechamento chegam juntos', async () => {
  const child = fakeChild();
  const pending = launchElevatedInstaller('C:\\updates\\Setup.exe', { spawnFn: () => child, env: {} });
  child.emit('error', Object.assign(new Error('falhou'), { code: 'EACCES' }));
  child.emit('close', 1);
  const outcome = await pending;
  assert.equal(outcome.cause, 'access-denied', 'o primeiro desfecho é o que vale');
});

// ── Sucesso é o processo confirmado, não "o comando voltou" ────────────────

test('só há sucesso quando o instalador confirma o processo criado', async () => {
  const child = fakeChild();
  const pending = launchElevatedInstaller('C:\\updates\\Setup.exe', { spawnFn: () => child, env: {} });
  child.stdout.emit('data', 'TUMACORD_PID=4812\n');
  child.emit('close', 0);
  assert.deepEqual(await pending, { started: true, pid: 4812 });
});

test('sair com código zero sem PID não é sucesso', async () => {
  const child = fakeChild();
  const pending = launchElevatedInstaller('C:\\updates\\Setup.exe', { spawnFn: () => child, env: {} });
  // Instalação não é "processo criado", e muito menos "comando voltou".
  child.emit('close', 0);
  const outcome = await pending;
  assert.equal(outcome.started, false);
  assert.equal(outcome.cause, 'unknown');
});

// ── UAC ────────────────────────────────────────────────────────────────────

test('o UAC cancelado é distinguido de permissão negada', async () => {
  const child = fakeChild();
  const pending = launchElevatedInstaller('C:\\updates\\Setup.exe', { spawnFn: () => child, env: {} });
  child.stderr.emit('data', 'TUMACORD_UAC_CANCELADO');
  child.emit('close', 4);
  const outcome = await pending;
  assert.equal(outcome.cause, 'uac-cancelled');
  assert.match(failureMessage('uac-cancelled'), /continua aberto e na versão de antes/);
  assert.notEqual(failureMessage('uac-cancelled'), failureMessage('access-denied'));
});

test('a espera pela confirmação tem fim, e desistir não é "instalou"', async () => {
  const child = fakeChild();
  const outcome = await launchElevatedInstaller('C:\\updates\\Setup.exe', { spawnFn: () => child, env: {}, timeoutMs: 5 });
  assert.equal(outcome.started, false);
  assert.equal(outcome.cause, 'timeout');
  assert.equal(child.matou, true, 'o lançador pendurado é encerrado');
});

// ── O caminho do arquivo não vira comando ──────────────────────────────────

test('o caminho do instalador viaja por ambiente, nunca concatenado no comando', async () => {
  const dangerous = 'C:\\updates\\Setup.exe"; Remove-Item C:\\ -Recurse; "';
  let seen: { args: string[]; env: Record<string, string> } | null = null;
  const child = fakeChild();
  const pending = launchElevatedInstaller(dangerous, {
    spawnFn: (_cmd: string, args: string[], options: { env: Record<string, string> }) => { seen = { args, env: options.env }; return child; },
    env: { SystemRoot: 'C:\\Windows' },
  });
  child.stdout.emit('data', 'TUMACORD_PID=1\n');
  child.emit('close', 0);
  await pending;

  assert.ok(seen, 'o lançador foi chamado');
  const { args, env } = seen as unknown as { args: string[]; env: Record<string, string> };
  assert.equal(env.TUMACORD_INSTALADOR, dangerous, 'o caminho vai pelo ambiente');
  for (const argument of args) {
    assert.equal(argument.includes('Setup.exe'), false, 'nenhum argumento carrega o caminho');
  }
  assert.equal(args.includes('-NoProfile'), true);
  // `shell: true` transformaria o nome do arquivo em linha de comando.
  assert.equal(ELEVATION_SCRIPT.includes('$env:TUMACORD_INSTALADOR'), true);
});

test('o verbo pedido é o que mostra o UAC', () => {
  assert.match(ELEVATION_SCRIPT, /-Verb RunAs/, 'CreateProcess não eleva; ShellExecuteEx com RunAs eleva');
  assert.match(ELEVATION_SCRIPT, /-PassThru/, 'sem o processo devolvido não há como confirmar que começou');
  assert.match(defaultPowerShell({ SystemRoot: 'C:\\Windows' }), /System32[\\/]WindowsPowerShell/);
});

// ── O arquivo é conferido de novo antes de receber administrador ───────────

test('o arquivo é reconferido imediatamente antes de executar', () => {
  const folder = mkdtempSync(path.join(tmpdir(), 'tumacord-instalador-'));
  try {
    const installerFile = path.join(folder, 'Setup.exe');
    writeFileSync(installerFile, 'conteudo do instalador');
    const digest = '9ff5b9b1e0e9a0f1dd0f0ba4b2e2e4b1a4a0e0b9c9d8e7f6a5b4c3d2e1f0a9b8';

    assert.equal(verifyInstallerFile(path.join(folder, 'nao-existe.exe')).ok, false);
    assert.equal(verifyInstallerFile(path.join(folder, 'nao-existe.exe')).cause, 'missing-file');

    writeFileSync(path.join(folder, 'vazio.exe'), '');
    assert.equal(verifyInstallerFile(path.join(folder, 'vazio.exe')).cause, 'empty-file');

    // Um arquivo trocado depois da verificação do download não é executado.
    assert.equal(verifyInstallerFile(installerFile, digest).cause, 'hash-mismatch');
    assert.equal(verifyInstallerFile(installerFile).ok, true, 'sem resumo esperado, existir e não estar vazio basta');
    assert.equal(verifyInstallerFile(installerFile, '', { hashFile: () => digest }).ok, true);
    assert.equal(verifyInstallerFile(installerFile, digest, { hashFile: () => digest }).ok, true);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

// ── O diagnóstico não conclui além do que observou ────────────────────────

test('EACCES não é lido como prova de uma causa única', () => {
  // Ele é classificado como "acesso negado" porque é o que o sistema disse —
  // e a mensagem correspondente não afirma o motivo, porque ele não foi
  // observado. Elevação necessária, antivírus e política de máquina chegam
  // todos assim.
  assert.equal(classifyLaunchFailure({ code: 'EACCES' }), 'access-denied');
  assert.match(failureMessage('access-denied'), /costuma ser/, 'a mensagem não afirma a causa');
  assert.match(failureMessage('access-denied'), /à mão/, 'e oferece a saída que sempre existe');
});

test('cada falha conhecida tem causa própria e mensagem própria, em português', () => {
  const causes = ['missing-file', 'empty-file', 'hash-mismatch', 'uac-cancelled', 'access-denied', 'sharing-violation', 'launcher-missing', 'timeout', 'installer-exit', 'unknown'];
  const messages = new Set(causes.map(failureMessage));
  assert.equal(messages.size, causes.length, 'duas causas com a mesma mensagem escondem uma delas');
  for (const eachCause of causes) assert.ok(failureMessage(eachCause).length > 20, eachCause);
});

test('arquivo em uso por outro programa é distinguido', () => {
  assert.equal(classifyLaunchFailure({ code: 'EBUSY' }), 'sharing-violation');
  assert.equal(classifyLaunchFailure({ stderr: 'The process cannot access the file because it is being used by another process' }), 'sharing-violation');
});

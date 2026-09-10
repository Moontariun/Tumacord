import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

// Aplicar uma atualização é a única coisa que este aplicativo faz fora da
// própria pasta de dados: ele mexe na instalação. Os casos abaixo exercitam
// cada caminho de aplicação contra um disco de verdade, em pasta temporária,
// porque um erro aqui não aparece como tela de erro — aparece como uma
// instalação que não abre mais.

const require = createRequire(import.meta.url);
const { Updater, isAllowedUrl, safeFileName, sanitizeState } = require('../desktop/updater.cjs') as {
  Updater: new (options: Record<string, unknown>) => any;
  isAllowedUrl: (candidate: unknown) => boolean;
  safeFileName: (name: unknown) => string;
  sanitizeState: (input: unknown) => { enabled: boolean; lastCheck: number; dismissed: string; notesSeen: string };
};

// Trocar o atalho `current` é um `rename` de symlink, e o Windows recusa isso
// sem privilégio. O que depende disso é pulado lá; o resto — inclusive o
// caminho do portable, que é do Windows — roda nos dois sistemas.
const SO_POSIX = process.platform === 'win32' ? 'trocar symlink exige privilégio no Windows' : false;

function ambiente(t: { after: (fn: () => void) => void }, extra: Record<string, unknown> = {}) {
  const raiz = mkdtempSync(path.join(tmpdir(), 'tumacord-updater-'));
  t.after(() => rmSync(raiz, { recursive: true, force: true }));
  const app = {
    getVersion: () => '0.9.0',
    getPath: (nome: string) => {
      const destino = path.join(raiz, nome);
      mkdirSync(destino, { recursive: true });
      return destino;
    },
  };
  const updater = new Updater({ app, env: {}, platform: 'linux', log: () => {}, ...extra });
  return { raiz, app, updater };
}

// O endereço do arquivo vem de uma resposta da rede. Se ela mandasse baixar de
// qualquer lugar, seria de qualquer lugar que viria o executável.
test('só endereço https do GitHub é aceito para baixar', () => {
  assert.equal(isAllowedUrl('https://api.github.com/repos/Moontariun/Tumacord/releases'), true);
  assert.equal(isAllowedUrl('https://github.com/x/y/releases/download/v1/a.exe'), true);
  assert.equal(isAllowedUrl('https://objects.githubusercontent.com/a/b'), true);
  for (const ruim of [
    'http://github.com/x/y', 'https://github.com.exemplo.com/x', 'https://exemplo.com/a.exe',
    'file:///etc/passwd', 'https://githubusercontent.com.mau.site/a', '', null, 42,
  ]) assert.equal(isAllowedUrl(ruim), false, `aceitou ${JSON.stringify(ruim)}`);
});

test('o nome do arquivo baixado não sai da pasta de downloads', () => {
  assert.equal(safeFileName('../../.bashrc'), '.bashrc');
  assert.equal(safeFileName('/etc/passwd'), 'passwd');
  assert.equal(safeFileName('Tumacord-0.9.0-Setup.exe'), 'Tumacord-0.9.0-Setup.exe');
  assert.equal(safeFileName('..'), 'tumacord-atualizacao');
  assert.equal(safeFileName(''), 'tumacord-atualizacao');
  assert.equal(safeFileName(null), 'tumacord-atualizacao');
});

test('preferência corrompida no disco não impede o aplicativo de abrir', () => {
  assert.deepEqual(sanitizeState(null), { enabled: true, lastCheck: 0, dismissed: '', notesSeen: '' });
  assert.deepEqual(sanitizeState({ enabled: 'talvez', lastCheck: 'ontem', dismissed: 42, notesSeen: [] }), { enabled: true, lastCheck: 0, dismissed: '', notesSeen: '' });
  assert.deepEqual(sanitizeState({ enabled: false, lastCheck: 10, dismissed: '0.9.1', notesSeen: '0.9.0' }), { enabled: false, lastCheck: 10, dismissed: '0.9.1', notesSeen: '0.9.0' });
});

// "O que mudou" aparece uma vez por versão. A marca fica no disco da máquina,
// e não no navegador: quem limpar os dados do site não volta a ver o changelog
// de uma versão que já leu.
test('o changelog visto fica marcado no disco, por versão', (t) => {
  const { raiz, updater } = ambiente(t);
  assert.equal(updater.state().notesSeen, '');
  updater.markNotesSeen('');
  assert.equal(updater.state().notesSeen, '0.9.0', 'sem argumento, marca a versão instalada');

  const arquivo = path.join(raiz, 'userData', 'update-state.json');
  assert.equal(JSON.parse(readFileSync(arquivo, 'utf8')).notesSeen, '0.9.0');

  const { updater: outro } = ambiente(t, { stateFile: arquivo });
  assert.equal(outro.state().notesSeen, '0.9.0', 'a marca sobrevive a fechar e abrir');
});

test('ignorar uma versão e desligar a procura ficam guardados', (t) => {
  const { updater } = ambiente(t);
  updater.update({ version: '0.9.1' });
  updater.dismiss('');
  updater.setEnabled(false);
  assert.equal(updater.state().dismissed, '0.9.1');
  assert.equal(updater.state().enabled, false);
});

// A instalação do Linux vive em pastas imutáveis com um atalho `current`. É
// isso que permite atualizar durante uma call: a sessão aberta continua lendo a
// pasta antiga, que ninguém tocou.
test('no Linux gerenciado, a build nova entra ao lado e só o atalho muda', { skip: SO_POSIX }, (t) => {
  const { raiz, updater } = ambiente(t, { kind: 'linux-managed' });
  const dataHome = path.join(raiz, 'home', '.local', 'share');
  updater.env = { XDG_DATA_HOME: dataHome };
  updater.app.getPath = (nome: string) => (nome === 'home' ? path.join(raiz, 'home') : path.join(raiz, nome));

  // Uma instalação anterior, com o atalho apontando para ela.
  const versoes = path.join(dataHome, 'tumacord', 'versions');
  const antiga = path.join(versoes, '0.8.8-aaaaaaaaaaaa');
  mkdirSync(antiga, { recursive: true });
  writeFileSync(path.join(antiga, 'tumacord'), 'binário antigo', 'utf8');
  execFileSync('ln', ['-s', antiga, path.join(dataHome, 'tumacord', 'current')]);

  // O pacote da versão nova, como o electron-builder o publica.
  const conteudo = mkdtempSync(path.join(tmpdir(), 'tumacord-pacote-'));
  t.after(() => rmSync(conteudo, { recursive: true, force: true }));
  const dentro = path.join(conteudo, 'tumacord-0.9.1');
  mkdirSync(path.join(dentro, 'resources'), { recursive: true });
  writeFileSync(path.join(dentro, 'tumacord'), 'binário novo', 'utf8');
  writeFileSync(path.join(dentro, 'resources', 'app.asar'), 'código', 'utf8');
  const pacote = path.join(conteudo, 'tumacord-0.9.1.tar.gz');
  execFileSync('tar', ['-czf', pacote, '-C', conteudo, 'tumacord-0.9.1']);

  const aplicado = updater.applyFile(pacote, '0.9.1');
  assert.equal(aplicado.restart, 'now');

  const atual = realpathSync(path.join(dataHome, 'tumacord', 'current'));
  assert.match(atual, /0\.9\.1-[0-9a-f]{12}$/, 'o atalho aponta para a pasta da versão nova');
  assert.equal(readFileSync(path.join(atual, 'tumacord'), 'utf8'), 'binário novo');
  assert.equal(readFileSync(path.join(antiga, 'tumacord'), 'utf8'), 'binário antigo', 'a versão de antes continua intacta');
  assert.equal(realpathSync(path.join(dataHome, 'tumacord', 'previous')), antiga, 'e continua alcançável para voltar');
  assert.equal(readFileSync(path.join(dataHome, 'tumacord', 'version'), 'utf8').trim(), '0.9.1');
  assert.equal(existsSync(pacote), false, 'o arquivo baixado não fica ocupando disco depois de aplicado');
});

test('um pacote sem o executável não vira instalação', (t) => {
  const { raiz, updater } = ambiente(t, { kind: 'linux-managed' });
  const dataHome = path.join(raiz, 'home', '.local', 'share');
  updater.env = { XDG_DATA_HOME: dataHome };
  updater.app.getPath = (nome: string) => (nome === 'home' ? path.join(raiz, 'home') : path.join(raiz, nome));

  const conteudo = mkdtempSync(path.join(tmpdir(), 'tumacord-pacote-'));
  t.after(() => rmSync(conteudo, { recursive: true, force: true }));
  mkdirSync(path.join(conteudo, 'outra-coisa'));
  writeFileSync(path.join(conteudo, 'outra-coisa', 'leiame.txt'), 'nada aqui', 'utf8');
  const pacote = path.join(conteudo, 'errado.tar.gz');
  execFileSync('tar', ['-czf', pacote, '-C', conteudo, 'outra-coisa']);

  assert.throws(() => updater.applyFile(pacote, '0.9.1'), /não contém o executável/);
  assert.equal(existsSync(path.join(dataHome, 'tumacord', 'current')), false, 'nenhum atalho é criado apontando para nada');
});

// O AppImage em execução continua montado a partir do arquivo aberto: trocar o
// arquivo por baixo é seguro, e é o que o próprio formato espera.
test('o AppImage é substituído no lugar onde ele já estava', (t) => {
  const { raiz, updater } = ambiente(t, { kind: 'linux-appimage' });
  const instalado = path.join(raiz, 'Tumacord.AppImage');
  writeFileSync(instalado, 'appimage antigo', 'utf8');
  updater.env = { APPIMAGE: instalado };

  const baixado = path.join(raiz, 'Tumacord-0.9.1.AppImage');
  writeFileSync(baixado, 'appimage novo', 'utf8');

  const aplicado = updater.applyFile(baixado, '0.9.1');
  assert.equal(aplicado.restart, 'now');
  assert.equal(readFileSync(instalado, 'utf8'), 'appimage novo');
  assert.equal(existsSync(baixado), false);
  assert.equal(existsSync(`${instalado}.novo`), false, 'nenhum arquivo pela metade fica para trás');
});

// Um portable não se substitui em execução: o Windows mantém o arquivo do
// processo bloqueado. O certo é deixar o novo ao lado e dizer isso.
test('o portable novo fica ao lado do que está rodando, e a pessoa é avisada', (t) => {
  const { raiz, updater } = ambiente(t, { kind: 'windows-portable', platform: 'win32' });
  const pasta = path.join(raiz, 'pendrive');
  mkdirSync(pasta, { recursive: true });
  const rodando = path.join(pasta, 'Tumacord-0.9.0-portable.exe');
  writeFileSync(rodando, 'portable antigo', 'utf8');
  updater.env = { PORTABLE_EXECUTABLE_FILE: rodando };

  const baixado = path.join(raiz, 'Tumacord-0.9.1-portable.exe');
  writeFileSync(baixado, 'portable novo', 'utf8');

  const aplicado = updater.applyFile(baixado, '0.9.1');
  assert.equal(aplicado.restart, 'manual');
  assert.equal(aplicado.folder, pasta);
  assert.match(aplicado.message, /Feche o Tumacord/);
  assert.equal(readFileSync(path.join(pasta, 'Tumacord-0.9.1-portable.exe'), 'utf8'), 'portable novo');
  assert.equal(readFileSync(rodando, 'utf8'), 'portable antigo', 'o que está rodando não é tocado');
});

// Uma cópia que não caiu em nenhum caminho conhecido não escreve nada em lugar
// nenhum — ela diz o que sabe e para por aí.
test('sem saber como esta cópia foi instalada, nada é aplicado', (t) => {
  const { updater } = ambiente(t, { kind: 'unknown' });
  assert.throws(() => updater.applyFile('/tmp/qualquer-coisa', '0.9.1'), /saiba atualizar sozinho/);
});

test('aplicar sem ter baixado não faz nada', async (t) => {
  const { updater } = ambiente(t, { kind: 'linux-appimage' });
  const estado = await updater.apply();
  assert.equal(estado.phase, 'idle');
  assert.equal(estado.applied, null);
});

// O aviso à interface é o que desenha a barra de progresso e o botão. Uma
// janela que já fechou não pode derrubar a atualização junto.
test('um ouvinte que explode não interrompe a atualização', (t) => {
  const { updater } = ambiente(t);
  updater.onChange(() => { throw new Error('a janela fechou'); });
  let recebido = '';
  updater.onChange((estado: { phase: string }) => { recebido = estado.phase; });
  assert.doesNotThrow(() => updater.update({ phase: 'available' }));
  assert.equal(recebido, 'available');
});

test('o estado devolvido é uma cópia, não a memória do atualizador', (t) => {
  const { updater } = ambiente(t);
  const estado = updater.state();
  estado.progress.received = 999;
  estado.phase = 'inventado';
  assert.equal(updater.state().progress.received, 0);
  assert.equal(updater.state().phase, 'idle');
});

test('o atalho `previous` some do caminho quando a pasta da versão é a mesma', { skip: SO_POSIX }, (t) => {
  const { raiz, updater } = ambiente(t, { kind: 'linux-managed' });
  const dataHome = path.join(raiz, 'home', '.local', 'share');
  updater.env = { XDG_DATA_HOME: dataHome };
  updater.app.getPath = (nome: string) => (nome === 'home' ? path.join(raiz, 'home') : path.join(raiz, nome));

  const conteudo = mkdtempSync(path.join(tmpdir(), 'tumacord-pacote-'));
  t.after(() => rmSync(conteudo, { recursive: true, force: true }));
  const dentro = path.join(conteudo, 'tumacord-0.9.1');
  mkdirSync(dentro, { recursive: true });
  writeFileSync(path.join(dentro, 'tumacord'), 'binário novo', 'utf8');
  const pacote = path.join(conteudo, 'pacote.tar.gz');
  execFileSync('tar', ['-czf', pacote, '-C', conteudo, 'tumacord-0.9.1']);

  updater.applyFile(pacote, '0.9.1');
  const atual = readlinkSync(path.join(dataHome, 'tumacord', 'current'));

  // Aplicar de novo o mesmo pacote não pode apagar a instalação em uso.
  execFileSync('tar', ['-czf', pacote, '-C', conteudo, 'tumacord-0.9.1']);
  updater.applyFile(pacote, '0.9.1');
  assert.equal(readlinkSync(path.join(dataHome, 'tumacord', 'current')), atual);
  assert.equal(existsSync(path.join(atual, 'tumacord')), true);
});

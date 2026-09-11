import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeSession,
  destinations,
  emptyKeyring,
  endSession,
  forgetDestination,
  forgetEverything,
  keyAt,
  migrateSingleSession,
  putSession,
  rememberKey,
  sessionAt,
  switchTo,
  type SavedSession,
} from '../src/lib/keyring';
import { originFor } from '../src/lib/origin';

// Até a 0.9.5 havia uma gaveta só: entrar num servidor dedicado escrevia por
// cima do que o P2P lembrava, e um convite para outro destino derrubava tudo —
// inclusive contas que nada tinham a ver com aquele convite.

function sessao(username: string, extra: Partial<SavedSession> = {}): SavedSession {
  return {
    serverUrl: 'https://casa:4600',
    token: `token-de-${username}`,
    user: { id: username.toLowerCase(), username },
    serverName: 'Casa',
    connectionMode: 'server',
    rememberMe: true,
    ...extra,
  };
}

const casa = originFor({ connectionMode: 'server', installationId: 'instalacao-casa' });
const trabalho = originFor({ connectionMode: 'server', installationId: 'instalacao-trabalho' });
const grupo = originFor({ connectionMode: 'p2p', inviteKey: 'convite-do-grupo' });

test('entrar em um destino não apaga o que os outros lembram', () => {
  let chaveiro = putSession(emptyKeyring(), casa, sessao('Renan'));
  chaveiro = putSession(chaveiro, grupo, sessao('Renan', { connectionMode: 'p2p', inviteKey: 'convite-do-grupo' }));
  chaveiro = putSession(chaveiro, trabalho, sessao('Outro'));

  assert.equal(destinations(chaveiro).length, 3);
  assert.equal(activeSession(chaveiro)?.user.username, 'Outro', 'o último aberto é o ativo');
  assert.ok(sessionAt(chaveiro, casa), 'a de casa continua lá');
  assert.ok(sessionAt(chaveiro, grupo), 'a do grupo também');
});

test('trocar de destino só muda qual gaveta está aberta', () => {
  let chaveiro = putSession(emptyKeyring(), casa, sessao('Renan'));
  chaveiro = putSession(chaveiro, grupo, sessao('Renan', { connectionMode: 'p2p' }));
  chaveiro = switchTo(chaveiro, casa);
  assert.equal(activeSession(chaveiro)?.serverName, 'Casa');
  assert.equal(destinations(chaveiro).length, 2, 'nada foi encerrado');
});

// As quatro operações têm efeitos diferentes, e o documento do projeto pede que
// eles sejam distintos e ditos.
test('sair da conta encerra só a sessão aberta', () => {
  let chaveiro = putSession(emptyKeyring(), casa, sessao('Renan'));
  chaveiro = putSession(chaveiro, trabalho, sessao('Outro'));
  chaveiro = rememberKey(chaveiro, trabalho, 'chave-do-trabalho');

  chaveiro = endSession(chaveiro, trabalho);
  assert.equal(sessionAt(chaveiro, trabalho), null, 'a sessão saiu');
  assert.equal(keyAt(chaveiro, trabalho), 'chave-do-trabalho', 'a chave fica: quem sai costuma voltar');
  assert.ok(sessionAt(chaveiro, casa), 'a outra conta não foi tocada');
  assert.equal(activeSession(chaveiro), null);
});

test('esquecer um destino leva a sessão e a chave dele, e mais nada', () => {
  let chaveiro = putSession(emptyKeyring(), casa, sessao('Renan'));
  chaveiro = rememberKey(rememberKey(chaveiro, casa, 'chave-de-casa'), trabalho, 'chave-do-trabalho');
  chaveiro = putSession(chaveiro, trabalho, sessao('Outro'));

  chaveiro = forgetDestination(chaveiro, casa);
  assert.equal(sessionAt(chaveiro, casa), null);
  assert.equal(keyAt(chaveiro, casa), '');
  assert.ok(sessionAt(chaveiro, trabalho));
  assert.equal(keyAt(chaveiro, trabalho), 'chave-do-trabalho');
});

test('esquecer tudo é o único caminho que esvazia o chaveiro', () => {
  let chaveiro = putSession(emptyKeyring(), casa, sessao('Renan'));
  chaveiro = putSession(chaveiro, trabalho, sessao('Outro'));
  assert.deepEqual(forgetEverything(), emptyKeyring());
  assert.equal(destinations(chaveiro).length, 2, 'e ele não é chamado por engano pelos outros');
});

// --- as quatro combinações de lembrar sessão e lembrar chave ---------------

test('lembrar sessão e lembrar chave são escolhas independentes', () => {
  // 1. lembra as duas
  let chaveiro = rememberKey(putSession(emptyKeyring(), casa, sessao('Renan', { rememberMe: true })), casa, 'chave');
  assert.ok(chaveiro.remembered[casa], 'sessão entre aberturas');
  assert.equal(keyAt(chaveiro, casa), 'chave');

  // 2. lembra a sessão, não a chave
  chaveiro = rememberKey(putSession(emptyKeyring(), casa, sessao('Renan', { rememberMe: true })), casa, '');
  assert.ok(chaveiro.remembered[casa]);
  assert.equal(keyAt(chaveiro, casa), '');

  // 3. não lembra a sessão, lembra a chave
  chaveiro = rememberKey(putSession(emptyKeyring(), casa, sessao('Renan', { rememberMe: false })), casa, 'chave');
  assert.equal(chaveiro.remembered[casa], undefined, 'a sessão vale só nesta abertura');
  assert.ok(chaveiro.ephemeral[casa]);
  assert.equal(keyAt(chaveiro, casa), 'chave', 'a chave sobrevive à abertura seguinte');

  // 4. não lembra nenhuma das duas
  chaveiro = putSession(emptyKeyring(), casa, sessao('Renan', { rememberMe: false }));
  assert.equal(chaveiro.remembered[casa], undefined);
  assert.equal(keyAt(chaveiro, casa), '');
});

test('mudar de ideia sobre lembrar não deixa uma cópia antiga de pé', () => {
  let chaveiro = putSession(emptyKeyring(), casa, sessao('Renan', { rememberMe: true }));
  chaveiro = putSession(chaveiro, casa, sessao('Renan', { rememberMe: false }));
  assert.equal(chaveiro.remembered[casa], undefined, 'a que era lembrada saiu');
  assert.ok(chaveiro.ephemeral[casa]);

  chaveiro = putSession(chaveiro, casa, sessao('Renan', { rememberMe: true }));
  assert.equal(chaveiro.ephemeral[casa], undefined);
  assert.ok(chaveiro.remembered[casa]);
});

// --- a gaveta única de antes -----------------------------------------------

test('a sessão antiga é convertida, e o campo que servia para duas coisas se separa', () => {
  const antiga: SavedSession = {
    serverUrl: 'https://casa:4600', token: 'token-antigo', user: { id: 'r', username: 'Renan' },
    serverName: 'Casa', connectionMode: 'server', rememberMe: true, directKey: 'chave-de-acesso',
  };
  const chaveiro = migrateSingleSession(emptyKeyring(), antiga, (session) => originFor({
    connectionMode: session.connectionMode ?? 'p2p', serverUrl: session.serverUrl, inviteKey: session.inviteKey ?? session.directKey,
  }));
  const destino = originFor({ connectionMode: 'server', serverUrl: 'https://casa:4600' });
  const convertida = sessionAt(chaveiro, destino);
  assert.equal(convertida?.token, 'token-antigo');
  assert.equal(convertida?.inviteKey, undefined, 'num servidor, aquilo era chave de acesso, não convite');
  assert.equal(keyAt(chaveiro, destino), 'chave-de-acesso', 'e ela foi para a gaveta de chaves');
});

test('no P2P, o mesmo campo antigo vira a chave do convite', () => {
  const antiga: SavedSession = {
    serverUrl: 'http://127.0.0.1:3927', token: 'token-antigo', user: { id: 'r', username: 'Renan' },
    serverName: 'Tumacord', connectionMode: 'p2p', rememberMe: true, directKey: 'convite-do-grupo',
  };
  const chaveiro = migrateSingleSession(emptyKeyring(), antiga, (session) => originFor({
    connectionMode: session.connectionMode ?? 'p2p', serverUrl: session.serverUrl, inviteKey: session.inviteKey ?? session.directKey,
  }));
  const convertida = sessionAt(chaveiro, grupo);
  assert.equal(convertida?.inviteKey, 'convite-do-grupo');
  assert.equal(keyAt(chaveiro, grupo), '', 'e não vira chave de acesso de servidor nenhum');
});

test('a conversão não acontece duas vezes nem por cima de algo mais novo', () => {
  const destino = originFor({ connectionMode: 'server', serverUrl: 'https://casa:4600' });
  const comAtual = putSession(emptyKeyring(), destino, sessao('Renan', { token: 'token-novo' }));
  const antiga: SavedSession = { ...sessao('Renan'), token: 'token-antigo', installationId: undefined };
  const depois = migrateSingleSession(comAtual, antiga, () => destino);
  assert.equal(sessionAt(depois, destino)?.token, 'token-novo');
});

test('sem sessão antiga não há o que converter', () => {
  assert.deepEqual(migrateSingleSession(emptyKeyring(), null, () => casa), emptyKeyring());
});

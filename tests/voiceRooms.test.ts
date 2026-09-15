import assert from 'node:assert/strict';
import test from 'node:test';
import { VoiceRooms } from '../server/voiceRooms.js';

test('o primeiro participante vira host e o menor ping assume sem recriar a sala', () => {
  const rooms = new VoiceRooms();
  rooms.join('call', { id: 'a', username: 'Ana', socketId: 'socket-a', endpoint: 'http://10.0.0.1:3927' });
  rooms.join('call', { id: 'b', username: 'Beto', socketId: 'socket-b', endpoint: 'http://10.0.0.2:3927' });
  rooms.join('call', { id: 'c', username: 'Caio', socketId: 'socket-c', endpoint: 'http://10.0.0.3:3927' });
  rooms.updatePing('call', 'socket-b', 42);
  rooms.updatePing('call', 'socket-c', 18);

  assert.equal(rooms.members('call')[0].isHost, true);
  const afterLeaving = rooms.leave('call', 'socket-a');
  assert.equal(afterLeaving.length, 2);
  assert.equal(afterLeaving[0].username, 'Beto');
  assert.equal(afterLeaving[0].isHost, false);
  assert.equal(afterLeaving[1].username, 'Caio');
  assert.equal(afterLeaving[1].isHost, true);
});

test('estado de mídia atualiza sem alterar o host', () => {
  const rooms = new VoiceRooms();
  rooms.join('call', { id: 'a', username: 'Ana', socketId: 'socket-a', endpoint: 'http://10.0.0.1:3927' });
  const members = rooms.update('call', 'socket-a', { muted: true, screen: true, screenAudio: true });
  assert.deepEqual({ host: members[0].isHost, muted: members[0].muted, screen: members[0].screen, screenAudio: members[0].screenAudio }, { host: true, muted: true, screen: true, screenAudio: true });
});

test('entrada ou retorno de outro usuário não apaga uma live existente', () => {
  const rooms = new VoiceRooms();
  rooms.join('call', { id: 'a', username: 'Ana', socketId: 'socket-a', endpoint: 'http://10.0.0.1:3927' });
  rooms.update('call', 'socket-a', { screen: true, camera: true });

  rooms.join('call', { id: 'b', username: 'Beto', socketId: 'socket-b-1', endpoint: 'http://10.0.0.2:3927' });
  rooms.leave('call', 'socket-b-1');
  rooms.join('call', { id: 'b', username: 'Beto', socketId: 'socket-b-2', endpoint: 'http://10.0.0.2:3927' });

  const streamer = rooms.members('call').find((member) => member.id === 'a');
  assert.deepEqual({ screen: streamer?.screen, camera: streamer?.camera }, { screen: true, camera: true });
});

test('estado impossível de áudio/tela e fala/mute é normalizado', () => {
  const rooms = new VoiceRooms();
  rooms.join('call', { id: 'a', username: 'Ana', socketId: 'socket-a', endpoint: 'http://10.0.0.1:3927' });
  rooms.update('call', 'socket-a', { screen: true, screenAudio: true, speaking: true });
  const [muted] = rooms.update('call', 'socket-a', { muted: true });
  assert.equal(muted.speaking, false);
  const [stopped] = rooms.update('call', 'socket-a', { screen: false });
  assert.equal(stopped.screenAudio, false);
});

test('a lista de lives assistidas e o campo antigo contam a mesma história', () => {
  const rooms = new VoiceRooms();
  rooms.join('call', { id: 'a', username: 'Ana', socketId: 'socket-a', endpoint: 'http://10.0.0.1:3927' });
  let [ana] = rooms.update('call', 'socket-a', { watchingAll: ['socket-b', 'socket-c'] });
  assert.deepEqual({ watching: ana.watching, all: ana.watchingAll }, { watching: 'socket-b', all: ['socket-b', 'socket-c'] });
  // Um cliente anterior à 0.13.5 manda só o campo antigo.
  [ana] = rooms.update('call', 'socket-a', { watching: 'socket-c' });
  assert.deepEqual(ana.watchingAll, ['socket-c']);
  [ana] = rooms.update('call', 'socket-a', { watching: '' });
  assert.deepEqual(ana.watchingAll, []);
});

test('quem está sem permissão de falar entra mudo e não consegue se desmutar', () => {
  const rooms = new VoiceRooms();
  let [ana] = rooms.join('call', { id: 'a', username: 'Ana', socketId: 'socket-a', endpoint: 'http://10.0.0.1:3927', speakBlocked: true });
  assert.equal(ana.muted, true);
  [ana] = rooms.update('call', 'socket-a', { muted: false, speaking: true });
  assert.deepEqual({ muted: ana.muted, speaking: ana.speaking }, { muted: true, speaking: false });
  assert.equal(rooms.setSpeakBlocked('call', 'a', false), true);
  [ana] = rooms.update('call', 'socket-a', { muted: false });
  assert.equal(ana.muted, false);
  assert.equal(rooms.setSpeakBlocked('call', 'a', false), false, 'nada mudou, nada a avisar');
});

test('a administração troca o host: só uma pessoa fica com a coroa', () => {
  const rooms = new VoiceRooms();
  rooms.join('call', { id: 'a', username: 'Ana', socketId: 'socket-a', endpoint: 'http://10.0.0.1:3927' });
  rooms.join('call', { id: 'b', username: 'Beto', socketId: 'socket-b', endpoint: 'http://10.0.0.2:3927' });
  rooms.join('call', { id: 'c', username: 'Caio', socketId: 'socket-c', endpoint: 'http://10.0.0.3:3927' });
  assert.equal(rooms.setHost('call', 'socket-c'), true);
  assert.deepEqual(rooms.members('call').map((member) => [member.username, member.isHost]), [['Ana', false], ['Beto', false], ['Caio', true]]);
  assert.equal(rooms.setHost('call', 'socket-fantasma'), false, 'quem não está na sala não vira host');
  assert.equal(rooms.setHost('outra-call', 'socket-a'), false);
  assert.equal(rooms.members('call').filter((member) => member.isHost).length, 1);
});

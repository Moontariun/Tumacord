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

// Quem entra ainda não disse em que sistema está. Até dizer, ninguém desenha na
// tela dele: o padrão seguro é o que não pinta nada na área de trabalho de quem
// talvez não suporte isso.
test('desenho na minha tela começa desligado até o cliente declarar o sistema', () => {
  const rooms = new VoiceRooms();
  const entrou = rooms.join('call', { id: 'a', username: 'Ana', socketId: 'socket-a', endpoint: 'http://10.0.0.1:3927' });
  assert.equal(entrou[0].drawSupported, false);
  assert.equal(entrou[0].allowDraw, true, 'a permissão continua sendo a de sempre; o que falta é o sistema');

  const declarou = rooms.update('call', 'socket-a', { drawSupported: true });
  assert.equal(declarou[0].drawSupported, true);
});

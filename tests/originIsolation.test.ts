import assert from 'node:assert/strict';
import test from 'node:test';
import { originFor } from '../src/lib/origin';

// A origem é o que impede a conversa de um lugar de voltar como se fosse de
// outro. O documento do projeto é explícito sobre o que não serve: nome de
// servidor, apelido e o literal "p2p" não delimitam nada.

test('dois servidores dedicados diferentes não compartilham o mesmo pote', () => {
  const um = originFor({ connectionMode: 'server', installationId: 'aaaa-1111', serverUrl: 'https://casa:4600' });
  const outro = originFor({ connectionMode: 'server', installationId: 'bbbb-2222', serverUrl: 'https://casa:4600' });
  assert.notEqual(um, outro, 'o mesmo endereço pode ser outro servidor');
});

test('o mesmo servidor continua o mesmo depois de mudar de endereço', () => {
  const antes = originFor({ connectionMode: 'server', installationId: 'aaaa-1111', serverUrl: 'https://casa:4600' });
  const depois = originFor({ connectionMode: 'server', installationId: 'aaaa-1111', serverUrl: 'https://outro-endereco:4600' });
  assert.equal(antes, depois);
});

test('servidor que não declara identidade cai no endereço, e ainda separa', () => {
  const um = originFor({ connectionMode: 'server', serverUrl: 'https://casa:4600' });
  const outro = originFor({ connectionMode: 'server', serverUrl: 'https://trabalho:4600' });
  assert.notEqual(um, outro);
  assert.match(um, /^endereco:/);
});

test('dedicado e P2P nunca caem no mesmo pote', () => {
  const dedicado = originFor({ connectionMode: 'server', installationId: 'aaaa-1111' });
  const grupo = originFor({ connectionMode: 'p2p', inviteKey: 'aaaa-1111' });
  assert.notEqual(dedicado, grupo, 'a mesma cadeia de caracteres em papéis diferentes não é a mesma origem');
});

test('dois grupos P2P com convites diferentes não compartilham histórico', () => {
  const grupo = originFor({ connectionMode: 'p2p', inviteKey: 'convite-do-grupo-a' });
  const outro = originFor({ connectionMode: 'p2p', inviteKey: 'convite-do-grupo-b' });
  assert.notEqual(grupo, outro);
});

// O grupo é o mesmo quando o host troca de máquina: é a chave do convite que o
// identifica, e não quem por acaso está hospedando agora.
test('o grupo continua o mesmo quando o host troca', () => {
  const comHost = originFor({ connectionMode: 'p2p', inviteKey: 'convite-do-grupo-a', serverUrl: 'http://192.168.0.10:3927' });
  const comOutroHost = originFor({ connectionMode: 'p2p', inviteKey: 'convite-do-grupo-a', serverUrl: 'http://192.168.0.77:3927' });
  assert.equal(comHost, comOutroHost);
});

test('um grupo só de rede local tem a própria origem, e não a de ninguém', () => {
  const redeLocal = originFor({ connectionMode: 'p2p' });
  assert.equal(redeLocal, 'grupo:rede-local');
  assert.notEqual(redeLocal, originFor({ connectionMode: 'p2p', inviteKey: 'convite' }));
});

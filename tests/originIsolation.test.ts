import assert from 'node:assert/strict';
import test from 'node:test';
import { describeOrigin, originFor, originLabel } from '../src/lib/origin';

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

// Como o destino se apresenta. O nome sozinho não diz o modo: um servidor
// dedicado chamado "Casa do Tuma" e um grupo P2P chamado "Tumacord" apareciam
// iguais na lista de contas guardadas, e escolher entre eles era adivinhar.
test('a etiqueta de um destino diz o modo antes do nome', () => {
  assert.deepEqual(originLabel('servidor:casa', 'Casa do Tuma'), { mode: 'server', place: 'Casa do Tuma' });
  assert.deepEqual(originLabel('endereco:https://casa:4600', 'Casa do Tuma'), { mode: 'server', place: 'Casa do Tuma' });
  assert.deepEqual(originLabel('grupo:convite', 'Tumacord'), { mode: 'p2p', place: 'Tumacord' });
  assert.deepEqual(originLabel('grupo:rede-local'), { mode: 'p2p', place: 'Rede local' });
});

test('um destino sem nome ainda declara o modo', () => {
  assert.equal(originLabel('servidor:casa').mode, 'server');
  assert.equal(originLabel('grupo:convite').mode, 'p2p');
  assert.equal(originLabel('grupo:convite').place, 'Por convite');
});

test('por extenso, o destino cabe no meio de uma frase', () => {
  assert.equal(describeOrigin('servidor:casa', 'Casa do Tuma'), 'no servidor dedicado Casa do Tuma');
  assert.equal(describeOrigin('servidor:casa'), 'no servidor dedicado');
  assert.equal(describeOrigin('grupo:rede-local'), 'no grupo P2P da rede local');
  assert.equal(describeOrigin('grupo:convite', 'Tumacord'), 'no grupo P2P de Tumacord');
  assert.equal(describeOrigin('grupo:convite'), 'no grupo P2P do convite');
});


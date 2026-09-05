import assert from 'node:assert/strict';
import test from 'node:test';
import { ATTEMPT_WINDOW_MS, AuthRateLimiter, BASE_DELAY_MS, FREE_ATTEMPTS, MAX_DELAY_MS } from '../server/rateLimit';

// Medido no servidor sem limite: doze senhas erradas em 595 ms, todas 401.
test('as primeiras tentativas passam; a partir do limite o bloqueio aparece', () => {
  const limiter = new AuthRateLimiter();
  const agora = 1_000_000;
  for (let tentativa = 1; tentativa <= FREE_ATTEMPTS; tentativa += 1) {
    assert.equal(limiter.check('renan', '1.2.3.4', agora).allowed, true, `tentativa ${tentativa} deveria passar`);
    assert.equal(limiter.fail('renan', '1.2.3.4', agora).retryAfterMs, 0);
  }
  const excedeu = limiter.fail('renan', '1.2.3.4', agora);
  assert.equal(excedeu.retryAfterMs, BASE_DELAY_MS);
  assert.equal(limiter.check('renan', '1.2.3.4', agora).allowed, false);
});

test('a espera dobra a cada erro e para de crescer no teto', () => {
  const limiter = new AuthRateLimiter();
  const agora = 1_000_000;
  for (let i = 0; i < FREE_ATTEMPTS; i += 1) limiter.fail('renan', '1.2.3.4', agora);
  const esperas: number[] = [];
  for (let i = 0; i < 12; i += 1) esperas.push(limiter.fail('renan', '1.2.3.4', agora).retryAfterMs);
  assert.deepEqual(esperas.slice(0, 4), [BASE_DELAY_MS, BASE_DELAY_MS * 2, BASE_DELAY_MS * 4, BASE_DELAY_MS * 8]);
  assert.equal(esperas.at(-1), MAX_DELAY_MS);
  assert.ok(esperas.every((espera) => espera <= MAX_DELAY_MS));
});

test('passado o bloqueio, a tentativa seguinte é permitida de novo', () => {
  const limiter = new AuthRateLimiter();
  const agora = 1_000_000;
  for (let i = 0; i <= FREE_ATTEMPTS; i += 1) limiter.fail('renan', '1.2.3.4', agora);
  assert.equal(limiter.check('renan', '1.2.3.4', agora + BASE_DELAY_MS - 1).allowed, false);
  assert.equal(limiter.check('renan', '1.2.3.4', agora + BASE_DELAY_MS + 1).allowed, true);
});

// O objetivo é atrapalhar quem chuta, não quem errou e lembrou depois.
test('acertar a senha zera a contagem', () => {
  const limiter = new AuthRateLimiter();
  const agora = 1_000_000;
  for (let i = 0; i <= FREE_ATTEMPTS + 2; i += 1) limiter.fail('renan', '1.2.3.4', agora);
  assert.equal(limiter.check('renan', '1.2.3.4', agora).allowed, false);
  limiter.succeed('renan', '1.2.3.4');
  assert.equal(limiter.check('renan', '1.2.3.4', agora).allowed, true);
  assert.equal(limiter.check('renan', '1.2.3.4', agora).remaining, FREE_ATTEMPTS);
});

test('a contagem esquece depois da janela, para não punir quem some por horas', () => {
  const limiter = new AuthRateLimiter();
  const agora = 1_000_000;
  for (let i = 0; i <= FREE_ATTEMPTS + 3; i += 1) limiter.fail('renan', '1.2.3.4', agora);
  assert.equal(limiter.check('renan', '1.2.3.4', agora + ATTEMPT_WINDOW_MS + 1).allowed, true);
  assert.equal(limiter.fail('renan', '1.2.3.4', agora + ATTEMPT_WINDOW_MS + 1).retryAfterMs, 0, 'a contagem recomeça do zero');
});

// Limitar só por IP puniria um NAT compartilhado; só por usuário deixaria
// distribuir as tentativas entre máquinas.
test('a contagem é por par usuário e origem', () => {
  const limiter = new AuthRateLimiter();
  const agora = 1_000_000;
  for (let i = 0; i <= FREE_ATTEMPTS; i += 1) limiter.fail('renan', '1.2.3.4', agora);
  assert.equal(limiter.check('renan', '1.2.3.4', agora).allowed, false);
  assert.equal(limiter.check('renan', '9.9.9.9', agora).allowed, true, 'outra origem não herda o bloqueio');
  assert.equal(limiter.check('outra-pessoa', '1.2.3.4', agora).allowed, true, 'outro usuário na mesma casa não é punido');
});

test('o nome do usuário é comparado sem diferenciar maiúsculas', () => {
  const limiter = new AuthRateLimiter();
  const agora = 1_000_000;
  for (let i = 0; i <= FREE_ATTEMPTS; i += 1) limiter.fail('Renan', '1.2.3.4', agora);
  assert.equal(limiter.check('renan', '1.2.3.4', agora).allowed, false, 'trocar a caixa não pode escapar do limite');
});

test('o mapa não cresce sem limite com origens descartáveis', () => {
  const limiter = new AuthRateLimiter(50);
  const agora = 1_000_000;
  for (let i = 0; i < 500; i += 1) limiter.fail('renan', `10.0.0.${i}`, agora + i);
  assert.ok(limiter.size <= 50, `o mapa ficou com ${limiter.size} entradas`);
  assert.equal(limiter.check('renan', '10.0.0.499', agora + 499).allowed, true);
});

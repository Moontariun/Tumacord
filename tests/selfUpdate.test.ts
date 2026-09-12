import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SelfUpdater, executorTokenMatches, selfUpdateConfig, unavailableReason } from '../server/selfUpdate';

// A atualização do servidor pelo painel, do lado que decide se ela acontece.
//
// Este servidor não executa mais nada: ele pede ao executor, que roda no host.
// O que se prova aqui é a conversa — que os caminhos de recusa fecham antes de
// qualquer pedido, que só o identificador da release atravessa, e que o painel
// retoma o trabalho depois de o servidor reiniciar, que é o caso esperado.

const SECRET = 'segredo-do-executor-com-tamanho-suficiente';
const ENABLED = { TUMACORD_SELF_UPDATE: '1', TUMACORD_EXECUTOR_TOKEN: SECRET };

interface RecordedRequest { method: string; url: string; authorization: string; body: unknown }
type Responder = (incoming: RecordedRequest) => { status: number; body: unknown };

/** Um executor de mentira, num socket Unix de verdade. */
async function fakeExecutor(t: { after: (fn: () => unknown) => void }, responder: Responder) {
  const folder = await mkdtemp(path.join(tmpdir(), 'tumacord-exec-falso-'));
  const socketPath = path.join(folder, 'executor.sock');
  const requests: RecordedRequest[] = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', () => {
      const incoming = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: String(request.headers.authorization ?? ''),
        body: text ? JSON.parse(text) : undefined,
      };
      requests.push(incoming);
      const reply = responder(incoming);
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => server.close(resolve));
  };
  t.after(async () => {
    await close();
    await rm(folder, { recursive: true, force: true });
  });
  return { socketPath, requests, close };
}

const catalog = {
  sequence: 3,
  channels: {
    stable: {
      entries: [
        { releaseId: 'rel_stable_0-9-9-1', version: '0.9.9-1', state: 'published' },
        { releaseId: 'rel_stable_0-9-8', version: '0.9.8', state: 'withdrawn', withdrawn: { reason: 'quebra a call' } },
      ],
    },
  },
};

test('o padrão é desligado, e ele é dito', () => {
  const config = selfUpdateConfig({});
  assert.equal(config.enabled, false);
  assert.match(unavailableReason(config), /desligada/);
});

// Um servidor que ganhou esta versão não passa a aceitar troca de código
// porque atualizou: ligar isso é uma decisão de quem hospeda.
test('ligado, sem o segredo do executor o caminho fecha', () => {
  assert.match(unavailableReason(selfUpdateConfig({ TUMACORD_SELF_UPDATE: '1' })), /TUMACORD_EXECUTOR_TOKEN/);
  assert.equal(unavailableReason(selfUpdateConfig(ENABLED)), '');
});

// O executor troca a versão do servidor. Alcançá-lo pela rede é um jeito de
// outra pessoa trocar a sua.
test('o executor só é alcançado no host local', () => {
  const withUrl = (url: string) => unavailableReason(selfUpdateConfig({ ...ENABLED, TUMACORD_EXECUTOR_URL: url }));
  assert.match(withUrl('http://10.0.0.5:4302'), /não é o host local/);
  assert.match(withUrl('http://exemplo.com:4302'), /não é o host local/);
  assert.match(withUrl('https://127.0.0.1:4302'), /http/);
  assert.match(withUrl('não é url'), /não é uma URL/);
  assert.equal(withUrl('http://127.0.0.1:4302'), '');
  assert.equal(withUrl('http://localhost:4302'), '');
  assert.equal(withUrl('http://[::1]:4302'), '');
});

test('o socket precisa de caminho absoluto, e tem precedência sobre a URL', () => {
  assert.match(unavailableReason(selfUpdateConfig({ ...ENABLED, TUMACORD_EXECUTOR_SOCKET: 'run/executor.sock' })), /absoluto/);
  // Com socket, uma URL ruim não importa: ela não é usada.
  assert.equal(unavailableReason(selfUpdateConfig({
    ...ENABLED, TUMACORD_EXECUTOR_SOCKET: '/run/tumacord-executor/executor.sock', TUMACORD_EXECUTOR_URL: 'http://10.0.0.5',
  })), '');
});

test('o prazo de uma chamada fica entre um segundo e um minuto, venha o que vier', () => {
  assert.equal(selfUpdateConfig({ TUMACORD_EXECUTOR_TIMEOUT_MS: '1' }).timeoutMs, 1_000);
  assert.equal(selfUpdateConfig({ TUMACORD_EXECUTOR_TIMEOUT_MS: '999999999' }).timeoutMs, 60_000);
  assert.equal(selfUpdateConfig({ TUMACORD_EXECUTOR_TIMEOUT_MS: 'abacaxi' }).timeoutMs, 15_000);
});

test('o segredo do executor é conferido inteiro, e só no formato de portador', () => {
  const config = selfUpdateConfig(ENABLED);
  assert.equal(executorTokenMatches(config, `Bearer ${SECRET}`), true);
  assert.equal(executorTokenMatches(config, `Bearer ${SECRET.slice(0, -1)}x`), false);
  assert.equal(executorTokenMatches(config, `Bearer ${SECRET}a`), false);
  assert.equal(executorTokenMatches(config, SECRET), false, 'sem o prefixo não é portador');
  assert.equal(executorTokenMatches(config, undefined), false);
  // Sem segredo configurado nada passa — nem um cabeçalho vazio.
  assert.equal(executorTokenMatches(selfUpdateConfig({}), 'Bearer '), false);
});

// Com o recurso desligado nada é pedido: a recusa vem antes até da conexão.
test('desligado, nem uma etiqueta publicada é aplicada', async () => {
  const updater = new SelfUpdater(selfUpdateConfig({}));
  const result = await updater.start('v0.9.8', '0.9.7');
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /desligada/);
  assert.equal(updater.snapshot().status, 'idle', 'nada começou');
});

test('ligado, uma etiqueta malformada morre antes de qualquer consulta', async (t) => {
  const { socketPath, requests } = await fakeExecutor(t, () => ({ status: 200, body: { catalog: catalog } }));
  const updater = new SelfUpdater(selfUpdateConfig({ ...ENABLED, TUMACORD_EXECUTOR_SOCKET: socketPath }));
  for (const attempt of ['main', 'v0.9.9; rm -rf /', '../../etc/passwd', 'V1.2.3', '']) {
    const result = await updater.start(attempt, '0.9.7');
    assert.equal(result.ok, false, `${JSON.stringify(attempt)} não pode ser aceito`);
    assert.equal(updater.snapshot().status, 'idle');
  }
  assert.equal(requests.length, 0, 'nenhuma consulta ao executor por uma etiqueta malformada');
});

test('o estado começa parado e não inventa uma atualização', () => {
  const updater = new SelfUpdater(selfUpdateConfig({}));
  assert.deepEqual(updater.snapshot(), { status: 'idle', tag: '', startedAt: '', finishedAt: '', log: '', jobId: '' });
  assert.equal(updater.running, false);
});

// --- a conversa com o executor ----------------------------------------------

test('só o identificador da release atravessa, com o segredo, pelo socket', async (t) => {
  const { socketPath, requests } = await fakeExecutor(t, (incoming) => {
    if (incoming.method === 'GET' && incoming.url === '/v1/state') return { status: 200, body: { catalog: catalog } };
    if (incoming.method === 'POST' && incoming.url === '/v1/apply') return { status: 202, body: { jobId: 'job-1' } };
    return { status: 404, body: {} };
  });
  const updater = new SelfUpdater(selfUpdateConfig({ ...ENABLED, TUMACORD_EXECUTOR_SOCKET: socketPath }));

  const result = await updater.start('v0.9.9-1', '0.9.9');
  assert.equal(result.ok, true, result.ok ? '' : result.error);

  const applyRequest = requests.find((incoming) => incoming.url === '/v1/apply');
  // Nem a etiqueta vai: a referência de git é derivada no executor, do
  // manifesto assinado. Um campo a mais aqui seria um alvo vindo de fora.
  assert.deepEqual(applyRequest?.body, { releaseId: 'rel_stable_0-9-9-1' });
  assert.ok(requests.every((incoming) => incoming.authorization === `Bearer ${SECRET}`));

  const state = updater.snapshot();
  assert.equal(state.status, 'running');
  assert.equal(state.tag, 'v0.9.9-1');
  assert.equal(state.jobId, 'job-1');
});

test('uma versão retirada não chega a ser pedida ao executor', async (t) => {
  const { socketPath, requests } = await fakeExecutor(t, () => ({ status: 200, body: { catalog: catalog } }));
  const updater = new SelfUpdater(selfUpdateConfig({ ...ENABLED, TUMACORD_EXECUTOR_SOCKET: socketPath }));
  const result = await updater.start('v0.9.8', '0.9.9');
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /retirada/);
  assert.equal(requests.some((incoming) => incoming.url === '/v1/apply'), false);
});

test('o executor recusando o segredo é dito, e não vira uma lista vazia', async (t) => {
  const { socketPath } = await fakeExecutor(t, () => ({ status: 401, body: { error: 'Não autorizado.' } }));
  const updater = new SelfUpdater(selfUpdateConfig({ ...ENABLED, TUMACORD_EXECUTOR_SOCKET: socketPath }));
  await assert.rejects(() => updater.offers('0.9.9'), /recusou o segredo/);
});

test('a recusa do executor chega ao painel com o motivo dele', async (t) => {
  const { socketPath } = await fakeExecutor(t, (incoming) => (incoming.url === '/v1/state'
    ? { status: 200, body: { catalog: catalog } }
    : { status: 409, body: { error: 'Já há uma operação em andamento (pid 42).' } }));
  const updater = new SelfUpdater(selfUpdateConfig({ ...ENABLED, TUMACORD_EXECUTOR_SOCKET: socketPath }));
  const result = await updater.start('v0.9.9-1', '0.9.9');
  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.error : '', /operação em andamento/);
  assert.equal(updater.snapshot().status, 'idle');
});

test('executor fora do ar é dito como tal', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'tumacord-sem-executor-'));
  try {
    const updater = new SelfUpdater(selfUpdateConfig({ ...ENABLED, TUMACORD_EXECUTOR_SOCKET: path.join(folder, 'nao-existe.sock') }));
    const result = await updater.start('v0.9.9-1', '0.9.9');
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.error : '', /systemctl status tumacord-executor/);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

// A aplicação reinicia justamente este servidor. O processo novo nasce parado,
// e o trabalho que o trocou está no executor.
test('depois de o servidor reiniciar, o painel retoma o trabalho no executor', async (t) => {
  const now = Date.parse('2026-09-12T12:00:00Z');
  let job: Record<string, unknown> = {
    id: 'job-9', kind: 'server-apply', state: 'running', input: { releaseId: 'rel_stable_0-9-9-1', version: '0.9.9-1' },
    steps: [{ name: 'backup', state: 'ok' }, { name: 'build', state: 'running' }], createdAt: '2026-09-12T11:55:00Z',
  };
  const { socketPath } = await fakeExecutor(t, (incoming) => {
    if (incoming.url === '/v1/jobs') return { status: 200, body: { jobs: [job] } };
    if (incoming.url === '/v1/jobs/job-9') return { status: 200, body: job };
    return { status: 404, body: {} };
  });
  const updater = new SelfUpdater(selfUpdateConfig({ ...ENABLED, TUMACORD_EXECUTOR_SOCKET: socketPath }));

  const resumed = await updater.refresh(now);
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.tag, 'v0.9.9-1');
  assert.equal(resumed.jobId, 'job-9');

  job = { ...job, state: 'succeeded', finishedAt: '2026-09-12T11:59:00Z', steps: [{ name: 'validate', state: 'ok' }] };
  const finished = await updater.refresh(now);
  assert.equal(finished.status, 'done');
  assert.match(finished.log, /validate/);
});

test('um trabalho antigo não reaparece como se fosse de agora', async (t) => {
  const { socketPath } = await fakeExecutor(t, () => ({
    status: 200,
    body: { jobs: [{ id: 'job-velho', kind: 'server-apply', state: 'succeeded', input: { version: '0.9.8' }, finishedAt: '2026-09-10T12:00:00Z' }] },
  }));
  const updater = new SelfUpdater(selfUpdateConfig({ ...ENABLED, TUMACORD_EXECUTOR_SOCKET: socketPath }));
  const state = await updater.refresh(Date.parse('2026-09-12T12:00:00Z'));
  assert.equal(state.status, 'idle');
  assert.equal(state.jobId, '');
});

test('perder o executor no meio não declara a atualização como falha', async (t) => {
  const { socketPath, close } = await fakeExecutor(t, (incoming) => (incoming.url === '/v1/state'
    ? { status: 200, body: { catalog: catalog } }
    : { status: 202, body: { jobId: 'job-2' } }));
  const updater = new SelfUpdater(selfUpdateConfig({ ...ENABLED, TUMACORD_EXECUTOR_SOCKET: socketPath }));
  assert.equal((await updater.start('v0.9.9-1', '0.9.9')).ok, true);

  await close();
  const state = await updater.refresh();
  // O servidor pode estar reiniciando justamente por causa do executor.
  assert.equal(state.status, 'running');
  assert.equal(state.jobId, 'job-2');
});

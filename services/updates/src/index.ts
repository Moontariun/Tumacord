// O serviço de distribuição do Tumacord.
//
// Roda na **mesma VPS** do servidor dedicado, como um contêiner separado. É
// separado de propósito: ele precisa continuar de pé enquanto o dedicado
// reinicia, que é exatamente o momento de uma atualização. Um serviço de
// atualização que caísse junto com o que ele atualiza não serviria para nada.
//
// O que ele faz, e só:
//
//   · serve o catálogo assinado e os manifestos assinados;
//   · serve os bytes dos pacotes, depois de autorizar o dispositivo;
//   · troca convite por credencial de dispositivo, e renova credencial válida.
//
// O que ele **não** faz: não consulta o GitHub, não executa nada, não recebe
// URL nem caminho do navegador, e não assina documento nenhum. A chave privada
// de assinatura não está aqui — ela vive no ambiente de publicação. Este
// serviço guarda e serve o que já chegou assinado, e sabe apenas conferir.
//
// A administração (importar, publicar, retirar) escuta numa interface local
// separada, e não na internet: ela é operada pelo executor e pelo painel do
// dono, que já estão na máquina.

import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import {
  type Catalog,
  type ReleaseManifest,
  type Signed,
  CHANNELS,
  catalogFreshness,
  verifySigned,
} from '../../../shared/distribution.js';
import { verifySignature } from '../../../shared/distributionCrypto.js';
import {
  AUTH_MESSAGES,
  ENROLL_MESSAGES,
  authorize,
  bearerToken,
  createInvite,
  enroll,
  publicDevice,
  renew,
  sanitizeLabel,
} from './devices.js';
import { ConcurrencyGate, fileSize, openRange, planDelivery, resolveStoragePath } from './delivery.js';
import { PUBLISH_MESSAGES, StateStore, validateCatalog, withdrawEntry } from './state.js';

const config = {
  port: Number(process.env.TUMACORD_UPDATES_PORT ?? 4300),
  host: process.env.TUMACORD_UPDATES_HOST ?? '0.0.0.0',
  /** A porta da administração. Escuta só no laço local por padrão. */
  adminPort: Number(process.env.TUMACORD_UPDATES_ADMIN_PORT ?? 4301),
  adminHost: process.env.TUMACORD_UPDATES_ADMIN_HOST ?? '127.0.0.1',
  /** Onde o estado mora. Fora do checkout, que é descartável. */
  stateDir: process.env.TUMACORD_UPDATES_STATE_DIR ?? '/var/lib/tumacord/updates',
  /** Onde os pacotes moram. Fora do webroot: não há caminho estático para cá. */
  storageDir: process.env.TUMACORD_UPDATES_STORAGE_DIR ?? '/var/lib/tumacord/packages',
  /** Quantos downloads simultâneos. A VPS divide rede com o chat e o TURN. */
  maxDownloads: Number(process.env.TUMACORD_UPDATES_MAX_DOWNLOADS ?? 6),
};

const store = new StateStore(config.stateDir);
const gate = new ConcurrencyGate(config.maxDownloads);

/** Log sem segredo nenhum: nem token, nem convite, nem hash. */
function log(event: string, detail: Record<string, unknown> = {}): void {
  const clean: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (/token|invite|convite|secret|segredo|hash|authorization/i.test(key)) continue;
    clean[key] = value;
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...clean }));
}

const app = express();
app.disable('x-powered-by');
// Sem `Referrer-Policy` frouxo e sem inline: este serviço não tem interface,
// mas o cabeçalho vale do mesmo jeito quando alguém abre uma URL no navegador.
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } }));
app.use(express.json({ limit: '32kb' }));

/**
 * Exige um dispositivo autorizado.
 *
 * Vale para `GET`, `HEAD` e `Range` igualmente: um `HEAD` anônimo revelaria
 * tamanho e existência, e um `Range` anônimo seria o download inteiro em
 * pedaços.
 */
function requireDevice(request: express.Request, response: express.Response): { deviceId: string } | null {
  const result = authorize(store.state.devices, bearerToken(request.headers.authorization), 'download', Date.now());
  if (!result.ok) {
    // A mensagem é útil e o estado é dito: expirado e revogado levam a caminhos
    // diferentes — um renova sozinho, o outro precisa do dono.
    response.status(result.failure === 'revoked' ? 403 : 401).json({ error: AUTH_MESSAGES[result.failure], reason: result.failure });
    return null;
  }
  return { deviceId: result.device.deviceId };
}

// ── Catálogo e manifestos ───────────────────────────────────────────────────

app.get('/v1/catalog', (request, response) => {
  const device = requireDevice(request, response);
  if (!device) return;
  const catalogDoc = store.state.catalog;
  if (!catalogDoc) {
    return response.status(503).json({ error: 'Ainda não há catálogo publicado neste servidor.', reason: 'no-catalog' });
  }
  // O documento sai exatamente como foi assinado. Filtrar o conteúdo quebraria
  // a assinatura — e uma assinatura que se quebra por filtro não protege nada.
  response.set('cache-control', 'private, no-store').json(catalogDoc);
});

app.get('/v1/releases/:releaseId/manifest', (request, response) => {
  const device = requireDevice(request, response);
  if (!device) return;
  const manifestDoc = store.state.manifests[String(request.params.releaseId)];
  if (!manifestDoc) return response.status(404).json({ error: 'Essa release não existe neste servidor.', reason: 'unknown-release' });
  response.set('cache-control', 'private, no-store').json(manifestDoc);
});

app.get('/v1/keys', (_request, response) => {
  // As chaves públicas confiáveis, para o painel e o executor conferirem o que
  // está em uso. São públicas por definição; o que nunca sai daqui é o
  // privado, que nem está nesta máquina.
  response.json({ keys: store.state.trustedKeys });
});

// ── Download ────────────────────────────────────────────────────────────────

app.all('/v1/artifacts/:releaseId/:artifactId', async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return response.status(405).set('allow', 'GET, HEAD').json({ error: 'Método não permitido.' });
  }
  const device = requireDevice(request, response);
  if (!device) return;

  const signedManifest = store.state.manifests[String(request.params.releaseId)];
  if (!signedManifest) return response.status(404).json({ error: 'Essa release não existe neste servidor.', reason: 'unknown-release' });
  const artifact = signedManifest.payload.artifacts.find((candidate) => candidate.artifactId === String(request.params.artifactId));
  if (!artifact) return response.status(404).json({ error: 'Esse pacote não existe nesta release.', reason: 'unknown-artifact' });

  // Uma versão retirada não é baixada de novo, nem por quem tem a URL: a
  // retirada precisa alcançar as máquinas que já estavam na rua.
  if (releaseIsWithdrawn(store.state.catalog?.payload, signedManifest.payload.releaseId)) {
    return response.status(410).json({ error: 'Essa versão foi retirada e não pode mais ser baixada.', reason: 'withdrawn' });
  }

  // O caminho vem do manifesto assinado, e ainda assim é resolvido contra a
  // raiz: um documento assinado com `..` dentro sairia do armazenamento.
  const file = resolveStoragePath(config.storageDir, artifact.storagePath);
  if (!file) {
    log('path-rejected', { releaseId: signedManifest.payload.releaseId, artifactId: artifact.artifactId });
    return response.status(500).json({ error: 'O caminho deste pacote é inválido.', reason: 'bad-path' });
  }
  const size = await fileSize(file);
  if (size === null) return response.status(404).json({ error: 'O arquivo deste pacote não está no armazenamento.', reason: 'missing-file' });
  if (size !== artifact.size) {
    // O que está em disco não é o que o manifesto assinado descreve. Servir
    // assim entregaria bytes que ninguém assinou.
    log('size-divergente', { releaseId: signedManifest.payload.releaseId, artifactId: artifact.artifactId, onDisk: size, inManifest: artifact.size });
    return response.status(409).json({ error: 'O pacote no armazenamento não confere com o manifesto.', reason: 'size-mismatch' });
  }

  if (!gate.tryAcquire()) {
    response.set('retry-after', '30');
    return response.status(503).json({ error: 'Há downloads demais agora. Tente de novo em instantes.', reason: 'busy' });
  }

  const plan = planDelivery({
    filePath: file, size: size, method: request.method,
    rangeHeader: request.headers.range, fileName: artifact.fileName, sha256: artifact.sha256,
  });
  response.status(plan.status).set(plan.headers);
  log('download', { releaseId: signedManifest.payload.releaseId, artifactId: artifact.artifactId, deviceId: device.deviceId, status: plan.status, metodo: request.method });

  if (!plan.stream) {
    gate.release();
    return response.end();
  }
  const stream = openRange(plan.stream.path, plan.stream.start, plan.stream.end);
  let released = false;
  const release = () => { if (!released) { released = true; gate.release(); } };
  stream.on('error', () => { release(); response.destroy(); });
  response.on('close', release);
  response.on('finish', release);
  stream.pipe(response);
});

function releaseIsWithdrawn(catalog: Catalog | undefined, releaseId: string): boolean {
  if (!catalog) return false;
  for (const channel of CHANNELS) {
    const entry = catalog.channels?.[channel]?.entries?.find((candidate) => candidate.releaseId === releaseId);
    if (entry?.state === 'withdrawn') return true;
  }
  return false;
}

// ── Dispositivos ────────────────────────────────────────────────────────────

app.post('/v1/devices/enroll', async (request, response) => {
  const body = request.body as { invite?: unknown; label?: unknown };
  const result = enroll(store.state.invites, typeof body?.invite === 'string' ? body.invite : '', sanitizeLabel(body?.label), Date.now());
  if (!result.ok) {
    log('enroll-rejected', { reason: result.failure });
    return response.status(401).json({ error: ENROLL_MESSAGES[result.failure], reason: result.failure });
  }
  await store.mutate((state) => {
    state.devices.push(result.device);
    const index = state.invites.findIndex((candidate) => candidate.tokenHash === result.invite.tokenHash);
    if (index >= 0) state.invites[index] = result.invite;
  });
  log('device-enrolled', { deviceId: result.device.deviceId, label: result.device.label });
  // O token só existe aqui, uma vez. Ele não é guardado em claro nem repetido.
  response.status(201).json({ deviceId: result.device.deviceId, token: result.token, expiresAt: result.device.expiresAt });
});

app.post('/v1/devices/renew', async (request, response) => {
  const currentDevice = authorize(store.state.devices, bearerToken(request.headers.authorization), 'download', Date.now());
  if (!currentDevice.ok) {
    // Renovar exige credencial que ainda vale: aceitar vencida ou revogada
    // devolveria acesso a quem o dono acabou de tirar.
    return response.status(401).json({ error: AUTH_MESSAGES[currentDevice.failure], reason: currentDevice.failure });
  }
  const renewed = renew(currentDevice.device, Date.now());
  await store.mutate((state) => {
    const index = state.devices.findIndex((candidate) => candidate.deviceId === renewed.device.deviceId);
    if (index >= 0) state.devices[index] = renewed.device;
  });
  log('device-renewed', { deviceId: renewed.device.deviceId });
  response.json({ deviceId: renewed.device.deviceId, token: renewed.token, expiresAt: renewed.device.expiresAt });
});

// ── Saúde ───────────────────────────────────────────────────────────────────

app.get('/v1/health', (_request, response) => {
  const catalogDoc = store.state.catalog?.payload;
  response.json({
    ok: true,
    servico: 'tumacord-atualizacoes',
    catalogDoc: catalogDoc ? { sequence: catalogDoc.sequence, expiresAt: catalogDoc.expiresAt } : null,
    downloadsAtivos: gate.active,
  });
});

app.use((_request, response) => response.status(404).json({ error: 'Não há nada neste caminho.' }));

// ── Administração, numa interface separada ──────────────────────────────────
//
// Importar, publicar e retirar não escutam na internet. Quem as opera — o
// executor e o painel do dono — já está na máquina, e expor isso publicamente
// significaria defender a operação mais sensível do sistema no lugar mais
// exposto dele.

const admin = express();
admin.disable('x-powered-by');
admin.use(express.json({ limit: '8mb' }));

admin.post('/admin/manifest', async (request, response) => {
  const document = request.body as Signed<ReleaseManifest>;
  const checked = verifySigned(document, store.state.trustedKeys, 'manifest', verifySignature);
  if (!checked.ok) {
    log('manifest-rejected', { reason: checked.failure, detalhe: checked.detail });
    return response.status(400).json({ error: `Manifesto recusado: ${checked.failure}.`, reason: checked.failure });
  }
  await store.mutate((state) => { state.manifests[document.payload.releaseId] = document; });
  log('manifest-imported', { releaseId: document.payload.releaseId, version: document.payload.version, commit: document.payload.commit });
  response.status(201).json({ ok: true, releaseId: document.payload.releaseId });
});

admin.post('/admin/catalog', async (request, response) => {
  const document = request.body as Signed<Catalog>;
  const checked = verifySigned(document, store.state.trustedKeys, 'catalog', verifySignature);
  if (!checked.ok) {
    log('catalog-rejected', { reason: checked.failure, detalhe: checked.detail });
    return response.status(400).json({ error: `Catálogo recusado: ${checked.failure}.`, reason: checked.failure });
  }
  const failure = validateCatalog(document.payload, store.state.catalog?.payload ?? null, store.state.manifests);
  if (failure) {
    log('catalog-invalid', { reason: failure });
    return response.status(409).json({ error: PUBLISH_MESSAGES[failure], reason: failure });
  }
  const freshness = catalogFreshness(document.payload, store.state.catalog?.payload?.sequence ?? 0, Date.now());
  if (freshness !== 'ok') {
    return response.status(409).json({ error: `Catálogo ${freshness}.`, reason: freshness });
  }
  // Promoção atômica: o catálogo inteiro troca de uma vez.
  await store.mutate((state) => {
    state.catalog = document;
    state.history.push({ sequence: document.payload.sequence, publishedAt: new Date().toISOString(), digest: '' });
    if (state.history.length > 200) state.history.splice(0, state.history.length - 200);
  });
  log('catalog-published', { sequence: document.payload.sequence });
  response.status(201).json({ ok: true, sequence: document.payload.sequence });
});

/**
 * O catálogo publicado agora, para recuperação.
 *
 * O estado do catálogo vive no ambiente de publicação, porque só lá ele pode
 * ser produzido. Quando essa pasta se perde, publicar às cegas produziria uma
 * sequência que anda para trás — e um catálogo assim é recusado aqui e nos
 * clientes, depois de já ter sido assinado. Esta rota devolve o que está no
 * ar para o publicador reconstruir o estado a partir dele.
 */
admin.get('/admin/catalog', (_request, response) => {
  response.json(store.state.catalog ?? null);
});

/**
 * O manifesto de uma release, do lado administrativo.
 *
 * O executor precisa do **commit** que a release declara para aplicar a
 * referência exata de onde ela saiu — e ele não tem, nem deve ter, credencial
 * de dispositivo. Aceitar a referência vinda de quem pede seria aceitar um
 * alvo arbitrário; aqui ela é derivada do que foi assinado e publicado.
 */
admin.get('/admin/releases/:releaseId/manifest', (request, response) => {
  const document = store.state.manifests[String(request.params.releaseId)];
  if (!document) return response.status(404).json({ error: 'Essa release não tem manifesto importado.', reason: 'unknown-release' });
  response.json(document);
});

admin.post('/admin/keys', async (request, response) => {
  const body = request.body as { keys?: unknown };
  if (!Array.isArray(body?.keys)) return response.status(400).json({ error: 'Informe a lista de chaves.' });
  await store.mutate((state) => { state.trustedKeys = body.keys as never; });
  log('keys-updated', { count: body.keys.length });
  response.json({ ok: true });
});

admin.post('/admin/invites', async (request, response) => {
  const body = request.body as { label?: unknown };
  const { invite, token } = createInvite(sanitizeLabel(body?.label), Date.now());
  await store.mutate((state) => {
    state.invites.push(invite);
    const now = Date.now();
    state.invites = state.invites.filter((candidate) => candidate.expiresAt > now || candidate.usedAt);
  });
  log('invite-created', { label: invite.label, expiresAt: invite.expiresAt });
  // O convite aparece uma vez, aqui, para o dono passar por canal privado.
  response.status(201).json({ invite: token, expiresAt: invite.expiresAt, label: invite.label });
});

admin.get('/admin/devices', (_request, response) => {
  response.json({ devices: store.state.devices.map(publicDevice) });
});

admin.post('/admin/devices/:id/revoke', async (request, response) => {
  const body = request.body as { reason?: unknown };
  let found = false;
  await store.mutate((state) => {
    const device = state.devices.find((candidate) => candidate.deviceId === String(request.params.id));
    if (!device) return;
    found = true;
    device.revokedAt = new Date().toISOString();
    device.revokedReason = sanitizeLabel(body?.reason) || 'revogado pelo dono';
  });
  if (!found) return response.status(404).json({ error: 'Esse dispositivo não existe.' });
  log('device-revoked', { deviceId: request.params.id });
  response.json({ ok: true });
});

admin.post('/admin/withdraw', async (request, response) => {
  const body = request.body as { releaseId?: unknown; channel?: unknown; reason?: unknown };
  const catalogDoc = store.state.catalog;
  if (!catalogDoc) return response.status(409).json({ error: 'Não há catálogo publicado.' });
  const channel = body?.channel === 'test' ? 'test' : 'stable';
  const reason = sanitizeLabel(body?.reason);
  if (!reason) return response.status(400).json({ error: 'A retirada precisa de um motivo: ele aparece na tela de quem tentar instalar.' });
  // A retirada muda o catálogo, e um catálogo mudado precisa ser assinado de
  // novo. Este serviço não assina: ele devolve o documento a assinar, e quem
  // tem a chave publica de volta.
  const proposed = withdrawEntry(catalogDoc.payload, channel, String(body?.releaseId ?? ''), reason, Date.now());
  response.json({ ok: true, toSign: proposed });
});

async function main(): Promise<void> {
  await store.load();
  app.listen(config.port, config.host, () => {
    log('service-listening', { port: config.port, host: config.host, storage: path.basename(config.storageDir) });
  });
  admin.listen(config.adminPort, config.adminHost, () => {
    log('admin-listening', { port: config.adminPort, host: config.adminHost });
  });
}

if (process.env.TUMACORD_UPDATES_NO_LISTEN !== '1') {
  main().catch((error) => {
    console.error('Falha ao subir o serviço de atualizações:', error);
    process.exit(1);
  });
}

export { admin, app, config, store };

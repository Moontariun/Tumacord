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
} from './dispositivos.js';
import { ConcurrencyGate, fileSize, openRange, planDelivery, resolveStoragePath } from './entrega.js';
import { PUBLISH_MESSAGES, StateStore, validateCatalog, withdrawEntry } from './estado.js';

const config = {
  porta: Number(process.env.TUMACORD_UPDATES_PORT ?? 4300),
  host: process.env.TUMACORD_UPDATES_HOST ?? '0.0.0.0',
  /** A porta da administração. Escuta só no laço local por padrão. */
  portaAdmin: Number(process.env.TUMACORD_UPDATES_ADMIN_PORT ?? 4301),
  hostAdmin: process.env.TUMACORD_UPDATES_ADMIN_HOST ?? '127.0.0.1',
  /** Onde o estado mora. Fora do checkout, que é descartável. */
  estado: process.env.TUMACORD_UPDATES_STATE_DIR ?? '/var/lib/tumacord/atualizacoes',
  /** Onde os pacotes moram. Fora do webroot: não há caminho estático para cá. */
  armazenamento: process.env.TUMACORD_UPDATES_STORAGE_DIR ?? '/var/lib/tumacord/pacotes',
  /** Quantos downloads simultâneos. A VPS divide rede com o chat e o TURN. */
  downloadsSimultaneos: Number(process.env.TUMACORD_UPDATES_MAX_DOWNLOADS ?? 6),
};

const store = new StateStore(config.estado);
const portao = new ConcurrencyGate(config.downloadsSimultaneos);

/** Log sem segredo nenhum: nem token, nem convite, nem hash. */
function registrar(evento: string, detalhe: Record<string, unknown> = {}): void {
  const limpo: Record<string, unknown> = {};
  for (const [chave, valor] of Object.entries(detalhe)) {
    if (/token|invite|convite|secret|segredo|hash|authorization/i.test(chave)) continue;
    limpo[chave] = valor;
  }
  console.log(JSON.stringify({ at: new Date().toISOString(), evento, ...limpo }));
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
function exigirDispositivo(request: express.Request, response: express.Response): { deviceId: string } | null {
  const resultado = authorize(store.state.devices, bearerToken(request.headers.authorization), 'download', Date.now());
  if (!resultado.ok) {
    // A mensagem é útil e o estado é dito: expirado e revogado levam a caminhos
    // diferentes — um renova sozinho, o outro precisa do dono.
    response.status(resultado.failure === 'revoked' ? 403 : 401).json({ error: AUTH_MESSAGES[resultado.failure], reason: resultado.failure });
    return null;
  }
  return { deviceId: resultado.device.deviceId };
}

// ── Catálogo e manifestos ───────────────────────────────────────────────────

app.get('/v1/catalogo', (request, response) => {
  const dispositivo = exigirDispositivo(request, response);
  if (!dispositivo) return;
  const catalogo = store.state.catalog;
  if (!catalogo) {
    return response.status(503).json({ error: 'Ainda não há catálogo publicado neste servidor.', reason: 'no-catalog' });
  }
  // O documento sai exatamente como foi assinado. Filtrar o conteúdo quebraria
  // a assinatura — e uma assinatura que se quebra por filtro não protege nada.
  response.set('cache-control', 'private, no-store').json(catalogo);
});

app.get('/v1/releases/:releaseId/manifesto', (request, response) => {
  const dispositivo = exigirDispositivo(request, response);
  if (!dispositivo) return;
  const manifesto = store.state.manifests[String(request.params.releaseId)];
  if (!manifesto) return response.status(404).json({ error: 'Essa release não existe neste servidor.', reason: 'unknown-release' });
  response.set('cache-control', 'private, no-store').json(manifesto);
});

app.get('/v1/chaves', (_request, response) => {
  // As chaves públicas confiáveis, para o painel e o executor conferirem o que
  // está em uso. São públicas por definição; o que nunca sai daqui é o
  // privado, que nem está nesta máquina.
  response.json({ keys: store.state.trustedKeys });
});

// ── Download ────────────────────────────────────────────────────────────────

app.all('/v1/artefatos/:releaseId/:artifactId', async (request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return response.status(405).set('allow', 'GET, HEAD').json({ error: 'Método não permitido.' });
  }
  const dispositivo = exigirDispositivo(request, response);
  if (!dispositivo) return;

  const assinado = store.state.manifests[String(request.params.releaseId)];
  if (!assinado) return response.status(404).json({ error: 'Essa release não existe neste servidor.', reason: 'unknown-release' });
  const artefato = assinado.payload.artifacts.find((candidate) => candidate.artifactId === String(request.params.artifactId));
  if (!artefato) return response.status(404).json({ error: 'Esse pacote não existe nesta release.', reason: 'unknown-artifact' });

  // Uma versão retirada não é baixada de novo, nem por quem tem a URL: a
  // retirada precisa alcançar as máquinas que já estavam na rua.
  if (releaseRetirada(store.state.catalog?.payload, assinado.payload.releaseId)) {
    return response.status(410).json({ error: 'Essa versão foi retirada e não pode mais ser baixada.', reason: 'withdrawn' });
  }

  // O caminho vem do manifesto assinado, e ainda assim é resolvido contra a
  // raiz: um documento assinado com `..` dentro sairia do armazenamento.
  const arquivo = resolveStoragePath(config.armazenamento, artefato.storagePath);
  if (!arquivo) {
    registrar('caminho-recusado', { releaseId: assinado.payload.releaseId, artifactId: artefato.artifactId });
    return response.status(500).json({ error: 'O caminho deste pacote é inválido.', reason: 'bad-path' });
  }
  const tamanho = await fileSize(arquivo);
  if (tamanho === null) return response.status(404).json({ error: 'O arquivo deste pacote não está no armazenamento.', reason: 'missing-file' });
  if (tamanho !== artefato.size) {
    // O que está em disco não é o que o manifesto assinado descreve. Servir
    // assim entregaria bytes que ninguém assinou.
    registrar('tamanho-divergente', { releaseId: assinado.payload.releaseId, artifactId: artefato.artifactId, emDisco: tamanho, noManifesto: artefato.size });
    return response.status(409).json({ error: 'O pacote no armazenamento não confere com o manifesto.', reason: 'size-mismatch' });
  }

  if (!portao.tryAcquire()) {
    response.set('retry-after', '30');
    return response.status(503).json({ error: 'Há downloads demais agora. Tente de novo em instantes.', reason: 'busy' });
  }

  const plano = planDelivery({
    filePath: arquivo, size: tamanho, method: request.method,
    rangeHeader: request.headers.range, fileName: artefato.fileName, sha256: artefato.sha256,
  });
  response.status(plano.status).set(plano.headers);
  registrar('download', { releaseId: assinado.payload.releaseId, artifactId: artefato.artifactId, deviceId: dispositivo.deviceId, status: plano.status, metodo: request.method });

  if (!plano.stream) {
    portao.release();
    return response.end();
  }
  const fluxo = openRange(plano.stream.path, plano.stream.start, plano.stream.end);
  let liberado = false;
  const liberar = () => { if (!liberado) { liberado = true; portao.release(); } };
  fluxo.on('error', () => { liberar(); response.destroy(); });
  response.on('close', liberar);
  response.on('finish', liberar);
  fluxo.pipe(response);
});

function releaseRetirada(catalog: Catalog | undefined, releaseId: string): boolean {
  if (!catalog) return false;
  for (const canal of CHANNELS) {
    const entrada = catalog.channels?.[canal]?.entries?.find((candidate) => candidate.releaseId === releaseId);
    if (entrada?.state === 'withdrawn') return true;
  }
  return false;
}

// ── Dispositivos ────────────────────────────────────────────────────────────

app.post('/v1/dispositivos/inscrever', async (request, response) => {
  const corpo = request.body as { convite?: unknown; rotulo?: unknown };
  const resultado = enroll(store.state.invites, typeof corpo?.convite === 'string' ? corpo.convite : '', sanitizeLabel(corpo?.rotulo), Date.now());
  if (!resultado.ok) {
    registrar('inscricao-recusada', { motivo: resultado.failure });
    return response.status(401).json({ error: ENROLL_MESSAGES[resultado.failure], reason: resultado.failure });
  }
  await store.mutate((state) => {
    state.devices.push(resultado.device);
    const indice = state.invites.findIndex((candidate) => candidate.tokenHash === resultado.invite.tokenHash);
    if (indice >= 0) state.invites[indice] = resultado.invite;
  });
  registrar('dispositivo-inscrito', { deviceId: resultado.device.deviceId, rotulo: resultado.device.label });
  // O token só existe aqui, uma vez. Ele não é guardado em claro nem repetido.
  response.status(201).json({ deviceId: resultado.device.deviceId, token: resultado.token, expiresAt: resultado.device.expiresAt });
});

app.post('/v1/dispositivos/renovar', async (request, response) => {
  const atual = authorize(store.state.devices, bearerToken(request.headers.authorization), 'download', Date.now());
  if (!atual.ok) {
    // Renovar exige credencial que ainda vale: aceitar vencida ou revogada
    // devolveria acesso a quem o dono acabou de tirar.
    return response.status(401).json({ error: AUTH_MESSAGES[atual.failure], reason: atual.failure });
  }
  const renovado = renew(atual.device, Date.now());
  await store.mutate((state) => {
    const indice = state.devices.findIndex((candidate) => candidate.deviceId === renovado.device.deviceId);
    if (indice >= 0) state.devices[indice] = renovado.device;
  });
  registrar('dispositivo-renovado', { deviceId: renovado.device.deviceId });
  response.json({ deviceId: renovado.device.deviceId, token: renovado.token, expiresAt: renovado.device.expiresAt });
});

// ── Saúde ───────────────────────────────────────────────────────────────────

app.get('/v1/saude', (_request, response) => {
  const catalogo = store.state.catalog?.payload;
  response.json({
    ok: true,
    servico: 'tumacord-atualizacoes',
    catalogo: catalogo ? { sequence: catalogo.sequence, expiresAt: catalogo.expiresAt } : null,
    downloadsAtivos: portao.active,
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

admin.post('/admin/manifesto', async (request, response) => {
  const documento = request.body as Signed<ReleaseManifest>;
  const conferido = verifySigned(documento, store.state.trustedKeys, 'manifest', verifySignature);
  if (!conferido.ok) {
    registrar('manifesto-recusado', { motivo: conferido.failure, detalhe: conferido.detail });
    return response.status(400).json({ error: `Manifesto recusado: ${conferido.failure}.`, reason: conferido.failure });
  }
  await store.mutate((state) => { state.manifests[documento.payload.releaseId] = documento; });
  registrar('manifesto-importado', { releaseId: documento.payload.releaseId, version: documento.payload.version, commit: documento.payload.commit });
  response.status(201).json({ ok: true, releaseId: documento.payload.releaseId });
});

admin.post('/admin/catalogo', async (request, response) => {
  const documento = request.body as Signed<Catalog>;
  const conferido = verifySigned(documento, store.state.trustedKeys, 'catalog', verifySignature);
  if (!conferido.ok) {
    registrar('catalogo-recusado', { motivo: conferido.failure, detalhe: conferido.detail });
    return response.status(400).json({ error: `Catálogo recusado: ${conferido.failure}.`, reason: conferido.failure });
  }
  const falha = validateCatalog(documento.payload, store.state.catalog?.payload ?? null, store.state.manifests);
  if (falha) {
    registrar('catalogo-invalido', { motivo: falha });
    return response.status(409).json({ error: PUBLISH_MESSAGES[falha], reason: falha });
  }
  const frescor = catalogFreshness(documento.payload, store.state.catalog?.payload?.sequence ?? 0, Date.now());
  if (frescor !== 'ok') {
    return response.status(409).json({ error: `Catálogo ${frescor}.`, reason: frescor });
  }
  // Promoção atômica: o catálogo inteiro troca de uma vez.
  await store.mutate((state) => {
    state.catalog = documento;
    state.history.push({ sequence: documento.payload.sequence, publishedAt: new Date().toISOString(), digest: '' });
    if (state.history.length > 200) state.history.splice(0, state.history.length - 200);
  });
  registrar('catalogo-publicado', { sequence: documento.payload.sequence });
  response.status(201).json({ ok: true, sequence: documento.payload.sequence });
});

admin.post('/admin/chaves', async (request, response) => {
  const corpo = request.body as { keys?: unknown };
  if (!Array.isArray(corpo?.keys)) return response.status(400).json({ error: 'Informe a lista de chaves.' });
  await store.mutate((state) => { state.trustedKeys = corpo.keys as never; });
  registrar('chaves-atualizadas', { quantidade: corpo.keys.length });
  response.json({ ok: true });
});

admin.post('/admin/convites', async (request, response) => {
  const corpo = request.body as { rotulo?: unknown };
  const { invite, token } = createInvite(sanitizeLabel(corpo?.rotulo), Date.now());
  await store.mutate((state) => {
    state.invites.push(invite);
    const agora = Date.now();
    state.invites = state.invites.filter((candidate) => candidate.expiresAt > agora || candidate.usedAt);
  });
  registrar('convite-criado', { rotulo: invite.label, expiresAt: invite.expiresAt });
  // O convite aparece uma vez, aqui, para o dono passar por canal privado.
  response.status(201).json({ convite: token, expiresAt: invite.expiresAt, rotulo: invite.label });
});

admin.get('/admin/dispositivos', (_request, response) => {
  response.json({ devices: store.state.devices.map(publicDevice) });
});

admin.post('/admin/dispositivos/:id/revogar', async (request, response) => {
  const corpo = request.body as { motivo?: unknown };
  let achou = false;
  await store.mutate((state) => {
    const dispositivo = state.devices.find((candidate) => candidate.deviceId === String(request.params.id));
    if (!dispositivo) return;
    achou = true;
    dispositivo.revokedAt = new Date().toISOString();
    dispositivo.revokedReason = sanitizeLabel(corpo?.motivo) || 'revogado pelo dono';
  });
  if (!achou) return response.status(404).json({ error: 'Esse dispositivo não existe.' });
  registrar('dispositivo-revogado', { deviceId: request.params.id });
  response.json({ ok: true });
});

admin.post('/admin/retirar', async (request, response) => {
  const corpo = request.body as { releaseId?: unknown; canal?: unknown; motivo?: unknown };
  const catalogo = store.state.catalog;
  if (!catalogo) return response.status(409).json({ error: 'Não há catálogo publicado.' });
  const canal = corpo?.canal === 'test' ? 'test' : 'stable';
  const motivo = sanitizeLabel(corpo?.motivo);
  if (!motivo) return response.status(400).json({ error: 'A retirada precisa de um motivo: ele aparece na tela de quem tentar instalar.' });
  // A retirada muda o catálogo, e um catálogo mudado precisa ser assinado de
  // novo. Este serviço não assina: ele devolve o documento a assinar, e quem
  // tem a chave publica de volta.
  const proposto = withdrawEntry(catalogo.payload, canal, String(corpo?.releaseId ?? ''), motivo, Date.now());
  response.json({ ok: true, paraAssinar: proposto });
});

async function principal(): Promise<void> {
  await store.load();
  app.listen(config.porta, config.host, () => {
    registrar('servico-no-ar', { porta: config.porta, host: config.host, armazenamento: path.basename(config.armazenamento) });
  });
  admin.listen(config.portaAdmin, config.hostAdmin, () => {
    registrar('admin-no-ar', { porta: config.portaAdmin, host: config.hostAdmin });
  });
}

if (process.env.TUMACORD_UPDATES_NO_LISTEN !== '1') {
  principal().catch((erro) => {
    console.error('Falha ao subir o serviço de atualizações:', erro);
    process.exit(1);
  });
}

export { admin, app, config, store };

// De onde o aplicativo busca atualização: a distribuição privada do grupo.
//
// **Este arquivo não fala com o GitHub.** Nem para verificar, nem para baixar,
// nem no primeiro download de uma cópia nova. O repositório continua privado e
// continua sendo onde o código mora; quem serve atualização é a VPS do grupo.
//
// O que atravessa a rede aqui, e o que é feito com cada coisa:
//
//   · **catálogo** — documento assinado. A assinatura é conferida contra as
//     chaves embutidas no aplicativo antes de qualquer leitura de conteúdo. Um
//     catálogo vencido ou mais antigo do que o maior já aceito é recusado
//     **antes** de ser lido: um serviço que voltasse no tempo reoferecia uma
//     versão que o grupo já deixou para trás, ou segurava a retirada de uma
//     defeituosa;
//   · **manifesto** — idem, e com o resumo conferido contra o que o catálogo
//     prometeu;
//   · **pacote** — os bytes. Tamanho e SHA-256 conferidos, e a conferência
//     refeita imediatamente antes de executar.
//
// A credencial de dispositivo vai no cabeçalho `Authorization` e **não segue
// redirecionamento**: um redirect para outro domínio levaria a credencial
// junto, e é assim que se colhe credencial de aplicativo.

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const {
  CONTRACT_VERSION,
  artifactMatches,
  catalogFreshness,
  selectArtifact,
  verifySigned,
} = require('./distribution.generated.cjs');
const { verifySignature } = require('./distribution-crypto.generated.cjs');
const { serviceUrl } = require('./update-origin.cjs');

const REQUEST_TIMEOUT = 20_000;
/** Um documento assinado não passa disto. Acima, não é um catálogo. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
/** O instalador do Windows tem ~110 MB e o AppImage ~120 MB. */
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;

/**
 * Um pedido ao serviço de distribuição.
 *
 * Sem redirecionamento, de propósito. O serviço não redireciona; se ele
 * passasse a redirecionar, a decisão de seguir — e de levar a credencial
 * junto — seria tomada aqui, e não é uma decisão que valha a pena automatizar.
 */
function request(url, { headers = {}, method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(String(url));
    } catch {
      reject(new Error('Endereço de atualização inválido.'));
      return;
    }
    const secure = target.protocol === 'https:';
    const isLocal = target.hostname === 'localhost' || target.hostname === '127.0.0.1' || target.hostname === '::1';
    if (!secure && !isLocal) {
      reject(new Error('A origem das atualizações precisa ser https.'));
      return;
    }
    const transport = secure ? https : http;
    const call = transport.request(target, { method, headers }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        response.resume();
        // A credencial não vai atrás de um redirecionamento. Levá-la para
        // outro domínio é o jeito mais simples de colhê-la.
        reject(Object.assign(new Error('O serviço de atualizações redirecionou, e a credencial não é enviada para outro endereço.'), { status }));
        return;
      }
      // Qualquer 2xx é sucesso. A inscrição de dispositivo responde 201, e uma
      // retomada responde 206: listar os códigos um a um deixa de fora o que
      // ninguém lembrou de listar, e "respondeu 201" como erro é confuso de um
      // jeito que custa tempo a quem for investigar.
      if (status < 200 || status >= 300) {
        // O corpo do erro traz o motivo em português e a razão técnica.
        readText(response, 16 * 1024).then((text) => {
          let errorBody = {};
          try { errorBody = JSON.parse(text); } catch { /* nem todo erro é JSON */ }
          reject(Object.assign(
            new Error(errorBody.error || `O serviço de atualizações respondeu ${status || 'sem status'}.`),
            { status, reason: errorBody.reason || '' },
          ));
        }).catch(() => reject(Object.assign(new Error(`O serviço de atualizações respondeu ${status}.`), { status })));
        return;
      }
      resolve(response);
    });
    call.setTimeout(REQUEST_TIMEOUT, () => call.destroy(new Error('O serviço de atualizações demorou demais.')));
    call.on('error', reject);
    // O corpo é escrito antes de encerrar. Sem isto, um POST que declara
    // `content-length` e não escreve nada deixa o servidor esperando um corpo
    // que nunca chega: o pedido morre no tempo limite, e do outro lado
    // aparece um `request aborted` que não explica nada a ninguém.
    if (body !== null && body !== undefined) call.write(body);
    call.end();
  });
}

async function readText(response, cap) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > cap) {
      response.destroy();
      throw new Error('A resposta do serviço de atualizações veio grande demais.');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function buildHeaders(token, extra = {}) {
  return {
    accept: 'application/json',
    'user-agent': 'Tumacord',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

/**
 * Busca o catálogo e confere que ele pode decidir alguma coisa.
 *
 * A ordem importa: assinatura, depois frescor, depois conteúdo. Ler o conteúdo
 * antes de verificar a assinatura seria decidir com base num documento que
 * ainda pode ser de qualquer um.
 */
async function fetchCatalog({ origin, token, trustedKeys, acceptedSequence = 0, now = Date.now() }) {
  const response = await request(serviceUrl(origin, '/v1/catalog'), { headers: buildHeaders(token) });
  const document = JSON.parse(await readText(response, MAX_DOCUMENT_BYTES));

  const checked = verifySigned(document, trustedKeys, 'catalog', verifySignature, now);
  if (!checked.ok) {
    throw Object.assign(new Error(verificationMessage('catálogo', checked.failure)), { reason: checked.failure });
  }
  const freshness = catalogFreshness(document.payload, acceptedSequence, now);
  if (freshness !== 'ok') {
    // Falha segura: sem saber qual é a política vigente, não se instala nada.
    // Aceitar o catálogo velho "porque é o que temos" é exatamente o que
    // alguém no caminho precisaria para segurar a retirada de uma versão ruim.
    throw Object.assign(new Error(freshnessMessage(freshness)), { reason: freshness });
  }
  return document.payload;
}

/** Busca e confere o manifesto de uma release. */
async function fetchManifest({ origin, token, trustedKeys, releaseId, expectedDigest = '', now = Date.now() }) {
  const response = await request(serviceUrl(origin, '/v1/releases', releaseId) + '/manifest', { headers: buildHeaders(token) });
  const raw = await readText(response, MAX_DOCUMENT_BYTES);
  const document = JSON.parse(raw);

  const checked = verifySigned(document, trustedKeys, 'manifest', verifySignature, now);
  if (!checked.ok) {
    throw Object.assign(new Error(verificationMessage('manifesto', checked.failure)), { reason: checked.failure });
  }
  if (document.payload.releaseId !== releaseId) {
    throw Object.assign(new Error('O manifesto recebido é de outra release.'), { reason: 'manifest-mismatch' });
  }
  if (document.payload.contract !== CONTRACT_VERSION) {
    throw Object.assign(new Error('O manifesto está num contrato que esta versão não conhece.'), { reason: 'contract-unknown' });
  }
  // O catálogo assinado diz qual manifesto esperar. Sem esta conferência, um
  // serviço poderia servir o manifesto assinado de **outra** versão — todos os
  // dois autênticos, e o par errado.
  if (expectedDigest) {
    const { documentDigest } = require('./distribution-crypto.generated.cjs');
    if (documentDigest(document.payload) !== String(expectedDigest).toLowerCase()) {
      throw Object.assign(new Error('O manifesto não é o que o catálogo prometeu.'), { reason: 'manifest-mismatch' });
    }
  }
  return document.payload;
}

/**
 * Baixa um pacote, conferindo o que chega enquanto chega.
 *
 * Retoma de onde parou quando já há um arquivo parcial: um pacote de cem
 * megabytes numa conexão ruim não pode recomeçar do zero a cada queda.
 *
 * O resumo é calculado sobre **tudo** o que foi para o disco — inclusive o que
 * já estava lá de uma tentativa anterior —, e não só sobre o pedaço novo.
 */
async function downloadArtifact({
  origin, token, manifest, artifact, destination,
  onProgress = () => {}, shouldCancel = () => false,
}) {
  const partial = `${destination}.partial`;
  let alreadyHave = 0;
  try {
    const info = fs.statSync(partial);
    if (info.isFile() && info.size < artifact.size) alreadyHave = info.size;
    else if (info.isFile()) fs.rmSync(partial, { force: true });
  } catch { /* não há partial */ }

  if (artifact.size > MAX_DOWNLOAD_BYTES) {
    throw new Error('O pacote anunciado é maior do que qualquer versão do Tumacord; nada foi baixado.');
  }

  const headers = buildHeaders(token, { accept: 'application/octet-stream' });
  if (alreadyHave > 0) headers.range = `bytes=${alreadyHave}-`;

  const response = await request(serviceUrl(origin, '/v1/artifacts', manifest.releaseId, artifact.artifactId), { headers });
  // Se pedimos uma faixa e veio o arquivo inteiro, o que está no disco não
  // serve de começo: recomeçar é o certo, e silenciosamente concatenar seria
  // produzir um arquivo com um pedaço repetido.
  const resumed = alreadyHave > 0 && response.statusCode === 206;
  if (alreadyHave > 0 && !resumed) {
    fs.rmSync(partial, { force: true });
    alreadyHave = 0;
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const output = fs.createWriteStream(partial, { flags: resumed ? 'a' : 'w' });
  let received = alreadyHave;
  let lastReport = 0;

  try {
    for await (const chunk of response) {
      if (shouldCancel()) {
        response.destroy();
        throw Object.assign(new Error('Download cancelado.'), { cancelado: true });
      }
      received += chunk.length;
      if (received > artifact.size) {
        response.destroy();
        throw new Error('O pacote veio maior do que o manifesto declara; ele foi descartado.');
      }
      if (!output.write(chunk)) await new Promise((resolve) => output.once('drain', resolve));
      const now_ = Date.now();
      if (now_ - lastReport >= 200) {
        lastReport = now_;
        onProgress({ received: received, total: artifact.size });
      }
    }
  } finally {
    await new Promise((resolve) => output.end(resolve));
  }

  if (received !== artifact.size) {
    // O parcial fica: a próxima tentativa continua de onde parou.
    throw new Error(`O pacote chegou incompleto (${received} de ${artifact.size} bytes). Tente de novo — o download continua de onde parou.`);
  }

  // O resumo é de tudo o que está no disco, e não do que acabou de chegar.
  const digest = await sha256OfFile(partial);
  const mismatch = artifactMatches(manifest, artifact, { sha256: digest, size: received });
  if (mismatch) {
    fs.rmSync(partial, { force: true });
    throw Object.assign(new Error(mismatchMessage(mismatch)), { reason: mismatch });
  }

  fs.rmSync(destination, { force: true });
  fs.renameSync(partial, destination);
  onProgress({ received: received, total: artifact.size });
  return { file: destination, sha256: digest, size: received };
}

function sha256OfFile(arquivo) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const input = fs.createReadStream(arquivo);
    input.on('data', (chunk) => hash.update(chunk));
    input.on('error', reject);
    input.on('end', () => resolve(hash.digest('hex')));
  });
}

/** Troca um convite por uma credencial de dispositivo. */
async function enrollDevice({ origin, invite, label }) {
  const payload = JSON.stringify({ invite: String(invite ?? ''), label: String(label ?? '') });
  const response = await request(serviceUrl(origin, '/v1/devices/enroll'), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), accept: 'application/json' },
    body: payload,
  });
  const text = await readText(response, 16 * 1024);
  return JSON.parse(text);
}

/** Renova uma credencial que ainda vale. */
async function renewDevice({ origin, token }) {
  const response = await request(serviceUrl(origin, '/v1/devices/renew'), { method: 'POST', headers: buildHeaders(token) });
  return JSON.parse(await readText(response, 16 * 1024));
}

// ── Mensagens ───────────────────────────────────────────────────────────────
//
// Cada recusa tem a sua. "Não foi possível atualizar" cobre causas que levam a
// caminhos diferentes, e manda a pessoa procurar defeito no lugar errado.

function verificationMessage(documentName, failure) {
  const messages = {
    'contract-unknown': `Este ${documentName} foi publicado num formato que esta versão do Tumacord não conhece. Atualize pelo caminho manual.`,
    'no-signature': `O ${documentName} chegou sem assinatura e não foi aceito.`,
    'unknown-key': `O ${documentName} foi assinado por uma chave que este aplicativo não conhece. Se o grupo trocou de chave, é preciso atualizar pelo caminho manual.`,
    'key-revoked': `A chave que assinou este ${documentName} foi revogada.`,
    'key-not-yet-valid': `A chave que assinou este ${documentName} ainda não vale.`,
    'key-expired': `A chave que assinou este ${documentName} venceu.`,
    'key-wrong-scope': `A chave que assinou este ${documentName} não tem permissão para isso.`,
    'bad-signature': `A assinatura do ${documentName} não confere. Nada foi baixado.`,
  };
  return messages[failure] ?? `O ${documentName} não pôde ser verificado (${failure}).`;
}

function freshnessMessage(freshness) {
  const messages = {
    expired: 'A lista de versões do servidor está vencida. Nada é instalado sem saber qual é a política atual.',
    replayed: 'O servidor respondeu uma lista de versões mais antiga do que a última aceita. Nada foi instalado.',
    malformed: 'A lista de versões do servidor veio malformada.',
  };
  return messages[freshness] ?? `A lista de versões não pôde ser usada (${freshness}).`;
}

function mismatchMessage(failure) {
  const messages = {
    'digest-mismatch': 'O pacote baixado não confere com o resumo publicado; ele foi descartado.',
    'size-mismatch': 'O pacote baixado tem size diferente do publicado; ele foi descartado.',
    'version-mismatch': 'O pacote baixado é de outra versão; ele foi descartado.',
    'release-mismatch': 'O pacote baixado é de outra release; ele foi descartado.',
    'arch-mismatch': 'O pacote baixado é de outra arquitetura; ele foi descartado.',
    'format-mismatch': 'O pacote baixado está em outro formato; ele foi descartado.',
  };
  return messages[failure] ?? `O pacote baixado não confere (${failure}); ele foi descartado.`;
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  MAX_DOWNLOAD_BYTES,
  downloadArtifact,
  enrollDevice,
  fetchCatalog,
  fetchManifest,
  mismatchMessage,
  freshnessMessage,
  verificationMessage,
  renewDevice,
  selectArtifact,
  sha256OfFile,
};

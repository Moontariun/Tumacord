// A VPS buscando a release no repositório privado do GitHub.
//
// ## Onde este código roda, e por que não no serviço
//
// Aqui, no `tumacordctl`, que roda no host. **Não** no `tumacord-updates`: a
// propriedade declarada daquele serviço é que ele não fala com o GitHub, não
// executa nada e não assina documento nenhum — ele guarda e serve o que já
// chegou conferido. Dar a ele uma saída para a internet e um token trocaria
// essa propriedade por conveniência.
//
// ## O token
//
// Ele vive **na VPS**, e só nela. É o que permite o repositório continuar
// privado sem que cada aplicativo instalado carregue uma credencial do GitHub
// dentro do executável — que é o que aconteceria se o cliente buscasse
// direto, e que vazaria no primeiro `strings`.
//
// Um PAT *fine-grained* limitado a este repositório e a `Contents: read` é
// suficiente. Não use um token de conta inteira: quem ler o disco da VPS lê o
// token, e o estrago deve caber no que ele alcança.
//
// ## O redirecionamento, que é onde se perde credencial
//
// Em repositório privado o `browser_download_url` não serve: o download é pela
// API do asset, que responde **302** para o armazenamento. E o cabeçalho
// `Authorization` **não** acompanha esse salto — mandá-lo entregaria o token
// do GitHub ao host de destino, e é assim que se colhe credencial. Por isso o
// redirecionamento é seguido à mão aqui, em vez de deixado por conta do
// `fetch`: a decisão de largar o cabeçalho fica escrita, e não implícita no
// comportamento de uma biblioteca.

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const API = 'https://api.github.com';
const TIMEOUT_MS = 30_000;
/** Um pacote do Tumacord não passa disto. Acima, não é um pacote. */
export const MAX_ASSET_BYTES = 600 * 1024 * 1024;

/**
 * O token, de onde ele estiver.
 *
 * Um arquivo é melhor do que uma variável de ambiente: variável de ambiente
 * de processo aparece em `ps` de algumas formas e vaza em despejo de erro. O
 * arquivo pode ser 600 e pertencer a quem opera.
 */
export async function readToken({ env = process.env, tokenFile = '' } = {}) {
  if (tokenFile) {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(path.resolve(tokenFile), 'utf8');
    return raw.trim();
  }
  const padrao = '/etc/tumacord/github-token';
  try {
    const { readFile } = await import('node:fs/promises');
    return (await readFile(padrao, 'utf8')).trim();
  } catch { /* segue para o ambiente */ }
  return String(env.TUMACORD_GITHUB_TOKEN ?? '').trim();
}

function headers(token, accept) {
  return {
    accept,
    'user-agent': 'tumacordctl',
    'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}

async function pedir(url, { token, accept, seguirRedirecionamento = false } = {}) {
  const controller = new AbortController();
  const prazo = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resposta = await fetch(url, {
      headers: headers(token, accept),
      redirect: seguirRedirecionamento ? 'manual' : 'error',
      signal: controller.signal,
    });
    if (seguirRedirecionamento && resposta.status >= 300 && resposta.status < 400) {
      const destino = resposta.headers.get('location');
      if (!destino) throw new Error('O GitHub redirecionou sem dizer para onde.');
      // Sem `Authorization`, e de propósito: ver o cabeçalho deste arquivo.
      // O armazenamento assina a URL, então ele não precisa do token — e
      // mandá-lo seria entregá-lo a um host que não é o GitHub.
      const segundo = await fetch(destino, {
        headers: { accept, 'user-agent': 'tumacordctl' },
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!segundo.ok) throw new Error(`O armazenamento do GitHub respondeu ${segundo.status}.`);
      return segundo;
    }
    if (!resposta.ok) {
      const corpo = await resposta.text().catch(() => '');
      throw new Error(mensagemDeErro(resposta.status, corpo));
    }
    return resposta;
  } finally {
    clearTimeout(prazo);
  }
}

function mensagemDeErro(status, corpo) {
  let detalhe = '';
  try { detalhe = JSON.parse(corpo)?.message ?? ''; } catch { /* nem todo erro é JSON */ }
  if (status === 401) return 'O GitHub recusou o token (401). Ele expirou, foi revogado, ou está incompleto.';
  if (status === 403) return `O GitHub recusou por permissão ou limite de pedidos (403). ${detalhe}`.trim();
  if (status === 404) {
    // Em repositório privado, um token sem acesso recebe 404 e não 403 — o
    // GitHub não confirma a existência do que você não pode ver. Dizer as duas
    // possibilidades evita horas procurando a etiqueta errada.
    return 'Não encontrado (404). Ou a etiqueta não existe, ou o token não tem acesso a este repositório — em repositório privado o GitHub responde 404 aos dois casos.';
  }
  return `O GitHub respondeu ${status}. ${detalhe}`.trim();
}

/** A release publicada sob uma etiqueta. */
export async function releaseByTag({ repo, tag, token }) {
  const resposta = await pedir(`${API}/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, {
    token, accept: 'application/vnd.github+json',
  });
  return resposta.json();
}

/**
 * Baixa um asset, conferindo enquanto os bytes chegam.
 *
 * O resumo é calculado sobre o que foi para o disco, e o tamanho é comparado
 * com o que a API anunciou. Um arquivo ainda sendo enviado pelo CI aparece na
 * listagem antes de existir por inteiro, e baixá-lo daria um download truncado
 * com cara de corrupção — por isso `state` é conferido antes, por quem chama.
 */
export async function downloadAsset({ repo, asset, token, destination }) {
  if (asset.size > MAX_ASSET_BYTES) {
    throw new Error(`${asset.name} tem ${asset.size} bytes, acima do teto de ${MAX_ASSET_BYTES}. Nada foi baixado.`);
  }
  await mkdir(path.dirname(destination), { recursive: true });
  const resposta = await pedir(`${API}/repos/${repo}/releases/assets/${asset.id}`, {
    token,
    accept: 'application/octet-stream',
    seguirRedirecionamento: true,
  });

  const hash = createHash('sha256');
  let recebido = 0;
  const origem = Readable.fromWeb(resposta.body);
  origem.on('data', (pedaco) => {
    recebido += pedaco.length;
    hash.update(pedaco);
  });
  await pipeline(origem, createWriteStream(destination));

  const sha256 = hash.digest('hex');
  if (recebido !== asset.size) {
    throw new Error(`${asset.name} chegou com ${recebido} bytes; a API anunciou ${asset.size}. Descartado.`);
  }
  // A API entrega o resumo como `sha256:<hex>` quando o tem. Ele vem do mesmo
  // lugar que o arquivo, então não protege contra o GitHub — mas pega download
  // truncado e arquivo trocado no caminho, que é o que acontece na prática.
  const anunciado = typeof asset.digest === 'string' ? asset.digest.replace(/^sha256:/i, '').toLowerCase() : '';
  if (anunciado && anunciado !== sha256) {
    throw new Error(`${asset.name}: o resumo não confere com o que o GitHub anunciou. Descartado.`);
  }
  return { sha256, size: recebido, digestAnunciado: anunciado };
}

/** Assets que já terminaram de subir. O resto ainda não existe por inteiro. */
export function uploadedAssets(release) {
  return (release?.assets ?? []).filter((asset) => !asset.state || asset.state === 'uploaded');
}

/**
 * O commit exato de uma etiqueta.
 *
 * Não vale usar `target_commitish` da release: numa release criada a partir de
 * uma branch, esse campo é o **nome da branch** — que muda de significado
 * entre o momento em que a release foi criada e o momento em que isto roda. O
 * manifesto declara o commit que produziu aquele binário, e "a ponta de uma
 * branch" não é um commit.
 *
 * Uma etiqueta anotada aponta para um objeto `tag`, que por sua vez aponta
 * para o commit — daí o segundo salto.
 */
export async function commitForTag({ repo, tag, token }) {
  const referencia = await (await pedir(`${API}/repos/${repo}/git/ref/tags/${encodeURIComponent(tag)}`, {
    token, accept: 'application/vnd.github+json',
  })).json();
  const objeto = referencia?.object ?? {};
  if (objeto.type !== 'tag') return String(objeto.sha ?? '');
  const anotada = await (await pedir(`${API}/repos/${repo}/git/tags/${objeto.sha}`, {
    token, accept: 'application/vnd.github+json',
  })).json();
  return String(anotada?.object?.sha ?? '');
}

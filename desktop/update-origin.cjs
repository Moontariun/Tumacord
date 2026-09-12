// De onde este aplicativo aceita atualização, e em quem ele confia.
//
// ## A regra que sustenta o resto
//
// **Um servidor de chat qualquer não muda isto.** A origem das atualizações e
// as chaves confiáveis são configuração *do aplicativo*, e não algo que chega
// numa resposta da rede. Se um servidor pudesse anunciar "busque as
// atualizações aqui", entrar num servidor de alguém seria entregar a ele a
// capacidade de instalar código nesta máquina.
//
// Por isso a origem vem, nesta ordem:
//
//   1. do que foi embutido na build (o padrão do grupo);
//   2. de um arquivo local que só quem tem a máquina escreve;
//   3. da variável de ambiente, para homologação.
//
// E **nunca** de um socket, de uma resposta de API ou de um convite.
//
// ## Por que a origem não está escrita aqui
//
// Este repositório não traz o domínio de ninguém. A build oficial embute o
// dela; um clone sem configuração não tem origem, e nesse caso o aplicativo
// diz que não há de onde atualizar — em vez de tentar um endereço adivinhado.

const fs = require('node:fs');
const path = require('node:path');

/**
 * A origem embutida na build.
 *
 * Vazia neste repositório de propósito. O empacotamento oficial a define por
 * `TUMACORD_UPDATE_ORIGIN` no ambiente de build, e o valor fica gravado aqui
 * pelo `scripts/gerar-origem.mjs` quando ele existir.
 */
const BUILT_IN_ORIGIN = '';

/**
 * As chaves públicas em que esta build confia.
 *
 * Elas viajam **dentro do aplicativo**. Buscá-las na rede junto com o que elas
 * verificam seria pedir a chave a quem quer ser verificado.
 *
 * Vazia neste repositório, pelo mesmo motivo da origem: a build oficial embute
 * as dela.
 */
const BUILT_IN_KEYS = [];

/** Nome do arquivo local de configuração, dentro do `userData`. */
const ORIGIN_FILE = 'update-origin.json';

/**
 * Se uma origem é aceitável.
 *
 * `https` sempre; `http` só em `localhost`/`127.0.0.1`, que é o caso de
 * homologação na própria máquina. Um `http` para fora entregaria o catálogo e
 * a credencial a quem estiver no caminho — e a assinatura provaria que o
 * documento é autêntico sem impedir que ele seja o documento *antigo*.
 */
function originIsAcceptable(candidate) {
  let url;
  try {
    url = new URL(String(candidate));
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  if (url.protocol !== 'http:') return false;
  return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
}

/** A forma canônica de uma origem: só o esquema e o host, sem caminho. */
function normalizeOrigin(candidate) {
  if (!originIsAcceptable(candidate)) return '';
  return new URL(String(candidate)).origin;
}

function readOriginFile(userDataPath) {
  if (!userDataPath) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataPath, ORIGIN_FILE), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Onde este aplicativo busca atualização, e em quem confia.
 *
 * Devolve `origin` vazio quando não há origem configurada — e isso é dito na
 * tela, em vez de virar uma tentativa a um endereço adivinhado.
 */
function updateOrigin({ env = process.env, userDataPath = '' } = {}) {
  const stored = readOriginFile(userDataPath);

  // O ambiente vem primeiro porque ele é o caminho de homologação: quem o
  // define está na máquina e sabe o que está fazendo.
  const candidates = [env.TUMACORD_UPDATE_ORIGIN, stored?.origin, BUILT_IN_ORIGIN];
  let origin = '';
  let source = 'none';
  for (const [index, candidate] of candidates.entries()) {
    const normalized = normalizeOrigin(candidate);
    if (!normalized) continue;
    origin = normalized;
    source = ['ambiente', 'stored local', 'build'][index];
    break;
  }

  // As chaves seguem o mesmo caminho, e pelo mesmo motivo. Uma origem trocada
  // sem as chaves correspondentes não passa a valer: o catálogo dela não
  // verifica.
  const fromFile = Array.isArray(stored?.trustedKeys) ? stored.trustedKeys : [];
  const trustedKeys = fromFile.length ? fromFile : BUILT_IN_KEYS;

  return {
    origin,
    source,
    trustedKeys,
    /** O que a tela mostra quando não há de onde atualizar. */
    reason: origin
      ? ''
      : 'Este aplicativo não tem uma origem de atualizações configurada. Peça ao dono do servidor o endereço e o convite de dispositivo.',
  };
}

/**
 * Grava a origem escolhida por quem tem a máquina.
 *
 * Só a pessoa na frente do computador chega aqui — pelo assistente de
 * inscrição do dispositivo. Nenhum caminho de rede escreve este arquivo.
 */
function saveUpdateOrigin(userDataPath, { origin, trustedKeys = [] }) {
  const normalized = normalizeOrigin(origin);
  if (!normalized) throw new Error('Endereço de atualizações inválido: use https, ou http apenas em localhost.');
  if (!Array.isArray(trustedKeys) || !trustedKeys.length) {
    // Uma origem sem chave confiável não verifica nada, e aceitar isso seria
    // trocar a verificação por um endereço.
    throw new Error('Uma origem de atualizações precisa vir com as chaves públicas em que confiar.');
  }
  fs.mkdirSync(userDataPath, { recursive: true });
  const destination = path.join(userDataPath, ORIGIN_FILE);
  fs.writeFileSync(destination, `${JSON.stringify({ origin: normalized, trustedKeys }, null, 2)}\n`, { mode: 0o600 });
  return { origin: normalized, trustedKeys };
}

/**
 * Monta uma URL do serviço a partir de um caminho **fixo do código**.
 *
 * O caminho nunca vem da rede: os documentos assinados trazem identificadores,
 * e é este arquivo que decide em qual rota eles entram. Guardar URL num
 * documento assinado deixaria um manifesto mandar o aplicativo buscar binário
 * em outro domínio.
 */
function serviceUrl(origin, route, ...segments) {
  const base = normalizeOrigin(origin);
  if (!base) {
    // As duas recusas são ditas separadamente: "não configurei" e "configurei
    // errado" levam a caminhos diferentes, e um erro genérico manda quem for
    // investigar procurar no lugar errado.
    throw new Error(origin
      ? `Endereço de atualizações inválido (${String(origin)}): use https, ou http apenas em localhost.`
      : 'Sem origem de atualizações configurada.');
  }
  const parts = segments.map((segment) => {
    const text = String(segment ?? '');
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(text)) throw new Error(`Identificador inválido: ${JSON.stringify(text)}`);
    return encodeURIComponent(text);
  });
  return `${base}${route}${parts.length ? `/${parts.join('/')}` : ''}`;
}

module.exports = {
  ORIGIN_FILE,
  BUILT_IN_KEYS,
  BUILT_IN_ORIGIN,
  normalizeOrigin,
  originIsAcceptable,
  saveUpdateOrigin,
  serviceUrl,
  updateOrigin,
};

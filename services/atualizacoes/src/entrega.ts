// A entrega dos bytes de um pacote.
//
// Os arquivos ficam **fora do webroot**: eles não são servidos por caminho
// estático em lugar nenhum, e a única porta é esta — depois da autorização.
// Um diretório estático ao lado, ou uma listagem, seria um segundo caminho
// anônimo para o mesmo conteúdo, e o segundo caminho é sempre o que ninguém
// lembra de proteger.
//
// Retomada é requisito, não enfeite: um pacote de cem megabytes numa conexão
// ruim precisa continuar de onde parou. `Range` e `HEAD` passam **pela mesma
// autorização** do `GET` — um `HEAD` anônimo que revelasse tamanho e existência
// já seria informação, e um `Range` anônimo seria o download inteiro em
// pedaços.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

/** O teto de um pedido de faixa. Acima disso, o cliente pede em partes. */
export const MAX_RANGE_BYTES = 64 * 1024 * 1024;

export type RangeOutcome =
  | { kind: 'full'; start: number; end: number; length: number }
  | { kind: 'partial'; start: number; end: number; length: number }
  | { kind: 'unsatisfiable' }
  | { kind: 'malformed' };

/**
 * Interpreta um cabeçalho `Range`.
 *
 * Só a forma de uma faixa, de bytes, e só uma. Faixas múltiplas exigiriam
 * resposta `multipart/byteranges`, que nenhum cliente deste projeto pede e que
 * é superfície a mais para servir o mesmo arquivo.
 *
 * Uma faixa impossível devolve 416 em vez do arquivo inteiro: entregar tudo
 * para quem pediu um pedaço faria um cliente que retoma baixar de novo do
 * começo, achando que estava continuando.
 */
export function parseRange(header: unknown, size: number): RangeOutcome {
  if (header === undefined || header === null || header === '') return { kind: 'full', start: 0, end: Math.max(0, size - 1), length: size };
  if (typeof header !== 'string') return { kind: 'malformed' };
  const achado = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!achado) return { kind: 'malformed' };
  const [, inicioTexto, fimTexto] = achado;
  if (!inicioTexto && !fimTexto) return { kind: 'malformed' };

  // Um arquivo de tamanho zero não tem faixa nenhuma que satisfaça. Ele é
  // recusado antes, na conferência do pacote, mas a resposta certa aqui é 416
  // e não "pedido malformado": quem pediu não errou o pedido.
  if (size <= 0) return { kind: 'unsatisfiable' };

  let inicio: number;
  let fim: number;
  if (!inicioTexto) {
    // `bytes=-500`: os últimos 500 bytes.
    const ultimos = Number(fimTexto);
    if (!Number.isSafeInteger(ultimos) || ultimos <= 0) return { kind: 'malformed' };
    inicio = Math.max(0, size - ultimos);
    fim = size - 1;
  } else {
    inicio = Number(inicioTexto);
    if (!Number.isSafeInteger(inicio) || inicio < 0) return { kind: 'malformed' };
    fim = fimTexto ? Number(fimTexto) : size - 1;
    if (!Number.isSafeInteger(fim) || fim < 0) return { kind: 'malformed' };
  }
  if (size === 0 || inicio >= size) return { kind: 'unsatisfiable' };
  fim = Math.min(fim, size - 1);
  if (fim < inicio) return { kind: 'unsatisfiable' };
  // O teto protege memória e banda: a VPS divide rede com o chat e com o TURN.
  fim = Math.min(fim, inicio + MAX_RANGE_BYTES - 1);
  return { kind: 'partial', start: inicio, end: fim, length: fim - inicio + 1 };
}

/**
 * Resolve um caminho de armazenamento para um caminho de arquivo real.
 *
 * A conferência é feita sobre o caminho **já resolvido**, e não sobre o texto
 * que chegou: um `..` pode vir codificado, vir de um link simbólico ou aparecer
 * depois da junção. Comparar o resultado com a raiz é o que fecha isso.
 */
export function resolveStoragePath(root: string, storagePath: string): string | null {
  if (typeof storagePath !== 'string' || !storagePath) return null;
  if (storagePath.includes('\0')) return null;
  const raiz = path.resolve(root);
  const alvo = path.resolve(raiz, storagePath);
  if (alvo !== raiz && !alvo.startsWith(raiz + path.sep)) return null;
  return alvo;
}

export interface DeliveryPlan {
  status: 200 | 206 | 416;
  headers: Record<string, string>;
  /** Ausente em `HEAD` e em 416. */
  stream?: { path: string; start: number; end: number };
}

/**
 * O que responder a um pedido de download já autorizado.
 *
 * `HEAD` responde os mesmos cabeçalhos e nenhum corpo — é assim que um cliente
 * que retoma descobre o tamanho antes de pedir a faixa.
 */
export function planDelivery(options: {
  filePath: string;
  size: number;
  method: string;
  rangeHeader: unknown;
  fileName: string;
  sha256: string;
}): DeliveryPlan {
  const { filePath, size, method, rangeHeader, fileName, sha256 } = options;
  const faixa = parseRange(rangeHeader, size);
  const comuns: Record<string, string> = {
    'accept-ranges': 'bytes',
    'content-type': 'application/octet-stream',
    // Nome entre aspas e sem caractere de controle: ele vem do manifesto
    // assinado, mas vira cabeçalho, e cabeçalho com `\r` parte a resposta.
    'content-disposition': `attachment; filename="${fileName.replace(/[^A-Za-z0-9._-]/g, '_')}"`,
    // O resumo vai no cabeçalho para o cliente poder conferir enquanto baixa.
    // Ele não substitui a conferência contra o manifesto assinado: este
    // cabeçalho vem do mesmo lugar que os bytes.
    'x-tumacord-sha256': sha256,
    // Binário privado não entra em cache compartilhado. Um proxy guardando isto
    // serviria o arquivo a quem não foi autorizado.
    'cache-control': 'private, no-store',
    vary: 'Authorization',
  };

  if (faixa.kind === 'malformed' || faixa.kind === 'unsatisfiable') {
    return { status: 416, headers: { ...comuns, 'content-range': `bytes */${size}` } };
  }

  const parcial = faixa.kind === 'partial';
  const headers = {
    ...comuns,
    'content-length': String(faixa.length),
    ...(parcial ? { 'content-range': `bytes ${faixa.start}-${faixa.end}/${size}` } : {}),
  };
  if (method === 'HEAD') return { status: parcial ? 206 : 200, headers };
  return { status: parcial ? 206 : 200, headers, stream: { path: filePath, start: faixa.start, end: faixa.end } };
}

/** O tamanho real de um arquivo do armazenamento, ou `null` se não houver. */
export async function fileSize(filePath: string): Promise<number | null> {
  try {
    const estado = await stat(filePath);
    return estado.isFile() ? estado.size : null;
  } catch {
    return null;
  }
}

export function openRange(filePath: string, start: number, end: number): NodeJS.ReadableStream {
  return createReadStream(filePath, { start, end });
}

/**
 * Um limitador de downloads simultâneos.
 *
 * A VPS divide rede, CPU e disco com o chat e com o TURN. Sem teto, dez
 * pessoas atualizando ao mesmo tempo tiram a call de todo mundo — e o serviço
 * de atualização existe justamente para não precisar escolher entre as duas
 * coisas.
 */
export class ConcurrencyGate {
  private ativos = 0;
  constructor(private readonly limite: number) {}
  get active(): number { return this.ativos; }
  tryAcquire(): boolean {
    if (this.ativos >= this.limite) return false;
    this.ativos += 1;
    return true;
  }
  release(): void {
    this.ativos = Math.max(0, this.ativos - 1);
  }
}

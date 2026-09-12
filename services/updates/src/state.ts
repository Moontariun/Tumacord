// O estado do serviço de distribuição: o catálogo, os manifestos, os
// dispositivos e as chaves confiáveis.
//
// Fica em disco, num diretório **fora do checkout**. O checkout é descartável
// — ele é apagado e refeito a cada release — e guardar catálogo, pacotes ou
// autorizações dentro dele significaria perder tudo na primeira atualização do
// próprio serviço.
//
// ## Promoção atômica
//
// Publicar troca o catálogo inteiro de uma vez: grava num arquivo ao lado e
// renomeia por cima. Um `rename` no mesmo sistema de arquivos é atômico, então
// não existe instante em que alguém leia meio catálogo. Escrever por cima do
// arquivo vivo teria esse instante — e ele cai justamente quando há gente
// baixando, porque é quando se publica.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CHANNELS, CONTRACT_VERSION, type Catalog, type CatalogEntry, type ReleaseManifest, type Signed, type TrustedKey } from '../../../shared/distribution.js';
import type { DeviceRecord, InviteRecord } from './devices.js';

export interface DistributionState {
  /** O catálogo assinado, exatamente como ele é servido. */
  catalog: Signed<Catalog> | null;
  /** Os manifestos assinados, por release. */
  manifests: Record<string, Signed<ReleaseManifest>>;
  devices: DeviceRecord[];
  invites: InviteRecord[];
  /** As chaves em que este serviço confia para aceitar o que é importado. */
  trustedKeys: TrustedKey[];
  /** O histórico de catálogos publicados, para auditoria e recuperação. */
  history: { sequence: number; publishedAt: string; digest: string }[];
}

export function emptyState(): DistributionState {
  return { catalog: null, manifests: {}, devices: [], invites: [], trustedKeys: [], history: [] };
}

/** Um catálogo vazio, para o primeiro arranque. */
export function emptyCatalog(now: number, ttlMs: number): Catalog {
  return {
    contract: CONTRACT_VERSION,
    sequence: 0,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    channels: { stable: { entries: [] }, test: { entries: [] } },
  };
}

export class StateStore {
  private data: DistributionState = emptyState();
  private queue: Promise<void> = Promise.resolve();
  private readonly file: string;

  constructor(private readonly directory: string) {
    this.file = path.resolve(directory, 'distribution.json');
  }

  get state(): DistributionState { return this.data; }

  async load(): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    try {
      const loaded = JSON.parse(await readFile(this.file, 'utf8')) as Partial<DistributionState>;
      this.data = {
        catalog: loaded.catalog ?? null,
        manifests: loaded.manifests ?? {},
        devices: loaded.devices ?? [],
        invites: loaded.invites ?? [],
        trustedKeys: loaded.trustedKeys ?? [],
        history: loaded.history ?? [],
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.data = emptyState();
      await this.save();
    }
  }

  /**
   * Grava o estado.
   *
   * As gravações são encadeadas: duas ao mesmo tempo poderiam intercalar, e a
   * segunda a terminar venceria com o conteúdo da primeira. É o mesmo cuidado
   * do armazenamento do chat, pelo mesmo motivo.
   */
  private async save(): Promise<void> {
    const next = this.queue.then(async () => {
      const temporary = `${this.file}.next`;
      await writeFile(temporary, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 });
      // Renomear é atômico: ninguém lê meio arquivo.
      await rename(temporary, this.file);
    });
    this.queue = next.catch(() => undefined);
    await next;
  }

  async mutate(change: (state: DistributionState) => void): Promise<void> {
    change(this.data);
    await this.save();
  }
}

export type PublishFailure =
  | 'manifest-missing'
  | 'sequence-not-advancing'
  | 'entry-version-invalid'
  | 'duplicate-version'
  | 'reused-version'
  | 'unknown-channel';

export const PUBLISH_MESSAGES: Record<PublishFailure, string> = {
  'manifest-missing': 'Uma das entradas não tem manifesto importado. Importe a release antes de publicar.',
  'sequence-not-advancing': 'A sequência do catálogo precisa crescer a cada publicação.',
  'entry-version-invalid': 'Uma das entradas traz uma versão fora da convenção do produto.',
  'duplicate-version': 'A mesma versão aparece duas vezes no canal.',
  'reused-version': 'Essa versão já foi publicada apontando para outra release. Um número publicado não volta a ser usado para conteúdo diferente.',
  'unknown-channel': 'Canal desconhecido.',
};

/**
 * Confere um catálogo antes de ele virar o catálogo.
 *
 * A regra que dá mais trabalho e evita mais estrago: **um número já publicado
 * não volta a ser usado para conteúdo diferente**. Reaproveitar `0.9.9-1` para
 * outra release faria metade do grupo estar numa 0.9.9-1 e a outra metade
 * noutra, com o mesmo nome — e nenhum jeito de saber qual é qual olhando a
 * versão.
 */
export function validateCatalog(
  next: Catalog,
  current: Catalog | null,
  manifests: Record<string, Signed<ReleaseManifest>>,
): PublishFailure | null {
  if (current && next.sequence <= current.sequence) return 'sequence-not-advancing';
  const alreadyPublished = new Map<string, string>();
  for (const channel of CHANNELS) {
    for (const entry of current?.channels?.[channel]?.entries ?? []) {
      alreadyPublished.set(`${channel}:${entry.version}`, entry.releaseId);
    }
  }
  for (const channel of Object.keys(next.channels ?? {})) {
    if (!CHANNELS.includes(channel as never)) return 'unknown-channel';
  }
  for (const channel of CHANNELS) {
    const seen = new Set<string>();
    for (const entry of next.channels?.[channel]?.entries ?? []) {
      if (!entry?.version || !entry.releaseId) return 'entry-version-invalid';
      if (seen.has(entry.version)) return 'duplicate-version';
      seen.add(entry.version);
      const before = alreadyPublished.get(`${channel}:${entry.version}`);
      if (before && before !== entry.releaseId) return 'reused-version';
      if (!manifests[entry.releaseId]) return 'manifest-missing';
    }
  }
  return null;
}

/** Retira uma versão, aumentando a sequência sem oferecer nada novo. */
export function withdrawEntry(catalog: Catalog, channel: 'stable' | 'test', releaseId: string, reason: string, now: number): Catalog {
  return {
    ...catalog,
    sequence: catalog.sequence + 1,
    createdAt: new Date(now).toISOString(),
    channels: {
      ...catalog.channels,
      [channel]: {
        entries: (catalog.channels[channel]?.entries ?? []).map((entry): CatalogEntry => (
          entry.releaseId === releaseId
            ? { ...entry, state: 'withdrawn', withdrawn: { reason, at: new Date(now).toISOString() } }
            : entry
        )),
      },
    },
  };
}

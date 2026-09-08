// Preferência de codec de vídeo, e só quando há motivo medido.
//
// A regra é conservadora de propósito. `setCodecPreferences` com uma lista
// TRUNCADA é como se quebra uma chamada: o outro lado pode não ter o que
// sobrou, e a negociação termina sem vídeo. Aqui a lista nunca perde um item —
// ela só é REORDENADA. Quem não quiser o primeiro continua podendo escolher o
// segundo, e a compatibilidade bilateral fica preservada por construção.
//
// E a reordenação só acontece quando a medição diz que o encoder de vídeo por
// hardware não está disponível (`video_encode: disabled_software` no
// `getGPUFeatureStatus`). Nesse caso o custo do codec deixa de ser detalhe: um
// quadro 1080p em VP9 por software custa bem mais CPU que o mesmo quadro em
// VP8, e é CPU que o jogo também está querendo. Com encoder por hardware
// disponível — ou sem medição nenhuma — a escolha continua sendo do Chromium.

export interface CodecLike {
  mimeType: string;
  clockRate?: number;
  sdpFmtpLine?: string;
  payloadType?: number;
}

// Ordem para encoder de software, do mais barato ao mais caro por quadro.
// H264 vem antes de VP9 porque o OpenH264 costuma custar menos que o VP9 de
// software na mesma resolução; AV1 por software fica por último.
const SOFTWARE_ENCODE_ORDER = ['video/vp8', 'video/h264', 'video/vp9', 'video/av1'];

function rank(mimeType: string): number {
  const index = SOFTWARE_ENCODE_ORDER.indexOf(mimeType.toLowerCase());
  return index < 0 ? SOFTWARE_ENCODE_ORDER.length : index;
}

export function preferSoftwareFriendlyCodecs<T extends CodecLike>(codecs: readonly T[]): T[] {
  // Ordenação estável: dentro do mesmo codec, a ordem que o navegador deu
  // continua valendo. Ela carrega perfil e nível, e não é nossa para mexer.
  return codecs
    .map((codec, index) => ({ codec, index, rank: rank(codec.mimeType) }))
    .sort((left, right) => (left.rank - right.rank) || (left.index - right.index))
    .map((entry) => entry.codec);
}

export interface CodecDecision<T extends CodecLike> {
  apply: boolean;
  codecs: readonly T[];
  reason: 'sem-medição' | 'encoder-por-hardware' | 'sem-capacidades' | 'já-preferido' | 'encoder-por-software';
}

export function planVideoCodecPreference<T extends CodecLike>(input: {
  codecs: readonly T[] | undefined;
  hardwareEncode: boolean | null;
}): CodecDecision<T> {
  const codecs = input.codecs ?? [];
  if (!codecs.length) return { apply: false, codecs, reason: 'sem-capacidades' };
  if (input.hardwareEncode === null) return { apply: false, codecs, reason: 'sem-medição' };
  if (input.hardwareEncode) return { apply: false, codecs, reason: 'encoder-por-hardware' };
  const ordered = preferSoftwareFriendlyCodecs(codecs);
  const unchanged = ordered.every((codec, index) => codec === codecs[index]);
  if (unchanged) return { apply: false, codecs, reason: 'já-preferido' };
  return { apply: true, codecs: ordered, reason: 'encoder-por-software' };
}

// Orçamento de software, explicado.
//
// Sem encoder por hardware, 1440p60 e 1080p60 de tela em movimento não são um
// pedido caro: são um pedido que a CPU não entrega enquanto um jogo estiver
// rodando. Em vez de fingir que entrega e descobrir isso quadro a quadro, a
// live abre um degrau abaixo e SOBE se a medição mostrar folga — que é o
// caminho oposto ao de baixar depois que já estragou.
export function softwareEncodeHeadroom(input: { hardwareEncode: boolean | null; peers: number; targetFps: number }): { startFps: number; explain: string } {
  if (input.hardwareEncode !== false) return { startFps: input.targetFps, explain: '' };
  const peers = Math.max(1, input.peers);
  if (input.targetFps <= 30 && peers <= 2) {
    return { startFps: input.targetFps, explain: 'sem encoder por hardware; 30 FPS cabem em software nesta contagem de espectadores' };
  }
  const startFps = input.targetFps >= 60 ? (peers > 1 ? 30 : 48) : 30;
  return {
    startFps: Math.min(input.targetFps, startFps),
    explain: `sem encoder por hardware nesta máquina: a live abre em ${Math.min(input.targetFps, startFps)} FPS e sobe até ${input.targetFps} se houver folga medida`,
  };
}

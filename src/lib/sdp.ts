export interface VideoBitrateHints {
  startKbps: number;
  minKbps: number;
  maxKbps: number;
}

const GOOGLE_KEYS = ['x-google-start-bitrate', 'x-google-min-bitrate', 'x-google-max-bitrate'];
// rtx, red e fec descrevem redundância do payload principal; um fmtp inventado
// para eles quebraria a sessão inteira.
const AUXILIARY_CODECS = new Set(['rtx', 'red', 'ulpfec', 'flexfec-03']);

function withoutPreviousHints(parameters: string): string {
  return parameters
    .split(';')
    .map((entry) => entry.trim())
    .filter((entry) => entry && !GOOGLE_KEYS.some((key) => entry.toLowerCase().startsWith(`${key}=`)))
    .join(';');
}

function hintParameters(hints: VideoBitrateHints): string {
  return `x-google-start-bitrate=${hints.startKbps};x-google-min-bitrate=${hints.minKbps};x-google-max-bitrate=${hints.maxKbps}`;
}

// O controle de congestionamento do Chromium abre perto de 300 kbps e só
// descobre um enlace LAN/ZeroTier depois de dezenas de segundos — é por isso
// que a live entrava borrada e melhorava sozinha depois. Anunciar o ponto de
// partida e o piso na SDP é o único caminho suportado: `setParameters` não
// expõe start/min bitrate.
export function applyVideoBitrateHints(sdp: string, hints: VideoBitrateHints): string {
  if (typeof sdp !== 'string' || !sdp.includes('m=video')) return sdp;
  const separator = sdp.includes('\r\n') ? '\r\n' : '\n';
  const output: string[] = [];
  let inVideo = false;
  let bandwidthWritten = false;
  let primaryPayloads = new Set<string>();
  let withHints = new Set<string>();

  const flushMissingFmtp = () => {
    for (const payload of primaryPayloads) {
      if (!withHints.has(payload)) output.push(`a=fmtp:${payload} ${hintParameters(hints)}`);
    }
  };
  const writeBandwidth = () => {
    output.push(`b=AS:${hints.maxKbps}`);
    output.push(`b=TIAS:${hints.maxKbps * 1_000}`);
    bandwidthWritten = true;
  };

  for (const line of sdp.split(/\r\n|\n/)) {
    if (line.startsWith('m=')) {
      if (inVideo) flushMissingFmtp();
      inVideo = line.startsWith('m=video');
      bandwidthWritten = false;
      primaryPayloads = new Set();
      withHints = new Set();
      output.push(line);
      continue;
    }
    if (!inVideo) {
      output.push(line);
      continue;
    }
    // b=AS precisa ficar entre c= e a primeira linha a= da seção.
    if (line.startsWith('c=')) {
      output.push(line);
      writeBandwidth();
      continue;
    }
    if (line.startsWith('b=')) continue;
    if (line.startsWith('a=') && !bandwidthWritten) writeBandwidth();

    const rtpmap = /^a=rtpmap:(\d+) ([^/]+)\//.exec(line);
    if (rtpmap && !AUXILIARY_CODECS.has(rtpmap[2].toLowerCase())) primaryPayloads.add(rtpmap[1]);

    const fmtp = /^a=fmtp:(\d+) ?(.*)$/.exec(line);
    if (fmtp && primaryPayloads.has(fmtp[1])) {
      const kept = withoutPreviousHints(fmtp[2] ?? '');
      output.push(`a=fmtp:${fmtp[1]} ${kept ? `${kept};` : ''}${hintParameters(hints)}`);
      withHints.add(fmtp[1]);
      continue;
    }
    output.push(line);
  }
  if (inVideo) flushMissingFmtp();

  return output.join(separator);
}

// A faixa está entregando IMAGEM, ou está entregando preto?
//
// "Tela preta" foi relatado duas vezes neste projeto — na versão portable do
// Windows ao assistir por um servidor, e no Linux/Wayland — e as duas vezes a
// pergunta que faltava era a mesma: o preto nasce na captura de quem transmite
// ou no caminho de quem assiste? Sem essa resposta, os dois casos produzem
// exatamente o mesmo relato e nenhuma pista.
//
// A medida é direta: desenhar um quadro da faixa num canvas minúsculo e ler os
// pixels. Um `MediaStream` local ou de um `RTCPeerConnection` não contamina o
// canvas, então a leitura é permitida.
//
// Ela custa um quadro de 32×18 e só roda quando alguém pede o diagnóstico.

export interface FrameSample {
  /** Luminância média de 0 a 255. */
  mean: number;
  /** Quantos pixels amostrados não são praticamente pretos. */
  nonBlack: number;
  total: number;
  width: number;
  height: number;
}

const LARGURA = 32;
const ALTURA = 18;
const PRETO = 24;

export async function sampleTrackFrame(track: MediaStreamTrack, timeoutMs = 1_500): Promise<FrameSample | null> {
  if (typeof document === 'undefined' || track.readyState !== 'live') return null;
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  // Fora do documento e sem controles: isto não é uma prévia, é uma medição.
  video.srcObject = new MediaStream([track]);
  try {
    await new Promise<void>((resolve, reject) => {
      const pronto = () => resolve();
      const falhou = () => reject(new Error('a faixa não entregou quadro'));
      video.addEventListener('loadeddata', pronto, { once: true });
      video.addEventListener('error', falhou, { once: true });
      void video.play().catch(() => undefined);
      setTimeout(falhou, timeoutMs);
    });
    if (!video.videoWidth || !video.videoHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = LARGURA;
    canvas.height = ALTURA;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, LARGURA, ALTURA);
    const dados = ctx.getImageData(0, 0, LARGURA, ALTURA).data;
    let soma = 0;
    let naoPreto = 0;
    for (let i = 0; i < dados.length; i += 4) {
      const luz = (dados[i] + dados[i + 1] + dados[i + 2]) / 3;
      soma += luz;
      if (luz * 3 > PRETO) naoPreto += 1;
    }
    const total = LARGURA * ALTURA;
    return { mean: Math.round(soma / total), nonBlack: naoPreto, total, width: video.videoWidth, height: video.videoHeight };
  } catch {
    // Sem quadro em um segundo e meio já é resposta: a faixa não está
    // entregando imagem. Devolver `null` mantém isso como desconhecido, que é
    // o que ele é — pode ser a faixa, pode ser o elemento fora do documento.
    return null;
  } finally {
    video.srcObject = null;
    try { video.remove(); } catch { /* nunca esteve no documento */ }
  }
}

// A frase do relatório. "Preto" e "não medido" precisam ser distinguíveis: um é
// um defeito, o outro é ausência de informação.
export function describeFrameSample(rotulo: string, amostra: FrameSample | null): string {
  if (!amostra) return `  ${rotulo}: sem quadro para medir (desconhecido)`;
  const veredito = amostra.nonBlack === 0
    ? 'PRETO — a faixa entrega quadro, e o quadro é preto'
    : amostra.nonBlack < amostra.total / 20
      ? 'quase todo preto'
      : 'com imagem';
  return `  ${rotulo}: ${veredito} · ${amostra.width}×${amostra.height} · luminância média ${amostra.mean}/255 · ${amostra.nonBlack} de ${amostra.total} pixels com luz`;
}

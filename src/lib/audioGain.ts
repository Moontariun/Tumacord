// Acima de 100%, o controle passa a representar loudness percebido: +10 dB
// em 200% soa aproximadamente duas vezes mais alto. Um ganho linear de 2
// entrega só +6 dB e costuma parecer uma mudança pequena.
export function volumeToGain(volume: number): number {
  const safe = Math.max(0, Math.min(2, volume));
  if (safe <= 1) return safe;
  return 10 ** (((safe - 1) * 10) / 20);
}

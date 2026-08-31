// Acima de 100%, a escala é deliberadamente mais forte que um slider HTML
// comum. O teto de +18 dB torna 150–200% claramente audível mesmo em vozes
// gravadas baixo; o limitador do player continua protegendo contra picos.
export function volumeToGain(volume: number): number {
  const safe = Math.max(0, Math.min(2, volume));
  if (safe <= 1) return safe;
  return 10 ** (((safe - 1) * 18) / 20);
}

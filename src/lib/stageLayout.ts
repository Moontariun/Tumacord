// Como as lives se arrumam no palco.
//
// A grade antiga tinha três formatos fixos — um, dois lado a lado, e dois por
// dois para três ou quatro — e a partir da quinta live os quadros continuavam
// entrando em linhas de `1fr` até virarem selos. Três lives davam um buraco no
// canto de baixo, e numa janela alta e estreita dois quadros lado a lado
// sobravam com faixas pretas em cima e embaixo.
//
// Aqui a pergunta é outra: dado o espaço real do palco, qual número de colunas
// deixa cada quadro MAIOR? Os quadros têm a proporção de uma tela (16:9), a
// última linha fica centralizada, e a resposta muda sozinha quando a janela, a
// barra lateral ou a lista de membros mudam de tamanho.

export interface StageLayout {
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
}

/** Abaixo disto um quadro deixa de mostrar o que está sendo transmitido. */
export const MIN_TILE_HEIGHT = 120;

export function bestStageLayout(count: number, width: number, height: number, gap = 12, aspect = 16 / 9): StageLayout {
  if (count <= 0 || width <= 0 || height <= 0) return { columns: 1, rows: 1, tileWidth: 0, tileHeight: 0 };
  let best: (StageLayout & { area: number }) | null = null;
  for (let columns = 1; columns <= count; columns += 1) {
    const rows = Math.ceil(count / columns);
    const cellWidth = (width - gap * (columns - 1)) / columns;
    const cellHeight = (height - gap * (rows - 1)) / rows;
    if (cellWidth <= 0 || cellHeight <= 0) continue;
    let tileWidth = cellWidth;
    let tileHeight = tileWidth / aspect;
    if (tileHeight > cellHeight) {
      tileHeight = cellHeight;
      tileWidth = tileHeight * aspect;
    }
    const area = tileWidth * tileHeight;
    // Empate fica com o que veio antes, que tem menos colunas: com a mesma
    // área, uma coluna a menos deixa as lives mais perto do centro da tela.
    if (!best || area > best.area + 1) best = { columns, rows, tileWidth: Math.floor(tileWidth), tileHeight: Math.floor(tileHeight), area };
  }
  if (!best) return { columns: 1, rows: count, tileWidth: 0, tileHeight: 0 };
  const { area: _area, ...layout } = best;
  return layout;
}

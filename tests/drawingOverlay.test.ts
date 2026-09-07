import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { DrawingOverlay, displayForSource } = require('../desktop/drawing-overlay.cjs') as {
  DrawingOverlay: new (options: Record<string, unknown>) => {
    targetDisplay: (sourceId: string, kind: string) => { id: number } | null;
    show: (payload: Record<string, unknown>) => boolean;
    close: () => void;
    visible: boolean;
  };
  displayForSource: (sourceId: unknown, displays: Array<{ id: number }>, primary: { id: number } | null) => { id: number } | null;
};

const MONITORES = [
  { id: 11, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 22, bounds: { x: 1920, y: 0, width: 2560, height: 1440 } },
];

test('a fonte de captura aponta o monitor certo', () => {
  assert.equal(displayForSource('screen:22:0', MONITORES, MONITORES[0])?.id, 22);
  assert.equal(displayForSource('screen:11:0', MONITORES, MONITORES[0])?.id, 11);
});

// O portal do PipeWire nem sempre devolve um id que existe em
// `getAllDisplays()`. Cair no monitor principal é melhor do que não pintar.
test('id desconhecido cai no monitor principal', () => {
  assert.equal(displayForSource('screen:999:0', MONITORES, MONITORES[0])?.id, 11);
  assert.equal(displayForSource('screen:999:0', MONITORES, null), null, 'sem principal, não há onde pintar');
});

test('o que não é fonte de monitor não vira geometria inventada', () => {
  for (const fonte of ['window:1234:0', '', null, undefined, 'screen:', 'screen:abc:0', 42]) {
    assert.equal(displayForSource(fonte, MONITORES, MONITORES[0]), null, `aceitou ${JSON.stringify(fonte)}`);
  }
});

// A regra que sustenta a janela: coordenadas são frações do quadro capturado.
// Com um monitor, o quadro é o monitor e a conta fecha. Com uma janela, o
// quadro é aquela janela — e não sabemos onde ela está nem se ela se moveu.
test('capturando uma janela, a sobreposição não abre', () => {
  const overlay = new DrawingOverlay({
    createWindow: () => { throw new Error('não deveria ter criado janela'); },
    readDisplays: () => MONITORES,
    readPrimary: () => MONITORES[0],
  });
  assert.equal(overlay.targetDisplay('window:1234:0', 'window'), null);
  assert.equal(overlay.show({ sourceId: 'window:1234:0', sourceKind: 'window', strokes: [{ color: '#fff', at: 0, points: [] }], lifetime: 6_000 }), false);
  assert.equal(overlay.visible, false);
});

test('capturando um monitor, a janela abre nos limites daquele monitor', () => {
  const criadas: Array<Record<string, unknown>> = [];
  const enviados: Array<unknown> = [];
  const overlay = new DrawingOverlay({
    readDisplays: () => MONITORES,
    readPrimary: () => MONITORES[0],
    createWindow: (config: Record<string, unknown>) => {
      criadas.push(config);
      return janelaFalsa(enviados);
    },
  });
  const abriu = overlay.show({ sourceId: 'screen:22:0', sourceKind: 'screen', strokes: [{ color: '#ff5c5c', at: 1, points: [{ x: 0.5, y: 0.5 }] }], lifetime: 6_000 });
  assert.equal(abriu, true);
  assert.equal(criadas.length, 1);
  assert.equal(criadas[0].width, 2560, 'precisa cobrir o monitor que está sendo capturado');
  assert.equal(criadas[0].x, 1920);
  assert.equal(criadas[0].transparent, true);
  assert.equal(criadas[0].frame, false);
  assert.equal(criadas[0].focusable, false, 'a janela não pode roubar o foco de quem está jogando');
  assert.equal(criadas[0].skipTaskbar, true);
  assert.equal(enviados.length, 1, 'os traços seguem para a janela assim que ela abre');

  // Atualizar não recria a janela: recriar faria a sobreposição piscar a cada
  // ponto desenhado.
  overlay.show({ sourceId: 'screen:22:0', sourceKind: 'screen', strokes: [{ color: '#ff5c5c', at: 2, points: [{ x: 0.6, y: 0.6 }] }], lifetime: 6_000 });
  assert.equal(criadas.length, 1);
  assert.equal(enviados.length, 2);

  // Trocar de monitor recria, porque a geometria mudou.
  overlay.show({ sourceId: 'screen:11:0', sourceKind: 'screen', strokes: [{ color: '#fff', at: 3, points: [{ x: 0.1, y: 0.1 }] }], lifetime: 6_000 });
  assert.equal(criadas.length, 2);
  assert.equal(criadas[1].width, 1920);
});

// Compositor que recusa transparência, alfinete ou clique-passante não pode
// derrubar o aplicativo — no Wayland várias destas chamadas são ignoradas.
test('compositor que recusa os enfeites não derruba nada', () => {
  const overlay = new DrawingOverlay({
    readDisplays: () => MONITORES,
    readPrimary: () => MONITORES[0],
    createWindow: () => {
      const janela = janelaFalsa([]);
      janela.setIgnoreMouseEvents = () => { throw new Error('sem clique-passante'); };
      janela.setAlwaysOnTop = () => { throw new Error('sem alfinete'); };
      janela.setVisibleOnAllWorkspaces = () => { throw new Error('sem workspaces'); };
      janela.setContentProtection = () => { throw new Error('sem proteção de conteúdo'); };
      janela.setBounds = () => { throw new Error('Wayland ignora posição'); };
      janela.showInactive = () => { throw new Error('sem showInactive'); };
      return janela;
    },
  });
  assert.doesNotThrow(() => overlay.show({ sourceId: 'screen:11:0', sourceKind: 'screen', strokes: [{ color: '#fff', at: 0, points: [{ x: 0, y: 0 }] }], lifetime: 0 }));
  assert.equal(overlay.visible, true, 'a janela continua de pé mesmo sem os enfeites');
});

test('fechar é idempotente e some com a janela', () => {
  const overlay = new DrawingOverlay({
    readDisplays: () => MONITORES,
    readPrimary: () => MONITORES[0],
    createWindow: () => janelaFalsa([]),
  });
  overlay.show({ sourceId: 'screen:11:0', sourceKind: 'screen', strokes: [{ color: '#fff', at: 0, points: [{ x: 0, y: 0 }] }], lifetime: 6_000 });
  assert.equal(overlay.visible, true);
  overlay.close();
  overlay.close();
  assert.equal(overlay.visible, false);
});

function janelaFalsa(enviados: unknown[]) {
  let destruida = false;
  const ouvintes: Record<string, Array<() => void>> = {};
  return {
    setIgnoreMouseEvents: () => undefined,
    setAlwaysOnTop: () => undefined,
    setVisibleOnAllWorkspaces: () => undefined,
    setContentProtection: () => undefined,
    setBounds: () => undefined,
    showInactive: () => undefined,
    loadFile: () => Promise.resolve(),
    isDestroyed: () => destruida,
    close: () => { destruida = true; for (const fn of ouvintes.closed ?? []) fn(); },
    on: (evento: string, fn: () => void) => { (ouvintes[evento] ??= []).push(fn); },
    webContents: {
      send: (_canal: string, payload: unknown) => enviados.push(payload),
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
    },
  } as Record<string, unknown> as never;
}

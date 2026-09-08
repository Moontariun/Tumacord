import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { WindowActivity, presentationState, sameState } = require('../desktop/window-activity.cjs') as {
  WindowActivity: new (options: Record<string, unknown>) => {
    watch: (window: unknown) => void;
    refresh: () => void;
    unwatch: () => void;
    current: () => Record<string, unknown>;
  };
  presentationState: (input: { main?: unknown; detached?: unknown[] }) => Record<string, unknown>;
  sameState: (left: unknown, right: unknown) => boolean;
};

const VISIVEL = { minimized: false, visible: true, focused: true };

test('janela em foco pinta tudo; sem foco larga o enfeite; minimizada larga a prévia', () => {
  assert.deepEqual(presentationState({ main: VISIVEL }), { mode: 'active', paintPreviews: true, paintEffects: true, detachedVisible: false });
  assert.deepEqual(presentationState({ main: { ...VISIVEL, focused: false } }), { mode: 'background', paintPreviews: true, paintEffects: false, detachedVisible: false });
  assert.deepEqual(presentationState({ main: { ...VISIVEL, minimized: true } }), { mode: 'hidden', paintPreviews: false, paintEffects: false, detachedVisible: false });
  assert.deepEqual(presentationState({ main: { ...VISIVEL, visible: false } }), { mode: 'hidden', paintPreviews: false, paintEffects: false, detachedVisible: false });
});

// O caso que não pode quebrar: minimizar o Tumacord com a live solta na tela.
// A janela flutuante vive no mesmo processo de renderização, e apagar a
// pintura dela seria apagar a live que a pessoa está assistindo.
test('a live solta visível é anunciada mesmo com a janela principal minimizada', () => {
  const estado = presentationState({ main: { ...VISIVEL, minimized: true }, detached: [{ minimized: false, visible: true, focused: false }] });
  assert.equal(estado.mode, 'hidden');
  assert.equal(estado.detachedVisible, true);
});

test('uma live solta minimizada não conta como visível', () => {
  const estado = presentationState({ main: { ...VISIVEL, minimized: true }, detached: [{ minimized: true, visible: true, focused: false }] });
  assert.equal(estado.detachedVisible, false);
});

test('sem janela principal nada é pintado, e isso não estoura', () => {
  assert.equal(presentationState({}).mode, 'hidden');
  assert.equal(presentationState().mode, 'hidden');
});

test('o aviso só sai quando o estado muda de verdade', () => {
  const enviados: unknown[] = [];
  let minimized = false;
  const ouvintes: Record<string, Array<() => void>> = {};
  const janela = {
    on: (evento: string, handler: () => void) => { (ouvintes[evento] ??= []).push(handler); },
    removeListener: () => undefined,
    isDestroyed: () => false,
    isMinimized: () => minimized,
    isVisible: () => true,
    isFocused: () => !minimized,
  };
  const activity = new WindowActivity({ send: (state: unknown) => enviados.push(state), readDetached: () => [] });
  activity.watch(janela);
  assert.equal(enviados.length, 1, 'o primeiro estado é anunciado sempre');
  for (const handler of ouvintes.focus ?? []) handler();
  assert.equal(enviados.length, 1, 'foco repetido não gera mensagem nova');
  minimized = true;
  for (const handler of ouvintes.minimize ?? []) handler();
  assert.equal(enviados.length, 2);
  assert.equal((enviados[1] as { mode: string }).mode, 'hidden');
  activity.unwatch();
});

test('um send que estoura não derruba o processo principal', () => {
  const activity = new WindowActivity({ send: () => { throw new Error('renderer foi embora'); }, readDetached: () => [] });
  assert.doesNotThrow(() => activity.watch({ on: () => undefined, removeListener: () => undefined, isDestroyed: () => false, isMinimized: () => false, isVisible: () => true, isFocused: () => true }));
  activity.unwatch();
});

test('comparação de estado', () => {
  assert.equal(sameState(presentationState({ main: VISIVEL }), presentationState({ main: VISIVEL })), true);
  assert.equal(sameState(presentationState({ main: VISIVEL }), presentationState({ main: { ...VISIVEL, focused: false } })), false);
  assert.equal(sameState(null, presentationState({ main: VISIVEL })), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import { SCREEN_AUDIO_WORKLET_NAME, SCREEN_AUDIO_WORKLET_SOURCE } from '../src/lib/screenAudioWorklet';

// O processador roda em outra thread, num ambiente que não é o do bundle. O
// teste avalia exatamente a mesma string que o navegador carrega — não uma
// cópia da lógica —, então o que passa aqui é o que roda na live.
interface Processor {
  port: { onmessage: ((event: { data: unknown }) => void) | null; postMessage: (value: unknown) => void };
  process: (inputs: unknown[], outputs: Float32Array[][]) => boolean;
  filled: number;
  capacity: number;
  underruns: number;
  overruns: number;
  drifts: number;
  started: boolean;
}

function instantiate(processorOptions: Record<string, number> = {}) {
  const stats: unknown[] = [];
  class AudioWorkletProcessorStub {
    port = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (value: unknown) => stats.push(value),
    };
  }
  let registered: { name: string; ctor: new (options: unknown) => Processor } | null = null;
  const registerProcessor = (name: string, ctor: new (options: unknown) => Processor) => {
    registered = { name, ctor };
  };
  // eslint-disable-next-line no-new-func
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', SCREEN_AUDIO_WORKLET_SOURCE)(
    AudioWorkletProcessorStub,
    registerProcessor,
    48_000,
  );
  assert.ok(registered, 'o módulo precisa registrar o processador');
  assert.equal(registered!.name, SCREEN_AUDIO_WORKLET_NAME);
  return { processor: new registered!.ctor({ processorOptions }), stats };
}

function block(size = 128): Float32Array[][] {
  return [[new Float32Array(size), new Float32Array(size)]];
}

function feed(processor: Processor, frames: number, value: number) {
  const samples = new Float32Array(frames * 2);
  for (let index = 0; index < frames; index += 1) {
    samples[index * 2] = value;
    samples[index * 2 + 1] = -value;
  }
  processor.port.onmessage?.({ data: samples.buffer });
}

test('nada sai antes de o amortecedor encher', () => {
  const { processor } = instantiate({ capacity: 2048, target: 256, ceiling: 1024 });
  const outputs = block();
  feed(processor, 100, 0.5);
  processor.process([], outputs);
  assert.equal(processor.started, false);
  assert.ok(outputs[0][0].every((sample) => sample === 0), 'sem amortecedor, a saída é silêncio');
  feed(processor, 300, 0.5);
  processor.process([], outputs);
  assert.equal(processor.started, true);
});

test('o áudio atravessa sem alteração quando cabe em ±1', () => {
  const { processor } = instantiate({ capacity: 4096, target: 256, ceiling: 2048 });
  feed(processor, 1024, 0.25);
  const outputs = block();
  processor.process([], outputs);
  assert.ok(outputs[0][0].every((sample) => Math.abs(sample - 0.25) < 1e-6), 'o canal esquerdo precisa sair igual');
  assert.ok(outputs[0][1].every((sample) => Math.abs(sample + 0.25) < 1e-6), 'o canal direito precisa sair igual');
});

// A mistura nativa soma as aplicações em float e não limita: float aguenta a
// soma, a faixa Opus não. O corte precisa acontecer aqui, e sem deixar passar
// nem uma amostra fora da faixa.
test('a soma de várias aplicações nunca sai fora de ±1', () => {
  const { processor } = instantiate({ capacity: 8192, target: 256, ceiling: 4096 });
  feed(processor, 4096, 3.2);
  const outputs = block();
  let extremes = 0;
  for (let round = 0; round < 24; round += 1) {
    processor.process([], outputs);
    for (const channel of outputs[0]) {
      for (const sample of channel) {
        assert.ok(sample <= 1 && sample >= -1, `amostra fora da faixa: ${sample}`);
        if (Math.abs(sample) > 0.99) extremes += 1;
      }
    }
  }
  // Depois do ataque do limitador o sinal precisa assentar abaixo do teto, e
  // não ficar grudado em 1 — grudado em 1 seria distorção, não limitação.
  const settled = outputs[0][0].every((sample) => Math.abs(sample) < 0.9);
  assert.equal(settled, true, 'o limitador precisa assentar abaixo do teto');
  assert.ok(extremes < 128, 'o corte duro não pode ser o mecanismo principal');
});

test('um sinal quieto não é mexido pelo limitador', () => {
  const { processor } = instantiate({ capacity: 4096, target: 256, ceiling: 2048 });
  feed(processor, 2048, 0.05);
  const outputs = block();
  for (let round = 0; round < 8; round += 1) processor.process([], outputs);
  assert.ok(outputs[0][0].every((sample) => Math.abs(sample - 0.05) < 1e-3), 'sem pico, o ganho fica em 1');
});

test('o anel tem teto: uma live longa não cresce em memória', () => {
  const { processor } = instantiate({ capacity: 512, target: 128, ceiling: 384 });
  for (let round = 0; round < 40; round += 1) feed(processor, 480, 0.1);
  assert.equal(processor.filled <= processor.capacity, true);
  assert.equal(processor.capacity, 512);
  assert.ok(processor.overruns > 0, 'o descarte precisa ser contado');
});

// Os relógios do motor de áudio do Windows e do AudioContext não são o mesmo.
// Sem devolver o excesso, a latência cresce por horas de live.
test('o excesso acumulado é devolvido em vez de virar atraso permanente', () => {
  const { processor } = instantiate({ capacity: 8192, target: 256, ceiling: 1024 });
  feed(processor, 4000, 0.2);
  const outputs = block();
  processor.process([], outputs);
  assert.equal(processor.drifts, 1);
  assert.ok(processor.filled <= 256, `o amortecedor precisa voltar ao alvo, ficou em ${processor.filled}`);
});

test('sem dados a saída é silêncio, e a falta é contada', () => {
  const { processor } = instantiate({ capacity: 512, target: 4, ceiling: 256 });
  feed(processor, 8, 0.5);
  const outputs = block();
  processor.process([], outputs);
  processor.process([], outputs);
  assert.ok(processor.underruns > 0, 'a falta precisa aparecer no diagnóstico');
  assert.ok(outputs[0][0].every((sample) => sample === 0));
});

test('o pedido de limpeza esvazia o anel sem derrubar o processador', () => {
  const { processor } = instantiate({ capacity: 1024, target: 128, ceiling: 512 });
  feed(processor, 512, 0.4);
  processor.port.onmessage?.({ data: 'flush' });
  assert.equal(processor.filled, 0);
  assert.equal(processor.started, false);
  const outputs = block();
  processor.process([], outputs);
  assert.ok(outputs[0][0].every((sample) => sample === 0));
});

test('uma mensagem que não é áudio é ignorada', () => {
  const { processor } = instantiate({ capacity: 512, target: 64, ceiling: 256 });
  processor.port.onmessage?.({ data: null });
  processor.port.onmessage?.({ data: { pcm: true } });
  assert.equal(processor.filled, 0);
});

test('o diagnóstico do amortecedor sobe a cada segundo de áudio', () => {
  const { processor, stats } = instantiate({ capacity: 96_000, target: 256, ceiling: 48_000 });
  feed(processor, 60_000, 0.1);
  const outputs = block();
  for (let round = 0; round < 400; round += 1) processor.process([], outputs);
  assert.ok(stats.length >= 1, 'o processador precisa relatar o estado do amortecedor');
  const report = stats[0] as Record<string, number>;
  assert.equal(typeof report.buffered, 'number');
  assert.equal(typeof report.underruns, 'number');
  assert.equal(typeof report.overruns, 'number');
});

// Um contexto que não abre a 48 kHz não pode virar áudio acelerado.
test('uma taxa de contexto diferente é reamostrada em vez de acelerar o som', () => {
  const { processor } = instantiate({ capacity: 16_384, target: 512, ceiling: 8_192, sourceRate: 48_000, contextRate: 44_100 });
  feed(processor, 4410, 0.3);
  const outputs = block();
  const antes = processor.filled;
  processor.process([], outputs);
  const consumidos = antes - processor.filled;
  // 128 amostras de saída a 44,1 kHz consomem ~139 quadros de entrada a 48 kHz.
  assert.ok(consumidos >= 135 && consumidos <= 142, `consumo fora do esperado: ${consumidos}`);
  assert.ok(outputs[0][0].every((sample) => Math.abs(sample - 0.3) < 1e-3));
});

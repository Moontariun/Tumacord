import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { formatInboundVideo, formatOutboundVideo, readInboundVideo, readOutboundVideo } from '../src/lib/videoStats.js';
import { planVideoCodecPreference, preferSoftwareFriendlyCodecs, softwareEncodeHeadroom } from '../src/lib/codecPolicy.js';
import { classifyPaint, observePaint, initialPresentationState, paintFps, PaintMonitor, FAULT_THRESHOLD } from '../src/lib/presentationHealth.js';
import { describeFrameSample } from '../src/lib/frameProbe.js';

const require = createRequire(import.meta.url);
const { effectiveOzoneBackend, readAccelerationSummary, sanitizeSwitches, summarizeMetrics, describeWindow } = require('../desktop/graphics-report.cjs') as {
  effectiveOzoneBackend: (argv: string[], environment: Record<string, string>, platform: string) => string;
  readAccelerationSummary: (status: Record<string, string> | null) => { compositing: string; videoEncode: string; videoDecode: string };
  sanitizeSwitches: (argv: string[]) => string[];
  summarizeMetrics: (metrics: unknown[]) => Array<Record<string, unknown>>;
  describeWindow: (window: unknown) => Record<string, unknown>;
};

test('o relatório não carrega caminho de instalação, endereço nem chave', () => {
  const argv = [
    '/home/renan/Programas/Tumacord/tumacord',
    '--ozone-platform-hint=auto',
    '--enable-features=WebRTCPipeWireCapturer,WaylandWindowDecorations',
    '--tumacord-invite=abc123segredo',
    '--server-url=https://192.168.0.7:3927',
    '--user-data-dir=/home/renan/.config/tumacord',
    '--tumacord-safe-gpu',
  ];
  const limpo = sanitizeSwitches(argv);
  assert.deepEqual(limpo, ['ozone-platform-hint=auto', 'enable-features=WebRTCPipeWireCapturer,WaylandWindowDecorations', 'tumacord-safe-gpu']);
  assert.equal(limpo.join(' ').includes('renan'), false);
  assert.equal(limpo.join(' ').includes('192.168'), false);
  assert.equal(limpo.join(' ').includes('segredo'), false);
});

test('o backend efetivo não é o hint: ele é decidido pela sessão ou pela bandeira explícita', () => {
  assert.equal(effectiveOzoneBackend(['--ozone-platform=x11'], { WAYLAND_DISPLAY: 'wayland-0' }, 'linux'), 'x11');
  assert.match(effectiveOzoneBackend(['--ozone-platform-hint=auto'], { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland' }, 'linux'), /^wayland/);
  assert.match(effectiveOzoneBackend(['--ozone-platform-hint=auto'], { DISPLAY: ':0', XDG_SESSION_TYPE: 'x11' }, 'linux'), /^x11/);
  assert.equal(effectiveOzoneBackend([], {}, 'win32'), 'windows');
});

// A confusão que este projeto cometeu antes: ler composição acelerada como se
// fosse encode por hardware.
test('composição acelerada e encode por hardware são lidos separados', () => {
  const medido = readAccelerationSummary({ gpu_compositing: 'enabled', video_encode: 'disabled_software', video_decode: 'enabled' });
  assert.deepEqual(medido, { compositing: 'acelerado', videoEncode: 'software', videoDecode: 'acelerado' });
  const semMedida = readAccelerationSummary(null);
  assert.deepEqual(semMedida, { compositing: 'desconhecido', videoEncode: 'desconhecido', videoDecode: 'desconhecido' });
});

test('estatística ausente aparece como desconhecida, nunca como zero', () => {
  const saida = readOutboundVideo([{ type: 'outbound-rtp', kind: 'video', bytesSent: 100 }], undefined, 1_000);
  assert.ok(saida);
  assert.equal(saida.framesEncodedDelta, undefined);
  assert.equal(saida.averageEncodeMs, undefined);
  assert.equal(saida.encoderImplementation, undefined);
  const texto = formatOutboundVideo(saida, { width: 1920, height: 1080, frameRate: 60 }).join('\n');
  assert.match(texto, /encoder: desconhecido/);
  assert.match(texto, /tempo médio de encode: desconhecido/);
  assert.equal(texto.includes(': 0 ms'), false);
});

test('tempo médio de encode vem de diferença, não de um campo pronto', () => {
  const primeiro = readOutboundVideo(
    [{ type: 'outbound-rtp', kind: 'video', bytesSent: 1_000, framesEncoded: 100, totalEncodeTime: 1 }],
    undefined,
    1_000,
  );
  assert.ok(primeiro);
  const segundo = readOutboundVideo(
    [{ type: 'outbound-rtp', kind: 'video', bytesSent: 3_000, framesEncoded: 160, totalEncodeTime: 1.6, qualityLimitationReason: 'cpu' }],
    primeiro.counters,
    3_000,
  );
  assert.ok(segundo);
  assert.equal(segundo.framesEncodedDelta, 60);
  assert.equal(Math.round(segundo.averageEncodeMs ?? 0), 10);
  assert.equal(segundo.bitrateBps, 8_000);
  assert.equal(segundo.qualityLimitationReason, 'cpu');
});

test('codec negociado e implementação de decoder saem do relatório quando existem', () => {
  const stats = [
    { id: 'in', type: 'inbound-rtp', kind: 'video', bytesReceived: 100, framesDecoded: 10, totalDecodeTime: 0.02, codecId: 'c1', decoderImplementation: 'libvpx', powerEfficientDecoder: false, freezeCount: 2 },
    { id: 'c1', type: 'codec', mimeType: 'video/VP9' },
  ];
  const entrada = readInboundVideo(stats, undefined, 1_000);
  assert.ok(entrada);
  assert.equal(entrada.codec, 'VP9');
  assert.equal(entrada.decoderImplementation, 'libvpx');
  const texto = formatInboundVideo(entrada).join('\n');
  assert.match(texto, /decoder: libvpx \(não eficiente\)/);
  assert.match(texto, /congelamentos: 2/);
});

test('sem medição de aceleração, a ordem de codec não é tocada', () => {
  const codecs = [{ mimeType: 'video/VP9' }, { mimeType: 'video/VP8' }, { mimeType: 'video/H264' }];
  assert.equal(planVideoCodecPreference({ codecs, hardwareEncode: null }).apply, false);
  assert.equal(planVideoCodecPreference({ codecs, hardwareEncode: true }).apply, false);
  assert.equal(planVideoCodecPreference({ codecs: [], hardwareEncode: false }).apply, false);
});

// Truncar a lista é como se quebra uma chamada. Reordenar não tira nada de
// ninguém.
test('a preferência de codec reordena sem nunca remover um codec', () => {
  const codecs = [{ mimeType: 'video/AV1' }, { mimeType: 'video/VP9' }, { mimeType: 'video/VP8' }, { mimeType: 'video/H264' }, { mimeType: 'video/rtx' }];
  const decisao = planVideoCodecPreference({ codecs, hardwareEncode: false });
  assert.equal(decisao.apply, true);
  assert.equal(decisao.codecs.length, codecs.length);
  for (const codec of codecs) assert.ok(decisao.codecs.includes(codec), `${codec.mimeType} sumiu da lista`);
  assert.deepEqual(decisao.codecs.map((codec) => codec.mimeType), ['video/VP8', 'video/H264', 'video/VP9', 'video/AV1', 'video/rtx']);
  // Ordenação estável: dois perfis do mesmo codec mantêm a ordem do navegador.
  const doisH264 = preferSoftwareFriendlyCodecs([{ mimeType: 'video/H264', sdpFmtpLine: 'a' }, { mimeType: 'video/H264', sdpFmtpLine: 'b' }]);
  assert.deepEqual(doisH264.map((codec) => codec.sdpFmtpLine), ['a', 'b']);
});

test('sem encoder por hardware a live abre um degrau abaixo e explica o motivo', () => {
  const semHardware = softwareEncodeHeadroom({ hardwareEncode: false, peers: 1, targetFps: 60 });
  assert.equal(semHardware.startFps, 48);
  assert.match(semHardware.explain, /sem encoder por hardware/);
  assert.equal(softwareEncodeHeadroom({ hardwareEncode: false, peers: 3, targetFps: 60 }).startFps, 30);
  // Com hardware, ou sem medição, nada muda e nada é anunciado.
  assert.deepEqual(softwareEncodeHeadroom({ hardwareEncode: true, peers: 3, targetFps: 60 }), { startFps: 60, explain: '' });
  assert.deepEqual(softwareEncodeHeadroom({ hardwareEncode: null, peers: 3, targetFps: 60 }), { startFps: 60, explain: '' });
});

test('a cadência de pintura só é julgada com a janela em primeiro plano', () => {
  const parada = { frames: 0, elapsedMs: 2_000, longestGapMs: 2_000 };
  assert.equal(classifyPaint(parada, false), 'unknown');
  assert.equal(classifyPaint(parada, true), 'stalled');
  assert.equal(classifyPaint({ frames: 120, elapsedMs: 2_000, longestGapMs: 20 }, true), 'healthy');
  assert.equal(classifyPaint({ frames: 24, elapsedMs: 2_000, longestGapMs: 200 }, true), 'degraded');
  // Média boa com um buraco de mais de um segundo ainda é travamento visível.
  assert.equal(classifyPaint({ frames: 100, elapsedMs: 2_000, longestGapMs: 1_400 }, true), 'stalled');
  assert.equal(Math.round(paintFps({ frames: 120, elapsedMs: 2_000, longestGapMs: 5 }) ?? 0), 60);
});

test('a falha de apresentação é reportada uma vez, não uma por amostra', () => {
  let state = initialPresentationState();
  const ruim = { frames: 0, elapsedMs: 2_000, longestGapMs: 2_000 };
  const primeira = observePaint(state, ruim, true);
  assert.equal(primeira.report, false);
  state = primeira;
  const segunda = observePaint(state, ruim, true);
  assert.equal(segunda.report, true, `${FAULT_THRESHOLD} janelas ruins confirmam a falha`);
  state = segunda;
  const terceira = observePaint(state, ruim, true);
  assert.equal(terceira.report, false, 'a falha já foi reportada; não se repete');
});

test('processos e janelas entram no relatório sem inventar número', () => {
  assert.deepEqual(summarizeMetrics([{ type: 'GPU', cpu: { percentCPUUsage: 12.34 }, memory: { workingSetSize: 204_800 } }, { type: 'Renderer' }]), [
    { type: 'GPU', cpuPercent: 12.3, memoryMb: 200 },
    { type: 'Renderer', cpuPercent: undefined, memoryMb: undefined },
  ]);
  const janela = describeWindow({ id: 3, isMinimized: () => true, isVisible: () => true, isFocused: () => false, isFullScreen: () => false, isDestroyed: () => false });
  assert.equal(janela.minimized, true);
  assert.equal(janela.focused, false);
});

// Os dois relatos de "tela preta" — Windows portable assistindo por servidor, e
// Linux/Wayland — produziam o mesmo texto e nenhuma pista. Preto medido e
// ausência de medida precisam ser distinguíveis.
test('quadro preto e quadro não medido não podem virar a mesma frase', () => {
  const semMedida = describeFrameSample('quadro da minha captura', null);
  assert.match(semMedida, /desconhecido/);
  assert.equal(semMedida.includes('PRETO'), false);

  const preto = describeFrameSample('quadro da minha captura', { mean: 0, nonBlack: 0, total: 576, width: 1920, height: 1080 });
  assert.match(preto, /PRETO/);
  assert.match(preto, /1920×1080/, 'a faixa entrega quadro de tamanho conhecido, e o quadro é preto');

  const comImagem = describeFrameSample('quadro recebido', { mean: 118, nonBlack: 570, total: 576, width: 1280, height: 720 });
  assert.match(comImagem, /com imagem/);
  assert.equal(comImagem.includes('PRETO'), false);

  const quaseTodoPreto = describeFrameSample('quadro recebido', { mean: 3, nonBlack: 4, total: 576, width: 1280, height: 720 });
  assert.match(quaseTodoPreto, /quase todo preto/);
});

// Um vigia que continua agendando quadros depois de parar é exatamente o tipo
// de vazamento que a versão anterior tinha na sobreposição de desenho.
test('o medidor de cadência solta o agendamento ao parar', () => {
  let proximo = 1;
  const agendados = new Set<number>();
  let relogio = 0;
  const monitor = new PaintMonitor(
    (callback) => {
      const id = proximo++;
      agendados.add(id);
      // Um quadro imediato, como o navegador faria.
      queueMicrotask(() => { if (agendados.has(id)) { agendados.delete(id); relogio += 16; callback(relogio); } });
      return id;
    },
    (id) => { agendados.delete(id); },
    () => relogio,
  );
  monitor.start();
  monitor.stop();
  assert.equal(agendados.size, 0, 'nenhum quadro continua agendado depois de parar');
  // Parar duas vezes é seguro, e a amostra depois de parar não inventa quadros.
  monitor.stop();
  const amostra = monitor.take();
  assert.equal(amostra.frames, 0);
  assert.ok(amostra.elapsedMs >= 1);
});

// Uma janela de medição sem nenhum quadro precisa denunciar o silêncio inteiro,
// não um intervalo de zero. Era assim que uma pintura PARADA ficava invisível.
test('pintura parada aparece como intervalo grande, não como ausência de dados', () => {
  let relogio = 1_000;
  const monitor = new PaintMonitor(() => 1, () => undefined, () => relogio);
  monitor.start();
  relogio = 4_000;
  const amostra = monitor.take();
  assert.equal(amostra.frames, 0);
  assert.equal(amostra.longestGapMs, 3_000, 'o silêncio desde o início da janela é o intervalo');
  assert.equal(classifyPaint(amostra, true), 'stalled');
  monitor.stop();
});

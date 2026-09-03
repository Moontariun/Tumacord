import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { ScreenAudioRouter, activePipewireLinks, isCallAudio, screenAudioRoutePlan, staleModuleIds } = require('../desktop/audio-router.cjs') as {
  ScreenAudioRouter: new (options?: unknown) => {
    active: boolean;
    timer: unknown;
    prepare: () => Promise<{ ok: boolean }>;
    stop: () => Promise<{ ok: boolean }>;
  };
  activePipewireLinks: (graph: unknown[]) => Set<string>;
  isCallAudio: (input: unknown) => boolean;
  screenAudioRoutePlan: (graph: unknown[]) => { busFound: boolean; sourceFound: boolean; links: string[][] };
  staleModuleIds: (output: string) => string[];
};

test('mantém Discord fora do barramento da transmissão', () => {
  assert.equal(isCallAudio({ properties: { 'application.name': 'WEBRTC VoiceEngine', 'application.process.binary': 'Discord' } }), true);
});

test('mantém o próprio Tumacord fora do barramento da transmissão', () => {
  assert.equal(isCallAudio({ properties: { 'application.name': 'Tumacord', 'application.id': 'br.com.tumacord.app' } }), true);
});

test('inclui jogos e aplicativos comuns no áudio da tela', () => {
  assert.equal(isCallAudio({ properties: { 'application.name': 'FMOD Audio', 'application.process.binary': 'game' } }), false);
});

test('usa os links ativos do grafo PipeWire em vez de confiar em cache antigo', () => {
  const links = activePipewireLinks([
    { type: 'PipeWire:Interface:Port', id: 10 },
    { type: 'PipeWire:Interface:Link', info: { props: { 'link.output.port': 42, 'link.input.port': 77 } } },
  ]);
  assert.deepEqual([...links], ['42:77']);
  assert.equal(links.has('12:77'), false);
});

test('remove módulos antigos usando os IDs reais do formato short do PipeWire', () => {
  const output = [
    '536870916\tmodule-null-sink\tsink_name=tumacord_stream_bus rate=48000',
    '536870917\tmodule-remap-source\tmaster=tumacord_stream_bus.monitor source_name=tumacord_stream_source',
    '536870920\tmodule-always-sink\t',
  ].join('\n');
  assert.deepEqual(staleModuleIds(output), ['536870916', '536870917']);
});

const routingGraph = [
  { id: 10, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'tumacord_stream_bus', 'media.class': 'Audio/Sink' } } },
  { id: 11, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'tumacord_stream_source', 'media.class': 'Audio/Source' } } },
  { id: 20, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'Brave', 'application.name': 'Brave', 'media.class': 'Stream/Output/Audio' } } },
  { id: 21, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'Chromium', 'application.id': 'br.com.tumacord.app', 'media.class': 'Stream/Output/Audio' } } },
  { id: 22, type: 'PipeWire:Interface:Node', info: { props: { 'node.name': 'WEBRTC VoiceEngine', 'application.process.binary': 'Discord', 'media.class': 'Stream/Output/Audio' } } },
  { id: 100, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 10, 'port.direction': 'in', 'audio.channel': 'FL' } } },
  { id: 101, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 10, 'port.direction': 'in', 'audio.channel': 'FR' } } },
  { id: 200, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 20, 'port.direction': 'out', 'audio.channel': 'FL' } } },
  { id: 201, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 20, 'port.direction': 'out', 'audio.channel': 'FR' } } },
  { id: 210, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 21, 'port.direction': 'out', 'audio.channel': 'FL' } } },
  { id: 220, type: 'PipeWire:Interface:Port', info: { props: { 'node.id': 22, 'port.direction': 'out', 'audio.channel': 'FL' } } },
];

test('roteia aplicativos, mas mantém Tumacord e Discord fora da live', () => {
  assert.deepEqual(screenAudioRoutePlan(routingGraph), {
    busFound: true,
    sourceFound: true,
    links: [['200', '100'], ['201', '101']],
  });
});

test('serializa parar e preparar sem deixar módulos ativos sem monitoramento', async () => {
  let nextModule = 500;
  const modules = new Map<string, string>();
  const commands: string[] = [];
  const router = new ScreenAudioRouter({
    intervalMs: 60_000,
    retryDelayMs: 0,
    pipewireGraph: async () => routingGraph,
    pactl: async (args: string[]) => {
      commands.push(`pactl ${args.join(' ')}`);
      if (args[0] === 'load-module') {
        const id = String(nextModule++);
        modules.set(id, args.slice(1).join(' '));
        return id;
      }
      if (args[0] === 'unload-module') {
        modules.delete(args[1]);
        return '';
      }
      if (args.join(' ') === 'list short modules') {
        return [...modules].map(([id, description]) => `${id}\t${description}`).join('\n');
      }
      return '';
    },
    execFile: async (command: string, args: string[]) => {
      commands.push(`${command} ${args.join(' ')}`);
      return { stdout: '' };
    },
  });

  const firstStart = router.prepare();
  const stop = router.stop();
  const secondStart = router.prepare();
  await Promise.all([firstStart, stop, secondStart]);

  assert.equal(router.active, true);
  assert.ok(router.timer, 'o monitor periódico precisa continuar ativo');
  assert.equal(modules.size, 2, 'deve sobrar exatamente um barramento e uma fonte');
  assert.equal(commands.filter((command) => command.startsWith('pw-link -L -w')).length, 4);
  await router.stop();
  assert.equal(modules.size, 0);
});

test('falha transitória de uma porta não desmonta o barramento capturado', async () => {
  let nextModule = 700;
  let linkAttempts = 0;
  const modules = new Set<string>();
  const router = new ScreenAudioRouter({
    intervalMs: 60_000,
    retryDelayMs: 0,
    pipewireGraph: async () => routingGraph,
    pactl: async (args: string[]) => {
      if (args[0] === 'load-module') {
        const id = String(nextModule++);
        modules.add(id);
        return id;
      }
      if (args[0] === 'unload-module') modules.delete(args[1]);
      return args.join(' ') === 'list short modules' ? '' : '';
    },
    execFile: async (command: string, args: string[]) => {
      if (command === 'pw-link' && args[0] === '-L') {
        linkAttempts += 1;
        if (linkAttempts === 1) throw new Error('a porta desapareceu');
      }
      return { stdout: '' };
    },
  });

  const prepared = await router.prepare();
  assert.equal(prepared.ok, true);
  assert.equal(router.active, true);
  assert.equal(modules.size, 2, 'os módulos válidos não devem ser recriados por falha de uma porta');
  await router.stop();
});

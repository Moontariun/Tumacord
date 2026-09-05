import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { ScreenAudioRouter, activePipewireLinks, isCallAudio, isTumacordNode, parsePactlDefaults, screenAudioRoutePlan, staleModuleIds } = require('../desktop/audio-router.cjs') as {
  ScreenAudioRouter: new (options?: unknown) => {
    active: boolean;
    timer: unknown;
    prepare: () => Promise<{ ok: boolean }>;
    stop: () => Promise<{ ok: boolean }>;
  };
  activePipewireLinks: (graph: unknown[]) => Set<string>;
  isCallAudio: (input: unknown) => boolean;
  isTumacordNode: (name: unknown) => boolean;
  parsePactlDefaults: (info: unknown) => { sink: string; source: string };
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


const PACTL_INFO = [
  'Server String: /run/user/1000/pulse/native',
  'Server Name: PulseAudio (on PipeWire 1.6.8)',
  'Default Sink: alsa_output.pci-0000_00_1f.3.analog-stereo',
  'Default Source: alsa_input.usb-FIFINE_Microphone-00.analog-stereo',
  'Cookie: 1234:5678',
].join('\n');

test('os dispositivos padrão são lidos da saída do pactl', () => {
  assert.deepEqual(parsePactlDefaults(PACTL_INFO), {
    sink: 'alsa_output.pci-0000_00_1f.3.analog-stereo',
    source: 'alsa_input.usb-FIFINE_Microphone-00.analog-stereo',
  });
  assert.deepEqual(parsePactlDefaults('sem nada aqui'), { sink: '', source: '' });
  assert.deepEqual(parsePactlDefaults(null), { sink: '', source: '' });
});

test('os nós criados para a live são reconhecidos como nossos', () => {
  assert.equal(isTumacordNode('tumacord_stream_bus'), true);
  assert.equal(isTumacordNode('tumacord_stream_source'), true);
  assert.equal(isTumacordNode('tumacord_stream_bus.monitor'), true);
  assert.equal(isTumacordNode('alsa_input.usb-FIFINE_Microphone-00.analog-stereo'), false);
  assert.equal(isTumacordNode(undefined), false);
});

// O defeito relatado na 0.7.8: começar uma live criava a fonte virtual, o
// gerenciador de sessão a promovia a fonte padrão e quem estava com "Padrão do
// sistema" no microfone parava de ser ouvido até trocar o dispositivo à mão.
function routerWithDefaults(defaults: { sink: string; source: string }, promote: { sink?: boolean; source?: boolean }) {
  const commands: string[] = [];
  const current = { ...defaults };
  let nextModule = 900;
  const router = new ScreenAudioRouter({
    intervalMs: 60_000,
    retryDelayMs: 0,
    pipewireGraph: async () => routingGraph,
    pactl: async (args: string[]) => {
      commands.push(args.join(' '));
      if (args[0] === 'info') return `Default Sink: ${current.sink}\nDefault Source: ${current.source}`;
      if (args[0] === 'load-module') {
        if (args[1] === 'module-null-sink' && promote.sink) current.sink = 'tumacord_stream_bus';
        if (args[1] === 'module-remap-source' && promote.source) current.source = 'tumacord_stream_source';
        return String(nextModule++);
      }
      if (args[0] === 'set-default-source') { current.source = args[1]; return ''; }
      if (args[0] === 'set-default-sink') { current.sink = args[1]; return ''; }
      return '';
    },
    execFile: async () => ({ stdout: '' }),
  });
  return { router, commands, current };
}

test('a fonte virtual da live não fica como microfone padrão do sistema', async () => {
  const before = { sink: 'placa-onboard', source: 'microfone-fifine' };
  const { router, commands, current } = routerWithDefaults(before, { source: true, sink: true });
  assert.equal((await router.prepare()).ok, true);
  assert.deepEqual(current, before, 'o padrão anterior precisa ser devolvido');
  assert.ok(commands.includes('set-default-source microfone-fifine'));
  assert.ok(commands.includes('set-default-sink placa-onboard'));
  await router.stop();
});

test('um padrão que a própria pessoa trocou não é desfeito pela live', async () => {
  const { router, commands, current } = routerWithDefaults({ sink: 'placa-onboard', source: 'microfone-fifine' }, {});
  assert.equal((await router.prepare()).ok, true);
  assert.deepEqual(current, { sink: 'placa-onboard', source: 'microfone-fifine' });
  assert.equal(commands.some((command) => command.startsWith('set-default-')), false, 'nada a restaurar quando o padrão não virou nosso');
  await router.stop();
});

test('os nós da live pedem prioridade zero para não serem escolhidos como padrão', async () => {
  const { router, commands } = routerWithDefaults({ sink: 'placa-onboard', source: 'microfone-fifine' }, {});
  await router.prepare();
  const loads = commands.filter((command) => command.startsWith('load-module'));
  assert.equal(loads.length, 2);
  assert.ok(loads.every((command) => command.includes('priority.session=0')));
  await router.stop();
});

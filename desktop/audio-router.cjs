const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const BUS_NAME = 'tumacord_stream_bus';
const SOURCE_NAME = 'tumacord_stream_source';
const BUS_DESCRIPTION = 'Tumacord Stream Audio';

// `LC_ALL=C` porque a saída do pactl é traduzida: em português "Default
// Source" vira "Fonte padrão", e um parser preso ao inglês simplesmente não
// enxergaria o campo.
async function pactl(args) {
  const { stdout = '' } = await execFileAsync('pactl', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 3_500, env: { ...process.env, LC_ALL: 'C', LANGUAGE: 'C' } });
  return stdout.trim();
}

function parsePactlDefaults(info) {
  const text = String(info ?? '');
  return {
    sink: /^\s*Default Sink:\s*(\S+)\s*$/m.exec(text)?.[1] ?? '',
    source: /^\s*Default Source:\s*(\S+)\s*$/m.exec(text)?.[1] ?? '',
  };
}

// Um nó nosso que vira o padrão do sistema é exatamente o defeito: o
// "Padrão do sistema" do microfone passa a apontar para o barramento da live e
// quem escuta recebe silêncio ou o som da própria transmissão.
function isTumacordNode(name) {
  return typeof name === 'string' && (name === BUS_NAME || name === SOURCE_NAME || name.startsWith(`${BUS_NAME}.`));
}

async function pipewireGraph() {
  const { stdout = '' } = await execFileAsync('pw-dump', [], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5_000 });
  return JSON.parse(stdout);
}

function staleModuleIds(output) {
  return String(output ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((columns) => columns.slice(1).join(' ').includes(BUS_NAME) || columns.slice(1).join(' ').includes(SOURCE_NAME))
    .map(([id]) => id)
    .filter(Boolean);
}

function isCallAudio(input) {
  const properties = input?.properties ?? {};
  const searchable = [
    input?.name,
    properties['application.name'],
    properties['application.id'],
    properties['application.process.binary'],
    properties['media.name'],
    properties['node.name'],
    properties['module-stream-restore.id'],
  ].filter(Boolean).join(' ');
  return /tumacord|discord|web\s*rtc\s*voice|voiceengine|loopback|tumacord_stream_bus/i.test(searchable);
}

function activePipewireLinks(graph) {
  return new Set(graph
    .filter((entry) => entry.type === 'PipeWire:Interface:Link')
    .map((entry) => {
      const properties = entry.info?.props ?? {};
      return `${properties['link.output.port']}:${properties['link.input.port']}`;
    }));
}

function screenAudioRoutePlan(graph) {
  const nodes = graph.filter((entry) => entry.type === 'PipeWire:Interface:Node');
  const ports = graph.filter((entry) => entry.type === 'PipeWire:Interface:Port');
  const busNode = nodes.find((entry) => entry.info?.props?.['node.name'] === BUS_NAME);
  if (!busNode) return { busFound: false, sourceFound: false, links: [] };
  const sourceFound = nodes.some((entry) => entry.info?.props?.['node.name'] === SOURCE_NAME);
  const busInputs = ports.filter((entry) => Number(entry.info?.props?.['node.id']) === Number(busNode.id) && entry.info?.props?.['port.direction'] === 'in');
  const links = [];
  for (const node of nodes) {
    const properties = node.info?.props ?? {};
    if (properties['media.class'] !== 'Stream/Output/Audio' || isCallAudio({ properties, name: properties['node.name'] })) continue;
    const outputs = ports.filter((entry) => Number(entry.info?.props?.['node.id']) === Number(node.id) && entry.info?.props?.['port.direction'] === 'out');
    for (const output of outputs) {
      const channel = output.info?.props?.['audio.channel'];
      const input = busInputs.find((candidate) => candidate.info?.props?.['audio.channel'] === channel)
        ?? busInputs.find((candidate) => candidate.info?.props?.['audio.channel'] === 'MONO')
        ?? busInputs[0];
      if (input) links.push([String(output.id), String(input.id)]);
    }
  }
  return { busFound: true, sourceFound, links };
}

class ScreenAudioRouter {
  constructor(options = {}) {
    this.runPactl = options.pactl ?? pactl;
    this.readGraph = options.pipewireGraph ?? pipewireGraph;
    this.runFile = options.execFile ?? execFileAsync;
    // O grafo muda por eventos (abrir/fechar/pausar aplicativos), não a cada
    // frame. Consultá-lo várias vezes por segundo cria processos pw-dump em
    // excesso e aumenta a pressão sobre PipeWire durante uma live longa.
    this.intervalMs = options.intervalMs ?? 2_000;
    this.retryDelayMs = options.retryDelayMs ?? 120;
    this.nullSinkModule = null;
    this.remapSourceModule = null;
    this.links = new Set();
    this.timer = null;
    this.routePromise = null;
    this.operation = Promise.resolve();
    this.generation = 0;
    this.active = false;
  }

  enqueue(operation) {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  async available() {
    try {
      await Promise.all([
        this.runFile('pactl', ['info'], { encoding: 'utf8', timeout: 3_000 }),
        this.runFile('pw-link', ['--version'], { encoding: 'utf8', timeout: 3_000 }),
        this.runFile('pw-dump', ['--version'], { encoding: 'utf8', timeout: 3_000 }),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async cleanupStaleModules() {
    // pipewire-pulse 1.6 não inclui `index` no JSON de módulos. O código
    // anterior tentava descarregar `undefined`, deixando fontes antigas com
    // o mesmo nome. A captura podia então abrir uma dessas fontes suspensas
    // e a live ficava muda. O formato short preserva o ID real do módulo.
    const modules = await this.runPactl(['list', 'short', 'modules']).catch(() => '');
    const stale = staleModuleIds(modules);
    for (const moduleId of stale.reverse()) await this.runPactl(['unload-module', moduleId]).catch(() => undefined);
  }

  prepare() {
    return this.enqueue(() => this.prepareInternal());
  }

  stop() {
    return this.enqueue(() => this.stopInternal());
  }

  reset() {
    return this.enqueue(() => this.stopInternal());
  }

  async defaultDevices() {
    try {
      return parsePactlDefaults(await this.runPactl(['info']));
    } catch {
      return { sink: '', source: '' };
    }
  }

  // Só desfaz a troca quando o novo padrão é um nó do Tumacord. Se a pessoa
  // trocou o dispositivo padrão no meio do caminho, quem manda é ela.
  async restoreDefaultDevices(previous) {
    if (!previous) return;
    const current = await this.defaultDevices();
    if (previous.source && current.source !== previous.source && isTumacordNode(current.source)) {
      await this.runPactl(['set-default-source', previous.source]).catch(() => undefined);
    }
    if (previous.sink && current.sink !== previous.sink && isTumacordNode(current.sink)) {
      await this.runPactl(['set-default-sink', previous.sink]).catch(() => undefined);
    }
  }

  async prepareInternal() {
    if (!(await this.available())) return { ok: false, error: 'pactl/PipeWire não está disponível.' };
    // A fonte virtual da live entra no grafo como qualquer outra e, em vários
    // sistemas, o gerenciador de sessão a promove a padrão. O microfone
    // ficava mudo a partir daí, até a pessoa trocar o dispositivo à mão.
    const previousDefaults = await this.defaultDevices();
    if (this.nullSinkModule && this.remapSourceModule) {
      try {
        const graph = await this.readGraph();
        const plan = screenAudioRoutePlan(graph);
        if (plan.busFound && plan.sourceFound) {
          this.active = true;
          this.ensureTimer();
          await this.routeUntilReady();
          return { ok: true, deviceId: SOURCE_NAME, deviceName: BUS_DESCRIPTION };
        }
      } catch {
        // O estado será reconstruído abaixo. Isso também cobre reinícios do
        // PipeWire sem exigir logout ou reinicialização do computador.
      }
      await this.stopInternal();
    } else {
      await this.cleanupStaleModules();
    }
    try {
      this.nullSinkModule = await this.runPactl([
        'load-module', 'module-null-sink',
        `sink_name=${BUS_NAME}`,
        // `priority.session=0` pede ao gerenciador de sessão que nunca escolha
        // este nó como padrão. É a primeira linha de defesa; a restauração
        // abaixo cobre os sistemas que ignoram a dica.
        `sink_properties=device.description=${BUS_DESCRIPTION.replaceAll(' ', '_')} priority.session=0 node.dont-remix=true`,
        'rate=48000', 'channels=2',
      ]);
      // Chromium não lista fontes do tipo “monitor” em enumerateDevices().
      // Uma remap-source expõe o mesmo áudio como entrada virtual estéreo,
      // permitindo capturá-lo por getUserMedia sem depender de IDs privados
      // do Electron ou do portal de compartilhamento de tela.
      this.remapSourceModule = await this.runPactl([
        'load-module', 'module-remap-source',
        `master=${BUS_NAME}.monitor`,
        `source_name=${SOURCE_NAME}`,
        'source_properties=device.description=Tumacord_Stream_Audio priority.session=0',
        'channels=2',
      ]);
      await this.restoreDefaultDevices(previousDefaults);
      this.active = true;
      this.generation += 1;
      await this.routeUntilReady();
      this.ensureTimer();
      return { ok: true, deviceId: SOURCE_NAME, deviceName: BUS_DESCRIPTION };
    } catch (error) {
      await this.stopInternal();
      return { ok: false, error: error instanceof Error ? error.message : 'Falha ao preparar o áudio da tela.' };
    }
  }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.routeNow().catch(() => undefined), this.intervalMs);
    this.timer.unref?.();
  }

  async routeUntilReady(attempts = 12) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.routeNow();
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
    throw lastError;
  }

  async routeNow() {
    if (!this.active || !this.nullSinkModule) return { eligible: 0, linked: 0 };
    if (this.routePromise) return this.routePromise;
    const generation = this.generation;
    const running = this.routeEligibleInputs(generation);
    this.routePromise = running;
    try {
      return await running;
    } finally {
      if (this.routePromise === running) this.routePromise = null;
    }
  }

  async routeEligibleInputs(generation) {
    const graph = await this.readGraph();
    if (!this.active || generation !== this.generation) return { eligible: 0, linked: 0 };
    const plan = screenAudioRoutePlan(graph);
    if (!plan.busFound || !plan.sourceFound) throw new Error('O barramento virtual do Tumacord desapareceu do PipeWire.');
    const activeLinks = activePipewireLinks(graph);
    const plannedLinks = new Set(plan.links.map(([output, input]) => `${output}:${input}`));
    for (const key of this.links) {
      if (!plannedLinks.has(key) || !activeLinks.has(key)) this.links.delete(key);
    }
    let linked = 0;
    for (const [output, input] of plan.links) {
        if (!this.active || generation !== this.generation) break;
        const key = `${output}:${input}`;
        // Processos PipeWire recriam suas portas ao trocar de faixa, pausar um
        // jogo ou sair do modo tela cheia. O cache antigo dizia que o link
        // ainda existia e deixava a live muda para sempre. O grafo real é a
        // fonte de verdade, então qualquer link desaparecido é refeito.
        if (activeLinks.has(key)) {
          this.links.add(key);
          linked += 1;
          continue;
        }
        await this.runFile('pw-link', ['-L', '-w', output, input], { encoding: 'utf8', timeout: 2_500 })
          .then(() => {
            activeLinks.add(key);
            this.links.add(key);
            linked += 1;
          })
          .catch(() => undefined);
    }
    // Uma porta pode desaparecer entre o snapshot e pw-link (troca de faixa,
    // pausa ou fechamento do aplicativo). O barramento continua válido e o
    // timer tenta apenas o enlace transitório novamente. Desmontar os módulos
    // aqui encerrava a track que o Chromium ainda capturava e podia derrubar a
    // thread nativa desktopCaptureT.
    return { eligible: plan.links.length, linked };
  }

  async stopInternal() {
    this.active = false;
    this.generation += 1;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.routePromise) await this.routePromise.catch(() => undefined);
    await Promise.all([...this.links].map(async (key) => {
      const [output, input] = key.split(':');
      await this.runFile('pw-link', ['-d', output, input], { encoding: 'utf8', timeout: 2_000 }).catch(() => undefined);
    }));
    this.links.clear();
    const remapSourceModule = this.remapSourceModule;
    const nullSinkModule = this.nullSinkModule;
    this.remapSourceModule = null;
    this.nullSinkModule = null;
    if (remapSourceModule) await this.runPactl(['unload-module', String(remapSourceModule)]).catch(() => undefined);
    if (nullSinkModule) await this.runPactl(['unload-module', String(nullSinkModule)]).catch(() => undefined);
    await this.cleanupStaleModules();
    return { ok: true };
  }
}

module.exports = { ScreenAudioRouter, parsePactlDefaults, isTumacordNode, activePipewireLinks, isCallAudio, screenAudioRoutePlan, staleModuleIds };

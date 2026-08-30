const { execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const BUS_NAME = 'tumacord_stream_bus';
const SOURCE_NAME = 'tumacord_stream_source';
const BUS_DESCRIPTION = 'Tumacord Stream Audio';

async function pactl(args) {
  const { stdout = '' } = await execFileAsync('pactl', args, { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function pactlJson(subject) {
  const output = await pactl(['-f', 'json', 'list', subject]);
  return output ? JSON.parse(output) : [];
}

async function pipewireGraph() {
  const { stdout = '' } = await execFileAsync('pw-dump', [], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout);
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

class ScreenAudioRouter {
  constructor() {
    this.nullSinkModule = null;
    this.remapSourceModule = null;
    this.links = new Set();
    this.timer = null;
    this.preparePromise = null;
  }

  async available() {
    try {
      await Promise.all([
        execFileAsync('pactl', ['info'], { encoding: 'utf8' }),
        execFileAsync('pw-link', ['--version'], { encoding: 'utf8' }),
        execFileAsync('pw-dump', ['--version'], { encoding: 'utf8' }),
      ]);
      return true;
    } catch {
      return false;
    }
  }

  async cleanupStaleModules() {
    const modules = await pactlJson('modules').catch(() => []);
    const stale = modules.filter((module) => {
      const args = String(module.argument ?? module.args ?? '');
      return args.includes(BUS_NAME) || args.includes(SOURCE_NAME);
    });
    for (const module of stale.reverse()) await pactl(['unload-module', String(module.index)]).catch(() => undefined);
  }

  async prepare() {
    if (this.nullSinkModule && this.remapSourceModule) return { ok: true, deviceId: SOURCE_NAME, deviceName: BUS_DESCRIPTION };
    if (this.preparePromise) return this.preparePromise;
    this.preparePromise = this.prepareInternal().finally(() => { this.preparePromise = null; });
    return this.preparePromise;
  }

  async prepareInternal() {
    if (!(await this.available())) return { ok: false, error: 'pactl/PipeWire não está disponível.' };
    await this.cleanupStaleModules();
    try {
      this.nullSinkModule = await pactl([
        'load-module', 'module-null-sink',
        `sink_name=${BUS_NAME}`,
        `sink_properties=device.description=${BUS_DESCRIPTION.replaceAll(' ', '_')}`,
        'rate=48000', 'channels=2',
      ]);
      // Chromium não lista fontes do tipo “monitor” em enumerateDevices().
      // Uma remap-source expõe o mesmo áudio como entrada virtual estéreo,
      // permitindo capturá-lo por getUserMedia sem depender de IDs privados
      // do Electron ou do portal de compartilhamento de tela.
      this.remapSourceModule = await pactl([
        'load-module', 'module-remap-source',
        `master=${BUS_NAME}.monitor`,
        `source_name=${SOURCE_NAME}`,
        'source_properties=device.description=Tumacord_Stream_Audio',
        'channels=2',
      ]);
      await this.routeEligibleInputs();
      this.timer = setInterval(() => void this.routeEligibleInputs(), 450);
      this.timer.unref();
      return { ok: true, deviceId: SOURCE_NAME, deviceName: BUS_DESCRIPTION };
    } catch (error) {
      await this.stop();
      return { ok: false, error: error instanceof Error ? error.message : 'Falha ao preparar o áudio da tela.' };
    }
  }

  async routeEligibleInputs() {
    if (!this.nullSinkModule) return;
    const graph = await pipewireGraph();
    const nodes = graph.filter((entry) => entry.type === 'PipeWire:Interface:Node');
    const ports = graph.filter((entry) => entry.type === 'PipeWire:Interface:Port');
    const busNode = nodes.find((entry) => entry.info?.props?.['node.name'] === BUS_NAME);
    if (!busNode) return;
    const busInputs = ports.filter((entry) => Number(entry.info?.props?.['node.id']) === Number(busNode.id) && entry.info?.props?.['port.direction'] === 'in');
    for (const node of nodes) {
      const properties = node.info?.props ?? {};
      if (properties['media.class'] !== 'Stream/Output/Audio' || isCallAudio({ properties, name: properties['node.name'] })) continue;
      const outputs = ports.filter((entry) => Number(entry.info?.props?.['node.id']) === Number(node.id) && entry.info?.props?.['port.direction'] === 'out');
      for (const output of outputs) {
        const channel = output.info?.props?.['audio.channel'];
        const input = busInputs.find((candidate) => candidate.info?.props?.['audio.channel'] === channel)
          ?? busInputs.find((candidate) => candidate.info?.props?.['audio.channel'] === 'MONO')
          ?? busInputs[0];
        if (!input) continue;
        const key = `${output.id}:${input.id}`;
        if (this.links.has(key)) continue;
        await execFileAsync('pw-link', ['-L', String(output.id), String(input.id)], { encoding: 'utf8' })
          .then(() => this.links.add(key))
          .catch(() => undefined);
      }
    }
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const key of this.links) {
      const [output, input] = key.split(':');
      await execFileAsync('pw-link', ['-d', output, input], { encoding: 'utf8' }).catch(() => undefined);
    }
    this.links.clear();
    if (this.remapSourceModule) await pactl(['unload-module', String(this.remapSourceModule)]).catch(() => undefined);
    this.remapSourceModule = null;
    if (this.nullSinkModule) await pactl(['unload-module', String(this.nullSinkModule)]).catch(() => undefined);
    this.nullSinkModule = null;
    return { ok: true };
  }
}

module.exports = { ScreenAudioRouter, isCallAudio };

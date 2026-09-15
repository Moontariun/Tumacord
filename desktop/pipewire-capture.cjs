// O áudio da live no Linux, sem dispositivo nenhum aparecendo no sistema.
//
// Até a 0.13.4 o caminho era um `module-null-sink` mais um `module-remap-source`:
// o som dos aplicativos ia para um alto-falante virtual, e o Chromium abria o
// microfone virtual que espelhava esse alto-falante. Funcionava — e deixava
// "Tumacord_Stream_Audio" na lista de saídas e de entradas do sistema durante
// toda a live, onde qualquer um podia escolhê-lo sem querer.
//
// Aqui não há dispositivo. `pw-record` cria um FLUXO de gravação, como o de
// qualquer programa que grava áudio: ele aparece na aba de aplicativos que
// gravam, e não na lista de dispositivos. `--target 0` impede o gerenciador de
// sessão de ligá-lo ao microfone padrão, e quem liga as saídas dos aplicativos
// às entradas dele é este arquivo, pelo mesmo `pw-link` de antes. O PCM sai
// pela saída padrão do processo e segue pelo canal que o Windows já usa.

const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { activePipewireLinks, isCallAudio } = require('./audio-router.cjs');

const execFileAsync = promisify(execFile);
const CAPTURE_NAME = 'tumacord_stream_capture';
// float32 intercalado, dois canais: oito bytes por quadro. Blocos de 10 ms,
// o mesmo tamanho que o componente do Windows entrega ao worklet.
const FRAME_BYTES = 8;
const BLOCK_BYTES = 3_840;

function captureArguments() {
  const properties = [
    `node.name = "${CAPTURE_NAME}"`,
    'node.description = "Tumacord"',
    'application.name = "Tumacord"',
    'media.role = "Communication"',
    'node.autoconnect = false',
    'node.dont-reconnect = true',
  ].join(' ');
  return ['--raw', '--format', 'f32', '--rate', '48000', '--channels', '2', '--latency', '10ms', '--target', '0', '-P', `{ ${properties} }`, '-'];
}

async function pipewireGraph() {
  const { stdout = '' } = await execFileAsync('pw-dump', [], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 5_000 });
  return JSON.parse(stdout);
}

/**
 * Junta os pedaços da saída do processo em blocos de quadros inteiros.
 *
 * Um pipe entrega o que tiver, do tamanho que tiver: um pedaço pode terminar no
 * meio de uma amostra. Mandar esse pedaço adiante desalinharia os canais — a
 * esquerda viraria a direita, e o som viraria ruído até a próxima reconexão.
 */
class PcmFramer {
  constructor(onBlock, blockBytes = BLOCK_BYTES) {
    this.onBlock = onBlock;
    this.blockBytes = blockBytes - (blockBytes % FRAME_BYTES);
    this.pending = Buffer.alloc(0);
  }

  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    while (this.pending.length >= this.blockBytes) {
      this.onBlock(this.pending.subarray(0, this.blockBytes));
      this.pending = this.pending.subarray(this.blockBytes);
    }
  }

  reset() {
    this.pending = Buffer.alloc(0);
  }
}

/** Quais saídas de aplicativo ligar a quais entradas do nó de captura. */
function captureRoutePlan(graph, capturePid) {
  const nodes = graph.filter((entry) => entry.type === 'PipeWire:Interface:Node');
  const ports = graph.filter((entry) => entry.type === 'PipeWire:Interface:Port');
  const candidates = nodes.filter((entry) => entry.info?.props?.['node.name'] === CAPTURE_NAME);
  // Um nó com o mesmo nome pode ter sobrado de uma execução anterior que caiu.
  // O do processo atual é o que tem o PID dele.
  const captureNode = candidates.find((entry) => Number(entry.info?.props?.['application.process.id']) === Number(capturePid)) ?? (capturePid ? undefined : candidates[0]);
  if (!captureNode) return { captureFound: false, links: [] };
  const inputs = ports.filter((entry) => Number(entry.info?.props?.['node.id']) === Number(captureNode.id) && entry.info?.props?.['port.direction'] === 'in');
  const links = [];
  for (const node of nodes) {
    const properties = node.info?.props ?? {};
    if (properties['media.class'] !== 'Stream/Output/Audio' || isCallAudio({ properties, name: properties['node.name'] })) continue;
    const outputs = ports.filter((entry) => Number(entry.info?.props?.['node.id']) === Number(node.id) && entry.info?.props?.['port.direction'] === 'out');
    for (const output of outputs) {
      const channel = output.info?.props?.['audio.channel'];
      const input = inputs.find((candidate) => candidate.info?.props?.['audio.channel'] === channel)
        ?? inputs.find((candidate) => candidate.info?.props?.['audio.channel'] === 'MONO')
        ?? inputs[0];
      if (input) links.push([String(output.id), String(input.id)]);
    }
  }
  return { captureFound: inputs.length > 0, links };
}

class PipewireStreamCapture {
  constructor(options = {}) {
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawn ?? spawn;
    this.runFile = options.execFile ?? execFileAsync;
    this.readGraph = options.pipewireGraph ?? pipewireGraph;
    this.onPcm = options.onPcm ?? (() => undefined);
    this.intervalMs = options.intervalMs ?? 2_000;
    this.retryDelayMs = options.retryDelayMs ?? 150;
    this.child = null;
    this.active = false;
    this.links = new Set();
    this.timer = null;
    this.routing = null;
    this.supported = null;
    this.restarts = 0;
    this.lastError = '';
    this.operation = Promise.resolve();
    this.framer = new PcmFramer((block) => this.onPcm(block));
  }

  enqueue(operation) {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  /**
   * Se este sistema tem o que o caminho precisa. `--raw` existe no `pw-record`
   * desde o PipeWire 1.0; sem ele a saída padrão viria num contêiner de
   * arquivo, e quem chama cai no barramento antigo em vez de tocar ruído.
   */
  async available() {
    if (this.platform !== 'linux') return false;
    if (this.supported !== null) return this.supported;
    try {
      const [{ stdout: help = '' }] = await Promise.all([
        this.runFile('pw-record', ['--help'], { encoding: 'utf8', timeout: 3_000 }),
        this.runFile('pw-link', ['--version'], { encoding: 'utf8', timeout: 3_000 }),
        this.runFile('pw-dump', ['--version'], { encoding: 'utf8', timeout: 3_000 }),
      ]);
      this.supported = /--raw\b/.test(String(help));
    } catch (error) {
      // `--help` sai com código diferente de zero em algumas versões, e o texto
      // vem no erro. Isso não é ausência da ferramenta.
      this.supported = /--raw\b/.test(String(error?.stdout ?? ''));
    }
    return this.supported;
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

  describe() {
    return { ok: true, mode: 'stream', isolation: 'bus', deviceName: '', sampleRate: 48_000, channels: 2 };
  }

  async prepareInternal() {
    if (this.platform !== 'linux') return { ok: false, error: 'A captura do PipeWire é específica do Linux.' };
    if (!(await this.available())) return { ok: false, error: 'pw-record/PipeWire não está disponível.' };
    // Preparar de novo com a captura no ar é a verificação periódica de saúde
    // do renderer. Reiniciar o processo aqui cortaria o áudio a cada dez
    // segundos; o que se faz é conferir as ligações.
    if (this.active && this.child) {
      await this.routeNow().catch(() => undefined);
      return this.describe();
    }
    this.active = true;
    this.restarts = 0;
    try {
      this.startChild();
      await this.routeUntilReady();
      this.ensureTimer();
      return this.describe();
    } catch (error) {
      await this.stopInternal();
      return { ok: false, error: error instanceof Error ? error.message : 'Não consegui capturar o áudio da transmissão.' };
    }
  }

  startChild() {
    this.framer.reset();
    const child = this.spawnProcess('pw-record', captureArguments(), { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout?.on('data', (chunk) => { if (this.child === child) this.framer.push(chunk); });
    child.stderr?.on('data', (chunk) => { this.lastError = String(chunk).trim().slice(-300); });
    child.on('error', (error) => { this.lastError = error instanceof Error ? error.message : String(error); });
    child.on('exit', () => {
      if (this.child !== child) return;
      this.child = null;
      // As portas morreram junto com o processo; o próximo ciclo refaz tudo.
      this.links.clear();
    });
  }

  ensureTimer() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  async tick() {
    if (!this.active) return;
    // O PipeWire reiniciou ou o processo caiu: volta sozinho, com teto, para
    // um defeito permanente não virar um processo novo a cada dois segundos.
    if (!this.child) {
      if (this.restarts >= 20) return;
      this.restarts += 1;
      this.startChild();
    }
    await this.routeNow().catch(() => undefined);
  }

  async routeUntilReady(attempts = 20) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await this.routeNow({ requireCapture: true });
      } catch (error) {
        lastError = error;
        if (!this.child) throw new Error(this.lastError || 'O processo de captura do PipeWire encerrou.');
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
      }
    }
    throw lastError;
  }

  async routeNow({ requireCapture = false } = {}) {
    if (!this.active || !this.child) return { eligible: 0, linked: 0 };
    if (this.routing) return this.routing;
    const running = this.routeEligibleOutputs(requireCapture);
    this.routing = running;
    try {
      return await running;
    } finally {
      if (this.routing === running) this.routing = null;
    }
  }

  async routeEligibleOutputs(requireCapture) {
    const pid = this.child?.pid;
    const graph = await this.readGraph();
    const plan = captureRoutePlan(graph, pid);
    if (!plan.captureFound) {
      if (requireCapture) throw new Error('O nó de captura ainda não apareceu no PipeWire.');
      return { eligible: 0, linked: 0 };
    }
    const activeLinks = activePipewireLinks(graph);
    const planned = new Set(plan.links.map(([output, input]) => `${output}:${input}`));
    for (const key of this.links) if (!planned.has(key) || !activeLinks.has(key)) this.links.delete(key);
    let linked = 0;
    for (const [output, input] of plan.links) {
      if (!this.active || this.child?.pid !== pid) break;
      const key = `${output}:${input}`;
      if (activeLinks.has(key)) {
        this.links.add(key);
        linked += 1;
        continue;
      }
      await this.runFile('pw-link', ['-L', output, input], { encoding: 'utf8', timeout: 2_500 })
        .then(() => { this.links.add(key); linked += 1; })
        .catch(() => undefined);
    }
    return { eligible: plan.links.length, linked };
  }

  async stopInternal() {
    if (this.platform !== 'linux') return { ok: true };
    this.active = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.routing) await this.routing.catch(() => undefined);
    // Encerrar o processo desfaz as ligações dele: as portas deixam de existir.
    const child = this.child;
    this.child = null;
    this.links.clear();
    this.framer.reset();
    if (child) {
      await new Promise((resolve) => {
        const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* já saiu */ } resolve(); }, 1_500);
        child.once('exit', () => { clearTimeout(timer); resolve(); });
        try { child.kill('SIGTERM'); } catch { clearTimeout(timer); resolve(); }
      });
    }
    return { ok: true };
  }

  diagnostics() {
    return {
      platform: 'linux',
      mechanism: 'pipewire-capture',
      active: this.active,
      isolation: 'bus',
      links: this.links.size,
      restarts: this.restarts,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    };
  }
}

module.exports = { PipewireStreamCapture, PcmFramer, captureRoutePlan, captureArguments, CAPTURE_NAME, BLOCK_BYTES };

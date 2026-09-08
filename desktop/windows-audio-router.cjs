// O áudio da transmissão no Windows.
//
// O equivalente ao `ScreenAudioRouter` do Linux, com a mesma API para quem
// chama e um mecanismo completamente diferente por baixo. No Linux existe um
// barramento no PipeWire e a captura sai por `getUserMedia`; aqui não há
// dispositivo nenhum para abrir — o helper nativo entrega PCM e o renderer o
// transforma em uma `MediaStreamTrack` comum. Para o outro lado da call, os
// dois caminhos são indistinguíveis: chega uma faixa de áudio WebRTC normal.
//
// A diferença que justifica tudo isto: `audio: 'loopback'` do Chromium captura
// o dispositivo inteiro, com Tumacord e Discord dentro. Aqui a captura é por
// árvore de processo, e o que não está na lista nunca é aberto.

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const {
  captureCommand,
  createFrameDecoder,
  FRAME_TYPE_EVENT,
  FRAME_TYPE_PCM,
  isBlockedExecutable,
  parseEvent,
  selectCaptureRoots,
  sourceKindFromId,
  windowCommand,
  windowHandleFromSourceId,
} = require('./windows-audio-policy.cjs');

const HELPER_NAME = 'tumacord-audio-helper.exe';
// Loopback por processo chegou no Windows 10 20H1. Abaixo disso a ativação
// falha, e falhar é o comportamento certo: o alternativo seria o loopback do
// dispositivo inteiro, que devolve a call para dentro da live.
const MINIMUM_WINDOWS_BUILD = 19041;

function helperCandidates() {
  const candidates = [];
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'audio-helper', HELPER_NAME));
  candidates.push(path.join(__dirname, '..', 'native', 'windows', 'audio-helper', 'build', HELPER_NAME));
  return candidates;
}

function locateHelper() {
  return helperCandidates().find((candidate) => existsSync(candidate)) ?? '';
}

class WindowsScreenAudioRouter {
  constructor(options = {}) {
    this.spawnHelper = options.spawn ?? spawn;
    this.platform = options.platform ?? process.platform;
    this.helperPath = options.helperPath ?? null;
    this.now = options.now ?? (() => Date.now());
    this.selfPids = options.selfPids ?? [process.pid];
    this.onPcm = options.onPcm ?? (() => undefined);
    this.onDiagnostic = options.onDiagnostic ?? (() => undefined);
    this.restartLimit = options.restartLimit ?? 3;
    this.commandTimeoutMs = options.commandTimeoutMs ?? 6_000;
    this.restartBaseMs = options.restartBaseMs ?? 400;

    this.child = null;
    this.decode = null;
    this.active = false;
    this.mode = '';
    this.sourceId = '';
    this.targetPid = 0;
    this.capturedPids = [];
    this.excluded = [];
    this.restarts = 0;
    this.ready = null;
    this.waiters = new Map();
    this.operation = Promise.resolve();
    this.probeResult = null;
    this.stats = { underruns: 0, overruns: 0, blocks: 0, sources: 0 };
    this.lastError = '';
  }

  enqueue(operation) {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(() => undefined, () => undefined);
    return result;
  }

  resolveHelperPath() {
    if (this.helperPath !== null) return this.helperPath;
    this.helperPath = locateHelper();
    return this.helperPath;
  }

  // A sondagem roda o helper com `--probe`: ele tenta uma ativação real de
  // loopback por processo sobre si mesmo e diz se o Windows aceitou. É mais
  // confiável do que comparar número de build, porque políticas de empresa e
  // edições enxutas do sistema também podem tirar o recurso.
  async probe() {
    if (this.probeResult) return this.probeResult;
    if (this.platform !== 'win32') {
      this.probeResult = { supported: false, reason: 'platform', build: 0 };
      return this.probeResult;
    }
    const helper = this.resolveHelperPath();
    if (!helper) {
      this.probeResult = { supported: false, reason: 'helper-missing', build: 0 };
      return this.probeResult;
    }
    const result = await new Promise((resolve) => {
      let child;
      try {
        child = this.spawnHelper(helper, ['--probe'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        resolve({ supported: false, reason: 'helper-failed', build: 0 });
        return;
      }
      const decode = createFrameDecoder();
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        try { child.kill(); } catch { /* já saiu */ }
        resolve(value);
      };
      const timer = setTimeout(() => finish({ supported: false, reason: 'helper-timeout', build: 0 }), 8_000);
      timer.unref?.();
      child.stdout?.on('data', (chunk) => {
        for (const frame of decode(chunk)) {
          if (frame.type !== FRAME_TYPE_EVENT) continue;
          const event = parseEvent(frame.payload);
          if (event?.event !== 'probe') continue;
          clearTimeout(timer);
          finish({
            supported: Boolean(event.processLoopback) && Number(event.build) >= MINIMUM_WINDOWS_BUILD,
            reason: event.processLoopback ? '' : 'process-loopback-unavailable',
            build: Number(event.build) || 0,
          });
        }
      });
      child.on('error', () => { clearTimeout(timer); finish({ supported: false, reason: 'helper-failed', build: 0 }); });
      child.on('exit', () => { clearTimeout(timer); finish({ supported: false, reason: 'helper-exited', build: 0 }); });
    });
    this.probeResult = result;
    return result;
  }

  async available() {
    return (await this.probe()).supported;
  }

  capabilities() {
    const probe = this.probeResult;
    return {
      mode: 'stream',
      supported: probe ? probe.supported : null,
      build: probe?.build ?? 0,
      reason: probe?.reason ?? '',
    };
  }

  waitFor(eventName, timeoutMs = this.commandTimeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(eventName);
        reject(new Error(`O componente de áudio do Windows não respondeu (${eventName}).`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(eventName, { resolve, timer });
    });
  }

  settle(eventName, value) {
    const waiter = this.waiters.get(eventName);
    if (!waiter) return;
    this.waiters.delete(eventName);
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  }

  rejectAllWaiters(message) {
    for (const [eventName, waiter] of this.waiters) {
      clearTimeout(waiter.timer);
      waiter.resolve({ event: eventName, error: message });
    }
    this.waiters.clear();
  }

  send(command) {
    if (!this.child?.stdin?.writable) return false;
    try {
      this.child.stdin.write(command);
      return true;
    } catch {
      return false;
    }
  }

  handleEvent(event) {
    switch (event.event) {
      case 'ready':
        this.settle('ready', event);
        break;
      case 'window':
        this.settle('window', event);
        break;
      case 'capturing':
        this.capturedPids = Array.isArray(event.pids) ? event.pids : [];
        this.stats.sources = this.capturedPids.length;
        this.settle('capturing', event);
        if (Array.isArray(event.failed) && event.failed.length) {
          this.onDiagnostic({ event: 'screen-audio-capture-failed', count: event.failed.length });
        }
        break;
      case 'sessions':
        this.applySessions(Array.isArray(event.items) ? event.items : []);
        break;
      case 'source-gone':
        this.onDiagnostic({ event: 'screen-audio-source-gone' });
        if (this.mode === 'window' && event.pid === this.targetPid) {
          this.targetPid = 0;
          this.capturedPids = [];
          this.stats.sources = 0;
        }
        break;
      case 'stats':
        this.stats = {
          underruns: Number(event.underruns) || 0,
          overruns: Number(event.overruns) || 0,
          blocks: Number(event.blocks) || 0,
          sources: Number(event.sources) || 0,
        };
        break;
      case 'stopped':
        this.settle('stopped', event);
        break;
      case 'error':
        this.lastError = typeof event.message === 'string' ? event.message : 'erro no componente de áudio';
        this.onDiagnostic({ event: 'screen-audio-helper-error', code: String(event.code ?? '') });
        break;
      default:
        break;
    }
  }

  // O conjunto de aplicações com som muda durante a live: um jogo abre, o
  // navegador fecha uma aba, o Discord entra. Recalcular a cada aviso é o que
  // mantém a lista de bloqueio válida enquanto a transmissão acontece.
  applySessions(sessions) {
    if (!this.active || this.mode !== 'screen') return;
    const decision = selectCaptureRoots({ sessions, selfPids: this.selfPids });
    this.excluded = decision.excluded;
    const previous = [...this.capturedPids].sort((left, right) => left - right).join(',');
    const next = [...decision.roots].sort((left, right) => left - right).join(',');
    if (previous === next) return;
    this.send(captureCommand(decision.roots));
    this.onDiagnostic({
      event: 'screen-audio-sources-changed',
      included: decision.included.length,
      excluded: decision.excluded.length,
    });
  }

  async ensureHelper() {
    if (this.child) return true;
    const helper = this.resolveHelperPath();
    if (!helper) return false;
    let child;
    try {
      child = this.spawnHelper(helper, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      return false;
    }
    this.child = child;
    this.decode = createFrameDecoder();
    child.stdout?.on('data', (chunk) => {
      // Um bloco em trânsito pode chegar depois de o componente ter sido
      // encerrado. Sem esta saída, ele viraria exceção no meio do encerramento.
      if (!this.decode || this.child !== child) return;
      for (const frame of this.decode(chunk)) {
        if (frame.type === FRAME_TYPE_PCM) this.onPcm(frame.payload);
        else if (frame.type === FRAME_TYPE_EVENT) {
          const event = parseEvent(frame.payload);
          if (event) this.handleEvent(event);
        }
      }
    });
    child.on('error', () => this.handleExit('erro ao executar o componente de áudio'));
    child.on('exit', () => this.handleExit('o componente de áudio encerrou'));
    const ready = await this.waitFor('ready').catch(() => null);
    if (!ready || ready.error || !ready.processLoopback) {
      this.lastError = 'Este Windows não isola o áudio por aplicação.';
      await this.terminate();
      return false;
    }
    return true;
  }

  handleExit(message) {
    const wasActive = this.active;
    this.child = null;
    this.decode = null;
    this.rejectAllWaiters(message);
    if (!wasActive) return;
    this.onDiagnostic({ event: 'screen-audio-helper-gone', restarts: this.restarts });
    if (this.restarts >= this.restartLimit) {
      this.active = false;
      this.lastError = message;
      return;
    }
    this.restarts += 1;
    const delay = Math.min(4_000, this.restartBaseMs * (2 ** this.restarts));
    const timer = setTimeout(() => { void this.enqueue(() => this.restart()); }, delay);
    timer.unref?.();
  }

  async restart() {
    if (!this.active) return;
    const sourceId = this.sourceId;
    if (!(await this.ensureHelper())) return;
    await this.attach(sourceId).catch(() => undefined);
  }

  async attach(sourceId) {
    const kind = sourceKindFromId(sourceId);
    if (kind === 'window') {
      const handle = windowHandleFromSourceId(sourceId);
      if (!handle) throw new Error('A janela escolhida não tem um identificador válido.');
      // A espera é registrada antes do envio: o componente pode responder
      // antes de o `await` chegar, e uma resposta sem ouvinte viraria um
      // tempo esgotado com o áudio já pronto do outro lado.
      const window = this.waitFor('window');
      this.send(windowCommand(handle));
      const resolved = await window;
      if (resolved?.error || !resolved?.pid) throw new Error('A janela escolhida não está mais aberta.');
      // Uma janela do Discord jamais chega aqui — o seletor já não a lista —,
      // mas a recusa fica explícita: capturar essa árvore seria devolver a
      // voz da call pela transmissão.
      if (isBlockedExecutable(resolved.exe)) throw new Error('O áudio desta aplicação não pode ser transmitido.');
      this.mode = 'window';
      this.targetPid = resolved.pid;
      const capture = this.waitFor('capturing');
      this.send(captureCommand([resolved.pid]));
      const capturing = await capture;
      if (capturing?.error || !Array.isArray(capturing.pids) || !capturing.pids.length) {
        throw new Error('Não consegui capturar o áudio desta aplicação.');
      }
      return { isolation: 'process', sources: capturing.pids.length };
    }
    this.mode = 'screen';
    this.targetPid = 0;
    // O `CAPTURE` vazio liga o fluxo antes da primeira varredura: a faixa
    // nasce em silêncio em vez de nascer depois. `SCAN` vem em seguida e é o
    // que liga o monitoramento contínuo — é ele que faz um jogo aberto no meio
    // da live entrar e o Discord aberto no meio da live continuar fora. A
    // ordem importa: invertida, a lista escolhida pela varredura seria
    // sobrescrita pelo pedido vazio.
    const capture = this.waitFor('capturing');
    this.send(captureCommand([]));
    await capture.catch(() => undefined);
    this.send('SCAN\n');
    return { isolation: 'system', sources: this.capturedPids.length };
  }

  prepare(request = {}) {
    return this.enqueue(() => this.prepareInternal(request));
  }

  async prepareInternal(request) {
    if (this.platform !== 'win32') {
      return { ok: false, error: 'A captura de áudio por aplicação é específica do Windows.' };
    }
    const sourceId = typeof request.sourceId === 'string' ? request.sourceId : '';
    const kind = sourceKindFromId(sourceId);
    if (!kind) return { ok: false, error: 'Escolha uma tela ou janela antes de ligar o áudio.' };
    const probe = await this.probe();
    if (!probe.supported) {
      // Nenhuma reserva aqui é de propósito. A alternativa disponível seria o
      // loopback do dispositivo inteiro, e ele carrega Tumacord e Discord para
      // dentro da live — exatamente o defeito que este caminho existe para
      // evitar. Transmitir sem áudio é o resultado honesto.
      return {
        ok: false,
        code: probe.reason || 'unsupported',
        error: 'Nesta versão do Windows, o áudio da aplicação não pode ser isolado com segurança. A transmissão continuará sem áudio.',
      };
    }
    if (this.active && this.sourceId === sourceId && this.child) {
      // Preparar de novo para a mesma fonte é a verificação periódica de saúde
      // do renderer; recapturar aqui cortaria o áudio sem motivo.
      return this.describe();
    }
    await this.stopInternal();
    this.active = true;
    this.sourceId = sourceId;
    this.restarts = 0;
    this.lastError = '';
    if (!(await this.ensureHelper())) {
      this.active = false;
      return { ok: false, code: 'helper-missing', error: this.lastError || 'O componente de áudio do Windows não está disponível.' };
    }
    try {
      const attached = await this.attach(sourceId);
      this.isolation = attached.isolation;
      return this.describe();
    } catch (error) {
      await this.stopInternal();
      return { ok: false, code: 'capture-failed', error: error instanceof Error ? error.message : 'Não consegui capturar o áudio.' };
    }
  }

  describe() {
    return {
      ok: true,
      mode: 'stream',
      isolation: this.mode === 'window' ? 'process' : 'system',
      sourceId: this.sourceId,
      sources: this.capturedPids.length,
      excluded: this.excluded.length,
      sampleRate: 48_000,
      channels: 2,
    };
  }

  stop() {
    return this.enqueue(() => this.stopInternal());
  }

  reset() {
    return this.enqueue(() => this.stopInternal());
  }

  async stopInternal() {
    this.active = false;
    this.mode = '';
    this.sourceId = '';
    this.targetPid = 0;
    this.capturedPids = [];
    this.excluded = [];
    this.restarts = 0;
    if (!this.child) return { ok: true };
    const stopped = this.waitFor('stopped', 1_500);
    this.send('STOP\n');
    await stopped.catch(() => undefined);
    await this.terminate();
    return { ok: true };
  }

  async terminate() {
    const child = this.child;
    if (!child) {
      this.decode = null;
      this.rejectAllWaiters('componente encerrado');
      return;
    }
    // O pedido de saída precisa sair antes de soltar a referência: `send`
    // escreve em `this.child`, e limpá-lo primeiro deixaria o componente
    // dependendo do fechamento de stdin para perceber que acabou.
    this.send('QUIT\n');
    this.child = null;
    this.decode = null;
    this.rejectAllWaiters('componente encerrado');
    try { child.stdin?.end(); } catch { /* já fechado */ }
    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      const timer = setTimeout(() => {
        // Um helper que não sai sozinho seguraria uma captura WASAPI aberta.
        try { child.kill(); } catch { /* já saiu */ }
        finish();
      }, 1_500);
      timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); finish(); });
    });
  }

  diagnostics() {
    return {
      platform: 'win32',
      mechanism: 'wasapi-process-loopback',
      active: this.active,
      isolation: this.mode === 'window' ? 'process' : this.mode === 'screen' ? 'system' : '',
      sources: this.capturedPids.length,
      excluded: this.excluded.length,
      excludedReasons: this.excluded.reduce((totals, entry) => ({ ...totals, [entry.reason]: (totals[entry.reason] ?? 0) + 1 }), {}),
      underruns: this.stats.underruns,
      overruns: this.stats.overruns,
      blocks: this.stats.blocks,
      restarts: this.restarts,
      processLoopback: this.probeResult?.supported ?? null,
      windowsBuild: this.probeResult?.build ?? 0,
      lastError: this.lastError,
    };
  }
}

module.exports = { WindowsScreenAudioRouter, MINIMUM_WINDOWS_BUILD, locateHelper };

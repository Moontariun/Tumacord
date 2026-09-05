#!/usr/bin/env node
// Instrumento de diagnóstico do microfone.
//
// Existe para responder uma pergunta com medida, e não com hipótese: em qual
// camada o microfone deixa de funcionar, e o que muda quando outro aplicativo
// abre o dispositivo.
//
// Ele abre uma janela Electron invisível, captura o microfone em quatro
// combinações e mede a energia que realmente entra:
//
//   A  cancelamento de eco LIGADO,  sem saída de áudio ativa antes
//   B  cancelamento de eco DESLIGADO, sem saída de áudio ativa antes
//   C  cancelamento de eco LIGADO,  com saída de áudio ativa antes
//   D  cancelamento de eco DESLIGADO, com saída de áudio ativa antes
//
// A comparação A×C é o teste da hipótese de que o cancelamento de eco do
// Chromium precisa de uma referência de reprodução já aberta — que seria o que
// abrir o Discord fornece sem querer. Se A for mudo e C tiver sinal, a
// hipótese se confirma sem depender de abrir o Discord.
//
// Cada combinação roda em um processo próprio, para nenhuma carregar estado da
// anterior. Nada aqui grava áudio: só a energia agregada, quadro a quadro.
//
// Uso:
//   node scripts/diagnose-microphone.cjs            (roda as quatro)
//   node scripts/diagnose-microphone.cjs A          (roda uma)

const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const CENARIOS = {
  A: { echoCancellation: true, saidaAntes: false },
  B: { echoCancellation: false, saidaAntes: false },
  C: { echoCancellation: true, saidaAntes: true },
  D: { echoCancellation: false, saidaAntes: true },
  // O que o Tumacord realmente faz: captura crua, filtro neural GTCRN em
  // WebAssembly, e a faixa enviada é a SAÍDA do filtro — não a faixa do
  // dispositivo. Mede os dois lados para separar captura de processamento.
  E: { echoCancellation: true, saidaAntes: false, neural: true },
  F: { echoCancellation: true, saidaAntes: true, neural: true },
  // Cinco ciclos de captura e liberação no mesmo processo. É o padrão do
  // defeito relatado: funciona uma vez e não volta.
  G: { echoCancellation: true, saidaAntes: false, ciclos: 5 },
  H: { echoCancellation: true, saidaAntes: false, neural: true, ciclos: 5 },
};
const DURACAO_MS = 3_000;

// Estado dos nós de entrada no PipeWire, para saber se a fonte estava
// suspensa antes da captura e se ela acordou depois.
async function estadoDasFontes() {
  try {
    const { stdout } = await execFileAsync('pw-dump', [], { maxBuffer: 32 * 1024 * 1024, timeout: 8_000 });
    return JSON.parse(stdout)
      .filter((no) => no?.type === 'PipeWire:Interface:Node' && no?.info?.props?.['media.class'] === 'Audio/Source')
      .map((no) => ({
        nome: no.info.props['node.description'] || no.info.props['node.name'],
        estado: no.info.state,
      }));
  } catch {
    return null;
  }
}

const RENDERER = `
  const { ipcRenderer } = require('electron');
  const cenario = window.CENARIO;

  function rms(analyser) {
    const amostras = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(amostras);
    let soma = 0;
    for (const amostra of amostras) { const n = (amostra - 128) / 128; soma += n * n; }
    return Math.sqrt(soma / amostras.length);
  }

  async function medirUmCiclo(cenario, contextoSaida) {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: { ideal: cenario.echoCancellation }, noiseSuppression: { ideal: false }, autoGainControl: { ideal: true }, channelCount: { ideal: 1 }, sampleRate: { ideal: 48000 } },
      video: false,
    });
    const faixa = stream.getAudioTracks()[0];
    const contexto = new AudioContext({ sampleRate: 48000 });
    await contexto.resume().catch(() => {});
    const fonte = contexto.createMediaStreamSource(stream);
    const entrada = contexto.createAnalyser();
    entrada.fftSize = 256;
    fonte.connect(entrada);
    let saidaAnalisador = null;
    if (cenario.neural) {
      const fs = require('node:fs');
      const path = require('node:path');
      const raiz = path.join(process.env.TUMACORD_RAIZ, 'node_modules/@sapphi-red/web-noise-suppressor');
      const url = URL.createObjectURL(new Blob([fs.readFileSync(path.join(raiz, 'dist/gtcrn/workletProcessor.js'), 'utf8')], { type: 'text/javascript' }));
      await contexto.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const wasm = fs.readFileSync(path.join(raiz, 'dist/gtcrn.wasm'));
      const { GtcrnWorkletNode } = require(path.join(raiz, 'dist/index.cjs'));
      const supressor = new GtcrnWorkletNode(contexto, { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), maxChannels: 1 });
      saidaAnalisador = contexto.createAnalyser();
      saidaAnalisador.fftSize = 256;
      fonte.connect(supressor);
      supressor.connect(saidaAnalisador);
      supressor.connect(contexto.createMediaStreamDestination());
    }
    const leituras = [];
    const inicio = Date.now();
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        leituras.push(Number(rms(saidaAnalisador || entrada).toFixed(5)));
        if (Date.now() - inicio >= 1500) { clearInterval(timer); resolve(); }
      }, 100);
    });
    const resultado = {
      rmsMaximo: Math.max(...leituras),
      zeros: leituras.filter((v) => v === 0).length,
      total: leituras.length,
      faixa: { readyState: faixa.readyState, enabled: faixa.enabled, muted: faixa.muted },
      contexto: contexto.state,
    };
    stream.getTracks().forEach((t) => t.stop());
    await contexto.close().catch(() => {});
    return resultado;
  }

  (async () => {
    const relato = { cenario, eventos: [], erro: null };
    if (cenario.ciclos) {
      try {
        relato.ciclos = [];
        for (let i = 1; i <= cenario.ciclos; i += 1) {
          relato.ciclos.push({ ciclo: i, ...(await medirUmCiclo(cenario)) });
          await new Promise((r) => setTimeout(r, 400));
        }
        const mudos = relato.ciclos.filter((c) => c.rmsMaximo === 0).map((c) => c.ciclo);
        relato.veredito = mudos.length ? 'MUDO nos ciclos ' + mudos.join(', ') : 'COM SINAL em todos os ciclos';
      } catch (erro) {
        relato.erro = String(erro && erro.name ? erro.name + ': ' + erro.message : erro);
      }
      ipcRenderer.send('relato', relato);
      return;
    }
    let saida = null;
    try {
      // Saída de áudio ativa ANTES da captura, quando o cenário pede: é a
      // referência de reprodução que a hipótese do cancelamento de eco exige.
      if (cenario.saidaAntes) {
        saida = new AudioContext({ sampleRate: 48000 });
        await saida.resume().catch(() => {});
        const oscilador = saida.createOscillator();
        const ganho = saida.createGain();
        ganho.gain.value = 0.0001; // inaudível, mas o fluxo existe
        oscilador.connect(ganho).connect(saida.destination);
        oscilador.start();
        relato.saidaAntes = { state: saida.state };
        await new Promise((r) => setTimeout(r, 600));
      }

      const t0 = Date.now();
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: { ideal: cenario.echoCancellation },
          noiseSuppression: { ideal: false },
          autoGainControl: { ideal: true },
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48000 },
        },
        video: false,
      });
      relato.tempoAquisicaoMs = Date.now() - t0;

      const faixa = stream.getAudioTracks()[0];
      const settings = faixa.getSettings();
      relato.deviceIdSolicitado = '(padrão do sistema)';
      relato.deviceIdAdquirido = settings.deviceId || '(não informado)';
      relato.rotulo = faixa.label;
      relato.settings = {
        echoCancellation: settings.echoCancellation,
        noiseSuppression: settings.noiseSuppression,
        autoGainControl: settings.autoGainControl,
        sampleRate: settings.sampleRate,
        channelCount: settings.channelCount,
      };
      relato.inicial = { readyState: faixa.readyState, enabled: faixa.enabled, muted: faixa.muted };
      faixa.addEventListener('mute', () => relato.eventos.push({ evento: 'mute', em: Date.now() - t0 }));
      faixa.addEventListener('unmute', () => relato.eventos.push({ evento: 'unmute', em: Date.now() - t0 }));
      faixa.addEventListener('ended', () => relato.eventos.push({ evento: 'ended', em: Date.now() - t0 }));

      const contexto = new AudioContext({ sampleRate: 48000 });
      await contexto.resume().catch(() => {});
      relato.contextoCaptura = { state: contexto.state };
      const fonte = contexto.createMediaStreamSource(stream);
      const analisador = contexto.createAnalyser();
      analisador.fftSize = 256;
      fonte.connect(analisador);

      // Caminho do Tumacord: a faixa que vai para os outros participantes é a
      // saída do filtro neural, e não a do dispositivo.
      let analisadorSaida = null;
      let faixaEnviada = faixa;
      if (cenario.neural) {
        const fs = require('node:fs');
        const path = require('node:path');
        const raiz = path.join(process.env.TUMACORD_RAIZ, 'node_modules/@sapphi-red/web-noise-suppressor');
        const t1 = Date.now();
        const fonteWorklet = fs.readFileSync(path.join(raiz, 'dist/gtcrn/workletProcessor.js'), 'utf8');
        const url = URL.createObjectURL(new Blob([fonteWorklet], { type: 'text/javascript' }));
        await contexto.audioWorklet.addModule(url);
        URL.revokeObjectURL(url);
        const wasm = fs.readFileSync(path.join(raiz, 'dist/gtcrn.wasm'));
        const { GtcrnWorkletNode } = require(path.join(raiz, 'dist/index.cjs'));
        const supressor = new GtcrnWorkletNode(contexto, { wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength), maxChannels: 1 });
        const destino = contexto.createMediaStreamDestination();
        analisadorSaida = contexto.createAnalyser();
        analisadorSaida.fftSize = 256;
        fonte.connect(supressor);
        supressor.connect(destino);
        supressor.connect(analisadorSaida);
        faixaEnviada = destino.stream.getAudioTracks()[0];
        relato.neural = { montagemMs: Date.now() - t1, faixaSaida: { readyState: faixaEnviada.readyState, enabled: faixaEnviada.enabled, muted: faixaEnviada.muted } };
      }

      const leituras = [];
      const leiturasSaida = [];
      const inicio = Date.now();
      await new Promise((resolve) => {
        const timer = setInterval(() => {
          leituras.push(Number(rms(analisador).toFixed(5)));
          if (analisadorSaida) leiturasSaida.push(Number(rms(analisadorSaida).toFixed(5)));
          if (Date.now() - inicio >= ${DURACAO_MS}) { clearInterval(timer); resolve(); }
        }, 100);
      });

      relato.leituras = leituras;
      relato.rmsMaximo = Math.max(...leituras);
      relato.rmsMedio = Number((leituras.reduce((a, b) => a + b, 0) / leituras.length).toFixed(5));
      relato.leiturasExatamenteZero = leituras.filter((v) => v === 0).length;
      if (analisadorSaida) {
        relato.saida = {
          rmsMaximo: Math.max(...leiturasSaida),
          rmsMedio: Number((leiturasSaida.reduce((a, b) => a + b, 0) / leiturasSaida.length).toFixed(5)),
          zeros: leiturasSaida.filter((v) => v === 0).length,
          total: leiturasSaida.length,
        };
      }
      relato.final = { readyState: faixaEnviada.readyState, enabled: faixaEnviada.enabled, muted: faixaEnviada.muted };
      const medida = analisadorSaida ? relato.saida.rmsMaximo : relato.rmsMaximo;
      relato.veredito = medida === 0 ? 'MUDO (nenhuma amostra)' : medida < 0.006 ? 'quase mudo' : 'COM SINAL';

      stream.getTracks().forEach((t) => t.stop());
      await contexto.close().catch(() => {});
      if (saida) await saida.close().catch(() => {});
    } catch (erro) {
      relato.erro = String(erro && erro.name ? erro.name + ': ' + erro.message : erro);
    }
    ipcRenderer.send('relato', relato);
  })();
`;

const MAIN = `
  const { app, BrowserWindow, ipcMain, session } = require('electron');
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.whenReady().then(() => {
    session.defaultSession.setPermissionRequestHandler((_wc, p, cb) => cb(p === 'media'));
    session.defaultSession.setPermissionCheckHandler((_wc, p) => p === 'media');
    const janela = new BrowserWindow({
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        autoplayPolicy: 'no-user-gesture-required',
        backgroundThrottling: false,
      },
    });
    ipcMain.on('relato', (_evento, relato) => {
      process.stdout.write('__RELATO__' + JSON.stringify(relato) + '\\n');
      app.exit(0);
    });
    janela.loadFile(process.env.TUMACORD_PAGINA);
  });
`;

async function rodarCenario(nome) {
  const cenario = CENARIOS[nome];
  const antes = await estadoDasFontes();
  const fs = require('node:fs');
  const os = require('node:os');
  const base = path.join(os.tmpdir(), `tumacord-mic-${process.pid}-${nome}`);
  fs.mkdirSync(base, { recursive: true });
  const mainFile = path.join(base, 'main.cjs');
  const paginaFile = path.join(base, 'medicao.html');
  fs.writeFileSync(mainFile, MAIN, 'utf8');
  fs.writeFileSync(paginaFile, `<!doctype html><meta charset="utf-8"><title>medicao</title>`
    + `<script>window.CENARIO=${JSON.stringify(cenario)};</script><script>${RENDERER}</script>`, 'utf8');
  const electron = require('electron');

  const relato = await new Promise((resolve) => {
    let saida = '';
    const filho = spawn(electron, [mainFile, `--cenario=${JSON.stringify(cenario)}`], {
      env: { ...process.env, TUMACORD_PAGINA: paginaFile, TUMACORD_RAIZ: process.cwd(), ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const prazo = setTimeout(() => { filho.kill('SIGKILL'); resolve({ erro: 'tempo esgotado' }); }, DURACAO_MS + 20_000);
    filho.stdout.on('data', (pedaco) => { saida += pedaco.toString(); });
    filho.on('exit', () => {
      clearTimeout(prazo);
      const linha = saida.split('\n').find((l) => l.startsWith('__RELATO__'));
      resolve(linha ? JSON.parse(linha.slice(10)) : { erro: 'sem relato', saida: saida.slice(-400) });
    });
  });

  fs.rmSync(base, { recursive: true, force: true });
  const depois = await estadoDasFontes();
  return { nome, ...relato, pipewireAntes: antes, pipewireDepois: depois };
}

(async () => {
  const pedidos = process.argv.slice(2).filter((a) => CENARIOS[a]);
  const nomes = pedidos.length ? pedidos : Object.keys(CENARIOS);
  const resultados = [];
  for (const nome of nomes) {
    process.stderr.write(`rodando cenário ${nome}…\n`);
    resultados.push(await rodarCenario(nome));
    await new Promise((r) => setTimeout(r, 1_200));
  }
  console.log(JSON.stringify(resultados, null, 2));
})();

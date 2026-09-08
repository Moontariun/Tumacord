// Janela sobreposta ao desktop: o traço que alguém desenha na sua transmissão
// aparece por cima da tela de verdade, não só dentro do Tumacord. É o que
// permite continuar olhando para o jogo ou para o editor e ainda ver o que
// estão apontando.
//
// Três coisas a tornam frágil, e as três estão tratadas aqui:
//
// **Só faz sentido para o monitor inteiro.** As coordenadas são frações do
// quadro capturado. Capturando um monitor, o quadro é o monitor e a conta
// fecha. Capturando uma janela, o quadro é aquela janela — e nós não sabemos
// onde ela está na tela, nem se ela se moveu desde então. Nesse caso a janela
// sobreposta não abre, e o desenho continua aparecendo dentro do aplicativo.
//
// **Transparência e clique-passante dependem do compositor.** Nada aqui pode
// derrubar o aplicativo se o KDE, o GNOME ou o DWM recusarem: toda chamada de
// enfeite é tentada e esquecida.
//
// **Ela está na tela que está sendo capturada.** No Windows,
// `setContentProtection` tira a janela da captura. No Linux o portal do
// PipeWire captura o monitor inteiro e não sabe excluir uma janela, então o
// traço aparece duas vezes para quem assiste: a cópia local, imediata, e a que
// volta dentro do vídeo. Documentado, não escondido.

const { BrowserWindow, screen } = require('electron');
const path = require('node:path');

// `screen:<display_id>:<índice>` é o formato do desktopCapturer para monitor.
function displayForSource(sourceId, displays, primary) {
  const match = /^screen:(\d+):/.exec(String(sourceId ?? ''));
  if (!match) return null;
  const encontrado = displays.find((display) => String(display.id) === match[1]);
  return encontrado ?? primary ?? null;
}

// Abrir e fechar a janela sobreposta custa caro em compositor — e, no
// KDE/Wayland, cada mapeamento tira o foco de teclado de quem estava
// digitando. Uma rajada de traços com pausas de dois segundos abria e fechava
// a janela várias vezes. Agora, sem traços, ela só ESVAZIA; a janela em si é
// fechada depois de uma carência, e um traço novo cancela o fechamento.
const OVERLAY_LINGER_MS = 8_000;

class DrawingOverlay {
  constructor(options = {}) {
    this.lingerMs = options.lingerMs ?? OVERLAY_LINGER_MS;
    this.lingerTimer = null;
    this.createWindow = options.createWindow ?? ((config) => new BrowserWindow(config));
    this.readDisplays = options.readDisplays ?? (() => screen.getAllDisplays());
    this.readPrimary = options.readPrimary ?? (() => screen.getPrimaryDisplay());
    this.file = options.file ?? path.join(__dirname, 'overlay.html');
    this.preload = options.preload ?? path.join(__dirname, 'overlay-preload.cjs');
    this.window = null;
    this.sourceId = '';
    // O traço mais recente fica guardado até a página existir para recebê-lo.
    // `webContents.send` para uma janela que ainda está carregando não enfileira
    // nada: a mensagem simplesmente se perde, porque o ouvinte do preload ainda
    // não foi registrado. Era isso que deixava a sobreposição em branco — e no
    // Wayland, onde mapear a janela demora mais, ela nunca chegava a pintar.
    this.pending = null;
    this.loaded = false;
  }

  // Só monitor inteiro tem geometria conhecida. Janela, não.
  targetDisplay(sourceId, sourceKind) {
    if (sourceKind !== 'screen') return null;
    return displayForSource(sourceId, this.readDisplays(), this.readPrimary());
  }

  show({ sourceId, sourceKind, strokes, lifetime }) {
    const display = this.targetDisplay(sourceId, sourceKind);
    if (!display) return false;
    this.cancelLinger();
    if (!this.window || this.window.isDestroyed() || this.sourceId !== sourceId) {
      this.close();
      const janela = this.createWindow({
        ...display.bounds,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        show: false,
        backgroundColor: '#00000000',
        webPreferences: { preload: this.preload, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false },
      });
      // Nenhuma destas pode derrubar o aplicativo se o compositor recusar.
      try { janela.setIgnoreMouseEvents(true, { forward: false }); } catch { /* sem clique-passante */ }
      try { janela.setAlwaysOnTop(true, 'screen-saver'); } catch { /* sem alfinete */ }
      try { janela.setVisibleOnAllWorkspaces(true, { visibleOnFullScreenWindow: true }); } catch { /* idem */ }
      // No Windows isto tira a janela da própria captura, evitando o traço
      // aparecer duas vezes para quem assiste.
      try { janela.setContentProtection(true); } catch { /* não suportado aqui */ }
      try { janela.setBounds(display.bounds); } catch { /* Wayland ignora posição */ }
      janela.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      janela.webContents.on('will-navigate', (event) => event.preventDefault());
      janela.on('closed', () => { if (this.window === janela) { this.window = null; this.sourceId = ''; this.loaded = false; } });
      this.window = janela;
      this.sourceId = sourceId;
      this.loaded = false;
      // O ouvinte precisa existir antes do carregamento começar: uma página
      // que carrega rápido terminaria antes de alguém estar escutando.
      try {
        janela.webContents.on('did-finish-load', () => {
          if (this.window !== janela) return;
          this.loaded = true;
          this.flush();
        });
      } catch { /* stub sem eventos */ }
      void janela.loadFile(this.file).catch(() => undefined);
      try { janela.showInactive(); } catch { /* alguns compositores só têm show() */ }
      // No Wayland, `showInactive` de uma janela não focável às vezes não
      // chega a mapear nada. Sem isto, a sobreposição existia e ninguém a via.
      try { if (!janela.isVisible?.()) janela.show(); } catch { /* idem */ }
    }
    this.push(strokes, lifetime);
    return true;
  }

  push(strokes, lifetime) {
    if (!this.window || this.window.isDestroyed()) return;
    this.pending = { strokes, lifetime };
    this.flush();
  }

  flush() {
    if (!this.loaded || !this.pending) return;
    if (!this.window || this.window.isDestroyed()) return;
    this.window.webContents.send('tumacord:overlay-strokes', this.pending);
  }

  // Sem traço nenhum: a página se esvazia e para de pintar, e a janela fica de
  // pé por uma carência. É o que evita o vaivém de foco durante um desenho.
  clear() {
    this.cancelLinger();
    if (!this.window || this.window.isDestroyed()) return false;
    this.push([], this.pending ? this.pending.lifetime : 6000);
    this.lingerTimer = setTimeout(() => {
      this.lingerTimer = null;
      this.close();
    }, this.lingerMs);
    if (typeof this.lingerTimer?.unref === 'function') this.lingerTimer.unref();
    return true;
  }

  cancelLinger() {
    if (!this.lingerTimer) return;
    clearTimeout(this.lingerTimer);
    this.lingerTimer = null;
  }

  close() {
    this.cancelLinger();
    const janela = this.window;
    this.window = null;
    this.sourceId = '';
    this.pending = null;
    this.loaded = false;
    if (janela && !janela.isDestroyed()) {
      try { janela.close(); } catch { /* já estava indo embora */ }
    }
  }

  get visible() {
    return Boolean(this.window && !this.window.isDestroyed());
  }
}

module.exports = { DrawingOverlay, OVERLAY_LINGER_MS, displayForSource };

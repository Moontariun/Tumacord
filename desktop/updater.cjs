// Procurar, baixar e aplicar uma versão nova.
//
// O aplicativo procura ao abrir e não faz mais nada sozinho: baixar é um
// clique, aplicar é outro. Uma atualização automática no meio de uma call
// custaria a call, e é justamente durante uma call que o Tumacord é usado.
//
// A decisão de qual versão oferecer mora em `update-check.cjs`, sem rede e sem
// disco. Aqui fica o que precisa dos dois — e o cuidado que isso exige:
//
//   - só https, e só para o GitHub. O endereço do arquivo vem de uma resposta
//     da rede; se ela mandasse baixar de outro lugar, seria de outro lugar que
//     viria o executável. Cada redirecionamento é conferido de novo;
//   - tamanho e resumo conferidos antes de qualquer coisa ser executada;
//   - no Linux gerenciado, a build nova vai para uma pasta imutável e só o
//     atalho `current` é trocado — o mesmo que o instalador faz. Nenhum
//     arquivo em uso é sobrescrito, e a sessão aberta continua inteira.

const { createHash } = require('node:crypto');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { chooseUpdate, installKind } = require('./update-check.cjs');

const DEFAULT_REPOSITORY = 'Moontariun/Tumacord';
// Um arquivo maior do que isso não é uma versão do Tumacord: o instalador do
// Windows tem ~110 MB e o AppImage ~120 MB. O teto existe para que um servidor
// que responda para sempre não encha o disco de quem está esperando.
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;
const REQUEST_TIMEOUT = 20_000;
const MAX_REDIRECTS = 5;

// A lista de Releases vem de `api.github.com`; o arquivo em si é servido por um
// redirecionamento para o armazenamento do GitHub. Nada além disso é aceito.
function isAllowedUrl(candidate) {
  let url;
  try {
    url = new URL(String(candidate));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return url.hostname === 'api.github.com'
    || url.hostname === 'github.com'
    || url.hostname.endsWith('.githubusercontent.com');
}

function request(url, { headers = {}, redirectsLeft = MAX_REDIRECTS } = {}) {
  return new Promise((resolve, reject) => {
    if (!isAllowedUrl(url)) {
      reject(new Error('O endereço da atualização não é do GitHub; nada foi baixado.'));
      return;
    }
    const call = https.get(url, { headers }, (response) => {
      const status = response.statusCode ?? 0;
      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (redirectsLeft <= 0) {
          reject(new Error('A atualização redirecionou vezes demais.'));
          return;
        }
        const next = new URL(response.headers.location, url).toString();
        resolve(request(next, { headers, redirectsLeft: redirectsLeft - 1 }));
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(new Error(status === 403
          ? 'O GitHub recusou a consulta por excesso de pedidos; tente de novo mais tarde.'
          : `O GitHub respondeu ${status || 'sem status'} à consulta de versões.`));
        return;
      }
      resolve(response);
    });
    call.setTimeout(REQUEST_TIMEOUT, () => call.destroy(new Error('A consulta de versões demorou demais.')));
    call.on('error', reject);
  });
}

async function readJson(url, headers) {
  const response = await request(url, { headers });
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    // Uma resposta de JSON do GitHub não passa de alguns megabytes. Acima
    // disso não é a lista de Releases.
    if (size > 8 * 1024 * 1024) {
      response.destroy();
      throw new Error('A lista de versões veio grande demais.');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// O nome vem da resposta da rede e vira nome de arquivo em disco: separador de
// caminho e nome relativo saem daqui.
function safeFileName(name) {
  const base = path.basename(String(name ?? '')).replace(/[^A-Za-z0-9._-]/g, '_');
  return base && base !== '.' && base !== '..' ? base : 'tumacord-atualizacao';
}

function sanitizeState(input) {
  const source = input && typeof input === 'object' ? input : {};
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : true,
    lastCheck: Number.isFinite(source.lastCheck) ? Number(source.lastCheck) : 0,
    dismissed: typeof source.dismissed === 'string' ? source.dismissed : '',
    // Versão cujo "o que mudou" já foi mostrado. Guardada aqui, e não no
    // navegador, porque a pergunta é sobre esta instalação da máquina: quem
    // apagar os dados do site não vai rever o changelog da versão de antes.
    notesSeen: typeof source.notesSeen === 'string' ? source.notesSeen : '',
  };
}

class Updater {
  // `kind` existe para o teste poder exercitar cada caminho de aplicação sem
  // ter de forjar uma instalação de verdade. Em uso normal ele não é passado e
  // quem responde é a detecção.
  constructor({ app, env = process.env, platform = process.platform, stateFile, repository, kind, log = () => {} } = {}) {
    this.app = app;
    this.env = env;
    this.platform = platform;
    this.log = log;
    this.repository = repository || env.TUMACORD_UPDATE_REPO || DEFAULT_REPOSITORY;
    this.version = app?.getVersion?.() ?? '0.0.0';
    this.stateFile = stateFile || (app ? path.join(app.getPath('userData'), 'update-state.json') : '');
    this.downloadDirectory = app ? path.join(app.getPath('userData'), 'updates') : '';
    this.kind = kind || installKind({
      platform: this.platform,
      env: this.env,
      resourcesPath: process.resourcesPath ?? '',
      home: app?.getPath ? app.getPath('home') : '',
    });
    this.preferences = this.readPreferences();
    this.listeners = new Set();
    this.pending = null;
    this.cancelled = false;
    this.snapshot = {
      phase: 'idle',
      kind: this.kind,
      installed: this.version,
      installedBroken: '',
      installedRelease: null,
      version: '',
      title: '',
      notes: '',
      pageUrl: '',
      publishedAt: '',
      asset: null,
      progress: { received: 0, total: 0 },
      error: '',
      applied: null,
      file: '',
      skipped: [],
      enabled: this.preferences.enabled,
      lastCheck: this.preferences.lastCheck,
      dismissed: this.preferences.dismissed,
      notesSeen: this.preferences.notesSeen,
    };
  }

  readPreferences() {
    try {
      return sanitizeState(JSON.parse(fs.readFileSync(this.stateFile, 'utf8')));
    } catch {
      return sanitizeState(null);
    }
  }

  writePreferences(patch) {
    this.preferences = sanitizeState({ ...this.preferences, ...patch });
    try {
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, `${JSON.stringify(this.preferences, null, 2)}\n`, 'utf8');
    } catch {
      // Preferência que não persiste ainda vale para esta sessão. Um disco
      // cheio não pode impedir alguém de atualizar.
    }
    return this.preferences;
  }

  onChange(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  state() {
    return { ...this.snapshot, progress: { ...this.snapshot.progress } };
  }

  update(patch) {
    this.snapshot = { ...this.snapshot, ...patch };
    const state = this.state();
    for (const listener of this.listeners) {
      try {
        listener(state);
      } catch {
        // Uma janela que já fechou não pode derrubar a atualização.
      }
    }
    return state;
  }

  // Procurar não muda nada na máquina: é uma consulta e uma decisão. Ela é
  // silenciosa de propósito quando falha — ficar sem internet não é um erro
  // que mereça uma tela.
  async check({ manual = false } = {}) {
    if (this.snapshot.phase === 'checking' || this.snapshot.phase === 'downloading' || this.snapshot.phase === 'applying') return this.state();
    this.update({ phase: 'checking', error: '' });
    try {
      const releases = await readJson(`https://api.github.com/repos/${this.repository}/releases?per_page=20`, {
        'User-Agent': `Tumacord/${this.version}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      });
      const decision = chooseUpdate({ releases, currentVersion: this.version, kind: this.kind });
      const preferences = this.writePreferences({ lastCheck: Date.now() });
      this.log({ event: 'update-check', status: decision.status, version: decision.version ?? '', kind: this.kind, manual });
      return this.update({
        phase: decision.status === 'available' ? 'available' : decision.status === 'no-asset' ? 'no-asset' : 'up-to-date',
        installedBroken: decision.installedBroken ?? '',
        // As notas da versão instalada vêm na mesma consulta. É o que a tela
        // de "o que mudou" mostra na primeira abertura depois de atualizar —
        // inclusive quando a atualização foi feita por fora, pelo script de
        // instalação ou trocando o arquivo à mão.
        installedRelease: decision.installedRelease ?? this.snapshot.installedRelease,
        version: decision.version ?? '',
        title: decision.title ?? '',
        notes: decision.notes ?? '',
        pageUrl: decision.pageUrl ?? '',
        publishedAt: decision.publishedAt ?? '',
        asset: decision.asset ?? null,
        skipped: decision.skipped ?? [],
        progress: { received: 0, total: decision.asset?.size ?? 0 },
        file: '',
        applied: null,
        lastCheck: preferences.lastCheck,
        error: '',
      });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      this.log({ event: 'update-check-failed', message });
      return this.update({ phase: manual ? 'error' : 'idle', error: manual ? message : '' });
    }
  }

  async download() {
    const asset = this.snapshot.asset;
    if (!asset || !asset.url) return this.update({ phase: 'error', error: 'Não há arquivo desta versão para o jeito que o Tumacord foi instalado aqui.' });
    if (this.snapshot.phase === 'downloading') return this.state();

    const destination = path.join(this.downloadDirectory, safeFileName(asset.name));
    this.cancelled = false;
    this.update({ phase: 'downloading', error: '', progress: { received: 0, total: asset.size || 0 } });
    try {
      fs.mkdirSync(this.downloadDirectory, { recursive: true });
      const digest = await this.fetchToFile(asset.url, destination, asset.size);
      const expected = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1];
      if (expected && expected.toLowerCase() !== digest) {
        fs.rmSync(destination, { force: true });
        throw new Error('O arquivo baixado não confere com o resumo publicado; ele foi descartado.');
      }
      this.log({ event: 'update-downloaded', version: this.snapshot.version, file: path.basename(destination) });
      return this.update({ phase: 'ready', file: destination });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (!this.cancelled) this.log({ event: 'update-download-failed', message });
      try {
        fs.rmSync(destination, { force: true });
      } catch {
        // O arquivo parcial some na próxima tentativa.
      }
      return this.update({ phase: 'available', error: this.cancelled ? '' : message, progress: { received: 0, total: asset.size || 0 } });
    }
  }

  async fetchToFile(url, destination, expectedSize) {
    const response = await request(url, { headers: { 'User-Agent': `Tumacord/${this.version}`, Accept: 'application/octet-stream' } });
    this.pending = response;
    const total = Number(response.headers['content-length']) || expectedSize || 0;
    const hash = createHash('sha256');
    const partial = `${destination}.parcial`;
    const file = fs.createWriteStream(partial);
    let received = 0;
    let lastReport = 0;
    try {
      for await (const chunk of response) {
        received += chunk.length;
        if (received > MAX_DOWNLOAD_BYTES) throw new Error('O arquivo da atualização passou do tamanho aceitável.');
        hash.update(chunk);
        if (!file.write(chunk)) {
          // Sem o `error` aqui, um disco cheio deixaria esta espera pendurada
          // para sempre — download parado, sem barra andando e sem erro.
          await new Promise((resolve, reject) => {
            file.once('drain', resolve);
            file.once('error', reject);
          });
        }
        // Cem avisos por segundo à interface durante um download de cem
        // megabytes seria trabalho de IPC gasto para desenhar a mesma barra.
        const now = Date.now();
        if (now - lastReport > 250) {
          lastReport = now;
          this.update({ progress: { received, total } });
        }
      }
      await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
      if (expectedSize && received !== expectedSize) throw new Error('O arquivo baixado veio incompleto.');
      fs.renameSync(partial, destination);
      this.update({ progress: { received, total: total || received } });
      return hash.digest('hex');
    } catch (error) {
      file.destroy();
      fs.rmSync(partial, { force: true });
      throw error;
    } finally {
      this.pending = null;
    }
  }

  cancel() {
    if (!this.pending) return this.state();
    // O erro que sobe do fluxo interrompido é consequência do clique, não
    // defeito. `download()` consulta esta marca para não anunciar falha.
    this.cancelled = true;
    this.pending.destroy(new Error('Download cancelado.'));
    this.pending = null;
    return this.update({ phase: 'available', error: '' });
  }

  // Aplicar é o único momento em que algo muda fora da pasta de downloads, e é
  // sempre um clique de quem está na frente do computador.
  async apply() {
    if (this.snapshot.phase !== 'ready' || !this.snapshot.file) return this.state();
    this.update({ phase: 'applying', error: '' });
    try {
      const applied = await this.applyFile(this.snapshot.file, this.snapshot.version);
      this.log({ event: 'update-applied', version: this.snapshot.version, kind: this.kind, restart: applied.restart });
      return this.update({ phase: 'applied', applied, error: '' });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      this.log({ event: 'update-apply-failed', message, kind: this.kind });
      return this.update({ phase: 'ready', error: message });
    }
  }

  applyFile(file, version) {
    if (this.kind === 'linux-managed') return this.applyLinuxManaged(file, version);
    if (this.kind === 'linux-appimage') return this.applyLinuxAppImage(file);
    if (this.kind === 'windows-installed') return this.applyWindowsInstaller(file);
    if (this.kind === 'windows-portable') return this.applyWindowsPortable(file);
    throw new Error('Esta cópia não foi instalada por um caminho que o Tumacord saiba atualizar sozinho.');
  }

  // O mesmo desenho do `install-linux.sh`: a build nova entra em uma pasta
  // própria e somente o atalho `current` é trocado, de uma vez. Por isso
  // atualizar durante uma call não mistura arquivos — a sessão aberta continua
  // lendo a pasta antiga, que ninguém tocou.
  applyLinuxManaged(file, version) {
    const home = this.app?.getPath ? this.app.getPath('home') : '';
    const dataHome = this.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
    const installRoot = path.join(dataHome, 'tumacord');
    const versionsDirectory = path.join(installRoot, 'versions');
    fs.mkdirSync(versionsDirectory, { recursive: true });

    // `tar` acompanha toda distribuição alvo e o próprio instalador depende
    // dele, mas uma falta aqui apareceria como "a atualização não funciona".
    try {
      execFileSync('tar', ['--version'], { stdio: 'ignore' });
    } catch {
      throw new Error('O comando `tar` não está disponível nesta máquina; instale-o ou reinstale o Tumacord pelo script.');
    }

    const staging = fs.mkdtempSync(path.join(versionsDirectory, '.baixada.'));
    try {
      execFileSync('tar', ['-xzf', file, '-C', staging]);
      const entries = fs.readdirSync(staging);
      const root = entries.length === 1 && fs.statSync(path.join(staging, entries[0])).isDirectory()
        ? path.join(staging, entries[0])
        : staging;
      const executable = path.join(root, 'tumacord');
      if (!fs.existsSync(executable)) throw new Error('O pacote baixado não contém o executável do Tumacord.');

      // O Electron recusa o próprio auxiliar de sandbox quando ele tem o bit
      // setuid sem pertencer ao root — e uma build extraída pelo usuário nunca
      // pertence. Sem o bit ele usa o sandbox por namespace do kernel. É o que
      // o instalador já faz, pelo mesmo motivo.
      const sandbox = path.join(root, 'chrome-sandbox');
      try {
        const info = fs.statSync(sandbox);
        if (info.uid !== 0 && (info.mode & 0o4000) !== 0) fs.chmodSync(sandbox, info.mode & 0o777 & ~0o4000);
      } catch {
        // Sem auxiliar de sandbox não há bit para tirar.
      }

      const stamp = createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
      const versionDirectory = path.join(versionsDirectory, `${version}-${stamp}`);
      if (fs.existsSync(versionDirectory)) fs.rmSync(root, { recursive: true, force: true });
      else fs.renameSync(root, versionDirectory);

      const currentLink = path.join(installRoot, 'current');
      const previousLink = path.join(installRoot, 'previous');
      let currentTarget = '';
      try {
        currentTarget = fs.realpathSync(currentLink);
      } catch {
        // Primeira instalação sem atalho: não há versão anterior a guardar.
      }
      // A versão anterior continua no disco, apontada por `previous`. É o
      // caminho de volta quando a nova não presta — e este projeto já teve uma
      // versão que não prestou.
      if (currentTarget && currentTarget !== versionDirectory) {
        fs.rmSync(previousLink, { force: true });
        fs.symlinkSync(currentTarget, previousLink);
      }
      const nextLink = path.join(installRoot, '.current.next');
      fs.rmSync(nextLink, { force: true });
      fs.symlinkSync(versionDirectory, nextLink);
      fs.renameSync(nextLink, currentLink);
      fs.writeFileSync(path.join(installRoot, 'version'), `${version}\n`, 'utf8');
      fs.rmSync(file, { force: true });

      return {
        restart: 'now',
        message: `A versão ${version} está instalada. Ela passa a valer quando o Tumacord for reaberto; a sessão atual continua na versão de antes.`,
      };
    } finally {
      fs.rmSync(staging, { recursive: true, force: true });
    }
  }

  // O AppImage em execução continua montado a partir do arquivo aberto, então
  // trocar o arquivo por baixo é seguro: a sessão atual segue inteira e o
  // próximo início já é a versão nova.
  applyLinuxAppImage(file) {
    const target = this.env.APPIMAGE;
    const next = `${target}.novo`;
    try {
      fs.copyFileSync(file, next);
      fs.chmodSync(next, 0o755);
      fs.renameSync(next, target);
    } catch (error) {
      fs.rmSync(next, { force: true });
      throw new Error(`Não consegui substituir ${target} (${error && error.message ? error.message : error}). O arquivo novo está em ${file} e pode ser movido à mão.`);
    }
    fs.rmSync(file, { force: true });
    return { restart: 'now', message: 'O AppImage foi substituído. Reabrir o Tumacord já usa a versão nova.' };
  }

  // O instalador do Windows pede elevação e substitui a instalação inteira;
  // ele não pode fazer isso com o aplicativo aberto. Quem fecha é o Tumacord,
  // logo depois de entregar o instalador ao Windows.
  applyWindowsInstaller(file) {
    const child = spawn(file, [], { detached: true, stdio: 'ignore' });
    child.unref();
    return {
      restart: 'quit',
      message: 'O instalador foi aberto. O Tumacord vai fechar para ele poder substituir a instalação; o Windows vai pedir sua confirmação.',
    };
  }

  // Um portable não se substitui em execução: o Windows mantém o arquivo do
  // processo bloqueado. O certo é deixar o novo ao lado e dizer isso.
  applyWindowsPortable(file) {
    const running = this.env.PORTABLE_EXECUTABLE_FILE || '';
    const destination = running ? path.join(path.dirname(running), path.basename(file)) : file;
    if (destination !== file) {
      try {
        fs.copyFileSync(file, destination);
        fs.rmSync(file, { force: true });
      } catch (error) {
        throw new Error(`Não consegui guardar o portable novo ao lado do atual (${error && error.message ? error.message : error}). Ele continua em ${file}.`);
      }
    }
    return {
      restart: 'manual',
      folder: path.dirname(destination),
      message: `A versão nova está em ${destination}. Feche o Tumacord e abra esse arquivo; o antigo pode ser apagado depois.`,
    };
  }

  // "Já li o que mudou nesta versão." A tela não volta na próxima abertura, e
  // a da próxima versão volta a aparecer — uma vez.
  markNotesSeen(version) {
    const alvo = typeof version === 'string' && version ? version : this.snapshot.installed;
    const preferences = this.writePreferences({ notesSeen: alvo });
    return this.update({ notesSeen: preferences.notesSeen });
  }

  dismiss(version) {
    const target = typeof version === 'string' && version ? version : this.snapshot.version;
    const preferences = this.writePreferences({ dismissed: target });
    return this.update({ dismissed: preferences.dismissed });
  }

  setEnabled(enabled) {
    const preferences = this.writePreferences({ enabled: enabled !== false });
    return this.update({ enabled: preferences.enabled });
  }
}

module.exports = { DEFAULT_REPOSITORY, MAX_DOWNLOAD_BYTES, Updater, isAllowedUrl, safeFileName, sanitizeState };

// Procurar, baixar e aplicar uma versão nova.
//
// O aplicativo procura ao abrir e não faz mais nada sozinho: baixar é um
// clique, aplicar é outro. Uma atualização automática no meio de uma call
// custaria a call, e é justamente durante uma call que o Tumacord é usado.
//
// **A origem mudou na 0.9.9-1: este arquivo não fala mais com o GitHub.** Quem
// serve atualização é a distribuição privada do grupo, na mesma VPS do
// servidor dedicado. O repositório continua privado e continua sendo onde o
// código mora; o que deixou de existir é o caminho que levava o aplicativo de
// qualquer pessoa até a API pública do GitHub.
//
// A divisão de trabalho:
//
//   · `update-origin.cjs` — de onde este aplicativo aceita atualização, e em
//     quem ele confia. Configuração **do aplicativo**, nunca da rede;
//   · `update-credentials.cjs` — a credencial deste dispositivo, no mecanismo
//     seguro do sistema;
//   · `update-source.cjs` — a rede: buscar, verificar assinatura e baixar;
//   · `update-check.cjs` — a decisão, sem rede e sem disco;
//   · este arquivo — o estado, o progresso e a aplicação.
//
// O cuidado que sobrou aqui é o de sempre: tamanho e resumo conferidos antes
// de qualquer coisa ser executada, e no Linux gerenciado a build nova vai para
// uma pasta imutável enquanto só o atalho `current` é trocado — nenhum arquivo
// em uso é sobrescrito, e a sessão aberta continua inteira.

const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { failureMessage, launchElevatedInstaller, verifyInstallerFile } = require('./windows-installer.cjs');
const { chooseFromCatalog, installKind, manifestsToFetch } = require('./update-check.cjs');
const { MESSAGES: CREDENTIAL_MESSAGES, clearDeviceCredential, readDeviceCredential, shouldRenew, writeDeviceCredential } = require('./update-credentials.cjs');
const { updateOrigin } = require('./update-origin.cjs');
const { downloadArtifact, enrollDevice, fetchCatalog, fetchManifest, renewDevice } = require('./update-source.cjs');

// Um arquivo maior do que isso não é uma versão do Tumacord: o instalador do
// Windows tem ~110 MB e o AppImage ~120 MB. O teto existe para que um serviço
// que responda para sempre não encha o disco de quem está esperando.
const MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024;

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
    // A maior sequência de catálogo que este aplicativo já aceitou.
    //
    // É o anti-retrocesso: um serviço que voltasse no tempo — por erro ou por
    // alguém no meio do caminho — reoferecia uma versão que o grupo já deixou
    // para trás, ou segurava a retirada de uma defeituosa. Ela só cresce.
    catalogSequence: Number.isSafeInteger(source.catalogSequence) && source.catalogSequence >= 0 ? source.catalogSequence : 0,
  };
}

class Updater {
  // `kind` existe para o teste poder exercitar cada caminho de aplicação sem
  // ter de forjar uma instalação de verdade. Em uso normal ele não é passado e
  // quem responde é a detecção.
  constructor({ app, env = process.env, platform = process.platform, stateFile, kind, safeStorage, userDataPath, log = () => {} } = {}) {
    this.app = app;
    this.env = env;
    this.platform = platform;
    this.log = log;
    this.version = app?.getVersion?.() ?? '0.0.0';
    this.userDataPath = userDataPath || (app ? app.getPath('userData') : '');
    // O chaveiro do sistema, para a credencial do dispositivo. Injetável para
    // o teste poder exercitar o caminho sem chaveiro, que é o caso comum numa
    // sessão Linux sem gerenciador de segredos.
    this.safeStorage = safeStorage ?? null;
    this.stateFile = stateFile || (this.userDataPath ? path.join(this.userDataPath, 'update-state.json') : '');
    this.downloadDirectory = this.userDataPath ? path.join(this.userDataPath, 'updates') : '';
    this.kind = kind || installKind({
      platform: this.platform,
      env: this.env,
      resourcesPath: process.resourcesPath ?? '',
      home: app?.getPath ? app.getPath('home') : '',
    });
    this.preferences = this.readPreferences();
    this.listeners = new Set();
    // Preenchida só quando o chaveiro do sistema não aceitou guardar a
    // credencial. Ela morre com o processo, de propósito.
    this.sessionCredential = null;
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
      latest: '',
      mustStop: null,
      enabled: this.preferences.enabled,
      lastCheck: this.preferences.lastCheck,
      dismissed: this.preferences.dismissed,
      notesSeen: this.preferences.notesSeen,
      // De onde este aplicativo aceita atualização, e se ele já foi autorizado
      // a baixar. Os dois aparecem na tela: sem origem não há o que procurar,
      // e sem credencial a pessoa precisa de um convite do dono.
      origin: '',
      originSource: 'none',
      deviceId: '',
      needsEnrollment: false,
      enrollmentMessage: '',
    };
  }

  /**
   * De onde buscar, em quem confiar, e com qual credencial.
   *
   * Lido a cada verificação, e não guardado no construtor: a pessoa pode
   * inscrever o dispositivo com o aplicativo aberto, e a próxima procura
   * precisa enxergar isso.
   */
  source() {
    const origin = updateOrigin({ env: this.env, userDataPath: this.userDataPath });
    const stored = this.userDataPath
      ? readDeviceCredential({ userDataPath: this.userDataPath, safeStorage: this.safeStorage })
      : { token: '', deviceId: '', reason: 'missing' };
    // A credencial desta sessão entra quando o disco não pôde guardá-la —
    // sessão sem chaveiro, que é o caso comum no Linux. Ela faz a inscrição
    // valer **agora**, que é o que a mensagem promete; na próxima abertura
    // será preciso um convite novo, e isso também é dito.
    const credential = stored.token ? stored : (this.sessionCredential ?? stored);
    return { ...origin, credential };
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

    const { origin, source: originSource, trustedKeys, reason: originReason, credential } = this.source();

    // Sem origem configurada não há o que procurar, e tentar um endereço
    // adivinhado seria pior do que não tentar. Isso é dito, não escondido.
    if (!origin) {
      return this.update({ phase: 'no-origin', origin: '', originSource, error: manual ? originReason : '', needsEnrollment: false, enrollmentMessage: originReason });
    }
    // Sem chave confiável, nada do que chegar pode ser verificado — e aceitar
    // sem verificar seria trocar a verificação por um endereço.
    if (!trustedKeys.length) {
      const withoutKeys = 'Este aplicativo não tem nenhuma chave pública configurada para verificar as atualizações. Peça ao dono do servidor a configuração de origem.';
      return this.update({ phase: 'no-origin', origin, originSource, error: manual ? withoutKeys : '', needsEnrollment: false, enrollmentMessage: withoutKeys });
    }
    // Sem credencial, **tenta assim mesmo**.
    //
    // Um serviço com leitura aberta responde, e a pessoa não precisa digitar
    // convite nenhum — que é o ponto: um passo manual por máquina é um passo
    // que metade do grupo não dá, e no Windows ele acontece antes de o
    // aplicativo existir. Um serviço fechado responde 401, e é aí, e só aí,
    // que o convite é pedido.
    //
    // Custa um pedido a mais só no caso fechado, e evita inventar um contrato
    // novo de "me diga se você exige credencial" — a resposta do próprio
    // catálogo já diz isso.

    this.update({ phase: 'checking', error: '', origin, originSource, deviceId: credential.deviceId ?? '', needsEnrollment: false, enrollmentMessage: '' });

    try {
      // Renovar cedo evita perder o prazo justamente quando não há rede. Uma
      // falha aqui não impede a procura: a credencial atual ainda vale.
      if (shouldRenew(credential.expiresAt)) await this.renew().catch(() => undefined);

      const catalog = await fetchCatalog({
        origin,
        token: credential.token,
        trustedKeys,
        // O anti-retrocesso: um catálogo abaixo do maior já aceito é recusado
        // antes de qualquer leitura de conteúdo.
        acceptedSequence: this.preferences.catalogSequence,
      });

      // Só os manifestos que podem virar oferta, e o da versão instalada pelas
      // notas de "o que mudou". Buscar todos seria pedir dez documentos para
      // usar um.
      const wanted = manifestsToFetch({ catalog, currentVersion: this.version });
      const manifests = [];
      for (const item of wanted) {
        try {
          manifests.push(await fetchManifest({
            origin, token: credential.token, trustedKeys,
            releaseId: item.releaseId, expectedDigest: item.manifestSha256,
          }));
        } catch (error) {
          // Um manifesto que não verifica não derruba a procura: ele apenas
          // não vira oferta, e a versão dele aparece como pulada.
          this.log({ event: 'update-manifest-rejected', releaseId: item.releaseId, reason: String(error?.reason ?? error?.message ?? error) });
        }
      }

      const decision = chooseFromCatalog({
        catalog, manifests, currentVersion: this.version, kind: this.kind, arch: process.arch === 'arm64' ? 'arm64' : 'x64',
      });

      // A sequência aceita sobe junto, e só sobe.
      const preferences = this.writePreferences({
        lastCheck: Date.now(),
        catalogSequence: Math.max(this.preferences.catalogSequence, Number(catalog.sequence) || 0),
      });

      // Procurar de novo com uma versão já baixada não pode jogar o download
      // fora à toa: se a oferta continua sendo a mesma versão, o arquivo que
      // está no disco continua servindo. Só quando a oferta muda — porque
      // apareceu uma mais nova — é que ele deixa de valer.
      const mesmaOferta = Boolean(decision.version) && decision.version === this.snapshot.version;
      const baixadaSegueValendo = mesmaOferta && this.snapshot.phase === 'ready' && Boolean(this.snapshot.file);

      this.log({ event: 'update-check', status: decision.status, version: decision.version ?? '', kind: this.kind, manual, sequence: catalog.sequence });
      return this.update({
        phase: baixadaSegueValendo ? 'ready' : decision.status === 'available' ? 'available' : decision.status === 'no-asset' ? 'no-asset' : 'up-to-date',
        installedBroken: decision.installedBroken ?? '',
        installedRelease: decision.installedRelease ?? this.snapshot.installedRelease,
        version: decision.version ?? '',
        title: decision.title ?? '',
        notes: decision.notes ?? '',
        // Não há página pública numa distribuição privada. O campo continua
        // existindo para a interface, e continua vazio.
        pageUrl: '',
        publishedAt: decision.publishedAt ?? '',
        asset: decision.asset ?? null,
        skipped: decision.skipped ?? [],
        latest: decision.latest ?? '',
        mustStop: decision.mustStop ?? null,
        progress: { received: 0, total: decision.asset?.size ?? 0 },
        file: baixadaSegueValendo ? this.snapshot.file : '',
        // O resumo acompanha o arquivo. Preservá-lo é o que permite conferir
        // de novo na hora de aplicar; descartá-lo junto com uma oferta que
        // mudou é o que impede o resumo velho de "validar" o arquivo novo.
        sha256: baixadaSegueValendo ? (this.snapshot.sha256 || '') : '',
        applied: null,
        lastCheck: preferences.lastCheck,
        error: '',
      });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      const reason = String(error?.reason ?? '');
      this.log({ event: 'update-check-failed', message, reason });

      // Credencial recusada não é falha de rede: ela não volta sozinha, e
      // insistir a cada abertura só gastaria pedido. A credencial local sai, e
      // a tela passa a pedir um convite novo.
      //
      // O `status` entra na conta porque a procura passou a ser tentada **sem**
      // credencial: num serviço de leitura aberta ela nem é necessária, e num
      // serviço fechado a recusa chega como 401 antes de haver `reason` algum
      // para classificar. Sem isto, quem não tem credencial veria "falhou" em
      // vez do pedido de convite.
      if (reason === 'revoked' || reason === 'unknown' || error?.status === 401 || error?.status === 403) {
        clearDeviceCredential({ userDataPath: this.userDataPath });
        this.sessionCredential = null;
        return this.update({
          phase: 'needs-enrollment', needsEnrollment: true, enrollmentMessage: message,
          error: manual ? message : '', deviceId: '',
        });
      }
      // Ficar sem internet não é um erro que mereça uma tela.
      return this.update({ phase: manual ? 'error' : 'idle', error: manual ? message : '' });
    }
  }

  /**
   * Trocar um convite por uma credencial deste dispositivo.
   *
   * O convite vem por canal privado e vale uma vez. Quem chega aqui é a pessoa
   * na frente do computador — nenhum caminho de rede inscreve dispositivo.
   */
  async enroll(invite, label = '') {
    const { origin, reason: originReason } = this.source();
    if (!origin) return this.update({ phase: 'no-origin', error: originReason });
    try {
      const enrolled = await enrollDevice({ origin, invite: String(invite ?? ''), label: String(label || this.env.HOSTNAME || 'dispositivo') });
      const saved = writeDeviceCredential(
        { userDataPath: this.userDataPath, safeStorage: this.safeStorage },
        { token: enrolled.token, deviceId: enrolled.deviceId, expiresAt: enrolled.expiresAt },
      );
      this.log({ event: 'update-device-enrolled', deviceId: enrolled.deviceId, saved: saved.saved });
      // Sem chaveiro a credencial não vai para o disco — mas ela vale nesta
      // sessão, e é isso que a mensagem promete. Guardá-la só em memória é o
      // meio-termo honesto: escrever em claro seria pior, e descartar faria a
      // inscrição que acabou de funcionar parecer que falhou.
      this.sessionCredential = saved.saved
        ? null
        : { token: enrolled.token, deviceId: enrolled.deviceId, expiresAt: enrolled.expiresAt, reason: '' };
      const warning = saved.saved ? '' : saved.message;
      this.update({ deviceId: enrolled.deviceId, needsEnrollment: false, enrollmentMessage: warning, error: '' });
      const afterEnroll = await this.check({ manual: true });
      // A procura recarrega a origem e a credencial, e com isso apagaria o
      // aviso de que a credencial não foi gravada. Ele volta aqui.
      return warning ? this.update({ enrollmentMessage: warning }) : afterEnroll;
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      this.log({ event: 'update-device-enroll-failed', message });
      return this.update({ phase: 'needs-enrollment', needsEnrollment: true, enrollmentMessage: message, error: message });
    }
  }

  /** Renova a credencial deste dispositivo, enquanto ela ainda vale. */
  async renew() {
    const { origin, credential } = this.source();
    if (!origin || !credential.token) return this.state();
    const renewed = await renewDevice({ origin, token: credential.token });
    const saved = writeDeviceCredential(
      { userDataPath: this.userDataPath, safeStorage: this.safeStorage },
      { token: renewed.token, deviceId: renewed.deviceId ?? credential.deviceId, expiresAt: renewed.expiresAt },
    );
    this.sessionCredential = saved.saved
      ? null
      : { token: renewed.token, deviceId: renewed.deviceId ?? credential.deviceId, expiresAt: renewed.expiresAt, reason: '' };
    this.log({ event: 'update-device-renewed', deviceId: renewed.deviceId ?? credential.deviceId });
    return this.state();
  }

  async download() {
    const asset = this.snapshot.asset;
    if (!asset || !asset.releaseId || !asset.artifactId) {
      return this.update({ phase: 'error', error: 'Não há pacote desta versão para o jeito que o Tumacord foi instalado aqui.' });
    }
    if (this.snapshot.phase === 'downloading') return this.state();

    const { origin, trustedKeys, credential } = this.source();
    // Sem origem não há de onde baixar. Sem credencial, **tenta assim mesmo**:
    // a procura só chegou aqui porque o catálogo respondeu, e um serviço que
    // entrega o catálogo sem credencial entrega o pacote também. Se ele
    // recusar, a recusa chega como 401 e cai no tratamento de erro abaixo.
    if (!origin) {
      const semOrigem = 'Este aplicativo não tem uma origem de atualizações configurada.';
      return this.update({ phase: 'no-origin', error: semOrigem, enrollmentMessage: semOrigem });
    }
    if (asset.size > MAX_DOWNLOAD_BYTES) {
      return this.update({ phase: 'error', error: 'O pacote anunciado é maior do que qualquer versão do Tumacord; nada foi baixado.' });
    }

    const destination = path.join(this.downloadDirectory, safeFileName(asset.name));
    this.cancelled = false;
    this.update({ phase: 'downloading', error: '', progress: { received: 0, total: asset.size || 0 } });

    try {
      // O manifesto é buscado de novo, e não reaproveitado do estado: entre a
      // procura e o clique em baixar a versão pode ter sido retirada, e o
      // documento que autoriza o download precisa ser o de agora.
      const manifest = await fetchManifest({ origin, token: credential.token, trustedKeys, releaseId: asset.releaseId });
      const artifact = (manifest.artifacts ?? []).find((candidate) => candidate.artifactId === asset.artifactId);
      if (!artifact) throw new Error('O pacote desta versão não está mais no manifesto publicado.');

      const downloaded = await downloadArtifact({
        origin,
        token: credential.token,
        manifest,
        artifact,
        destination,
        onProgress: (progress) => this.update({ progress }),
        // O cancelamento é um clique, e ele é consultado a cada pedaço.
        shouldCancel: () => this.cancelled,
      });

      this.log({ event: 'update-downloaded', version: this.snapshot.version, file: path.basename(destination) });
      // O resumo do que foi baixado é guardado com o estado. Ele é conferido
      // de novo imediatamente antes de executar: entre baixar e aplicar há uma
      // janela em que o arquivo pode ser trocado, e essa janela é maior quando
      // a pessoa adia a instalação.
      return this.update({ phase: 'ready', file: downloaded.file, sha256: downloaded.sha256 });
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      if (!this.cancelled) this.log({ event: 'update-download-failed', message, reason: String(error?.reason ?? '') });
      return this.update({
        phase: 'available',
        error: this.cancelled ? '' : message,
        progress: { received: 0, total: asset.size || 0 },
      });
    } finally {
      this.cancelled = false;
    }
  }

  /**
   * Cancelar o download em andamento.
   *
   * A marca é consultada a cada pedaço recebido. O arquivo parcial **fica** no
   * disco de propósito: a próxima tentativa continua de onde parou, e num
   * pacote de cem megabytes numa conexão ruim isso é a diferença entre
   * conseguir e não conseguir.
   */
  cancel() {
    if (this.snapshot.phase !== 'downloading') return this.state();
    this.cancelled = true;
    return this.update({ phase: 'available', error: '' });
  }

  // A pasta de downloads não pode virar arquivo morto.
  //
  // Um pacote de versão passa dos noventa megabytes, e três caminhos deixavam
  // um para trás: o instalador do Windows, que não pode ser apagado enquanto
  // está rodando; um download que ninguém chegou a aplicar, porque a fase não
  // sobrevive ao fechamento do aplicativo e na volta ninguém mais sabe daquele
  // arquivo; e a sobra de uma tentativa interrompida na hora errada.
  //
  // A varredura roda na abertura e logo depois de aplicar. Ela guarda só o que
  // ainda pode ser necessário e apaga o resto — inclusive o instalador da vez
  // passada, que na abertura seguinte já não está em uso.
  sweepDownloads(keep = '') {
    if (!this.downloadDirectory || this.snapshot.phase === 'downloading') return [];
    const manter = keep ? path.resolve(keep) : '';
    const removidos = [];
    let nomes = [];
    try {
      nomes = fs.readdirSync(this.downloadDirectory);
    } catch {
      // A pasta só existe depois do primeiro download.
      return removidos;
    }
    for (const nome of nomes) {
      const alvo = path.join(this.downloadDirectory, nome);
      if (manter && path.resolve(alvo) === manter) continue;
      try {
        fs.rmSync(alvo, { recursive: true, force: true });
        removidos.push(nome);
      } catch {
        // Arquivo em uso — o instalador do Windows enquanto roda, por exemplo.
        // A próxima abertura tenta de novo, e aí ele já terminou.
      }
    }
    if (removidos.length) this.log({ event: 'update-downloads-cleaned', files: removidos.length });
    return removidos;
  }

  // Aplicar é o único momento em que algo muda fora da pasta de downloads, e é
  // sempre um clique de quem está na frente do computador.
  async apply() {
    if (this.snapshot.phase !== 'ready' || !this.snapshot.file) return this.state();
    this.update({ phase: 'applying', error: '' });
    try {
      const applied = await this.applyFile(this.snapshot.file, this.snapshot.version);
      this.log({ event: 'update-applied', version: this.snapshot.version, kind: this.kind, restart: applied.restart });
      // Aplicado, o resto da pasta de downloads não serve mais para nada — com
      // uma exceção: o instalador do Windows continua sendo lido pelo processo
      // que acabou de ser elevado. Apagá-lo aqui é tirar o arquivo debaixo de
      // quem está instalando. Ele é preservado e sai na abertura seguinte,
      // quando a versão nova já estiver confirmada.
      this.sweepDownloads(applied.keepFile || '');
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
  // ele não pode fazer isso com o aplicativo aberto. Mas fechar antes de saber
  // que ele começou deixa a pessoa sem instalador **e** sem Tumacord — e era
  // isso que acontecia: o `spawn` era dado como sucesso sem ninguém conferir.
  //
  // Aqui a ordem é: conferir o arquivo de novo, pedir a elevação, **esperar a
  // resposta**, e só então dizer que pode fechar. Nada disso pode derrubar o
  // processo principal, que é o que o print da 0.9.8 mostrava acontecendo.
  async applyWindowsInstaller(file) {
    // A verificação do download não vale para este momento: entre baixar e
    // aplicar o arquivo pode ter sido trocado, truncado ou removido. Um
    // executável que vai receber administrador é o último lugar onde faz
    // sentido confiar em verificação antiga.
    const verified = verifyInstallerFile(file, this.snapshot.sha256 || '');
    if (!verified.ok) throw new Error(failureMessage(verified.cause));

    const launchOutcome = await launchElevatedInstaller(file, { env: this.env });
    if (!launchOutcome.started) {
      this.log({ event: 'update-windows-launch-failed', cause: launchOutcome.cause, kind: this.kind });
      // O arquivo continua no disco de propósito: a pessoa pode executá-lo à
      // mão, e é isso que a mensagem diz. Apagá-lo aqui tiraria a única saída
      // que resta quando a elevação não passa.
      const launchError = new Error(`${failureMessage(launchOutcome.cause)} O instalador está em ${file}.`);
      launchError.cause = launchOutcome.cause;
      launchError.installerPath = file;
      throw launchError;
    }

    this.log({ event: 'update-windows-launched', pid: launchOutcome.pid, kind: this.kind });
    return {
      restart: 'quit',
      // O instalador é conservado até a próxima abertura confirmar a versão.
      // Apagá-lo agora tiraria o arquivo debaixo de um instalador que ainda
      // está lendo dele.
      keepFile: file,
      installerPid: launchOutcome.pid,
      message: 'O instalador começou. O Tumacord vai fechar para ele poder substituir a instalação.',
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

module.exports = { MAX_DOWNLOAD_BYTES, Updater, safeFileName, sanitizeState };

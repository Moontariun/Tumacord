// O preflight: o que precisa estar certo antes de mexer na instalação.
//
// Ele existe porque a infraestrutura não estava disponível quando isto foi
// escrito. Em vez de supor endereço, caminho e volume, o código pergunta à
// máquina — e é o operador que roda, na VPS, quando ela existir.
//
// A regra que atravessa o arquivo: **verificação ambígua é falha**. "Não
// consegui conferir" nunca vira "está tudo bem". Foi assim que o guia antigo
// seguia sem backup quando não achava o volume.

import { access, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { dataMount } from './discovery.mjs';

/** Um resultado de verificação. `warn` não impede; `fail` impede. */
export const LEVELS = ['ok', 'warn', 'fail'];

export function check(level, title, detail, howToFix = '') {
  return { level, title, detail, howToFix };
}

/** O pior nível de uma lista. É ele que decide se a operação segue. */
export function worstLevel(checks) {
  if (checks.some((item) => item.level === 'fail')) return 'fail';
  if (checks.some((item) => item.level === 'warn')) return 'warn';
  return 'ok';
}

/**
 * Espaço livre no sistema de arquivos de um caminho.
 *
 * Em bytes, e do sistema de arquivos que **de fato** contém o caminho — não do
 * `/`. Um volume Docker costuma estar noutro disco, e conferir o `/` responde
 * sobre o lugar errado.
 */
export async function freeSpace(target) {
  try {
    const info = await statfs(target);
    return { ok: true, free: info.bavail * info.bsize, total: info.blocks * info.bsize };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** Se uma porta TCP do host está livre para escutar. */
export function portIsFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

/** Se um caminho existe e é legível/gravável por quem está rodando. */
export async function permissions(target) {
  const result = { exists: false, readable: false, writable: false };
  try {
    await access(target, constants.F_OK);
    result.exists = true;
  } catch {
    return result;
  }
  try { await access(target, constants.R_OK); result.readable = true; } catch { /* sem leitura */ }
  try { await access(target, constants.W_OK); result.writable = true; } catch { /* sem escrita */ }
  return result;
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const units = ['B', 'kB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) { value /= 1024; index += 1; }
  return `${value.toFixed(value < 10 && index > 0 ? 1 : 0)} ${units[index]}`;
}

/**
 * O preflight de uma instalação descoberta.
 *
 * Recebe a instalação já escolhida — a escolha é do operador quando há mais de
 * uma — e devolve a lista de verificações com o que resolver em cada falha.
 *
 * `minimumFreeBytes` é o dobro do que uma release costuma ocupar mais folga
 * para o backup: aplicar sem espaço para o backup é aplicar sem backup.
 */
export async function preflight(installation, options = {}) {
  const {
    minimumFreeBytes = 2 * 1024 * 1024 * 1024,
    readFreeSpace = freeSpace,
    readPermissions = permissions,
  } = options;
  const checks = [];

  // ── A instalação existe e está identificada ──────────────────────────────
  checks.push(check('ok', 'Instalação identificada',
    `projeto "${installation.project}"${installation.directory ? `, em ${installation.directory}` : ''}`));

  const chat = installation.services['tumacord-server'];
  if (!chat) {
    checks.push(check('fail', 'Servidor de chat', 'o serviço `tumacord-server` não existe neste projeto',
      'Confira se está no projeto certo: `tumacordctl doctor --project <nome>`.'));
  } else {
    checks.push(check(
      chat.status === 'running' ? 'ok' : 'warn',
      'Servidor de chat',
      `${chat.name}: ${chat.status}${chat.health ? ` (saúde: ${chat.health})` : ''}`,
      chat.status === 'running' ? '' : 'Suba com `docker compose up -d` antes de aplicar uma atualização.',
    ));
  }

  const updates = installation.services['tumacord-updates'];
  checks.push(updates
    ? check(updates.status === 'running' ? 'ok' : 'warn', 'Serviço de atualizações',
      `${updates.name}: ${updates.status}`,
      updates.status === 'running' ? '' : 'Suba com `docker compose up -d tumacord-updates`.')
    : check('warn', 'Serviço de atualizações', 'não está instalado neste projeto',
      'Enquanto ele não existir, os aplicativos continuam dependendo da ponte manual. Veja docs/instalacao-vps.md.'));

  // ── Os dados: um mount, e só um ──────────────────────────────────────────
  //
  // Aqui é onde o guia antigo errava. O volume não é procurado por nome nem
  // por expressão regular: ele é o mount que o contêiner **tem** em /data.
  if (chat) {
    const data = dataMount(chat, '/data');
    if (!data) {
      checks.push(check('fail', 'Volume de dados', 'o contêiner do chat não tem nada montado em /data',
        'Sem saber onde os dados estão, nada é aplicado: um backup que não acontece só avisa na hora de restaurar. Confira o `docker-compose.yml` desta instalação.'));
    } else {
      const candidates = (chat.mounts ?? []).filter((mount) => mount.destination === '/data');
      if (candidates.length > 1) {
        checks.push(check('fail', 'Volume de dados', `há ${candidates.length} mounts em /data`,
          'Descoberta ambígua para a operação: escolher um deles seria escolher de qual você perde os dados.'));
      } else {
        checks.push(check(
          data.writable ? 'ok' : 'fail',
          'Volume de dados',
          `${data.kind} ${data.name || data.source} → /data${data.writable ? '' : ' (somente leitura!)'}`,
          data.writable ? '' : 'O servidor não consegue gravar. Corrija o mount antes de qualquer coisa.',
        ));

        // Espaço no disco que de fato contém os dados.
        if (data.source) {
          const space = await readFreeSpace(data.source);
          if (!space.ok) {
            checks.push(check('warn', 'Espaço em disco', `não consegui medir ${data.source}: ${space.error}`,
              'Rode como o usuário que administra o Docker, ou meça à mão com `df -h`.'));
          } else {
            checks.push(check(
              space.free >= minimumFreeBytes ? 'ok' : 'fail',
              'Espaço em disco',
              `${humanBytes(space.free)} livres de ${humanBytes(space.total)} em ${data.source}`,
              space.free >= minimumFreeBytes
                ? ''
                : `Aplicar precisa de espaço para o backup **e** para a imagem nova; o mínimo aqui é ${humanBytes(minimumFreeBytes)}. Libere espaço antes.`,
            ));
          }
          const granted = await readPermissions(data.source);
          checks.push(check(
            granted.exists && granted.readable ? 'ok' : 'warn',
            'Permissão de leitura dos dados',
            granted.exists
              ? `leitura: ${granted.readable ? 'sim' : 'não'}, escrita: ${granted.writable ? 'sim' : 'não'}`
              : 'o caminho do volume não é visível deste usuário',
            granted.exists && granted.readable ? '' : 'O backup lê daqui. Rode como root ou pelo usuário do Docker.',
          ));
        }
      }
    }

    // ── Portas ─────────────────────────────────────────────────────────────
    for (const port of chat.ports ?? []) {
      checks.push(check('ok', 'Porta publicada', `${port.inside} → ${port.host}`));
    }
  }

  // A porta da administração do serviço de atualizações **não** pode estar
  // aberta para fora. Publicá-la exporia a operação mais sensível do sistema.
  if (updates) {
    const exposed = (updates.ports ?? []).filter((port) => port.inside.startsWith('4301') && !port.host.startsWith('127.0.0.1'));
    checks.push(exposed.length
      ? check('fail', 'Porta de administração', `a 4301 está publicada em ${exposed.map((port) => port.host).join(', ')}`,
        'Ela precisa ficar no laço local: `127.0.0.1:4301:4301`. Quem a opera é o executor, que já está na máquina.')
      : check('ok', 'Porta de administração', 'a 4301 não está publicada para fora'));
  }

  // ── Configuração sem segredo impresso ────────────────────────────────────
  if (chat) {
    const required = ['DATA_DIR', 'SERVER_ACCESS_KEY'];
    const missing = required.filter((name) => !(chat.variables ?? []).includes(name));
    checks.push(missing.length
      ? check('fail', 'Configuração', `faltam variáveis: ${missing.join(', ')}`,
        'Confira o `.env` desta instalação. Veja docs/configuracao.md.')
      // Só os nomes. Imprimir os valores vazaria a chave no primeiro print.
      : check('ok', 'Configuração', `${(chat.variables ?? []).length} variáveis definidas (valores não são impressos)`));
  }

  return { checks, level: worstLevel(checks) };
}

/** Se uma porta do host está livre, para o preflight de instalação nova. */
export async function preflightPorts(ports, checkPort = portIsFree) {
  const checks = [];
  for (const port of ports) {
    const free = await checkPort(port);
    checks.push(check(free ? 'ok' : 'fail', `Porta ${port}`, free ? 'livre' : 'já está em uso',
      free ? '' : `Descubra quem a usa com \`ss -ltnp sport = :${port}\` e libere, ou escolha outra porta no .env.`));
  }
  return { checks, level: worstLevel(checks) };
}

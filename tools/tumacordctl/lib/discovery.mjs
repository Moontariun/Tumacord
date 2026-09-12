// Descobrir a instalação que está na máquina.
//
// ## Por que isto existe
//
// O guia antigo mandava achar o volume de dados com uma expressão regular
// sobre `docker volume ls`, pegar **o primeiro que combinasse** e, quando não
// combinasse nenhum, seguir sem backup. Três erros no mesmo lugar:
//
//   · "o primeiro que combina" escolhe entre coisas que não são a mesma. Duas
//     instalações na mesma máquina — ou um projeto Compose com outro nome —
//     produzem dois volumes parecidos, e o backup sai da instalação errada;
//   · o nome `tumacord-data` era presumido. Quem subiu com `-p outronome` tem
//     `outronome_tumacord-data`, e a regex não acha;
//   · não achar seguia adiante. Um backup que não aconteceu não avisa nada na
//     hora — avisa na hora da restauração.
//
// Aqui a descoberta é **estruturada**: `docker inspect` em JSON, e os mounts
// reais do contêiner que está rodando. Ambiguidade **para** a operação em vez
// de virar sorteio: com duas instalações candidatas, quem escolhe é o operador.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const runFile = promisify(execFile);

/** Roda um comando e devolve a saída, sem shell e sem concatenação. */
export async function run(command, args, options = {}) {
  try {
    const { stdout, stderr } = await runFile(command, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...options });
    return { ok: true, stdout, stderr };
  } catch (error) {
    return { ok: false, stdout: error?.stdout ?? '', stderr: error?.stderr ?? String(error?.message ?? error), code: error?.code };
  }
}

/**
 * As instalações do Tumacord nesta máquina.
 *
 * A busca é por **rótulo do Compose**, e não por nome: o rótulo
 * `com.docker.compose.project` é posto pelo próprio Compose e sobrevive a
 * qualquer nome de projeto que o operador tenha escolhido.
 */
export async function discoverInstallations(runCommand = run) {
  const listing = await runCommand('docker', [
    'ps', '--all', '--no-trunc', '--filter', 'label=com.docker.compose.project',
    '--format', '{{json .}}',
  ]);
  if (!listing.ok) return { ok: false, error: `não consegui falar com o Docker: ${listing.stderr.trim()}`, installations: [] };

  const containers = listing.stdout.split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);

  const byProject = new Map();
  for (const container of containers) {
    const details = await inspect(container.ID ?? container.Id ?? '', runCommand);
    if (!details) continue;
    const labels = details.Config?.Labels ?? {};
    const project = labels['com.docker.compose.project'];
    const service = labels['com.docker.compose.service'];
    if (!project || !service) continue;
    // Só as instalações deste projeto. O nome do serviço vem do
    // docker-compose.yml e é estável; o nome do projeto, não.
    if (!['tumacord-server', 'tumacord-updates', 'coturn'].includes(service)) continue;

    const entry = byProject.get(project) ?? { project, directory: labels['com.docker.compose.project.working_dir'] ?? '', services: {} };
    entry.services[service] = {
      id: details.Id,
      name: (details.Name ?? '').replace(/^\//, ''),
      image: details.Config?.Image ?? '',
      status: details.State?.Status ?? '',
      health: details.State?.Health?.Status ?? '',
      startedAt: details.State?.StartedAt ?? '',
      // Os mounts **reais**, e não os que o arquivo diz. Eles podem divergir
      // quando o contêiner subiu com um arquivo diferente do que está lá agora.
      mounts: (details.Mounts ?? []).map((mount) => ({
        kind: mount.Type, name: mount.Name ?? '', source: mount.Source ?? '',
        destination: mount.Destination ?? '', writable: mount.RW !== false,
      })),
      ports: portsOf(details),
      // O ambiente vem **sem os valores**: nomes só. Um preflight que
      // imprimisse `SERVER_ACCESS_KEY=...` vazaria o segredo no primeiro print.
      variables: (details.Config?.Env ?? []).map((item) => String(item).split('=')[0]).filter(Boolean).sort(),
    };
    byProject.set(project, entry);
  }
  return { ok: true, installations: [...byProject.values()] };
}

async function inspect(id, runCommand) {
  if (!id) return null;
  const result = await runCommand('docker', ['inspect', id]);
  if (!result.ok) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return null;
  }
}

function portsOf(details) {
  const map = details.NetworkSettings?.Ports ?? {};
  const ports = [];
  for (const [inside, bindings] of Object.entries(map)) {
    for (const binding of bindings ?? []) {
      ports.push({ inside, host: `${binding.HostIp || '0.0.0.0'}:${binding.HostPort}` });
    }
  }
  return ports.sort((left, right) => left.inside.localeCompare(right.inside));
}

/**
 * O mount que guarda os dados do chat, dentro de um serviço.
 *
 * A busca é pelo **destino** — o caminho dentro do contêiner —, que é o que o
 * servidor realmente usa, e não pelo nome do volume, que o operador escolhe.
 */
export function dataMount(service, destination = '/data') {
  return (service?.mounts ?? []).find((mount) => mount.destination === destination) ?? null;
}

/**
 * Escolhe a instalação sobre a qual operar.
 *
 * Com uma, é ela. Com nenhuma ou mais de uma, **para** e diz o que fazer:
 * escolher sozinho entre duas instalações é escolher em qual das duas o
 * operador vai perder dados.
 */
export function chooseInstallation(installations, requestedProject = '') {
  if (requestedProject) {
    const found = installations.find((candidate) => candidate.project === requestedProject);
    if (!found) {
      return { ok: false, error: `Não encontrei a instalação "${requestedProject}". As que existem: ${installations.map((c) => c.project).join(', ') || 'nenhuma'}.` };
    }
    return { ok: true, installation: found };
  }
  if (!installations.length) {
    return { ok: false, error: 'Não encontrei nenhuma instalação do Tumacord nesta máquina. Rode dentro do diretório do projeto, ou passe --project <nome>.' };
  }
  if (installations.length > 1) {
    return {
      ok: false,
      error: `Há mais de uma instalação aqui: ${installations.map((c) => c.project).join(', ')}. Escolha com --project <nome> — escolher sozinho seria escolher em qual delas você perde dados.`,
    };
  }
  return { ok: true, installation: installations[0] };
}

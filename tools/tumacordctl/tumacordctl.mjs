#!/usr/bin/env node
// `tumacordctl` — a operação da distribuição pela linha de comando.
//
// O painel do dono e este comando chamam **os mesmos serviços internos**, com
// os mesmos parâmetros e as mesmas verificações. Isso não é elegância: é o que
// permite recuperar a instalação quando o painel é justamente o que não está
// funcionando. Um caminho de recuperação que depende da coisa quebrada não é
// caminho de recuperação.
//
// Nada aqui recebe URL, caminho ou comando de fora. A aplicação usa sempre uma
// release por **identificador exato**, e nunca uma branch em movimento: "a
// mais recente" muda de significado entre o momento em que o operador lê e o
// momento em que o comando roda.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chooseInstallation, dataMount, discoverInstallations } from './lib/discovery.mjs';
import { preflight, preflightPorts } from './lib/preflight.mjs';
import {
  dropVolume, installationIdOf, planBackup, rehearsalVolumeName, restoreToNewVolume, sha256OfFile,
} from './lib/backup.mjs';
import { JobStore } from './lib/jobs.mjs';
import { planApply, planRollback, releaseIsApproved, validateRef } from './lib/deploy.mjs';
import { previousDeployment, runApply, runBackup, runRollback } from './lib/operations.mjs';

const TOOL_VERSION = '0.9.9-1';

const HELP = `tumacordctl ${TOOL_VERSION} — operação da distribuição do Tumacord

USO
  tumacordctl <comando> [opções]

COMANDOS
  doctor                    Confere a instalação desta máquina e diz o que impede uma
                            atualização. Não muda nada. É o primeiro comando a rodar
                            numa VPS nova ou antes de qualquer operação.
  install show              Mostra a instalação descoberta: projeto, serviços, mounts
                            reais, portas e nomes das variáveis (sem os valores).
  releases import           Importa uma release já assinada para o serviço.
  releases publish          Promove o catálogo assinado. Só depois de todas as
                            verificações.
  releases withdraw         Retira uma versão. Ela para de ser oferecida e de poder
                            ser baixada, inclusive por quem já estava na rua.
  devices list              Lista os dispositivos autorizados a baixar.
  devices enroll            Cria um convite de uso único, para passar por canal privado.
  devices revoke            Revoga a autorização de um dispositivo.
  jobs status               Mostra os trabalhos de importação e aplicação.
  backup                    Cópia consistente dos dados do dedicado.
  restore                   Restaura uma cópia — em destino separado, antes de
                            substituir o que está em uso.
  server apply              Aplica uma release exata ao servidor dedicado.
  server rollback           Volta ao deployment anterior registrado.

OPÇÕES GERAIS
  --project <nome>          Qual instalação operar. Obrigatório quando há mais de uma
                            nesta máquina: escolher sozinho seria escolher em qual
                            delas você perde dados.
  --service <url>           Onde está a administração do serviço de atualizações.
                            Padrão: http://127.0.0.1:4301
  --json                    Saída em JSON, para script.
  --help                    Esta ajuda. Vale também por comando: \`tumacordctl doctor --help\`.

ONDE ESTÁ DOCUMENTADO
  Instalação na VPS ........ docs/instalacao-vps.md
  Publicação privada ....... docs/publicacao-privada.md
  Backup e restauração ..... docs/backup-restore.md
  Atualização do servidor .. docs/atualizacao-servidor.md
`;

const COMMAND_HELP = {
  doctor: `tumacordctl doctor — confere a instalação desta máquina

USO
  tumacordctl doctor [--project <nome>] [--json] [--ports 4600,4300]

O QUE ELE FAZ
  Descobre a instalação pelos rótulos do Compose, e não por nome de volume nem
  por expressão regular. Confere: serviços de pé, o mount **real** dos dados,
  espaço no disco que de fato contém esses dados, permissões de leitura, portas
  publicadas, e se a porta de administração do serviço de atualizações está
  exposta para fora.

  Não muda nada. Pode rodar a qualquer momento, inclusive com gente na call.

O QUE ELE NÃO FAZ
  Não imprime valor de variável nenhuma — só os nomes. Um preflight que
  imprimisse a chave do servidor a vazaria no primeiro print.

SAÍDA
  0  nada impede a operação
  1  há falhas; elas são listadas com o que resolver em cada uma
  2  não consegui nem descobrir a instalação
`,
  install: `tumacordctl install show — o que existe nesta máquina

USO
  tumacordctl install show [--project <nome>] [--json]

Mostra projeto, diretório, serviços com estado e saúde, mounts reais com
destino e se são graváveis, portas publicadas, e os **nomes** das variáveis de
ambiente. Valores não são impressos.

É esta a saída para anexar num relato de problema: ela descreve a instalação
sem carregar segredo nenhum.
`,
  backup: `tumacordctl backup — cópia consistente dos dados do dedicado

USO
  tumacordctl backup --out <diretório> [--project <nome>]

CONSISTÊNCIA
  O servidor grava o JSON de forma coordenada dentro do processo. Um \`tar\` do
  volume vivo **não** prova que o arquivo foi capturado entre duas gravações, e
  é por isso que ele não é usado sozinho: o backup pede ao servidor que
  descarregue e pause a escrita, copia estado e anexos no mesmo ponto, e libera.

  Sem conseguir a pausa, o comando **para**. Não continuar em silêncio é o
  ponto: um backup que não aconteceu só avisa na hora de restaurar.
`,
  restore: `tumacordctl restore — restaura uma cópia num volume de ensaio

USO
  tumacordctl restore --from <arquivo.tar.gz> [--project <nome>]

ORDEM
  A restauração acontece num volume **novo**, de ensaio, e é validada lá. Este
  comando nunca substitui o que está em uso: substituir é uma decisão separada,
  e o procedimento está em docs/backup-restore.md seção 5.

O QUE ELE CONFERE, NESTA ORDEM
  1. O resumo SHA-256 ao lado da cópia, antes de criar coisa alguma.
  2. Que a cópia abre e contém \`tumacord.json\`.
  3. Que o \`installationId\` de dentro dela é o da instalação em uso. Restaurar
     a cópia de OUTRA instalação por cima desta é o erro que mais custa, e é
     este o passo que o impede.

PERDA POTENCIAL
  Restaurar dados devolve a instalação ao ponto da cópia. Tudo o que foi
  escrito depois dela — mensagens, contas, anexos — não está lá.
`,
  jobs: `tumacordctl jobs — os trabalhos do executor

USO
  tumacordctl jobs status [<id>] [--json]
  tumacordctl jobs unlock --force-unlock

POR QUE ELES TÊM ESTADO EM DISCO
  Um deploy para o servidor. Se o estado vivesse na memória do processo,
  reiniciar no meio faria o trabalho sumir sem desfecho: ninguém saberia se ele
  terminou, e a próxima tentativa repetiria uma migração que já rodou.

O LOCK
  Um lock de um processo que não existe mais é **dito**, e não removido
  sozinho: aquele trabalho pode ter parado no meio de uma migração. Confira com
  \`jobs status\` antes de liberar com \`--force-unlock\`.
`,
  server: `tumacordctl server — aplicar uma release, e voltar atrás

USO
  tumacordctl server apply --release <releaseId> --ref <v0.9.9-1|commit> --out <diretório> [--dry-run]
  tumacordctl server apply --release <releaseId> --ref <v0.9.9-1|commit> --no-backup
  tumacordctl server rollback [--dry-run]

O QUE ENTRA
  Uma release publicada no catálogo aprovado e uma referência **exata** de git:
  etiqueta da convenção ou commit de 40 caracteres. Uma branch é recusada de
  propósito — ela muda de significado entre o momento em que você lê e o
  momento em que o comando roda.

A ORDEM
  preflight → registrar o deployment atual → buscar a referência → construir →
  subir → **validar**. O sucesso só é marcado depois da validação, e ela
  compara versão, commit e identidade da instalação. Um \`HTTP 200\` diz que
  algum servidor respondeu; ele não diz que é a versão que acabou de subir.

A CÓPIA
  \`--out\` faz a cópia consistente antes de tudo, e a aplicação para se ela
  falhar. Voltar o código NÃO volta os dados. Quem já tem uma cópia conferida
  dispensa com \`--no-backup\`, e a dispensa fica registrada no trabalho.

A VOLTA ATRÁS
  Vai para o deployment que foi **registrado** na aplicação, e não para um
  número escrito num guia.
`,
};

function parseArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (!raw.startsWith('--')) { positionals.push(raw); continue; }
    const name = raw.slice(2);
    if (name === 'help' || name === 'json') { options[name] = true; continue; }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) { options[name] = true; continue; }
    options[name] = next;
    index += 1;
  }
  return { positionals, options };
}

const SYMBOL = { ok: '·', warn: '!', fail: '×' };

function printChecks(result) {
  for (const item of result.checks) {
    console.log(`  ${SYMBOL[item.level]} ${item.title}: ${item.detail}`);
    if (item.howToFix) console.log(`      → ${item.howToFix}`);
  }
  console.log();
  if (result.level === 'fail') console.log('Há falhas acima. Elas impedem a operação — cada uma traz o que resolver.');
  else if (result.level === 'warn') console.log('Há avisos acima. Eles não impedem a operação, mas vale ler.');
  else console.log('Nada impede a operação.');
}

async function selectedInstallation(options) {
  const discovery = await discoverInstallations();
  if (!discovery.ok) return { ok: false, error: discovery.error, code: 2 };
  const choice = chooseInstallation(discovery.installations, typeof options.project === 'string' ? options.project : '');
  if (!choice.ok) return { ok: false, error: choice.error, code: 2 };
  return { ok: true, installation: choice.installation };
}

async function doctorCommand(options) {
  const choice = await selectedInstallation(options);
  if (!choice.ok) {
    console.error(choice.error);
    return choice.code;
  }
  const result = await preflight(choice.installation);
  if (typeof options.ports === 'string') {
    const ports = options.ports.split(',').map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
    const extra = await preflightPorts(ports);
    result.checks.push(...extra.checks);
    result.level = extra.level === 'fail' || result.level === 'fail'
      ? 'fail'
      : (extra.level === 'warn' || result.level === 'warn' ? 'warn' : 'ok');
  }
  if (options.json) {
    console.log(JSON.stringify({ project: choice.installation.project, ...result }, null, 2));
  } else {
    console.log(`\nPreflight da instalação "${choice.installation.project}"\n`);
    printChecks(result);
  }
  return result.level === 'fail' ? 1 : 0;
}

async function installCommand(positionals, options) {
  const sub = positionals[0] ?? 'show';
  if (sub !== 'show') {
    console.error(`Subcomando desconhecido: ${sub}. Use \`install show\`.`);
    return 1;
  }
  const choice = await selectedInstallation(options);
  if (!choice.ok) {
    console.error(choice.error);
    return choice.code;
  }
  const { installation } = choice;
  if (options.json) {
    console.log(JSON.stringify(installation, null, 2));
    return 0;
  }
  console.log(`\nProjeto:   ${installation.project}`);
  if (installation.directory) console.log(`Diretório: ${installation.directory}`);
  for (const [name, service] of Object.entries(installation.services)) {
    console.log(`\n  ${name}`);
    console.log(`    contêiner: ${service.name} (${service.status}${service.health ? `, saúde ${service.health}` : ''})`);
    console.log(`    imagem:    ${service.image}`);
    for (const mount of service.mounts) {
      console.log(`    mount:     ${mount.kind} ${mount.name || mount.source} → ${mount.destination}${mount.writable ? '' : ' (ro)'}`);
    }
    for (const port of service.ports) console.log(`    porta:     ${port.inside} → ${port.host}`);
    console.log(`    variáveis: ${service.variables.join(', ') || 'nenhuma'}`);
  }
  const chat = installation.services['tumacord-server'];
  const data = chat ? dataMount(chat, '/data') : null;
  console.log(`\nDados do chat: ${data ? `${data.kind} ${data.name || data.source}` : 'NÃO ENCONTRADOS — nada deve ser aplicado assim'}`);
  console.log('\n(Os valores das variáveis não são impressos: esta saída pode ser colada num relato.)');
  return 0;
}

/** Onde o estado dos trabalhos mora. Fora do checkout, que é descartável. */
function stateDir(options) {
  const raw = typeof options.state === 'string' ? options.state : (process.env.TUMACORD_EXECUTOR_STATE || '/var/lib/tumacord/executor');
  return path.resolve(raw);
}

/**
 * Abre o estado dos trabalhos, dizendo o que fazer quando não dá.
 *
 * O padrão é `/var/lib/tumacord/executor`, que na VPS pertence ao usuário do
 * executor. Um `EACCES` cru aqui não diz nada a quem está operando.
 */
async function openJobStore(options) {
  const directory = stateDir(options);
  const store = new JobStore(directory);
  try {
    await store.init();
  } catch (error) {
    return {
      ok: false,
      error: `Não consegui usar ${directory} para o estado dos trabalhos: ${error?.message ?? error}\n`
        + 'Rode como o usuário do executor, ou aponte outro lugar com --state <diretório> ou TUMACORD_EXECUTOR_STATE.',
    };
  }
  return { ok: true, store };
}

/**
 * A autorização para pausar a escrita, de onde ela pode vir sem passar por
 * linha de comando — que é legível por qualquer processo da máquina.
 *
 * Primeiro a sessão de um dono, se foi dada pelo ambiente. Senão, o segredo do
 * executor, que o servidor aceita para isso: rodando como o usuário do
 * executor, a cópia não depende de uma sessão que expira em dias.
 */
function ownerToken(options) {
  if (process.env.TUMACORD_OWNER_TOKEN) return process.env.TUMACORD_OWNER_TOKEN;
  try {
    return readFileSync(path.join(stateDir(options), 'executor.token'), 'utf8').trim();
  } catch {
    return '';
  }
}

/** A administração do serviço de atualizações, sempre no laço local. */
function serviceUrl(options) {
  const raw = typeof options.service === 'string' ? options.service : 'http://127.0.0.1:4301';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocolo');
    return url.origin;
  } catch {
    throw new Error(`--service precisa ser uma URL http(s): recebi ${JSON.stringify(raw)}`);
  }
}

async function ask(options, route, init = {}) {
  const response = await fetch(`${serviceUrl(options)}${route}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
  return { status: response.status, body };
}

async function devicesCommand(positionals, options) {
  const sub = positionals[0] ?? 'list';

  if (sub === 'list') {
    const { status, body } = await ask(options, '/admin/devices');
    if (status !== 200) { console.error(body.error ?? `o serviço respondeu ${status}`); return 1; }
    if (options.json) { console.log(JSON.stringify(body, null, 2)); return 0; }
    if (!body.devices?.length) { console.log('Nenhum dispositivo autorizado ainda.'); return 0; }
    for (const device of body.devices) {
      const state = device.revokedAt ? `revogado em ${device.revokedAt}` : `vale até ${new Date(device.expiresAt).toISOString()}`;
      console.log(`  ${device.deviceId}  ${device.label.padEnd(24)}  ${state}`);
    }
    return 0;
  }

  if (sub === 'enroll') {
    const label = typeof options.label === 'string' ? options.label : '';
    if (!label) {
      console.error('Informe --label "Windows do Caio": é como você reconhece o dispositivo na lista depois.');
      return 1;
    }
    const { status, body } = await ask(options, '/admin/invites', { method: 'POST', body: JSON.stringify({ label }) });
    if (status !== 201) { console.error(body.error ?? `o serviço respondeu ${status}`); return 1; }
    console.log(`\nConvite para "${body.label}":\n\n  ${body.invite}\n`);
    console.log(`Vale uma vez só, até ${new Date(body.expiresAt).toISOString()}.`);
    console.log('Passe por canal privado. Ele não é mostrado de novo.');
    return 0;
  }

  if (sub === 'revoke') {
    const id = positionals[1] ?? (typeof options.id === 'string' ? options.id : '');
    if (!id) {
      console.error('Informe o id do dispositivo: `tumacordctl devices revoke <id>`. Veja a lista com `tumacordctl devices list`.');
      return 1;
    }
    const reason = typeof options.reason === 'string' ? options.reason : 'revogado pelo dono';
    const { status, body } = await ask(options, `/admin/devices/${encodeURIComponent(id)}/revoke`, { method: 'POST', body: JSON.stringify({ reason }) });
    if (status !== 200) { console.error(body.error ?? `o serviço respondeu ${status}`); return 1; }
    console.log(`Dispositivo ${id} revogado. Ele para de baixar na hora, inclusive no meio de um download.`);
    return 0;
  }

  console.error(`Subcomando desconhecido: ${sub}. Use list, enroll ou revoke.`);
  return 1;
}

async function releasesCommand(positionals, options) {
  const sub = positionals[0] ?? '';

  if (sub === 'import') {
    const file = typeof options.manifest === 'string' ? options.manifest : '';
    if (!file) {
      console.error('Informe --manifest <arquivo.json>: o manifesto já assinado pelo ambiente de publicação.');
      return 1;
    }
    const contents = await readFile(path.resolve(file), 'utf8');
    const { status, body } = await ask(options, '/admin/manifest', { method: 'POST', body: contents });
    if (status !== 201) { console.error(`Manifesto recusado: ${body.error ?? status}`); return 1; }
    console.log(`Manifesto da release ${body.releaseId} importado e conferido.`);
    return 0;
  }

  if (sub === 'publish') {
    const file = typeof options.catalog === 'string' ? options.catalog : '';
    if (!file) {
      console.error('Informe --catalog <arquivo.json>: o catálogo já assinado.');
      return 1;
    }
    const contents = await readFile(path.resolve(file), 'utf8');
    const { status, body } = await ask(options, '/admin/catalog', { method: 'POST', body: contents });
    if (status !== 201) { console.error(`Catálogo recusado: ${body.error ?? status}`); return 1; }
    console.log(`Catálogo publicado na sequência ${body.sequence}. A partir de agora os aplicativos passam a ver isto.`);
    return 0;
  }

  if (sub === 'withdraw') {
    const releaseId = positionals[1] ?? (typeof options.release === 'string' ? options.release : '');
    const reason = typeof options.reason === 'string' ? options.reason : '';
    if (!releaseId || !reason) {
      console.error('Uso: tumacordctl releases withdraw <releaseId> --reason "o áudio sai errado no Windows"');
      console.error('O motivo não é enfeite: ele aparece na tela de quem tentar instalar.');
      return 1;
    }
    const { status, body } = await ask(options, '/admin/withdraw', {
      method: 'POST',
      body: JSON.stringify({ releaseId, reason, channel: options.channel ?? 'stable' }),
    });
    if (status !== 200) { console.error(body.error ?? `o serviço respondeu ${status}`); return 1; }
    console.log('O catálogo com a retirada está pronto para assinar. Ele NÃO foi publicado ainda:');
    console.log('este serviço não assina nada — a chave privada vive no ambiente de publicação.\n');
    console.log(JSON.stringify(body.toSign, null, 2));
    return 0;
  }

  if (sub === 'list') {
    console.error('`releases list` lê o catálogo pelo serviço público, com credencial de dispositivo.');
    console.error('Use `tumacordctl install show` para ver o que está instalado, ou consulte o painel do dono.');
    return 1;
  }

  console.error(`Subcomando desconhecido: ${sub || '(nenhum)'}. Use import, publish ou withdraw.`);
  return 1;
}

// ── Backup ──────────────────────────────────────────────────────────────────

async function backupCommand(options) {
  const choice = await selectedInstallation(options);
  if (!choice.ok) { console.error(choice.error); return choice.code; }

  const out = typeof options.out === 'string' ? options.out : '';
  if (!out) { console.error('Informe --out <diretório>: onde a cópia será escrita.'); return 1; }

  const result = await runBackup({
    installation: choice.installation,
    outputDir: out,
    token: ownerToken(options),
    report: ({ step, state, detail }) => {
      if (state === 'running') return;
      console.log(`  ${state === 'ok' ? '·' : '!'} ${step}${detail ? `: ${detail}` : ''}`);
    },
  });
  if (!result.ok) { console.error(`\n${result.error}`); return 1; }

  console.log(`\n${result.archive}`);
  console.log(`${result.archive}.sha256  (${result.sha256})\n`);
  console.log('Leve uma cópia para FORA desta máquina: uma cópia que mora na VPS não');
  console.log('protege contra a perda da VPS, que é justamente o caso em que se precisa dela.');
  return 0;
}

// ── Restauração ─────────────────────────────────────────────────────────────

async function restoreCommand(options) {
  const from = typeof options.from === 'string' ? options.from : '';
  if (!from) { console.error('Informe --from <arquivo.tar.gz>: a cópia a restaurar.'); return 1; }
  const archive = path.resolve(from);

  // A origem é conferida **antes** de qualquer coisa ser criada.
  try {
    const expected = (await readFile(`${archive}.sha256`, 'utf8')).trim().split(/\s+/)[0];
    const actual = await sha256OfFile(archive);
    if (expected && expected !== actual) {
      console.error(`A cópia não confere com o resumo guardado:\n  esperado ${expected}\n  lido     ${actual}`);
      console.error('NÃO restaure: use outra cópia.');
      return 1;
    }
    console.log(`· resumo confere (${actual})`);
  } catch {
    console.log('! sem arquivo `.sha256` ao lado: a integridade não pôde ser conferida antes.');
  }

  const rehearsal = rehearsalVolumeName();
  console.log(`· restaurando num volume de ensaio: ${rehearsal}`);
  const restored = await restoreToNewVolume({ archive, volume: rehearsal });
  if (!restored.ok) {
    console.error(restored.error);
    await dropVolume({ volume: rehearsal });
    return 1;
  }

  const identity = await installationIdOf({ volume: rehearsal });
  if (!identity.ok) {
    console.error(identity.error);
    await dropVolume({ volume: rehearsal });
    return 1;
  }
  console.log(`· a cópia é da instalação ${identity.installationId}`);

  // Compara com a instalação em uso, quando há uma. Restaurar a cópia de
  // **outra** instalação por cima desta é o erro que mais custa.
  const choice = await selectedInstallation(options);
  if (choice.ok) {
    const live = planBackup({ installation: choice.installation, outputDir: '/tmp' });
    if (live.ok) {
      const atual = await installationIdOf({ volume: live.volume });
      if (atual.ok && atual.installationId !== identity.installationId) {
        console.error(`\nPARE: a instalação em uso é ${atual.installationId} e esta cópia é ${identity.installationId}.`);
        console.error('Restaurar isto por cima trocaria os dados de uma instalação pelos de outra.');
        await dropVolume({ volume: rehearsal });
        return 1;
      }
      if (atual.ok) console.log(`· confere com a instalação em uso (${atual.installationId})`);
    }
  }

  console.log(`\nA cópia foi restaurada e validada no volume de ensaio \`${rehearsal}\`.`);
  console.log('Ela NÃO substituiu nada: substituir é uma decisão separada.\n');
  console.log('Para conferir por dentro, suba um servidor de teste contra ele — o');
  console.log('procedimento está em docs/backup-restore.md, seção 4.\n');
  console.log('Quando terminar o ensaio:');
  console.log(`  docker volume rm ${rehearsal}`);
  console.log('\nPara substituir os dados em uso, siga docs/backup-restore.md seção 5:');
  console.log('ele diz a perda potencial por extenso e pede confirmação explícita.');
  return 0;
}

// ── Trabalhos ───────────────────────────────────────────────────────────────

async function jobsCommand(positionals, options) {
  const sub = positionals[0] ?? 'status';
  const opened = await openJobStore(options);
  if (!opened.ok) { console.error(opened.error); return 1; }
  const { store } = opened;

  if (sub === 'status') {
    const id = positionals[1] ?? (typeof options.id === 'string' ? options.id : '');
    if (id) {
      const job = await store.read(id);
      if (!job) { console.error(`Não há trabalho ${id}.`); return 1; }
      if (options.json) { console.log(JSON.stringify(job, null, 2)); return 0; }
      console.log(`\n${job.kind}  ${job.id}`);
      console.log(`estado:   ${job.state}`);
      console.log(`criado:   ${job.createdAt}`);
      if (job.finishedAt) console.log(`terminou: ${job.finishedAt}`);
      if (job.error) console.log(`erro:     ${job.error}`);
      console.log('\netapas:');
      for (const step of job.steps) {
        const mark = step.state === 'failed' ? '×' : step.state === 'ok' ? '·' : step.state === 'skipped' ? '-' : '…';
        console.log(`  ${mark} ${step.name}${step.detail ? `: ${step.detail}` : ''}`);
      }
      return job.state === 'failed' ? 1 : 0;
    }
    const jobs = await store.list();
    if (options.json) { console.log(JSON.stringify(jobs, null, 2)); return 0; }
    if (!jobs.length) { console.log('Nenhum trabalho registrado.'); return 0; }
    for (const job of jobs.slice(0, 20)) {
      console.log(`  ${job.state.padEnd(10)} ${job.kind.padEnd(16)} ${job.id}  ${job.createdAt}`);
    }
    return 0;
  }

  if (sub === 'unlock') {
    if (!options['force-unlock']) {
      console.error('Liberar o lock exige --force-unlock: um lock órfão pode ser de um trabalho que parou no meio de uma migração,');
      console.error('e assumir que ele terminou é o jeito de rodar a migração duas vezes. Confira com `jobs status` antes.');
      return 1;
    }
    await store.releaseLock();
    console.log('Lock liberado.');
    return 0;
  }

  console.error(`Subcomando desconhecido: ${sub}. Use status ou unlock.`);
  return 1;
}

// ── Aplicar e voltar atrás ──────────────────────────────────────────────────

async function serverCommand(positionals, options) {
  const sub = positionals[0] ?? '';
  if (sub === 'apply') return applyCommand(options);
  if (sub === 'rollback') return rollbackCommand(options);
  console.error(`Subcomando desconhecido: ${sub || '(nenhum)'}. Use apply ou rollback.`);
  return 1;
}

async function applyCommand(options) {
  const choice = await selectedInstallation(options);
  if (!choice.ok) { console.error(choice.error); return choice.code; }
  const { installation } = choice;

  const ref = validateRef(options.ref);
  if (!ref.ok) { console.error(ref.error); return 1; }
  const releaseId = typeof options.release === 'string' ? options.release : '';
  if (!releaseId) { console.error('Informe --release <releaseId>: a aplicação usa uma release exata, e não uma branch.'); return 1; }
  const out = typeof options.out === 'string' ? options.out : '';
  if (!out && !options['no-backup']) {
    console.error('Informe --out <diretório> para a cópia que antecede a aplicação.');
    console.error('Voltar o código NÃO volta os dados: sem cópia, uma migração que dê errado não tem para onde voltar.');
    console.error('Se você já tem uma cópia conferida desta instalação, dispense com --no-backup — e isso fica registrado no trabalho.');
    return 1;
  }
  const channel = typeof options.channel === 'string' ? options.channel : 'stable';

  // A release precisa estar publicada no catálogo aprovado. Aplicar o que
  // ninguém revisou é exatamente o que esta conferência impede.
  const { status, body } = await ask(options, '/admin/catalog');
  if (status !== 200 || !body) { console.error('Não consegui ler o catálogo publicado para conferir a release.'); return 1; }
  const approved = releaseIsApproved(body, { releaseId, channel });
  if (!approved.ok) { console.error(approved.error); return 1; }

  const plan = planApply({ installation, ref: ref.ref, releaseId, version: approved.entry.version });
  console.log(`\nAplicar ${approved.entry.version} (${releaseId}) em "${plan.project}"\n`);
  for (const effect of plan.effects) console.log(`  · ${effect}`);
  console.log(`\netapas: ${plan.steps.join(' → ')}\n`);
  if (options['dry-run']) { console.log('--dry-run: nada foi feito.'); return 0; }

  const opened = await openJobStore(options);
  if (!opened.ok) { console.error(opened.error); return 1; }
  const { store } = opened;

  // O lock antes de qualquer trabalho: um duplo clique não lança dois deploys,
  // e a linha de comando não atropela o executor.
  const lock = store.acquireLock({ owner: `apply:${releaseId}` });
  if (!lock.ok) { console.error(lock.error); return 1; }

  try {
    const { job, created } = await store.create({
      kind: 'server-apply',
      key: `apply:${releaseId}:${ref.ref}`,
      input: { releaseId, ref: ref.ref, version: approved.entry.version, project: plan.project },
    });
    if (!created && job.state === 'succeeded') {
      console.log(`Esta release já foi aplicada pelo trabalho ${job.id}. Nada a fazer.`);
      return 0;
    }

    const result = await runApply({
      installation, releaseId, ref: ref.ref, version: approved.entry.version,
      store, job, stateDirectory: stateDir(options),
      backup: out ? { outputDir: out, token: ownerToken(options) } : 'skip',
      report: ({ step, state, detail }) => {
        if (state === 'running') return;
        console.log(`  ${state === 'ok' ? '·' : state === 'skipped' ? '-' : '×'} ${step}${detail ? `: ${detail}` : ''}`);
      },
    });

    if (!result.ok) {
      console.error(`\nFALHOU: ${result.error}`);
      console.error(`Trabalho ${result.job.id} — veja \`tumacordctl jobs status ${result.job.id}\`.`);
      console.error('O deployment anterior está registrado: `tumacordctl server rollback`.');
      return 1;
    }
    console.log(`\nAplicado. Trabalho ${result.job.id}.`);
    console.log(`  versão ${approved.entry.version}, commit ${result.commit.slice(0, 12)}`);
    console.log('\nA volta atrás está registrada: `tumacordctl server rollback`.');
    return 0;
  } finally {
    await store.releaseLock();
  }
}

async function rollbackCommand(options) {
  const choice = await selectedInstallation(options);
  if (!choice.ok) { console.error(choice.error); return choice.code; }
  const { installation } = choice;

  const registered = await previousDeployment(stateDir(options));
  if (!registered.ok) { console.error(registered.error); return 1; }

  const plan = planRollback({ installation, previous: registered.previous });
  console.log(`\nVoltar "${plan.project}" para ${plan.ref || plan.to} (${String(plan.to).slice(0, 12)})\n`);
  for (const effect of plan.effects) console.log(`  · ${effect}`);
  console.log('');
  if (options['dry-run']) { console.log('--dry-run: nada foi feito.'); return 0; }

  const opened = await openJobStore(options);
  if (!opened.ok) { console.error(opened.error); return 1; }
  const { store } = opened;
  const lock = store.acquireLock({ owner: 'rollback' });
  if (!lock.ok) { console.error(lock.error); return 1; }

  try {
    const { job } = await store.create({ kind: 'server-rollback', key: `rollback:${plan.to}`, input: { to: plan.to, project: plan.project } });
    const result = await runRollback({
      installation, previous: registered.previous, store, job,
      report: ({ step, state, detail }) => {
        if (state === 'running') return;
        console.log(`  ${state === 'ok' ? '·' : state === 'skipped' ? '-' : '×'} ${step}${detail ? `: ${detail}` : ''}`);
      },
    });
    if (!result.ok) {
      console.error(`\nFALHOU: ${result.error}`);
      console.error(`Trabalho ${result.job.id}. O procedimento manual está em docs/atualizacao-servidor.md.`);
      return 1;
    }
    console.log(`\nDe volta em ${result.health?.version ?? plan.ref}. Trabalho ${result.job.id}.`);
    console.log('\nVoltar o código NÃO volta os dados. Se a versão nova migrou o formato e esta');
    console.log('não sabe ler o que ela escreveu, restaure a cópia: docs/backup-restore.md.');
    return 0;
  } finally {
    await store.releaseLock();
  }
}

async function main(argv) {
  const { positionals, options } = parseArgs(argv);
  const command = positionals[0] ?? '';
  const rest = positionals.slice(1);

  // Pedir ajuda é sucesso. Sem comando nenhum e sem `--help`, a ajuda também
  // aparece, mas o código de saída é 1: quem chamou errou a invocação, e um
  // script encadeado precisa perceber isso.
  if (options.help) {
    console.log(COMMAND_HELP[command] ?? HELP);
    return 0;
  }
  if (!command) { console.log(HELP); return 1; }

  try {
    switch (command) {
      case 'doctor': return await doctorCommand(options);
      case 'install': return await installCommand(rest, options);
      case 'devices': return await devicesCommand(rest, options);
      case 'releases': return await releasesCommand(rest, options);
      case 'backup': return await backupCommand(options);
      case 'restore': return await restoreCommand(options);
      case 'jobs': return await jobsCommand(rest, options);
      case 'server': return await serverCommand(rest, options);
      case 'version': console.log(TOOL_VERSION); return 0;
      default: {
        console.error(`Comando desconhecido: ${command}\n`);
        console.log(HELP);
        return 1;
      }
    }
  } catch (error) {
    console.error(String(error?.message ?? error));
    return 1;
  }
}

export { COMMAND_HELP, HELP, main, parseArgs, serviceUrl };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

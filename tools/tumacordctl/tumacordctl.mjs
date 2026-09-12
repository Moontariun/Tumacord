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

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chooseInstallation, dataMount, discoverInstallations } from './lib/discovery.mjs';
import { preflight, preflightPorts } from './lib/preflight.mjs';

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
  restore: `tumacordctl restore — restaura uma cópia

USO
  tumacordctl restore --from <arquivo> --to <destino> [--verify]

ORDEM
  A restauração acontece primeiro num **destino separado** e é validada lá,
  antes de qualquer coisa substituir o que está em uso. Nunca há \`rm -rf\` sobre
  um caminho que não foi conferido.

PERDA POTENCIAL
  Restaurar dados devolve a instalação ao ponto da cópia. Tudo o que foi
  escrito depois dela — mensagens, contas, anexos — não está lá. O comando diz
  a data da cópia e pede confirmação explícita antes de substituir.
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

/**
 * O que ainda não existe, e o que ele faria.
 *
 * Dizer isto é melhor do que um comando que finge funcionar: um que responde
 * "ok" sem fazer nada é pior do que um que recusa.
 */
const NOT_IMPLEMENTED = {
  'server apply': 'aplicar uma release ao dedicado',
  'server rollback': 'voltar ao deployment anterior',
  backup: 'a cópia consistente',
  restore: 'a restauração',
  'jobs status': 'a lista de trabalhos',
};

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
      case 'version': console.log(TOOL_VERSION); return 0;
      default: {
        const key = rest.length ? `${command} ${rest[0]}` : command;
        if (NOT_IMPLEMENTED[key]) {
          // Dizer o que falta é melhor do que um comando que finge funcionar.
          console.error(`\`${key}\` ainda não está implementado nesta revisão: ${NOT_IMPLEMENTED[key]}.`);
          console.error('O procedimento manual equivalente está em docs/atualizacao-servidor.md e docs/backup-restore.md.');
          return 3;
        }
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

export { COMMAND_HELP, HELP, NOT_IMPLEMENTED, main, parseArgs, serviceUrl };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

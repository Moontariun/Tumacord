import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

// @ts-expect-error — módulo .mjs sem tipos, e é assim que o operador o usa.
import { chooseInstallation, dataMount, discoverInstallations } from '../tools/tumacordctl/lib/discovery.mjs';
// @ts-expect-error — idem.
import { preflight, preflightPorts, worstLevel } from '../tools/tumacordctl/lib/preflight.mjs';
// @ts-expect-error — idem.
import { COMMAND_HELP, HELP, parseArgs, serviceUrl } from '../tools/tumacordctl/tumacordctl.mjs';

// A descoberta da instalação, que é onde o guia antigo errava três vezes no
// mesmo lugar: escolhia "o primeiro volume que combina com a regex", presumia
// o nome `tumacord-data`, e seguia sem backup quando não achava nada.
//
// Aqui a descoberta é estruturada e a ambiguidade **para** a operação.

const CHAT_CONTAINER = {
  Id: 'abc123',
  Name: '/tumacord-server',
  Config: {
    Image: 'tumacord-tumacord-server',
    Labels: { 'com.docker.compose.project': 'tumacord', 'com.docker.compose.service': 'tumacord-server', 'com.docker.compose.project.working_dir': '/home/Tumacord' },
    Env: ['DATA_DIR=/data', 'SERVER_ACCESS_KEY=segredo-que-nao-pode-vazar', 'PORT=4600'],
  },
  State: { Status: 'running', Health: { Status: 'healthy' }, StartedAt: '2026-09-12T10:00:00Z' },
  Mounts: [{ Type: 'volume', Name: 'project-do-renan_tumacord-data', Source: '/var/lib/docker/volumes/project-do-renan_tumacord-data/_data', Destination: '/data', RW: true }],
  NetworkSettings: { Ports: { '4600/tcp': [{ HostIp: '0.0.0.0', HostPort: '4600' }] } },
};

/** Um `docker` fingido, que responde o que a máquina responderia. */
function fakeDocker(containers: Record<string, unknown>[]) {
  return async (command: string, args: string[]) => {
    if (command !== 'docker') return { ok: false, stdout: '', stderr: 'command inesperado' };
    if (args[0] === 'ps') {
      return { ok: true, stdout: containers.map((c) => JSON.stringify({ ID: (c as { Id: string }).Id })).join('\n'), stderr: '' };
    }
    if (args[0] === 'inspect') {
      const found = containers.find((c) => (c as { Id: string }).Id === args[1]);
      return found ? { ok: true, stdout: JSON.stringify([found]), stderr: '' } : { ok: false, stdout: '', stderr: 'no such object' };
    }
    return { ok: false, stdout: '', stderr: 'command inesperado' };
  };
}

// ── Descoberta ─────────────────────────────────────────────────────────────

test('a instalação é achada pelo rótulo do Compose, com qualquer nome de projeto', async () => {
  // O ponto: o nome do volume aqui é `projeto-do-renan_tumacord-data`, que
  // nenhuma regex por `tumacord-data` acharia como nome exato.
  const { ok, installations } = await discoverInstallations(fakeDocker([CHAT_CONTAINER]));
  assert.equal(ok, true);
  assert.equal(installations.length, 1);
  assert.equal(installations[0].project, 'tumacord');
  assert.equal(installations[0].directory, '/home/Tumacord');
  assert.equal(installations[0].services['tumacord-server'].status, 'running');
});

test('o volume de dados é o mount real em /data, e não um nome presumido', async () => {
  const { installations } = await discoverInstallations(fakeDocker([CHAT_CONTAINER]));
  const data = dataMount(installations[0].services['tumacord-server'], '/data');
  assert.equal(data.name, 'project-do-renan_tumacord-data');
  assert.equal(data.source, '/var/lib/docker/volumes/project-do-renan_tumacord-data/_data');
  assert.equal(data.writable, true);
});

test('os valores das variáveis nunca saem da descoberta', async () => {
  const { installations } = await discoverInstallations(fakeDocker([CHAT_CONTAINER]));
  const text = JSON.stringify(installations);
  // Um preflight que imprimisse a chave a vazaria no primeiro print.
  assert.equal(text.includes('segredo-que-nao-pode-vazar'), false);
  assert.deepEqual(installations[0].services['tumacord-server'].variables, ['DATA_DIR', 'PORT', 'SERVER_ACCESS_KEY']);
});

test('duas instalações param a operação em vez de virar sorteio', async () => {
  const secondInstallation = { ...CHAT_CONTAINER, Id: 'def456', Config: { ...CHAT_CONTAINER.Config, Labels: { ...CHAT_CONTAINER.Config.Labels, 'com.docker.compose.project': 'homologacao' } } };
  const { installations } = await discoverInstallations(fakeDocker([CHAT_CONTAINER, secondInstallation]));
  assert.equal(installations.length, 2);

  const choice = chooseInstallation(installations);
  assert.equal(choice.ok, false);
  assert.match(choice.error, /--project/);
  assert.match(choice.error, /perde dados/, 'o motivo da recusa é dito');

  // Com o projeto nomeado, segue.
  assert.equal(chooseInstallation(installations, 'homologacao').ok, true);
  assert.equal(chooseInstallation(installations, 'homologacao').installation.project, 'homologacao');
  // E um nome que não existe não vira "o primeiro que combina".
  assert.equal(chooseInstallation(installations, 'inventado').ok, false);
});

test('nenhuma instalação não é tratada como instalação vazia', async () => {
  const choice = chooseInstallation([]);
  assert.equal(choice.ok, false);
  assert.match(choice.error, /Não encontrei nenhuma instalação/);
});

test('contêineres de outros projetos não entram', async () => {
  const foreign = { ...CHAT_CONTAINER, Id: 'zzz', Config: { ...CHAT_CONTAINER.Config, Labels: { 'com.docker.compose.project': 'outra-coisa', 'com.docker.compose.service': 'postgres' } } };
  const { installations } = await discoverInstallations(fakeDocker([foreign]));
  assert.equal(installations.length, 0, 'só os serviços deste projeto');
});

// ── Preflight ──────────────────────────────────────────────────────────────

const healthyInstallation = {
  project: 'tumacord', directory: '/home/Tumacord',
  services: {
    'tumacord-server': {
      name: 'tumacord-server', status: 'running', health: 'healthy', image: 'x',
      mounts: [{ kind: 'volume', name: 'tumacord_tumacord-data', source: '/var/lib/docker/volumes/x/_data', destination: '/data', writable: true }],
      ports: [{ inside: '4600/tcp', host: '0.0.0.0:4600' }],
      variables: ['DATA_DIR', 'SERVER_ACCESS_KEY'],
    },
    'tumacord-updates': {
      name: 'tumacord-updates', status: 'running', health: '', image: 'y', mounts: [],
      ports: [{ inside: '4300/tcp', host: '127.0.0.1:4300' }, { inside: '4301/tcp', host: '127.0.0.1:4301' }],
      variables: ['TUMACORD_UPDATES_STATE_DIR'],
    },
  },
};

const roomySpace = async () => ({ ok: true, free: 50 * 1024 ** 3, total: 100 * 1024 ** 3 });
const goodPermissions = async () => ({ exists: true, readable: true, writable: true });
const baseOptions = { readFreeSpace: roomySpace, readPermissions: goodPermissions };

test('uma instalação saudável não impede nada', async () => {
  const result = await preflight(healthyInstallation, baseOptions);
  assert.equal(result.level, 'ok', JSON.stringify(result.checks.filter((c: { level: string }) => c.level !== 'ok')));
});

test('sem mount em /data, o preflight FALHA — não segue sem backup', async () => {
  // É exatamente o caso em que o guia antigo seguia adiante. Um backup que não
  // acontece só avisa na hora de restaurar.
  const withoutData = { ...healthyInstallation, services: { ...healthyInstallation.services, 'tumacord-server': { ...healthyInstallation.services['tumacord-server'], mounts: [] } } };
  const result = await preflight(withoutData, baseOptions);
  assert.equal(result.level, 'fail');
  const check = result.checks.find((item: { title: string }) => item.title === 'Volume de dados');
  assert.equal(check.level, 'fail');
  assert.match(check.howToFix, /só avisa na hora de restaurar/);
});

test('dois mounts em /data param a operação', async () => {
  const ambiguous = {
    ...healthyInstallation,
    services: {
      ...healthyInstallation.services,
      'tumacord-server': {
        ...healthyInstallation.services['tumacord-server'],
        mounts: [
          { kind: 'volume', name: 'a', source: '/a', destination: '/data', writable: true },
          { kind: 'bind', name: '', source: '/b', destination: '/data', writable: true },
        ],
      },
    },
  };
  const result = await preflight(ambiguous, baseOptions);
  assert.equal(result.level, 'fail');
  assert.match(result.checks.find((c: { title: string }) => c.title === 'Volume de dados').howToFix, /ambígua/);
});

test('dados montados somente para leitura é falha', async () => {
  const readOnly = {
    ...healthyInstallation,
    services: { ...healthyInstallation.services, 'tumacord-server': { ...healthyInstallation.services['tumacord-server'], mounts: [{ kind: 'volume', name: 'x', source: '/x', destination: '/data', writable: false }] } },
  };
  assert.equal((await preflight(readOnly, baseOptions)).level, 'fail');
});

test('disco sem espaço para o backup impede aplicar', async () => {
  // Aplicar sem espaço para o backup é aplicar sem backup.
  const tight = { ...baseOptions, readFreeSpace: async () => ({ ok: true, free: 100 * 1024 * 1024, total: 20 * 1024 ** 3 }) };
  const result = await preflight(healthyInstallation, tight);
  assert.equal(result.level, 'fail');
  const check = result.checks.find((item: { title: string }) => item.title === 'Espaço em disco');
  assert.match(check.howToFix, /backup/);
});

test('não conseguir medir o espaço vira aviso, e não "está tudo bem"', async () => {
  const blind = { ...baseOptions, readFreeSpace: async () => ({ ok: false, error: 'permissão negada' }) };
  const result = await preflight(healthyInstallation, blind);
  const check = result.checks.find((item: { title: string }) => item.title === 'Espaço em disco');
  assert.equal(check.level, 'warn');
  assert.match(check.detail, /permissão negada/);
});

test('a porta de administração publicada para fora é falha', async () => {
  const exposed = {
    ...healthyInstallation,
    services: {
      ...healthyInstallation.services,
      'tumacord-updates': { ...healthyInstallation.services['tumacord-updates'], ports: [{ inside: '4301/tcp', host: '0.0.0.0:4301' }] },
    },
  };
  const result = await preflight(exposed, baseOptions);
  assert.equal(result.level, 'fail');
  assert.match(result.checks.find((c: { title: string }) => c.title === 'Porta de administração').howToFix, /laço local/);
});

test('variável obrigatória ausente é falha, e o valor continua fora da saída', async () => {
  const withoutKey = {
    ...healthyInstallation,
    services: { ...healthyInstallation.services, 'tumacord-server': { ...healthyInstallation.services['tumacord-server'], variables: ['DATA_DIR'] } },
  };
  const result = await preflight(withoutKey, baseOptions);
  assert.equal(result.level, 'fail');
  const check = result.checks.find((item: { title: string }) => item.title === 'Configuração');
  assert.match(check.detail, /SERVER_ACCESS_KEY/, 'o nome que falta é dito');
});

test('o serviço de atualizações ausente é aviso, não falha', async () => {
  // Ele ainda não existe em toda instalação, e o caminho manual continua valendo.
  const withoutService = { ...healthyInstallation, services: { 'tumacord-server': healthyInstallation.services['tumacord-server'] } };
  const result = await preflight(withoutService, baseOptions);
  assert.equal(result.level, 'warn');
  assert.match(result.checks.find((c: { title: string }) => c.title === 'Serviço de atualizações').howToFix, /ponte manual/);
});

test('cada falha traz o que resolver', async () => {
  const broken = { ...healthyInstallation, services: { ...healthyInstallation.services, 'tumacord-server': { ...healthyInstallation.services['tumacord-server'], mounts: [], variables: [] } } };
  const result = await preflight(broken, baseOptions);
  for (const check of result.checks.filter((item: { level: string }) => item.level === 'fail')) {
    assert.ok(check.howToFix.length > 10, `"${check.title}" falha sem dizer o que fazer`);
  }
});

test('o pior nível é o que decide se a operação segue', () => {
  assert.equal(worstLevel([{ level: 'ok' }, { level: 'warn' }]), 'warn');
  assert.equal(worstLevel([{ level: 'ok' }, { level: 'fail' }, { level: 'warn' }]), 'fail');
  assert.equal(worstLevel([{ level: 'ok' }]), 'ok');
  assert.equal(worstLevel([]), 'ok');
});

test('portas ocupadas são detectadas, e o comando para descobrir quem as usa é dito', async () => {
  const result = await preflightPorts([4600, 4300], async (port: number) => port !== 4600);
  assert.equal(result.level, 'fail');
  const busy = result.checks.find((item: { title: string }) => item.title === 'Porta 4600');
  assert.equal(busy.level, 'fail');
  assert.match(busy.howToFix, /ss -ltnp/);
});

// ── A interface do comando ─────────────────────────────────────────────────

test('a ajuda cita os guias que existem, e os comandos que ela promete', () => {
  for (const command of ['doctor', 'install show', 'releases import', 'releases publish', 'devices enroll', 'devices revoke', 'backup', 'restore']) {
    assert.ok(HELP.includes(command), `\`${command}\` não aparece na ajuda`);
  }
  // Cada guia citado precisa existir de verdade — um link para nada é pior do
  // que nenhum link. Isto é o que impede a ajuda de prometer documentação que
  // ninguém escreveu, que é a reclamação que originou a revisão.
  const guides = [...new Set([...HELP.matchAll(/docs\/[a-z0-9-]+\.md/g)].map((found) => found[0]))];
  assert.ok(guides.length >= 4, 'a ajuda precisa apontar para onde o procedimento está');
  for (const guide of guides) {
    assert.ok(existsSync(new URL(`../${guide}`, import.meta.url)), `${guide} é citado no --help e não existe`);
  }
});

test('cada guia citado nas ajudas por comando também existe', () => {
  for (const [command, text] of Object.entries(COMMAND_HELP as Record<string, string>)) {
    for (const guide of [...text.matchAll(/docs\/[a-z0-9-]+\.md/g)].map((found) => found[0])) {
      assert.ok(existsSync(new URL(`../${guide}`, import.meta.url)), `${guide}, citado em \`${command} --help\`, não existe`);
    }
  }
});

test('todo comando anunciado na ajuda tem rota de verdade', () => {
  // Um comando que aparece no --help e cai em "Comando desconhecido" é pior do
  // que um que não aparece: quem leu a ajuda confiou nela.
  const source = readFileSync(new URL('../tools/tumacordctl/tumacordctl.mjs', import.meta.url), 'utf8');
  const section = HELP.slice(HELP.indexOf('COMANDOS'), HELP.indexOf('OPÇÕES GERAIS'));
  const announced = new Set(
    section.split('\n')
      .map((line) => /^ {2}([a-z]+)(?: [a-z]+)?\s{2,}/.exec(line)?.[1] ?? '')
      .filter(Boolean),
  );
  assert.ok(announced.size >= 6, `a ajuda anuncia poucos commands: ${[...announced].join(', ')}`);
  for (const command of announced) {
    assert.ok(source.includes(`case '${command}':`), `\`${command}\` está na ajuda e não tem case no switch`);
  }
});

test('o executor recusa referência que não é exata', async () => {
  // Uma branch muda de significado entre o momento em que a pessoa lê e o
  // momento em que o comando roda. Isso é recusa, e não aviso.
  const { validateRef } = await import('../tools/tumacordctl/lib/deploy.mjs');
  assert.equal(validateRef('main').ok, false);
  assert.equal(validateRef('0.9.9-1').ok, false, 'sem o v não é a etiqueta da convenção');
  assert.equal(validateRef('v0.9.9-1').ok, true);
  assert.equal(validateRef('a'.repeat(40)).ok, true);
  assert.equal(validateRef('a'.repeat(39)).ok, false);
});

test('cada comando com ajuda própria explica o que NÃO faz também', () => {
  assert.match(COMMAND_HELP.doctor, /Não muda nada/);
  assert.match(COMMAND_HELP.doctor, /não imprime valor/i);
  assert.match(COMMAND_HELP.backup, /para/i);
  // A garantia do restore é que ele não troca nada sozinho: ensaia num volume
  // novo e para por ali.
  assert.match(COMMAND_HELP.restore, /de ensaio/);
  assert.match(COMMAND_HELP.restore, /nunca substitui/);
  assert.match(COMMAND_HELP.restore, /perda/i);
  // E a aplicação precisa dizer que voltar o código não volta os dados.
  assert.match(COMMAND_HELP.server, /volta os dados/);
  assert.match(COMMAND_HELP.server, /branch é recusada/);
});

test('as opções são lidas sem shell e sem concatenação', () => {
  assert.deepEqual(parseArgs(['doctor', '--project', 'homologacao', '--json']), {
    positionals: ['doctor'], options: { project: 'homologacao', json: true },
  });
  assert.deepEqual(parseArgs(['devices', 'revoke', 'dev-1', '--reason', 'máquina perdida']), {
    positionals: ['devices', 'revoke', 'dev-1'], options: { reason: 'máquina perdida' },
  });
  // Uma opção sem valor não engole a próxima opção.
  assert.deepEqual(parseArgs(['doctor', '--json', '--project', 'x']).options, { json: true, project: 'x' });
});

test('o endereço do serviço precisa ser uma URL, e o padrão é o laço local', () => {
  assert.equal(serviceUrl({}), 'http://127.0.0.1:4301');
  assert.equal(serviceUrl({ service: 'http://127.0.0.1:9999' }), 'http://127.0.0.1:9999');
  // Nada de caminho, comando ou esquema estranho entrando por aqui.
  assert.throws(() => serviceUrl({ service: 'file:///etc/passwd' }), /URL http/);
  assert.throws(() => serviceUrl({ service: '; rm -rf /' }), /URL http/);
  assert.throws(() => serviceUrl({ service: 'não é url' }), /URL http/);
});

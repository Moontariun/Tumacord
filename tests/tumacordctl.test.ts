import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';

// @ts-expect-error — módulo .mjs sem tipos, e é assim que o operador o usa.
import { descobrirInstalacoes, escolherInstalacao, mountDeDados } from '../tools/tumacordctl/lib/descoberta.mjs';
// @ts-expect-error — idem.
import { piorNivel, preflight, preflightPortas } from '../tools/tumacordctl/lib/preflight.mjs';
// @ts-expect-error — idem.
import { AJUDA, AJUDA_COMANDO, NAO_IMPLEMENTADO, parseArgs, urlDoServico } from '../tools/tumacordctl/tumacordctl.mjs';

// A descoberta da instalação, que é onde o guia antigo errava três vezes no
// mesmo lugar: escolhia "o primeiro volume que combina com a regex", presumia
// o nome `tumacord-data`, e seguia sem backup quando não achava nada.
//
// Aqui a descoberta é estruturada e a ambiguidade **para** a operação.

const CONTÊINER_CHAT = {
  Id: 'abc123',
  Name: '/tumacord-server',
  Config: {
    Image: 'tumacord-tumacord-server',
    Labels: { 'com.docker.compose.project': 'tumacord', 'com.docker.compose.service': 'tumacord-server', 'com.docker.compose.project.working_dir': '/home/Tumacord' },
    Env: ['DATA_DIR=/data', 'SERVER_ACCESS_KEY=segredo-que-nao-pode-vazar', 'PORT=4600'],
  },
  State: { Status: 'running', Health: { Status: 'healthy' }, StartedAt: '2026-09-12T10:00:00Z' },
  Mounts: [{ Type: 'volume', Name: 'projeto-do-renan_tumacord-data', Source: '/var/lib/docker/volumes/projeto-do-renan_tumacord-data/_data', Destination: '/data', RW: true }],
  NetworkSettings: { Ports: { '4600/tcp': [{ HostIp: '0.0.0.0', HostPort: '4600' }] } },
};

/** Um `docker` fingido, que responde o que a máquina responderia. */
function dockerFingido(contêineres: Record<string, unknown>[]) {
  return async (comando: string, argumentos: string[]) => {
    if (comando !== 'docker') return { ok: false, stdout: '', stderr: 'comando inesperado' };
    if (argumentos[0] === 'ps') {
      return { ok: true, stdout: contêineres.map((c) => JSON.stringify({ ID: (c as { Id: string }).Id })).join('\n'), stderr: '' };
    }
    if (argumentos[0] === 'inspect') {
      const achado = contêineres.find((c) => (c as { Id: string }).Id === argumentos[1]);
      return achado ? { ok: true, stdout: JSON.stringify([achado]), stderr: '' } : { ok: false, stdout: '', stderr: 'no such object' };
    }
    return { ok: false, stdout: '', stderr: 'comando inesperado' };
  };
}

// ── Descoberta ─────────────────────────────────────────────────────────────

test('a instalação é achada pelo rótulo do Compose, com qualquer nome de projeto', async () => {
  // O ponto: o nome do volume aqui é `projeto-do-renan_tumacord-data`, que
  // nenhuma regex por `tumacord-data` acharia como nome exato.
  const { ok, instalacoes } = await descobrirInstalacoes(dockerFingido([CONTÊINER_CHAT]));
  assert.equal(ok, true);
  assert.equal(instalacoes.length, 1);
  assert.equal(instalacoes[0].projeto, 'tumacord');
  assert.equal(instalacoes[0].diretorio, '/home/Tumacord');
  assert.equal(instalacoes[0].servicos['tumacord-server'].estado, 'running');
});

test('o volume de dados é o mount real em /data, e não um nome presumido', async () => {
  const { instalacoes } = await descobrirInstalacoes(dockerFingido([CONTÊINER_CHAT]));
  const dados = mountDeDados(instalacoes[0].servicos['tumacord-server'], '/data');
  assert.equal(dados.nome, 'projeto-do-renan_tumacord-data');
  assert.equal(dados.origem, '/var/lib/docker/volumes/projeto-do-renan_tumacord-data/_data');
  assert.equal(dados.escrita, true);
});

test('os valores das variáveis nunca saem da descoberta', async () => {
  const { instalacoes } = await descobrirInstalacoes(dockerFingido([CONTÊINER_CHAT]));
  const texto = JSON.stringify(instalacoes);
  // Um preflight que imprimisse a chave a vazaria no primeiro print.
  assert.equal(texto.includes('segredo-que-nao-pode-vazar'), false);
  assert.deepEqual(instalacoes[0].servicos['tumacord-server'].variaveis, ['DATA_DIR', 'PORT', 'SERVER_ACCESS_KEY']);
});

test('duas instalações param a operação em vez de virar sorteio', async () => {
  const segunda = { ...CONTÊINER_CHAT, Id: 'def456', Config: { ...CONTÊINER_CHAT.Config, Labels: { ...CONTÊINER_CHAT.Config.Labels, 'com.docker.compose.project': 'homologacao' } } };
  const { instalacoes } = await descobrirInstalacoes(dockerFingido([CONTÊINER_CHAT, segunda]));
  assert.equal(instalacoes.length, 2);

  const escolha = escolherInstalacao(instalacoes);
  assert.equal(escolha.ok, false);
  assert.match(escolha.erro, /--projeto/);
  assert.match(escolha.erro, /perde dados/, 'o motivo da recusa é dito');

  // Com o projeto nomeado, segue.
  assert.equal(escolherInstalacao(instalacoes, 'homologacao').ok, true);
  assert.equal(escolherInstalacao(instalacoes, 'homologacao').instalacao.projeto, 'homologacao');
  // E um nome que não existe não vira "o primeiro que combina".
  assert.equal(escolherInstalacao(instalacoes, 'inventado').ok, false);
});

test('nenhuma instalação não é tratada como instalação vazia', async () => {
  const escolha = escolherInstalacao([]);
  assert.equal(escolha.ok, false);
  assert.match(escolha.erro, /Não encontrei nenhuma instalação/);
});

test('contêineres de outros projetos não entram', async () => {
  const alheio = { ...CONTÊINER_CHAT, Id: 'zzz', Config: { ...CONTÊINER_CHAT.Config, Labels: { 'com.docker.compose.project': 'outra-coisa', 'com.docker.compose.service': 'postgres' } } };
  const { instalacoes } = await descobrirInstalacoes(dockerFingido([alheio]));
  assert.equal(instalacoes.length, 0, 'só os serviços deste projeto');
});

// ── Preflight ──────────────────────────────────────────────────────────────

const instalacaoSaudavel = {
  projeto: 'tumacord', diretorio: '/home/Tumacord',
  servicos: {
    'tumacord-server': {
      nome: 'tumacord-server', estado: 'running', saude: 'healthy', imagem: 'x',
      mounts: [{ tipo: 'volume', nome: 'tumacord_tumacord-data', origem: '/var/lib/docker/volumes/x/_data', destino: '/data', escrita: true }],
      portas: [{ interna: '4600/tcp', host: '0.0.0.0:4600' }],
      variaveis: ['DATA_DIR', 'SERVER_ACCESS_KEY'],
    },
    'tumacord-atualizacoes': {
      nome: 'tumacord-atualizacoes', estado: 'running', saude: '', imagem: 'y', mounts: [],
      portas: [{ interna: '4300/tcp', host: '127.0.0.1:4300' }, { interna: '4301/tcp', host: '127.0.0.1:4301' }],
      variaveis: ['TUMACORD_UPDATES_STATE_DIR'],
    },
  },
};

const espacoFolgado = async () => ({ ok: true, livre: 50 * 1024 ** 3, total: 100 * 1024 ** 3 });
const permissoesBoas = async () => ({ existe: true, leitura: true, escrita: true });
const opcoesBase = { lerEspaco: espacoFolgado, lerPermissoes: permissoesBoas };

test('uma instalação saudável não impede nada', async () => {
  const resultado = await preflight(instalacaoSaudavel, opcoesBase);
  assert.equal(resultado.nivel, 'ok', JSON.stringify(resultado.checks.filter((c: { nivel: string }) => c.nivel !== 'ok')));
});

test('sem mount em /data, o preflight FALHA — não segue sem backup', async () => {
  // É exatamente o caso em que o guia antigo seguia adiante. Um backup que não
  // acontece só avisa na hora de restaurar.
  const semDados = { ...instalacaoSaudavel, servicos: { ...instalacaoSaudavel.servicos, 'tumacord-server': { ...instalacaoSaudavel.servicos['tumacord-server'], mounts: [] } } };
  const resultado = await preflight(semDados, opcoesBase);
  assert.equal(resultado.nivel, 'falha');
  const check = resultado.checks.find((item: { titulo: string }) => item.titulo === 'Volume de dados');
  assert.equal(check.nivel, 'falha');
  assert.match(check.comoResolver, /só avisa na hora de restaurar/);
});

test('dois mounts em /data param a operação', async () => {
  const ambiguo = {
    ...instalacaoSaudavel,
    servicos: {
      ...instalacaoSaudavel.servicos,
      'tumacord-server': {
        ...instalacaoSaudavel.servicos['tumacord-server'],
        mounts: [
          { tipo: 'volume', nome: 'a', origem: '/a', destino: '/data', escrita: true },
          { tipo: 'bind', nome: '', origem: '/b', destino: '/data', escrita: true },
        ],
      },
    },
  };
  const resultado = await preflight(ambiguo, opcoesBase);
  assert.equal(resultado.nivel, 'falha');
  assert.match(resultado.checks.find((c: { titulo: string }) => c.titulo === 'Volume de dados').comoResolver, /ambígua/);
});

test('dados montados somente para leitura é falha', async () => {
  const somenteLeitura = {
    ...instalacaoSaudavel,
    servicos: { ...instalacaoSaudavel.servicos, 'tumacord-server': { ...instalacaoSaudavel.servicos['tumacord-server'], mounts: [{ tipo: 'volume', nome: 'x', origem: '/x', destino: '/data', escrita: false }] } },
  };
  assert.equal((await preflight(somenteLeitura, opcoesBase)).nivel, 'falha');
});

test('disco sem espaço para o backup impede aplicar', async () => {
  // Aplicar sem espaço para o backup é aplicar sem backup.
  const apertado = { ...opcoesBase, lerEspaco: async () => ({ ok: true, livre: 100 * 1024 * 1024, total: 20 * 1024 ** 3 }) };
  const resultado = await preflight(instalacaoSaudavel, apertado);
  assert.equal(resultado.nivel, 'falha');
  const check = resultado.checks.find((item: { titulo: string }) => item.titulo === 'Espaço em disco');
  assert.match(check.comoResolver, /backup/);
});

test('não conseguir medir o espaço vira aviso, e não "está tudo bem"', async () => {
  const cego = { ...opcoesBase, lerEspaco: async () => ({ ok: false, erro: 'permissão negada' }) };
  const resultado = await preflight(instalacaoSaudavel, cego);
  const check = resultado.checks.find((item: { titulo: string }) => item.titulo === 'Espaço em disco');
  assert.equal(check.nivel, 'aviso');
  assert.match(check.detalhe, /permissão negada/);
});

test('a porta de administração publicada para fora é falha', async () => {
  const exposto = {
    ...instalacaoSaudavel,
    servicos: {
      ...instalacaoSaudavel.servicos,
      'tumacord-atualizacoes': { ...instalacaoSaudavel.servicos['tumacord-atualizacoes'], portas: [{ interna: '4301/tcp', host: '0.0.0.0:4301' }] },
    },
  };
  const resultado = await preflight(exposto, opcoesBase);
  assert.equal(resultado.nivel, 'falha');
  assert.match(resultado.checks.find((c: { titulo: string }) => c.titulo === 'Porta de administração').comoResolver, /laço local/);
});

test('variável obrigatória ausente é falha, e o valor continua fora da saída', async () => {
  const semChave = {
    ...instalacaoSaudavel,
    servicos: { ...instalacaoSaudavel.servicos, 'tumacord-server': { ...instalacaoSaudavel.servicos['tumacord-server'], variaveis: ['DATA_DIR'] } },
  };
  const resultado = await preflight(semChave, opcoesBase);
  assert.equal(resultado.nivel, 'falha');
  const check = resultado.checks.find((item: { titulo: string }) => item.titulo === 'Configuração');
  assert.match(check.detalhe, /SERVER_ACCESS_KEY/, 'o nome que falta é dito');
});

test('o serviço de atualizações ausente é aviso, não falha', async () => {
  // Ele ainda não existe em toda instalação, e o caminho manual continua valendo.
  const semServico = { ...instalacaoSaudavel, servicos: { 'tumacord-server': instalacaoSaudavel.servicos['tumacord-server'] } };
  const resultado = await preflight(semServico, opcoesBase);
  assert.equal(resultado.nivel, 'aviso');
  assert.match(resultado.checks.find((c: { titulo: string }) => c.titulo === 'Serviço de atualizações').comoResolver, /ponte manual/);
});

test('cada falha traz o que resolver', async () => {
  const ruim = { ...instalacaoSaudavel, servicos: { ...instalacaoSaudavel.servicos, 'tumacord-server': { ...instalacaoSaudavel.servicos['tumacord-server'], mounts: [], variaveis: [] } } };
  const resultado = await preflight(ruim, opcoesBase);
  for (const check of resultado.checks.filter((item: { nivel: string }) => item.nivel === 'falha')) {
    assert.ok(check.comoResolver.length > 10, `"${check.titulo}" falha sem dizer o que fazer`);
  }
});

test('o pior nível é o que decide se a operação segue', () => {
  assert.equal(piorNivel([{ nivel: 'ok' }, { nivel: 'aviso' }]), 'aviso');
  assert.equal(piorNivel([{ nivel: 'ok' }, { nivel: 'falha' }, { nivel: 'aviso' }]), 'falha');
  assert.equal(piorNivel([{ nivel: 'ok' }]), 'ok');
  assert.equal(piorNivel([]), 'ok');
});

test('portas ocupadas são detectadas, e o comando para descobrir quem as usa é dito', async () => {
  const resultado = await preflightPortas([4600, 4300], async (porta: number) => porta !== 4600);
  assert.equal(resultado.nivel, 'falha');
  const ocupada = resultado.checks.find((item: { titulo: string }) => item.titulo === 'Porta 4600');
  assert.equal(ocupada.nivel, 'falha');
  assert.match(ocupada.comoResolver, /ss -ltnp/);
});

// ── A interface do comando ─────────────────────────────────────────────────

test('a ajuda cita os guias que existem, e os comandos que ela promete', () => {
  for (const comando of ['doctor', 'instalacao', 'releases importar', 'releases publicar', 'devices convidar', 'devices revogar', 'backup', 'restore']) {
    assert.ok(AJUDA.includes(comando), `\`${comando}\` não aparece na ajuda`);
  }
  // Cada guia citado precisa existir de verdade — um link para nada é pior do
  // que nenhum link. Isto é o que impede a ajuda de prometer documentação que
  // ninguém escreveu, que é a reclamação que originou a revisão.
  const guias = [...new Set([...AJUDA.matchAll(/docs\/[a-z0-9-]+\.md/g)].map((achado) => achado[0]))];
  assert.ok(guias.length >= 4, 'a ajuda precisa apontar para onde o procedimento está');
  for (const guia of guias) {
    assert.ok(existsSync(new URL(`../${guia}`, import.meta.url)), `${guia} é citado no --help e não existe`);
  }
});

test('cada guia citado nas ajudas por comando também existe', () => {
  for (const [comando, texto] of Object.entries(AJUDA_COMANDO as Record<string, string>)) {
    for (const guia of [...texto.matchAll(/docs\/[a-z0-9-]+\.md/g)].map((achado) => achado[0])) {
      assert.ok(existsSync(new URL(`../${guia}`, import.meta.url)), `${guia}, citado em \`${comando} --help\`, não existe`);
    }
  }
});

test('o que ainda não está implementado é dito, e não finge funcionar', () => {
  // Um comando que responde "ok" sem fazer nada é pior do que um que recusa.
  for (const [comando, descricao] of Object.entries(NAO_IMPLEMENTADO as Record<string, string>)) {
    assert.ok(descricao.length > 5, comando);
    assert.ok(AJUDA.includes(comando.split(' ')[0]), `${comando} sumiu da ajuda`);
  }
});

test('cada comando com ajuda própria explica o que NÃO faz também', () => {
  assert.match(AJUDA_COMANDO.doctor, /Não muda nada/);
  assert.match(AJUDA_COMANDO.doctor, /não imprime valor/i);
  assert.match(AJUDA_COMANDO.backup, /para/i);
  assert.match(AJUDA_COMANDO.restore, /destino separado/);
  assert.match(AJUDA_COMANDO.restore, /perda/i);
});

test('as opções são lidas sem shell e sem concatenação', () => {
  assert.deepEqual(parseArgs(['doctor', '--projeto', 'homologacao', '--json']), {
    posicionais: ['doctor'], opcoes: { projeto: 'homologacao', json: true },
  });
  assert.deepEqual(parseArgs(['devices', 'revogar', 'dev-1', '--motivo', 'máquina perdida']), {
    posicionais: ['devices', 'revogar', 'dev-1'], opcoes: { motivo: 'máquina perdida' },
  });
  // Uma opção sem valor não engole a próxima opção.
  assert.deepEqual(parseArgs(['doctor', '--json', '--projeto', 'x']).opcoes, { json: true, projeto: 'x' });
});

test('o endereço do serviço precisa ser uma URL, e o padrão é o laço local', () => {
  assert.equal(urlDoServico({}), 'http://127.0.0.1:4301');
  assert.equal(urlDoServico({ servico: 'http://127.0.0.1:9999' }), 'http://127.0.0.1:9999');
  // Nada de caminho, comando ou esquema estranho entrando por aqui.
  assert.throws(() => urlDoServico({ servico: 'file:///etc/passwd' }), /URL http/);
  assert.throws(() => urlDoServico({ servico: '; rm -rf /' }), /URL http/);
  assert.throws(() => urlDoServico({ servico: 'não é url' }), /URL http/);
});

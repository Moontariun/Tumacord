import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(projectRoot, 'scripts');
// Os testes rodam com um PATH montado à mão para simular cada distribuição, e
// nesse PATH o próprio bash não existe: ele precisa ser chamado pelo caminho.
const BASH = ['/usr/bin/bash', '/bin/bash', '/usr/local/bin/bash'].find((candidate) => existsSync(candidate)) ?? 'bash';
const DIRNAME = ['/usr/bin/dirname', '/bin/dirname'].find((candidate) => existsSync(candidate)) ?? '';

const SHELL_SCRIPTS = [
  'install-linux.sh',
  'install-cachyos.sh',
  'install-from-github.sh',
  'install-v0.8.1.sh',
  'install-v0.8.2.sh',
  'update-server.sh',
  'uninstall-linux.sh',
  'uninstall-cachyos.sh',
];

test('todo script de instalação passa na checagem de sintaxe do bash', () => {
  for (const script of SHELL_SCRIPTS) {
    assert.doesNotThrow(() => execFileSync(BASH, ['-n', path.join(scripts, script)]), `sintaxe inválida em ${script}`);
  }
});

// A 0.7.8 recusava qualquer distribuição sem `pacman` na primeira linha, e era
// exatamente isso que fazia o comando do README falhar no Fedora. Este teste
// executa a parte de tradução de pacotes do instalador com um PATH controlado,
// em que só existe o gerenciador que estamos simulando.
function packagesFor(manager: string, requirements: string[]): string[] {
  const directory = mkdtempSync(path.join(tmpdir(), 'tumacord-installer-'));
  try {
    const binary = path.join(directory, manager);
    writeFileSync(binary, '#!/bin/sh\nexit 0\n', 'utf8');
    chmodSync(binary, 0o755);
    const installer = readFileSync(path.join(scripts, 'install-linux.sh'), 'utf8');
    // Roda só até a definição de `package_for`: o resto do script compila e
    // instala o aplicativo, o que não cabe em um teste.
    const preamble = installer.slice(0, installer.indexOf('# Bibliotecas que o Electron carrega'));
    const probe = `${preamble}\nprintf '%s\\n' "$package_manager"\nfor requirement in ${requirements.join(' ')}; do package_for "$requirement"; done\n`;
    const output = execFileSync(BASH, ['-c', probe], {
      env: { PATH: directory, HOME: directory },
      encoding: 'utf8',
    });
    return output.trim().split('\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('no Fedora o instalador escolhe dnf e os pacotes de lá', () => {
  const [manager, ...packages] = packagesFor('dnf', ['node', 'npm', 'pactl', 'pipewire-tools', 'git', 'xdg-user-dir']);
  assert.equal(manager, 'dnf');
  assert.deepEqual(packages, ['nodejs', 'npm', 'pulseaudio-utils', 'pipewire-utils', 'git', 'xdg-user-dirs']);
});

test('o dnf5 é preferido quando existe, sem mudar os nomes dos pacotes', () => {
  const [manager, ...packages] = packagesFor('dnf5', ['node', 'pactl', 'pipewire-tools']);
  assert.equal(manager, 'dnf5');
  assert.deepEqual(packages, ['nodejs', 'pulseaudio-utils', 'pipewire-utils']);
});

test('CachyOS/Arch continua com os nomes que a 0.7.8 já usava', () => {
  const [manager, ...packages] = packagesFor('pacman', ['node', 'npm', 'pactl', 'pipewire-tools']);
  assert.equal(manager, 'pacman');
  assert.deepEqual(packages, ['nodejs', 'npm', 'libpulse', 'pipewire-audio']);
});

test('Debian/Ubuntu e openSUSE têm o pw-link no pacote certo de cada um', () => {
  assert.deepEqual(packagesFor('apt-get', ['pactl', 'pipewire-tools']), ['apt-get', 'pulseaudio-utils', 'pipewire-bin']);
  assert.deepEqual(packagesFor('zypper', ['pactl', 'pipewire-tools']), ['zypper', 'pulseaudio-utils', 'pipewire-tools']);
});

test('sem nenhum gerenciador conhecido o instalador explica o que instalar à mão', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'tumacord-installer-'));
  try {
    // O PATH leva só o `dirname`, que o script usa para se localizar: nenhum
    // gerenciador de pacotes é visível, que é a situação sob teste.
    if (DIRNAME) symlinkSync(DIRNAME, path.join(directory, 'dirname'));
    let failed = false;
    let message = '';
    try {
      execFileSync(BASH, [path.join(scripts, 'install-linux.sh')], { env: { PATH: directory, HOME: directory }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      failed = true;
      message = String((error as { stderr?: string }).stderr ?? '');
    }
    assert.equal(failed, true);
    assert.match(message, /gerenciador de pacotes/);
    assert.match(message, /pw-link/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('o instalador da versão aponta para a branch da 0.8.0', () => {
  const bootstrap = readFileSync(path.join(scripts, 'install-v0.8.1.sh'), 'utf8');
  assert.match(bootstrap, /branch="release\/stability-and-admin-v0\.8\.1"/);
  assert.match(bootstrap, /install-from-github\.sh/);
});

test('o instalador da 0.8.2 aponta para a branch da 0.8.2', () => {
  const bootstrap = readFileSync(path.join(scripts, 'install-v0.8.2.sh'), 'utf8');
  assert.match(bootstrap, /branch="release\/turn-opt-in-v0\.8\.2"/);
  assert.match(bootstrap, /install-from-github\.sh/);
});

// Um comando de instalação que aponta para a versão anterior é pior do que um
// comando quebrado: ele funciona, e instala a coisa errada em silêncio. Foi o
// que houve na 0.8.2 — o `install-v0.8.2.sh` foi criado e o README continuou
// mandando copiar o da 0.8.1, enquanto `update-server.sh` sem argumento
// rebaixava o servidor para a versão com o relay em laço de reinício.
//
// A versão vem do package.json de propósito: um `npm version` sozinho passa a
// reprovar aqui até que README, instalador e atualizador acompanhem.
test('README, instalador e atualizador seguem a versão do package.json', () => {
  const { version } = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as { version: string };
  const instalador = `install-v${version}.sh`;
  const bootstrap = readFileSync(path.join(scripts, instalador), 'utf8');
  const branch = /branch="([^"]+)"/.exec(bootstrap)?.[1];
  assert.ok(branch, `${instalador} precisa declarar a branch que instala`);

  const readme = readFileSync(path.join(projectRoot, 'README.md'), 'utf8');
  const citados = [...new Set([...readme.matchAll(/install-v(\d+\.\d+\.\d+)\.sh/g)].map((achado) => achado[1]))];
  assert.deepEqual(citados, [version], 'o README não pode mandar copiar instalador de outra versão');
  assert.ok(readme.includes(`/${branch}/scripts/${instalador}`), `o README precisa apontar ${instalador} na branch ${branch}`);
  assert.ok(readme.includes(`/${branch}/scripts/install-from-github.sh`), `o instalador genérico do README precisa vir da branch ${branch}`);

  const atualizador = readFileSync(path.join(scripts, 'update-server.sh'), 'utf8');
  assert.ok(atualizador.includes(`\${1:-${branch}}`), `update-server.sh sem argumento precisa ir para ${branch}, não para uma versão anterior`);
});

test('o bootstrap do GitHub prefere o instalador novo e mantém o nome antigo como reserva', () => {
  const bootstrap = readFileSync(path.join(scripts, 'install-from-github.sh'), 'utf8');
  assert.match(bootstrap, /installer="\$source_directory\/scripts\/install-linux\.sh"/);
  assert.match(bootstrap, /install-cachyos\.sh/);
  assert.match(bootstrap, /dnf install --assumeyes git/);
});

// A numeração do coturn saltou de 4.5 para 4.17, e uma tag inventada só
// aparece na hora do `docker compose up`, na máquina de quem for hospedar.
test('a imagem do relay usa uma tag que existe de verdade', () => {
  const compose = readFileSync(path.join(projectRoot, 'docker-compose.yml'), 'utf8');
  const imagem = /image:\s*(coturn\/coturn:\S+)/.exec(compose)?.[1];
  assert.ok(imagem, 'o serviço de relay precisa declarar uma imagem');
  assert.match(imagem!, /^coturn\/coturn:(?:4\.\d+|4|latest|alpine)(?:\.\d+)?-?alpine\d*(?:\.\d+)?$/, `tag suspeita: ${imagem}`);
  assert.equal(imagem, 'coturn/coturn:4.17-alpine');
});


// Uma opção que o turnserver não reconhece não é ignorada: ele imprime o help
// e sai com 255, e o `restart: unless-stopped` transforma isso em laço de
// reinício. Foi assim que `--no-loopback-peers` — removido do coturn, que hoje
// nega loopback por padrão e só aceita `--allow-loopback-peers` — deixou o
// relay fora do ar sem ninguém perceber. As depreciadas entram na mesma lista
// porque é de onde as removidas vêm.
test('o relay não passa ao coturn nenhuma opção removida ou depreciada', () => {
  const compose = readFileSync(path.join(projectRoot, 'docker-compose.yml'), 'utf8');
  const comandos = compose
    .split('\n')
    .map((linha) => /^\s+- (--[a-z0-9-]+)/.exec(linha)?.[1])
    .filter((flag): flag is string => Boolean(flag));
  assert.ok(comandos.includes('--no-multicast-peers'), 'a proibição de multicast continua valendo e precisa continuar aqui');
  for (const proibida of ['--no-loopback-peers', '--no-cli', '--no-dtls']) {
    assert.equal(comandos.includes(proibida), false, `${proibida} não existe mais no coturn 4.17`);
  }
});

// O Compose interpola o arquivo inteiro antes de olhar para os perfis. Uma
// variável obrigatória dentro do serviço de relay derrubava o `up` de quem
// nunca pediu relay nenhum.
test('subir só o servidor não exige as variáveis do relay', () => {
  const compose = readFileSync(path.join(projectRoot, 'docker-compose.yml'), 'utf8');
  const obrigatorias = compose.match(/\$\{TUMACORD_TURN_[A-Z_]+:\?/g) ?? [];
  assert.deepEqual(obrigatorias, [], 'as variáveis de TURN não podem usar `:?`');
});

// Uma atualização que apaga dados é pior do que uma que não acontece.
test('o script de atualização nunca remove volumes nem descarta alteração local', () => {
  const bruto = readFileSync(path.join(scripts, 'update-server.sh'), 'utf8');
  // Só o que é executável. O próprio script explica em comentário que jamais
  // usa `down -v`, e ler a explicação como se fosse comando reprovaria a
  // documentação em vez do comportamento.
  const script = bruto.split('\n').filter((linha) => !/^\s*#/.test(linha)).join('\n');
  assert.equal(/down\s+(-v|--volumes)/.test(script), false, '`down -v` apagaria contas e mensagens');
  assert.equal(/git\s+(reset\s+--hard|checkout\s+--force|clean\s+-[a-z]*f)/.test(script), false, 'não pode descartar alteração local do operador');
  assert.match(script, /git status --porcelain/, 'precisa detectar alteração local antes de mexer');
  assert.match(script, /tar czf/, 'precisa fazer backup antes de atualizar');
  assert.match(script, /api\/health/, 'precisa conferir se o servidor respondeu depois');
  assert.match(bruto, /down -v/, 'e o script precisa explicar por que não usa isso');
});

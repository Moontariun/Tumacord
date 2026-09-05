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
  'install-v0.7.11.sh',
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

test('o instalador da versão aponta para a branch da 0.7.11', () => {
  const bootstrap = readFileSync(path.join(scripts, 'install-v0.7.11.sh'), 'utf8');
  assert.match(bootstrap, /branch="release\/clipboard-and-invite-v0\.7\.11"/);
  assert.match(bootstrap, /install-from-github\.sh/);
});

test('o bootstrap do GitHub prefere o instalador novo e mantém o nome antigo como reserva', () => {
  const bootstrap = readFileSync(path.join(scripts, 'install-from-github.sh'), 'utf8');
  assert.match(bootstrap, /installer="\$source_directory\/scripts\/install-linux\.sh"/);
  assert.match(bootstrap, /install-cachyos\.sh/);
  assert.match(bootstrap, /dnf install --assumeyes git/);
});

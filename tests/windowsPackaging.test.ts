import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
  version: string;
  scripts: Record<string, string>;
  build: {
    productName: string;
    copyright?: string;
    win: {
      target: Array<{ target: string; arch: string[] }>;
      icon: string;
      signtoolOptions?: { publisherName?: string };
      extraResources: Array<{ from: string; to: string }>;
    };
    nsis: Record<string, unknown>;
    portable: Record<string, unknown>;
    linux: Record<string, unknown>;
  };
};

// A distribuição do Windows deixou de ser só um portable. Um instalador de
// verdade é o que registra o aplicativo em "Aplicativos instalados", cria os
// atalhos, desinstala e deixa os dados do usuário no lugar.
test('o Windows gera instalador NSIS e portable, os dois em x64', () => {
  const targets = manifest.build.win.target;
  const nsis = targets.find((entry) => entry.target === 'nsis');
  const portable = targets.find((entry) => entry.target === 'portable');
  assert.ok(nsis, 'o Setup NSIS precisa existir');
  assert.ok(portable, 'o portable continua como alternativa');
  assert.deepEqual(nsis!.arch, ['x64']);
  assert.deepEqual(portable!.arch, ['x64']);
});

test('cada alvo do Windows tem o próprio nome de arquivo, com a versão', () => {
  assert.equal(manifest.build.nsis.artifactName, 'Tumacord-${version}-Setup.${ext}');
  assert.equal(manifest.build.portable.artifactName, 'Tumacord-${version}-portable.${ext}');
});

// Um `.ico` com vários tamanhos é o que evita o ícone borrado na barra de
// tarefas e na lista de aplicativos instalados.
test('o ícone do Windows é um .ico multirresolução versionado', () => {
  assert.equal(manifest.build.win.icon, 'assets/tumacord.ico');
  const icon = readFileSync(path.join(projectRoot, 'assets', 'tumacord.ico'));
  assert.equal(icon.readUInt16LE(0), 0, 'campo reservado do cabeçalho ICO');
  assert.equal(icon.readUInt16LE(2), 1, 'o tipo precisa ser ícone, não cursor');
  const count = icon.readUInt16LE(4);
  assert.ok(count >= 5, `esperado ao menos cinco tamanhos, veio ${count}`);
  const sizes = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    const entry = 6 + index * 16;
    sizes.add(icon[entry] === 0 ? 256 : icon[entry]);
    const length = icon.readUInt32LE(entry + 8);
    const offset = icon.readUInt32LE(entry + 12);
    assert.ok(offset + length <= icon.length, 'cada imagem precisa caber no arquivo');
  }
  for (const required of [16, 32, 48, 256]) {
    assert.ok(sizes.has(required), `falta o tamanho ${required}px, que o Windows pede`);
  }
});

// Sem o helper dentro do pacote, a transmissão com áudio não existe na máquina
// de quem instalou — e o defeito só apareceria depois da instalação.
test('o componente nativo de áudio entra no pacote em um caminho fixo', () => {
  const [resource] = manifest.build.win.extraResources;
  assert.ok(resource, 'o helper precisa ser empacotado');
  assert.equal(resource.from, 'native/windows/audio-helper/build/tumacord-audio-helper.exe');
  assert.equal(resource.to, 'audio-helper/tumacord-audio-helper.exe');
  const router = readFileSync(path.join(projectRoot, 'desktop', 'windows-audio-router.cjs'), 'utf8');
  assert.match(router, /process\.resourcesPath, 'audio-helper', HELPER_NAME/, 'o roteador precisa procurar exatamente onde o empacotador põe');
});

test('o empacotamento do Windows compila o componente nativo antes do instalador', () => {
  assert.match(manifest.scripts['package:windows'], /build:native:win/);
  assert.match(manifest.scripts['build:native:win'], /native\/windows\/audio-helper\/build\.ps1/);
  assert.ok(existsSync(path.join(projectRoot, 'native', 'windows', 'audio-helper', 'build.ps1')));
  assert.ok(existsSync(path.join(projectRoot, 'native', 'windows', 'audio-helper', 'main.cpp')));
});

// Uma atualização que apaga a conta e as mensagens de quem instalou é pior do
// que uma atualização que não acontece.
test('a atualização preserva os dados e a desinstalação é oferecida', () => {
  assert.equal(manifest.build.nsis.deleteAppDataOnUninstall, false);
  assert.equal(manifest.build.nsis.oneClick, false, 'o instalador assistido é o que permite escolher a pasta');
  assert.equal(manifest.build.nsis.allowToChangeInstallationDirectory, true);
  assert.equal(manifest.build.nsis.createStartMenuShortcut, true);
  assert.equal(manifest.build.nsis.createDesktopShortcut, true);
});

// O firewall é aberto uma vez, no instalador, e não a cada abertura do app.
test('o instalador cria e remove as regras de firewall, sem abrir o perfil público', () => {
  const script = readFileSync(path.join(projectRoot, 'build', 'installer.nsh'), 'utf8');
  assert.match(script, /!macro customInstall/);
  assert.match(script, /!macro customUnInstall/);
  const executable = script.split('\n').filter((line) => !/^\s*;/.test(line)).join('\n');
  assert.match(executable, /TumacordFirewallRule\s+"[^"]*TCP 3927[^"]*"\s+TCP\s+3927/, 'a sinalização precisa da regra de TCP 3927');
  assert.match(executable, /TumacordFirewallRule\s+"[^"]*UDP 3928[^"]*"\s+UDP\s+3928\s+"remoteip=LocalSubnet"/, 'a descoberta não passa da própria sub-rede');
  assert.match(executable, /localport=\$\{Port\}/, 'a regra precisa prender a porta declarada');
  assert.equal(/profile=[a-z,]*public/i.test(executable), false, 'nada é liberado no perfil público');
  assert.equal(/advfirewall set|netsh advfirewall set/.test(executable), false, 'o firewall nunca é desligado');
  assert.match(executable, /program="\$INSTDIR\\\$\{APP_EXECUTABLE_FILENAME\}"/, 'a regra é presa ao executável do Tumacord');
  // Uma remoção dentro da macro (que roda para cada regra, evitando duplicar
  // ao instalar por cima) e uma para cada regra na desinstalação.
  const uninstall = executable.slice(executable.indexOf('!macro customUnInstall'));
  assert.match(uninstall, /delete rule name="Tumacord - sinalizacao \(TCP 3927\)"/);
  assert.match(uninstall, /delete rule name="Tumacord - descoberta na rede local \(UDP 3928\)"/);
  assert.match(executable.slice(0, executable.indexOf('!macro customInstall')), /delete rule name="\$\{Name\}"/, 'instalar por cima não pode duplicar a regra');
});

test('a identidade do publisher é declarada e não carrega segredo nenhum', () => {
  assert.equal(manifest.build.win.signtoolOptions?.publisherName, 'Tumacord');
  assert.equal(manifest.build.productName, 'Tumacord');
  assert.match(String(manifest.build.copyright), /Tumacord/);
  const raw = readFileSync(path.join(projectRoot, 'package.json'), 'utf8');
  for (const proibido of ['certificateFile', 'certificatePassword', 'certificateSubjectName', 'AZURE_CLIENT_SECRET']) {
    assert.equal(raw.includes(proibido), false, `${proibido} não pode ficar no repositório`);
  }
});

// Uniformizar o Linux por cima do Windows seria trocar uma solução que
// funciona por outra pior. As duas continuam separadas.
test('a build do Linux não foi tocada pela do Windows', () => {
  assert.deepEqual(manifest.build.linux.target, ['AppImage', 'tar.gz']);
  assert.equal(manifest.build.linux.icon, 'assets/tumacord-logo.png');
  assert.equal(manifest.build.linux.executableName, 'tumacord');
  assert.match(manifest.scripts['package:linux'], /electron-builder --linux AppImage tar\.gz/);
  assert.equal(/build:native:win/.test(manifest.scripts['package:linux']), false, 'o componente do Windows não entra na build do Linux');
});

// A versão do componente nativo precisa distinguir a revisão de manutenção.
//
// Até a 0.9.9 a normalização do `build.ps1` era `-replace '[^0-9.].*$', ''`,
// que apagava o sufixo inteiro: `0.9.9-1` saía como `0.9.9` e era preenchido
// para `0.9.9.0` — o mesmo número da versão que a revisão corrige.
//
// NOTA: este teste confere o **script**, não a execução dele. Não há
// PowerShell no ambiente de desenvolvimento em Linux; a execução real do
// `build.ps1` é verificada na máquina Windows e está registrada em docs/QA.md.
test('o componente nativo do Windows recebe a revisão no quarto campo', () => {
  const script = readFileSync(path.join(projectRoot, 'native', 'windows', 'audio-helper', 'build.ps1'), 'utf8');
  assert.ok(
    !script.includes("-replace '[^0-9.].*$', ''"),
    'a normalização que apagava o sufixo numérico não pode voltar',
  );
  assert.match(script, /\(\?<rev>\[1-9\]\[0-9\]\*\)/, 'a revisão é lida como um campo próprio');
  assert.match(script, /65535/, 'o limite do campo de 16 bits é conferido antes de compilar');
  assert.match(script, /throw "Versao fora da convencao do produto/, 'uma versão fora da convenção falha a build em vez de virar 0.0.0');
});

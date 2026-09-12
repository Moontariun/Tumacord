// Entregar o instalador do Windows ao Windows.
//
// ## O que acontecia
//
// Um print da 0.9.8 mostra o processo principal caindo com:
//
//     spawn C:\Users\...\AppData\Roaming\tumacord\updates\Tumacord-0.9.9-Setup.exe EACCES
//
// Duas coisas erradas, uma dentro da outra.
//
// A de fora: `spawn(file, [], { detached: true })` não tinha ouvinte de
// `error`. Uma falha assíncrona de lançamento emite `'error'` no filho, e um
// `'error'` sem ouvinte é lançado como exceção não tratada — o aplicativo
// inteiro fechava por causa de uma atualização que não começou.
//
// A de dentro: `spawn` chama `CreateProcess`, e `CreateProcess` **não eleva**.
// O instalador deste projeto é NSIS com `perMachine: true`, ou seja, pede
// administrador no manifesto; `CreateProcess` devolve `ERROR_ELEVATION_REQUIRED`
// para um executável assim, e é isso que chega ao Node como `EACCES`. Quem
// eleva é `ShellExecuteEx` com o verbo `runas` — é ele que mostra o UAC.
//
// Por isso `EACCES` aqui **não prova uma causa única**: elevação necessária,
// permissão negada de verdade, arquivo bloqueado por antivírus e caminho
// inexistente chegam parecidos. O diagnóstico abaixo separa o que dá para
// separar, e diz o que não deu.
//
// ## O que foi escolhido
//
// `Start-Process -Verb RunAs`, que é `ShellExecuteEx` com o verbo certo. Ele
// mostra o UAC, e — ao contrário de abrir o arquivo pelo shell e torcer —
// falha de um jeito observável quando a pessoa cancela. Assim dá para não
// fechar o aplicativo quando a instalação nem começou.
//
// O caminho do arquivo **nunca é concatenado** no comando: ele viaja por
// variável de ambiente e é lido lá dentro. `shell: true`, montar linha de
// comando com aspas e rodar o Tumacord inteiro como administrador não são
// correções — são três formas de transformar um nome de arquivo em comando.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

/** Quanto tempo esperar a pessoa responder ao UAC antes de desistir. */
const UAC_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * O script que eleva. Ele lê o caminho do ambiente, e por isso não há nada a
 * escapar: o valor nunca é interpretado como comando.
 *
 * `-PassThru` faz o `Start-Process` devolver o processo criado; imprimir o PID
 * é a confirmação de que o instalador começou mesmo. Sem ele, "o comando
 * voltou" não distingue instalador aberto de UAC cancelado.
 */
const ELEVATION_SCRIPT = [
  '$ErrorActionPreference = "Stop"',
  '$alvo = $env:TUMACORD_INSTALADOR',
  'if (-not (Test-Path -LiteralPath $alvo)) { Write-Error "TUMACORD_ARQUIVO_AUSENTE"; exit 3 }',
  'try {',
  '  $processo = Start-Process -FilePath $alvo -Verb RunAs -PassThru',
  '  Write-Output ("TUMACORD_PID=" + $processo.Id)',
  '} catch {',
  '  $codigo = $_.Exception.NativeErrorCode',
  '  if ($codigo -eq 1223) { Write-Error "TUMACORD_UAC_CANCELADO"; exit 4 }',
  '  Write-Error ("TUMACORD_FALHA_LANCAMENTO:" + $_.Exception.Message); exit 5',
  '}',
].join('\n');

/**
 * As causas que este código sabe distinguir.
 *
 * `unknown` existe e é usado: afirmar uma causa que não foi observada é pior
 * do que dizer que não se sabe, porque manda a pessoa consertar a coisa
 * errada.
 */
const LAUNCH_FAILURES = ['missing-file', 'empty-file', 'hash-mismatch', 'uac-cancelled', 'access-denied', 'sharing-violation', 'launcher-missing', 'timeout', 'installer-exit', 'unknown'];

const MESSAGES = {
  'missing-file': 'O instalador baixado não está mais no disco. Baixe a atualização de novo.',
  'empty-file': 'O instalador baixado está vazio ou incompleto. Baixe a atualização de novo.',
  'hash-mismatch': 'O instalador no disco não confere com o que foi verificado no download. Ele não foi executado. Baixe a atualização de novo.',
  'uac-cancelled': 'A instalação precisa da sua confirmação de administrador. Nada foi alterado — o Tumacord continua aberto e na versão de antes.',
  'access-denied': 'O Windows recusou a execução do instalador. Isso costuma ser antivírus ou política da máquina; o arquivo está guardado e pode ser executado à mão.',
  'sharing-violation': 'O arquivo do instalador está em uso por outro programa. Feche-o e tente de novo.',
  'launcher-missing': 'Não encontrei o PowerShell para pedir a elevação. Execute o instalador à mão pelo caminho indicado.',
  timeout: 'A confirmação de administrador não foi respondida. Nada foi alterado; tente de novo quando puder confirmar.',
  'installer-exit': 'O instalador foi aberto mas terminou com erro.',
  unknown: 'Não consegui abrir o instalador, e o Windows não disse o suficiente para eu saber por quê. O arquivo está guardado e pode ser executado à mão.',
};

/**
 * Classifica uma falha de lançamento.
 *
 * Recebe o que foi observado, e não uma conclusão: código de erro do Node,
 * saída do PowerShell e o estado do arquivo. O que não couber em nenhuma causa
 * conhecida vira `unknown`, com o erro original preservado para o suporte.
 */
function classifyLaunchFailure({ code = '', exitCode = null, stderr = '', message = '' } = {}) {
  const combined = `${stderr} ${message}`;
  if (combined.includes('TUMACORD_UAC_CANCELADO') || exitCode === 4) return 'uac-cancelled';
  if (combined.includes('TUMACORD_ARQUIVO_AUSENTE') || exitCode === 3 || code === 'ENOENT') {
    // ENOENT do próprio `spawn` é o PowerShell que não existe, e não o
    // instalador: são dois problemas diferentes com o mesmo código.
    return code === 'ENOENT' ? 'launcher-missing' : 'missing-file';
  }
  if (code === 'EACCES' || code === 'EPERM') return 'access-denied';
  if (code === 'EBUSY' || combined.includes('being used by another process') || combined.includes('sendo usado por outro')) return 'sharing-violation';
  if (code === 'ETIMEDOUT') return 'timeout';
  return 'unknown';
}

/** A mensagem em português de uma causa. */
function failureMessage(cause) {
  return MESSAGES[cause] ?? MESSAGES.unknown;
}

/**
 * Confere o arquivo imediatamente antes de executá-lo.
 *
 * A verificação do download não basta: entre baixar e aplicar há uma janela em
 * que o arquivo pode ter sido trocado, truncado ou removido. Um executável que
 * vai receber administrador é o último lugar onde vale confiar em verificação
 * antiga.
 */
function verifyInstallerFile(file, expectedSha256, { statSync = fs.statSync, hashFile } = {}) {
  let fileStat;
  try {
    fileStat = statSync(file);
  } catch {
    return { ok: false, cause: 'missing-file' };
  }
  if (!fileStat.isFile() || fileStat.size <= 0) return { ok: false, cause: 'empty-file' };
  if (expectedSha256) {
    const actualSha256 = hashFile ? hashFile(file) : sha256OfFile(file);
    if (String(actualSha256).toLowerCase() !== String(expectedSha256).toLowerCase()) return { ok: false, cause: 'hash-mismatch' };
  }
  return { ok: true, size: fileStat.size };
}

function sha256OfFile(file) {
  const { createHash } = require('node:crypto');
  const hash = createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/**
 * Abre o instalador com elevação e **espera saber se ele começou**.
 *
 * Devolve `{ started: true, pid }` só quando o PowerShell confirmou o processo
 * criado. Qualquer outra coisa é uma falha classificada — e em nenhum caminho
 * este código lança evento sem ouvinte nem derruba o processo principal.
 */
function launchElevatedInstaller(file, {
  spawnFn = spawn,
  timeoutMs = UAC_TIMEOUT_MS,
  env = process.env,
  powershell = '',
} = {}) {
  return new Promise((resolve) => {
    const executable = powershell || defaultPowerShell(env);
    let child;
    try {
      child = spawnFn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ELEVATION_SCRIPT], {
        windowsHide: true,
        // O caminho do arquivo viaja aqui, e não na linha de comando.
        env: { ...env, TUMACORD_INSTALADOR: file },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      // Falha síncrona de `spawn`. Ela existe e era ignorada: o `try` não
      // estava aqui, e nem o ouvinte de `error` abaixo.
      resolve({ started: false, cause: classifyLaunchFailure({ code: error && error.code, message: String(error && error.message) }), error: String(error && error.message ? error.message : error) });
      return;
    }

    let stdoutText = '';
    let stderrText = '';
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* já morreu */ }
      settle({ started: false, cause: 'timeout', error: 'a confirmação de administrador não foi respondida' });
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => { stdoutText += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderrText += String(chunk); });

    // **O ouvinte que faltava.** Sem ele, um `EACCES` assíncrono vira exceção
    // não tratada e fecha o Tumacord inteiro.
    child.on('error', (error) => {
      settle({ started: false, cause: classifyLaunchFailure({ code: error && error.code, message: String(error && error.message) }), error: String(error && error.message ? error.message : error) });
    });

    // `close` e não `exit`: `close` espera os fluxos, e é deles que sai o PID.
    // Ouvir os dois faria a operação terminar duas vezes; `terminar` protege,
    // mas ouvir um só é mais honesto sobre a intenção.
    child.on('close', (exitCode) => {
      const pid = /TUMACORD_PID=(\d+)/.exec(stdoutText)?.[1];
      if (pid) {
        settle({ started: true, pid: Number(pid) });
        return;
      }
      settle({
        started: false,
        cause: classifyLaunchFailure({ exitCode, stderr: stderrText }),
        error: stderrText.trim() || `o lançador terminou com código ${exitCode}`,
      });
    });
  });
}

function defaultPowerShell(env) {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
  return path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

module.exports = {
  ELEVATION_SCRIPT,
  LAUNCH_FAILURES,
  UAC_TIMEOUT_MS,
  classifyLaunchFailure,
  defaultPowerShell,
  failureMessage,
  launchElevatedInstaller,
  verifyInstallerFile,
};

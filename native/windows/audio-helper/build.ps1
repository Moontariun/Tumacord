# Compila o helper de áudio do Windows.
#
# Sem CMake de propósito: o único requisito é o compilador C++ que já vem no
# runner windows-latest e no Build Tools do Visual Studio. Menos uma peça para
# manter, e a linha de comando fica legível para quem for conferir o que entra
# no binário assinado.
#
#   powershell -ExecutionPolicy Bypass -File native/windows/audio-helper/build.ps1
#
# O resultado é native/windows/audio-helper/build/tumacord-audio-helper.exe.
# `/MT` liga a CRT estaticamente: o aplicativo instalado não pode depender de
# um redistribuível do Visual C++ na máquina de quem baixou.

[CmdletBinding()]
param(
    [string]$Configuration = 'Release',
    [string]$Version = ''
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$outputDirectory = Join-Path $here 'build'
$objectDirectory = Join-Path $outputDirectory 'obj'

if (-not $Version) {
    $packageFile = Join-Path (Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))) 'package.json'
    if (Test-Path $packageFile) {
        $Version = (Get-Content $packageFile -Raw | ConvertFrom-Json).version
    }
}
if (-not $Version) { $Version = '0.0.0' }
# A versao numerica de quatro campos que o Windows entende, pela convencao do
# produto: (major, minor, patch, revisao). `0.9.9` vira `0.9.9.0` e `0.9.9-1`
# vira `0.9.9.1`.
#
# Ate a 0.9.9 a normalizacao daqui recortava tudo a partir do primeiro
# caractere que nao fosse digito ou ponto, e com isso apagava o sufixo inteiro:
# a revisao 0.9.9-1 saia como 0.9.9 e era preenchida para 0.9.9.0, exatamente o
# mesmo numero da versao que ela corrige. O componente nativo da revisao ficava
# indistinguivel do da versao anterior para o Windows.
#
# Esta e a mesma regra de `shared/version.ts`, e `tests/version.test.ts`
# confere que as duas concordam.
$normalizada = $Version.Trim() -replace '^[vV]', ''
if ($normalizada -notmatch '^(?<major>0|[1-9][0-9]*)\.(?<minor>0|[1-9][0-9]*)\.(?<patch>0|[1-9][0-9]*)(?:-(?<rev>[1-9][0-9]*))?$') {
    throw "Versao fora da convencao do produto: '$Version'. Esperado 0.9.9 ou 0.9.9-1."
}
$parts = @($Matches['major'], $Matches['minor'], $Matches['patch'], $(if ($Matches['rev']) { $Matches['rev'] } else { '0' }))
foreach ($campo in $parts) {
    if ([int]$campo -gt 65535) { throw "Campo de versao acima de 65535 nao cabe no formato do Windows: '$Version'." }
}
$versionComma = ($parts -join ',')
$versionText = ($parts -join '.')

function Import-VisualStudioEnvironment {
    if ($env:VSINSTALLDIR -and (Get-Command cl.exe -ErrorAction SilentlyContinue)) { return }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { throw 'vswhere.exe nao encontrado: instale o Build Tools do Visual Studio com o workload C++.' }
    $installation = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $installation) { throw 'Nenhuma instalacao do Visual Studio com as ferramentas C++ x64 foi encontrada.' }
    $vcvars = Join-Path $installation 'VC\Auxiliary\Build\vcvars64.bat'
    if (-not (Test-Path $vcvars)) { throw "vcvars64.bat ausente em $installation" }
    # `set` depois do vcvars devolve o ambiente inteiro; importar assim evita
    # descobrir a mao onde estao os includes e as libs de cada versao do SDK.
    $output = cmd.exe /c "`"$vcvars`" >nul 2>&1 && set"
    foreach ($line in $output) {
        if ($line -match '^([^=]+)=(.*)$') {
            Set-Item -Path "env:$($matches[1])" -Value $matches[2] -ErrorAction SilentlyContinue
        }
    }
}

Import-VisualStudioEnvironment

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $objectDirectory | Out-Null

$resource = Join-Path $objectDirectory 'helper.res'
$rcArguments = @(
    '/nologo', '/c65001',
    "/dTUMACORD_VERSION_COMMA=$versionComma",
    "/dTUMACORD_VERSION_TEXT=\`"$versionText\`"",
    "/fo", $resource,
    (Join-Path $here 'helper.rc')
)
& rc.exe @rcArguments
if ($LASTEXITCODE -ne 0) { throw "rc.exe falhou com codigo $LASTEXITCODE" }

$sources = @('main.cpp', 'capture.cpp', 'sessions.cpp', 'processes.cpp', 'protocol.cpp') | ForEach-Object { Join-Path $here $_ }
$optimisation = if ($Configuration -eq 'Debug') { @('/Od', '/Zi', '/MTd') } else { @('/O2', '/MT', '/GL') }
$linkExtra = if ($Configuration -eq 'Debug') { @() } else { @('/LTCG', '/OPT:REF', '/OPT:ICF') }

$clArguments = @(
    '/nologo', '/std:c++17', '/EHsc', '/W4', '/WX', '/permissive-', '/utf-8',
    '/DWIN32_LEAN_AND_MEAN', '/D_WIN32_WINNT=0x0A00', '/DNOMINMAX', '/DUNICODE', '/D_UNICODE'
) + $optimisation + @(
    "/Fo:$objectDirectory\", "/Fd:$objectDirectory\helper.pdb"
) + $sources + @(
    '/link'
) + $linkExtra + @(
    '/SUBSYSTEM:CONSOLE',
    # Windows 10 20H1 e a primeira versao com loopback por processo; abaixo
    # disso o proprio helper detecta e o aplicativo transmite sem audio.
    '/DYNAMICBASE', '/NXCOMPAT', '/HIGHENTROPYVA',
    "/OUT:$outputDirectory\tumacord-audio-helper.exe",
    $resource,
    'ole32.lib', 'oleaut32.lib', 'mmdevapi.lib', 'avrt.lib', 'winmm.lib', 'user32.lib', 'advapi32.lib'
)

& cl.exe @clArguments
if ($LASTEXITCODE -ne 0) { throw "cl.exe falhou com codigo $LASTEXITCODE" }

Write-Host "Helper gerado em $outputDirectory\tumacord-audio-helper.exe"

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

const executar = promisify(execFile);

/** Roda um comando e devolve a saída, sem shell e sem concatenação. */
export async function rodar(comando, argumentos, opcoes = {}) {
  try {
    const { stdout, stderr } = await executar(comando, argumentos, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opcoes });
    return { ok: true, stdout, stderr };
  } catch (erro) {
    return { ok: false, stdout: erro?.stdout ?? '', stderr: erro?.stderr ?? String(erro?.message ?? erro), code: erro?.code };
  }
}

/**
 * As instalações do Tumacord nesta máquina.
 *
 * A busca é por **rótulo do Compose**, e não por nome: o rótulo
 * `com.docker.compose.project` é posto pelo próprio Compose e sobrevive a
 * qualquer nome de projeto que o operador tenha escolhido.
 */
export async function descobrirInstalacoes(executarComando = rodar) {
  const listagem = await executarComando('docker', [
    'ps', '--all', '--no-trunc', '--filter', 'label=com.docker.compose.project',
    '--format', '{{json .}}',
  ]);
  if (!listagem.ok) return { ok: false, erro: `não consegui falar com o Docker: ${listagem.stderr.trim()}`, instalacoes: [] };

  const contêineres = listagem.stdout.split('\n').filter(Boolean).map((linha) => {
    try { return JSON.parse(linha); } catch { return null; }
  }).filter(Boolean);

  const porProjeto = new Map();
  for (const contêiner of contêineres) {
    const detalhe = await inspecionar(contêiner.ID ?? contêiner.Id ?? '', executarComando);
    if (!detalhe) continue;
    const rotulos = detalhe.Config?.Labels ?? {};
    const projeto = rotulos['com.docker.compose.project'];
    const servico = rotulos['com.docker.compose.service'];
    if (!projeto || !servico) continue;
    // Só as instalações deste projeto. O nome do serviço vem do
    // docker-compose.yml e é estável; o nome do projeto, não.
    if (!['tumacord-server', 'tumacord-atualizacoes', 'coturn'].includes(servico)) continue;

    const atual = porProjeto.get(projeto) ?? { projeto, diretorio: rotulos['com.docker.compose.project.working_dir'] ?? '', servicos: {} };
    atual.servicos[servico] = {
      id: detalhe.Id,
      nome: (detalhe.Name ?? '').replace(/^\//, ''),
      imagem: detalhe.Config?.Image ?? '',
      estado: detalhe.State?.Status ?? '',
      saude: detalhe.State?.Health?.Status ?? '',
      iniciadoEm: detalhe.State?.StartedAt ?? '',
      // Os mounts **reais**, e não os que o arquivo diz. Eles podem divergir
      // quando o contêiner subiu com um arquivo diferente do que está lá agora.
      mounts: (detalhe.Mounts ?? []).map((mount) => ({
        tipo: mount.Type, nome: mount.Name ?? '', origem: mount.Source ?? '',
        destino: mount.Destination ?? '', escrita: mount.RW !== false,
      })),
      portas: portasDe(detalhe),
      // O ambiente vem **sem os valores**: nomes só. Um preflight que
      // imprimisse `SERVER_ACCESS_KEY=...` vazaria o segredo no primeiro print.
      variaveis: (detalhe.Config?.Env ?? []).map((entrada) => String(entrada).split('=')[0]).filter(Boolean).sort(),
    };
    porProjeto.set(projeto, atual);
  }
  return { ok: true, instalacoes: [...porProjeto.values()] };
}

async function inspecionar(id, executarComando) {
  if (!id) return null;
  const resultado = await executarComando('docker', ['inspect', id]);
  if (!resultado.ok) return null;
  try {
    const lido = JSON.parse(resultado.stdout);
    return Array.isArray(lido) ? lido[0] : lido;
  } catch {
    return null;
  }
}

function portasDe(detalhe) {
  const mapa = detalhe.NetworkSettings?.Ports ?? {};
  const portas = [];
  for (const [interna, ligacoes] of Object.entries(mapa)) {
    for (const ligacao of ligacoes ?? []) {
      portas.push({ interna, host: `${ligacao.HostIp || '0.0.0.0'}:${ligacao.HostPort}` });
    }
  }
  return portas.sort((esquerda, direita) => esquerda.interna.localeCompare(direita.interna));
}

/**
 * O mount que guarda os dados do chat, dentro de um serviço.
 *
 * A busca é pelo **destino** — o caminho dentro do contêiner —, que é o que o
 * servidor realmente usa, e não pelo nome do volume, que o operador escolhe.
 */
export function mountDeDados(servico, destino = '/data') {
  return (servico?.mounts ?? []).find((mount) => mount.destino === destino) ?? null;
}

/**
 * Escolhe a instalação sobre a qual operar.
 *
 * Com uma, é ela. Com nenhuma ou mais de uma, **para** e diz o que fazer:
 * escolher sozinho entre duas instalações é escolher em qual das duas o
 * operador vai perder dados.
 */
export function escolherInstalacao(instalacoes, projetoPedido = '') {
  if (projetoPedido) {
    const achada = instalacoes.find((candidata) => candidata.projeto === projetoPedido);
    if (!achada) {
      return { ok: false, erro: `Não encontrei a instalação "${projetoPedido}". As que existem: ${instalacoes.map((c) => c.projeto).join(', ') || 'nenhuma'}.` };
    }
    return { ok: true, instalacao: achada };
  }
  if (!instalacoes.length) {
    return { ok: false, erro: 'Não encontrei nenhuma instalação do Tumacord nesta máquina. Rode dentro do diretório do projeto, ou passe --projeto <nome>.' };
  }
  if (instalacoes.length > 1) {
    return {
      ok: false,
      erro: `Há mais de uma instalação aqui: ${instalacoes.map((c) => c.projeto).join(', ')}. Escolha com --projeto <nome> — escolher sozinho seria escolher em qual delas você perde dados.`,
    };
  }
  return { ok: true, instalacao: instalacoes[0] };
}

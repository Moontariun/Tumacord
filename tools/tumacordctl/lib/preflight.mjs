// O preflight: o que precisa estar certo antes de mexer na instalação.
//
// Ele existe porque a infraestrutura não estava disponível quando isto foi
// escrito. Em vez de supor endereço, caminho e volume, o código pergunta à
// máquina — e é o operador que roda, na VPS, quando ela existir.
//
// A regra que atravessa o arquivo: **verificação ambígua é falha**. "Não
// consegui conferir" nunca vira "está tudo bem". Foi assim que o guia antigo
// seguia sem backup quando não achava o volume.

import { access, statfs } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createServer } from 'node:net';
import { mountDeDados } from './descoberta.mjs';

/** Um resultado de verificação. `aviso` não impede; `falha` impede. */
export const NIVEIS = ['ok', 'aviso', 'falha'];

export function check(nivel, titulo, detalhe, comoResolver = '') {
  return { nivel, titulo, detalhe, comoResolver };
}

/** O pior nível de uma lista. É ele que decide se a operação segue. */
export function piorNivel(checks) {
  if (checks.some((item) => item.nivel === 'falha')) return 'falha';
  if (checks.some((item) => item.nivel === 'aviso')) return 'aviso';
  return 'ok';
}

/**
 * Espaço livre no sistema de arquivos de um caminho.
 *
 * Em bytes, e do sistema de arquivos que **de fato** contém o caminho — não do
 * `/`. Um volume Docker costuma estar noutro disco, e conferir o `/` responde
 * sobre o lugar errado.
 */
export async function espacoLivre(caminho) {
  try {
    const estado = await statfs(caminho);
    return { ok: true, livre: estado.bavail * estado.bsize, total: estado.blocks * estado.bsize };
  } catch (erro) {
    return { ok: false, erro: String(erro?.message ?? erro) };
  }
}

/** Se uma porta TCP do host está livre para escutar. */
export function portaLivre(porta, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const servidor = createServer();
    servidor.once('error', () => resolve(false));
    servidor.once('listening', () => servidor.close(() => resolve(true)));
    servidor.listen(porta, host);
  });
}

/** Se um caminho existe e é legível/gravável por quem está rodando. */
export async function permissoes(caminho) {
  const resultado = { existe: false, leitura: false, escrita: false };
  try {
    await access(caminho, constants.F_OK);
    resultado.existe = true;
  } catch {
    return resultado;
  }
  try { await access(caminho, constants.R_OK); resultado.leitura = true; } catch { /* sem leitura */ }
  try { await access(caminho, constants.W_OK); resultado.escrita = true; } catch { /* sem escrita */ }
  return resultado;
}

function humano(bytes) {
  if (!Number.isFinite(bytes)) return '?';
  const unidades = ['B', 'kB', 'MB', 'GB', 'TB'];
  let valor = bytes;
  let indice = 0;
  while (valor >= 1024 && indice < unidades.length - 1) { valor /= 1024; indice += 1; }
  return `${valor.toFixed(valor < 10 && indice > 0 ? 1 : 0)} ${unidades[indice]}`;
}

/**
 * O preflight de uma instalação descoberta.
 *
 * Recebe a instalação já escolhida — a escolha é do operador quando há mais de
 * uma — e devolve a lista de verificações com o que resolver em cada falha.
 *
 * `espacoMinimo` é o dobro do que uma release costuma ocupar mais folga para o
 * backup: aplicar sem espaço para o backup é aplicar sem backup.
 */
export async function preflight(instalacao, opcoes = {}) {
  const {
    espacoMinimo = 2 * 1024 * 1024 * 1024,
    lerEspaco = espacoLivre,
    lerPermissoes = permissoes,
    conferirPorta = portaLivre,
  } = opcoes;
  const checks = [];

  // ── A instalação existe e está identificada ──────────────────────────────
  checks.push(check('ok', 'Instalação identificada', `projeto "${instalacao.projeto}"${instalacao.diretorio ? `, em ${instalacao.diretorio}` : ''}`));

  const chat = instalacao.servicos['tumacord-server'];
  if (!chat) {
    checks.push(check('falha', 'Servidor de chat', 'o serviço `tumacord-server` não existe neste projeto',
      'Confira se está no projeto certo: `tumacordctl doctor --projeto <nome>`.'));
  } else {
    checks.push(check(
      chat.estado === 'running' ? 'ok' : 'aviso',
      'Servidor de chat',
      `${chat.nome}: ${chat.estado}${chat.saude ? ` (saúde: ${chat.saude})` : ''}`,
      chat.estado === 'running' ? '' : 'Suba com `docker compose up -d` antes de aplicar uma atualização.',
    ));
  }

  const atualizacoes = instalacao.servicos['tumacord-atualizacoes'];
  checks.push(atualizacoes
    ? check(atualizacoes.estado === 'running' ? 'ok' : 'aviso', 'Serviço de atualizações',
      `${atualizacoes.nome}: ${atualizacoes.estado}`,
      atualizacoes.estado === 'running' ? '' : 'Suba com `docker compose up -d tumacord-atualizacoes`.')
    : check('aviso', 'Serviço de atualizações', 'não está instalado neste projeto',
      'Enquanto ele não existir, os aplicativos continuam dependendo da ponte manual. Veja docs/instalacao-vps.md.'));

  // ── Os dados: um mount, e só um ──────────────────────────────────────────
  //
  // Aqui é onde o guia antigo errava. O volume não é procurado por nome nem
  // por expressão regular: ele é o mount que o contêiner **tem** em /data.
  if (chat) {
    const dados = mountDeDados(chat, '/data');
    if (!dados) {
      checks.push(check('falha', 'Volume de dados', 'o contêiner do chat não tem nada montado em /data',
        'Sem saber onde os dados estão, nada é aplicado: um backup que não acontece só avisa na hora de restaurar. Confira o `docker-compose.yml` desta instalação.'));
    } else {
      const candidatos = (chat.mounts ?? []).filter((mount) => mount.destino === '/data');
      if (candidatos.length > 1) {
        checks.push(check('falha', 'Volume de dados', `há ${candidatos.length} mounts em /data`,
          'Descoberta ambígua para a operação: escolher um deles seria escolher de qual você perde os dados.'));
      } else {
        checks.push(check('ok', 'Volume de dados', `${dados.tipo} ${dados.nome || dados.origem} → /data${dados.escrita ? '' : ' (somente leitura!)'}`,
          dados.escrita ? '' : 'O servidor não consegue gravar. Corrija o mount antes de qualquer coisa.'));
        if (!dados.escrita) checks[checks.length - 1].nivel = 'falha';

        // Espaço no disco que de fato contém os dados.
        if (dados.origem) {
          const espaco = await lerEspaco(dados.origem);
          if (!espaco.ok) {
            checks.push(check('aviso', 'Espaço em disco', `não consegui medir ${dados.origem}: ${espaco.erro}`,
              'Rode como o usuário que administra o Docker, ou meça à mão com `df -h`.'));
          } else {
            checks.push(check(
              espaco.livre >= espacoMinimo ? 'ok' : 'falha',
              'Espaço em disco',
              `${humano(espaco.livre)} livres de ${humano(espaco.total)} em ${dados.origem}`,
              espaco.livre >= espacoMinimo ? '' : `Aplicar precisa de espaço para o backup **e** para a imagem nova; o mínimo aqui é ${humano(espacoMinimo)}. Libere espaço antes.`,
            ));
          }
          const acesso = await lerPermissoes(dados.origem);
          checks.push(check(
            acesso.existe && acesso.leitura ? 'ok' : 'aviso',
            'Permissão de leitura dos dados',
            acesso.existe ? `leitura: ${acesso.leitura ? 'sim' : 'não'}, escrita: ${acesso.escrita ? 'sim' : 'não'}` : 'o caminho do volume não é visível deste usuário',
            acesso.existe && acesso.leitura ? '' : 'O backup lê daqui. Rode como root ou pelo usuário do Docker.',
          ));
        }
      }
    }

    // ── Portas ─────────────────────────────────────────────────────────────
    for (const porta of chat.portas ?? []) {
      checks.push(check('ok', 'Porta publicada', `${porta.interna} → ${porta.host}`));
    }
  }

  // A porta da administração do serviço de atualizações **não** pode estar
  // aberta para fora. Publicá-la exporia a operação mais sensível do sistema.
  if (atualizacoes) {
    const expostas = (atualizacoes.portas ?? []).filter((porta) => porta.interna.startsWith('4301') && !porta.host.startsWith('127.0.0.1'));
    checks.push(expostas.length
      ? check('falha', 'Porta de administração', `a 4301 está publicada em ${expostas.map((p) => p.host).join(', ')}`,
        'Ela precisa ficar no laço local: `127.0.0.1:4301:4301`. Quem a opera é o executor, que já está na máquina.')
      : check('ok', 'Porta de administração', 'a 4301 não está publicada para fora'));
  }

  // ── Configuração sem segredo impresso ────────────────────────────────────
  if (chat) {
    const obrigatorias = ['DATA_DIR', 'SERVER_ACCESS_KEY'];
    const faltando = obrigatorias.filter((nome) => !(chat.variaveis ?? []).includes(nome));
    checks.push(faltando.length
      ? check('falha', 'Configuração', `faltam variáveis: ${faltando.join(', ')}`, 'Confira o `.env` desta instalação. Veja docs/configuracao.md.')
      // Só os nomes. Imprimir os valores vazaria a chave no primeiro print.
      : check('ok', 'Configuração', `${(chat.variaveis ?? []).length} variáveis definidas (valores não são impressos)`));
  }

  return { checks, nivel: piorNivel(checks) };
}

/** Se uma porta do host está livre, para o preflight de instalação nova. */
export async function preflightPortas(portas, conferir = portaLivre) {
  const checks = [];
  for (const porta of portas) {
    const livre = await conferir(porta);
    checks.push(check(livre ? 'ok' : 'falha', `Porta ${porta}`, livre ? 'livre' : 'já está em uso',
      livre ? '' : `Descubra quem a usa com \`ss -ltnp sport = :${porta}\` e libere, ou escolha outra porta no .env.`));
  }
  return { checks, nivel: piorNivel(checks) };
}

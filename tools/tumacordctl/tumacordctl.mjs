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
import { descobrirInstalacoes, escolherInstalacao, mountDeDados, rodar } from './lib/descoberta.mjs';
import { preflight, preflightPortas } from './lib/preflight.mjs';

const VERSAO_FERRAMENTA = '0.9.9-1';

const AJUDA = `tumacordctl ${VERSAO_FERRAMENTA} — operação da distribuição do Tumacord

USO
  tumacordctl <comando> [opções]

COMANDOS
  doctor                    Confere a instalação desta máquina e diz o que impede uma
                            atualização. Não muda nada. É o primeiro comando a rodar
                            numa VPS nova ou antes de qualquer operação.
  instalacao                Mostra a instalação descoberta: projeto, serviços, mounts
                            reais, portas e nomes das variáveis (sem os valores).
  releases listar           Lista o que está publicado no catálogo.
  releases importar         Importa uma release já assinada para o serviço.
  releases publicar         Promove o catálogo assinado. Só depois de todas as
                            verificações.
  releases retirar          Retira uma versão. Ela para de ser oferecida e de poder
                            ser baixada, inclusive por quem já estava na rua.
  devices listar            Lista os dispositivos autorizados a baixar.
  devices convidar          Cria um convite de uso único, para passar por canal privado.
  devices revogar           Revoga a autorização de um dispositivo.
  jobs status               Mostra os trabalhos de importação e aplicação.
  backup                    Cópia consistente dos dados do dedicado.
  restore                   Restaura uma cópia — em destino separado, antes de
                            substituir o que está em uso.
  server apply              Aplica uma release exata ao servidor dedicado.
  server rollback           Volta ao deployment anterior registrado.

OPÇÕES GERAIS
  --projeto <nome>          Qual instalação operar. Obrigatório quando há mais de uma
                            nesta máquina: escolher sozinho seria escolher em qual
                            delas você perde dados.
  --servico <url>           Onde está a administração do serviço de atualizações.
                            Padrão: http://127.0.0.1:4301
  --json                    Saída em JSON, para script.
  --help                    Esta ajuda. Vale também por comando: \`tumacordctl doctor --help\`.

ONDE ESTÁ DOCUMENTADO
  Instalação na VPS ........ docs/instalacao-vps.md
  Publicação privada ....... docs/publicacao-privada.md
  Backup e restauração ..... docs/backup-restore.md
  Atualização do servidor .. docs/atualizacao-servidor.md
`;

const AJUDA_COMANDO = {
  doctor: `tumacordctl doctor — confere a instalação desta máquina

USO
  tumacordctl doctor [--projeto <nome>] [--json] [--portas 4600,4300]

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
  instalacao: `tumacordctl instalacao — o que existe nesta máquina

USO
  tumacordctl instalacao [--projeto <nome>] [--json]

Mostra projeto, diretório, serviços com estado e saúde, mounts reais com
destino e se são graváveis, portas publicadas, e os **nomes** das variáveis de
ambiente. Valores não são impressos.

É esta a saída para anexar num relato de problema: ela descreve a instalação
sem carregar segredo nenhum.
`,
  backup: `tumacordctl backup — cópia consistente dos dados do dedicado

USO
  tumacordctl backup --saida <diretório> [--projeto <nome>]

CONSISTÊNCIA
  O servidor grava o JSON de forma coordenada dentro do processo. Um \`tar\` do
  volume vivo **não** prova que o arquivo foi capturado entre duas gravações, e
  é por isso que ele não é usado sozinho: o backup pede ao servidor que descarregue
  e pause a escrita, copia estado e anexos no mesmo ponto, e libera.

  Sem conseguir a pausa, o comando **para**. Não continuar em silêncio é o
  ponto: um backup que não aconteceu só avisa na hora de restaurar.
`,
  restore: `tumacordctl restore — restaura uma cópia

USO
  tumacordctl restore --de <arquivo> --para <destino> [--conferir]

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
  const posicionais = [];
  const opcoes = {};
  for (let i = 0; i < argv.length; i += 1) {
    const bruto = argv[i];
    if (!bruto.startsWith('--')) { posicionais.push(bruto); continue; }
    const nome = bruto.slice(2);
    if (nome === 'help' || nome === 'json') { opcoes[nome] = true; continue; }
    const proximo = argv[i + 1];
    if (proximo === undefined || proximo.startsWith('--')) { opcoes[nome] = true; continue; }
    opcoes[nome] = proximo;
    i += 1;
  }
  return { posicionais, opcoes };
}

const SIMBOLO = { ok: '·', aviso: '!', falha: '×' };

function imprimirChecks(resultado) {
  for (const item of resultado.checks) {
    console.log(`  ${SIMBOLO[item.nivel]} ${item.titulo}: ${item.detalhe}`);
    if (item.comoResolver) console.log(`      → ${item.comoResolver}`);
  }
  console.log();
  if (resultado.nivel === 'falha') console.log('Há falhas acima. Elas impedem a operação — cada uma traz o que resolver.');
  else if (resultado.nivel === 'aviso') console.log('Há avisos acima. Eles não impedem a operação, mas vale ler.');
  else console.log('Nada impede a operação.');
}

async function instalacaoEscolhida(opcoes) {
  const descoberta = await descobrirInstalacoes();
  if (!descoberta.ok) return { ok: false, erro: descoberta.erro, codigo: 2 };
  const escolha = escolherInstalacao(descoberta.instalacoes, typeof opcoes.projeto === 'string' ? opcoes.projeto : '');
  if (!escolha.ok) return { ok: false, erro: escolha.erro, codigo: 2 };
  return { ok: true, instalacao: escolha.instalacao };
}

async function comandoDoctor(opcoes) {
  const escolha = await instalacaoEscolhida(opcoes);
  if (!escolha.ok) {
    console.error(escolha.erro);
    return escolha.codigo;
  }
  const resultado = await preflight(escolha.instalacao);
  if (typeof opcoes.portas === 'string') {
    const portas = opcoes.portas.split(',').map((valor) => Number(valor.trim())).filter((valor) => Number.isInteger(valor) && valor > 0);
    const extra = await preflightPortas(portas);
    resultado.checks.push(...extra.checks);
    resultado.nivel = extra.nivel === 'falha' || resultado.nivel === 'falha' ? 'falha' : (extra.nivel === 'aviso' || resultado.nivel === 'aviso' ? 'aviso' : 'ok');
  }
  if (opcoes.json) {
    console.log(JSON.stringify({ projeto: escolha.instalacao.projeto, ...resultado }, null, 2));
  } else {
    console.log(`\nPreflight da instalação "${escolha.instalacao.projeto}"\n`);
    imprimirChecks(resultado);
  }
  return resultado.nivel === 'falha' ? 1 : 0;
}

async function comandoInstalacao(opcoes) {
  const escolha = await instalacaoEscolhida(opcoes);
  if (!escolha.ok) {
    console.error(escolha.erro);
    return escolha.codigo;
  }
  const { instalacao } = escolha;
  if (opcoes.json) {
    console.log(JSON.stringify(instalacao, null, 2));
    return 0;
  }
  console.log(`\nProjeto:   ${instalacao.projeto}`);
  if (instalacao.diretorio) console.log(`Diretório: ${instalacao.diretorio}`);
  for (const [nome, servico] of Object.entries(instalacao.servicos)) {
    console.log(`\n  ${nome}`);
    console.log(`    contêiner: ${servico.nome} (${servico.estado}${servico.saude ? `, saúde ${servico.saude}` : ''})`);
    console.log(`    imagem:    ${servico.imagem}`);
    for (const mount of servico.mounts) {
      console.log(`    mount:     ${mount.tipo} ${mount.nome || mount.origem} → ${mount.destino}${mount.escrita ? '' : ' (ro)'}`);
    }
    for (const porta of servico.portas) console.log(`    porta:     ${porta.interna} → ${porta.host}`);
    console.log(`    variáveis: ${servico.variaveis.join(', ') || 'nenhuma'}`);
  }
  const chat = instalacao.servicos['tumacord-server'];
  const dados = chat ? mountDeDados(chat, '/data') : null;
  console.log(`\nDados do chat: ${dados ? `${dados.tipo} ${dados.nome || dados.origem}` : 'NÃO ENCONTRADOS — nada deve ser aplicado assim'}`);
  console.log('\n(Os valores das variáveis não são impressos: esta saída pode ser colada num relato.)');
  return 0;
}

/** A administração do serviço de atualizações, sempre no laço local. */
function urlDoServico(opcoes) {
  const bruto = typeof opcoes.servico === 'string' ? opcoes.servico : 'http://127.0.0.1:4301';
  try {
    const url = new URL(bruto);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocolo');
    return url.origin;
  } catch {
    throw new Error(`--servico precisa ser uma URL http(s): recebi ${JSON.stringify(bruto)}`);
  }
}

async function pedir(opcoes, caminho, init = {}) {
  const resposta = await fetch(`${urlDoServico(opcoes)}${caminho}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  const texto = await resposta.text();
  let corpo;
  try { corpo = texto ? JSON.parse(texto) : {}; } catch { corpo = { error: texto }; }
  return { status: resposta.status, corpo };
}

async function comandoDevices(posicionais, opcoes) {
  const sub = posicionais[0] ?? 'listar';
  if (sub === 'listar') {
    const { status, corpo } = await pedir(opcoes, '/admin/dispositivos');
    if (status !== 200) { console.error(corpo.error ?? `o serviço respondeu ${status}`); return 1; }
    if (opcoes.json) { console.log(JSON.stringify(corpo, null, 2)); return 0; }
    if (!corpo.devices?.length) { console.log('Nenhum dispositivo autorizado ainda.'); return 0; }
    for (const device of corpo.devices) {
      const estado = device.revokedAt ? `revogado em ${device.revokedAt}` : `vale até ${new Date(device.expiresAt).toISOString()}`;
      console.log(`  ${device.deviceId}  ${device.label.padEnd(24)}  ${estado}`);
    }
    return 0;
  }
  if (sub === 'convidar') {
    const rotulo = typeof opcoes.rotulo === 'string' ? opcoes.rotulo : '';
    if (!rotulo) { console.error('Informe --rotulo "Windows do Caio": é como você reconhece o dispositivo na lista depois.'); return 1; }
    const { status, corpo } = await pedir(opcoes, '/admin/convites', { method: 'POST', body: JSON.stringify({ rotulo }) });
    if (status !== 201) { console.error(corpo.error ?? `o serviço respondeu ${status}`); return 1; }
    console.log(`\nConvite para "${corpo.rotulo}":\n\n  ${corpo.convite}\n`);
    console.log(`Vale uma vez só, até ${new Date(corpo.expiresAt).toISOString()}.`);
    console.log('Passe por canal privado. Ele não é mostrado de novo.');
    return 0;
  }
  if (sub === 'revogar') {
    const id = posicionais[1] ?? (typeof opcoes.id === 'string' ? opcoes.id : '');
    if (!id) { console.error('Informe o id do dispositivo: `tumacordctl devices revogar <id>`. Veja a lista com `tumacordctl devices listar`.'); return 1; }
    const motivo = typeof opcoes.motivo === 'string' ? opcoes.motivo : 'revogado pelo dono';
    const { status, corpo } = await pedir(opcoes, `/admin/dispositivos/${encodeURIComponent(id)}/revogar`, { method: 'POST', body: JSON.stringify({ motivo }) });
    if (status !== 200) { console.error(corpo.error ?? `o serviço respondeu ${status}`); return 1; }
    console.log(`Dispositivo ${id} revogado. Ele para de baixar na hora, inclusive no meio de um download.`);
    return 0;
  }
  console.error(`Subcomando desconhecido: ${sub}. Use listar, convidar ou revogar.`);
  return 1;
}

async function comandoReleases(posicionais, opcoes) {
  const sub = posicionais[0] ?? 'listar';
  if (sub === 'importar') {
    const arquivo = typeof opcoes.manifesto === 'string' ? opcoes.manifesto : '';
    if (!arquivo) { console.error('Informe --manifesto <arquivo.json>: o manifesto já assinado pelo ambiente de publicação.'); return 1; }
    const conteudo = await readFile(path.resolve(arquivo), 'utf8');
    const { status, corpo } = await pedir(opcoes, '/admin/manifesto', { method: 'POST', body: conteudo });
    if (status !== 201) { console.error(`Manifesto recusado: ${corpo.error ?? status}`); return 1; }
    console.log(`Manifesto da release ${corpo.releaseId} importado e conferido.`);
    return 0;
  }
  if (sub === 'publicar') {
    const arquivo = typeof opcoes.catalogo === 'string' ? opcoes.catalogo : '';
    if (!arquivo) { console.error('Informe --catalogo <arquivo.json>: o catálogo já assinado.'); return 1; }
    const conteudo = await readFile(path.resolve(arquivo), 'utf8');
    const { status, corpo } = await pedir(opcoes, '/admin/catalogo', { method: 'POST', body: conteudo });
    if (status !== 201) { console.error(`Catálogo recusado: ${corpo.error ?? status}`); return 1; }
    console.log(`Catálogo publicado na sequência ${corpo.sequence}. A partir de agora os aplicativos passam a ver isto.`);
    return 0;
  }
  if (sub === 'retirar') {
    const releaseId = posicionais[1] ?? (typeof opcoes.release === 'string' ? opcoes.release : '');
    const motivo = typeof opcoes.motivo === 'string' ? opcoes.motivo : '';
    if (!releaseId || !motivo) {
      console.error('Uso: tumacordctl releases retirar <releaseId> --motivo "o áudio sai errado no Windows"');
      console.error('O motivo não é enfeite: ele aparece na tela de quem tentar instalar.');
      return 1;
    }
    const { status, corpo } = await pedir(opcoes, '/admin/retirar', { method: 'POST', body: JSON.stringify({ releaseId, motivo, canal: opcoes.canal ?? 'stable' }) });
    if (status !== 200) { console.error(corpo.error ?? `o serviço respondeu ${status}`); return 1; }
    console.log('O catálogo com a retirada está pronto para assinar. Ele NÃO foi publicado ainda:');
    console.log('este serviço não assina nada — a chave privada vive no ambiente de publicação.\n');
    console.log(JSON.stringify(corpo.paraAssinar, null, 2));
    return 0;
  }
  if (sub === 'listar') {
    console.error('`releases listar` lê o catálogo pelo serviço público, com credencial de dispositivo.');
    console.error('Use `tumacordctl instalacao` para ver o que está instalado, ou consulte o painel do dono.');
    return 1;
  }
  console.error(`Subcomando desconhecido: ${sub}. Use importar, publicar ou retirar.`);
  return 1;
}

const NAO_IMPLEMENTADO = {
  'server apply': 'aplicar uma release ao dedicado',
  'server rollback': 'voltar ao deployment anterior',
  backup: 'a cópia consistente',
  restore: 'a restauração',
  'jobs status': 'a lista de trabalhos',
};

async function principal(argv) {
  const { posicionais, opcoes } = parseArgs(argv);
  const comando = posicionais[0] ?? '';
  const resto = posicionais.slice(1);

  if (!comando || opcoes.help && !comando) { console.log(AJUDA); return comando ? 0 : 1; }
  if (opcoes.help && AJUDA_COMANDO[comando]) { console.log(AJUDA_COMANDO[comando]); return 0; }
  if (opcoes.help) { console.log(AJUDA); return 0; }

  try {
    switch (comando) {
      case 'doctor': return await comandoDoctor(opcoes);
      case 'instalacao': return await comandoInstalacao(opcoes);
      case 'devices': return await comandoDevices(resto, opcoes);
      case 'releases': return await comandoReleases(resto, opcoes);
      case 'versao': console.log(VERSAO_FERRAMENTA); return 0;
      default: {
        const chave = resto.length ? `${comando} ${resto[0]}` : comando;
        if (NAO_IMPLEMENTADO[chave]) {
          // Dizer o que falta é melhor do que um comando que finge funcionar.
          console.error(`\`${chave}\` ainda não está implementado nesta revisão: ${NAO_IMPLEMENTADO[chave]}.`);
          console.error('O procedimento manual equivalente está em docs/atualizacao-servidor.md e docs/backup-restore.md.');
          return 3;
        }
        console.error(`Comando desconhecido: ${comando}\n`);
        console.log(AJUDA);
        return 1;
      }
    }
  } catch (erro) {
    console.error(String(erro?.message ?? erro));
    return 1;
  }
}

export { AJUDA, AJUDA_COMANDO, NAO_IMPLEMENTADO, parseArgs, principal, urlDoServico };

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  principal(process.argv.slice(2)).then((codigo) => process.exit(codigo));
}

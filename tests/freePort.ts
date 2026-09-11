import { openSync, closeSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Porta livre de verdade, perguntada ao sistema — e sem repetir.
//
// Sortear um número em uma faixa parece suficiente até os arquivos de teste
// rodarem em paralelo, que é o padrão do runner do Node. Duas suítes podem
// sortear a mesma porta, e aí uma delas falha por `EADDRINUSE` de forma
// intermitente: passa na máquina, falha no CI, e a diferença não está no
// código.
//
// Pedir ao sistema uma porta livre resolve metade do problema. A outra metade
// é a janela entre soltar a porta aqui e o servidor ligá-la: nela, outra suíte
// pode receber exatamente a mesma porta do sistema. Numa máquina de integração
// contínua com quatro núcleos e uma dúzia de servidores subindo ao mesmo
// tempo, essa janela é grande o bastante para acontecer — e o sintoma é um
// servidor que "encerrou antes do teste (1)", em um arquivo que ninguém tocou.
//
// Duas coisas fecham a janela. Cada processo procura a partir de um ponto
// próprio, derivado do seu pid, então arquivos diferentes não disputam o mesmo
// número; e dentro do processo um contador impede a repetição. A conferência
// continua sendo uma ligação de verdade: só é devolvida a porta que o sistema
// deixou ligar agora.

/**
 * Abaixo do que o sistema entrega sozinho para portas efêmeras.
 *
 * Este arquivo dizia que 20.000–60.000 era uma faixa "fora do que o sistema
 * entrega sozinho", e isso estava errado: no Linux o padrão de
 * `ip_local_port_range` é 32768–60999, então dois terços das candidatas eram
 * justamente portas que o núcleo pode dar a qualquer conexão de saída.
 *
 * E há uma janela em que isso importa. Entre conferir a porta aqui e o
 * servidor de teste ligá-la passa a inicialização de um processo Node com
 * `tsx` — bem mais que um piscar —, e nesse intervalo a suíte está abrindo
 * dezenas de conexões para 127.0.0.1. Uma delas recebe do núcleo exatamente a
 * porta reservada, o servidor encontra `EADDRINUSE` e sai com código 1. O
 * sintoma é o que o CI mostrava: "servidor encerrou (1)", intermitente, sempre
 * no arquivo que sobe mais servidores, e nunca reproduzível na máquina de quem
 * foi olhar.
 *
 * A reserva entre processos não cobria isso: ela impede que outra *suíte* pegue
 * a porta, não que o *núcleo* a entregue a um cliente.
 */
function inicioDasEfemeras(): number {
  try {
    const [baixo] = readFileSync('/proc/sys/net/ipv4/ip_local_port_range', 'utf8').trim().split(/\s+/).map(Number);
    if (Number.isInteger(baixo) && baixo > 4_000) return baixo;
  } catch { /* não é Linux, ou o arquivo não está legível */ }
  // O padrão do Linux, que é também o mais baixo entre os sistemas comuns.
  return 32_768;
}

const INICIO = 20_000;
/** Uma folga abaixo do limite: quem o ajusta para baixo não nos pega de surpresa. */
export const FIM = Math.max(INICIO + 2_000, inicioDasEfemeras() - 500);
const LARGURA = FIM - INICIO;

// O ponto de partida deste processo. Pids próximos viram faixas distantes, o
// que importa porque o runner cria os processos praticamente juntos.
let proxima = INICIO + ((process.pid * 2_654_435_761) % LARGURA);
let tentativasDesteProcesso = 0;

// A reserva entre processos.
//
// Espalhar por pid e conferir ligando resolve quase tudo, e "quase" é o
// problema: duas suítes podem receber do sistema a mesma porta na mesma
// janela de milissegundos entre a conferência e o servidor ligá-la. O sintoma
// é um servidor que "encerrou antes do teste (1)" em um arquivo que ninguém
// tocou.
//
// Os processos de teste compartilham o diretório temporário, e é nele que a
// reserva mora: um arquivo por porta, criado com `wx` — que falha se já
// existir. Quem criou o arquivo ficou com a porta, e não há empate possível.
const RESERVAS = path.join(tmpdir(), 'tumacord-portas-de-teste');
/** Uma reserva velha é de um processo que morreu; ela deixa de valer. */
const RESERVA_VALIDA_MS = 10 * 60_000;

function reservar(port: number): boolean {
  try {
    mkdirSync(RESERVAS, { recursive: true });
    closeSync(openSync(path.join(RESERVAS, String(port)), 'wx'));
    return true;
  } catch {
    return false;
  }
}

function limparReservasVelhas(): void {
  try {
    const agora = Date.now();
    for (const nome of readdirSync(RESERVAS)) {
      const arquivo = path.join(RESERVAS, nome);
      try {
        if (agora - statSync(arquivo).mtimeMs > RESERVA_VALIDA_MS) unlinkSync(arquivo);
      } catch { /* outro processo já limpou */ }
    }
  } catch { /* o diretório ainda não existe */ }
}

function podeLigar(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sonda = createServer();
    sonda.once('error', () => resolve(false));
    sonda.listen(port, '127.0.0.1', () => sonda.close(() => resolve(true)));
  });
}

export async function freePort(): Promise<number> {
  limparReservasVelhas();
  for (let tentativa = 0; tentativa < 200; tentativa += 1) {
    tentativasDesteProcesso += 1;
    const candidata = INICIO + ((proxima + tentativasDesteProcesso * 7) % LARGURA);
    // A reserva primeiro: se outro processo já a pegou, nem vale conferir.
    if (!reservar(candidata)) continue;
    if (await podeLigar(candidata)) return candidata;
  }
  // Nenhuma das 200 candidatas serviu. Perguntar ao sistema com `listen(0)`
  // era o caminho antigo, e ele devolve justamente uma porta efêmera — o
  // problema de que acabamos de sair. Melhor falhar dizendo o que houve.
  throw new Error(`não consegui uma porta livre entre ${INICIO} e ${FIM}`);
}

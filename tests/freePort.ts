import { createServer } from 'node:net';

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

/** Faixa alta, fora do que o sistema entrega sozinho para portas efêmeras. */
const INICIO = 20_000;
const FIM = 60_000;
const LARGURA = FIM - INICIO;

// O ponto de partida deste processo. Pids próximos viram faixas distantes, o
// que importa porque o runner cria os processos praticamente juntos.
let proxima = INICIO + ((process.pid * 2_654_435_761) % LARGURA);
let tentativasDesteProcesso = 0;

function podeLigar(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sonda = createServer();
    sonda.once('error', () => resolve(false));
    sonda.listen(port, '127.0.0.1', () => sonda.close(() => resolve(true)));
  });
}

export async function freePort(): Promise<number> {
  for (let tentativa = 0; tentativa < 200; tentativa += 1) {
    tentativasDesteProcesso += 1;
    const candidata = INICIO + ((proxima + tentativasDesteProcesso * 7) % LARGURA);
    if (await podeLigar(candidata)) return candidata;
  }
  // Nenhuma das candidatas serviu: volta a perguntar ao sistema, que é o
  // caminho antigo. Pior do que uma porta disputada é um teste que não roda.
  return new Promise((resolve, reject) => {
    const sonda = createServer();
    sonda.once('error', reject);
    sonda.listen(0, '127.0.0.1', () => {
      const address = sonda.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      sonda.close(() => (port ? resolve(port) : reject(new Error('não consegui uma porta livre'))));
    });
  });
}

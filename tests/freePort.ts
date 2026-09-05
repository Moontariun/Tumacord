import { createServer } from 'node:net';

// Porta livre de verdade, perguntada ao sistema.
//
// Sortear um número em uma faixa parece suficiente até os arquivos de teste
// rodarem em paralelo — que é o padrão do runner do Node. Duas suítes podem
// sortear a mesma porta, e aí uma delas falha por `EADDRINUSE` de forma
// intermitente: passa na máquina, falha no CI, e a diferença não está no
// código. Pedir ao sistema uma porta livre elimina a coincidência.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => (port ? resolve(port) : reject(new Error('não consegui uma porta livre'))));
    });
  });
}

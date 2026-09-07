// Um valor que vem de fora: do servidor, do processo principal, de um
// dispositivo. Ele demora, às vezes falha, e volta.
//
// O defeito que este arquivo existe para impedir é sempre o mesmo. Sob carga
// alta de CPU ou GPU, o event loop engasga, uma resposta atrasa, um IPC
// demora — e o resultado disso vira `null`, `[]` ou `false` na interface. A
// pessoa vê o botão sumir. Segundos depois a resposta chega e ele volta.
// Nada quebrou: a interface concluiu "não existe" a partir de "ainda não
// respondeu", que são coisas diferentes.
//
// São seis estados, não dois:
//
//   unknown     — ninguém perguntou ainda;
//   loading     — perguntou pela primeira vez, sem nada em mãos;
//   ready       — respondeu, e o valor é atual;
//   refreshing  — está perguntando de novo, com o valor anterior em mãos;
//   stale       — a última pergunta falhou, mas o valor anterior continua
//                 valendo enquanto não houver resposta melhor;
//   failed      — falhou e não há valor nenhum para mostrar.
//
// E cada pergunta carrega um número. Uma resposta que chega depois de outra
// pergunta ter sido feita é descartada: sem isso, o pedido A que atrasou
// sobrescreve o resultado do pedido B que já terminou — a inversão de ordem
// que aparece exatamente quando a máquina está ocupada.

export type Freshness = 'unknown' | 'loading' | 'ready' | 'refreshing' | 'stale' | 'failed';

export interface Tracked<T> {
  value: T | null;
  status: Freshness;
  /** Número da pergunta em voo. Resposta com número antigo não vale. */
  request: number;
  error: string;
}

export function untracked<T>(): Tracked<T> {
  return { value: null, status: 'unknown', request: 0, error: '' };
}

// Começa uma pergunta nova. O valor anterior fica: apagá-lo aqui é justamente
// o que faz a interface piscar a cada atualização.
//
// `request` pode vir de fora quando quem pergunta precisa saber o número antes
// de o React aplicar o estado — é o caso de qualquer chamada assíncrona, que
// só consegue conferir a própria geração se já a tiver em mãos.
export function beginLoad<T>(state: Tracked<T>, request = state.request + 1): Tracked<T> {
  return {
    value: state.value,
    status: state.value === null ? 'loading' : 'refreshing',
    request,
    error: '',
  };
}

export function settle<T>(state: Tracked<T>, request: number, value: T): Tracked<T> {
  if (request !== state.request) return state;
  return { value, status: 'ready', request, error: '' };
}

// Falhar não apaga o que já se sabia. Um timeout diz que a resposta demorou,
// não que o outro lado deixou de ter aquilo.
export function failLoad<T>(state: Tracked<T>, request: number, error: string): Tracked<T> {
  if (request !== state.request) return state;
  return {
    value: state.value,
    status: state.value === null ? 'failed' : 'stale',
    request,
    error,
  };
}

export function isBusy<T>(state: Tracked<T>): boolean {
  return state.status === 'loading' || state.status === 'refreshing';
}

// Não há nada a mostrar e nenhuma falha declarada — o único caso em que faz
// sentido substituir a tela por "Carregando…". Com valor em mãos, ou com uma
// falha para explicar, a tela tem coisa melhor a dizer.
export function isBlank<T>(state: Tracked<T>): boolean {
  return state.value === null && state.status !== 'failed';
}

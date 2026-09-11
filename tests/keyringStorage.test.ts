import assert from 'node:assert/strict';
import test from 'node:test';
import type { SavedSession } from '../src/lib/keyring';

// O chaveiro ligado ao armazenamento do navegador.
//
// `keyring.test.ts` prova as decisões, que são puras. O que se prova aqui é a
// outra metade: o que acontece quando essas decisões encontram `localStorage`,
// a gaveta única de até a 0.9.5 e a leitura que roda a cada tela.

function memoria() {
  const dados = new Map<string, string>();
  return {
    get length() { return dados.size; },
    clear() { dados.clear(); },
    getItem(chave: string) { return dados.get(chave) ?? null; },
    key(indice: number) { return [...dados.keys()][indice] ?? null; },
    removeItem(chave: string) { dados.delete(chave); },
    setItem(chave: string, valor: string) { dados.set(chave, String(valor)); },
  };
}

const local = memoria();
const daAbertura = memoria();
Object.assign(globalThis, { localStorage: local, sessionStorage: daAbertura, window: { location: { protocol: 'file:' } } });

const { abandonSession, clearSession, forgetAllDestinations, loadSession, rememberedDestinations, saveSession } = await import('../src/lib/session');

function sessao(extra: Partial<SavedSession> = {}): SavedSession {
  return {
    serverUrl: 'http://127.0.0.1:3927',
    token: 'token-do-grupo',
    user: { id: 'renan', username: 'Renan' },
    serverName: 'Tumacord',
    connectionMode: 'p2p',
    rememberMe: true,
    ...extra,
  };
}

function doZero(legado?: SavedSession) {
  local.clear();
  daAbertura.clear();
  if (legado) local.setItem('tumacord.session', JSON.stringify(legado));
}

// O defeito: a gaveta única não é apagada de propósito, e a conversão rodava a
// cada leitura do chaveiro. Sair da conta apagava a sessão; a leitura seguinte
// a trazia de volta. No P2P a sessão antiga e a nova caem no mesmo destino
// (`grupo:`), e por isso sair de uma conta do modo P2P não acontecia.
test('sair de uma conta do modo P2P que veio da gaveta antiga não a traz de volta', () => {
  doZero(sessao());
  assert.equal(loadSession()?.token, 'token-do-grupo', 'a conversão restaura a sessão de quem atualizou');

  clearSession();
  assert.equal(loadSession(), null, 'sair encerra');
  assert.deepEqual(rememberedDestinations(), [], 'e a leitura seguinte não a ressuscita');
});

test('a gaveta antiga continua no disco: a conversão é que acontece uma vez só', () => {
  doZero(sessao());
  loadSession();
  clearSession();
  assert.ok(local.getItem('tumacord.session'), 'nada é apagado — perder a sessão de quem atualizou seria pior');
  assert.ok(local.getItem('tumacord.keyring.migrado'), 'o que fica registrado é que este computador já passou por aqui');
});

test('esquecer tudo não ressuscita a gaveta antiga', () => {
  doZero(sessao());
  loadSession();
  forgetAllDestinations();
  assert.deepEqual(rememberedDestinations(), []);
  assert.equal(loadSession(), null);
});

// A recuperação automática do P2P autentica antes de saber se a tela ainda
// está de pé, e autenticar grava.
test('descartar desfaz só o que aquela tentativa escreveu', () => {
  doZero();
  saveSession(sessao({ token: 'token-da-tentativa' }));
  abandonSession(sessao({ token: 'token-da-tentativa' }));
  assert.deepEqual(rememberedDestinations(), [], 'a sessão que ninguém adotou sai');

  doZero();
  saveSession(sessao({ token: 'token-mais-novo' }));
  abandonSession(sessao({ token: 'token-de-uma-tentativa-antiga' }));
  assert.equal(loadSession()?.token, 'token-mais-novo', 'uma troca de host não é desfeita por uma tentativa vencida');
});

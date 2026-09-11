// O que este computador lembra, por destino.
//
// Até a 0.9.5 havia **uma** gaveta: entrar em um servidor dedicado escrevia
// por cima do que o modo P2P lembrava, e voltar para o P2P escrevia por cima
// do servidor. Trocar de modo custava a sessão do outro, e um convite para um
// destino diferente derrubava tudo — inclusive as contas que nada tinham a ver
// com aquele convite.
//
// Agora cada destino tem a própria gaveta, endereçada pela identidade estável
// de `origin.ts`. Quatro operações, com efeitos diferentes e ditos:
//
// - **sair da conta** encerra a sessão atual e não toca nas outras;
// - **trocar de destino** só muda qual gaveta está aberta;
// - **esquecer este destino** apaga a sessão *e* a chave dele;
// - **esquecer tudo** esvazia o chaveiro.
//
// A chave do servidor mora numa gaveta própria, separada da sessão, porque
// lembrar uma não é lembrar a outra: dá para querer a sessão sem guardar a
// chave, e guardar a chave sem manter a sessão. As quatro combinações existem.
//
// Este arquivo é puro de propósito — ele recebe e devolve um chaveiro, sem
// tocar em `localStorage`. É o que permite provar as quatro combinações sem
// navegador nenhum.

import type { SessionResponse } from '../../shared/types';

export interface SavedSession {
  serverUrl: string;
  token: string;
  user: SessionResponse['user'];
  serverName: string;
  password?: string;
  resumeChannelId?: string;
  connectionMode?: 'p2p' | 'server';
  rememberMe?: boolean;
  /** Chave do convite do grupo, no P2P. É ela que identifica o grupo. */
  inviteKey?: string;
  /** Identidade da instalação dedicada, declarada por ela. */
  installationId?: string;
  /** Como o campo era gravado até a 0.9.5; lido para migrar, nunca escrito. */
  directKey?: string;
}

export interface Keyring {
  /** Sessões lembradas entre aberturas do aplicativo. */
  remembered: Record<string, SavedSession>;
  /** Sessões desta abertura só, de quem não pediu para ser lembrado. */
  ephemeral: Record<string, SavedSession>;
  /** Chaves de servidor que a pessoa pediu para lembrar, por destino. */
  keys: Record<string, string>;
  /** Destino aberto agora. */
  active: string;
}

export const emptyKeyring = (): Keyring => ({ remembered: {}, ephemeral: {}, keys: {}, active: '' });

export function sessionAt(keyring: Keyring, destination: string): SavedSession | null {
  return keyring.ephemeral[destination] ?? keyring.remembered[destination] ?? null;
}

export function activeSession(keyring: Keyring): SavedSession | null {
  return keyring.active ? sessionAt(keyring, keyring.active) : null;
}

/** Os destinos que a pessoa pode retomar sem digitar nada. */
export function destinations(keyring: Keyring): Array<{ destination: string; session: SavedSession }> {
  const vistos = new Map<string, SavedSession>();
  for (const [destination, session] of Object.entries(keyring.remembered)) vistos.set(destination, session);
  for (const [destination, session] of Object.entries(keyring.ephemeral)) vistos.set(destination, session);
  return [...vistos.entries()].map(([destination, session]) => ({ destination, session }));
}

// Guardar uma sessão nunca mexe nas outras gavetas. A escolha de lembrar
// decide em qual das duas ela entra, e tira da outra — senão uma sessão
// "esquecida" continuaria de pé por causa de uma cópia antiga.
export function putSession(keyring: Keyring, destination: string, session: SavedSession): Keyring {
  const lembrar = session.rememberMe ?? true;
  const remembered = { ...keyring.remembered };
  const ephemeral = { ...keyring.ephemeral };
  if (lembrar) {
    remembered[destination] = { ...session, rememberMe: true };
    delete ephemeral[destination];
  } else {
    ephemeral[destination] = { ...session, rememberMe: false };
    delete remembered[destination];
  }
  return { ...keyring, remembered, ephemeral, active: destination };
}

/**
 * Sair da conta.
 *
 * Encerra a sessão deste destino e fecha a gaveta. As outras continuam onde
 * estavam: sair de um servidor não é esquecer os outros. A chave guardada
 * também fica — quem sai de uma conta costuma voltar para o mesmo lugar.
 */
export function endSession(keyring: Keyring, destination: string): Keyring {
  const remembered = { ...keyring.remembered };
  const ephemeral = { ...keyring.ephemeral };
  delete remembered[destination];
  delete ephemeral[destination];
  return { ...keyring, remembered, ephemeral, active: keyring.active === destination ? '' : keyring.active };
}

/** Esquecer este destino: a sessão e a chave dele, e mais nada. */
export function forgetDestination(keyring: Keyring, destination: string): Keyring {
  const keys = { ...keyring.keys };
  delete keys[destination];
  return { ...endSession(keyring, destination), keys };
}

/**
 * Desfazer uma entrada que ninguém chegou a adotar.
 *
 * A recuperação automática do P2P autentica e grava antes de alguém dizer se
 * aquela sessão ainda serve. Quando a tela já saiu do ar — porque a pessoa
 * saiu da conta —, o que foi gravado precisa sair junto: senão "sair" vira um
 * clique que não faz nada e a conta reaparece na abertura seguinte.
 *
 * Sai só o que aquela tentativa escreveu. Se algo mais novo já ocupa o
 * destino — uma troca de host, por exemplo —, ele fica onde está.
 */
export function abandonSession(keyring: Keyring, destination: string, token: string): Keyring {
  return sessionAt(keyring, destination)?.token === token ? endSession(keyring, destination) : keyring;
}

/** Trocar de destino sem encerrar nada. */
export function switchTo(keyring: Keyring, destination: string): Keyring {
  return { ...keyring, active: destination };
}

export function rememberKey(keyring: Keyring, destination: string, key: string): Keyring {
  const limpa = key.trim();
  const keys = { ...keyring.keys };
  if (limpa) keys[destination] = limpa;
  else delete keys[destination];
  return { ...keyring, keys };
}

export function keyAt(keyring: Keyring, destination: string): string {
  return keyring.keys[destination] ?? '';
}

/** Esquecer tudo. É o único caminho que esvazia o chaveiro inteiro. */
export function forgetEverything(): Keyring {
  return emptyKeyring();
}

// A gaveta única da 0.9.5 e anteriores.
//
// Ela é lida e convertida, nunca apagada: se algo der errado na conversão,
// perder a sessão de quem atualizou seria trocar um problema por outro. O
// `directKey` era usado para duas coisas diferentes — chave de convite no P2P
// e chave de acesso no dedicado —, e aqui cada uma vai para o seu lugar.
//
// Converter é um ato único, e quem chama precisa registrar que ele aconteceu.
// Enquanto isso não era feito, a conversão rodava a cada leitura do chaveiro:
// sair da conta apagava a sessão e a leitura seguinte a trazia de volta da
// gaveta antiga. No P2P os dois lados caíam no mesmo destino — `grupo:` —, e
// por isso sair de uma conta do modo P2P simplesmente não acontecia.
export function migrateSingleSession(keyring: Keyring, legacy: SavedSession | null, destinationOf: (session: SavedSession) => string): Keyring {
  if (!legacy?.token) return keyring;
  const destination = destinationOf(legacy);
  if (sessionAt(keyring, destination)) return keyring;
  const convertida: SavedSession = {
    ...legacy,
    inviteKey: legacy.connectionMode === 'server' ? undefined : (legacy.inviteKey ?? legacy.directKey),
    directKey: undefined,
  };
  const comSessao = putSession(keyring, destination, convertida);
  // A chave de acesso do dedicado só continua lembrada se havia uma: ela não
  // é inventada aqui, e quem nunca usou chave não passa a ter uma guardada.
  const chave = legacy.connectionMode === 'server' ? (legacy.directKey ?? '') : '';
  return chave ? rememberKey(comSessao, destination, chave) : comSessao;
}

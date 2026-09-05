// Canais e categorias: validação e ordenação.
//
// O modelo anterior era `{ id, name, type }` e mais nada. Categoria, posição,
// tópico e limite de pessoas precisam existir para o painel fazer sentido, e
// todos entram como opcionais para as instalações vindas da 0.8.0
// continuarem carregando sem conversão destrutiva.
//
// A ordenação é por número inteiro esparso, e não por índice de array. Índice
// obriga a reescrever a lista inteira a cada movimento, e dois administradores
// arrastando canais ao mesmo tempo se sobrescrevem em silêncio. Com posição
// explícita, cada movimento é uma escrita pequena e o pior caso é uma ordem
// inesperada — não um canal perdido.

export type ChannelType = 'text' | 'voice';

export interface ChannelRecord {
  id: string;
  name: string;
  type: ChannelType;
  categoryId?: string;
  position?: number;
  topic?: string;
  userLimit?: number;
}

export interface CategoryRecord {
  id: string;
  name: string;
  position?: number;
}

export const MAX_CHANNEL_NAME = 32;
export const MAX_CATEGORY_NAME = 32;
export const MAX_TOPIC = 190;
export const MAX_USER_LIMIT = 99;
export const POSITION_STEP = 100;

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

// Nome de canal aceita letra, número, espaço e alguns separadores. O que sai é
// o texto limpo, não um identificador — o id é gerado à parte e nunca vem do
// cliente.
export function validateChannelName(value: unknown): ValidationResult<string> {
  if (typeof value !== 'string') return { ok: false, error: 'Informe um nome para o canal.' };
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name) return { ok: false, error: 'O nome do canal não pode ficar vazio.' };
  if (name.length > MAX_CHANNEL_NAME) return { ok: false, error: `O nome do canal cabe em ${MAX_CHANNEL_NAME} caracteres.` };
  if (!/^[\p{L}\p{N} _.\-—]+$/u.test(name)) return { ok: false, error: 'Use letras, números, espaço, hífen, ponto ou sublinhado.' };
  return { ok: true, value: name };
}

export function validateCategoryName(value: unknown): ValidationResult<string> {
  const result = validateChannelName(value);
  if (!result.ok) return { ok: false, error: result.error?.replace('canal', 'categoria') };
  if ((result.value ?? '').length > MAX_CATEGORY_NAME) return { ok: false, error: `O nome da categoria cabe em ${MAX_CATEGORY_NAME} caracteres.` };
  return result;
}

export function validateTopic(value: unknown): ValidationResult<string> {
  if (value === undefined || value === null) return { ok: true, value: '' };
  if (typeof value !== 'string') return { ok: false, error: 'Tópico inválido.' };
  const topic = value.trim();
  if (topic.length > MAX_TOPIC) return { ok: false, error: `O tópico cabe em ${MAX_TOPIC} caracteres.` };
  return { ok: true, value: topic };
}

// Limite de pessoas só faz sentido em canal de voz, e zero significa "sem
// limite" — que é diferente de "ninguém pode entrar".
export function validateUserLimit(value: unknown, type: ChannelType): ValidationResult<number | undefined> {
  if (value === undefined || value === null || value === '') return { ok: true, value: undefined };
  if (type !== 'voice') return { ok: false, error: 'Limite de pessoas vale apenas para canal de voz.' };
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0 || limit > MAX_USER_LIMIT) {
    return { ok: false, error: `Use um limite entre 0 e ${MAX_USER_LIMIT}; 0 significa sem limite.` };
  }
  return { ok: true, value: limit === 0 ? undefined : limit };
}

export function slugify(name: string): string {
  return name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Trocar o tipo de um canal que já tem conteúdo perderia esse conteúdo: uma
// conversa não vira sala de voz. Em vez de fazer silenciosamente ou proibir
// sem explicar, a regra é dita.
export function canChangeChannelType(channel: ChannelRecord, hasMessages: boolean, hasParticipants: boolean): ValidationResult<true> {
  if (hasMessages) return { ok: false, error: 'Este canal já tem mensagens. Crie um canal de voz novo em vez de converter.' };
  if (hasParticipants) return { ok: false, error: 'Há gente nesta call agora. Peça para saírem antes de converter o canal.' };
  return { ok: true, value: true };
}

// Posições esparsas: inserir entre dois vizinhos não obriga a reescrever a
// lista. Quando o espaço acaba, a faixa inteira é redistribuída.
export function nextPosition(records: readonly { position?: number }[]): number {
  const maior = records.reduce((maximo, record) => Math.max(maximo, record.position ?? 0), 0);
  return maior + POSITION_STEP;
}

export function normalizePositions<T extends { id: string; position?: number }>(records: readonly T[]): T[] {
  return records
    .map((record, index) => ({ record, index, position: record.position ?? index * POSITION_STEP }))
    .sort((a, b) => a.position - b.position || a.index - b.index)
    .map(({ record }, index) => ({ ...record, position: (index + 1) * POSITION_STEP }));
}

// Reordenar recebe a ordem desejada e devolve as posições. Ids desconhecidos
// são ignorados, e os que ficaram de fora vão para o fim preservando a ordem
// relativa — dois administradores arrastando ao mesmo tempo produzem uma
// ordem inesperada, nunca um canal sumido.
export function applyOrder<T extends { id: string; position?: number }>(records: readonly T[], orderedIds: readonly string[]): T[] {
  const conhecidos = new Map(records.map((record) => [record.id, record]));
  const ordenados: T[] = [];
  for (const id of orderedIds) {
    const record = conhecidos.get(id);
    if (!record || ordenados.some((existente) => existente.id === id)) continue;
    ordenados.push(record);
    conhecidos.delete(id);
  }
  const restantes = records.filter((record) => conhecidos.has(record.id));
  // A posição vem da ordem pedida, e não da anterior. Delegar para
  // `normalizePositions` aqui reordenaria pela posição antiga e desfaria
  // exatamente o movimento que acabou de ser solicitado.
  return [...ordenados, ...restantes].map((record, index) => ({ ...record, position: (index + 1) * POSITION_STEP }));
}

export interface ChannelTree {
  categories: Array<CategoryRecord & { channels: ChannelRecord[] }>;
  uncategorized: ChannelRecord[];
}

// A árvore que o cliente desenha. Canal cuja categoria sumiu não desaparece:
// ele cai em "sem categoria", porque perder um canal por causa de uma
// categoria apagada seria perder conversa.
export function buildChannelTree(channels: readonly ChannelRecord[], categories: readonly CategoryRecord[]): ChannelTree {
  const ordenadas = normalizePositions(categories);
  const validas = new Set(ordenadas.map((category) => category.id));
  const ordenados = normalizePositions(channels);
  return {
    categories: ordenadas.map((category) => ({
      ...category,
      channels: ordenados.filter((channel) => channel.categoryId === category.id),
    })),
    uncategorized: ordenados.filter((channel) => !channel.categoryId || !validas.has(channel.categoryId)),
  };
}

// Apagar categoria não apaga canal. Os canais dela ficam sem categoria.
export function detachCategory(channels: readonly ChannelRecord[], categoryId: string): ChannelRecord[] {
  return channels.map((channel) => (channel.categoryId === categoryId ? { ...channel, categoryId: undefined } : channel));
}

// Um servidor sem nenhum canal de texto deixa o grupo sem lugar para conversar
// e sem como recriar um pela interface normal.
export function canDeleteChannel(channels: readonly ChannelRecord[], channelId: string): ValidationResult<true> {
  const alvo = channels.find((channel) => channel.id === channelId);
  if (!alvo) return { ok: false, error: 'Esse canal não existe mais.' };
  if (alvo.type !== 'text') return { ok: true, value: true };
  const outrosTexto = channels.filter((channel) => channel.type === 'text' && channel.id !== channelId);
  if (!outrosTexto.length) return { ok: false, error: 'Este é o último canal de texto. Crie outro antes de apagar este.' };
  return { ok: true, value: true };
}

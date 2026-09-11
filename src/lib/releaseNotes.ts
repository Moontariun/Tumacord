// As notas de uma versão, como elas são escritas e como elas são lidas.
//
// O que sai da página de Releases do GitHub é o Markdown do CHANGELOG. Mostrar
// esse texto cru numa janela do aplicativo deixaria `**assim**` e `- assim` na
// cara de quem só quer saber o que mudou; interpretar HTML de um texto que veio
// da rede é o outro extremo, e esse não é negociável — nada aqui vira HTML.
//
// O meio-termo é este: o Markdown é lido em blocos e cada bloco vira texto
// puro, que a interface desenha com os próprios elementos. Um marcador que
// este leitor não conheça simplesmente sobrevive como texto — nunca some, e
// nunca vira tag.

export interface NoteBlock {
  kind: 'heading' | 'paragraph' | 'item' | 'quote';
  text: string;
}

// O que o aplicativo mostra, e o que fica na página da versão.
//
// O CHANGELOG deste projeto conta a história inteira: por que a decisão foi
// tomada, o que estava errado antes, onde o defeito aparecia. Isso é escrito
// para quem lê o repositório — e é demais para uma janela que abre sozinha
// dizendo "o que mudou". Quem só quer usar o aplicativo não precisa saber o
// nome do arquivo que mudou nem por que a referência era esquecida no meio do
// arrasto.
//
// Então cada versão traz, no começo da própria seção, um resumo entre
// marcadores. O aplicativo mostra o resumo; a página de Releases continua
// mostrando tudo, porque os marcadores são comentários e não aparecem lá.
// Versão sem resumo cai no texto inteiro, que é como era antes.
const RESUMO = /<!--\s*tumacord:resumo\s*-->([\s\S]*?)<!--\s*\/tumacord:resumo\s*-->/i;

export function readReleaseSummary(markdown: unknown): NoteBlock[] {
  if (typeof markdown !== 'string') return [];
  const trecho = RESUMO.exec(markdown)?.[1];
  return trecho ? readReleaseNotes(trecho) : [];
}

/** O resumo quando ele existe; o texto inteiro quando não. */
export function readReleaseHighlights(markdown: unknown): { blocks: NoteBlock[]; summarized: boolean } {
  const resumo = readReleaseSummary(markdown);
  return resumo.length ? { blocks: resumo, summarized: true } : { blocks: readReleaseNotes(markdown), summarized: false };
}

// `**forte**`, `*ênfase*`, `` `código` `` e `[texto](endereço)` viram o texto
// que eles marcam. O endereço do link fica junto, entre parênteses: ele é
// informação, e escondê-lo tiraria de quem lê a chance de digitá-lo.
function inline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '$1 ($2)')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s.,;:)!?]|$)/g, '$1$2')
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s.,;:)!?]|$)/g, '$1$2')
    .trim();
}

export function readReleaseNotes(markdown: unknown): NoteBlock[] {
  if (typeof markdown !== 'string' || !markdown.trim()) return [];
  const blocos: NoteBlock[] = [];
  // Um parágrafo pode ocupar várias linhas no CHANGELOG — ele é escrito com a
  // margem em 80 colunas. Juntar as linhas é o que devolve o parágrafo.
  let paragrafo: string[] = [];
  const fecharParagrafo = () => {
    if (!paragrafo.length) return;
    const texto = inline(paragrafo.join(' '));
    if (texto) blocos.push({ kind: 'paragraph', text: texto });
    paragrafo = [];
  };

  for (const linhaBruta of markdown.replace(/\r\n/g, '\n').split('\n')) {
    const linha = linhaBruta.trim();
    if (!linha) {
      fecharParagrafo();
      continue;
    }
    // Uma linha inteira em negrito é como este CHANGELOG escreve subtítulo.
    const titulo = /^#{1,6}\s+(.*)$/.exec(linha) ?? /^\*\*(.+)\*\*:?$/.exec(linha);
    if (titulo) {
      fecharParagrafo();
      const texto = inline(titulo[1]);
      if (texto) blocos.push({ kind: 'heading', text: texto });
      continue;
    }
    const item = /^[-*+]\s+(.*)$/.exec(linha);
    if (item) {
      fecharParagrafo();
      const texto = inline(item[1]);
      if (texto) blocos.push({ kind: 'item', text: texto });
      continue;
    }
    const citacao = /^>\s?(.*)$/.exec(linha);
    if (citacao) {
      fecharParagrafo();
      const texto = inline(citacao[1]);
      if (texto) blocos.push({ kind: 'quote', text: texto });
      continue;
    }
    // Linha de separação (`---`) não carrega texto nenhum.
    if (/^([-*_])\1{2,}$/.test(linha.replace(/\s/g, ''))) {
      fecharParagrafo();
      continue;
    }
    // Comentário do Markdown é recado para quem escreve, não para quem lê: os
    // marcadores deste projeto viajam assim, e antes disso apareciam na tela
    // como um parágrafo de texto cru.
    if (/^<!--[\s\S]*-->$/.test(linha)) {
      fecharParagrafo();
      continue;
    }
    // Um item de lista escrito em mais de uma linha continua sendo um item.
    // Sem isto, a segunda linha virava um parágrafo solto embaixo dele — e a
    // margem de 80 colunas deste CHANGELOG faz isso o tempo todo.
    const ultimo = blocos[blocos.length - 1];
    if (!paragrafo.length && ultimo?.kind === 'item') {
      ultimo.text = inline(`${ultimo.text} ${linha}`);
      continue;
    }
    paragrafo.push(linha);
  }
  fecharParagrafo();
  return blocos;
}

// Tamanho de arquivo para quem vai esperar o download. Duas casas só onde elas
// significam alguma coisa: "112,4 MB" ajuda, "112,40 MB" não.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} kB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0).replace('.', ',')} MB`;
  return `${(mb / 1024).toFixed(1).replace('.', ',')} GB`;
}

// "há 2 dias" diz mais do que uma data para quem está decidindo se atualiza
// agora. Datas antigas voltam a ser datas, que é quando elas voltam a informar.
export function describePublished(iso: string, now = Date.now()): string {
  const at = Date.parse(typeof iso === 'string' ? iso : '');
  if (!Number.isFinite(at)) return '';
  const dias = Math.floor((now - at) / 86_400_000);
  if (dias < 0) return '';
  if (dias === 0) return 'publicada hoje';
  if (dias === 1) return 'publicada ontem';
  if (dias < 30) return `publicada há ${dias} dias`;
  return `publicada em ${new Date(at).toLocaleDateString('pt-BR')}`;
}

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

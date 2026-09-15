import { useEffect, useState } from 'react';
import { previewableLinks, splitLinks } from '../lib/links';

// Links clicáveis e a prévia do que há do outro lado, como no Discord.

export interface LinkPreviewData {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
}

// Uma busca por endereço, por sessão do aplicativo. A promessa fica guardada
// e não o resultado: dez mensagens com o mesmo link fazem um pedido só, e um
// canal reaberto não busca de novo.
const cache = new Map<string, Promise<LinkPreviewData | null>>();

function fetchPreview(serverUrl: string, token: string, url: string): Promise<LinkPreviewData | null> {
  const chave = `${serverUrl}\n${url}`;
  const guardada = cache.get(chave);
  if (guardada) return guardada;
  const pedido = fetch(`${serverUrl}/api/link-preview?url=${encodeURIComponent(url)}`, { headers: { authorization: `Bearer ${token}` } })
    .then(async (resposta) => {
      // Um servidor anterior à 0.13.5 responde 404, e um pedido recusado por
      // excesso responde 429. Nos dois casos a mensagem fica sem prévia — e o
      // 429 sai do cache, para a prévia aparecer quando o canal for reaberto.
      if (resposta.status === 429) cache.delete(chave);
      if (!resposta.ok) return null;
      const corpo = await resposta.json() as { preview?: LinkPreviewData | null };
      return corpo.preview ?? null;
    })
    .catch(() => { cache.delete(chave); return null; });
  cache.set(chave, pedido);
  return pedido;
}

/** O texto da mensagem, com os endereços virando links. */
export function MessageText({ body }: { body: string }) {
  return <>{splitLinks(body).map((part, index) => part.kind === 'link'
    ? <a key={index} href={part.href} target="_blank" rel="noopener noreferrer nofollow" className="message-link" title={part.href}>{part.text}</a>
    : <span key={index}>{part.text}</span>)}</>;
}

export function LinkPreviews({ body, serverUrl, token }: { body: string; serverUrl: string; token: string }) {
  const links = previewableLinks(body);
  if (!links.length) return null;
  return <div className="link-previews">{links.map((url) => <LinkPreviewCard key={url} url={url} serverUrl={serverUrl} token={token} />)}</div>;
}

function LinkPreviewCard({ url, serverUrl, token }: { url: string; serverUrl: string; token: string }) {
  const [preview, setPreview] = useState<LinkPreviewData | null>(null);
  useEffect(() => {
    let vivo = true;
    void fetchPreview(serverUrl, token, url).then((dados) => { if (vivo) setPreview(dados); });
    return () => { vivo = false; };
  }, [serverUrl, token, url]);
  if (!preview || (!preview.title && !preview.description && !preview.image)) return null;
  // Só imagem embutida entra. Um endereço de fora faria o aplicativo de cada
  // pessoa ir buscá-la, entregando o IP de todo mundo ao site do link.
  const imagem = preview.image && /^data:image\/(png|jpe?g|gif|webp);base64,/i.test(preview.image) ? preview.image : undefined;
  const soImagem = imagem && !preview.description && (!preview.title || /\.(png|jpe?g|gif|webp)$/i.test(preview.title));
  return <div className={`link-preview ${soImagem ? 'is-image' : ''}`}>
    <div className="link-preview-copy">
      {preview.siteName && <small>{preview.siteName}</small>}
      {preview.title && !soImagem && <a href={url} target="_blank" rel="noopener noreferrer nofollow">{preview.title}</a>}
      {preview.description && <p>{preview.description}</p>}
    </div>
    {imagem && <a className="link-preview-image" href={url} target="_blank" rel="noopener noreferrer nofollow"><img src={imagem} alt={preview.title ?? ''} loading="lazy" /></a>}
  </div>;
}

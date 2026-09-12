// Montar o próximo catálogo a partir do que está publicado.
//
// ## Onde o catálogo mora
//
// O estado do catálogo vive no **ambiente de publicação**, ao lado das chaves
// — e não na VPS. O motivo é que só aqui ele pode ser produzido: a VPS guarda
// e serve o que já chegou assinado, e não sabe assinar nada. Guardar a
// referência lá seria guardar uma cópia de algo que ela não consegue reproduzir.
//
// A consequência prática: **um ambiente de publicação**, e o estado dele faz
// parte do backup. Perder esse arquivo não perde as versões publicadas — elas
// continuam na VPS e podem ser buscadas de volta por `GET /admin/catalog` —,
// mas rebuildar às cegas produziria uma sequência que anda para trás, e um
// catálogo assim é recusado pelo serviço e pelos clientes.
//
// ## A sequência
//
// Ela só cresce, e cresce **a cada publicação** — inclusive numa retirada, que
// não oferece nada novo. Ela é a defesa contra repetição: um serviço que
// voltasse no tempo reoferecia uma versão que o grupo já deixou para trás.
//
// A sequência do catálogo não é a ordem da versão do produto. São perguntas
// diferentes: uma diz "este catálogo é mais recente", a outra diz "esta build
// é mais nova".

/** Um catálogo vazio, para o primeiro arranque. */
export function emptyCatalog({ contract, now = Date.now(), ttlMs }) {
  return {
    contract,
    sequence: 0,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    channels: { stable: { entries: [] }, test: { entries: [] } },
  };
}

/**
 * O próximo catálogo, com uma versão publicada.
 *
 * Republicar a **mesma** release sob o mesmo número é permitido — é o que
 * acontece ao renovar a validade. Publicar o mesmo número apontando para
 * **outra** release é recusado: metade do grupo ficaria numa 0.9.9-1 e a outra
 * metade noutra, com o mesmo nome, e sem jeito de distinguir olhando a versão.
 */
export function withRelease(current, { manifest, manifestSha256, channel, now = Date.now(), ttlMs }) {
  const entries = (current.channels?.[channel]?.entries ?? []).slice();
  const existing = entries.findIndex((entry) => entry.version === manifest.version);

  if (existing >= 0 && entries[existing].releaseId !== manifest.releaseId) {
    throw new Error(
      `A versão ${manifest.version} já está publicada apontando para ${entries[existing].releaseId}. `
      + 'Um número publicado não volta a ser usado para conteúdo diferente — escolha a próxima revisão.',
    );
  }

  const entry = {
    releaseId: manifest.releaseId,
    version: manifest.version,
    state: 'published',
    publishedAt: existing >= 0 ? entries[existing].publishedAt : new Date(now).toISOString(),
    manifestSha256,
    ...(manifest.requiredStop ? { requiredStop: manifest.requiredStop } : {}),
  };
  if (existing >= 0) entries[existing] = entry;
  else entries.push(entry);

  return {
    ...current,
    sequence: current.sequence + 1,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    channels: { ...current.channels, [channel]: { entries } },
  };
}

/**
 * O próximo catálogo, com uma versão retirada.
 *
 * Retirar não apaga: os bytes continuam no armazenamento e quem já baixou
 * continua com o arquivo. O que muda é que ninguém volta a receber a oferta, e
 * downloads novos são recusados — inclusive nas máquinas que já estavam na rua
 * quando o defeito apareceu.
 */
export function withWithdrawal(current, { releaseId, reason, channel, now = Date.now(), ttlMs }) {
  const entries = current.channels?.[channel]?.entries ?? [];
  if (!entries.some((entry) => entry.releaseId === releaseId)) {
    throw new Error(`A release ${releaseId} não está publicada no canal ${channel}; não há o que retirar.`);
  }
  if (!reason?.trim()) {
    // O motivo aparece na tela de quem tentar instalar. Sem ele, a pessoa vê
    // uma versão sumir e não sabe se o problema é dela.
    throw new Error('A retirada precisa de um motivo: ele aparece na tela de quem tentar instalar.');
  }
  return {
    ...current,
    sequence: current.sequence + 1,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlMs).toISOString(),
    channels: {
      ...current.channels,
      [channel]: {
        entries: entries.map((entry) => (entry.releaseId === releaseId
          ? { ...entry, state: 'withdrawn', withdrawn: { reason: reason.trim(), at: new Date(now).toISOString() } }
          : entry)),
      },
    },
  };
}

/**
 * Confere que o próximo catálogo pode substituir o atual.
 *
 * As mesmas recusas que o serviço aplica, feitas **aqui** para o erro aparecer
 * antes da publicação em vez de depois — e com a mensagem que ajuda a resolver.
 */
export function validateNext(next, current) {
  if (current && next.sequence <= current.sequence) {
    return `A sequência precisa crescer: a publicada é ${current.sequence} e esta é ${next.sequence}.`;
  }
  for (const [channel, content] of Object.entries(next.channels ?? {})) {
    const seen = new Set();
    for (const entry of content?.entries ?? []) {
      if (!entry?.version || !entry?.releaseId) return `Uma entrada do canal ${channel} está incompleta.`;
      if (seen.has(entry.version)) return `A versão ${entry.version} aparece duas vezes no canal ${channel}.`;
      seen.add(entry.version);
    }
  }
  return '';
}

const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export function safeAttachmentName(value: unknown, fallback = 'arquivo'): string {
  if (typeof value !== 'string') return fallback;
  const leaf = value.normalize('NFKC').replaceAll('\\', '/').split('/').pop() ?? '';
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().replace(/[. ]+$/g, '').slice(0, 200);
  if (!cleaned) return fallback;
  return WINDOWS_RESERVED_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
}

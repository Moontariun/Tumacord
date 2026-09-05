// Preferências de rede do processo principal.
//
// Elas moram fora do navegador porque quem precisa delas primeiro é a
// descoberta e o enlace direto, que já estão de pé antes de a interface
// carregar. O arquivo é pequeno de propósito: um erro de leitura devolve o
// padrão em vez de impedir o aplicativo de abrir.

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const DEFAULT_STUN_SERVERS = [
  'stun:stun.l.google.com:19302',
  'stun:stun1.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

// O ZeroTier deixa de ser exigência e vira escolha: quem já tem a rede montada
// liga aqui e continua como antes; quem não tem nunca precisa instalar nada.
const DEFAULTS = {
  zeroTierEnabled: false,
  portMapping: true,
  stunEnabled: true,
  stunServers: DEFAULT_STUN_SERVERS,
  // Chave própria do convite. Ela precisa sobreviver a reinício: um código
  // entregue ontem tem de continuar abrindo a call hoje.
  directKey: '',
};

function sanitize(input) {
  const source = input && typeof input === 'object' ? input : {};
  const servers = Array.isArray(source.stunServers)
    ? source.stunServers.filter((server) => typeof server === 'string' && server.trim()).map((server) => server.trim()).slice(0, 8)
    : DEFAULTS.stunServers;
  const key = typeof source.directKey === 'string' ? source.directKey.trim() : '';
  return {
    zeroTierEnabled: typeof source.zeroTierEnabled === 'boolean' ? source.zeroTierEnabled : DEFAULTS.zeroTierEnabled,
    portMapping: typeof source.portMapping === 'boolean' ? source.portMapping : DEFAULTS.portMapping,
    stunEnabled: typeof source.stunEnabled === 'boolean' ? source.stunEnabled : DEFAULTS.stunEnabled,
    stunServers: servers.length ? servers : DEFAULTS.stunServers,
    directKey: key.length >= 22 && key.length <= 256 ? key : '',
  };
}

function readNetworkPreferences(file) {
  let preferences;
  try {
    preferences = sanitize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch {
    preferences = { ...DEFAULTS };
  }
  if (preferences.directKey) return preferences;
  return writeNetworkPreferences(file, { ...preferences, directKey: randomBytes(24).toString('base64url') });
}

function writeNetworkPreferences(file, preferences) {
  const next = sanitize(preferences);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    // Preferência que não persiste ainda vale para esta sessão; travar o app
    // por causa de um disco cheio seria uma troca ruim.
  }
  return next;
}

module.exports = { DEFAULTS, DEFAULT_STUN_SERVERS, readNetworkPreferences, sanitize, writeNetworkPreferences };

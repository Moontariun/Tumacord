// A credencial deste dispositivo para baixar atualizações.
//
// ## Onde ela mora
//
// No mecanismo seguro do sistema, pelo `safeStorage` do Electron — que usa o
// chaveiro do sistema operacional. Quando ele não está disponível — uma sessão
// sem chaveiro no Linux é o caso comum —, há um **fallback explícito**: o
// token não é guardado em claro, e o aplicativo pede a inscrição de novo.
//
// Guardar em claro "porque o chaveiro não deu" seria a escolha errada: o
// arquivo de configuração de um aplicativo é lido por qualquer coisa que rode
// como aquele usuário, e a credencial baixa binário privado do grupo.
//
// ## O que ela é, e o que ela não é
//
// Ela **só baixa**. Não publica, não retira versão, não aplica nada no
// servidor e não é a sessão do chat — o serviço de atualização precisa
// funcionar enquanto o dedicado reinicia, que é exatamente o momento de uma
// atualização.

const fs = require('node:fs');
const path = require('node:path');

const FILE = 'update-device.json';

/** O que o disco guarda. O token só existe aqui em forma cifrada. */
function filePath(userDataPath) {
  return path.join(userDataPath, FILE);
}

/**
 * Lê a credencial guardada.
 *
 * Devolve `{ token: '', reason }` quando não há — e a razão é dita, porque
 * "não tenho credencial" e "não consigo ler a credencial que tenho" levam a
 * caminhos diferentes: o primeiro pede um convite, o segundo pode ser só um
 * chaveiro trancado.
 */
function readDeviceCredential({ userDataPath, safeStorage }) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath(userDataPath), 'utf8'));
  } catch {
    return { token: '', deviceId: '', reason: 'missing' };
  }
  if (!raw || typeof raw !== 'object') return { token: '', deviceId: '', reason: 'corrupt' };

  const deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : '';
  const expiresAt = Number.isFinite(raw.expiresAt) ? Number(raw.expiresAt) : 0;

  if (typeof raw.encrypted !== 'string' || !raw.encrypted) return { token: '', deviceId, reason: 'corrupt' };
  if (!safeStorage?.isEncryptionAvailable?.()) {
    // O token existe e está cifrado, mas o chaveiro não está disponível agora.
    // Isso não é "sem credencial": é "não consigo abri-la nesta sessão".
    return { token: '', deviceId, expiresAt, reason: 'keyring-unavailable' };
  }
  try {
    const token = safeStorage.decryptString(Buffer.from(raw.encrypted, 'base64'));
    return { token, deviceId, expiresAt, reason: '' };
  } catch {
    // Cifrada por outro perfil, outra máquina, ou depois de o chaveiro ser
    // recriado. O token não volta, e insistir seria pedir para falhar de novo.
    return { token: '', deviceId, expiresAt, reason: 'cannot-decrypt' };
  }
}

/**
 * Guarda a credencial.
 *
 * **Sem chaveiro, não guarda.** Devolve o que houve para a tela poder dizer:
 * a inscrição funcionou, mas ela não sobrevive ao fechamento do aplicativo, e
 * é melhor a pessoa saber disso agora do que na próxima abertura.
 */
function writeDeviceCredential({ userDataPath, safeStorage }, { token, deviceId, expiresAt }) {
  if (!token) throw new Error('Credencial vazia não é guardada.');
  if (!safeStorage?.isEncryptionAvailable?.()) {
    return {
      saved: false,
      reason: 'keyring-unavailable',
      message: 'Este sistema não ofereceu um lugar seguro para guardar a credencial, então ela não foi gravada. O aplicativo continua atualizando nesta sessão; na próxima abertura será preciso um convite novo.',
    };
  }
  fs.mkdirSync(userDataPath, { recursive: true });
  const contents = {
    deviceId: String(deviceId ?? ''),
    expiresAt: Number.isFinite(expiresAt) ? Number(expiresAt) : 0,
    encrypted: safeStorage.encryptString(String(token)).toString('base64'),
  };
  fs.writeFileSync(filePath(userDataPath), `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  return { saved: true, reason: '', message: '' };
}

/** Apaga a credencial. Usado quando o serviço diz que ela foi revogada. */
function clearDeviceCredential({ userDataPath }) {
  try {
    fs.rmSync(filePath(userDataPath), { force: true });
    return true;
  } catch {
    return false;
  }
}

/** As mensagens de cada situação, em português, porque elas vão para a tela. */
const MESSAGES = {
  missing: 'Este dispositivo ainda não foi autorizado a baixar atualizações. Peça um convite ao dono do servidor.',
  corrupt: 'A credencial guardada está ilegível. Peça um convite novo ao dono do servidor.',
  'keyring-unavailable': 'Não consegui abrir o lugar seguro onde a credencial está guardada. Se o seu sistema pede uma senha para destravar o chaveiro, destrave e tente de novo.',
  'cannot-decrypt': 'A credencial guardada foi cifrada por outra sessão e não abre mais. Peça um convite novo ao dono do servidor.',
};

/** Se vale a pena renovar agora. Renovar cedo evita perder o prazo offline. */
function shouldRenew(expiresAt, now = Date.now(), leadTimeMs = 7 * 24 * 60 * 60 * 1000) {
  if (!Number.isFinite(expiresAt) || expiresAt <= 0) return false;
  return expiresAt - now <= leadTimeMs;
}

module.exports = {
  FILE,
  MESSAGES,
  clearDeviceCredential,
  readDeviceCredential,
  shouldRenew,
  writeDeviceCredential,
};

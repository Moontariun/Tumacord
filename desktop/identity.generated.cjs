// ATENÇÃO: arquivo gerado por scripts/generate-version.mjs a partir de
// shared/version.ts. Não edite aqui — a edição seria perdida na próxima
// geração, e `tests/version.test.ts` falha quando os dois divergem.
//
// A política de versão do Tumacord tem uma implementação só. Esta é a
// adaptação CJS dela, para o processo principal do Electron, que carrega
// `desktop/*.cjs` sem bundler.

"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// shared/identity.ts
var identity_exports = {};
__export(identity_exports, {
  CLOCK_SKEW_MS: () => CLOCK_SKEW_MS,
  IDENTITY_CONTRACT: () => IDENTITY_CONTRACT,
  LOCAL_NETWORK_GROUP: () => LOCAL_NETWORK_GROUP,
  LOGIN_MESSAGES: () => LOGIN_MESSAGES,
  MAX_BATCH: () => MAX_BATCH,
  MAX_RECORDS_PER_GROUP: () => MAX_RECORDS_PER_GROUP,
  NONCE_TTL_MS: () => NONCE_TTL_MS,
  claimMessage: () => claimMessage,
  claimShapeIsValid: () => claimShapeIsValid,
  decideLogin: () => decideLogin,
  emptyLedger: () => emptyLedger,
  isGroupId: () => isGroupId,
  isNonce: () => isNonce,
  isReleased: () => isReleased,
  loginMessage: () => loginMessage,
  loginProofShapeIsValid: () => loginProofShapeIsValid,
  mergeLedger: () => mergeLedger,
  normalizeName: () => normalizeName,
  recordsForSync: () => recordsForSync,
  releaseMessage: () => releaseMessage,
  releaseShapeIsValid: () => releaseShapeIsValid,
  statusOfName: () => statusOfName,
  verifyClaim: () => verifyClaim,
  verifyLoginProof: () => verifyLoginProof,
  verifyRelease: () => verifyRelease
});
module.exports = __toCommonJS(identity_exports);
var IDENTITY_CONTRACT = 1;
var LOCAL_NETWORK_GROUP = "local-network";
var MAX_BATCH = 200;
var MAX_RECORDS_PER_GROUP = 5e3;
var CLOCK_SKEW_MS = 5 * 6e4;
var NONCE_TTL_MS = 6e4;
var CLAIM_DOMAIN = "tumacord/identity/claim/v1";
var RELEASE_DOMAIN = "tumacord/identity/release/v1";
var LOGIN_DOMAIN = "tumacord/identity/login/v1";
function emptyLedger() {
  return { entries: [], releases: [], sequence: 0 };
}
function normalizeName(name) {
  return name.normalize("NFKC").trim().toLocaleLowerCase("pt-BR");
}
var BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
var NONCE = /^[A-Za-z0-9_-]{16,128}$/;
function hasControlCharacter(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
function isGroupId(value) {
  return value === LOCAL_NETWORK_GROUP || typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
function isNonce(value) {
  return typeof value === "string" && NONCE.test(value);
}
function isName(value) {
  return typeof value === "string" && value.length >= 1 && value.length <= 64 && value === value.trim() && !hasControlCharacter(value);
}
function isEncoded(value, max) {
  return typeof value === "string" && value.length >= 4 && value.length <= max && BASE64.test(value);
}
function isInstant(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}
function canonical(fields) {
  const ordered = {};
  for (const key of Object.keys(fields).sort()) ordered[key] = fields[key];
  return JSON.stringify(ordered);
}
function claimMessage(claim) {
  return [CLAIM_DOMAIN, canonical({
    contract: claim.contract,
    group: claim.group,
    name: claim.name,
    displayName: claim.displayName,
    publicKey: claim.publicKey,
    issuedAt: claim.issuedAt,
    legacy: claim.legacy
  })].join("\n");
}
function releaseMessage(release) {
  return [RELEASE_DOMAIN, canonical({
    contract: release.contract,
    group: release.group,
    name: release.name,
    publicKey: release.publicKey,
    releasedAt: release.releasedAt
  })].join("\n");
}
function loginMessage(proof) {
  return [LOGIN_DOMAIN, canonical({ group: proof.group, name: proof.name, nonce: proof.nonce, publicKey: proof.publicKey })].join("\n");
}
function claimShapeIsValid(value) {
  if (!value || typeof value !== "object") return false;
  const claim = value;
  return claim.contract === IDENTITY_CONTRACT && isGroupId(claim.group) && isName(claim.name) && isName(claim.displayName) && isEncoded(claim.publicKey, 128) && isInstant(claim.issuedAt) && typeof claim.legacy === "boolean" && isEncoded(claim.signature, 128);
}
function releaseShapeIsValid(value) {
  if (!value || typeof value !== "object") return false;
  const release = value;
  return release.contract === IDENTITY_CONTRACT && isGroupId(release.group) && isName(release.name) && isEncoded(release.publicKey, 128) && isInstant(release.releasedAt) && isEncoded(release.signature, 128);
}
function loginProofShapeIsValid(value) {
  if (!value || typeof value !== "object") return false;
  const proof = value;
  return isGroupId(proof.group) && isName(proof.name) && isNonce(proof.nonce) && isEncoded(proof.publicKey, 128) && isEncoded(proof.signature, 128);
}
function safely(check) {
  try {
    return check() === true;
  } catch {
    return false;
  }
}
function verifyClaim(value, verify) {
  if (!claimShapeIsValid(value)) return false;
  const claim = value;
  return safely(() => verify(claim.publicKey, claimMessage(claim), claim.signature));
}
function verifyRelease(value, verify) {
  if (!releaseShapeIsValid(value)) return false;
  const release = value;
  return safely(() => verify(release.publicKey, releaseMessage(release), release.signature));
}
function verifyLoginProof(value, verify) {
  if (!loginProofShapeIsValid(value)) return false;
  const proof = value;
  return safely(() => verify(proof.publicKey, loginMessage(proof), proof.signature));
}
function isReleased(claim, releases) {
  const issued = Date.parse(claim.issuedAt);
  return releases.some(({ release }) => release.group === claim.group && release.name === claim.name && release.publicKey === claim.publicKey && Date.parse(release.releasedAt) >= issued);
}
function precedes(left, right) {
  return Date.parse(left.firstSeenAt) - Date.parse(right.firstSeenAt) || left.sequence - right.sequence || (left.claim.publicKey < right.claim.publicKey ? -1 : left.claim.publicKey > right.claim.publicKey ? 1 : 0);
}
function statusOfName(ledger, group, name) {
  const byKey = /* @__PURE__ */ new Map();
  for (const entry of ledger.entries) {
    if (entry.claim.group !== group || entry.claim.name !== name) continue;
    if (isReleased(entry.claim, ledger.releases)) continue;
    const current = byKey.get(entry.claim.publicKey);
    if (!current || precedes(entry, current) < 0) byKey.set(entry.claim.publicKey, entry);
  }
  const ordered = [...byKey.values()].sort(precedes);
  if (!ordered.length) return { state: "free" };
  if (ordered.length === 1) return { state: "bound", holder: ordered[0] };
  return { state: "contested", holder: ordered[0], contenders: ordered.slice(1) };
}
function mergeLedger(current, incoming, options) {
  const entries = [...current.entries];
  const releases = [...current.releases];
  let sequence = current.sequence;
  const added = [];
  const releasedNow = [];
  const rejected = [];
  const capacity = options.maxRecordsPerGroup ?? MAX_RECORDS_PER_GROUP;
  const firstSeenAt = new Date(options.now).toISOString();
  const counts = /* @__PURE__ */ new Map();
  for (const entry of entries) counts.set(entry.claim.group, (counts.get(entry.claim.group) ?? 0) + 1);
  for (const entry of releases) counts.set(entry.release.group, (counts.get(entry.release.group) ?? 0) + 1);
  const full = (group) => (counts.get(group) ?? 0) >= capacity;
  const occupy = (group) => counts.set(group, (counts.get(group) ?? 0) + 1);
  const incomingReleases = Array.isArray(incoming.releases) ? incoming.releases : [];
  const incomingClaims = Array.isArray(incoming.claims) ? incoming.claims : [];
  for (let index = MAX_BATCH; index < incomingReleases.length; index += 1) rejected.push({ reason: "limit" });
  for (let index = MAX_BATCH; index < incomingClaims.length; index += 1) rejected.push({ reason: "limit" });
  for (const candidate of incomingReleases.slice(0, MAX_BATCH)) {
    if (!releaseShapeIsValid(candidate)) {
      rejected.push({ reason: "shape" });
      continue;
    }
    if (!options.acceptedGroups.has(candidate.group)) {
      rejected.push({ reason: "group", name: candidate.name });
      continue;
    }
    if (Date.parse(candidate.releasedAt) > options.now + CLOCK_SKEW_MS) {
      rejected.push({ reason: "future", name: candidate.name });
      continue;
    }
    if (!verifyRelease(candidate, options.verify)) {
      rejected.push({ reason: "signature", name: candidate.name });
      continue;
    }
    if (releases.some((entry2) => entry2.release.signature === candidate.signature)) continue;
    if (full(candidate.group)) {
      rejected.push({ reason: "capacity", name: candidate.name });
      continue;
    }
    sequence += 1;
    const entry = { release: candidate, firstSeenAt, sequence };
    releases.push(entry);
    releasedNow.push(entry);
    occupy(candidate.group);
  }
  for (const candidate of incomingClaims.slice(0, MAX_BATCH)) {
    if (!claimShapeIsValid(candidate)) {
      rejected.push({ reason: "shape" });
      continue;
    }
    if (!options.acceptedGroups.has(candidate.group)) {
      rejected.push({ reason: "group", name: candidate.name });
      continue;
    }
    if (Date.parse(candidate.issuedAt) > options.now + CLOCK_SKEW_MS) {
      rejected.push({ reason: "future", name: candidate.name });
      continue;
    }
    if (!verifyClaim(candidate, options.verify)) {
      rejected.push({ reason: "signature", name: candidate.name });
      continue;
    }
    if (entries.some((entry2) => entry2.claim.signature === candidate.signature)) continue;
    if (isReleased(candidate, releases)) {
      rejected.push({ reason: "released", name: candidate.name });
      continue;
    }
    if (entries.some((entry2) => entry2.claim.group === candidate.group && entry2.claim.name === candidate.name && entry2.claim.publicKey === candidate.publicKey && !isReleased(entry2.claim, releases))) continue;
    if (full(candidate.group)) {
      rejected.push({ reason: "capacity", name: candidate.name });
      continue;
    }
    sequence += 1;
    const entry = { claim: candidate, firstSeenAt, sequence };
    entries.push(entry);
    added.push(entry);
    occupy(candidate.group);
  }
  return { ledger: { entries, releases, sequence }, added, released: releasedNow, rejected };
}
function recordsForSync(ledger, groups, after = 0, limit = MAX_BATCH) {
  const pending = [
    ...ledger.releases.filter((entry) => groups.has(entry.release.group) && entry.sequence > after).map((entry) => ({ sequence: entry.sequence, release: entry.release })),
    ...ledger.entries.filter((entry) => groups.has(entry.claim.group) && entry.sequence > after).map((entry) => ({ sequence: entry.sequence, claim: entry.claim }))
  ].sort((left, right) => left.sequence - right.sequence);
  const page = pending.slice(0, Math.max(1, limit));
  return {
    claims: page.flatMap((item) => item.claim ? [item.claim] : []),
    releases: page.flatMap((item) => item.release ? [item.release] : []),
    next: pending.length > page.length ? page[page.length - 1].sequence : 0
  };
}
function decideLogin(status, proof) {
  if (proof && !proof.valid) return { allow: false, status: 401, reason: "bad-proof" };
  if (status.state === "free") return { allow: true, binding: proof ? "new" : "none", provisional: false };
  if (!proof) return { allow: false, status: 426, reason: "proof-required" };
  if (status.state === "bound") {
    return status.holder.claim.publicKey === proof.publicKey ? { allow: true, binding: "existing", provisional: false } : { allow: false, status: 409, reason: "claimed-by-other" };
  }
  if (status.holder.claim.publicKey === proof.publicKey) return { allow: true, binding: "existing", provisional: true };
  return status.contenders.some((entry) => entry.claim.publicKey === proof.publicKey) ? { allow: false, status: 409, reason: "contested" } : { allow: false, status: 409, reason: "claimed-by-other" };
}
var LOGIN_MESSAGES = {
  "proof-required": "Esse nome est\xE1 vinculado a uma identidade neste grupo, e esta c\xF3pia do Tumacord n\xE3o sabe prov\xE1-la. Atualize o aplicativo para entrar com ele.",
  "claimed-by-other": "Esse nome pertence a outra pessoa neste grupo. Entre com outro nome.",
  contested: "Esse nome foi reivindicado por dois dispositivos enquanto o grupo estava dividido, e o outro chegou primeiro a este host. At\xE9 um dos dois liberar o nome, entre com outro.",
  "bad-proof": "A prova de identidade deste dispositivo n\xE3o confere. Tente entrar de novo."
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CLOCK_SKEW_MS,
  IDENTITY_CONTRACT,
  LOCAL_NETWORK_GROUP,
  LOGIN_MESSAGES,
  MAX_BATCH,
  MAX_RECORDS_PER_GROUP,
  NONCE_TTL_MS,
  claimMessage,
  claimShapeIsValid,
  decideLogin,
  emptyLedger,
  isGroupId,
  isNonce,
  isReleased,
  loginMessage,
  loginProofShapeIsValid,
  mergeLedger,
  normalizeName,
  recordsForSync,
  releaseMessage,
  releaseShapeIsValid,
  statusOfName,
  verifyClaim,
  verifyLoginProof,
  verifyRelease
});

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

// shared/distribution.ts
var distribution_exports = {};
__export(distribution_exports, {
  CHANNELS: () => CHANNELS,
  CONTRACT_VERSION: () => CONTRACT_VERSION,
  DIGEST_ALGORITHM: () => DIGEST_ALGORITHM,
  INSTALL_KINDS: () => INSTALL_KINDS,
  SIGNATURE_ALGORITHM: () => SIGNATURE_ALGORITHM,
  artifactIsWellFormed: () => artifactIsWellFormed,
  artifactMatches: () => artifactMatches,
  canonicalVersion: () => canonicalVersion,
  canonicalize: () => canonicalize,
  catalogFreshness: () => catalogFreshness,
  entryVersion: () => entryVersion,
  ineligibleReason: () => ineligibleReason,
  isSafeStoragePath: () => isSafeStoragePath,
  keyUsable: () => keyUsable,
  selectArtifact: () => selectArtifact,
  verifySigned: () => verifySigned
});
module.exports = __toCommonJS(distribution_exports);

// shared/version.ts
var VersionError = class extends Error {
  constructor(input, reason) {
    super(`vers\xE3o inv\xE1lida (${reason}): ${JSON.stringify(input)}`);
    this.input = input;
    this.name = "VersionError";
  }
  input;
};
var VERSION_LIMIT = 65535;
var NUMERIC_ID = "0|[1-9]\\d*";
var ALPHANUM_ID = "\\d*[A-Za-z-][0-9A-Za-z-]*";
var PRE_ID = `(?:${NUMERIC_ID}|${ALPHANUM_ID})`;
var PRERELEASE = `(?:${PRE_ID})(?:\\.(?:${PRE_ID}))*`;
var BUILD = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
var FIELD = "(?:0|[1-9]\\d*)";
var TAG_PATTERN = new RegExp(`^v${FIELD}\\.${FIELD}\\.${FIELD}(?:-${PRERELEASE})?(?:\\+${BUILD})?$`);
var FULL_FORM = new RegExp(`^(${FIELD})\\.(${FIELD})\\.(${FIELD})(?:-(${PRERELEASE}))?(?:\\+(${BUILD}))?$`);
var SHORT_FORM = new RegExp(`^(${FIELD})\\.(${FIELD})(?:-(${PRERELEASE}))?(?:\\+(${BUILD}))?$`);
function rejectionReason(raw) {
  if (!raw) return "vazia";
  if (/-(?:0\d)/.test(raw)) return "zero \xE0 esquerda num identificador de pr\xE9-vers\xE3o";
  if (/^\d+\.\d+\.\d+-$/.test(raw)) return "pr\xE9-vers\xE3o vazia depois do h\xEDfen";
  if (/\+$/.test(raw)) return "metadado de build vazio depois do `+`";
  if (/\b0\d/.test(raw)) return "zero \xE0 esquerda";
  return "formato";
}
function readIdentifiers(raw) {
  if (!raw) return [];
  return raw.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part);
}
function parseVersion(input) {
  if (typeof input !== "string") return null;
  const raw = input.trim().replace(/^v/i, "");
  const found = FULL_FORM.exec(raw) ?? SHORT_FORM.exec(raw);
  if (!found) return null;
  const short = found.length === 5;
  const major = Number(found[1]);
  const minor = Number(found[2]);
  const patch = short ? 0 : Number(found[3]);
  const prerelease = readIdentifiers(short ? found[3] : found[4]);
  const build = (short ? found[4] : found[5]) ?? "";
  for (const value of [major, minor, patch]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > VERSION_LIMIT) return null;
  }
  const core = `${major}.${minor}.${patch}`;
  const text = `${core}${prerelease.length ? `-${prerelease.join(".")}` : ""}${build ? `+${build}` : ""}`;
  return {
    major,
    minor,
    patch,
    prerelease,
    build,
    isPrerelease: prerelease.length > 0,
    text,
    tag: `v${text}`,
    tuple: [major, minor, patch]
  };
}
function requireVersion(input) {
  const version = parseVersion(input);
  if (!version) throw new VersionError(input, typeof input === "string" ? rejectionReason(input.trim().replace(/^v/i, "")) : "n\xE3o \xE9 texto");
  return version;
}
function asVersion(input) {
  if (typeof input === "object" && input !== null) {
    const candidate = input;
    const tuple = candidate.tuple;
    if (Array.isArray(tuple) && tuple.length === 3 && tuple.every((field) => Number.isSafeInteger(field)) && Array.isArray(candidate.prerelease)) {
      return candidate;
    }
    throw new VersionError(input, "objeto que n\xE3o \xE9 uma vers\xE3o lida");
  }
  return requireVersion(input);
}
function compareIdentifiers(left, right) {
  const leftNumeric = typeof left === "number";
  const rightNumeric = typeof right === "number";
  if (leftNumeric && rightNumeric) return left === right ? 0 : left > right ? 1 : -1;
  if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
  return left === right ? 0 : String(left) > String(right) ? 1 : -1;
}
function compareVersions(left, right) {
  const a = asVersion(left);
  const b = asVersion(right);
  for (let index = 0; index < 3; index += 1) {
    if (a.tuple[index] !== b.tuple[index]) return a.tuple[index] > b.tuple[index] ? 1 : -1;
  }
  if (!a.prerelease.length && !b.prerelease.length) return 0;
  if (!a.prerelease.length) return 1;
  if (!b.prerelease.length) return -1;
  const limit = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < limit; index += 1) {
    if (index >= a.prerelease.length) return -1;
    if (index >= b.prerelease.length) return 1;
    const ordem = compareIdentifiers(a.prerelease[index], b.prerelease[index]);
    if (ordem !== 0) return ordem;
  }
  return 0;
}

// shared/distribution.ts
var SIGNATURE_ALGORITHM = "ed25519";
var DIGEST_ALGORITHM = "sha256";
var CONTRACT_VERSION = 1;
var CHANNELS = ["stable", "test"];
var INSTALL_KINDS = ["linux-managed", "linux-appimage", "windows-installed", "windows-portable", "server-bundle"];
function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("n\xFAmero n\xE3o finito n\xE3o tem forma can\xF4nica");
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item === void 0 ? null : item)).join(",")}]`;
  if (typeof value === "object") {
    const fields = Object.entries(value).filter(([, item]) => item !== void 0).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${fields.map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`).join(",")}}`;
  }
  throw new Error(`tipo sem forma can\xF4nica: ${typeof value}`);
}
function keyUsable(key, scope, now) {
  if (key.revokedAt) return "key-revoked";
  if (!key.scope.includes(scope)) return "key-wrong-scope";
  if (key.notBefore && Date.parse(key.notBefore) > now) return "key-not-yet-valid";
  if (key.notAfter && Date.parse(key.notAfter) <= now) return "key-expired";
  return null;
}
function verifySigned(document, keys, scope, verifySignature, now = Date.now()) {
  if (!document || typeof document !== "object" || !document.payload) return { ok: false, failure: "no-signature" };
  const contract = document.payload.contract;
  if (contract !== CONTRACT_VERSION) return { ok: false, failure: "contract-unknown", detail: String(contract) };
  const signatures = Array.isArray(document.signatures) ? document.signatures : [];
  if (!signatures.length) return { ok: false, failure: "no-signature" };
  const data = canonicalize(document.payload);
  let lastFailure = "unknown-key";
  let detail = "";
  for (const signature of signatures) {
    const key = keys.find((candidate) => candidate.keyId === signature.keyId);
    if (!key) {
      lastFailure = "unknown-key";
      detail = signature.keyId;
      continue;
    }
    const blocker = keyUsable(key, scope, now);
    if (blocker) {
      lastFailure = blocker;
      detail = key.keyId;
      continue;
    }
    if (signature.algorithm !== key.algorithm) {
      lastFailure = "bad-signature";
      detail = signature.keyId;
      continue;
    }
    if (verifySignature(key.publicKey, data, signature.signature, signature.algorithm)) {
      return { ok: true, keyId: key.keyId };
    }
    lastFailure = "bad-signature";
    detail = signature.keyId;
  }
  return { ok: false, failure: lastFailure, detail: detail || void 0 };
}
function catalogFreshness(catalog, acceptedSequence, now) {
  if (!catalog || typeof catalog !== "object") return "malformed";
  if (catalog.contract !== CONTRACT_VERSION) return "malformed";
  if (!Number.isSafeInteger(catalog.sequence) || catalog.sequence < 0) return "malformed";
  if (catalog.sequence < acceptedSequence) return "replayed";
  const expiresAt = Date.parse(catalog.expiresAt ?? "");
  if (!Number.isFinite(expiresAt)) return "malformed";
  if (expiresAt <= now) return "expired";
  return "ok";
}
function selectArtifact(manifest, installKind, arch) {
  const candidates = (manifest?.artifacts ?? []).filter((artifact) => artifact && artifact.installKind === installKind && artifact.arch === arch && artifactIsWellFormed(artifact));
  if (candidates.length !== 1) {
    return null;
  }
  return candidates[0];
}
function artifactIsWellFormed(artifact) {
  if (!artifact || typeof artifact !== "object") return false;
  if (!/^[0-9a-f]{64}$/.test(String(artifact.sha256 ?? "").toLowerCase())) return false;
  if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0) return false;
  if (!artifact.artifactId || !artifact.fileName) return false;
  if (!INSTALL_KINDS.includes(artifact.installKind)) return false;
  return isSafeStoragePath(artifact.storagePath);
}
function isSafeStoragePath(candidate) {
  if (typeof candidate !== "string" || !candidate) return false;
  if (candidate.length > 512) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(candidate)) return false;
  if (candidate.startsWith("/") || candidate.startsWith("\\")) return false;
  if (candidate.includes("\0") || candidate.includes("\\")) return false;
  return candidate.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && /^[A-Za-z0-9._-]+$/.test(segment));
}
function artifactMatches(manifest, artifact, observed) {
  if (observed.releaseId !== void 0 && observed.releaseId !== manifest.releaseId) return "release-mismatch";
  if (observed.version !== void 0) {
    const expected = parseVersion(manifest.version);
    const seen = parseVersion(observed.version);
    if (!expected || !seen || compareVersions(expected, seen) !== 0) return "version-mismatch";
  }
  if (observed.arch !== void 0 && observed.arch !== artifact.arch) return "arch-mismatch";
  if (observed.format !== void 0 && observed.format !== artifact.format) return "format-mismatch";
  if (observed.size !== void 0 && observed.size !== artifact.size) return "size-mismatch";
  if (observed.sha256 !== void 0 && String(observed.sha256).toLowerCase() !== String(artifact.sha256).toLowerCase()) return "digest-mismatch";
  return null;
}
function ineligibleReason(input) {
  const { entry, manifest, currentVersion, installKind, arch } = input;
  const version = parseVersion(entry.version);
  if (!version) return { reason: "not-published", detail: "vers\xE3o fora da conven\xE7\xE3o do produto" };
  if (entry.state === "withdrawn") {
    return { reason: "withdrawn", detail: entry.withdrawn?.reason || "esta vers\xE3o foi retirada" };
  }
  if (entry.state !== "published") return { reason: "not-published", detail: String(entry.state) };
  const broken = input.knownBroken?.get(version.text);
  if (broken) return { reason: "known-broken", detail: broken };
  if (compareVersions(version, currentVersion) <= 0) {
    return { reason: "not-newer", detail: "esta vers\xE3o n\xE3o \xE9 mais nova do que a instalada" };
  }
  if (!manifest) return { reason: "manifest-missing", detail: "o manifesto desta vers\xE3o n\xE3o veio assinado" };
  if (manifest.releaseId !== entry.releaseId) return { reason: "manifest-mismatch", detail: "o manifesto \xE9 de outra release" };
  const fromManifest = parseVersion(manifest.version);
  if (!fromManifest || compareVersions(fromManifest, version) !== 0) {
    return { reason: "manifest-mismatch", detail: "o manifesto declara outra vers\xE3o" };
  }
  const minimum = manifest.compatibility?.minUpdaterVersion;
  if (minimum) {
    const required = parseVersion(minimum);
    if (required && compareVersions(currentVersion, required) < 0) {
      return { reason: "needs-updater", detail: `esta vers\xE3o precisa da ${required.text} instalada antes` };
    }
  }
  if (!selectArtifact(manifest, installKind, arch)) {
    return { reason: "no-artifact", detail: `n\xE3o h\xE1 pacote para ${installKind} ${arch} nesta vers\xE3o` };
  }
  return null;
}
function entryVersion(entry) {
  return parseVersion(entry?.version);
}
function canonicalVersion(input) {
  return requireVersion(input).text;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  CHANNELS,
  CONTRACT_VERSION,
  DIGEST_ALGORITHM,
  INSTALL_KINDS,
  SIGNATURE_ALGORITHM,
  artifactIsWellFormed,
  artifactMatches,
  canonicalVersion,
  canonicalize,
  catalogFreshness,
  entryVersion,
  ineligibleReason,
  isSafeStoragePath,
  keyUsable,
  selectArtifact,
  verifySigned
});

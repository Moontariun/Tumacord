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

// shared/distributionCrypto.ts
var distributionCrypto_exports = {};
__export(distributionCrypto_exports, {
  documentDigest: () => documentDigest,
  generateSigningKey: () => generateSigningKey,
  keyIdFor: () => keyIdFor,
  sha256: () => sha256,
  signDocument: () => signDocument,
  signPayload: () => signPayload,
  verifySignature: () => verifySignature
});
module.exports = __toCommonJS(distributionCrypto_exports);
var import_node_crypto = require("node:crypto");

// shared/version.ts
var NUMERIC_ID = "0|[1-9]\\d*";
var ALPHANUM_ID = "\\d*[A-Za-z-][0-9A-Za-z-]*";
var PRE_ID = `(?:${NUMERIC_ID}|${ALPHANUM_ID})`;
var PRERELEASE = `(?:${PRE_ID})(?:\\.(?:${PRE_ID}))*`;
var BUILD = "[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*";
var FIELD = "(?:0|[1-9]\\d*)";
var TAG_PATTERN = new RegExp(`^v${FIELD}\\.${FIELD}\\.${FIELD}(?:-${PRERELEASE})?(?:\\+${BUILD})?$`);
var FULL_FORM = new RegExp(`^(${FIELD})\\.(${FIELD})\\.(${FIELD})(?:-(${PRERELEASE}))?(?:\\+(${BUILD}))?$`);
var SHORT_FORM = new RegExp(`^(${FIELD})\\.(${FIELD})(?:-(${PRERELEASE}))?(?:\\+(${BUILD}))?$`);

// shared/distribution.ts
var SIGNATURE_ALGORITHM = "ed25519";
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

// shared/distributionCrypto.ts
function keyIdFor(publicKeyBase64) {
  return (0, import_node_crypto.createHash)("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex").slice(0, 32);
}
function generateSigningKey() {
  const { publicKey, privateKey } = (0, import_node_crypto.generateKeyPairSync)("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  return {
    keyId: keyIdFor(spki),
    algorithm: SIGNATURE_ALGORITHM,
    publicKey: spki,
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64")
  };
}
function verifySignature(publicKeyBase64, data, signatureBase64, algorithm = SIGNATURE_ALGORITHM) {
  if (algorithm !== SIGNATURE_ALGORITHM) return false;
  try {
    const key = (0, import_node_crypto.createPublicKey)({ key: Buffer.from(publicKeyBase64, "base64"), format: "der", type: "spki" });
    return (0, import_node_crypto.verify)(null, Buffer.from(data, "utf8"), key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
function signPayload(privateKeyBase64, payload) {
  const key = (0, import_node_crypto.createPrivateKey)({ key: Buffer.from(privateKeyBase64, "base64"), format: "der", type: "pkcs8" });
  return (0, import_node_crypto.sign)(null, Buffer.from(canonicalize(payload), "utf8"), key).toString("base64");
}
function signDocument(payload, keys) {
  if (!keys.length) throw new Error("um documento sem assinatura n\xE3o \xE9 public\xE1vel");
  return {
    payload,
    signatures: keys.map((key) => ({
      keyId: key.keyId,
      algorithm: key.algorithm || SIGNATURE_ALGORITHM,
      signature: signPayload(key.privateKey, payload)
    }))
  };
}
function sha256(data) {
  return (0, import_node_crypto.createHash)("sha256").update(data).digest("hex");
}
function documentDigest(payload) {
  return sha256(canonicalize(payload));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  documentDigest,
  generateSigningKey,
  keyIdFor,
  sha256,
  signDocument,
  signPayload,
  verifySignature
});

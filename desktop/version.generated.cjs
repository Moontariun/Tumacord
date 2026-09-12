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

// shared/version.ts
var version_exports = {};
__export(version_exports, {
  TAG_PATTERN: () => TAG_PATTERN,
  VERSION_LIMIT: () => VERSION_LIMIT,
  VersionError: () => VersionError,
  compareVersions: () => compareVersions,
  formatVersion: () => formatVersion,
  isVersion: () => isVersion,
  parseVersion: () => parseVersion,
  requireVersion: () => requireVersion,
  sortDescending: () => sortDescending,
  windowsVersion: () => windowsVersion
});
module.exports = __toCommonJS(version_exports);
var VersionError = class extends Error {
  constructor(input, reason) {
    super(`vers\xE3o inv\xE1lida (${reason}): ${JSON.stringify(input)}`);
    this.input = input;
    this.name = "VersionError";
  }
  input;
};
var VERSION_LIMIT = 65535;
var TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[1-9]\d*)?$/;
var FIELD = "(?:0|[1-9]\\d*)";
var FULL_FORM = new RegExp(`^(${FIELD})\\.(${FIELD})\\.(${FIELD})(?:-([1-9]\\d*))?$`);
var SHORT_FORM = new RegExp(`^(${FIELD})\\.(${FIELD})(?:-([1-9]\\d*))?$`);
function rejectionReason(raw) {
  if (!raw) return "vazia";
  if (/[+]/.test(raw)) return "metadado de build n\xE3o faz parte desta conven\xE7\xE3o";
  if (/-(?:0\d*|\d*[A-Za-z])/.test(raw)) {
    return "o sufixo \xE9 a revis\xE3o de manuten\xE7\xE3o, um inteiro positivo \u2014 alpha, beta e rc n\xE3o entram: quem \xE9 ensaio \xE9 decidido pelo canal";
  }
  if (/\b0\d/.test(raw)) return "zero \xE0 esquerda";
  return "formato";
}
function parseVersion(input) {
  if (typeof input !== "string") return null;
  const raw = input.trim().replace(/^v/i, "");
  const found = FULL_FORM.exec(raw) ?? SHORT_FORM.exec(raw);
  if (!found) return null;
  const short = found.length === 4;
  const major = Number(found[1]);
  const minor = Number(found[2]);
  const patch = short ? 0 : Number(found[3]);
  const revision = Number((short ? found[3] : found[4]) ?? 0);
  for (const value of [major, minor, patch, revision]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > VERSION_LIMIT) return null;
  }
  const text = revision ? `${major}.${minor}.${patch}-${revision}` : `${major}.${minor}.${patch}`;
  return { major, minor, patch, revision, text, tag: `v${text}`, tuple: [major, minor, patch, revision] };
}
function requireVersion(input) {
  const version = parseVersion(input);
  if (!version) throw new VersionError(input, typeof input === "string" ? rejectionReason(input.trim().replace(/^v/i, "")) : "n\xE3o \xE9 texto");
  return version;
}
function isVersion(input) {
  return parseVersion(input) !== null;
}
function asVersion(input) {
  if (typeof input === "object" && input !== null) {
    const tuple = input.tuple;
    if (Array.isArray(tuple) && tuple.length === 4 && tuple.every((field) => Number.isSafeInteger(field))) {
      return input;
    }
    throw new VersionError(input, "objeto que n\xE3o \xE9 uma vers\xE3o lida");
  }
  return requireVersion(input);
}
function compareVersions(left, right) {
  const a = asVersion(left);
  const b = asVersion(right);
  for (let index = 0; index < 4; index += 1) {
    if (a.tuple[index] !== b.tuple[index]) return a.tuple[index] > b.tuple[index] ? 1 : -1;
  }
  return 0;
}
function formatVersion(version) {
  return version.text;
}
function windowsVersion(input) {
  const { major, minor, patch, revision } = requireVersion(input);
  return `${major}.${minor}.${patch}.${revision}`;
}
function sortDescending(versions) {
  const parsed = [];
  for (const item of versions) {
    const version = parseVersion(item);
    if (version) parsed.push(version);
  }
  return parsed.sort((left, right) => compareVersions(right, left));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  TAG_PATTERN,
  VERSION_LIMIT,
  VersionError,
  compareVersions,
  formatVersion,
  isVersion,
  parseVersion,
  requireVersion,
  sortDescending,
  windowsVersion
});

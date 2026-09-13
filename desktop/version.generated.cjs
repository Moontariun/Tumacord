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
function isVersion(input) {
  return parseVersion(input) !== null;
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
function formatVersion(version) {
  return version.text;
}
function windowsVersion(input) {
  const { major, minor, patch, isPrerelease, text } = requireVersion(input);
  if (isPrerelease) {
    throw new VersionError(input, `uma pr\xE9-vers\xE3o n\xE3o tem n\xFAmero de Windows: ${text} n\xE3o pode ser ordenada contra ${major}.${minor}.${patch} em quatro campos`);
  }
  return `${major}.${minor}.${patch}.0`;
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

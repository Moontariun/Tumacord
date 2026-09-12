// ATENÇÃO: arquivo gerado por scripts/gerar-versao.mjs a partir de
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
  constructor(input, motivo) {
    super(`vers\xE3o inv\xE1lida (${motivo}): ${JSON.stringify(input)}`);
    this.input = input;
    this.name = "VersionError";
  }
  input;
};
var VERSION_LIMIT = 65535;
var TAG_PATTERN = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[1-9]\d*)?$/;
var CAMPO = "(?:0|[1-9]\\d*)";
var COMPLETA = new RegExp(`^(${CAMPO})\\.(${CAMPO})\\.(${CAMPO})(?:-([1-9]\\d*))?$`);
var CURTA = new RegExp(`^(${CAMPO})\\.(${CAMPO})(?:-([1-9]\\d*))?$`);
function motivoDaRecusa(bruto) {
  if (!bruto) return "vazia";
  if (/[+]/.test(bruto)) return "metadado de build n\xE3o faz parte desta conven\xE7\xE3o";
  if (/-(?:0\d*|\d*[A-Za-z])/.test(bruto)) {
    return "o sufixo \xE9 a revis\xE3o de manuten\xE7\xE3o, um inteiro positivo \u2014 alpha, beta e rc n\xE3o entram: quem \xE9 ensaio \xE9 decidido pelo canal";
  }
  if (/\b0\d/.test(bruto)) return "zero \xE0 esquerda";
  return "formato";
}
function parseVersion(input) {
  if (typeof input !== "string") return null;
  const bruto = input.trim().replace(/^v/i, "");
  const m = COMPLETA.exec(bruto) ?? CURTA.exec(bruto);
  if (!m) return null;
  const curta = m.length === 4;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  const patch = curta ? 0 : Number(m[3]);
  const revision = Number((curta ? m[3] : m[4]) ?? 0);
  for (const valor of [major, minor, patch, revision]) {
    if (!Number.isSafeInteger(valor) || valor < 0 || valor > VERSION_LIMIT) return null;
  }
  const text = revision ? `${major}.${minor}.${patch}-${revision}` : `${major}.${minor}.${patch}`;
  return { major, minor, patch, revision, text, tag: `v${text}`, tuple: [major, minor, patch, revision] };
}
function requireVersion(input) {
  const versao = parseVersion(input);
  if (!versao) throw new VersionError(input, typeof input === "string" ? motivoDaRecusa(input.trim().replace(/^v/i, "")) : "n\xE3o \xE9 texto");
  return versao;
}
function isVersion(input) {
  return parseVersion(input) !== null;
}
function comoVersao(entrada) {
  if (typeof entrada === "object" && entrada !== null) {
    const tupla = entrada.tuple;
    if (Array.isArray(tupla) && tupla.length === 4 && tupla.every((campo) => Number.isSafeInteger(campo))) {
      return entrada;
    }
    throw new VersionError(entrada, "objeto que n\xE3o \xE9 uma vers\xE3o lida");
  }
  return requireVersion(entrada);
}
function compareVersions(left, right) {
  const a = comoVersao(left);
  const b = comoVersao(right);
  for (let i = 0; i < 4; i += 1) {
    if (a.tuple[i] !== b.tuple[i]) return a.tuple[i] > b.tuple[i] ? 1 : -1;
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
  const lidas = [];
  for (const item of versions) {
    const versao = parseVersion(item);
    if (versao) lidas.push(versao);
  }
  return lidas.sort((left, right) => compareVersions(right, left));
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

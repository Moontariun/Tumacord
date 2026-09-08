#!/usr/bin/env node
// Monta o ícone do Windows a partir dos PNGs que já existem no repositório.
//
// O electron-builder aceita um PNG e converte sozinho, mas a conversão dele
// produz um ícone único redimensionado. O Windows mostra o ícone em cinco
// tamanhos diferentes — 16 px na barra de tarefas, 32 px na lista de
// aplicativos instalados, 48 px no Explorer, 256 px na visualização grande —,
// e uma imagem só, esticada, fica borrada em quase todos eles. As artes por
// tamanho já estão em `assets/icons`; este script apenas as empacota.
//
//   node scripts/build-windows-icon.cjs
//
// Rode de novo sempre que a marca mudar. O `.ico` é versionado porque a build
// do Windows precisa dele mesmo sem Node no caminho de empacotamento.

const { readFileSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
// 96 e 512 ficam de fora de propósito: o Windows não pede esses tamanhos e
// cada entrada extra engorda todo executável que carrega o ícone.
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function readPng(size) {
  const file = path.join(projectRoot, 'assets', 'icons', `${size}x${size}`, 'apps', 'tumacord.png');
  const data = readFileSync(file);
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} não é um PNG.`);
  const width = data.readUInt32BE(16);
  const height = data.readUInt32BE(20);
  if (width !== size || height !== size) throw new Error(`${file} tem ${width}x${height}, esperado ${size}x${size}.`);
  return data;
}

function buildIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;
  images.forEach((image, index) => {
    const entry = index * 16;
    // 256 é gravado como 0: o campo tem um byte só, e é assim que o formato
    // representa o tamanho máximo.
    directory[entry] = image.size === 256 ? 0 : image.size;
    directory[entry + 1] = image.size === 256 ? 0 : image.size;
    directory[entry + 2] = 0;
    directory[entry + 3] = 0;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(image.data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

const images = SIZES.map((size) => ({ size, data: readPng(size) }));
const target = path.join(projectRoot, 'assets', 'tumacord.ico');
writeFileSync(target, buildIco(images));
console.log(`Ícone com ${images.length} tamanhos gravado em ${path.relative(projectRoot, target)}.`);

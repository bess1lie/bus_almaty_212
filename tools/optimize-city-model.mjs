#!/usr/bin/env node
/**
 * Убирает из городской CC0 GLB-модели встроенные текстуры: streetProps
 * всё равно сплющивает геометрию и берёт только material.color/vertex colors.
 * В PNG уходило ~2.5 МБ на дерево и десятки МБ VRAM на мобильном.
 *
 *Usage: node tools/optimize-city-model.mjs input.glb output.glb
 */
import fs from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('usage: optimize-city-model.mjs <in.glb> <out.glb>');

const buf = fs.readFileSync(input);
if (buf.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB');
const total = buf.readUInt32LE(8);
let off = 12, json, bin;
while (off < total) {
  const len = buf.readUInt32LE(off);
  const type = buf.toString('ascii', off + 4, off + 8);
  const chunk = buf.subarray(off + 8, off + 8 + len);
  if (type === 'JSON') json = JSON.parse(chunk.toString('utf8'));
  if (type === 'BIN\0') bin = Buffer.from(chunk);
  off += 8 + len;
}

// Какие bufferViews реально нужны аксессорам геометрии.
const used = new Set();
for (const a of json.accessors ?? []) if (a.bufferView !== undefined) used.add(a.bufferView);
const remap = new Map();
const chunks = [];
let cursor = 0;
let nextIndex = 0;
for (const oldIndex of [...used].sort((a, b) => a - b)) {
  const view = json.bufferViews[oldIndex];
  const start = view.byteOffset ?? 0;
  const bytes = bin.subarray(start, start + view.byteLength);
  chunks.push(bytes);
  remap.set(oldIndex, { old: oldIndex, index: nextIndex++, offset: cursor });
  cursor += bytes.length;
  while (cursor % 4) { chunks.push(Buffer.from([0])); cursor++; }
}
const newBin = Buffer.concat(chunks);
json.bufferViews = [...remap.values()].map(({ old, offset }) => ({
  ...json.bufferViews[old],
  byteOffset: offset,
}));
// Важно: порядок remap совпадает с порядком used, а index — индекс в chunks.
for (const a of json.accessors ?? []) {
  if (a.bufferView === undefined) continue;
  const mapped = remap.get(a.bufferView);
  if (!mapped) { delete a.bufferView; continue; }
  a.bufferView = mapped.index;
}

const FLAT_COLORS = [
  [/leaf|leaves|foliage|green/i, [0.27, 0.47, 0.29, 1]],
  [/bark|wood|trunk|brown/i, [0.40, 0.29, 0.20, 1]],
  [/light|lamp|glow/i, [0.96, 0.85, 0.62, 1]],
  [/metal|steel|grey|gray/i, [0.42, 0.47, 0.50, 1]],
];
for (const material of json.materials ?? []) {
  const name = material.name ?? '';
  const flat = FLAT_COLORS.find(([re]) => re.test(name))?.[1] ?? material.pbrMetallicRoughness?.baseColorFactor ?? [0.8, 0.8, 0.8, 1];
  material.pbrMetallicRoughness = {
    baseColorFactor: flat,
    metallicFactor: 0,
    roughnessFactor: 0.9,
  };
  delete material.normalTexture;
  delete material.occlusionTexture;
  delete material.emissiveTexture;
  delete material.extensions;
}
delete json.images;
delete json.textures;
delete json.samplers;
delete json.extensionsUsed;
delete json.extensionsRequired;
json.buffers = [{ byteLength: newBin.length }];

let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
while (jsonBytes.length % 4) jsonBytes = Buffer.concat([jsonBytes, Buffer.from([0x20])]);
const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + newBin.length, 8);
const jh = Buffer.alloc(8);
jh.writeUInt32LE(jsonBytes.length, 0);
jh.write('JSON', 4, 'ascii');
const bh = Buffer.alloc(8);
bh.writeUInt32LE(newBin.length, 0);
bh.write('BIN\0', 4, 'ascii');
fs.writeFileSync(output, Buffer.concat([header, jh, jsonBytes, bh, newBin]));
console.log('optimized', input, (buf.length / 1024).toFixed(0) + 'KB ->', (fs.statSync(output).size / 1024).toFixed(0) + 'KB');

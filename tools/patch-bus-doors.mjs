#!/usr/bin/env node
/**
 * BUS-01: модель автобуса имела третью (пассажирскую) дверь со стороны
 * водителя — рядом с кабиной. Скрипт удаляет обе створки из сцены и вместо
 * них собирает нормальную боковину с окном из геометрии кузова.
 *
 * Работает напрямую с GLB: переписывает JSON-chunk и добавляет новые
 * bufferView/accessor/mesh/node. Исходные материалы не меняются.
 * Применяется ко всем трем ливреям (геометрия у них идентична).
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2] ?? path.resolve(import.meta.dirname, '..');
const FILES = [
  'public/models/variants/bus_almaty_212_golden_hour.glb',
  'public/models/variants/bus_almaty_212_sand.glb',
  'public/models/variants/bus_almaty_212_turquoise.glb',
];

function readGlb(file) {
  const buf = fs.readFileSync(file);
  const total = buf.readUInt32LE(8);
  let off = 12, json = null, bin = null;
  while (off < total) {
    const len = buf.readUInt32LE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 'JSON') json = JSON.parse(chunk.toString('utf8'));
    if (type === 'BIN\0') bin = Buffer.from(chunk);
    off += 8 + len;
  }
  return { json, bin };
}

function writeGlb(file, json, bin) {
  let jsonBytes = Buffer.from(JSON.stringify(json), 'utf8');
  while (jsonBytes.length % 4) jsonBytes = Buffer.concat([jsonBytes, Buffer.from([0x20])]);
  while (bin.length % 4) bin = Buffer.concat([bin, Buffer.from([0])]);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonBytes.length + 8 + bin.length, 8);
  const jh = Buffer.alloc(8);
  jh.writeUInt32LE(jsonBytes.length, 0);
  jh.write('JSON', 4, 'ascii');
  const bh = Buffer.alloc(8);
  bh.writeUInt32LE(bin.length, 0);
  bh.write('BIN\0', 4, 'ascii');
  fs.writeFileSync(file, Buffer.concat([header, jh, jsonBytes, bh, bin]));
}

/** 24 вершины (по 4 на грань) + 36 индексов, с нормалями. */
function box(min, max) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const faces = [
    [[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[x1,y0,z1], [1,0,0]],
    [[x0,y0,z1],[x0,y1,z1],[x0,y1,z0],[x0,y0,z0], [-1,0,0]],
    [[x0,y1,z0],[x0,y1,z1],[x1,y1,z1],[x1,y1,z0], [0,1,0]],
    [[x0,y0,z1],[x0,y0,z0],[x1,y0,z0],[x1,y0,z1], [0,-1,0]],
    [[x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1], [0,0,1]],
    [[x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0], [0,0,-1]],
  ];
  const pos = [], nor = [], idx = [];
  faces.forEach((f, fi) => {
    for (let k = 0; k < 4; k++) { pos.push(...f[k]); nor.push(...f[4]); }
    const b = fi * 4;
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  });
  return { pos, nor, idx };
}

function matrixT(x, y, z) {
  return [1,0,0,0, 0,1,0,0, 0,0,1,0, x,y,z,1];
}

for (const rel of FILES) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) { console.log('skip missing', rel); continue; }
  const { json, bin: originalBin } = readGlb(file);
  let bin = originalBin;
  const find = n => json.nodes.findIndex(x => x.name === n);
  const left = ['door_left_front_1', 'door_left_rear_1'].map(find);
  const doorsLeft = find('doors_left');
  if (left.some(i => i < 0) || doorsLeft < 0) throw new Error(`Missing door nodes in ${rel}`);

  // Уже пропатченный файл — идемпотентно
  if (find('driver_side_wall') >= 0) { console.log('already patched', rel); continue; }

  const body = json.nodes[find('body')];
  for (const idx of left) {
    const at = json.nodes[doorsLeft].children.indexOf(idx);
    if (at >= 0) json.nodes[doorsLeft].children.splice(at, 1);
  }
  console.log(rel, 'removed left door nodes', left.join(','));

  // Геометрия боковины: сплошная панель с настоящим окном.
  // X=-1.205 наружная обшивка, X=-1.23 стекло, Z -5.02..-4.24.
  const parts = [
    ['driver_side_wall_low',   [-1.23, 0.06, -5.02], [-1.19, 0.48, -4.24], 1],
    ['driver_side_wall_top',   [-1.23, 1.30, -5.02], [-1.19, 1.40, -4.24], 1],
    ['driver_side_wall_front', [-1.23, 0.48, -5.02], [-1.19, 1.30, -4.88], 1],
    ['driver_side_wall_rear',  [-1.23, 0.48, -4.38], [-1.19, 1.30, -4.24], 1],
    ['driver_side_window',     [-1.235,0.48, -4.88], [-1.231,1.30, -4.38], 4],
  ];
  const newNodes = [];
  for (const [name, min, max, material] of parts) {
    const g = box(min, max);
    const posOff = bin.length;
    const posBytes = Buffer.from(new Float32Array(g.pos).buffer);
    bin = Buffer.concat([bin, posBytes]);
    json.bufferViews.push({ buffer: 0, byteOffset: posOff, byteLength: posBytes.length, target: 34962 });
    const posView = json.bufferViews.length - 1;
    json.accessors.push({
      bufferView: posView, componentType: 5126, count: g.pos.length / 3, type: 'VEC3',
      min: min, max: max,
    });
    const posAcc = json.accessors.length - 1;

    const norOff = bin.length;
    const norBytes = Buffer.from(new Float32Array(g.nor).buffer);
    bin = Buffer.concat([bin, norBytes]);
    json.bufferViews.push({ buffer: 0, byteOffset: norOff, byteLength: norBytes.length, target: 34962 });
    const norView = json.bufferViews.length - 1;
    json.accessors.push({ bufferView: norView, componentType: 5126, count: g.nor.length / 3, type: 'VEC3' });
    const norAcc = json.accessors.length - 1;

    const idxOff = bin.length;
    const idxBytes = Buffer.from(new Uint16Array(g.idx).buffer);
    bin = Buffer.concat([bin, idxBytes]);
    json.bufferViews.push({ buffer: 0, byteOffset: idxOff, byteLength: idxBytes.length, target: 34963 });
    const idxView = json.bufferViews.length - 1;
    json.accessors.push({ bufferView: idxView, componentType: 5123, count: g.idx.length, type: 'SCALAR' });
    const idxAcc = json.accessors.length - 1;

    json.meshes.push({
      name: `geom_${name}`,
      primitives: [{ attributes: { POSITION: posAcc, NORMAL: norAcc }, indices: idxAcc, material }],
    });
    const meshIndex = json.meshes.length - 1;
    json.nodes.push({ name, mesh: meshIndex, matrix: matrixT(0, 0, 0) });
    newNodes.push(json.nodes.length - 1);
  }
  // Добавляем в body (matrix у него единичный — локальные координаты = глобальные)
  if (!matrixIsIdentity(body.matrix)) throw new Error('body node has non-identity matrix');
  body.children.push(...newNodes);
  json.buffers[0].byteLength = bin.length;
  writeGlb(file, json, bin);
  console.log(rel, 'added', newNodes.length, 'side meshes');
}

function matrixIsIdentity(m) {
  if (!m) return true;
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  return m.every((v, i) => Math.abs(v - I[i]) < 1e-6);
}

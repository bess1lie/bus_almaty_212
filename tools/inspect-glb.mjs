import fs from 'node:fs';

function parse(file) {
  const buf = fs.readFileSync(file);
  const len = buf.readUInt32LE(8);
  let off = 12, json = null, bin = null;
  while (off < len) {
    const n = buf.readUInt32LE(off), type = buf.toString('ascii', off+4, off+8);
    const d = buf.subarray(off+8, off+8+n);
    if (type === 'JSON') json = JSON.parse(d.toString('utf8'));
    if (type === 'BIN\0') bin = d;
    off += 8+n;
  }
  return { json, bin, buf };
}
const COMP = { 5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array };
const NCOMP = { SCALAR:1, VEC2:2, VEC3:3, VEC4:4, MAT4:16 };
function readAcc(json, bin, idx) {
  const a = json.accessors[idx];
  if (!a) return null;
  const bv = json.bufferViews[a.bufferView];
  if (bv.extensions?.EXT_meshopt_compression) return { ...a, compressed: true, values: (a.min && a.max) ? [a.min, a.max] : [] };
  const Ctor = COMP[a.componentType] ?? Float32Array;
  const comps = NCOMP[a.type] ?? 1;
  const stride = bv.byteStride ?? comps * Ctor.BYTES_PER_ELEMENT;
  const start = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out = [];
  for (let i = 0; i < a.count; i++) {
    const base = start + i*stride;
    const v = [];
    for (let c = 0; c < comps; c++) {
      let val;
      if (Ctor === Float32Array) val = bin.readFloatLE(base + c*4);
      else if (Ctor === Uint32Array) val = bin.readUInt32LE(base + c*4);
      else if (Ctor === Uint16Array) val = bin.readUInt16LE(base + c*2);
      else if (Ctor === Int16Array) val = bin.readInt16LE(base + c*2);
      else val = bin.readUInt8(base + c);
      if (a.normalized && Ctor !== Float32Array) val /= (Ctor === Uint8Array ? 255 : Ctor === Uint16Array ? 65535 : 32767);
      v.push(val);
    }
    out.push(comps === 1 ? v[0] : v);
  }
  return { ...a, values: out };
}
function quatToEuler(q) {
  const [x,y,z,w] = q;
  const sinr_cosp = 2*(w*x + y*z), cosr_cosp = 1-2*(x*x+y*y);
  const rx = Math.atan2(sinr_cosp, cosr_cosp);
  const sinp = 2*(w*y - z*x);
  const ry = Math.abs(sinp)>=1 ? Math.sign(sinp)*Math.PI/2 : Math.asin(sinp);
  const siny_cosp = 2*(w*z + x*y), cosy_cosp = 1-2*(y*y+z*z);
  const rz = Math.atan2(siny_cosp, cosy_cosp);
  return [rx,ry,rz].map(v=>+(v*180/Math.PI).toFixed(1));
}
for (const file of process.argv.slice(2)) {
  const { json, bin, buf } = parse(file);
  console.log('\n=========', file, (buf.length/1024).toFixed(1),'KB','=========');
  console.log('asset', JSON.stringify(json.asset), 'ext', JSON.stringify(json.extensionsUsed));
  console.log('nodes', json.nodes.length, 'meshes', json.meshes.length, 'materials', json.materials?.length ?? 0, 'images', json.images?.length ?? 0, 'textures', json.textures?.length ?? 0, 'anims', json.animations?.length ?? 0, 'skins', json.skins?.length ?? 0);
  // global bounds
  let gmin=[Infinity,Infinity,Infinity], gmax=[-Infinity,-Infinity,-Infinity], tris=0, uvMeshes=0, normMeshes=0, tanMeshes=0;
  for (const m of json.meshes) {
    if (m.primitives.some(p=>p.attributes.TEXCOORD_0!==undefined)) uvMeshes++;
    if (m.primitives.some(p=>p.attributes.NORMAL!==undefined)) normMeshes++;
    if (m.primitives.some(p=>p.attributes.TANGENT!==undefined)) tanMeshes++;
    for (const p of m.primitives) {
      const pos = readAcc(json, bin, p.attributes.POSITION);
      if (pos?.min && pos?.max) { for(let k=0;k<3;k++){gmin[k]=Math.min(gmin[k],pos.min[k]);gmax[k]=Math.max(gmax[k],pos.max[k]);} }
      else if (pos) for (const v of pos.values) for(let k=0;k<3;k++){gmin[k]=Math.min(gmin[k],v[k]);gmax[k]=Math.max(gmax[k],v[k]);}
      if (p.indices!==undefined) { const ia = readAcc(json,bin,p.indices); tris += (ia.compressed ? (ia.count??0) : ia.values.length)/3; }
      else if (pos) tris += (pos.count ?? pos.values.length)/3;
    }
  }
  console.log('bounds', gmin.map(v=>+v.toFixed(2)), gmax.map(v=>+v.toFixed(2)), 'size', gmax.map((v,i)=>+(v-gmin[i]).toFixed(2)));
  console.log('triangles', tris, 'UV meshes',uvMeshes+'/'+json.meshes.length,'NORMAL',normMeshes,'TANGENT',tanMeshes);
  console.log('materials:', (json.materials??[]).map((m,i)=>`${i}:${m.name}|tex:${!!(m.pbrMetallicRoughness?.baseColorTexture)}|n:${!!m.normalTexture}|r:${!!m.pbrMetallicRoughness?.metallicRoughnessTexture}`).join('  '));
  console.log('images:', (json.images??[]).map(im=>im.name||im.uri||('bv'+im.bufferView)).join(', '));
  console.log('--- nodes with name (non-mesh transform) ---');
  for (let i=0;i<json.nodes.length;i++) {
    const n = json.nodes[i];
    if (!n.name || /^(mesh|primitive|node)/i.test(n.name)) continue;
    const t = n.translation ?? [0,0,0], s = n.scale ?? [1,1,1], r = n.rotation ?? [0,0,0,1];
    const moved = t.some(v=>v!==0) || s.some(v=>v!==1) || r.some((v,j)=>j<3&&v!==0);
    if (moved || /door|wheel|camera|steer|needle|mirror|seat|dashboard|bus_root|name/i.test(n.name)) {
      console.log(i, n.name, 'T', t.map(v=>+v.toFixed(2)), 'Rdeg', quatToEuler(r), 'S', s.map(v=>+v.toFixed(2)), 'mesh', n.mesh, 'children', n.children?.length ?? 0);
    }
  }
  if (json.animations?.length) {
    console.log('--- animations ---');
    for (const a of json.animations) console.log(a.name, 'channels', a.channels.length, 'targets', a.channels.map(c=>json.nodes[c.target.node]?.name).slice(0,20).join(','));
  }
}

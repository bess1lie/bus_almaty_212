import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const OUT = '/home/bess1lie/bus_almaty_212/public/textures/pbr';
const SETS = {
  asphalt: 'asphalt_01',
  sidewalk: 'concrete_pavement_02',
  concrete: 'concrete_floor_worn_001',
  brick: 'brick_wall_001',
  facade: 'concrete_tile_facade',
  roof: 'clay_roof_tiles_02',
  ground: 'dirt',
};
const MAPS = { diff: 'Diffuse', nor: 'nor_gl', rough: 'Rough' };
fs.mkdirSync(OUT, { recursive: true });
for (const [name, id] of Object.entries(SETS)) {
  const meta = JSON.parse(execFileSync('curl', ['-s', `https://api.polyhaven.com/files/${id}`], { encoding: 'utf8' }));
  const dir = `${OUT}/${name}`;
  fs.mkdirSync(dir, { recursive: true });
  for (const [short, key] of Object.entries(MAPS)) {
    const entry = meta[key]?.['1k']?.jpg ?? meta[key]?.['1k']?.png;
    if (!entry) { console.log('skip', name, key); continue; }
    const tmp = `/tmp/opencode/assets/${id}_${short}.jpg`;
    execFileSync('curl', ['-s', '-L', '-o', tmp, entry.url]);
    const out = `${dir}/${short}.webp`;
    // 512 px — достаточно для уличного уровня; вебп quality 80.
    execFileSync('magick', [tmp, '-resize', '512x512>', '-quality', '80', out]);
    console.log(name, short, (fs.statSync(out).size / 1024).toFixed(0) + 'KB');
  }
}

/**
 * scan-pbf.mjs — быстрый скан PBF: считает ноды/ways в bbox, проверяет скорость.
 * Использование: node tools/scan-pbf.mjs <путь-к-pbf>
 */
import osmRead from 'osm-read';
import { performance } from 'node:perf_hooks';

const parsePbf = osmRead.parsePbf;

const file = process.argv[2] ?? '/tmp/opencode/kazakhstan-latest.osm.pbf';

const BBOX = { minLon: 76.55, maxLon: 77.25, minLat: 43.05, maxLat: 43.42 };

let nodesInBox = 0;
let totalNodes = 0;
let waysBuilding = 0;
let waysHighway = 0;
let waysOther = 0;

const t0 = performance.now();
parsePbf({
  filePath: file,
  callback(err, parser) {
    console.log('callback called, err=', err, 'blocks:', parser?.fileBlocks?.length);
    if (err) {
      console.error('open error:', err);
      process.exit(1);
    }
  },
  node(node) {
    totalNodes++;
    if (
      node.lon >= BBOX.minLon && node.lon <= BBOX.maxLon &&
      node.lat >= BBOX.minLat && node.lat <= BBOX.maxLat
    ) {
      nodesInBox++;
    }
    if (totalNodes % 100000 === 0) {
      console.error(`  ... ${totalNodes} nodes`);
    }
  },
  way(way) {
    const t = way.tags || {};
    if (t.building) waysBuilding++;
    else if (t.highway) waysHighway++;
    else waysOther++;
  },
  endDocument() {
    console.log('endDocument reached');
    const dt = ((performance.now() - t0) / 1000).toFixed(1);
    console.log(`nodes total: ${totalNodes}, in bbox: ${nodesInBox}`);
    console.log(`ways building: ${waysBuilding}, highway: ${waysHighway}, other: ${waysOther}`);
    console.log(`time: ${dt}s`);
  },
  error(err) {
    console.error('parse error:', err);
    process.exit(1);
  },
});

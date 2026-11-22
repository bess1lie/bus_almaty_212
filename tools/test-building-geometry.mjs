/**
 * Тесты корректной триангуляции контуров зданий.
 * Запуск: node --experimental-strip-types tools/test-building-geometry.mjs
 */
import { cleanPolygon, signedArea, triangulatePolygon, upwardFace } from '../src/world/polygon.ts';

let failures = 0;
function check(name, ok, detail = '') {
  if (ok) console.log('PASS', name, detail);
  else { console.error('FAIL', name, detail); failures++; }
}

function triangleAreaSum(points, faces) {
  const clean = cleanPolygon(points);
  let sum = 0;
  for (const [i, j, k] of faces) {
    const a = clean[i], b = clean[j], c = clean[k];
    sum += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }
  return sum;
}

const cases = [
  ['rectangle', [[0, 0], [12, 0], [12, 8], [0, 8]]],
  ['concave L', [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]]],
  ['concave notch', [[0, 0], [8, 0], [8, 8], [5, 8], [5, 3], [3, 3], [3, 8], [0, 8]]],
  ['CW winding', [[0, 0], [0, 6], [9, 6], [9, 0]]],
  ['duplicate + closing point', [[0, 0], [6, 0], [6, 0], [6, 5], [0, 5], [0, 0]]],
];

for (const [name, poly] of cases) {
  const faces = triangulatePolygon(poly);
  const clean = cleanPolygon(poly);
  const expected = Math.abs(signedArea(clean));
  const actual = faces ? triangleAreaSum(poly, faces) : -1;
  check(name, faces !== null && faces.length === clean.length - 2 && Math.abs(actual - expected) < 1e-6,
    `faces=${faces?.length} area=${actual.toFixed(2)} expected=${expected.toFixed(2)}`);
  if (faces) {
    const orientations = faces.map(([i, j, k]) => upwardFace(clean[i], clean[j], clean[k]).join(''));
    check(`${name}: upward normals`, orientations.every((o) => o === '012' || o === '021'), orientations.join(','));
  }
}

check('degenerate polygon rejected', triangulatePolygon([[0, 0], [2, 0], [4, 0], [6, 0]]) === null);
check('invalid coordinates rejected', triangulatePolygon([[0, 0], [NaN, 2], [3, 4]]) === null);
check('two-point contour rejected', triangulatePolygon([[0, 0], [1, 1]]) === null);

if (failures > 0) process.exitCode = 1;
else console.log('ALL TRIANGULATION TESTS PASSED');

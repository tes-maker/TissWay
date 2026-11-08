// Local geometry: distances, kerb side, polylines.
import assert from "node:assert/strict";
import { test } from "node:test";
import { approx } from "./helpers.js";
import { Grid, bbox, inZones, zonesAround, decodePolyline, dist, distancesToPolyline, pathLength, project, rightOf } from "../src/geo.js";

const A = [49.0, 1.0], B = [49.001, 1.0]; // northbound road (~110 m)

test("dist: one thousandth of a degree of latitude", () => approx(dist(A, B), 110.6, 0.5));

test("project: middle of the segment", () => {
  const [t, d] = project([49.0005, 1.0001], A, B);
  approx(t, 0.5, 0.01);
  approx(d, 7.3, 0.2);
});

test("rightOf depends on the direction of travel", () => {
  const east = [49.0005, 1.0002], west = [49.0005, 0.9998];
  assert.ok(rightOf(east, A, B) && !rightOf(west, A, B));
  assert.ok(rightOf(west, B, A) && !rightOf(east, B, A));
});

test("pathLength and distancesToPolyline", () => {
  approx(pathLength([A, B, A]).at(-1), 2 * dist(A, B), 0.3);
  const d = distancesToPolyline([[49.0005, 1.0001], [49.002, 1.0]], [A, B]);
  approx(d[0], 7.3, 0.2);
  approx(d[1], dist([49.002, 1.0], B), 0.2);
  assert.equal(distancesToPolyline([A], [])[0], Infinity);
});

test("decodePolyline, precision 6", () => {
  const [a, b] = decodePolyline("_cvm|A_c`|@o}@?");
  approx(a[0], A[0]); approx(a[1], A[1]); approx(b[0], B[0]); approx(b[1], B[1]);
});

test("bbox grows by the padding on every side", () => {
  const [s, w, n, e] = bbox([A, B], 100);
  assert.ok(s < 49 && n > 49.001 && w < 1 && e > 1);
  approx(49 - s, 100 / 110574);
});

test("Grid finds every item within reach, and only those", () => {
  const items = [[49, 1], [49.0005, 1], [49.002, 1], [49, 1.001], [49, 1.1]];
  const near = new Grid(items, (x) => x, 100).within([49, 1], 100).map(([x]) => x);
  assert.deepEqual(near.sort(), [[49, 1], [49, 1.001], [49.0005, 1]].sort());
});

test("zonesAround: one bbox for a compact line, one zone per group of stops for a long one", () => {
  const town = [[49.18, -0.37], [49.185, -0.36], [49.19, -0.375]];
  assert.deepEqual(zonesAround(town, 300), [bbox(town, 300)]);
  const coach = [[49.18, -0.37], [49.181, -0.371], [49.3, 0.1], [49.49, 0.11]]; // Caen, ..., Le Havre
  const zones = zonesAround(coach, 300);
  assert.equal(zones.length, 3);
  for (const p of coach) assert.ok(inZones(p, zones));
  assert.ok(!inZones([49.35, -0.1], zones)); // the countryside between them is not read
});

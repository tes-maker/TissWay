// GPX tracks: reading, anchors, adapting the path to a profile, tags of the relation.
import assert from "node:assert/strict";
import { test } from "node:test";
import "./helpers.js";
import { PROFILES, adaptPath, anchorIndices, chainWays, fits, hexColour, parseGpx, relationId, routeTags, snapAnchors, valhalla, writeGpx, writeTracks } from "../src/gpx.js";

const DEG_PER_M = 1 / 111_320; // in longitude at the equator, in latitude almost

/** A straight path along the equator, a point every step metres. */
const line = (length_m, step = 50, lat = 0) => Array.from({ length: length_m / step + 1 }, (_, i) => [lat, i * step * DEG_PER_M]);

test("GPX: the track points, its name, the repeated points removed", () => {
  const gpx = `<?xml version="1.0"?><gpx version="1.1"><metadata><name>File</name></metadata>
    <wpt lat="1" lon="1"><name>Spring</name></wpt>
    <trk><name>Tour du lac &amp; retour</name><trkseg>
      <trkpt lon="2.5" lat="48.1"><ele>10</ele></trkpt><trkpt lat="48.1" lon="2.5"/><trkpt lat='48.2' lon='2.6'></trkpt>
    </trkseg></trk></gpx>`;
  assert.deepEqual(parseGpx(gpx), { name: "Tour du lac & retour", points: [[48.1, 2.5], [48.2, 2.6]] });
});

test("GPX: a route, else waypoints, else an error", () => {
  const route = '<gpx><rte><rtept lat="1" lon="2"/><rtept lat="3" lon="4"/></rte></gpx>';
  assert.deepEqual(parseGpx(route), { name: "", points: [[1, 2], [3, 4]] });
  const wpts = '<gpx><metadata><name>Walk</name></metadata><wpt lat="1" lon="2"/><wpt lat="3" lon="4"/></gpx>';
  assert.deepEqual(parseGpx(wpts), { name: "Walk", points: [[1, 2], [3, 4]] });
  assert.throws(() => parseGpx('<gpx><trk><trkseg><trkpt lat="1" lon="2"/></trkseg></trk></gpx>'), /no track/);
  assert.throws(() => parseGpx("<osm></osm>"), /not a GPX/);
});

test("GPX written back reads the same", () => {
  const path = [[48.1, 2.5], [48.2, 2.6]];
  assert.deepEqual(parseGpx(writeGpx("A <b> & c", path)), { name: "A <b> & c", points: path });
});

test("anchors every 400 m, a short last piece joined to the one before", () => {
  assert.deepEqual(anchorIndices(line(1000)), [0, 8, 16, 20]); // 0, 400, 800 m, and the end: 200 m left is long enough
  assert.deepEqual(anchorIndices(line(850)), [0, 8, 17]); // 50 m after 800: joined
  assert.deepEqual(anchorIndices(line(100)), [0, 2]);
});

test("a leg fits the piece it replaces: close and not much longer", () => {
  const piece = line(400);
  const beside = line(400, 50, 12 * DEG_PER_M); // the cycleway 12 m from the road
  assert.ok(fits(beside, piece));
  assert.ok(!fits(line(400, 50, 80 * DEG_PER_M), piece)); // another street
  const detour = [...line(200), [300 * DEG_PER_M, 200 * DEG_PER_M], ...line(400).slice(4)]; // 300 m away and back
  assert.ok(!fits(detour, piece));
  assert.ok(!fits(null, piece));
});

const road = { use: "road", road_class: "secondary", cycle_lane: "none" };
const cycleway = { use: "cycleway", road_class: "service_other", cycle_lane: "separated" };

/** A match on a single kind of way: every segment, every point on edges of that kind. */
const matchOn = (path, edge) => ({ ways: ["w1"], path, edges: [{ way: "w1", ...edge, begin: 0, end: path.length - 1 }], pointEdge: path.map(() => 0) });

/** Valhalla replaced: legs as given, matched on the cycleway when they are off the road (latitude above 5 m), on the road otherwise. */
function fakeValhalla(t, legsOf, nearby = (pts) => pts.map(() => [])) {
  const calls = { route: [] };
  t.mock.method(valhalla, "nearby", async (pts) => nearby(pts));
  t.mock.method(valhalla, "routeLegs", async (anchors) => {
    calls.route.push(anchors);
    return legsOf(anchors);
  });
  t.mock.method(valhalla, "mapMatch", async (pts) => {
    const edges = [road, cycleway].map((e, i) => ({ way: `w${i + 1}`, ...e, begin: 0, end: 0 }));
    return { ways: ["w2"], path: pts, edges, pointEdge: pts.map(([lat]) => (lat > 5 * DEG_PER_M ? 1 : 0)) };
  });
  return calls;
}

/** The leg between two anchors along the equator, on the cycleway 10 m north, back on the road at the anchors. */
const besideLeg = ([a, b]) => {
  const from = Math.round(a[1] / DEG_PER_M), to = Math.round(b[1] / DEG_PER_M);
  const leg = line(to - from).map(([, lon]) => [10 * DEG_PER_M, lon + from * DEG_PER_M]);
  return [a, ...leg.slice(1, -1), b];
};

test("adapting a path: the road becomes the cycleway beside it", async (t) => {
  const path = line(800);
  fakeValhalla(t, (anchors) => anchors.slice(1).map((b, k) => besideLeg([anchors[k], b])));
  const { match, changed, pieces } = await adaptPath(matchOn(path, road), PROFILES.bicycle);
  assert.equal(pieces, 2);
  assert.equal(changed, 2);
  assert.ok(Math.abs(match.path[3][0] - 10 * DEG_PER_M) < 1e-12);
});

test("adapting a path: a leg no better suited, or straying, keeps the matched piece", async (t) => {
  const path = line(800);
  fakeValhalla(t, () => [line(400), line(400, 50, 80 * DEG_PER_M)]); // on the road again; another street
  const { match, changed } = await adaptPath(matchOn(path, road), PROFILES.bicycle);
  assert.equal(changed, 0);
  assert.equal(match.path, path);
});

test("adapting a path: the cycleway already followed is not left for the road", async (t) => {
  const path = line(400, 50, 10 * DEG_PER_M);
  fakeValhalla(t, () => [line(400)]);
  assert.equal((await adaptPath(matchOn(path, cycleway), PROFILES.bicycle)).changed, 0);
});

test("adapting a path: a leg taken next to a piece kept starts from the matched path", async (t) => {
  const path = line(800);
  const calls = fakeValhalla(t, (anchors) => (anchors.length === 2 ? [besideLeg(anchors)] : [besideLeg(anchors.slice(0, 2)), line(400, 50, 80 * DEG_PER_M).map(([la, lo]) => [la, lo + 400 * DEG_PER_M])]),
    (pts) => pts.map(([lat, lon]) => [{ lat, lon, distance: 0, heading: 90, allowed: true, edge: road }, { lat: lat + 10 * DEG_PER_M, lon, distance: 10, heading: 90, allowed: true, edge: cycleway }]));
  const { changed } = await adaptPath(matchOn(path, road), PROFILES.bicycle);
  assert.equal(changed, 1);
  assert.equal(calls.route.length, 2);
  assert.ok(calls.route[0].every(([lat]) => Math.abs(lat - 10 * DEG_PER_M) < 1e-12)); // all the anchors on the cycleway first
  assert.deepEqual(calls.route[1][1], path[8]); // then the one between the leg taken and the piece kept back on the road
});

test("anchors move onto a better way nearby, parallel to the path, not onto a crossing", async (t) => {
  const path = line(800);
  const crossing = { ...cycleway };
  t.mock.method(valhalla, "nearby", async (pts) => pts.map(([lat, lon], k) => [
    { lat, lon, distance: 0, heading: 90, allowed: true, edge: road },
    k === 1 ? { lat: lat + 5 * DEG_PER_M, lon, distance: 5, heading: 0, allowed: true, edge: crossing } : { lat: lat + 12 * DEG_PER_M, lon, distance: 12, heading: 270, allowed: true, edge: cycleway },
  ]));
  const anchors = await snapAnchors(path, [0, 8, 16], PROFILES.bicycle);
  assert.ok(Math.abs(anchors[0][0] - 12 * DEG_PER_M) < 1e-12);
  assert.deepEqual(anchors[1], path[8]);
  // for a walker, the cycleway is no better than the road
  assert.deepEqual(await snapAnchors(path, [0, 8, 16], PROFILES.foot), [path[0], path[8], path[16]]);
});

test("profiles: what each one prefers", () => {
  const sidewalk = { use: "sidewalk" }, trail = { use: "path" }, lane = { use: "road", road_class: "secondary", cycle_lane: "dedicated" };
  assert.ok(PROFILES.bicycle.prefer(cycleway) > PROFILES.bicycle.prefer(lane));
  assert.ok(PROFILES.bicycle.prefer(lane) > PROFILES.bicycle.prefer(road));
  assert.ok(PROFILES.mtb.prefer(trail) > PROFILES.mtb.prefer(cycleway));
  assert.equal(PROFILES.road_bike.prefer(trail), 0);
  assert.ok(PROFILES.foot.prefer(sidewalk) > PROFILES.foot.prefer(road));
  assert.ok(PROFILES.hiking.prefer(trail) > PROFILES.hiking.prefer(sidewalk));
});

test("tags of the relation", () => {
  assert.deepEqual(routeTags(PROFILES.bicycle, { name: "Voie verte", level: "r" }), { type: "route", route: "bicycle", name: "Voie verte", network: "rcn" });
  assert.deepEqual(routeTags(PROFILES.hiking, { ref: "GR 34", level: "n" }), { type: "route", route: "hiking", ref: "GR 34", network: "nwn" });
  assert.deepEqual(routeTags(PROFILES.mtb), { type: "route", route: "mtb" });
});

test("relation id from an id, r123 or a link", () => {
  assert.equal(relationId("1234567"), "1234567");
  assert.equal(relationId(" r42 "), "42");
  assert.equal(relationId("https://www.openstreetmap.org/relation/9876#map=15/49/0"), "9876");
  assert.equal(relationId("way 12"), null);
  assert.equal(relationId(""), null);
});

test("ways put end to end, each turned to follow the one before", () => {
  // a - b - c drawn backwards, then c - d, then d - e drawn backwards
  assert.deepEqual(chainWays([["b", "a"], ["b", "c"], ["e", "d", "c"]]), [["a", "b", "c", "d", "e"]]);
  // the first way turned to lead to the second
  assert.deepEqual(chainWays([["b", "a"], ["a", "z"]]), [["b", "a", "z"]]);
  assert.deepEqual(chainWays([["a", "b"], ["z", "a"]]), [["b", "a", "z"]]);
  // a gap: two segments
  assert.deepEqual(chainWays([["a", "b"], ["x", "y"], ["y", "z"]]), [["a", "b"], ["x", "y", "z"]]);
});

test("a roundabout drawn whole is followed from its entry to its exit, in its direction", () => {
  const ring = ["r1", "r2", "r3", "r4", "r1"];
  assert.deepEqual(chainWays([["s", "r2"], ring, ["r4", "t"]]), [["s", "r2", "r3", "r4", "t"]]);
  assert.deepEqual(chainWays([["s", "r4"], ring, ["r2", "t"]]), [["s", "r4", "r1", "r2", "t"]]);
});

test("GPX of several tracks, segments and waypoints", () => {
  const text = writeTracks([{ name: "Bus 1: A → B", segments: [[[1, 2], [3, 4]], [[5, 6], [7, 8]]] }, { name: "Bus 1: B → A", segments: [[[7, 8], [1, 2]]] }], [{ lat: 1, lon: 2, name: "A & co" }]);
  assert.equal(text.match(/<trk>/g).length, 2);
  assert.equal(text.match(/<trkseg>/g).length, 3);
  assert.match(text, /<wpt lat="1.0000000" lon="2.0000000"><name>A &amp; co<\/name><extensions>.*<\/extensions><\/wpt>/);
  assert.deepEqual(parseGpx(text).points, [[1, 2], [3, 4], [5, 6], [7, 8], [7, 8], [1, 2]].filter((p, i, a) => i === 0 || p.join() !== a[i - 1].join()));
});

test("tracks in the colour of their line, stops as white dots circled with black", () => {
  const text = writeTracks([{ name: "Bus 1", segments: [[[1, 2], [3, 4]]], colour: "#E3001B" }, { name: "Bus 2", segments: [[[1, 2], [3, 4]]], colour: "" }],
    [{ lat: 1, lon: 2, name: "A" }]);
  assert.match(text, /<trk><name>Bus 1<\/name><extensions><gpx_style:line><gpx_style:color>E3001B<\/gpx_style:color>.*<osmand:color>#e3001b<\/osmand:color>/);
  assert.match(text, /<trk><name>Bus 2<\/name>\n/); // no colour: the app's own
  const wpt = /<wpt[\s\S]*?<\/wpt>/.exec(text)[0];
  assert.match(wpt, /<gpx_style:line><gpx_style:color>000000<\/gpx_style:color><\/gpx_style:line><gpx_style:fill><gpx_style:color>FFFFFF/);
  assert.match(wpt, /<osmand:color>#ffffff<\/osmand:color>/);
  assert.match(text, /xmlns:gpx_style=.*xmlns:osmand=/);
});

test("OSM colours as rrggbb", () => {
  assert.deepEqual(["#E3001B", "e3001b", "#e30", "Red", " navy ", "rouge", "", undefined].map(hexColour), ["e3001b", "e3001b", "ee3300", "ff0000", "000080", "", "", ""]);
});

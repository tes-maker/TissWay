// Local geometry in an equirectangular projection around a point: accurate enough at the scale of a stop or
// a junction. Positions are [lat, lon] in degrees, distances are in metres.

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320; // at the equator
const RAD = Math.PI / 180;

/** [x, y] of p in metres, relative to origin. */
export const xy = (p, origin) => [
  (p[1] - origin[1]) * M_PER_DEG_LON * Math.cos(origin[0] * RAD),
  (p[0] - origin[0]) * M_PER_DEG_LAT,
];

export const dist = (a, b) => Math.hypot(...xy(a, b));

/** [t, distance] of the projection of p on the segment [a, b], t in [0, 1]. */
export function project(p, a, b) {
  const [ax, ay] = xy(a, p), [bx, by] = xy(b, p);
  const dx = bx - ax, dy = by - ay;
  const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
  return [t, Math.hypot(ax + t * dx, ay + t * dy)];
}

export const interpolate = (a, b, t) => [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];

/** [lat, lon] of an OSM node or a GTFS stop. */
export const latlon = (o) => [o.lat, o.lon];

/** Distance from p to the line through a and b (not clamped to the segment). */
export function lineDistance(p, a, b) {
  const [ax, ay] = xy(a, p), [bx, by] = xy(b, p);
  const length = Math.hypot(bx - ax, by - ay);
  return length ? Math.abs(ax * by - ay * bx) / length : Math.hypot(ax, ay);
}

/** Is p on the right of the directed segment a -> b (direction of travel on the way)? */
export function rightOf(p, a, b) {
  const [ax, ay] = xy(a, p), [bx, by] = xy(b, p);
  return ax * by - ay * bx < 0;
}

/** Cumulative length at each point of a polyline. */
export function pathLength(points) {
  const out = points.length ? [0] : [];
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    const k = M_PER_DEG_LON * Math.cos(((a[0] + b[0]) / 2) * RAD);
    out.push(out[i - 1] + Math.hypot((b[1] - a[1]) * k, (b[0] - a[0]) * M_PER_DEG_LAT));
  }
  return out;
}

/** Distance from each point to the nearest segment of the polyline. */
export function distancesToPolyline(points, polyline) {
  if (!polyline.length) return points.map(() => Infinity);
  const line = polyline.length === 1 ? [polyline[0], polyline[0]] : polyline;
  return points.map((p) => {
    let best = Infinity;
    for (let i = 1; i < line.length; i++) best = Math.min(best, project(p, line[i - 1], line[i])[1]);
    return best;
  });
}

/** [[lat, lon]] of an encoded polyline (Valhalla uses precision 6). */
export function decodePolyline(encoded) {
  const coords = [], factor = 1e6;
  let index = 0, lat = 0, lon = 0;
  const next = () => {
    let shift = 0, result = 0, b;
    do {
      b = encoded.charCodeAt(index++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (index < encoded.length) {
    lat += next();
    lon += next();
    coords.push([lat / factor, lon / factor]);
  }
  return coords;
}

/** [south, west, north, east] of the points, grown by pad_m metres on every side. */
export function bbox(points, pad_m = 0) {
  const lats = points.map((p) => p[0]), lons = points.map((p) => p[1]);
  const [s, n] = [Math.min(...lats), Math.max(...lats)];
  const padLon = pad_m / (M_PER_DEG_LON * Math.cos(Math.max(Math.abs(s), Math.abs(n)) * RAD));
  return [s - pad_m / M_PER_DEG_LAT, Math.min(...lons) - padLon, n + pad_m / M_PER_DEG_LAT, Math.max(...lons) + padLon];
}

export const inBbox = ([lat, lon], [s, w, n, e]) => lat >= s && lat <= n && lon >= w && lon <= e;

/** Spatial grid: within(p, m) gives the items of at(item) closer than m metres (cell_m >= m expected). */
export class Grid {
  constructor(items, at, cell_m) {
    this.at = at;
    this.latStep = cell_m / M_PER_DEG_LAT;
    // twice the size at the first item's latitude: still at least cell_m wide up to 60° further north
    this.lonStep = cell_m / (M_PER_DEG_LON * Math.cos(Math.min(85, Math.abs(items.length ? at(items[0])[0] : 0)) * RAD) * 0.5);
    this.cells = new Map();
    for (const item of items) {
      const k = this.key(at(item));
      if (this.cells.has(k)) this.cells.get(k).push(item);
      else this.cells.set(k, [item]);
    }
  }

  key([lat, lon]) {
    return `${Math.floor(lat / this.latStep)}:${Math.floor(lon / this.lonStep)}`;
  }

  /** [[item, distance]] within m metres of p. */
  within(p, m) {
    const out = [];
    const row = Math.floor(p[0] / this.latStep), col = Math.floor(p[1] / this.lonStep);
    for (let r = row - 1; r <= row + 1; r++) {
      for (let c = col - 1; c <= col + 1; c++) {
        for (const item of this.cells.get(`${r}:${c}`) || []) {
          const d = dist(this.at(item), p);
          if (d <= m) out.push([item, d]);
        }
      }
    }
    return out;
  }
}

/** Position of an OSM object: the node, or the center of a way. null without coordinates. */
export const osmPosition = (o) => o.center ?? (o.lat !== undefined ? [o.lat, o.lon] : null);

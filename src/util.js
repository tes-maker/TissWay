// Small helpers, and the logger every module writes to (the page plugs its journal into log.sink).

export const log = {
  sink: (level, message) => console[level === "warn" ? "warn" : "log"](message),
  info: (message) => log.sink("info", message),
  warn: (message) => log.sink("warn", message),
  debug: (message) => log.sink("debug", message),
};

/** The list or set kept under a key of a Map, created on first use. */
export const listIn = (map, key) => map.get(key) ?? map.set(key, []).get(key);
export const setIn = (map, key) => map.get(key) ?? map.set(key, new Set()).get(key);

/** Lexicographic comparison of numbers, strings or arrays of them. */
export function compare(a, b) {
  if (Array.isArray(a)) {
    for (let i = 0; i < a.length; i++) {
      const c = compare(a[i], b[i]);
      if (c) return c;
    }
    return 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** First item with the smallest key (undefined when empty). */
export function minBy(items, key = (x) => x) {
  let best, bestKey;
  for (const item of items) {
    const k = key(item);
    if (bestKey === undefined || compare(k, bestKey) < 0) [best, bestKey] = [item, k];
  }
  return best;
}

/** First item with the largest key (undefined when empty). */
export function maxBy(items, key = (x) => x) {
  let best, bestKey;
  for (const item of items) {
    const k = key(item);
    if (bestKey === undefined || compare(k, bestKey) > 0) [best, bestKey] = [item, k];
  }
  return best;
}

export const sortedBy = (items, key) => [...items].sort((a, b) => compare(key(a), key(b)));

/** Consecutive repeats removed: [a, a, b, a] -> [a, b, a]. */
export const dedupe = (items) => items.filter((x, i) => i === 0 || x !== items[i - 1]);

export const unique = (items) => [...new Set(items)];

/** item -> number of occurrences, in order of first appearance. */
export function counter(items) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  return counts;
}

/** [[item, count]] most frequent first; ties in order of first appearance. */
export const mostCommon = (counts) => [...counts].sort((a, b) => b[1] - a[1]);

export function sameTags(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

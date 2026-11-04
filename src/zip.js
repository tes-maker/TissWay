// Minimal ZIP reader, no dependency: the central directory gives the entries, DecompressionStream inflates
// them on the fly, without ever holding a whole file in memory.

const CENTRAL = 0x02014b50, END = 0x06054b50, LOCAL = 0x04034b50;
const utf8 = new TextDecoder();
const view = async (blob, start, end) => new DataView(await blob.slice(start, end).arrayBuffer());

/** Entries {name, method, compressedSize, offset} of a ZIP Blob. */
export async function zipEntries(blob) {
  const tailStart = Math.max(0, blob.size - 65_557); // end record (22 bytes) + the longest comment
  const tail = await view(blob, tailStart, blob.size);
  let at = tail.byteLength - 22;
  while (at >= 0 && tail.getUint32(at, true) !== END) at--;
  if (at < 0) throw new Error("This file is not a valid ZIP archive.");
  const size = tail.getUint32(at + 12, true), start = tail.getUint32(at + 16, true);
  if (start === 0xffffffff) throw new Error("ZIP64 archives are not supported.");

  const dir = await view(blob, start, start + size);
  const entries = [];
  for (let p = 0; p + 46 <= dir.byteLength && dir.getUint32(p, true) === CENTRAL;) {
    const nameLength = dir.getUint16(p + 28, true);
    entries.push({
      name: utf8.decode(new Uint8Array(dir.buffer, dir.byteOffset + p + 46, nameLength)),
      method: dir.getUint16(p + 10, true),
      compressedSize: dir.getUint32(p + 20, true),
      offset: dir.getUint32(p + 42, true),
    });
    p += 46 + nameLength + dir.getUint16(p + 30, true) + dir.getUint16(p + 32, true);
  }
  return entries;
}

/** ReadableStream of the uncompressed bytes of an entry. */
export async function entryStream(blob, entry) {
  const head = await view(blob, entry.offset, entry.offset + 30);
  if (head.getUint32(0, true) !== LOCAL) throw new Error(`Corrupt ZIP archive (${entry.name})`);
  const data = entry.offset + 30 + head.getUint16(26, true) + head.getUint16(28, true);
  const raw = blob.slice(data, data + entry.compressedSize).stream();
  if (entry.method === 0) return raw;
  if (entry.method !== 8) throw new Error(`Unsupported ZIP compression (${entry.name})`);
  return raw.pipeThrough(new DecompressionStream("deflate-raw"));
}

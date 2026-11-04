// Development server: ES modules cannot be loaded from file://. Any static host works in production.
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PORT = Number(process.env.PORT) || 8000;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".otf": "font/otf" };

createServer((req, res) => {
  const path = normalize(decodeURIComponent(new URL(req.url, "http://localhost").pathname));
  let file = join(ROOT, path);
  if (!file.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return res.writeHead(403).end();
  try {
    if (statSync(file).isDirectory()) file = join(file, "index.html");
    statSync(file);
  } catch {
    return res.writeHead(404).end("Not found");
  }
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
  createReadStream(file).pipe(res);
}).listen(PORT, "127.0.0.1", () => console.log(`tissway: http://localhost:${PORT}`));

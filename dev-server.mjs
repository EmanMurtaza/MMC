// Local dev server: serves the static site and mounts the Netlify function at /api/*.
// Usage: node dev-server.mjs  →  http://localhost:8888
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import handler from "./netlify/functions/api.mjs";

const PORT = process.env.PORT || 8888;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname.startsWith("/api")) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks),
    });
    const response = await handler(request);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
    return;
  }

  let file = url.pathname === "/" ? "/index.html" : url.pathname;
  if (file === "/admin") file = "/admin.html";
  try {
    const data = await fs.readFile(path.join(process.cwd(), file));
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("Not found");
  }
}).listen(PORT, () => console.log(`MMC dev server → http://localhost:${PORT}`));

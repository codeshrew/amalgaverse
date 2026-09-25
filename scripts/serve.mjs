#!/usr/bin/env node
// Zero-dependency static server for the site/ folder.
//   node scripts/serve.mjs [port]
// Pass --watch to re-run the updater every 15 minutes while serving.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { extname, join, normalize } from 'node:path';

const root = new URL('../site/', import.meta.url).pathname;
const port = Number(process.argv.find((a) => /^\d+$/.test(a)) || process.env.PORT || 4077);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) throw Object.assign(new Error('forbidden'), { code: 'EACCES' });
    await stat(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Signal lost.');
  }
}).listen(port, () => console.log(`Amalgaverse console online → http://localhost:${port}`));

if (process.argv.includes('--watch')) {
  const run = () => spawn(process.execPath, [new URL('./update.mjs', import.meta.url).pathname], { stdio: 'inherit' });
  run();
  setInterval(run, 15 * 60_000);
}

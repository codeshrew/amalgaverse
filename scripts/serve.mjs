#!/usr/bin/env node
// Zero-dependency static server for the site/ folder.
//   node scripts/serve.mjs [port]
// Pass --watch to re-run the updater every 30 minutes while serving.
// Supports HTTP Range (Safari needs it for <video>) and a /proxy?u= passthrough for
// video.twimg.com, which rejects cross-site browser requests.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';
import { extname, join, normalize } from 'node:path';

const root = new URL('../site/', import.meta.url).pathname;
const port = Number(process.argv.find((a) => /^\d+$/.test(a)) || process.env.PORT || 4077);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

async function proxy(req, res, target) {
  let u;
  try {
    u = new URL(target);
  } catch {
    u = null;
  }
  if (!u || u.protocol !== 'https:' || !['video.twimg.com', 'pbs.twimg.com'].includes(u.hostname)) {
    res.writeHead(400).end('bad proxy target');
    return;
  }
  const upstream = await fetch(u, { headers: req.headers.range ? { range: req.headers.range } : {} });
  const headers = { 'cache-control': 'public, max-age=86400' };
  for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  res.writeHead(upstream.status, headers);
  if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
  else res.end();
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/proxy') return await proxy(req, res, url.searchParams.get('u'));
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const file = normalize(join(root, path));
    if (!file.startsWith(root)) throw new Error('forbidden');
    const info = await stat(file);
    const type = TYPES[extname(file)] || 'application/octet-stream';
    const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
    if (range) {
      const start = range[1] ? +range[1] : Math.max(0, info.size - +range[2]);
      const end = range[1] && range[2] ? Math.min(+range[2], info.size - 1) : info.size - 1;
      if (start >= info.size) {
        res.writeHead(416, { 'content-range': `bytes */${info.size}` }).end();
        return;
      }
      res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${info.size}`, 'content-length': end - start + 1 });
      createReadStream(file, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'no-cache', 'content-length': info.size });
    if (type === 'video/mp4') createReadStream(file).pipe(res);
    else res.end(await readFile(file));
  } catch {
    if (!res.headersSent) res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Signal lost.');
  }
}).listen(port, () => console.log(`Amalgaverse console online → http://localhost:${port}`));

if (process.argv.includes('--watch')) {
  let busy = false;
  const run = () => {
    if (busy) return;
    busy = true;
    spawn(process.execPath, [new URL('./update.mjs', import.meta.url).pathname], { stdio: 'inherit' }).on('close', () => (busy = false));
  };
  run();
  setInterval(run, 30 * 60_000);
}

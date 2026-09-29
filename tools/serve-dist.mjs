/**
 * serve-dist.mjs —— 极简静态服务器，只用来给 headless Chrome 截图 / 快速预览构建产物。
 * 不依赖 esbuild / vite，因此可以在受限沙箱里直接跑。
 * 运行：node tools/serve-dist.mjs [端口]
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 脚本在 tools/ 下，构建产物在项目根的 dist/
const ROOT = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const PORT = Number(process.argv[2] ?? 4173);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    let rel = normalize(url).replace(/^([/\\])+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = join(ROOT, rel);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`serving dist at http://127.0.0.1:${PORT}/`);
});

import assert from 'node:assert/strict';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { HDR_PRESETS } from '../src/environment.js';

// 按需联网验证官方资源；不放入离线 check，不写入磁盘。
await Promise.all(HDR_PRESETS.map(async ({ name, url }) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  assert.ok(response.ok, `${name}: HTTP ${response.status}`);
  assert.equal(response.headers.get('access-control-allow-origin'), '*', `${name}: CORS`);
  const buffer = await response.arrayBuffer();
  const data = new HDRLoader().parse(buffer);
  assert.ok(data.width > 0 && data.height > 0);
  console.log(`${name}: HTTP 200, CORS OK, HDR ${data.width}×${data.height}, ${buffer.byteLength} bytes`);
}));

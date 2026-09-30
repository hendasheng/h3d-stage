import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createEnvironmentLighting, HDR_PRESETS } from '../src/environment.js';

// 只替换 GPU 预过滤，HDR 解析与异步切换执行生产代码。
const targets = [];
function target(kind) {
  const result = { texture: { kind }, disposed: false, dispose() { this.disposed = true; } };
  targets.push(result);
  return result;
}
THREE.PMREMGenerator.prototype.fromScene = () => target('room');
THREE.PMREMGenerator.prototype.fromEquirectangular = (texture) => {
  assert.equal(texture.image.width, 2);
  assert.equal(texture.image.height, 1);
  assert.equal(texture.colorSpace, THREE.LinearSRGBColorSpace);
  assert.equal(texture.flipY, true);
  return target('hdr');
};

const header = new TextEncoder().encode('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 1 +X 2\n');
const hdr = new Uint8Array([...header, 255, 100, 30, 129, 30, 100, 255, 129]);
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  assert.ok(HDR_PRESETS.some((preset) => preset.url === url));
  return { ok: true, arrayBuffer: async () => hdr.buffer };
};
const scene = new THREE.Scene();
scene.environmentIntensity = 2;
let state;
const lighting = createEnvironmentLighting({}, scene, (value) => { state = value; });
const original = scene.environment;
assert.equal(state.current, 'room');

await lighting.select('royal');
assert.equal(state.current, 'royal');
assert.equal(scene.environment.kind, 'hdr');
assert.equal(scene.environmentIntensity, 2, '切换不重置环境亮度');
assert.ok(state.options.some((item) => item.value === 'royal'));
const goodTexture = scene.environment;
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new TextEncoder().encode('bad data').buffer });
await lighting.select('sunset');
assert.equal(scene.environment, goodTexture, '坏 HDR 不替换当前环境');
assert.match(state.status, /加载失败/);
globalThis.fetch = async () => ({ ok: false, status: 503 });
await lighting.select('sunset');
assert.equal(scene.environment, goodTexture, '网络失败不替换当前环境');
assert.match(state.status, /503/);
globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => hdr.buffer });

await lighting.select('none');
assert.equal(scene.environment, null);
assert.equal(targets[1].disposed, true, '退出 HDR 释放 GPU 目标');
await lighting.select('room');
assert.equal(scene.environment, original);
await lighting.select('royal');
assert.equal(scene.environment.kind, 'hdr', '可重新选择 HDR 预设');

let resolveSlow;
globalThis.fetch = () => new Promise((resolve) => { resolveSlow = resolve; });
const pending = lighting.select('sunrise');
await lighting.select('none');
resolveSlow({ ok: true, arrayBuffer: async () => hdr.buffer });
await pending;
assert.equal(state.current, 'none', '旧加载结果不能覆盖较新的选择');
assert.equal(scene.environment, null);
lighting.dispose();
globalThis.fetch = realFetch;
assert.ok(targets.every((item) => item.disposed), '释放全部 PMREM 目标');
console.log('环境测试通过：HDR 解析、切换、亮度保留、失败回退、异步竞态、资源释放');

import assert from 'node:assert/strict';
import * as THREE from 'three';
import { configureKeyShadow, setSelfShadows, setShadowSoftness } from '../src/shadows.js';

const key = new THREE.DirectionalLight();
const extent = configureKeyShadow(key, 10);
assert.equal(extent, 17.5);
assert.equal(key.castShadow, true);
assert.equal(key.shadow.mapSize.width, 4096);
assert.equal(key.shadow.mapSize.height, 4096);
assert.equal(key.shadow.camera.left, -17.5);
assert.equal(key.shadow.camera.right, 17.5);
assert.equal(key.shadow.camera.far, 70);
assert.equal(setShadowSoftness(key, 3.5), 3.5);
assert.equal(key.shadow.radius, 3.5);
assert.equal(setShadowSoftness(key, 99), 8);
assert.equal(setShadowSoftness(key, -1), 0);

const parts = [
  { object: new THREE.Mesh() },
  { object: new THREE.Mesh() },
];
setSelfShadows(parts);
for (const { object } of parts) {
  assert.equal(object.castShadow, true);
  assert.equal(object.receiveShadow, true);
}
setSelfShadows(parts, false);
for (const { object } of parts) {
  assert.equal(object.castShadow, false);
  assert.equal(object.receiveShadow, false);
}

console.log('shadow setup checks passed');

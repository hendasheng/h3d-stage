import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createFogBackdrop, createFogBackground, createFogGround, createVerticalFog } from '../src/fog.js';

const settings = { enabled: true, height: -5, smoothness: 3, depth: 30, depthSmoothness: 15 };
const fog = createVerticalFog(settings);
const material = new THREE.MeshStandardMaterial();
fog.attach([{ material }]);
assert.match(material.customProgramCacheKey(), /thibaut-fog-v1/);
const shader = { uniforms: {}, vertexShader: '#include <common>\n#include <worldpos_vertex>', fragmentShader: '#include <common>\nvec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;' };
material.onBeforeCompile(shader);
assert.match(shader.vertexShader, /vWorldPosition/);
assert.match(shader.fragmentShader, /verticalMixer/);
assert.equal(shader.uniforms.fogPositionY.value, -5);
fog.update({ enabled: false, height: 1, smoothness: 2, depth: 5, depthSmoothness: 6 });
assert.equal(fog.uniforms.fogEnabled.value, 0);
assert.equal(fog.uniforms.fogPositionY.value, 1);

const background = createFogBackground(settings);
assert.equal(background.mesh.geometry.parameters.radius, 100);
assert.equal(background.mesh.material.side, THREE.BackSide);
const backdrop = createFogBackdrop(settings, new THREE.PerspectiveCamera());
assert.equal(backdrop.mesh.geometry.parameters.radius, .5);
assert.equal(backdrop.mesh.renderOrder, 9);
const ground = createFogGround();
assert.equal(ground.geometry.parameters.radius, 100);
console.log('reference fog checks passed');

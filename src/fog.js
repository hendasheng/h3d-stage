import * as THREE from 'three';

// 逐行对应 https://projects.thibautfoussard.com/fog/ 的材质注入。
export function createVerticalFog(settings) {
  const uniforms = { fogPositionY: { value: settings.height }, fogSmoothness: { value: settings.smoothness }, fogDepth: { value: settings.depth }, fogDepthSmoothness: { value: settings.depthSmoothness }, fogEnabled: { value: settings.enabled ? 1 : 0 } };
  const fogCode = `
float verticalMixer = smoothstep(vWorldPosition.y - fogSmoothness, vWorldPosition.y + fogSmoothness, fogPositionY);
float distanceToCamera = length(vWorldPosition - cameraPosition);
float depthMixer = smoothstep(distanceToCamera + fogDepthSmoothness, distanceToCamera - fogDepthSmoothness, fogDepth);
depthMixer = mix(0.0, depthMixer, verticalMixer);
float mixer = verticalMixer * .5 + depthMixer * .95;
mixer = clamp(mixer, 0.0, 1.0) * fogEnabled;
outgoingLight = mix(outgoingLight, vec3(1.0), mixer);`;
  return {
    attach(parts) {
      for (const material of new Set(parts.map((part) => part.material).filter(Boolean))) {
        const old = material.onBeforeCompile, oldKey = material.customProgramCacheKey;
        material.onBeforeCompile = (shader) => {
          old?.(shader); Object.assign(shader.uniforms, uniforms);
          shader.vertexShader = shader.vertexShader.replace('#include <common>', '#include <common>\nvarying vec3 vWorldPosition;').replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWorldPosition = worldPosition.xyz;');
          shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nuniform float fogPositionY, fogSmoothness, fogDepth, fogDepthSmoothness, fogEnabled; varying vec3 vWorldPosition;').replace('vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;', `vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;${fogCode}`);
        };
        material.customProgramCacheKey = () => `${oldKey?.call(material) ?? ''}|thibaut-fog-v1`;
        material.needsUpdate = true;
      }
    },
    update(next) { uniforms.fogPositionY.value = next.height; uniforms.fogSmoothness.value = next.smoothness; uniforms.fogDepth.value = next.depth; uniforms.fogDepthSmoothness.value = next.depthSmoothness; uniforms.fogEnabled.value = next.enabled ? 1 : 0; },
    uniforms,
  };
}

// 原页 IK：固定半径 100 的背景球。
export function createFogBackground(settings) {
  const uniforms = { position: { value: settings.height }, smoothness: { value: settings.smoothness } };
  const material = new THREE.ShaderMaterial({ uniforms, transparent: true, side: THREE.BackSide,
    vertexShader: 'varying vec3 vWorldPosition;void main(){vWorldPosition=(modelMatrix*vec4(position,1.0)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'uniform float position;uniform float smoothness;varying vec3 vWorldPosition;void main(){float mixer=smoothstep(vWorldPosition.y-smoothness,vWorldPosition.y+smoothness,position);vec4 color=mix(vec4(1.0),vec4(1.0,1.0,1.0,0.0),1.0-mixer);gl_FragColor=color;}' });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 36, 18), material); mesh.name = 'thibaut-fog-background';
  return { mesh, update(next) { uniforms.position.value = next.height; uniforms.smoothness.value = next.smoothness; } };
}

// 原页 zK：跟随相机的半径 0.5 背面球。
export function createFogBackdrop(settings, camera) {
  const uniforms = { positionY: { value: settings.height }, smoothness: { value: settings.smoothness } };
  const material = new THREE.ShaderMaterial({ uniforms, transparent: true, side: THREE.BackSide,
    vertexShader: 'varying float vElevation;uniform float positionY,smoothness;void main(){vec3 vWorldPosition=(modelMatrix*vec4(position,1.0)).xyz;vElevation=smoothstep(vWorldPosition.y+smoothness,vWorldPosition.y-smoothness,positionY);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: 'varying float vElevation;void main(){float mixer=(1.0-vElevation)*.5;gl_FragColor=vec4(1.0,1.0,1.0,mixer);}' });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(.5, 32, 16), material); mesh.name = 'thibaut-fog-camera-sphere'; mesh.renderOrder = 9;
  return { mesh, update(next) { uniforms.positionY.value = next.height; uniforms.smoothness.value = next.smoothness; }, tick() { mesh.position.copy(camera.position); } };
}

// 原页 DK：深灰圆形地面；位置由 main 按模型底部设置。
export function createFogGround() {
  const mesh = new THREE.Mesh(new THREE.CircleGeometry(100, 32), new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 1, metalness: 0 }));
  mesh.rotation.x = -Math.PI * .5; mesh.name = 'thibaut-fog-ground';
  return mesh;
}

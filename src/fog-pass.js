import * as THREE from 'three';

/**
 * fog-pass.js —— **全局雾**：着色器定义 + 相机矩阵刷新。
 *
 * ## 雾为什么必须是全屏后期，而不是给材质注入
 *
 * 材质注入按定义只改**实体表面**的像素。模型和相机之间的空间没有东西可以改，
 * 所以那种做法永远只能得到"模型表面浮着一层雾"，做不出"空间里有雾"。
 *
 * ## 深度从哪来（**不能**用挂在 composer target 上的 DepthTexture）
 *
 * 直觉做法是给 composer 的 render target 挂一张 `DepthTexture` 让雾读。**那会撞上硬限制**：
 *
 *   `GL_INVALID_OPERATION: glDrawArrays: Feedback loop formed between Framebuffer
 *    and active Texture`
 *
 * 因为雾输出的那个 framebuffer，其深度附件**正是**它采样的纹理 —— 同一张图既读又写，
 * WebGL 直接丢弃这次绘制（画面表现是"雾没生效"或整屏乱闪）。这是 API 层面禁止的，
 * 不是参数问题。
 *
 * 所以深度来自 `src/fog-depth.js` 的**独立预渲染**：它把深度用 `RGBADepthPacking`
 * 写进一张独立的普通 RGBA 纹理（与雾的输出 framebuffer 毫无关系），
 * 这里用 three 自带的 `unpackRGBAToDepth()` 解包。
 *
 * ## 公式（与参考站一致，只换了作用位置）
 *
 *   verticalMixer = smoothstep(y - smoothness, y + smoothness, positionY + noiseOffset)
 *   depthMixer    = smoothstep(d + dSmooth, d - dSmooth, fogDepth)，再被 verticalMixer 门控
 *   mixer         = clamp(verticalMixer*.5 + depthMixer*.95, 0, 1)
 *   color         = mix(color, fogColor, mixer)
 *
 * 另外加了两点参考站没有的处理：**距离衰减**与**雾量封顶**（见着色器里的注释）。
 * 没有它们时，只要物体低于雾面，连近处表面也会被盖上 50% 白 —— 画面会糊成一片。
 */

export const FOG_PASS_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    // **必须自己传矩阵**：`inverseProjectionMatrix` / `viewMatrixInverse` 是 three 给
    // **内建材质**注入的 uniform，自定义 ShaderMaterial 拿不到。
    // 踩过：直接引用它们 → 片元编译失败 → 整条后期链静默失效（只在控制台留一句 shader error）。
    uInvProjection: { value: new THREE.Matrix4() },
    uCameraWorld: { value: new THREE.Matrix4() },
    uFogColor: { value: new THREE.Color(0xffffff) },
    fogPositionY: { value: 0 },
    fogSmoothness: { value: 0 },
    fogDepth: { value: 0 },
    fogDepthSmoothness: { value: 0 },
    fogEnabled: { value: 0 },
    // 雾量上限：留一点本体颜色，别把画面吃光（参考站是 1.0，实测太糊）
    uFogMaxMixer: { value: 0.85 },
    uFogNoise: { value: null },
    fogNoiseScale: { value: 0.06 },
    fogNoiseStrength: { value: 0 },
    uFogTime: { value: 0 },
    uFogDynamic: { value: 0 },
    fogFlow: { value: new THREE.Vector2(0.012, 0.007) },
    fogFlowZ: { value: 0.006 },
    fogWarp: { value: 0.35 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragmentShader: `
    #include <common>
    #include <packing>
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float cameraNear;
    uniform float cameraFar;
    uniform mat4 uInvProjection;
    uniform mat4 uCameraWorld;
    uniform vec3 uFogColor;
    uniform float fogPositionY;
    uniform float fogSmoothness;
    uniform float fogDepth;
    uniform float fogDepthSmoothness;
    uniform float fogEnabled;
    uniform float uFogMaxMixer;
    uniform sampler2D uFogNoise;
    uniform float fogNoiseScale;
    uniform float fogNoiseStrength;
    uniform float uFogTime;
    uniform float uFogDynamic;
    uniform vec2 fogFlow;
    uniform float fogFlowZ;
    uniform float fogWarp;
    varying vec2 vUv;

    /**
     * 三维噪声：在一张二维无缝贴图的两个"层"之间做三线性插值。
     * 每层在自己的 UV 空间里平铺（贴图本身无缝），层间按 z 的小数部分混合。
     * 这样不需要 3D 纹理，却是货真价实的三维噪声 —— 竖直面上不会被拉成条。
     */
    float noiseVolume(vec3 p) {
      float z0 = floor(p.z);
      float fz = p.z - z0;
      vec2 o0 = vec2(z0 * 0.137, z0 * 0.317);
      vec2 o1 = vec2((z0 + 1.0) * 0.137, (z0 + 1.0) * 0.317);
      float a = texture2D(uFogNoise, p.xy + o0).r;
      float b = texture2D(uFogNoise, p.xy + o1).r;
      return mix(a, b, fz);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);

      // 深度是**独立预渲染**写进普通 RGBA 纹理的（RGBADepthPacking）→ 解包
      float packed = texture2D(tDepth, vUv).r;
      float rawDepth = unpackRGBAToDepth(texture2D(tDepth, vUv));
      // 背景没写深度（clear 到 1）→ 当作"无限远"，这样背景/天穹也参与雾
      float viewZ = (rawDepth >= 1.0 - 1e-6)
        ? -cameraFar
        : perspectiveDepthToViewZ(rawDepth, cameraNear, cameraFar);
      vec4 ndc = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
      vec4 viewPos = uInvProjection * ndc;
      // 逆投影在 z=远平面处退化（w→0）。夹住，别让后面算出 Inf/NaN。
      viewPos /= (abs(viewPos.w) < 1e-6 ? (viewPos.w < 0.0 ? -1e-6 : 1e-6) : viewPos.w);
      viewPos.z = viewZ;
      vec3 world = (uCameraWorld * vec4(viewPos.xyz, 1.0)).xyz;
      // 硬保护：世界坐标一旦非有限就原样输出。
      // 输出垃圾这种失败模式看起来就是整屏乱闪，代价太大，值得多一层保险。
      if (!all(lessThan(abs(world), vec3(1e7))) || !(packed >= 0.0)) {
        gl_FragColor = color;
        return;
      }

      // 动态：三维噪声扰动雾面高度
      vec3 np = world * fogNoiseScale + vec3(uFogTime * fogFlow.x, uFogTime * fogFlow.y, uFogTime * fogFlowZ);
      float warp = noiseVolume(np * 0.37);
      float n = noiseVolume(np + vec3((warp - 0.5) * fogWarp));
      float noiseOffset = (n - 0.5) * fogNoiseStrength * uFogDynamic;

      float verticalMixer = smoothstep(world.y - fogSmoothness, world.y + fogSmoothness, fogPositionY + noiseOffset);
      float distanceToCamera = length(world - cameraPosition);
      float depthMixer = smoothstep(distanceToCamera + fogDepthSmoothness, distanceToCamera - fogDepthSmoothness, fogDepth);
      depthMixer = mix(0.0, depthMixer, verticalMixer);
      float mixer = clamp(verticalMixer * 0.5 + depthMixer * 0.95, 0.0, 1.0);

      // 距离衰减：参考站的高度项是恒定的，照搬会让近处表面也被盖上 50% 白 → 糊成一片
      float nearFade = smoothstep(0.0, max(fogDepth, 1.0), distanceToCamera);
      mixer *= nearFade;
      mixer = min(mixer, uFogMaxMixer) * fogEnabled;
      if (!(mixer >= 0.0)) mixer = 0.0;

      gl_FragColor = vec4(mix(color.rgb, uFogColor, mixer), color.a);
    }`,
};

/**
 * 给一个使用 `FOG_PASS_SHADER` 的材质接上"每帧刷新相机矩阵与深度纹理"的能力。
 *
 * @param {THREE.ShaderMaterial} material
 * @param {THREE.Camera} camera
 * @param {() => object} [getDepthTexture] 每帧取一次深度纹理。
 *   必须用 getter 而不是值：窗口缩放会重建 render target，旧纹理随之作废。
 * @returns {{update: () => void}}
 */
export function bindFogCamera(material, camera, getDepthTexture) {
  const update = () => {
    if (!material || !camera) return;
    const u = material.uniforms;
    if (u.uInvProjection) u.uInvProjection.value.copy(camera.projectionMatrixInverse);
    camera.updateMatrixWorld();
    if (u.uCameraWorld) u.uCameraWorld.value.copy(camera.matrixWorld);
    if (u.cameraNear) u.cameraNear.value = camera.near;
    if (u.cameraFar) u.cameraFar.value = camera.far;
    if (getDepthTexture && u.tDepth) {
      const depth = getDepthTexture();
      if (depth && u.tDepth.value !== depth) u.tDepth.value = depth;
    }
  };
  update();
  return { update };
}

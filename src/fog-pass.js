import * as THREE from 'three';

/**
 * fog-pass.js —— **全局雾**：一个全屏后期 pass，用深度重建每个像素的世界坐标。
 *
 * 为什么不能再靠"给材质注入"（0.5 第一版的根本错误）：
 *   材质注入按定义只改**实体表面**的像素。模型和相机之间的空间没有东西可以改，
 *   所以那种做法永远只能得到"模型表面浮着一层雾"，做不出"空间里有雾"。
 *   要让雾全局生效，它必须是一个**覆盖整个画面**的 pass。
 *
 * 顺带解决条带问题：材质注入里我只能拿到被渲染的那个面的世界坐标，
 * 在竖直面上 xz 几乎不变，噪声被沿高度拉成竖条（用户一眼就看出来了）。
 * 现在每个像素都有完整的世界坐标，噪声用**三维**采样，竖直面上自然有变化。
 *
 * 深度重建的做法 —— **矩阵必须自己传**：
 *   viewZ  = perspectiveDepthToViewZ( texture(tDepth).x, near, far )
 *   viewPos = (uInvProjection * ndc) 归一化后把 z 换成 viewZ
 *   world   = uCameraWorld * viewPos
 *   其中 uInvProjection = camera.projectionMatrixInverse，uCameraWorld = camera.matrixWorld，
 *   由 `bindFogPassCamera()` 每帧刷新（相机一动它们就变，不刷新雾会错位）。
 *
 * 雾的**公式与 0.4/参考站完全一致**，只是从"改材质颜色"搬到"改最终颜色"：
 *   verticalMixer = smoothstep(y - smoothness, y + smoothness, positionY + noiseOffset)
 *   depthMixer    = smoothstep(d + dSmooth, d - dSmooth, depth)  然后被 verticalMixer 门控
 *   mixer         = clamp(verticalMixer*.5 + depthMixer*.95, 0, 1) * enabled
 *   color         = mix(color, fogColor, mixer)
 */

/**
 * 给一个 ShaderPass 接上"每帧刷新相机矩阵（以及深度纹理）"的能力。
 *
 * @param {object} pass three 的 ShaderPass（uniforms 用 FOG_PASS_SHADER）
 * @param {THREE.Camera} camera
 * @param {() => object} [getDepthTexture] 每帧取一次深度纹理。
 *   必须用 getter 而不是值：`EffectComposer.setSize()`（窗口缩放）会**重建**它的两个
 *   render target，旧的深度纹理随之作废，抱着旧引用会让雾读到一张死纹理。
 * @returns {{update: () => void}} 每帧调用 update()
 */
export function bindFogPassCamera(pass, camera, getDepthTexture) {
  const update = () => {
    if (!pass || !camera) return;
    pass.uniforms.uInvProjection.value.copy(camera.projectionMatrixInverse);
    camera.updateMatrixWorld();
    pass.uniforms.uCameraWorld.value.copy(camera.matrixWorld);
    pass.uniforms.cameraNear.value = camera.near;
    pass.uniforms.cameraFar.value = camera.far;
    if (getDepthTexture) {
      const depth = getDepthTexture();
      if (depth && pass.uniforms.tDepth.value !== depth) pass.uniforms.tDepth.value = depth;
    }
  };
  update();
  return { update };
}


export const FOG_PASS_SHADER = {
  uniforms: {
    tDiffuse: { value: null },
    tDepth: { value: null },
    cameraNear: { value: 0.1 },
    cameraFar: { value: 1000 },
    // **必须自己传矩阵**：`inverseProjectionMatrix` / `viewMatrixInverse` 是 three 给
    // **内建材质**注入的 uniform，自定义 ShaderMaterial 拿不到。
    // 踩过：直接引用它们 → 片元编译失败 → 整条后期链静默失效（只在控制台留一句 shader error，
    // 画面看起来"雾没生效"，极难查）。
    uInvProjection: { value: new THREE.Matrix4() },
    uCameraWorld: { value: new THREE.Matrix4() },
    uFogColor: { value: new THREE.Color(0xffffff) },
    fogPositionY: { value: -2 },
    fogSmoothness: { value: 5 },
    fogDepth: { value: 70 },
    fogDepthSmoothness: { value: 25 },
    uFogEnabled: { value: 1 },
    uFogNoise: { value: null },
    fogNoiseScale: { value: 0.06 },
    fogNoiseStrength: { value: 6 },
    uFogTime: { value: 0 },
    uFogDynamic: { value: 1 },
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
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform float cameraNear;
    uniform float cameraFar;
    // ShaderPass 用的是一张普通 quad，three 不会给自定义材质注入这两个矩阵 —— 必须自己声明并传入。
    uniform mat4 uInvProjection;
    uniform mat4 uCameraWorld;
    uniform vec3 uFogColor;
    uniform float fogPositionY;
    uniform float fogSmoothness;
    uniform float fogDepth;
    uniform float fogDepthSmoothness;
    uniform float uFogEnabled;
    uniform sampler2D uFogNoise;
    uniform float fogNoiseScale;
    uniform float fogNoiseStrength;
    uniform float uFogTime;
    uniform float uFogDynamic;
    uniform vec2 fogFlow;
    uniform float fogFlowZ;
    uniform float fogWarp;
    varying vec2 vUv;

    float perspectiveDepthToViewZ(const in float invClipZ, const in float near, const in float far) {
      return (near * far) / ((far - near) * invClipZ - far);
    }

    /**
     * 三维噪声：在一张二维无缝贴图的两个"层"之间做三线性插值。
     * p 是已经乘过缩放的噪声坐标。
     * 每层在自己的 UV 空间里平铺（贴图本身无缝），层间按 z 的小数部分混合，
     * 于是任意方向上都有连续变化 —— 竖直面不会退化成一条一条。
     */
    float noiseVolume(vec3 p) {
      float z0 = floor(p.z);
      float fz = p.z - z0;
      // 每层给一个固定的 UV 偏移，避免两层采到同一条轨迹
      vec2 o0 = vec2(z0 * 0.137, z0 * 0.317);
      vec2 o1 = vec2((z0 + 1.0) * 0.137, (z0 + 1.0) * 0.317);
      float a = texture2D(uFogNoise, p.xy + o0).r;
      float b = texture2D(uFogNoise, p.xy + o1).r;
      return mix(a, b, fz);
    }

    void main() {
      vec4 color = texture2D(tDiffuse, vUv);

      // 世界坐标：深度 + 逆投影 + 视图矩阵的逆
      float d = texture2D(tDepth, vUv).x;
      float viewZ = perspectiveDepthToViewZ(d, cameraNear, cameraFar);
      vec4 ndc = vec4(vUv * 2.0 - 1.0, 0.0, 1.0);
      vec4 viewPos = uInvProjection * ndc;
      // 逆投影在 z=远平面处会退化（w 为 0），指数超大。夹住，别让后面算出 Inf/NaN。
      viewPos /= (abs(viewPos.w) < 1e-6 ? (viewPos.w < 0.0 ? -1e-6 : 1e-6) : viewPos.w);
      viewPos.z = viewZ;
      vec3 world = (uCameraWorld * vec4(viewPos.xyz, 1.0)).xyz;
      // 硬保护：世界坐标一旦非有限（深度纹理异常、矩阵未更新等），直接原样输出。
      // 宁可不加雾，也绝不能把垃圾值混进画面 —— 那种情况看起来就是整屏爆闪。
      if (!all(lessThan(abs(world), vec3(1e7)))) {
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
      float mixer = clamp(verticalMixer * 0.5 + depthMixer * 0.95, 0.0, 1.0) * uFogEnabled;
      // mixer 也必须有限，否则 mix 出来是 NaN
      if (!(mixer >= 0.0)) mixer = 0.0;

      gl_FragColor = vec4(mix(color.rgb, uFogColor, mixer), color.a);
    }`,
};

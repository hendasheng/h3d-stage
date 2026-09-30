import * as THREE from 'three';

/**
 * fog-depth.js —— 给全局雾用的**独立深度预渲染**。
 *
 * ## 为什么必须独立，不能直接用 composer target 上挂的深度
 *
 * 直觉做法是给 composer 的 render target 挂一张 `DepthTexture`，让雾 pass 读它。
 * 但那样会撞上 WebGL 的硬性限制：
 *
 *   `GL_INVALID_OPERATION: glDrawArrays: Feedback loop formed between Framebuffer
 *    and active Texture`
 *
 * 因为雾 pass 输出到的那个 framebuffer，其深度附件**正是**它采样的纹理 ——
 * 同一张图既当读源又当写目标，绘制会被直接丢弃（画面看起来就是"雾没生效"或整屏乱闪）。
 * 这不是参数问题，也不是版本问题，是 API 层面的禁止。
 *
 * ## 做法
 *
 * 在场景颜色之前先跑一遍"只写深度"的预渲染，深度落在**它自己的** framebuffer 上：
 *
 *   1. 用 `MeshDepthMaterial` + `RGBADepthPacking` 把深度写进一张**普通颜色纹理**
 *      （这样在着色器里用 three 自带的 `unpackRGBAToDepth()` 解包，不必依赖深度纹理格式）；
 *   2. 换回正常材质渲染一遍颜色到 composer 的 target（用 `scene.overrideMaterial` 临时替换）；
 *   3. 雾 pass 读那张独立的深度纹理 —— 它与雾的输出 framebuffer **没有任何关系**，不存在反馈。
 *
 * `RGBADepthPacking` 在 8 位纹理上只有 32 位精度里的一小段，但对雾来说够用：
 * 深度只用来还原世界坐标，量化台阶远小于高度过渡带。
 */
export function createFogDepthPass(width, height) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: true,
    minFilter: THREE.NearestFilter,
    magFilter: THREE.NearestFilter,
    generateMipmaps: false,
  });

  /** 只写深度的材质：颜色被过掉，深度打包进 RGBA */
  const depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });

  return {
    target,
    /**
     * 跑一次深度预渲染。
     * @param {THREE.WebGLRenderer} renderer
     * @param {THREE.Scene} scene
     * @param {THREE.Camera} camera
     */
    render(renderer, scene, camera) {
      const prevOverride = scene.overrideMaterial;
      const prevBackground = scene.background;
      const prevAutoClear = renderer.autoClear;

      scene.overrideMaterial = depthMaterial;
      scene.background = null;      // 背景不该产生深度（远平面留作背景）
      renderer.autoClear = true;
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.setRenderTarget(null);

      scene.overrideMaterial = prevOverride;
      scene.background = prevBackground;
      renderer.autoClear = prevAutoClear;
    },
    get texture() { return target.texture; },
    setSize(w, h) { target.setSize(w, h); },
    dispose() {
      target.dispose();
      depthMaterial.dispose();
    },
  };
}

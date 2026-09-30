/**
 * fog-texture.js —— 雾用的**无缝二维**噪声贴图（被当成三维噪声的"层"来用）。
 *
 * 噪声**不能**在片元里现算：雾每帧要覆盖整个画面，现算代价太高。
 * 做法（参考 Codrops《The Sleepers》）：用一张无缝噪声贴图代替噪声计算。
 *
 * 为什么是二维而不是三维贴图：雾现在需要**三维**采样（否则竖直面上会被拉成条），
 * 而用"两层二维采样 + 按 z 小数插值"就能得到等价的三维噪声（见 `src/fog-pass.js`
 * 的 `noiseVolume()`）—— 不需要 3D 纹理，兼容性最好。这张图就是那两层用的源。
 *
 * 贴图由 `tools/gen-noise-texture.mjs` 程序生成（周期性梯度噪声，严格平铺），
 * 二进制 PNG 只有几万字节，跟着源码打包。
 *
 * 用 `?url` 导入而不是直接 import：Node 测试里导入本模块时不会碰到二进制资源。
 */
import * as THREE from 'three';
import noiseUrl from './assets/textures/noise-tileable.png?url';

let texture = null;

/**
 * 共享的噪声贴图（懒创建，全局只加载一次）。
 *
 * 没有 DOM 时返回 null：Node 测试会 import `src/main.js`（进而 import 到这里），
 * 而 `TextureLoader` 内部要 `document.createElementNS`，在 Node 里直接抛错。
 * 雾那边允许 `uFogNoise` 为空（采到黑 = 噪声恒定，场景仍然能建起来）。
 */
export function getFogNoiseTexture() {
  if (typeof document === 'undefined' || typeof document.createElementNS !== 'function') return null;
  if (texture) return texture;
  texture = new THREE.TextureLoader().load(noiseUrl);
  // 必须平铺：贴图本身就是无缝的，重复采样不会露接缝
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.NoColorSpace;   // 这是数据不是颜色，别做 sRGB 转换
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  return texture;
}

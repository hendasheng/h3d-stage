/**
 * fog-texture.js —— 雾用的噪声贴图。
 *
 * 噪声**不能**在片元里现算：雾要注入到场景里每个材质上，于是每帧、每个像素都要算一遍。
 * 参考做法（Codrops《The Sleepers》）是"用一张无缝噪声贴图代替噪声计算"。
 *
 * 贴图由 `tools/gen-noise-texture.mjs` 程序生成（周期性梯度噪声，严格平铺），
 * 二进制 PNG 只有几万字节，跟着源码打包。
 *
 * 用 `?url` 导入而不是直接 import：Node 测试里导入 `src/fog.js` 时不会碰到二进制资源
 * （贴图由测试自己造一个假 texture 传进去）。
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

/**
 * three-stub-hooks.mjs —— 模块加载钩子实现，让测试能在 Node 里导入真实的应用模块。
 *
 * 替身：
 *   · `three`            → 桩（Node 里没有 WebGL；WebGLRenderer / PMREMGenerator 换成假的）
 *   · `./models.js`      → 桩（里面用了 Vite 专有的 import.meta.glob，Node 无法求值）
 *   · `.css` / `.jsx`    → 空桩（由 Vite 处理，测试不需要）
 *   · `.json`            → 转成 JS 模块（版本号来自 package.json 具名导入）
 */
const REAL_THREE = new URL('../node_modules/three/build/three.module.js', import.meta.url).href;

const source = `
import * as T from ${JSON.stringify(REAL_THREE)};
export * from ${JSON.stringify(REAL_THREE)};
export class WebGLRenderer {
  constructor(canvas) {
    this.domElement = canvas?.canvas ?? canvas ?? globalThis.document.createElement('canvas');
    this.shadowMap = {};
    this.capabilities = { isWebGL2: true };
    this.__isStub = true;
  }
  setPixelRatio() {}
  setSize() {}
  setAnimationLoop() {}
  render() {}
  compile() {}
  dispose() {}
  getContext() { return null; }
}
export class PMREMGenerator {
  constructor() { this.texture = null; }
  fromScene() { return { texture: null, dispose() {} }; }
  fromEquirectangular() { return { texture: null, dispose() {} }; }
  compileEquirectangularShader() {}
  dispose() {}
}
`;
const STUB_URL = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(source);

// 模型列表桩：空列表即可让 main.js 走"没有模型"的失败分支，
// 测试只关心 main.js 导出的纯函数，不需要真的加载模型。
const MODELS_STUB_URL = 'data:text/javascript;charset=utf-8,' + encodeURIComponent(
  'export function listModels() { return []; }\nexport function modelUrl() { return ""; }\n'
);

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier === 'three') {
    return { url: STUB_URL, shortCircuit: true, format: 'module' };
  }
  if (specifier.endsWith('/models.js') || specifier.endsWith('./models.js')) {
    return { url: MODELS_STUB_URL, shortCircuit: true, format: 'module' };
  }
  // CSS / JSX 由 Vite 处理，Node 里不需要真内容（测试只关心 main.js 导出的纯函数）
  if (specifier.endsWith('.css')) {
    return { url: 'data:text/javascript,export default {}', shortCircuit: true, format: 'module' };
  }
  if (specifier.endsWith('.jsx')) {
    return { url: 'data:text/javascript,export const App = () => null;', shortCircuit: true, format: 'module' };
  }
  // JSON 在浏览器里由 Vite 处理，Node 里转成 JS 模块转发（package.json 的版本号靠它）
  if (specifier.endsWith('.json')) {
    const resolved = await next(specifier, context);
    const text = readFileSync(fileURLToPath(resolved.url), 'utf8');
    return {
      url: 'data:text/javascript;charset=utf-8,' + encodeURIComponent(`export default ${text}`),
      shortCircuit: true,
      format: 'module',
    };
  }
  return next(specifier, context);
}

/**
 * models.js —— 枚举模型并提供 URL 解析。
 *
 * 模型放在 `src/assets/models/`，用 Vite 的 import.meta.glob 在构建期扫成模块映射，
 * 所以**新增模型文件不用改任何清单**，界面里的下拉会自动多出一项。
 * 文件名同时用于显示与加载，不存在"显示名"和"实际路径"两套数据。
 *
 * 注意：**不要**把模型放回 `public/`。glob 会把 `public/` 下的文件当可导入资源再打包一遍，
 * 结果是 dist 里出现两份 glb（public 原样拷贝一份 + assets 里带哈希一份）。
 */
const modules = import.meta.glob('./assets/models/*.glb', { query: '?url', import: 'default', eager: true });

/** 文件名 → 可 fetch 的 URL */
const urlByName = new Map(
  Object.entries(modules).map(([path, url]) => [path.split('/').pop(), url])
);

/** @returns {string[]} 目录下所有模型文件名（按名称排序） */
export function listModels() {
  return [...urlByName.keys()].sort((a, b) => a.localeCompare(b));
}

/**
 * 解析模型文件名 → URL，并统一后缀。
 * @param {string} name 文件名（含或不含 .glb 均可）
 * @returns {string} 可 fetch 的 URL
 */
export function modelUrl(name) {
  if (!name) return '';
  const key = name.toLowerCase().endsWith('.glb') ? name : `${name}.glb`;
  const url = urlByName.get(key);
  if (!url) {
    throw new Error(`没有模型 ${key}（现有：${listModels().join(', ') || '空'}）`);
  }
  return url;
}

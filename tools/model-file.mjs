/**
 * model-file.mjs —— 定位项目里当前使用的模型文件。
 *
 * 模型文件名是手动维护的（用户会随导出来改名），所以测试与自检**不要写死文件名**，
 * 统一从这里取。约定：`src/assets/models/` 下若存在 `Geo1.glb` 就用它，
 * 否则按名称排序取第一个 `.glb`。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MODELS_DIR = new URL('../src/assets/models/', import.meta.url);
const DEFAULT_NAME = 'Geo1.glb';

/** @returns {string} 模型文件的绝对路径 */
export function resolveModelPath() {
  let names;
  try {
    names = readdirSync(MODELS_DIR);
  } catch (err) {
    throw new Error(`读不到 ${fileURLToPath(MODELS_DIR)}：${err.message}`);
  }
  const glbs = names.filter((n) => n.toLowerCase().endsWith('.glb')).sort();
  if (glbs.length === 0) {
    throw new Error(`src/assets/models/ 下没有 .glb 文件（现有：${names.join(', ') || '空'}）`);
  }
  const picked = glbs.includes(DEFAULT_NAME) ? DEFAULT_NAME : glbs[0];
  return fileURLToPath(new URL(picked, MODELS_DIR));
}

/** @returns {Buffer} 模型文件内容 */
export function readModelBuffer() {
  return readFileSync(resolveModelPath());
}

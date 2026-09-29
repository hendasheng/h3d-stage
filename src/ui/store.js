/**
 * ui/store.js —— UI 与 three.js 之间的共享状态。
 *
 * 用 @preact/signals 的 signal 承载"会驱动界面重绘"的值；
 * parts 数组本身很大，不放进 signal，改用一个 rev 计数器通知重绘。
 */
import { signal } from '@preact/signals';

export const store = {
  /* ---- 驱动界面 ---- */
  model: signal(''),              // 当前模型文件名（来自 src/assets/models/，见 src/models.js）
  models: [],                     // main.js 在启动时填入可选模型列表
  // 材质：默认统一的基础材质（中性色）；classColors 打开后按 class 分配不同颜色
  classColors: signal(false),
  baseColor: signal('#9aa3ad'),
  explode: signal(0),
  wireframe: signal(false),
  spin: signal(true),
  showGrid: signal(false),        // 世界网格（GridHelper）显隐
  filter: signal(''),
  partsCollapsed: signal(false),
  selected: signal(-1),
  rev: signal(0),                 // parts 内容/显隐变化时自增

  /* ---- 由加载流程填充 ---- */
  info: signal({ model: '', summary: '', path: '', selection: '', debug: '' }),
  parts: [],                      // [{ name, triangleCount, visible, material, object }]

  /* ---- 由 main.js 注入的回调 ---- */
  handlers: {},
};

/** 提示 parts 数组发生了变化（显隐、选中、重建） */
export function touch() {
  store.rev.value++;
}

/** 载入模型后回填信息；model 取实际加载的文件名，不写死 */
export function setInfo(patch) {
  store.info.value = { ...store.info.value, ...patch };
}

export function setDebug(text) {
  store.info.value = { ...store.info.value, debug: text };
}

/** 选中信息（显示在左侧标题区） */
export function setSelection(text) {
  store.info.value = { ...store.info.value, selection: text };
}

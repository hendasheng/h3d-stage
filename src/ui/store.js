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

  /* ---- 0.3 材质驱动：class 发光 ---- */
  glowDuration: signal(0.8),      // 信号长度（秒）：到期后开始衰减，再经同样时长回到 0；0 = 持续
  glowPeak: signal(2.5),          // 峰值发光强度
  glowColor: signal('#ffffff'),   // 发光颜色
  glowActive: signal([]),         // [{ id, level }] 当前发光的 class
  glowInput: signal('0'),         // 测试窗口里手动输入的 class 编号（整数字符串）
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

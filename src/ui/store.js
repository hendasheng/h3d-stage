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
  bloomEnabled: signal(true),
  bloomStrength: signal(0.1),
  bloomRadius: signal(0.2),
  bloomThreshold: signal(1.5),
  shadowSoftness: signal(3),
  gtaoEnabled: signal(true),
  gtaoIntensity: signal(0.6),
  gtaoRadius: signal(0.35),
  // 雾：公式与参考站一致（高度项 + 深度项相加加权），四个参数始终同时生效
  fogEnabled: signal(true),
  fogColor: signal('#ffffff'),
  fogBgMode: signal('dome'),
  fogBgColor: signal('#000000'),
  fogBgTop: signal('#000000'),
  fogBgBottom: signal('#ffffff'),
  fogHeight: signal(-2),          // fogPositionY
  fogSmoothness: signal(5),       // fogSmoothness
  fogDepth: signal(70),           // fogDepth
  fogDepthSmoothness: signal(25), // fogDepthSmoothness
  // 动态雾（0.5）：噪声把雾面高度推起来，并且自己流动
  fogDynamic: signal(true),
  fogNoiseStrength: signal(6),    // 雾面上下起伏多少（世界单位峰谷差，与高度过渡带同量级才看得出）
  fogNoiseScale: signal(0.06),    // 噪声疏密：1/scale ≈ 一个噪声周期跨多少世界单位
  fogFlowX: signal(0.012),        // 流动速度（噪声 UV/秒）
  fogFlowY: signal(0.007),
  fogWarp: signal(0.35),          // domain warp 强度：流动不规则的程度
  // 背景天穹的显隐由 fog.js 按「背景类型」控制，没有独立开关
  environment: signal('room'),
  environmentIntensity: signal(1),
  lightIntensity: signal(1),      // 原有三盏辅助灯的共同倍率
  environmentStatus: signal('默认室内'),
  environmentOptions: [
    { text: '默认室内', value: 'room' },
    { text: '关闭环境', value: 'none' },
  ],

  /* ---- 0.3 材质驱动：class 发光 ---- */
  glowDuration: signal(0.05),     // 信号长度（秒）默认值：满亮保持 0.05s，再经同样时长衰减；0 = 持续
  glowPeak: signal(50),           // 峰值发光强度默认值
  glowColor: signal('#ffa024'),   // 发光颜色
  glowActive: signal([]),         // [{ id, level }] 当前发光的 class
  glowInput: signal('0'),         // 测试窗口里手动输入的 class 编号（整数字符串）
  filter: signal(''),
  statsCollapsed: signal(false),
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

/**
 * test-explode-reset.mjs —— 专测炸开滑块"归零复位"这条路径。
 *
 * 背景：updateExplode() 本身没问题，bug 出在 main.js 的 tick() 调用条件上：
 *   旧写法 `if (state.explode > 0) updateExplode(...)`
 * 导致滑块拖到 0 时该函数一次都不被调用，复位分支永远执行不到，
 * 部件停在最后的位置 —— 表现为"拉到 0 还有距离"。
 *
 * 本测试直接跑 main.js 里的真实判断函数（用 DOM 桩绕过浏览器依赖），
 * 所以它测的是生产代码，不是复刻的副本。
 *
 * 运行：node test-explode-reset.mjs
 */
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [OK]  ' : '  [FAIL]'} ${label}${extra ? ' -> ' + extra : ''}`);
};

/* ---------------- 最小 DOM 桩 ---------------- */
const makeEl = () => {
  const el = {
    textContent: '',
    innerHTML: '',
    title: '',
    value: '0',
    checked: false,
    dataset: {},
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    children: [],
    append() {},
    appendChild() {},
    replaceChildren() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    scrollIntoView() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture() {},
    releasePointerCapture() {},
    focus() {},
    getContext: () => null,
    // OrbitControls 会用到
    getRootNode() {
      return { addEventListener() {}, removeEventListener() {}, dispatchEvent() {} };
    },
    ownerDocument: {
      addEventListener() {},
      removeEventListener() {},
      getElementById: byId,
      createElement: makeEl,
    },
  };
  return el;
};
const els = new Map();
const byId = (id) => {
  if (!els.has(id)) els.set(id, makeEl());
  return els.get(id);
};
globalThis.document = {
  getElementById: byId,
  createElement: makeEl,
  createDocumentFragment: makeEl,
  querySelectorAll: () => [],
  addEventListener() {},
  title: '',
  body: makeEl(),
};
globalThis.window = { addEventListener() {}, devicePixelRatio: 1, innerWidth: 1280, innerHeight: 800 };
globalThis.devicePixelRatio = 1;
globalThis.innerWidth = 1280;
globalThis.innerHeight = 800;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 0);
// 模型加载失败也没关系：本测试只关心 shouldUpdateExplode 这个纯函数
globalThis.fetch = async () => ({ ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) });

// 注意：'three' 由 ./three-stub-loader.mjs 换成桩模块（Node 里没有 WebGL），
// 必须用 `node --import ./three-stub-loader.mjs test-explode-reset.mjs` 运行，
// 或直接 `npm run test:explode`。
const { shouldUpdateExplode } = await import('../src/main.js');
console.log(`shouldUpdateExplode 导出成功: ${typeof shouldUpdateExplode === 'function'}`);
// import main.js 会连带触发它的 init()（DOM/WebGL 都是桩，模型 fetch 返回 404）。
// 这里给它一点时间跑完，让任何潜在异常自然暴露，而不是被吞掉。
await new Promise((r) => setTimeout(r, 300));

console.log('\n=== A. 调用条件本身（这就是之前漏测的地方）===');
ok('滑块在 0、上一帧也是 0 → 不调用', shouldUpdateExplode(0, 0) === false);
ok('滑块在 1 → 调用', shouldUpdateExplode(1, 0) === true);
ok('滑块刚归零（上一帧 > 0）→ 必须调用（复位这一帧）', shouldUpdateExplode(0, 0.5) === true,
  `得到 ${shouldUpdateExplode(0, 0.5)}`);
ok('滑块一直为 0 → 不调用（省掉无效重绘）', shouldUpdateExplode(0, 0) === false);
ok('首次加载（prev=0）且在 0 → 不调用', shouldUpdateExplode(0, 0) === false);
ok('两次都大于 0 → 持续调用', shouldUpdateExplode(1, 1) === true);

console.log('\n=== B. 模拟 tick() 循环：完整拖动后必须回到原位 ===');
// 用真实模型跑，确保测的是真实数据
const { buildPartsFromVertexAttribute, updateExplode } = await import('../src/parts.js');
const { readModelBuffer } = await import('./model-file.mjs');
const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
const buf = readModelBuffer();
const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
const gltf = await new GLTFLoader().parseAsync(ab, '');
let mesh = null;
gltf.scene.traverse((o) => { if (o.isMesh && !mesh) mesh = o; });
const { parts } = buildPartsFromVertexAttribute(mesh, '_class', 2000);
for (const p of parts) {
  p.object.userData.basePosition = p.object.position.clone();
}
console.log(`  真实模型部件数 = ${parts.length}`);

// 完整复刻 tick() 的行为
let lastExplode = -1;
let calls = 0;
const tick = (explode) => {
  if (shouldUpdateExplode(explode, lastExplode)) {
    updateExplode(parts, explode, 10);
    calls++;
  }
  lastExplode = explode;
};

const base0 = parts[0].object.userData.basePosition.clone();
const dragSeq = [0, 0.4, 1, 2, 0.7, 1.5, 0.2, 2, 1, 0];
console.log(`  拖动序列: ${dragSeq.join(' → ')}`);
for (const f of dragSeq) for (let i = 0; i < 5; i++) tick(f); // 每档停 5 帧
let maxResidual = 0, worst = -1;
parts.forEach((p, i) => {
  const d = p.object.position.distanceTo(p.object.userData.basePosition);
  if (d > maxResidual) { maxResidual = d; worst = i; }
});
console.log(`  updateExplode 调用次数 = ${calls}`);
console.log(`  回到 0 后最大残留 = ${maxResidual.toExponential(3)}（部件 #${worst}）`);
ok('滑块归零后所有部件精确复位', maxResidual < 1e-9, `最大残留 ${maxResidual.toExponential(3)}`);
ok('归零这一帧确实执行了复位调用', calls > 0, `calls=${calls}`);

console.log('\n=== C. 反证：旧版条件会失败（同一场景，改用旧判断）===');
const parts2 = buildPartsFromVertexAttribute(mesh, '_class', 2000).parts;
for (const p of parts2) p.object.userData.basePosition = p.object.position.clone();
let lastOld = -1;
const tickOld = (explode) => {
  // 旧写法
  if (explode > 0 && parts2.length) updateExplode(parts2, explode, 10);
  lastOld = explode;
};
for (const f of dragSeq) for (let i = 0; i < 5; i++) tickOld(f);
let oldResidual = 0;
parts2.forEach((p) => { oldResidual = Math.max(oldResidual, p.object.position.distanceTo(p.object.userData.basePosition)); });
console.log(`  旧条件回到 0 后的最大残留 = ${oldResidual.toExponential(3)}`);
ok('旧条件确实会留下残留（证明这个测试能抓住该 bug）', oldResidual > 0.1, `${oldResidual.toExponential(3)} > 0.1`);

console.log(`\n${failures ? `存在 ${failures} 个失败项` : '炸开复位测试全部通过'}\n`);
process.exitCode = failures ? 1 : 0;

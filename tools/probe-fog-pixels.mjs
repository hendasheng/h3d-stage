/**
 * probe-fog-pixels.mjs —— 在真实 WebGL 里渲染并回读像素，验证雾确实改变了画面。
 *
 * 为什么需要像素级验证：shader 注入"命中"、uniform"挂上"都不等于画面改变
 * （公式算错、方向反了、uniform 没生效都可能看不出来）。
 *
 * 探针分两段，各自用**不会串味**的最小场景：
 *
 *   第一段 雾（材质注入）—— 正交相机 + 一块正对相机、占满画面的板。
 *     画面里从头到尾只有这一块板（背景也让路：不挂天穹、背景设成与板不同色），
 *     所以"像素变了"只可能是雾造成的。板放远一点，深度项才有量程。
 *
 *   第二段 天穹（背景）—— 一块大地面 + 天穹，斜视。
 *     天穹是背景不是雾，所以单独一段验证：取样点分别落在天穹与地面上，互不遮挡。
 *
 * 公式的两条推论（写断言前先想清楚，别把公式本身当 bug）：
 *   mixer = clamp(verticalMixer*.5 + verticalMixer*depthMixer*.95, 0, 1)
 *   · verticalMixer=1 且 depthMixer=0 时，画面已有 0.5 的雾量 —— "高度项吃满"不等于"过曝"
 *   · verticalMixer=0 时两项**一起**归零，所以此时怎么调 depth 都不会有雾
 *
 * 做法：DevTools Protocol 打开 dev server 上的页面，页面内 import 真实模块建场景、
 * 渲染到离屏 canvas、readPixels，再把统计值返回。
 *
 * 材质一律用 MeshBasicMaterial（不受光照影响，画面只反映雾）。踩过：
 * 注入点原来只匹配 PBR 材质的 `totalDiffuse + totalSpecular + …`，探测场景用 Basic 材质，
 * 于是"注入命中、uniform 挂上、画面一动不动"。
 *
 * 运行：npm run probe:fog   （需要 dev server 在 5178）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9227;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = mkdtempSync(join(tmpdir(), 'dsh-px-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--no-sandbox', '--no-first-run', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=600,400', 'about:blank',
], { stdio: 'ignore' });

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [OK]  ' : '  [FAIL]'} ${label}${extra ? ' -> ' + extra : ''}`);
};

let ws = null;
const cleanup = () => {
  try { ws?.close(); } catch { /* ignore */ }
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' });
    else chrome.kill('SIGTERM');
    chrome.unref();
  } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
};

try {
  let target = null;
  for (let i = 0; i < 40 && !target; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 等 */ }
  }
  if (!target) throw new Error('CDP 未就绪');

  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const evaluate = (expr) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, (m) => {
      const r = m.result;
      res(r?.exceptionDetails ? `EXC: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}` : r?.result?.value);
    });
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });

  // 走 dev server 的页面，才能用 Vite 的模块解析 import 'three'
  await evaluate(`location.href = 'http://127.0.0.1:5178/'`).catch(() => {});
  await sleep(1500);

  console.log('\n=== 离屏渲染 + 像素回读 ===');
  const result = await evaluate(String.raw`
    (async () => {
      const THREE = await import('/node_modules/.vite/deps/three.js');
      const { createFog, FOG_DEFAULTS } = await import('/src/fog.js');
      const { createSkyDome } = await import('/src/sky-dome.js');

      const W = 64, H = 64;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, preserveDrawingBuffer: true });
      renderer.setPixelRatio(1);
      renderer.setSize(W, H);
      const gl = renderer.getContext();
      const buf = new Uint8Array(W * H * 4);

      const mean = (x0, y0, x1, y1) => {
        let sum = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += buf[(y * W + x) * 4]; n++; }
        return +(sum / n).toFixed(1);
      };
      /** 中央区域的均值：板占满画面时就是"这块板的颜色" */
      const center = () => mean(8, 8, W - 8, H - 8);

      const OUT = [];
      const DIAG = [];

      /* ================= 第一段：雾 ================= */
      // 透视相机在原点朝 -Z，一块正对相机、**铺满视野**的板放在 z = -d：
      // 板上每点到相机的距离都恰好是 d（正对相机，不用管斜边）。
      // 板必须覆盖 50° 视野在距离 d 处的高度 2*d*tan(25°) ≈ 0.93d，所以按距离缩放 1x1 的平面。
      // （踩过：板做小了，中央取到的是背景黑，"雾没变化"全是假象。）
      const sceneA = new THREE.Scene();
      const cameraA = new THREE.PerspectiveCamera(50, 1, 0.1, 2000);
      cameraA.position.set(0, 0, 0);
      cameraA.lookAt(0, 0, -1);
      const plateMat = new THREE.MeshBasicMaterial({ color: 0x505050 });
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), plateMat);
      sceneA.add(plate);
      const fogA = createFog(sceneA, null);

      const setPlate = (d, s) => {
        plate.position.z = -d;
        plate.scale.set(d * 1.2, d * 1.2, 1);   // 铺满视野
        // 背景用纯黑、与板不同色：板没盖到的地方一眼能看出来，不会有"板其实是背景"的误会
        fogA.update({ color: '#ffffff', bgMode: 'flat', bgColor: '#000000',
          height: 40, smoothness: 2, depth: 100, depthSmoothness: 5, ...s }, [{ material: plateMat }]);
      };
      const shotA = (label) => {
        renderer.render(sceneA, cameraA);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        // 顺手把注入后的 uniform 现场值带出来，异常时能一眼看出是"值不对"还是"值对了但画面不对"
        const sh = { uniforms: {}, vertexShader: 'void main() {\n}',
          fragmentShader: '#include <common>\nvec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;' };
        plateMat.onBeforeCompile(sh);
        OUT.push({
          seg: 'A', label, val: center(), corner: mean(2, 2, 5, 5),
          u: 'py=' + sh.uniforms.fogPositionY.value + ' dep=' + sh.uniforms.fogDepth.value
            + ' on=' + sh.uniforms.fogEnabled.value,
        });
      };

      // 板在 z=-100 且 depth=100、过渡带 5 → 90..110 正好卡住 → depthMixer≈0.5
      setPlate(100, { enabled: false });        shotA('P1 关雾（板距离 100）');
      setPlate(100, { enabled: true });         shotA('P2 开雾（板距离 100）');
      setPlate(100, { enabled: false });        shotA('P3 再关雾');
      // 高度项：同一块板，把雾面放在它**之下**（两项都归零 → 完全没有雾）与**之上**
      // （只剩深度项那一半）。两者必须差得出来，否则说明 height 没生效。
      // 前两版写法都不行：把雾面抬到"满屏板之上"要先知道板的世界 Y 跨度（由相机视野决定，
      // 取样点落在哪一侧说不清）；改用两块板又会互相遮挡、还容易出画。
      setPlate(100, { enabled: true, height: -300, depth: 100 });
      shotA('P4 雾面在板之下（无雾）');
      setPlate(100, { enabled: true, height: 300, depth: 100 });
      shotA('P4b 雾面在板之上（只剩深度项）');
      // 深度项：depth 拉到 2000 → 只有高度项那 *.5；压到 20 → 距离项吃满
      setPlate(100, { enabled: true, height: 40, depth: 2000 });  shotA('P5 深度 2000（无距离雾）');
      setPlate(100, { enabled: true, height: 40, depth: 20 });    shotA('P6 深度 20（距离雾吃满）');
      // 雾色改红：确认注入的确实是 uFogColor 这个 uniform
      setPlate(100, { enabled: true, height: 40, depth: 20, color: '#ff0000' }); shotA('P7 雾色改红');
      // 板挪近：同一套参数下，近处不该比远处亮（深度项的方向）
      setPlate(20, { enabled: true, height: 40, depth: 100 });    shotA('P8 板距离 20');
      setPlate(100, { enabled: true, height: 40, depth: 100 });   shotA('P9 板距离 100');

      /* ================= 第二段：天穹 ================= */
      // 没有地面了，所以画面里除了天穹什么都没有 —— 反而更好验证：
      // 每个像素都直接反映天穹的渐变。相机必须待在天穹球内（半径见 src/sky-dome.js）。
      const sceneB = new THREE.Scene();
      const cameraB = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);
      cameraB.position.set(0, 5, 55);
      cameraB.lookAt(0, 0, 0);
      const dome = createSkyDome();
      sceneB.add(dome.dome);
      const fogB = createFog(sceneB, dome);

      // 取样：画面上方 1/6（天穹上部）与下方 1/6（天穹下部）
      const shotB = (label) => {
        dome.followCamera(cameraB);
        renderer.render(sceneB, cameraB);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        const rgbOf = (y0, y1) => [0, 1, 2].map((c) => {
          let s = 0, n = 0;
          for (let y = y0; y < y1; y++) for (let x = 6; x < W - 6; x++) { s += buf[(y * W + x) * 4 + c]; n++; }
          return (s / n).toFixed(0);
        }).join('/');
        OUT.push({
          seg: 'B', label,
          skyTop: mean(6, H - 14, W - 6, H - 4),   // 天穹上部（该是 bgTop）
          skyBottom: mean(6, 4, W - 6, 14),        // 天穹下部（该是雾色）
          rgb: rgbOf(H - 14, H - 4),
          all: mean(4, 4, W - 4, H - 4),           // 全屏均值：雾面越高，天穹越白 → 越亮
        });
      };
      const setDome = (s) => fogB.update({ color: '#ffffff', bgMode: 'dome', bgTop: '#000000',
        height: 5, smoothness: 3, depth: 70, depthSmoothness: 25, ...s }, []);
      setDome({});                 shotB('D1 天穹（雾面 5）');
      setDome({ height: 300 });    shotB('D2 天穹（雾面 300，分界上移）');
      setDome({ height: -300 });   shotB('D3 天穹（雾面 -300，分界下移）');
      setDome({ bgMode: 'flat', bgColor: '#000000' }); shotB('D4 背景改纯黑');
      setDome({ bgMode: 'dome', bgTop: '#ff0000' });   shotB('D5 天穹顶部改红');
      setDome({ height: -2000 });  shotB('D6 天穹（雾面 -2000，全黑）');

      DIAG.push('FOG_DEFAULTS=' + JSON.stringify(FOG_DEFAULTS));

      renderer.dispose();
      return JSON.stringify({ out: OUT, diag: DIAG });
    })()
  `);

  if (typeof result !== 'string' || result.startsWith('EXC')) {
    console.log('  页面执行失败:', result);
    failures++;
  } else {
    const { out, diag } = JSON.parse(result);
    for (const d of diag ?? []) console.log('  [diag] ' + d);
    for (const r of out) {
      console.log(r.seg === 'A'
        ? `  ${r.label.padEnd(26)} 板色=${String(r.val).padStart(6)} 角=${String(r.corner).padStart(3)}  ${r.u}`
        : `  ${r.label.padEnd(26)} 天上=${String(r.skyTop).padStart(6)}  天下=${String(r.skyBottom).padStart(6)} 上部RGB=${r.rgb}`);
    }
    const g = (k) => out.find((r) => r.label.startsWith(k));
    const [P1, P2, P3, P4, P4b, P5, P6, P7, P8, P9] = ['P1', 'P2', 'P3', 'P4 ', 'P4b', 'P5', 'P6', 'P7', 'P8', 'P9'].map(g);
    const [D1, D2, D3, D4, D5, D6] = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6'].map(g);

    console.log('\n--- 第一段：雾确实改变了材质画面 ---');
    ok('基准：关雾时板是纯灰（无干扰）', P1.val > 75 && P1.val < 85, `板色 ${P1.val}`);
    ok('可复现：关雾两次结果一致', Math.abs(P1.val - P3.val) < 0.5, `${P1.val} vs ${P3.val}`);
    ok('开雾后板明显变亮', P2.val > P1.val + 15, `${P1.val} → ${P2.val}`);
    ok('雾色是 uniform（改红后红通道升）', P7.val > 90, `板色(红通道) ${P7.val}`);
    // 板的世界 Y 跨度随距离变化（距离 d 时约 ±0.47d），所以"抬到板之上"要按最远那块板算
    ok('高度项：雾面在板之下 → 完全没有雾', Math.abs(P4.val - P1.val) < 12,
      `板色 ${P4.val}（关雾 ${P1.val}）`);
    ok('高度项：雾面在板之上 → 只剩深度项那一半（和无雾分得开）', P4b.val > P4.val + 40,
      `雾面在下 ${P4.val} → 雾面在上 ${P4b.val}`);
    ok('深度项：depth 拉到 2000 → 距离雾归零（只剩高度项那一半）', P5.val < P2.val - 15,
      `depth 20: ${P6.val} → depth 2000: ${P5.val}`);
    ok('depth 越小，板越白（距离雾吃满）', P6.val > P5.val + 15, `${P5.val} → ${P6.val}`);
    ok('同一参数下近处的板不比远处亮（深度项方向没反）', P8.val <= P9.val + 2,
      `距离 20: ${P8.val} → 距离 100: ${P9.val}`);

    console.log('\n--- 第二段：天穹是背景（顶深底白，跟着雾面走）---');
    ok('天穹上部是 bgTop（深色）', D1.skyTop < 20, `天上 ${D1.skyTop}（RGB ${D1.rgb}）`);
    ok('天穹下部是雾色（白）', D1.skyBottom > 200, `天下 ${D1.skyBottom}`);
    // 雾面越高 → 天穹越白 → 全屏越亮。这条判据不依赖取样点落在分界的哪一侧，最不容易写错。
    ok('雾面越高，天穹越白（全屏均值单调上升）',
      D1.all < D2.all && D6.all <= D3.all && D3.all < D1.all,
      `-2000: ${D6.all} / -300: ${D3.all} < 5: ${D1.all} < 300: ${D2.all}`);
    ok('背景切纯黑后天空是黑的（天穹被隐藏）', D4.all < 10, `全屏 ${D4.all}`);
    ok('bgTop 控制天穹顶部颜色', D5.skyTop > D1.skyTop + 100 && D5.rgb.startsWith('255/'),
      `天上 ${D1.skyTop} → ${D5.skyTop}（RGB ${D5.rgb}）`);
    ok('没有地面时，天穹自己铺满整个画面', D1.all > 5, `全屏 ${D1.all}`);
  }
} catch (err) {
  failures++;
  console.log('  [FAIL] 探测过程出错:', err.message);
} finally {
  cleanup();
}

console.log(`\n${failures ? `存在 ${failures} 个失败项` : '雾像素验证通过：高度项与深度项都确实改变了画面'}\n`);
process.exitCode = failures ? 1 : 0;

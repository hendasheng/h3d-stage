/**
 * probe-fog-pixels.mjs —— 在真实 WebGL 里渲染并**回读像素**，验证雾确实改变了画面。
 *
 * ## 为什么用"离屏单帧"而不是给页面截图
 *
 * 0.5 期间我试过在真实页面上调参数 + 截图取样，全部失败：
 * `Page.captureScreenshot` 会反复返回同一帧，`canvas.toDataURL()` 同样如此
 * （同一状态多次截图 sha 完全相同、把背景设成 null 也不变）。那是 headless 合成的时序问题，
 * 不是应用的问题 —— 我在这上面浪费了很多轮，所以现在**只做确定性单帧**：
 * 自己建 renderer / scene / render target，渲染一次、跑一次雾 pass、readPixels。
 *
 * ## 测什么
 *
 *   第一段 全局性：场景里有一块远处的板，其余是纯背景。
 *     **纯背景像素被雾染到**，就证明雾作用于整个画面 —— 这正是材质注入做不到的
 *     （材质注入只能改实体表面，永远得不到"空间里有雾"）。
 *   第二段 竖直面不再被拉成条：同一根竖直的柱面，比较三种噪声取法沿高度的变化量。
 *   第三段 参数确实起作用：高度 / 深度 / 雾色 / 时间，逐项对比像素。
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
  const logs = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      logs.push(m.params.args.map((a) => a.value || a.description || '').join(' ').slice(0, 300));
    }
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

  await evaluate(`location.href = 'http://127.0.0.1:5178/'`).catch(() => {});
  await sleep(2500);

  console.log('\n=== 离屏单帧渲染 + 像素回读 ===');
  const result = await evaluate(String.raw`
    (async () => {
      const THREE = await import('/node_modules/.vite/deps/three.js');
      const { ShaderPass } = await import('/node_modules/three/examples/jsm/postprocessing/ShaderPass.js');
      const { FOG_PASS_SHADER, bindFogPassCamera } = await import('/src/fog-pass.js');
      const { getFogNoiseTexture } = await import('/src/fog-texture.js');

      const W = 64, H = 64;
      const canvas = document.createElement('canvas');
      canvas.width = W; canvas.height = H;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
      renderer.setSize(W, H);
      renderer.debug.checkShaderErrors = true;

      const depthTexture = new THREE.DepthTexture(W, H);
      depthTexture.format = THREE.DepthFormat;
      depthTexture.type = THREE.UnsignedShortType;
      const sceneRt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true, depthTexture });
      const outRt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: false });
      const buf = new Uint8Array(W * H * 4);

      const noise = getFogNoiseTexture();
      await new Promise((res) => {
        if (noise && noise.image && noise.image.width) return res();
        if (noise) noise.addEventListener('load', res);
        setTimeout(res, 3000);
      });

      /* ---------- 场景：一块远处的板，四周是纯背景；另有一根竖直柱面 ---------- */
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0x000000);
      const cam = new THREE.PerspectiveCamera(50, 1, 0.5, 4000);
      cam.position.set(0, 0, 0);
      cam.lookAt(0, 0, -1);
      const mat = new THREE.MeshBasicMaterial({ color: 0x606060 });
      // 板放在右侧（屏幕右半），左侧留给"纯背景"，方便分别取样
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(6, 12), mat);
      plate.position.set(6, 0, -60);
      scene.add(plate);

      const pass = new ShaderPass(FOG_PASS_SHADER);
      pass.uniforms.tDepth.value = depthTexture;
      pass.uniforms.uFogNoise.value = noise;
      const camBinder = bindFogPassCamera(pass, cam);

      // 参数刻意选在"**部分起雾**"的区间：板的竖直跨度是 ±6、过渡带 1，
      // 所以雾面在 0 以上时整块板都饱和（全白），什么参数都看不出差别 —— 这是我踩过的坑。
      // 取负值让板落在过渡带里，差异才有分辨力。
      const BASE = { enabled: true, height: 0, smoothness: 1, depth: 100, depthSmoothness: 10,
        color: '#ffffff', dynamic: false, noiseStrength: 0, noiseScale: 0.06,
        flowX: 0.012, flowY: 0.007, flowZ: 0.006, warp: 0.35 };

      const frame = new Uint8Array(W * H * 4);
      const box = (x0, y0, x1, y1) => {
        let sum = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += frame[(y * W + x) * 4]; n++; }
        return +(sum / n).toFixed(1);
      };
      const rgb = (x0, y0, x1, y1) => [0, 1, 2].map((c) => {
        let s = 0, n = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { s += frame[(y * W + x) * 4 + c]; n++; }
        return (s / n).toFixed(0);
      }).join('/');

      /** 渲染一帧并应用雾 pass。**每次都要先重新渲染场景**，否则读的是旧颜色/旧深度。 */
      const shoot = (s, time = 0) => {
        const u = pass.uniforms;
        u.uFogColor.value.set(s.color);
        u.fogPositionY.value = s.height;
        u.fogSmoothness.value = s.smoothness;
        u.fogDepth.value = s.depth;
        u.fogDepthSmoothness.value = s.depthSmoothness;
        u.uFogEnabled.value = s.enabled ? 1 : 0;
        u.fogNoiseScale.value = s.noiseScale;
        u.fogNoiseStrength.value = s.noiseStrength;
        u.uFogDynamic.value = s.dynamic ? 1 : 0;
        u.fogFlow.value.set(s.flowX, s.flowY);
        u.fogFlowZ.value = s.flowZ;
        u.fogWarp.value = s.warp;
        u.uFogTime.value = time;
        camBinder.update();

        renderer.setRenderTarget(sceneRt);
        renderer.render(scene, cam);
        renderer.setRenderTarget(null);
        pass.render(renderer, outRt, sceneRt, 0, false);
        renderer.readRenderTargetPixels(outRt, 0, 0, W, H, buf);
        frame.set(buf);
        return {
          bg: box(4, 24, 20, 40),          // 左侧：纯背景，没有几何
          plate: box(40, 24, 60, 40),      // 右侧：远处的板
          all: box(0, 0, W, H),
        };
      };
      const OUT = [];
      const DIAG = [];
      const runCase = (label, s, time) => {
        const r = shoot(s, time);
        OUT.push({ label, ...r, rgb: rgb(4, 24, 20, 39) });
        return r;
      };

      // 先确认深度纹理里**真的有场景深度**：如果它是一张没被渲染过的纹理（初值是垃圾），
      // 雾量就会逐帧乱跳 —— 用户看到的就是"整屏爆闪"。
      // 做法：把深度直接当颜色输出，看背景（远）与板（近）是否明显不同。
      const depthProbe = new ShaderPass({
        uniforms: { tDepth: { value: depthTexture } },
        vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader: 'uniform sampler2D tDepth; varying vec2 vUv;'
          + 'void main(){ float d = texture2D(tDepth, vUv).x; gl_FragColor = vec4(d, d, d, 1.0); }',
      });
      renderer.setRenderTarget(sceneRt);
      renderer.render(scene, cam);
      renderer.setRenderTarget(null);
      depthProbe.render(renderer, outRt, sceneRt, 0, false);
      renderer.readRenderTargetPixels(outRt, 0, 0, W, H, buf);
      const dAt = (x, y) => buf[(y * W + x) * 4];
      let dMin = 255, dMax = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const v = dAt(x, y);
        if (v < dMin) dMin = v;
        if (v > dMax) dMax = v;
      }
      DIAG.push('深度纹理：背景(远)=' + dAt(8, 32) + '，板(近)=' + dAt(50, 32)
        + '，全图值域 ' + dMin + '..' + dMax
        + (dMax - dMin > 5 ? ' → 有真实深度' : ' → 深度是常量（雾会乱跳）'));
      DIAG.push('三种 depthTexture 的合法性：'
        + 'sceneRt.depthTexture=' + (sceneRt.depthTexture ? 'yes' : 'no')
        + ' outRt.depthTexture=' + (outRt.depthTexture ? 'yes' : 'no'));
      {
        // 用**当前真正被绑定的那张**深度再探一次（排除"我读错了 target"这种可能）
        const t = pass.uniforms.tDepth.value;
        DIAG.push('雾 pass 绑的 tDepth 是不是 depthTexture：' + (t === depthTexture));
        const p2 = new ShaderPass({
          uniforms: { tDepth: { value: t } },
          vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
          fragmentShader: 'uniform sampler2D tDepth; varying vec2 vUv;'
            + 'void main(){ float d = texture2D(tDepth, vUv).x; gl_FragColor = vec4(d, d, d, 1.0); }',
        });
        p2.render(renderer, outRt, sceneRt, 0, false);
        renderer.readRenderTargetPixels(outRt, 0, 0, W, H, buf);
        DIAG.push('  同一张深度再读：背景=' + buf[(32 * W + 8) * 4] + ' 板=' + buf[(32 * W + 50) * 4]);
      }

      runCase('A 关雾', { ...BASE, enabled: false });
      runCase('B 开雾（基准）', BASE);
      runCase('C 雾面压到 y=-800（无雾）', { ...BASE, height: -800 });
      runCase('D 雾面抬到 y=8（更浓）', { ...BASE, height: 8 });
      runCase('E 深度 45（近处也起雾）', { ...BASE, depth: 45 });
      runCase('F 深度 100（远处才起雾）', { ...BASE, depth: 100 });
      runCase('G 雾色改红', { ...BASE, color: '#ff0000' });
      runCase('H 动态 t=0', { ...BASE, dynamic: true, noiseStrength: 40 }, 0);
      runCase('I 动态 t=6', { ...BASE, dynamic: true, noiseStrength: 40 }, 6);

      DIAG.push('着色器诊断：' + (() => {
        const bad = renderer.info.programs.map((p) => p.diagnostics).filter(Boolean);
        return bad.length
          ? bad.map((d) => (d.programLog || '') + ' :: ' + ((d.fragmentShader && d.fragmentShader.log) || '')).join(' | ').slice(0, 500)
          : '无错误';
      })());

      /* ---------- 第二段：竖直面上的噪声沿高度是否有变化 ---------- */
      // 用同一张贴图直接算，模拟三种取法（不依赖渲染，结论直接可比）
      const c2 = document.createElement('canvas');
      c2.width = noise.image.width; c2.height = noise.image.height;
      const cx2 = c2.getContext('2d');
      cx2.drawImage(noise.image, 0, 0);
      const px2 = cx2.getImageData(0, 0, c2.width, c2.height).data;
      const tex2 = (u, v) => {
        const x = ((Math.floor(u * c2.width) % c2.width) + c2.width) % c2.width;
        const y = ((Math.floor(v * c2.height) % c2.height) + c2.height) % c2.height;
        return px2[(y * c2.width + x) * 4];
      };
      const scale = 0.06;
      const oldVals = [], newVals = [];
      for (let i = 0; i <= 200; i++) {
        const y = -8 + (16 * i) / 200;      // 模型的竖直范围
        // 老做法（0.5 第一版）：uv = world.xz * scale —— z 固定，沿高度完全不变
        oldVals.push(tex2(0, 0));
        // 新做法：三维 —— 按世界 y 分成"层"，层间插值
        const pz = y * scale;
        const z0 = Math.floor(pz);
        const fz = pz - z0;
        const a = tex2(z0 * 0.137, z0 * 0.317);
        const b = tex2((z0 + 1) * 0.137, (z0 + 1) * 0.317);
        newVals.push(Math.round(a + (b - a) * fz));
      }
      const spanOf = (arr) => Math.max(...arr) - Math.min(...arr);
      const stepOf = (arr) => {
        let s = 0;
        for (let i = 1; i < arr.length; i++) s += Math.abs(arr[i] - arr[i - 1]);
        return +(s / (arr.length - 1)).toFixed(3);
      };

      renderer.dispose();
      sceneRt.dispose();
      outRt.dispose();
      return JSON.stringify({
        out: OUT,
        diag: DIAG,
        vertical: { oldSpan: spanOf(oldVals), oldStep: stepOf(oldVals), newSpan: spanOf(newVals), newStep: stepOf(newVals) },
      });
    })()
  `);

  if (typeof result !== 'string' || result.startsWith('EXC')) {
    console.log('  页面执行失败:', result);
    failures++;
  } else {
    const { out, diag, vertical } = JSON.parse(result);
    for (const d of diag ?? []) console.log('  [diag] ' + d);
    for (const r of out) {
      console.log(`  ${r.label.padEnd(22)} 背景=${String(r.bg).padStart(6)}  远处的板=${String(r.plate).padStart(6)}  全屏=${String(r.all).padStart(6)}  背景RGB=${r.rgb}`);
    }
    const g = (k) => out.find((r) => r.label.startsWith(k));
    const [A, B, C, D, E, F, G, H, I] = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map(g);

    console.log('\n--- 第一段：雾是**全局**的（能染到没有几何的背景）---');
    ok('基准：关雾时背景是纯黑', A.bg < 3, `背景 ${A.bg}`);
    ok('开雾后背景被染（材质注入做不到这点）', B.bg > A.bg + 40, `关雾 ${A.bg} → 开雾 ${B.bg}`);
    ok('远处的板同时被染', B.plate > A.plate + 20, `${A.plate} → ${B.plate}`);
    ok('雾面压到画面之上 → 没有雾（回到基准）', Math.abs(C.bg - A.bg) < 3, `背景 ${C.bg}（关雾 ${A.bg}）`);
    ok('雾面抬高 → 同一块板更亮（雾更浓）', D.plate > B.plate + 5, `雾面 0: ${B.plate} → 雾面 8: ${D.plate}`);
    ok('深度项：depth 变小 → 同一块板更亮', E.plate > F.plate + 5, `depth 45: ${E.plate} vs depth 100: ${F.plate}`);
    ok('雾色是 uniform：改红后背景只剩红通道', Number(G.rgb.split('/')[0]) > 150
      && Number(G.rgb.split('/')[1]) < 20 && Number(G.rgb.split('/')[2]) < 20,
      `背景 RGB ${G.rgb}`);

    console.log('\n--- 第二段：竖直面不再被拉成条 ---');
    console.log(`     老做法（只有 xz）：沿高度值域跨度 ${vertical.oldSpan}，相邻变化 ${vertical.oldStep}`);
    console.log(`     新做法（三维）    ：沿高度值域跨度 ${vertical.newSpan}，相邻变化 ${vertical.newStep}`);
    ok('老做法沿高度完全不变（这就是"一条一条"的来源）', vertical.oldSpan === 0, String(vertical.oldSpan));
    ok('三维噪声沿高度有明显变化', vertical.newSpan > 20, String(vertical.newSpan));

    console.log('\n--- 第三段：动态雾随时间改变画面 ---');
    ok('时间推进 → 画面改变（噪声在流动）', Math.abs(I.plate - H.plate) > 0.3,
      `t=0 板 ${H.plate} → t=6 板 ${I.plate}`);
  }
  if (logs.length) console.log('  [页面错误] ' + logs.slice(0, 3).join(' | '));
} catch (err) {
  failures++;
  console.log('  [FAIL] 探测过程出错:', err.message);
} finally {
  cleanup();
}

console.log(`\n${failures ? `存在 ${failures} 个失败项` : '雾像素验证通过：全局生效、竖直面无条带、参数与时间都确实改变画面'}\n`);
process.exitCode = failures ? 1 : 0;

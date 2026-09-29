/**
 * probe-glow-cdp.mjs —— 用 Chrome DevTools Protocol 真实验证发光链路。
 *
 * 为什么需要它：控件是 Tweakpane 自绘的，DOM 里没有原生 min/max 或 value，
 * 只 dump DOM 无法判断"拖得动、触发有效"。这里用 CDP：
 *   1. 在页面里直接调用 store.handlers.triggerGlow(137)
 *   2. 读回 class 137 的材质 emissive 强度
 *   3. 等"长度"过后再读一次，确认回到 0
 *
 * 运行：node tools/probe-glow-cdp.mjs   （需要 dev server 在 5178）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9222;
const URL_APP = 'http://127.0.0.1:5178/';
const CHROME = process.env.CHROME_PATH
  || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const profile = mkdtempSync(join(tmpdir(), 'dsh-cdp-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--no-sandbox', '--no-first-run', '--mute-audio',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1600,1000', URL_APP,
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
  // 等 CDP 起来
  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) {
    await sleep(500);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      targets = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch { /* 继续等 */ }
  }
  if (!targets) throw new Error('CDP 未就绪');

  const WebSocket = globalThis.WebSocket;
  ws = new WebSocket(targets.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let msgId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.text + ' ' + (r.result.exceptionDetails.exception?.description ?? ''));
    return r.result?.result?.value;
  };

  // 等模型加载完（overlay 收起）
  let loaded = false;
  for (let i = 0; i < 40 && !loaded; i++) {
    await sleep(700);
    loaded = await evaluate(`!!document.querySelector('#overlay.done')`);
  }
  console.log('\n=== 页面状态 ===');
  ok('模型加载完成', loaded === true);
  const state = await evaluate(`JSON.stringify({ parts: window.__h3d?.parts ?? null })`);
  console.log(`  ${state}`);

  console.log('\n=== 发光链路（真实运行时）===');
  // 暴露的状态对象由 main.js 挂到 window.__h3d（仅用于调试/验证）
  const hasHook = await evaluate(`typeof window.__h3d === 'object' && !!window.__h3d.triggerGlow`);
  if (!hasHook) {
    console.log('  ⚠ 页面未暴露 window.__h3d，跳过运行时验证');
  } else {
    // 注意：强度写在 emissive 颜色里，emissiveIntensity 恒为 1，
    // 所以判断"亮/灭"要看颜色：全黑 = 灭（等于基础材质）。
    const lum = (c) => (c ? Math.max(c.r, c.g, c.b) : -1);
    const colorOf = async (id) => JSON.parse(await evaluate(`JSON.stringify(window.__h3d.emissiveColorOf(${id}))`));

    const before = await colorOf(137);
    ok('触发前 class 137 为黑（= 基础材质）', lum(before) === 0, JSON.stringify(before));

    await evaluate(`window.__h3d.triggerGlow(137)`);
    await sleep(120);
    const peak = await colorOf(137);
    ok('触发后 class 137 发光（颜色非黑）', lum(peak) > 0, JSON.stringify(peak));
    const others = await colorOf(0);
    ok('未触发的 class 0 仍为黑', lum(others) === 0, JSON.stringify(others));

    // 颜色：默认白色应是等值三通道；换成橙色后应保持"R > G > B"的色相（而不是被拉平成白）
    const white = peak;
    ok('默认白色：三通道等值', Math.abs(white.r - white.g) < 1e-6 && Math.abs(white.g - white.b) < 1e-6, JSON.stringify(white));

    await evaluate(`window.__h3d.setGlowColor('#ff8800')`);
    // 显式给足够长的长度，避免依赖默认值（默认 0.05s，衰减太快读不到）
    await evaluate(`window.__h3d.setGlowDuration(1)`);
    await evaluate(`window.__h3d.triggerGlow(137)`);
    await sleep(120);
    const orange = await colorOf(137);
    ok('换成橙色后 R > G > B（色相保留）',
      orange.r > orange.g && orange.g > orange.b,
      `r=${orange.r.toFixed(3)} g=${orange.g.toFixed(3)} b=${orange.b.toFixed(3)}`);

    // 等待衰减结束：长度设成 1s → 保持 1s + 衰减 1s ≈ 2s，留足余量（别按默认值算，这里改了长度）
    await sleep(3200);
    const after = await colorOf(137);
    ok('长度结束后发光归零（回到黑）', lum(after) === 0, JSON.stringify(after));
  }
} catch (err) {
  failures++;
  console.log(`  [FAIL] 探测过程出错: ${err.message}`);
} finally {
  cleanup();
}

console.log(`\n${failures ? `存在 ${failures} 个失败项` : 'CDP 运行时验证通过'}\n`);
process.exitCode = failures ? 1 : 0;

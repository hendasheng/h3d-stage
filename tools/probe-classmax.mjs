/**
 * probe-classmax.mjs —— 检查 class 编号控件的上限是否等于模型真实最大 class。
 * 用 CDP 连真实页面读取。
 * 运行：node tools/probe-classmax.mjs
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 9223;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const profile = mkdtempSync(join(tmpdir(), 'dsh-cmax-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--enable-unsafe-swiftshader', '--use-angle=swiftshader',
  '--no-sandbox', '--no-first-run', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`, '--window-size=1600,1000', 'http://127.0.0.1:5178/',
], { stdio: 'ignore' });

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
    } catch { /* 继续等 */ }
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
    pending.set(mid, (m) => res(m.result?.result?.value));
    ws.send(JSON.stringify({ id: mid, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });

  for (let i = 0; i < 40; i++) {
    if (await evaluate(`!!document.querySelector('#overlay.done')`)) break;
    await sleep(700);
  }

  console.log('=== class 编号来源 ===');
  console.log('  部件数            =', await evaluate(`window.__h3d ? window.__h3d.classCount() : 'no hook'`));
  console.log('  maxClassId        =', await evaluate(`window.__h3d ? window.__h3d.maxClassId() : 'no hook'`));

  // Tweakpane 的滑块/输入框：找"class 编号"那一行附近的 input 与其 max 属性
  const info = await evaluate(`(() => {
    const inputs = [...document.querySelectorAll('input.tp-txtv_i')];
    const out = inputs.map((el) => {
      const wrap = el.closest('.tp-txtv');
      const row = wrap ? wrap.closest('.tp-lblv') : null;
      const label = row ? (row.textContent || '').replace(el.value, '').trim() : '';
      return { label, value: el.value, min: el.getAttribute('min'), max: el.getAttribute('max'), step: el.getAttribute('step') };
    });
    return JSON.stringify(out);
  })()`);
  // 行为验证：往 class 输入框写一个远超范围的值，看是否被钳到模型最大值。
  // （Tweakpane 不把 min/max 暴露到 DOM，只能这样验。）
  const clampResult = await evaluate(`(async () => {
    const el = [...document.querySelectorAll('input.tp-txtv_i')].find((i) => {
      const row = i.closest('.tp-lblv');
      return row && /class/.test(row.textContent || '');
    });
    if (!el) return 'no-input';
    const label = (el.closest('.tp-lblv')?.textContent || '').trim();
    const set = (v) => {
      el.focus();
      el.value = String(v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.blur();
    };
    set(99999);
    await new Promise((r) => setTimeout(r, 150));
    const high = el.value;
    set(-5);
    await new Promise((r) => setTimeout(r, 150));
    const low = el.value;
    return JSON.stringify({ label, high, low, max: window.__h3d.maxClassId() });
  })()`);

  console.log('\\n=== 越界输入是否被钳到模型范围 ===');
  try {
    const r = JSON.parse(clampResult);
    console.log(`  标签 = ${JSON.stringify(r.label)}`);
    console.log(`  输入 99999 -> ${r.high}    输入 -5 -> ${r.low}    （模型 max=${r.max}）`);
    console.log(`  [${r.high === String(r.max) ? 'OK' : 'FAIL'}] 超上限被钳到 ${r.max}`);
    console.log(`  [${r.low === '0' ? 'OK' : 'FAIL'}] 低于 0 被钳到 0`);
    console.log(`  [${r.label.includes(String(r.max)) ? 'OK' : 'FAIL'}] 标签里写出了范围（含 ${r.max}）`);
  } catch {
    console.log('  解析失败:', clampResult);
  }

  console.log('\n=== 所有数值输入框 ===');
  for (const it of JSON.parse(info)) {
    console.log(`  label=${JSON.stringify(it.label).padEnd(14)} value=${String(it.value).padEnd(8)} min=${it.min} max=${it.max} step=${it.step}`);
  }
} catch (err) {
  console.log('探测出错:', err.message);
} finally {
  cleanup();
}

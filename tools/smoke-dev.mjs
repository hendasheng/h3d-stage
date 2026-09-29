/**
 * smoke-dev.mjs —— 抓"页面根本打不开"这类错误（秒级，不需要浏览器）。
 *
 * 起因：`vite build` 通过并不代表 dev 能跑。两者 JSX 转换不同 ——
 * 缺 @preact/preset-vite 时，build 走 automatic runtime 能过，
 * dev 却按 esbuild 默认的 React.createElement 编译，浏览器报 "React is not defined"。
 *
 * 做法：取 dev server 实际吐出的模块源码，检查有没有对 React 的残留引用。
 * 若 5178 上已有 dev server 就直接用它，否则临时起一个、测完杀掉。
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const PORT = 5178;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const MODULES = ['/src/main.js', '/src/ui/App.jsx', '/src/ui/store.js'];

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [OK]  ' : '  [FAIL]'} ${label}${extra ? ' -> ' + extra : ''}`);
};

const isServing = async () => {
  try {
    const r = await fetch(ORIGIN + '/', { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch { return false; }
};

let child = null;
if (!(await isServing())) {
  console.log(`端口 ${PORT} 上没有 dev server，临时启动一个…`);
  // 直接跑 vite 的入口（用当前 node），不走 npx：
  // Node 不允许不经 shell 直接 spawn `.cmd`（会 spawn EINVAL），而 shell:true 又要处理引号转义。
  const viteBin = fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url));
  child = spawn(process.execPath, [viteBin, '--port', String(PORT), '--strictPort'],
    { stdio: 'ignore', cwd: fileURLToPath(new URL('..', import.meta.url)) });
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline && !(await isServing())) await sleep(400);
  if (!(await isServing())) {
    console.log('  [FAIL] dev server 起不来');
    child.kill();
    process.exit(1);
  }
}

try {
  console.log('\n=== dev server 模块转换检查 ===');
  for (const mod of MODULES) {
    let src = '';
    try {
      const r = await fetch(ORIGIN + mod, { signal: AbortSignal.timeout(10000) });
      src = await r.text();
      ok(`${mod} 返回 200`, r.ok, String(r.status));
    } catch (e) {
      ok(`${mod} 可访问`, false, e.message);
      continue;
    }
    // 关键检查：不得残留 React.createElement（Preact 项目里这必然运行时报错）
    ok(`${mod} 不含 React.createElement`, !/React\.createElement/.test(src));
    // import 说明符必须是浏览器能解析的形式（不能是裸包名）
    const bareImports = [...src.matchAll(/from\s+"([^"]+)"/g)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith('/') && !s.startsWith('.') && !s.startsWith('http') && !s.startsWith('data:'));
    ok(`${mod} 的 import 都已被处理成可解析路径`, bareImports.length === 0, bareImports.join(', '));
  }

  console.log('\n=== 关键依赖可加载 ===');
  for (const dep of ['tweakpane', 'preact']) {
    const r = await fetch(`${ORIGIN}/node_modules/.vite/deps/${dep}.js`, { signal: AbortSignal.timeout(10000) }).catch(() => null);
    ok(`${dep} 已预构建`, !!r?.ok, r ? String(r.status) : 'fetch 失败');
  }
} finally {
  if (child) {
    // 注意：Windows 上对 spawn 出来的 npx.cmd 直接 kill() 会触发 libuv 断言崩溃
    // (Assertion failed: !(handle->flags & UV_HANDLE_CLOSING))。
    // 用 taskkill 结束整个进程树，并吞掉一切错误 —— 清理失败不该影响测试结论。
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        child.kill('SIGTERM');
      }
      child.unref();
    } catch { /* 忽略 */ }
    console.log('\n（已停掉临时 dev server）');
  }
}

console.log(`\n${failures ? `存在 ${failures} 个失败项` : 'dev smoke 检查通过'}\n`);
process.exitCode = failures ? 1 : 0;
// 不用 process.exit()：它会打断尚未完成的清理，导致上面那种原生崩溃

import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

// 说明：
// 1) 模型放在 src/assets/models/，由 src/models.js 用 import.meta.glob 枚举，界面里可切换。
//    不要放 public/ —— 目录扫描会把 public 下的文件再打包一份，dist 里出现两个 glb。
// 2) preact() 插件负责 JSX 转换。没有它的话：
//    dev 时 esbuild 会按默认的 React.createElement 编译，浏览器里报 "React is not defined"；
//    而 build 恰好走 automatic runtime 又能过 —— 这种 dev/build 行为不一致极其难查。
export default defineConfig({
  plugins: [preact()],
  server: {
    host: '127.0.0.1',
    port: 5178,
    open: false,
    // 某些编辑器的原子写会在 src/ 下留 ".xxx.tmpdir" 目录，
    // chokidar 监视它时会 EBUSY 直接把 dev server 打挂，这里忽略掉。
    watch: {
      ignored: ['**/.*.tmpdir/**', '**/*.tmp', '**/node_modules/**', '**/.npm-cache/**'],
    },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
  },
});

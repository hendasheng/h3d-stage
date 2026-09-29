# AGENTS.md —— 改这个项目的强制约定

动手前读这里。与其它文件冲突时以本文件为准。
**本文件只写"该怎么做"，不复述项目背景与技术细节**（那些在 README / NOTES）。

## 0. 文档分工：一件事只写在一个文件里

写文档前先查这张表。**任何事实只能有一个归属**；其它文件需要时用链接或一句话指路，**不要抄**。

| 内容 | 唯一归属 |
| --- | --- |
| 项目是什么、怎么跑、有哪些界面功能、目录结构 | `README.md` |
| 每版的：主题、基线（模型哈希/大小/结构）、已完成、已知问题、路线图 | `VERSIONS.md` |
| 技术原理与依据、踩坑、已知限制 | `NOTES.md` |
| 强制约定（该怎么做、不要做什么） | 本文件 |

- `README.md` 要短：标准是"新人只看它能不能跑起来"。**不放**实测数据表、历史结论、逐段代码讲解。
- `VERSIONS.md` 只记版本流水，**不放**通用原理。
- `NOTES.md` 只记技术结论，**不放**版本流水账。
- 引用其它文档一律**按标题**（如 `NOTES.md` 的「某某」），不要写"第 N 节"——插一节就全错。
- **文档里不要写本机绝对路径**（`C:\Users\...`、`Desktop\...`、外盘路径等）：
  换台机器就失效，且会泄露本地目录结构。命令示例从项目根写起（`npm run dev`），
  需要指文件就写相对路径（`src/main.js`、`src/assets/models/`）。

## 1. 第三方库：优先用，或先问，不要上来就手搓

**默认假设：任何界面/交互/通用能力都有成熟库可用。** 顺序：

1. 先查有没有现成的库，有就用。
2. 有多个候选、或引新依赖会明显改变项目形态时，**先问用户**再动，给出候选与取舍。
3. 只在明确没有合适库时才手写，并在注释里说明为什么手写。

**不要**不问就手搓：UI 控件（→ Tweakpane，已用）、面板/列表/表单与响应式状态（→ Preact + signals，已用）、
可折叠面板/树/表格/弹窗/拖拽/虚拟滚动、日期时间/格式化/状态机/校验/HTTP/补间、通用数学几何算法。

**边界**：业务算法（按 `_class` 分桶、连通性聚类、Exploded View 位移）本来就该自己写，不算手搓。

> 代价已经付过：手搓 UI 出过面板重叠、收起时外框不动、状态不同步三个坑，改用库后全部消失。

## 2. 改完跑什么：轻量验证优先

改完只跑秒级检查，**不要**为小改动做重验证。

| 手段 | 量级 | 何时用 |
| --- | --- | --- |
| `node tools/validate.mjs` | 秒 | 改数据管线 |
| `npm run test:explode` | 秒 | 改炸开 / 部件状态 |
| `npm run test:smoke` | 秒 | **改 JSX / 界面 / vite 配置** |
| `npx vite build` | 数秒 | 改导入结构 / 新依赖 |
| 软件光栅化渲染、headless 截图 | 分钟 | 只在用户要求看图，或逻辑推不出对错时 |

一键：`npm run check`。**画面类确认交给用户**——用户就在看页面。
开发期脚本都在 `tools/`（用途见 `tools/README.md`），**不要往根目录加脚本**。

**`vite build` 通过 ≠ dev 能跑**：缺 `@preact/preset-vite` 时 build 走 automatic runtime 能过，
dev 却按 `React.createElement` 编译而白屏。所以动了 JSX 或 vite 配置**必须**跑 `test:smoke`。

## 3. 硬性约束

- **模型位置固定**：`src/assets/models/`，界面里的下拉自动枚举（`src/models.js` 用 `import.meta.glob`）。
  **不要**加清单文件、**不要**放回 `public/`（`public/` 配合目录扫描会让构建产物出现两份 glb）。
- **不要**用 `uncaughtException` / `unhandledRejection` 吞异常让测试变绿；让错误暴露。
- **不要**把项目定位绑回"Houdini 模型查看器"——Houdini 只是素材来源之一。
- 动画用的静止位置（`userData.basePosition`）**只写一次、只读不改**；复位路径要单独测
  （只测函数内部逻辑会漏掉"它到底有没有被调用"）。
- `@preact/signals` 的 `subscribe()` **会立即同步触发一次**：初始化期间的这类回调要用就绪标志挡住
  （见 `main.js` 的 `ready`），相关变量必须声明在使用之前，否则命中 TDZ。
- 新增模型文件后**提示用户刷新页面**（目录扫描发生在模块加载时）。

## 4. 环境与沙箱

- `npm install` **必须加 `--ignore-scripts`**（esbuild 的 postinstall 会 `spawn EPERM`；平台二进制走 optionalDependencies，跳过不影响）。
- npm 缓存已由 `.npmrc` 指到项目内 `.npm-cache`，**不要改回全局**。
- `vite` / `vite build` 需要 esbuild 子进程（管道 stdio），受限沙箱下 `spawn EPERM` —— 按提示申请放宽，别绕路。
- dev server 端口 **5178**（`--strictPort`）。重启前确认旧进程已退，否则新实例会悄悄换到 5179，你会对着旧代码调试。
- `vite.config.js` 的 `server.watch.ignored` **不要删**：编辑器临时目录、Chrome profile 被监视会 `EBUSY` 打挂 dev server。
- **改目录名**：dev server 会把根目录锁死，`Rename-Item` / `Move-Item` 必然失败。做法：
  停 server → `robocopy <旧> <新> /E /MOVE /NFL /NDL /NJH /NJS /R:1 /W:1`（退出码 1 = 正常完成）
  → **核对 `src/assets/models/` 下资源**（曾发生模型被上层改名导致 ENOENT）→ `npm run check` 全绿再交付。

## 5. 版本流程

**接到新一轮工作，先建版本、再动手**：

1. 改 `package.json` 的 `version`（唯一来源，UI 自动跟随）
2. 在 `VERSIONS.md` 顶部开新版本段：主题、基线（模型哈希 / 大小 / 结构）、路线图候选
3. **停下等需求确认**，不要拿候选清单自己开工
4. 需求明确后再实现，完成后补「已完成 / 已知问题」

> 0.1 是直接开工、事后补记录的反例。0.2 起按此流程。
> 已知问题如实记录，包括"这个数字随每次导出变化"这类前提，避免误判为回归。

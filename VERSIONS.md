# 版本记录

每版只记：主题 · 基线 · 已完成 · 已知问题 · 路线图。
技术原理一律写在 `NOTES.md`，本文件不重复。

---

## 0.2.0-dev — 进行中（自 2026-09-29）

**主题：项目更名 · 模型基础材质 · class 分色可选 · 拆除模型路径的外部通路。**

### 基线

| 项 | 值 |
| --- | --- |
| 模型 | `src/assets/models/`（3 个文件；早期为 `public/models/Geo1.glb`） |
| 大小 / 时间 | 主文件 565,452 bytes / 2026-09-29 20:58:38 |
| SHA256 | `CE515DF9591113DC23937B58D9D769D9FEC930D0D6DDDBD3F78C7C7F5D098A6E`（主文件） |
| 结构 | 1 node / 1 mesh / 1 primitive / 0 material |
| 属性 | `POSITION`、`NORMAL`、`TANGENT`、`TEXCOORD_0`、**`_class`** |
| `_class` | UNSIGNED_INT，取值 0~249 → **250 个碎块**，三角形相加 = 5476 |

> 模型会被 Houdini 侧反复覆盖导出：与 `class` 直接相关的结构性事实写死校验；
> 随导出变化的量（唯一点数、连通体数、包围盒）只断言关系。

### 已完成

1. **更名** `three-houdini-parts` → `h3d-stage`（包名 + 目录一起改）。
   采用 `robocopy /E /MOVE`（dev server 锁根目录，`Rename-Item` 不可用），详见 `NOTES.md` 的「目录改名的正确姿势」。
2. **模型基础材质**：默认统一中性色（metalness 0.12 / roughness 0.62，默认 `#9aa3ad`，面板可调）；
   移除原「随机配色 / 按高度 / 按法线」三选一。
3. **class 分色成为参数**：默认关闭；打开后按 class 分配 250 种可区分颜色。
   点击部件时标题区显示 部件名 · 三角形数 · class 编号 · 颜色。
4. **版本号收敛为单一来源**：`package.json` → `src/ui/version.js` → UI / `main.js` / `validate.mjs`
   （原先 4 处各写一份；同时消除了 `App.jsx ↔ main.js` 的循环依赖）。
5. **拆除模型路径的外部通路**（用户要求）：删除 `VITE_MODEL_URL` 环境变量读取、`.env.example`、
   `vite.config.js` 里的 `server.fs.allow`；改为 `src/main.js` 顶部一行手动指定。约定已写入 `AGENTS.md`。
6. **开发期脚本收进 `tools/`**：原先 6 个 `.mjs` 堆在根目录（自检 / 测试桩 / 静态预览），
   与应用本体混在一起。现统一移到 `tools/`，根目录只留应用与配置；对应 npm scripts 与文档引用已同步。
7. **多模型切换**：模型改放 `src/assets/models/`，`src/models.js` 用 `import.meta.glob` 在构建期
   枚举目录，界面「控制 → 模型」下拉自动列出全部模型，切换即重新加载（含旧模型的资源释放）。
   没有清单文件要维护。**不要**放回 `public/`——目录扫描会把 public 下的文件再打包一份，
   dist 里会出现两个 glb（实测确认）。
8. **去掉「数据来源」参数**（用户要求）：只保留按 `_class` 逐块这一条路径，删掉 `store.mode`
   及相关的构建分支；没有分组属性时自动退回"整个网格当一个部件"。
9. **标题显示真实文件名**：从实际加载的模型取，不再有写死的显示名。
10. **错误可读性**：加载时先校验 `Content-Type`，解析前校验 magic —— 路径错时不再只报
    "不是合法的 GLB 文件"（根因是 dev server 对不存在的路径返回 `index.html` 且状态码为 200）。
    测试也不写死模型名，统一走 `tools/model-file.mjs` 定位。

### 路线图候选（等确认，未开工）

| # | 功能 | 价值 | 依据 |
| --- | --- | --- | --- |
| 1 | `name` 属性分块路径 | 适配其它导出：`name` 是字符串属性，需先做"值 → id"映射 | 与 `_class` 机制同理 |
| 2 | 模型切换入口 | 界面里直接换 GLB，不用改代码里的 `MODEL_URL` | 目前换模型要改 `src/main.js` 一行 |
| 3 | 朝向下拉（Y-up / Z-up） | 上游坐标系不同时不用改代码 | 曾因多加一次旋转返工 |
| 4 | 导出 250 块为多节点 GLB | 把拆分结果存回 GLB，可在 Houdini 里核对 | 需要交叉验证拆分正确性 |
| 5 | 破碎动画 | 炸开后加缓动/物理（先找库） | 当前只有静态炸开 |
| 6 | 列表虚拟滚动 | 部件数上千时保持流畅 | 当前 250 行全量渲染 |
| 7 | 炸开方向可选 | 质心方向 / 固定轴向 / 最近邻 | 对齐 Houdini 不同做法 |

---

## 0.1.0 — 已完成（2026-09-29）

**主题：验证 Houdini 的 `class` 属性能否在 three.js 里逐块读取。**

### 基线

| 项 | 值 |
| --- | --- |
| 模型 | `939_Building_Fracture\glb\Geo1.glb`（当时从 E: 盘复制进项目） |
| 大小 | 565,452 bytes |
| 结构 | 1 node / 1 mesh / 1 primitive / 0 material，属性含 `_class` |
| 结论 | `_class` 取值 0~249 连续 → 250 个碎块；三角形相加 = 5476 |

### 验证结论（原理见 `NOTES.md`）

1. Houdini 的 `class` 导出为 glTF 自定义顶点通道 `_class`（UNSIGNED_INT）。
2. three.js 的 `GLTFLoader` **完整保留**该通道，读出为 `Uint32Array`。
3. 同一三角形的三个顶点 class 一致 → 按首顶点分桶是安全的。
4. 250 块三角形相加 = 5476 = 模型总数 → 分块不丢面、不重复。

### 本版交付

- 数据来源两种模式：按 `_class` 逐块（默认）/ 原始单网格
- 部件列表：选中（与 3D 拾取联动）、逐块显隐、名称过滤、可收起
- 逐部件操作：炸开、线框、自动旋转
- 结构诊断面板：`_class`、node/mesh/primitive/material、焊接与连通体实测
- 三项自检：`validate.mjs` · `test-explode-reset.mjs` · `smoke-dev.mjs`

### 本版修掉的问题

| 现象 | 根因 | 修复 |
| --- | --- | --- |
| 首屏两个模型（一彩色一白色） | 原始网格未隐藏，与拆出的部件叠加 | 原始网格只在「原始单网格」模式显示 |
| 「原始单网格」模式模型躺下 | 加载时多设了一次 `rotation.x = -π/2`，部件未继承 | 去掉该旋转，两模式朝向统一 |
| 炸开拉到 0 仍有偏移、反复拖动越来越大 | ① 爆炸后位置被写回不变量 `basePosition`，每帧累加；② `tick()` 写成 `if (explode > 0)`，归零那帧根本不调用 → 复位分支永不执行 | `basePosition` 只写一次；判断提成 `shouldUpdateExplode()` 并新增专项测试 |
| 页面白屏 `React is not defined` | 缺 Preact 的 JSX 插件：dev 按 `React.createElement` 编译，build 恰好走 automatic runtime 所以能过 | 挂 `@preact/preset-vite`，新增 `smoke-dev.mjs` 守这条 |
| `Cannot access 'lastExplode' before initialization` | `signals.subscribe()` 立即同步触发，而变量声明在其后（TDZ） | 声明提前到文件顶部 |
| `buildMode()` 在模型加载前被调用 | 同一个"立即同步回调"触发了 `mode` 订阅 | 加 `ready` 标志，模型就绪前忽略重建 |

### 已知限制

- 未做自动化浏览器渲染验证，渲染结果依赖人工确认。
- 连通性/焊接类指标随每次导出变化，不代表 `class` 分块结果。
- 初始居中用的是"原始网格包围盒（含 Houdini 自身变换）"，而部件按原始几何生成，
  两者原点可能不同——当前模型恰好一致，换模型需留意。

# h3d-stage

演出用的实时交互场景：**Houdini 产出 3D 模型 → 接入 three.js → 外部信号驱动**。
当前实现了前两段：读模型、按属性拆成"部件"、检查 / 上色 / 炸开。信号驱动（OSC）是后续方向。

```bash
npm install          # 依赖（已装好可跳过）
npm run dev          # http://127.0.0.1:5178/
npm run check        # 三项自检（数据管线 / 炸开复位 / dev smoke）
```

**详细文档**：[AGENTS.md](./AGENTS.md)（改项目必读）· [VERSIONS.md](./VERSIONS.md)（版本与基线）· [NOTES.md](./NOTES.md)（技术结论与踩坑）

## 界面

| 区域 | 内容 |
| --- | --- |
| 左 · 标题 | 模型文件名、摘要、选中部件信息 |
| 左 · 模型 / 诊断 | 模型路径与结构、`_class` 统计、连通性等实测信息 |
| 右 · 控制参数 | 模型（在多个模型间切换）、材质（基础颜色 / class 分色）、每个部件（炸开距离 / 线框 / 自动旋转） |
| 右 · 部件列表 | 点击选中（与 3D 拾取联动）、逐块显隐、按名称过滤、可收起 |

选中部件时标题区显示：部件名 · 三角形数 · class 编号 · 颜色。

## 模型

把 `.glb` 放进 `src/assets/models/`，界面「控制 → 模型」的下拉里会自动出现，直接切换即可。
没有清单文件需要维护——目录内容由构建期扫描得到。

> 模型放在 `src/assets/` 而不是 `public/`：后者配合目录扫描会让构建产物里出现两份 glb。

## 目录

```
h3d-stage/
├─ index.html              # 外壳：canvas + 挂载点 + 加载遮罩
├─ vite.config.js          # preact 插件（JSX 转换）+ dev server 配置
├─ tools/                  # 开发期脚本（自检 / 预览），不参与应用运行
└─ src/
   ├─ assets/models/       # 模型（放进来即可，界面下拉自动出现）
   ├─ main.js              # three.js 场景 + 模型解析 + 与 UI 接线
   ├─ parts.js             # 取部件与逐部件操作
   ├─ connectivity.js      # 并查集 / 焊接 / 连通体 / 距离聚类 / 网格分区
   ├─ palette.js           # class 配色 + 子几何体抽取
   ├─ demo-glb.js          # GLB 二进制解析 + 多节点 GLB 重导出
   ├─ base.css             # 外壳样式 + Tweakpane 深色主题
   └─ ui/                  # Preact 组件 + signals 状态 + 版本号
```

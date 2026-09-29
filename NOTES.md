# 技术结论与踩坑

记录**实测得到的事实与依据**，避免重复踩坑。
本文件只写"为什么、怎么发现的"；**规则**在 `AGENTS.md`，**版本流水**在 `VERSIONS.md`。

---

## Houdini `class` → glTF `_class`（核心机制）

Houdini 的 glTF 导出器给自定义属性名加下划线：

| Houdini 属性 | glTF 通道 | 类型 |
| --- | --- | --- |
| `class` | `_class` | UNSIGNED_INT (5125) |
| `name` | `_name` | 字符串属性需自行映射为 id |

实测要点：

- `_class` 是**逐顶点**的（`bufferView.target = 34962`）
- 同一三角形的三个顶点 class 完全一致（5476 个三角形中 0 个不一致）
  → **按首顶点取 class 分桶是安全的**
- 取值 `0~249` 连续整数，每个取值都有三角形

## three.js 会原样保留 `_class`

`GLTFLoader` 的映射规则是 `ATTRIBUTES[name] || name.toLowerCase()`；`ATTRIBUTES` 只含
POSITION/NORMAL/TANGENT/TEXCOORD_0 等标准通道，所以 `_class` 走 `toLowerCase()` 分支，
名字保持不变：

```js
mesh.name                              // "geo1"
Object.keys(mesh.geometry.attributes)  // ['position','tangent','normal','uv','_class']
mesh.geometry.attributes._class.array  // Uint32Array(10206)
mesh.geometry.groups                   // []  ← 没有 material group
```

于是"逐块 for 循环"就是按属性分桶，无需任何猜测算法：

```js
const attr = mesh.geometry.attributes._class;
const index = mesh.geometry.index.array;
const byClass = new Map();
for (let t = 0; t < index.length / 3; t++) {
  const cls = attr.array[index[t * 3]];   // 第 t 个三角形属于哪个碎块
  if (!byClass.has(cls)) byClass.set(cls, []);
  byClass.get(cls).push(t);
}
```

实现：`src/parts.js` 的 `buildPartsFromVertexAttribute()`。
另有一条对照路径 —— 不拆分、直接 `gltf.scene.traverse()` 拿原始网格。

## 这份模型**不能**靠连通性分块（重要）

以基线文件实测：

| 指标 | 值 | 含义 |
| --- | --- | --- |
| 顶点数 | 10206 | |
| 位置去重后唯一点 | ~817 | 大量顶点重复 → 面基本未焊接 |
| 按共享顶点划分的连通体 | ~2365 个 | 最大一块仅 7 个三角形 |
| 同坐标点 | 同 class 内重复数千、跨 class 亦有 | 块内与块间都在复用坐标 |

结论：`connectivityBySharedVertices()` 切出的是三角形碎片，**与 250 个碎块无关**；
有 `_class` 时这条路直接跳过。
（`connectivity.js` 的焊接 / 距离聚类 / 网格分区保留着，是给没有 `class` 的模型准备的备用方案。）

> ⚠️ 上表数字**每次导出都会变**（作者在持续调模型）。所以 `validate.mjs` 对它们只断言**关系**
> （划分有效、最大连通体远小于平均块面数），不写死数值，避免每次导出误报失败。

## Exploded View 的位移逻辑

不是"所有块等距平移"：

1. 每块取自己的质心（本项目用包围盒中心）
2. 方向 = 该质心相对整体质心的方向（向外）
3. **位移量 ∝ 到中心的距离** → 远处走得多、近处走得少，整体轮廓被放大而非整体平移

```js
dir.copy(base).sub(center).normalize();
part.position.copy(base).addScaledVector(dir, factor * 0.7 * base.distanceTo(center));
```

实现：`src/parts.js` 的 `updateExplode()`。

## glTF 是 Y-up，不要再额外旋转

`GLTFLoader` 加载后朝向已正确。曾额外设 `sourceScene.rotation.x = -Math.PI/2`，
结果原始网格躺下，而按原始几何生成的部件没吃到这个旋转 → 两个模式姿态不一致。
**只做居中，不改朝向。**

## 测试与构建的坑

**`vite build` 通过 ≠ dev 能跑。** 缺 `@preact/preset-vite` 时，build 走 automatic runtime 能过，
dev 却按 esbuild 默认的 `React.createElement` 编译 → 浏览器白屏 `React is not defined`。
这种 dev/build 行为不一致极难查，所以有 `smoke-dev.mjs` 专门守这条（取 dev 实际吐出的模块源码检查）。

**dev server 对不存在的路径返回 `index.html`（状态码仍是 200）**，而不是 404。
于是"模型路径写错 / 文件被改名"会表现成 `不是合法的 GLB 文件`——实际是 HTML 被拿去解析了。
对策：加载时先看 `Content-Type`（应为 `model/gltf-binary`），解析前再校验 magic，
两者都会给出"拿到的其实是 HTML"这类可读信息。
另外模型文件名由使用者手动改（曾出现 `Geo1.glb` → `939_Building_Fracture_Geo1.glb`），
所以**测试与自检不要写死文件名**，统一走 `tools/model-file.mjs` 定位。

**`@preact/signals` 的 `subscribe()` 会立即同步触发一次回调**，初始化期间会引发两类崩溃：

1. **TDZ**：回调用到的 `let` 变量声明在 `subscribe()` 之后 → `Cannot access before initialization`。
2. **空场景重建**：`mode` 的订阅立刻跑 `buildMode()`，此时模型未加载、`sourceMesh` 为 null → `TypeError`。

对策：变量声明提前、用就绪标志（`main.js` 的 `ready`）挡住初始化期的回调。

**复位路径必须专门测。** 炸开滑块曾出现"拉到 0 仍有偏移且越来越大"——
`updateExplode` 内部逻辑没问题，问题是 `tick()` 的调用条件写成 `explode > 0`，
**归零那帧函数根本没被调用**。只测函数内部逻辑会漏掉"它到底有没有被调用"。

## 环境

- Node v24.18.0 / npm 11.16.0（无 pnpm）
- three `^0.180.0`、vite `^7.0.0`、tweakpane `^4.0.5`、preact `^10.29.8`、@preact/signals `^2.11.2`
- 受限沙箱下 esbuild 的 postinstall 与管道 stdio 会 `spawn EPERM`（对策见 `AGENTS.md`）

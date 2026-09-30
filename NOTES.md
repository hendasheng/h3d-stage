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

## class 发光：信号语义（0.3 材质驱动）

一条信号至少两条信息 —— **编号 + 长度**：

| 字段 | 含义 |
| --- | --- |
| 编号 classId | 哪个 class 发光。**整数**（小数一律归一，OSC 常以 float32 传整数） |
| 长度 duration | 亮多久（秒），语义同 MIDI 音符长度：满亮保持 L 秒 → 再用 L 秒线性衰减（释放尾巴） |

`duration = 0` / 缺省 = 持续，直到显式 `release()`。界面默认值：**长度 0.05 秒、峰值强度 50**
（`src/ui/store.js` 与 `src/glow.js` 的 `GLOW_DEFAULTS` 必须一致，测试有断言锁住）。

实现要点（`src/glow.js`：纯逻辑、不依赖 three，可单测）：

- 强度按**时间戳**计算，不按帧累加 → 掉帧不残留、不同帧率结果一致
- 材质侧**把"颜色 × 强度"整体写进 `emissive`，`emissiveIntensity` 固定为 1**，基色不动
  → 颜色全黑时它就是纯基础材质；所以"基础材质 / 基础+发光"两态用**同一材质**表达，不需要换材质
- 上述存储形式与使用 `emissiveIntensity` 数学等价，不会自行避免过曝；保色机制见「高强度发光与色调映射」。
- **emissive 归发光独占**：选中高亮原先也写 emissive，会互相覆盖，已改为选中只在列表/信息区体现

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

**面板控件的范围别用"还没加载的数据"算，更别用超大兜底值。** class 编号滑块出过两次问题：
① `max` 取自组件挂载时还是空的 `store.parts` → 滑块被建成 `0..0`，完全拖不动；
② 为绕开①先给 `max = 100000`，结果**这个兜底值成了实际生效的上限**，能拉到 100000。
正解：上限取**模型的真实最大 class**（`src/main.js` 导出的 `maxClassId()`），
并且**只在模型就绪后才创建该控件**（`hasClassRange()` 为假就先不建）。
验证方式：给输入框写 99999 看是否被钳到真实最大值——Tweakpane 不把 min/max 暴露到 DOM，
只能这样按行为验。

**Tweakpane 的 `setHex()` 吃不了 CSS 颜色字符串。** 面板的颜色值形如 `"#ff8800"`，
`emissive.setHex("#ff8800")` 会得到 `#000NaN`（实测过）。统一改用 `new THREE.Color(v)` 解析。

## 高强度发光与色调映射

`emissive = color × intensity` 与 `emissive = color, emissiveIntensity = intensity`
进入 Three shader 后完全等价。只验证材质通道比例，无法证明屏幕颜色正确。
ACES 在高强度下会使颜色趋向白色；把乘法挪到 CPU 无法解决。

将发光在 tone mapping 后压缩并混入基础颜色，会变成表面染色，不能替代发光。
全场景 Bloom 会同时提取普通材质的高亮反射，不能保证只让指定 class 发光。
当前使用原生 `MeshStandardMaterial` 自发光；场景辉光使用 Three 的 `UnrealBloomPass`，最后由 `OutputPass` 统一处理色调映射与输出颜色空间。关闭辉光时恢复直接渲染，没有自定义材质 shader。
高强度褪色问题未解决，后续方案须验证指定 class 与未触发部件的实际显示。

Three 默认颜色管理启用，材质存储的是线性值（`#ff8800` 的 G ≈ 0.246）。
材质数值测试只能验证传值与归零，过曝程度仍需浏览器画面确认。

## 雾：参考站公式与材质注入的五个陷阱

参考效果：`projects.thibautfoussard.com/fog`。它的实现是**材质注入**（不是 three 内置雾、不是后期），
公式用 CDP 拦截 `WebGL2RenderingContext.shaderSource` 抓原文得到：

```glsl
float verticalMixer = smoothstep(vWorldPosition.y - fogSmoothness, vWorldPosition.y + fogSmoothness, fogPositionY);
float distanceToCamera = length(vWorldPosition - cameraPosition);
float depthMixer = smoothstep(distanceToCamera + fogDepthSmoothness, distanceToCamera - fogDepthSmoothness, fogDepth);
depthMixer = mix(0., depthMixer, verticalMixer);          // 深度项被高度项门控
float mixer = verticalMixer * .5 + depthMixer * .95;      // 相加加权，不是二选一
mixer = clamp(mixer, 0., 1.);
outgoingLight = mix(outgoingLight, vec3(1.), mixer);      // 参考站混纯白
```

三条与直觉相反的结论，写断言前必须先想清楚：

- **两项是相加加权**（`*.5 + *.95`），不是 `mix(高度, 深度, k)`。所以 `verticalMixer=1` 且
  `depthMixer=0` 时画面**已经**有 0.5 的雾量；两者同时饱和会被 `clamp` 到 1。
- **深度项被高度项门控**：`verticalMixer=0` 的地方（画面整体高于雾面）两项一起归零，
  这时怎么调 `fogDepth` 都不会有雾。反过来 `verticalMixer=1` 的地方，`fogDepth` 才说了算。
- **没有"距离雾/高度分层雾"两种模式**，四个参数始终同时生效。自创模式是早先走错的路。

我们的两点改动：混 `uFogColor`（默认纯白，默认画面与参考站一致）而不是写死 `vec3(1.)`；
混入量乘 `fogEnabled` 以便关断。

### 陷阱一：`outgoingLight` 的合成行每种材质都不一样

给材质注入雾，必须改 `outgoingLight`，但这一行的写法**按材质类型分家**：

| 材质 | 合成行 |
| --- | --- |
| Standard / Physical | `vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;` |
| Basic | `vec3 outgoingLight = reflectedLight.indirectDiffuse;` |
| Lambert / Toon | `vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;` |
| Phong | `…directDiffuse + indirectDiffuse + directSpecular + indirectSpecular + totalEmissiveRadiance;` |
| Matcap | `vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;` |
| Points / Sprite / Line | `outgoingLight = diffuseColor.rgb;` |

只认第一种（PBR）时，**其它材质的雾是静默消失的**：注入函数被调用了、uniform 也挂上了、
`customProgramCacheKey` 也变了，唯独那行代码没插进去。表现就是"链路全对、画面一动不动"。
对策：全部列出，并且在一处都没命中时 `console.error` 报出材质类型，不许静默。

### 陷阱二：varying 名不能照抄，参考站的名字在 three 里已被占用

参考站的 varying 叫 `vWorldPosition`，但 three 的顶点着色器在 `ENV_WORLDPOS` 分支里
**已经声明过同名 varying**（envmap 用）。照抄 → 同一份 shader 里重复声明 varying →
顶点着色器编译失败；同时我们并未给它赋值，片元端读到的恒为 0。两个问题叠在一起，
现象同样是"注入命中但参数完全不动画面"。我们改用 `vH3dWorldPos`。

> 教训：注入型改动的"命中"毫无意义。判据只有两个 ——
> **编译后的着色器里真的有那段代码**（用 CDP 抓 `shaderSource` 看原文），
> 以及**像素真的变了**（`readPixels` 回读）。两者都做过才敢说修好了。

### 陷阱三（最致命）：uniform 值改了但不会被上传，画面一动不动

three 的 `getUniformList()` 把「这个程序里哪些 uniform 需要上传」这张表
**缓存在材质上**（`materialProperties.uniformsList`），而程序是按 `customProgramCacheKey` 缓存的。
两者合起来：**cacheKey 不变 ⇒ 程序只编译一次 ⇒ 之后改 `uniforms.xxx.value` 永远不会被上传**。

表现极具误导性：注入命中了、`onBeforeCompile` 每次都调用、uniform 对象的现场值也是新的，
**唯独画面纹丝不动**（真实页面实测：改 depth / height / color，全屏均值恒为 188.71）。
参考站有同样的结构性问题，只是它把参数喂给 Leva 的初值、从不在运行时改，所以看不出来。

对策（见 `src/fog.js` 的 `stateKey()`）：`customProgramCacheKey()` 里**带上当前参数值**，
值一变就换一个程序；值变化时给所有已注入材质 `needsUpdate = true`。
代价是拖滑块会重编译，换来的是"参数真的有效"。判定它有没有修好，**不能看 uniform 值，只能看像素**。

## 动态雾（0.5）：噪声只扰动雾面高度

来源：Codrops《The Sleepers》（同一作者 Thibaut Foussard）。核心做法是**用一张无缝噪声贴图代替运行时算噪声**
——雾要注入到场景里每个材质，每帧每像素现算噪声代价太大。

本项目的注入（见 `src/fog.js`）：

```glsl
vec2 noiseUv = vH3dWorldPos.xz * fogNoiseScale
             + vec2(uFogTime * fogFlow.x, uFogTime * fogFlow.y);
vec2 warpOffset = texture2D(uFogNoise, noiseUv * 0.37).rg - 0.5;   // domain warp
float noise = texture2D(uFogNoise, noiseUv + warpOffset * fogWarp).r;
float noiseOffset = (noise - 0.5) * fogNoiseStrength * fogDynamic;

float verticalMixer = smoothstep(y - fogSmoothness, y + fogSmoothness,
                                 fogPositionY + noiseOffset);
// …其余与 0.4 完全一致
```

四个设计点：

- **只动雾面高度**。噪声不参与深度项、不改混合权重，所以 `dynamic = 0` 时画面与 0.4 逐像素一致
  （探针实测：关动态后推进时间，变化像素数为 0）。
- **沿世界 xz 平面采样**。雾面是水平的，噪声该像一张铺在地面上的图，而不是贴在模型表面。
- **domain warp** 让流动不规则：拿第一层噪声去推歪采样位置，比单纯平移更像雾。
- **时间不进 cacheKey**。`uFogTime` 每帧都变，进指纹就等于每帧重编译；它只改 uniform 值。

### 两个量级陷阱（都让我误判过"噪声没生效"）

1. **噪声贴图必须在 `bindUniforms` 里更新，不能只在构造时写一次。**
   否则运行期传进来的贴图永远不会绑到 sampler 上，采到的是未绑定纹理（纯黑），
   于是"噪声"恒为常数、画面纹丝不动。
2. **强度要和 `smoothness`（高度过渡带）同量级才看得见。**
   过渡带 5 宽时，强度 0.35 只把界线推动 ±0.17（约 3%），肉眼看不出；
   强度 6 时开关动态有约 14% 的像素变化。`noiseScale` 也不是越大越好：
   它决定"一个噪声周期跨多少世界单位"（`1/noiseScale`），
   若远大于模型尺寸，整个模型只落在一个噪声块里，雾界线只能整体平移、出不来起伏。

### 噪声贴图怎么来的

`tools/gen-noise-texture.mjs`（`npm run gen:noise`）程序生成，产物
`src/assets/textures/noise-tileable.png` 随源码打包（59 KB，8 位灰度）。

- **周期性梯度噪声**：格点哈希时把整数坐标对 period 取模，
  于是 `x = period` 与 `x = 0` 得到同一个哈希，边界天然连续。实测接缝跳变为 **0**。
- fBm 叠 4 层，每层周期同步翻倍，整体仍然严格平铺。
- 贴图值域拉到满量程，少浪费 8 位精度。
- `npm run check` 里带 `--check`，会比对文件与生成结果是否一致，防止手改或忘记重新生成。

> 8 位精度够用：噪声只用于推动雾界线，量化台阶远小于过渡带宽度，实测画面无可见条带。

## 背景与几何：天穹为什么存在、尺寸怎么定

参考站（`projects.thibautfoussard.com/fog`）的场景构成与本项目的对应：

| 元素 | 参考站 | 本项目 |
| --- | --- | --- |
| 背景 | **渐变天穹**：球体（BackSide）跟随相机，顶 `#000000` → 底 `#ffffff`，分界用**与雾同一个** smoothstep | 同（`src/sky-dome.js`） |
| 地面 | 圆面 r=100，`MeshStandardMaterial` 色 `#333333`、rough 1、metal 0，放在 `y=-10` | **不要**：雾直接作用于模型本身，地面是多余遮挡 |
| 主几何 | city.glb 缩放 0.5、`y=-10`，全部换成雾注入材质 | 用户导入的模型 |
| 光照 | `ambientLight` π/2 + HDR 环境（`backgroundIntensity 0.17`，Cineon，曝光 1） | 项目原有的灯光与 HDR 环境 |
| 相机 | `fov 110`，位置 `[-28, 4.5, -17]`，target `[0,-10,0]` —— **街面高度看出去** | 项目原有的环绕相机 |
| 「雾墙」 | 只是个**半径 0.5 的小球**（放在相机位置、`renderOrder 9`），用于可视化雾面高度，**不是实体** | 未实现（不需要） |

**参考站没有背景板、没有雾墙、没有高度参考环**，我们也不要地面。
地形/落点是可选项而不是前提：雾是按世界坐标算的材质效果，有地面时"低处积雾"更直观，
没有地面时雾直接染在模型上，同样成立，而且画面更干净（去掉后模型轮廓不再被一块大圆面切掉）。

> 曾经自作主张加过后墙 + 高度参考环 + 大圆地面。前两个纯属臆造；地面则是多余的遮挡。

天穹尺寸的两条约束（都踩过）：

- **太小** → 几何戳到球外面，那部分画面没有背景（实测半径 100 时，一块 z=-12 的板就出界）。
- **太大** → 球的下半球把整个世界包在"雾面以下"，画面整体刷白（实测半径 2500 时前半屏全白）。

所以取一个中间值（当前 140）。天穹只写色不写深度（`depthWrite: false`），但
**绝不要 `depthTest: false`** —— 那会让它在最后一个 pass 把整幅画面盖掉（模型全被抹掉）。

`height` 是**世界坐标的绝对值**：调到远大于场景尺寸（比如 2000）等于把整个场景压到雾面之下，
画面只会整体变白。调参要对照模型的真实高度范围。

## 环境

- Node v24.18.0 / npm 11.16.0（无 pnpm）
- three `^0.180.0`、vite `^7.0.0`、tweakpane `^4.0.5`、preact `^10.29.8`、@preact/signals `^2.11.2`
- 受限沙箱下 esbuild 的 postinstall 与管道 stdio 会 `spawn EPERM`（对策见 `AGENTS.md`）

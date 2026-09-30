# tools/ —— 开发期脚本

这些脚本**不参与应用运行**，只在开发/自检/调试时手动或经 `npm run` 调用。
放在这里是为了让项目根目录只保留应用本体与配置。

| 脚本 | 用途 | 入口 |
| --- | --- | --- |
| `validate.mjs` | 数据管线自检（30 项断言：解析 / `_class` / 拆块 / 材质 / 炸开位移 / 连通性） | `node tools/validate.mjs` |
| `test-explode-reset.mjs` | 炸开滑块**归零复位**专项测试（直接导入真实的 `src/main.js`） | `npm run test:explode` |
| `smoke-dev.mjs` | dev 模块转换检查：抓"页面根本打不开"（React 残留、裸包名 import、依赖未预构建） | `npm run test:smoke` |
| `test-environment.mjs` | HDR 解析、环境切换、失败回退、异步竞态与资源释放（GPU 预过滤用桩） | `npm run test:environment` |
| `test-fog.mjs` | 指定示例雾的材质注入、背景球、相机球与圆形地面 | `npm run test:fog` |
| `test-shadows.mjs` | 主光阴影范围与每个 class 的投射 / 接收标记 | `npm run test:shadows` |
| `verify-hdr-presets.mjs` | 按需联网检查官方 HDR 资源 HTTP、跨域许可与实际解析 | `node tools/verify-hdr-presets.mjs` |
| `serve-dist.mjs` | 极简静态服务器，预览 `dist/`（不依赖 esbuild，可在受限环境跑） | `npm run serve` |
| `model-file.mjs` | 定位当前模型文件（**不写死文件名**，供下面两个测试共用） | — |
| `three-stub-loader.mjs` | 模块加载钩子入口（`--import` 用），供上面两个测试挂桩 | — |
| `three-stub-hooks.mjs` | 钩子实现：把 `three` 换成桩、`.css`/`.jsx`/`.json` 转成 Node 可加载的模块 | — |

一键跑全部自检：`npm run check`

> 搬动脚本时注意：它们用的是相对于**项目根**还是相对于**自身**的路径。
> 本目录下已统一为基于 `import.meta.url` 的相对路径（`../src/`、`../node_modules/`）。

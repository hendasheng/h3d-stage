/**
 * main.js —— three.js 场景 + 数据管线 + 与 UI 的接线。
 *
 * 界面不再手搓：左侧（标题 / 部件列表）用 Preact 组件，右侧控制项用 Tweakpane，
 * 共享状态在 src/ui/store.js。本文件只负责 3D、模型解析和把库的回调接到数据上。
 */

import './base.css';
import * as THREE from 'three';
import { render, h } from 'preact';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createEnvironmentLighting } from './environment.js';
import { createFog, FOG_DEFAULTS } from './fog.js';
import { FOG_PASS_SHADER, bindFogPassCamera } from './fog-pass.js';
import { getFogNoiseTexture } from './fog-texture.js';
import { createSkyDome } from './sky-dome.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { configureKeyShadow, setSelfShadows, setShadowSoftness } from './shadows.js';
import { App } from './ui/App.jsx';
import { store, setInfo, setDebug, setSelection, touch } from './ui/store.js';
import { parseGLBBuffers } from './demo-glb.js';
import { listModels, modelUrl } from './models.js';
import { weldByPosition, connectivityBySharedVertices } from './connectivity.js';
import { paletteColor } from './palette.js';
import {
  collectPartsFromScene,
  buildPartsFromVertexAttribute,
  applyColorMode,
  updateExplode,
  setWireframe,
  buildClassMaterialIndex,
  setClassGlow,
  clearGlow,
} from './parts.js';
import * as glow from './glow.js';
// 版本的唯一来源：package.json（见 src/ui/version.js），改版本只改一处
import { VERSION } from './ui/version.js';

const $ = (id) => document.getElementById(id);

const MAX_PARTS = 2000;
const GRID_SIZE = 40;       // 世界网格边长（同时作为格数 → 每格 1 单位）

let renderer, scene, camera, controls, modelRoot, centerGroup, raycaster, worldGrid;
let keyLight;
let environmentLighting;
let composer, bloomPass, gtaoPass, fogPass, fogCamera;
let fog;   // 由 createFog(scene, skyDome) 创建，见 src/fog.js
let skyDome;   // 渐变天穹（背景），见 src/sky-dome.js
const auxiliaryLights = [];
let source = null;          // parseGLBBuffers 的结果
let sourceMesh = null;      // three.js 侧的基准 Mesh
let sourceScene = null;     // 加载出来的 gltf.scene
let modelRadius = 10;
let modelFloorY = -10;
let classKey = '_class';    // 几何体上的分组属性名
let classValueCount = 0;    // 该属性有多少种取值 = 有多少个碎块
let classMaterials = new Map();   // class 编号 → 该 class 的材质列表（发光用）
// 注意：必须在使用前声明 —— signal.subscribe() 会立刻同步触发回调，
// 若声明写在后面会命中暂时性死区（TDZ）直接抛错。
let lastExplode = 0;
let lastFrameTime = 0;   // 上一帧时间戳（ms），用来算动态雾的 dt
// 模型就绪前忽略 UI 触发的重建，否则 subscribe 的立即回调会拿着空场景去拆部件
let ready = false;

/* ================================================================== */
/* 引导                                                                */
/* ================================================================== */

init();

/**
 * 引导：只做一次的事（场景 / UI / 事件接线），然后加载下拉里的首个模型。
 * 模型本身可以随时切换，见 loadModel()。
 */
async function init() {
  wireHandlers();
  initThree();
  render(h(App, {}), $('app'));
  initControlsWiring();

  const models = listModels();
  if (models.length === 0) {
    fail('src/assets/models/ 下没有 .glb 文件。放一个进去再刷新。');
    return;
  }
  store.models = models;
  await loadModel(models[0]);
}

/**
 * 加载并显示指定模型（换模型就是重新跑一遍它）。
 * 失败时把错误显示在遮罩上，不影响已加载的模型。
 * @param {string} file src/assets/models/ 下的文件名
 */
async function loadModel(file) {
  ready = false;                       // 重建期间挂起 UI 触发的重建
  $('overlay').classList.remove('done');

  let result;
  try {
    result = await fetchModel(file);
  } catch (err) {
    fail(`无法加载模型：${err.message}\n当前模型：${file}\n请确认 src/assets/models/ 下确实有这个文件。`);
    return;
  }

  const { arrayBuffer, parsed, gltf } = result;
  teardownScene();

  source = parsed;
  sourceScene = gltf.scene;

  // 只做居中，不改朝向：glTF 已是 Y-up，加载后就是站立姿态
  const box = new THREE.Box3().setFromObject(sourceScene);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  modelRadius = Math.max(size.length() * 0.5, 1);
  sourceScene.position.sub(center);
  modelFloorY = box.min.y - center.y;
  configureKeyShadow(keyLight, modelRadius);

  modelRoot = new THREE.Group();
  modelRoot.add(sourceScene);
  scene.add(modelRoot);

  const baseMeshes = [];
  sourceScene.traverse((o) => { if (o.isMesh) baseMeshes.push(o); });
  sourceMesh = baseMeshes[0] ?? null;
  if (!sourceMesh) {
    fail(`${file} 里没有任何 Mesh。`);
    return;
  }

  // 找出几何体上的分组属性（Houdini 的 class 会导出成 _class）
  classKey = null;
  for (const name of Object.keys(sourceMesh.geometry.attributes)) {
    if (name.startsWith('_')) { classKey = name; break; }
  }
  classValueCount = 0;
  if (classKey) {
    const values = new Set();
    const arr = sourceMesh.geometry.attributes[classKey].array;
    for (let i = 0; i < arr.length; i++) values.add(Number(arr[i]));
    classValueCount = values.size;
  }

  controls.target.set(0, 0, 0);
  camera.position.set(modelRadius * 1.5, modelRadius * 0.85, modelRadius * 1.7);
  controls.update();

  await buildParts();
  ready = true;   // 之后 UI 的改动才允许触发重建

  renderStats();
  renderDiagnostics();

  setInfo({
    model: file,
    summary: classKey
      ? `${classValueCount} 个碎块 · ${(source.indices.length / 3).toLocaleString()} 三角形`
      : `${source.nodeCount} 节点 · ${source.meshCount} 网格 · 未找到分组属性`,
    path: `src/assets/models/${file}`,
    debug: '',
  });
  $('modelpath') && ($('modelpath').textContent = `src/assets/models/${file}`);
  $('modelmeta') && ($('modelmeta').textContent = `${source.generator} · ${(arrayBuffer.byteLength / 1024).toFixed(0)} KB`);
  $('modelnodes') && ($('modelnodes').textContent =
    `${source.nodeCount} node / ${source.meshCount} mesh / ${source.primitiveCount} primitive / ${source.materialCount} material`);

  // 模型就绪后同步面板：class 编号的范围、以及挂载时因 parts 为空而没建起来的绑定
  store.ui?.syncParams();

  // 仅 dev：把发光接口挂到 window，供 tools/probe-glow-cdp.mjs 做真实运行时验证。
  // import.meta.env.DEV 在生产构建里是 false，整段会被摇掉，不进产物。
  if (import.meta.env?.DEV) {
    window.__h3d = {
      triggerGlow,
      releaseGlow,
      classCount: () => classMaterials.size,
      maxClassId,
      /** 调试用：改发光颜色（等价于面板上改色） */
      setGlowColor: (c) => { store.glowColor.value = c; },
      /** 调试用：改长度（秒） */
      setGlowDuration: (d) => { store.glowDuration.value = Number(d); },
      /** 读某 class 的当前发光强度（取该 class 第一个材质） */
      emissiveOf: (id) => {
        const list = classMaterials.get(Math.round(Number(id)));
        return list?.[0]?.emissiveIntensity ?? -1;
      },
      /** 读某 class 当前 emissive 的线性颜色（强度已乘进颜色里） */
      emissiveColorOf: (id) => {
        const m = classMaterials.get(Math.round(Number(id)))?.[0];
        if (!m) return null;
        return { r: m.emissive.r, g: m.emissive.g, b: m.emissive.b };
      },
      glowActive: () => store.glowActive.value.map((e) => e.id),
      /** 场景/相机/渲染器引用：供 tools 里的 CDP 探测读取真实状态 */
      scene: () => scene,
      camera: () => camera,
      renderer: () => renderer,
      composer: () => composer,
      fogPass: () => fogPass,
      /** 调试：把雾 pass 的 tDepth 直接当颜色输出（判断深度纹理有没有数据） */
      showDepth(enabled) {
        if (!fogPass) return 'no pass';
        if (!fogPass.userData.__origFrag) fogPass.userData.__origFrag = fogPass.material.fragmentShader;
        fogPass.material.fragmentShader = enabled
          ? 'uniform sampler2D tDepth;\nvarying vec2 vUv;\nvoid main(){ float d = texture2D(tDepth, vUv).x; gl_FragColor = vec4(d, d, d, 1.0); }'
          : fogPass.userData.__origFrag;
        fogPass.material.needsUpdate = true;
        return enabled ? 'depth view on' : 'depth view off';
      },
      fog,
      store,
      fogInfo: () => ({
        sceneFog: scene.fog ? { near: scene.fog.near, far: scene.fog.far, color: '#' + scene.fog.color.getHexString() } : null,
        background: scene.background?.isColor ? '#' + scene.background.getHexString() : (scene.background ? 'texture' : null),
        passAttached: !!fogPass,
        domeVisible: skyDome?.dome?.visible ?? false,
        parts: store.parts.length,
        time: fog?.time ?? 0,
      }),
    };
  }

  $('overlay').classList.add('done');
}

/** 取回并解析模型文件；不碰场景，便于在切换时先确认新模型可用 */
async function fetchModel(file) {
  const res = await fetch(modelUrl(file));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // dev server 对不存在的路径会返回 index.html（状态仍是 200），所以必须看 Content-Type，
  // 否则后面会把 HTML 当 GLB 解析，报出一句看不出真因的错。
  const type = res.headers.get('content-type') ?? '';
  if (!/octet-stream|gltf|binary|model/i.test(type)) {
    throw new Error(`服务器返回的是 ${type || '未知类型'}，不是模型文件——多半是路径写错了`);
  }
  const arrayBuffer = await res.arrayBuffer();
  const parsed = parseGLBBuffers(arrayBuffer);              // 二进制层面
  const gltf = await new GLTFLoader().parseAsync(arrayBuffer, '');  // 渲染层面
  return { arrayBuffer, parsed, gltf };
}

/** 移除并释放上一个模型占用的资源（几何体 / 材质 / 场景对象） */
function teardownScene() {
  clearParts();
  if (modelRoot) {
    scene.remove(modelRoot);
    modelRoot.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose?.();
      if (Array.isArray(o.material)) o.material.forEach((m) => m?.dispose?.());
      else o.material?.dispose?.();
    });
    modelRoot = null;
  }
  source = null;
  sourceMesh = null;
  sourceScene = null;
  classKey = null;
  classValueCount = 0;
}

function fail(msg) {
  const ov = $('overlay');
  ov.classList.remove('done');
  ov.innerHTML = `<div style="max-width:640px;color:#ef5350;white-space:pre-wrap;font-family:Consolas,monospace;font-size:12px;text-align:left">${escapeHtml(msg)}</div>`;
  setDebug('ERROR');
}

/* ================================================================== */
/* three.js 基础场景                                                    */
/* ================================================================== */

function initThree() {
  renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true;
  // PCF 支持 shadow.radius，因此可以让右侧控件实时调节阴影软硬。
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1014);
  environmentLighting = createEnvironmentLighting(renderer, scene, ({ current, status, options }) => {
    store.environment.value = current;
    store.environmentStatus.value = status;
    store.environmentOptions = options;
    store.ui?.syncParams();
  });

  camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.05, 4000);
  camera.position.set(14, 9, 16);

  // 背景 = 渐变天穹（顶 bgTop → 底雾色，与雾面无缝衔接），见 src/sky-dome.js。
  // 天穹在 createFog 之前建好 —— 雾要把 height/smoothness/颜色同步给它。
  skyDome = createSkyDome();
  scene.add(skyDome.dome);

  // 雾：由全屏后期 pass 完成（见下方 composer），这里先建管理器（背景/天穹/参数）
  fog = createFog(scene, skyDome);

  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.07;

  const hemisphere = new THREE.HemisphereLight(0xa8c4ff, 0x14171c, 1.1);
  scene.add(hemisphere);
  keyLight = new THREE.DirectionalLight(0xffffff, 1.9);
  keyLight.position.set(9, 16, 11);
  keyLight.target.position.set(0, 0, 0);
  setShadowSoftness(keyLight, store.shadowSoftness.value);
  scene.add(keyLight, keyLight.target);
  const fill = new THREE.DirectionalLight(0x88aaff, 0.7);
  fill.position.set(-11, 6, -9);
  scene.add(fill);
  auxiliaryLights.push([hemisphere, 1.1], [keyLight, 1.9], [fill, 0.7]);

  centerGroup = new THREE.Group();
  scene.add(centerGroup);

  // 世界网格：three 自带的 GridHelper，放在世界原点（0,0,0）的 XZ 平面上，
  // 挂在场景根节点（不随模型自转），作为空间参照
  worldGrid = new THREE.GridHelper(GRID_SIZE, GRID_SIZE, 0x4a5568, 0x2a323d);
  worldGrid.visible = store.showGrid.value;
  scene.add(worldGrid);

  // 环境（地面 + 渐变天穹）在相机之后、雾之前创建，见上面的说明

  raycaster = new THREE.Raycaster();

  // 标准场景后期：先在 HDR 中生成辉光，最后统一做色调映射与颜色空间转换。
  //
  // 雾走**全屏后期**（不是材质注入）：它需要场景深度来重建每个像素的世界坐标，
  // 所以 composer 的 render target 挂一张深度纹理（RenderPass 写、雾 pass 读）。
  //
  // **顺序：雾紧跟 RenderPass，在 GTAO / 辉光之前。** 这不是审美选择，是正确性：
  //   1. 刚渲染完那一刻深度一定是新鲜的 —— 与后面接多少个 pass 无关，
  //      不会出现"某个 pass 顺手把深度缓冲清掉/换掉"这类难查的问题；
  //   2. 雾是"空间里的介质"，本来就该作用在最原始的场景颜色上，
  //      再让 GTAO（接触遮蔽）与辉光去处理雾化后的画面。
  //
  // **踩过并改坏过画面的坑**：`EffectComposer` 会把我传进去的 render target 变成它的
  // renderTarget1 / renderTarget2 两个缓冲，而场景**只写进 renderTarget1 的深度**
  // （RenderPass 写的是当时的 readBuffer，第一步就是 renderTarget1）。
  // 第一版我照着 readBuffer 去绑，结果把一张**从未写过**的深度纹理交给雾：
  // 未初始化的深度每帧内容不定 → 重建出的世界坐标是垃圾 → 雾量乱跳 → **整屏爆闪**。
  const composerTarget = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
    depthBuffer: true,
    depthTexture: new THREE.DepthTexture(innerWidth, innerHeight),
  });
  composerTarget.depthTexture.format = THREE.DepthFormat;
  composerTarget.depthTexture.type = THREE.UnsignedShortType;
  composer = new EffectComposer(renderer, composerTarget);
  composer.addPass(new RenderPass(scene, camera));

  fogPass = new ShaderPass(FOG_PASS_SHADER);
  /**
   * 取"场景深度"那张纹理。
   * 用 getter 而不是固定值：`EffectComposer.setSize()`（窗口缩放）会**重建**这两个 target，
   * 旧纹理随之作废，抱着旧引用会让雾读到一张死纹理。
   */
  const sceneDepthTexture = () => {
    const rt = composer?.renderTarget1;
    if (!rt) return null;
    if (!rt.depthTexture) {
      // 理论上不会发生（我们建 target 时就挂了），但真发生了要出声，不要静默出垃圾画面
      rt.depthTexture = new THREE.DepthTexture(rt.width, rt.height);
      rt.depthTexture.format = THREE.DepthFormat;
      rt.depthTexture.type = THREE.UnsignedShortType;
      console.warn('[fog] renderTarget1 上没有深度纹理，已补一张');
    }
    return rt.depthTexture;
  };
  fogPass.uniforms.tDepth.value = sceneDepthTexture();
  // 相机矩阵必须自己传（ShaderMaterial 拿不到 three 的内建矩阵），并且每帧刷新
  fogCamera = bindFogPassCamera(fogPass, camera, sceneDepthTexture);
  composer.addPass(fogPass);

  gtaoPass = new GTAOPass(scene, camera, innerWidth, innerHeight);
  gtaoPass.blendIntensity = store.gtaoIntensity.value;
  gtaoPass.updateGtaoMaterial({ radius: store.gtaoRadius.value, thickness: 1 });
  gtaoPass.enabled = store.gtaoEnabled.value;
  composer.addPass(gtaoPass);
  bloomPass = new UnrealBloomPass(
    new THREE.Vector2(innerWidth, innerHeight),
    store.bloomStrength.value, store.bloomRadius.value, store.bloomThreshold.value,
  );
  composer.addPass(bloomPass);
  composer.addPass(new OutputPass());

  // 把 pass 交给雾管理器，并把噪声贴图与当前参数灌进去
  fog.attachPass(fogPass);
  fog.update({ noiseTexture: getFogNoiseTexture() });
  applyFogCurrent();

  window.addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    composer.setSize(innerWidth, innerHeight);
    gtaoPass.setSize(innerWidth, innerHeight);
  });
  renderer.domElement.addEventListener('pointerdown', onPointerDown);
  renderer.domElement.addEventListener('pointermove', onPointerMove);
  renderer.setAnimationLoop(tick);
}

function tick(now = 0) {
  if (store.spin.value && modelRoot) modelRoot.rotation.y += 0.0025;
  controls.update();
  // 天穹每帧跟随相机：半径远小于远裁剪面，不跟随就会"走出天空"
  skyDome?.followCamera(camera);
  // 相机一动，从深度反推世界坐标用的矩阵就得跟着更新，否则雾会错位
  fogCamera?.update();

  // 动态雾：用真实经过的时间推进流动，与帧率无关。
  // 首帧没有上一帧时间戳（now 可能是 0），跳过以免产生一个巨大的 dt。
  if (lastFrameTime && now > lastFrameTime) {
    fog?.tick(Math.min((now - lastFrameTime) / 1000, 0.1));   // 封顶 0.1s：切标签页回来不要跳一大步
  }
  lastFrameTime = now;
  let needRender = true;

  // 只要曾经炸开过就继续调用 —— 包括 factor 归零那一帧，
  // 因为"复位"是由 updateExplode 内部 factor <= 0 的分支完成的。
  if (shouldUpdateExplode(store.explode.value, lastExplode) && store.parts.length) {
    updateExplode(store.parts, store.explode.value, modelRadius);
  }
  lastExplode = store.explode.value;

  // 材质驱动：每帧按时间戳算各 class 的发光强度（与帧率无关），并写进材质
  if (glowActiveCount()) updateGlow();

  if (needRender) {
    if (store.bloomEnabled.value) composer.render();
    else renderer.render(scene, camera);
  }
}

/* ------------------------------------------------------------------ */
/* 发光：手动触发（0.3 第一步，OSC 之前）                                */
/* ------------------------------------------------------------------ */

function glowActiveCount() {
  return glow.snapshot().length;
}

/** 当前模型的最大 class 编号（模型的真实上限；无部件时为 0） */
export function maxClassId() {
  let max = 0;
  for (const id of classMaterials.keys()) if (id > max) max = id;
  return max;
}

/** 触发某 class 发光。class 编号是整数：OSC / 面板传来小数也归一成整数 */
function triggerGlow(classId) {
  const id = Math.round(Number(classId));   // class 为整数编号，杜绝 1.5 这类值
  if (!Number.isFinite(id)) return false;
  if (id < 0 || id > maxClassId()) {
    setSelection(`class 编号越界：${id}（当前模型范围 0~${maxClassId()}）`);
    return false;
  }
  if (!classMaterials.has(id)) {
    setSelection(`class ${id} 不存在（当前模型共 ${classMaterials.size} 个 class）`);
    return false;
  }
  glow.trigger(id, {
    peak: store.glowPeak.value,
    duration: store.glowDuration.value,
  });
  refreshGlowStatus();
  return true;
}

/** 释放某 class：从当前强度衰减到 0 */
function releaseGlow(classId) {
  glow.release(Number(classId), { duration: store.glowDuration.value });
  refreshGlowStatus();
}

function releaseAllGlow() {
  for (const id of glow.activeIds()) glow.release(id, { duration: store.glowDuration.value });
  refreshGlowStatus();
}

/** 立即熄灭全部（不清材质，等下一帧 updateGlow 落零） */
function clearAllGlow() {
  glow.clearAll();
  clearGlow(store.parts);
  store.glowActive.value = [];
  updateGlow();
  touch();
}

/** 按当前时间把强度写进材质；导出供 tick 调用 */
function updateGlow() {
  const now = performance.now() / 1000;
  const levels = glow.levelsAt(now);
  let changed = false;
  for (const [id, level] of levels) {
    setClassGlow(classMaterials, id, level, store.glowPeak.value, store.glowColor.value);
    changed = true;
  }
  // 熄灭的（已从 levels 里移除）：把强度归零
  const next = [...levels.keys()].sort((a, b) => a - b);
  const prev = store.glowActive.value.map((e) => Number(e.id));
  for (const id of prev) if (!levels.has(id)) { setClassGlow(classMaterials, id, 0, store.glowPeak.value, store.glowColor.value); changed = true; }

  if (changed || next.length !== prev.length) {
    store.glowActive.value = next.map((id) => ({ id, level: levels.get(id) }));
    refreshGlowStatus();
    touch();
  }
}

/** 把活跃清单写进标题区（用于肉眼确认哪些 class 正在发光） */
function refreshGlowStatus() {
  const list = store.glowActive.value;
  if (!list.length) { setSelection(store.selected.value >= 0 ? store.info.value.selection : ''); return; }
  setSelection('发光中：' + list.map((e) => `class ${e.id}(${(e.level ?? 1).toFixed(2)})`).join('  '));
}

/**
 * 是否需要在这一帧更新炸开位置。
 * 关键：factor 从 >0 变成 0 的那一帧也必须返回 true。
 */
export function shouldUpdateExplode(explode, prevExplode) {
  return explode > 0 || prevExplode > 0;
}

/* ================================================================== */
/* 把界面事件接到数据上（库 → 数据 的唯一入口）                           */
/* ================================================================== */

function wireHandlers() {
  store.handlers.selectEnvironment = (id) => environmentLighting.select(id);
  store.handlers.select = (index) => select(index);
  // 发光测试窗口（0.3 第一步；接 OSC 后由信号直接调 triggerGlow/releaseGlow）
  store.handlers.triggerGlow = (classId) => triggerGlow(classId);
  store.handlers.releaseGlow = (classId) => releaseGlow(classId);
  store.handlers.releaseAllGlow = () => releaseAllGlow();
  store.handlers.clearGlow = () => clearAllGlow();
  store.handlers.visibility = (index, visible) => {
    const p = store.parts[index];
    if (p) { p.visible = visible; p.object.visible = visible; }
  };
}

/** 按当前设置给所有部件上色（基础材质中性色 / class 分色） */
function applyColors() {
  applyColorMode(store.parts, store.classColors.value, paletteColor, store.baseColor.value);
}

function initControlsWiring() {
  store.bloomStrength.subscribe((value) => { bloomPass.strength = value; });
  store.bloomRadius.subscribe((value) => { bloomPass.radius = value; });
  store.bloomThreshold.subscribe((value) => { bloomPass.threshold = value; });
  store.environmentIntensity.subscribe((value) => { scene.environmentIntensity = value; });
  store.lightIntensity.subscribe((value) => {
    for (const [light, base] of auxiliaryLights) light.intensity = base * value;
  });
  store.shadowSoftness.subscribe((value) => { setShadowSoftness(keyLight, value); });
  store.gtaoEnabled.subscribe((value) => { gtaoPass.enabled = value; });
  store.gtaoIntensity.subscribe((value) => { gtaoPass.blendIntensity = value; });
  store.gtaoRadius.subscribe((value) => { gtaoPass.updateGtaoMaterial({ radius: value }); });
  // 雾：设置变了就整体重新应用（背景与雾分开，见 src/fog.js）
  const applyFog = () => applyFogCurrent();
  for (const sig of [store.fogEnabled, store.fogColor, store.fogBgMode,
    store.fogBgColor, store.fogBgTop, store.fogBgBottom,
    store.fogHeight, store.fogSmoothness, store.fogDepth, store.fogDepthSmoothness,
    store.fogDynamic, store.fogNoiseStrength, store.fogNoiseScale,
    store.fogFlowX, store.fogFlowY, store.fogWarp]) {
    sig.subscribe(applyFog);
  }
  // subscribe 的回调会立即同步执行一次；模型没加载完之前不要真的重建
  store.model.subscribe((file) => {
    if (file && file !== store.info.value.model) void loadModel(file);
  });
  store.explode.subscribe(() => {
    if (store.ui) store.ui.syncParams();
  });
  store.classColors.subscribe(() => {
    if (ready) { applyColors(); touch(); }
    if (store.ui) store.ui.syncParams();
  });
  store.baseColor.subscribe(() => {
    if (ready && !store.classColors.value) { applyColors(); touch(); }
    if (store.ui) store.ui.syncParams();
  });
  store.wireframe.subscribe((on) => {
    if (ready) setWireframe(store.parts, on);
    if (store.ui) store.ui.syncParams();
  });
  store.showGrid.subscribe((on) => {
    if (worldGrid) worldGrid.visible = on;
    if (store.ui) store.ui.syncParams();
  });
}

/* ================================================================== */
/* 部件：构建 / 选择 / 高亮                                             */
/* ================================================================== */

function clearParts() {
  for (const p of store.parts) {
    p.object.parent?.remove(p.object);
    if (p.source !== 'node') {
      p.geometry.dispose?.();
      p.object.material?.dispose?.();
    }
  }
  store.parts = [];
  store.selected.value = -1;
  centerGroup.clear();
}

/** 按顶点分组属性（Houdini 的 class）把当前模型拆成部件 */
async function buildParts() {
  store.explode.value = 0;
  lastExplode = 0;
  clearParts();

  if (classKey) {
    store.parts = buildPartsFromVertexAttribute(sourceMesh, classKey, MAX_PARTS).parts;
  } else {
    // 没有分组属性时退回"整个网格就是一个部件"
    store.parts = collectPartsFromScene(sourceScene).parts;
  }

  // 静止位置只在这里写一次；updateExplode 只读不写（否则每帧累加会漂移）
  for (let i = 0; i < store.parts.length; i++) {
    const p = store.parts[i];
    p.object.userData.basePosition = p.object.position.clone();
    p.object.userData.partIndex = i;
  }

  // 部件都是按原始几何单独生成的，所以原始网格始终隐藏
  sourceScene.visible = false;
  sourceScene.rotation.set(0, 0, 0);
  setSelfShadows(store.parts);
  for (const p of store.parts) centerGroup.add(p.object);

  applyColors();
  setWireframe(store.parts, store.wireframe.value);
  applyFogCurrent();
  classMaterials = buildClassMaterialIndex(store.parts);   // class → 材质，发光时按编号直取
  glow.clearAll();
  store.glowActive.value = [];
  touch();
  updateDebug();
}

/**
 * 用当前 store 里的设置应用一次雾。
 *
 * 注意这里**不再需要传部件列表**：雾是全屏后期 pass，与模型材质无关，
 * 所以"换了模型要重新注入"这件事不存在了 —— 换模型不影响雾。（0.4 的材质注入才需要。）
 */
function applyFogCurrent() {
  fog?.update({
    enabled: store.fogEnabled.value,
    color: store.fogColor.value,
    bgMode: store.fogBgMode.value,
    bgColor: store.fogBgColor.value,
    bgTop: store.fogBgTop.value,
    bgBottom: store.fogBgBottom.value,
    height: store.fogHeight.value,
    smoothness: store.fogSmoothness.value,
    depth: store.fogDepth.value,
    depthSmoothness: store.fogDepthSmoothness.value,
    // 动态雾（0.5）
    dynamic: store.fogDynamic.value,
    noiseStrength: store.fogNoiseStrength.value,
    noiseScale: store.fogNoiseScale.value,
    flowX: store.fogFlowX.value,
    flowY: store.fogFlowY.value,
    warp: store.fogWarp.value,
  });
}

/**
 * 选中一个部件：记录索引 + 在标题区显示它的信息。
 * 注意：**不再用 emissive 做选中高亮** —— 材质驱动（0.3）之后 emissive 专用于 class 发光，
 * 两处都写会互相覆盖。选中态在列表里体现，3D 里靠发光/分色区分。
 */
function select(index) {
  store.selected.value = index;

  if (index < 0 || !store.parts[index]) {
    setSelection('');
    touch();
    return;
  }

  const p = store.parts[index];
  const classId = p.object.userData.classId;
  const colorHex = store.classColors.value ? '#' + p.material.color.getHexString() : null;
  const glowing = classId !== undefined && store.glowActive.value.some((e) => Number(e.id) === Number(classId));
  setSelection(
    `选中 ${p.name} · ${p.triangleCount}△` +
    (classId !== undefined ? ` · class=${classId}` : '') +
    (colorHex ? ` · ${colorHex}` : '') +
    (glowing ? ' · 发光中' : '')
  );
  touch();
}

function pickPart(ev) {
  if (!store.parts.length) return -1;
  const rect = renderer.domElement.getBoundingClientRect();
  const ndc = new THREE.Vector2(
    ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    -((ev.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(ndc, camera);
  const targets = store.parts.filter((p) => p.visible).map((p) => p.object);
  const hits = raycaster.intersectObjects(targets, false);
  return hits.length ? (hits[0].object.userData.partIndex ?? -1) : -1;
}

let lastMove = 0;
function onPointerMove(ev) {
  const now = performance.now();
  if (now - lastMove < 60) return;
  lastMove = now;
  void ev;
}

function onPointerDown(ev) {
  const i = pickPart(ev);
  if (i >= 0) select(i);
}

/* ================================================================== */
/* 右侧面板里的「模型 / 数据 / 诊断」文本块（由本文件写 DOM）              */
/* ================================================================== */

function updateDebug(msg) {
  const tris = store.parts.reduce((s, p) => s + p.triangleCount, 0);
  setDebug(`parts=${store.parts.length}  tris=${tris}` +
    `  ${classKey ?? 'no-class'}=${classKey ? classValueCount : '-'}${msg ? '  ' + msg : ''}`);
}

function renderStats() {
  const host = $('statsBody');
  if (!host || !source) return;
  const tris = store.parts.reduce((s, p) => s + p.triangleCount, 0);
  const verts = store.parts.reduce((s, p) => s + p.vertexCount, 0);
  const rows = [
    ['模型文件', store.info.value.model || '—'],
    ['部件数量 (可 for 循环)', store.parts.length],
    ['三角形总数', tris],
    ['顶点总数', verts],
    ['primitive / material', `${source.primitiveCount} / ${source.materialCount}`],
    ['属性通道', source.attributeKeys.join(', ')],
    ['分组属性', classKey ? `${classKey}（${classValueCount} 组）` : '无'],
    ['three.js 属性', Object.keys(sourceMesh.geometry.attributes).join(', ')],
  ];
  host.innerHTML = rows
    .map(([k, v]) => `<div class="stat"><span class="k">${escapeHtml(k)}</span><span class="v">${escapeHtml(String(v))}</span></div>`)
    .join('');
}

function renderDiagnostics() {
  const host = $('diagBody');
  if (!host || !source) return;

  const positions = source.positions;
  const indices = source.indices;
  const triCount = indices.length / 3;

  const { count: weldedCount } = weldByPosition(positions);
  const conn = connectivityBySharedVertices(indices, positions.length / 3);
  const perGroup = new Map();
  for (let t = 0; t < triCount; t++) perGroup.set(conn.triGroup[t], (perGroup.get(conn.triGroup[t]) ?? 0) + 1);
  const connSizes = [...perGroup.values()].sort((a, b) => b - a);

  const multiNode = source.nodeCount > 1 && source.meshCount > 1;
  const hasGroups = (sourceMesh?.geometry.groups?.length ?? 0) > 0;
  const hasClass = !!classKey;

  let classTriStat = '';
  if (hasClass) {
    const arr = sourceMesh.geometry.attributes[classKey].array;
    const perValue = new Map();
    for (let t = 0; t < triCount; t++) {
      const v = Number(arr[indices[t * 3]]);
      perValue.set(v, (perValue.get(v) ?? 0) + 1);
    }
    const ts = [...perValue.values()].sort((a, b) => b - a);
    classTriStat = `最大一块 ${ts[0]} 个三角形，中位 ${ts[Math.floor(ts.length / 2)]} 个。`;
  }

  const items = [
    hasClass
      ? { level: 'ok', text: `几何体带分组属性 <b>${classKey}</b>（${classValueCount} 种取值）—— 分组信息就在数据里，直接读属性即可逐个拆块。${classTriStat}` }
      : { level: 'bad', text: `几何体上没有分组属性（Houdini 的 <code>class</code> / <code>name</code> 没导出），无法直接按碎块拆。` },
    {
      level: multiNode ? 'ok' : 'warn',
      text: multiNode
        ? `文件有 ${source.nodeCount} 个 node、${source.meshCount} 个 mesh —— 每个 Mesh 也是一个部件。`
        : `文件只有 ${source.nodeCount} 个 node、${source.meshCount} 个 mesh —— 碎块在场景图层面是合并的。`,
    },
    {
      level: hasGroups ? 'ok' : 'warn',
      text: hasGroups
        ? `几何体带 ${sourceMesh.geometry.groups.length} 个 material group。`
        : `几何体没有 material group（1 个 primitive、无材质），靠 group 分块走不通。`,
    },
    {
      level: weldedCount === positions.length / 3 ? 'warn' : 'ok',
      text: `原始顶点 ${positions.length / 3} 个，位置去重后 ${weldedCount} 个 —— ${
        weldedCount === positions.length / 3 ? '每个面都是独立顶点（未焊接）' : `有 ${positions.length / 3 - weldedCount} 个顶点共用`}。`,
    },
    {
      level: connSizes[0] < triCount / 250 ? 'info' : 'warn',
      text: `按拓扑连通性划分得到 ${connSizes.length} 个连通体，最大一块 ${connSizes[0]} 个三角形${hasClass ? '（有 class 属性时无需依赖它）' : ''}。`,
    },
  ];

  const advice = hasClass
    ? `<p class="hint">推荐用法：<code>geometry.attributes.${classKey}</code> 就是碎块编号，按它分桶逐个建 Mesh —— 见 <code>buildPartsFromVertexAttribute()</code>。这个属性来自 Houdini 的 <code>class</code>，导成 glTF 自定义通道时名字前会加下划线。</p>`
    : `<p class="hint">想让 three.js 逐个读取碎块，最直接的是改导出：给碎块加 <code>class</code> 或 <code>name</code> 属性并导出。</p>`;

  host.innerHTML =
    `<ul class="diag">${items.map((it) => `<li><span class="dot ${it.level}"></span><span>${it.text}</span></li>`).join('')}</ul>` + advice;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

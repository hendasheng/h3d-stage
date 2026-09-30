/**
 * test-fog.mjs —— 雾模块（src/fog.js）的行为测试。
 *
 * 0.5 起雾**不再**是材质注入，而是**全屏后期 pass**（`src/fog-pass.js`）：
 * 材质注入按定义只改实体表面，做不出"空间里有雾"。所以这里测的是
 * 「背景三态 + 天穹同步 + 参数是否写进 pass 的 uniforms + 时间推进」，
 * 着色器本身的行为由 `tools/probe-fog-pixels.mjs` 用真实 WebGL 回读像素验证。
 *
 * 运行：node tools/test-fog.mjs
 */
import * as THREE from 'three';
import { createFog, FOG_DEFAULTS, BACKGROUND_MODES } from '../src/fog.js';

// 渐变背景要 canvas：Node 里没有 DOM，补一个最小桩（只够 createLinearGradient / fillRect）。
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({
        createLinearGradient: () => ({ addColorStop() {} }),
        fillRect() {},
        set fillStyle(_v) {},
      }),
    }),
  };
}

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [OK]  ' : '  [FAIL]'} ${label}${extra ? ' -> ' + extra : ''}`);
};
const hex = (color) => color.getHexString().slice(0, 6);

/** 假 pass：只记录 uniforms 被写成了什么（形状与 three 的 ShaderPass 一致） */
function makeFakePass() {
  return {
    uniforms: {
      tDiffuse: { value: null },
      tDepth: { value: null },
      cameraNear: { value: 0.1 },
      cameraFar: { value: 1000 },
      uInvProjection: { value: new THREE.Matrix4() },
      uCameraWorld: { value: new THREE.Matrix4() },
      uFogColor: { value: new THREE.Color(0xffffff) },
      fogPositionY: { value: 0 },
      fogSmoothness: { value: 0 },
      fogDepth: { value: 0 },
      fogDepthSmoothness: { value: 0 },
      uFogEnabled: { value: 0 },
      uFogNoise: { value: null },
      fogNoiseScale: { value: 0 },
      fogNoiseStrength: { value: 0 },
      uFogTime: { value: 0 },
      uFogDynamic: { value: 0 },
      fogFlow: { value: new THREE.Vector2() },
      fogFlowZ: { value: 0 },
      fogWarp: { value: 0 },
    },
  };
}

const scene = new THREE.Scene();
const pass = makeFakePass();
const fog = createFog(scene, null, pass);

console.log('\n=== 1. 创建 ===');
ok('不再挂内置雾（内置雾染不到背景，做不到全局）', scene.fog === null, String(scene.fog));
ok('默认不设 scene.background（背景交给天穹）', scene.background === null, String(scene.background));
ok('三种背景模式可选（天穹 / 纯色 / 渐变）', BACKGROUND_MODES.length === 3, BACKGROUND_MODES.map((m) => m.value).join(','));
ok('高度项与深度项的参数齐备',
  ['height', 'smoothness', 'depth', 'depthSmoothness'].every((k) => typeof FOG_DEFAULTS[k] === 'number'),
  ['height', 'smoothness', 'depth', 'depthSmoothness'].map((k) => `${k}=${FOG_DEFAULTS[k]}`).join(' '));
ok('动态雾参数齐备',
  typeof FOG_DEFAULTS.dynamic === 'boolean'
  && ['noiseStrength', 'noiseScale', 'flowX', 'flowY', 'flowZ', 'warp'].every((k) => typeof FOG_DEFAULTS[k] === 'number'),
  ['noiseStrength', 'noiseScale', 'flowX', 'flowY', 'flowZ', 'warp'].map((k) => `${k}=${FOG_DEFAULTS[k]}`).join(' '));

console.log('\n=== 2. 参数写进 pass 的 uniforms ===');
fog.update({ enabled: true, height: -7.5, smoothness: 3, depth: 90, depthSmoothness: 12, color: '#ff0000' });
ok('fogPositionY 写对了', pass.uniforms.fogPositionY.value === -7.5, String(pass.uniforms.fogPositionY.value));
ok('fogSmoothness 写对了', pass.uniforms.fogSmoothness.value === 3, String(pass.uniforms.fogSmoothness.value));
ok('fogDepth 写对了', pass.uniforms.fogDepth.value === 90, String(pass.uniforms.fogDepth.value));
ok('fogDepthSmoothness 写对了', pass.uniforms.fogDepthSmoothness.value === 12, String(pass.uniforms.fogDepthSmoothness.value));
ok('uFogColor 写对了', hex(pass.uniforms.uFogColor.value) === 'ff0000', hex(pass.uniforms.uFogColor.value));
ok('uFogEnabled = 1', pass.uniforms.uFogEnabled.value === 1, String(pass.uniforms.uFogEnabled.value));
ok('动态参数一并写入（强度 / 疏密 / 流动 / warp）',
  pass.uniforms.fogNoiseStrength.value === FOG_DEFAULTS.noiseStrength
  && pass.uniforms.fogNoiseScale.value === FOG_DEFAULTS.noiseScale
  && pass.uniforms.uFogDynamic.value === (FOG_DEFAULTS.dynamic ? 1 : 0)
  && pass.uniforms.fogFlow.value.x === FOG_DEFAULTS.flowX
  && pass.uniforms.fogFlowZ.value === FOG_DEFAULTS.flowZ
  && pass.uniforms.fogWarp.value === FOG_DEFAULTS.warp,
  `str=${pass.uniforms.fogNoiseStrength.value} scl=${pass.uniforms.fogNoiseScale.value} flowZ=${pass.uniforms.fogFlowZ.value}`);
fog.update({ enabled: false });
ok('关雾时 uFogEnabled = 0', pass.uniforms.uFogEnabled.value === 0, String(pass.uniforms.uFogEnabled.value));

console.log('\n=== 3. 多次 update 不重复、可覆盖 ===');
fog.update({ height: -3 });
ok('第二次 update 只改这一项，其余保持', pass.uniforms.fogPositionY.value === -3
  && pass.uniforms.fogSmoothness.value === 3 && pass.uniforms.fogDepth.value === 90,
  `Y=${pass.uniforms.fogPositionY.value} smooth=${pass.uniforms.fogSmoothness.value} depth=${pass.uniforms.fogDepth.value}`);
ok('settings 快照能读回来', fog.settings.height === -3 && fog.settings.depth === 90,
  JSON.stringify({ height: fog.settings.height, depth: fog.settings.depth }));
// 后期 pass 每帧重读 uniform，所以**不需要** 0.4 那套"改 cacheKey 强制重编译"的把戏
ok('没有留下材质注入的痕迹（不再有 attach / detach）',
  typeof fog.attach === 'undefined' && typeof fog.detach === 'undefined');

console.log('\n=== 4. 背景三态与雾色的关系 ===');
fog.update({ bgMode: 'flat', bgColor: '#000000', color: '#ffffff' });
ok('纯色背景 = bgColor', hex(scene.background) === '000000', hex(scene.background));
fog.update({ color: '#00ff00', bgMode: 'flat', bgColor: '#000000' });
ok('改雾色不影响纯色背景', hex(scene.background) === '000000' && hex(pass.uniforms.uFogColor.value) === '00ff00',
  `bg=${hex(scene.background)} fog=${hex(pass.uniforms.uFogColor.value)}`);
fog.update({ bgMode: 'gradient', bgTop: '#000000', bgBottom: '#2a3038' });
ok('渐变背景是贴图而不是 Color', scene.background?.isColor !== true && scene.background != null,
  scene.background?.constructor?.name);
fog.update({ bgMode: 'dome' });
ok('天穹态下 scene.background 为空（否则会把天穹盖住）', scene.background === null, String(scene.background));

console.log('\n=== 5. 天穹同步（背景与雾必须同一分界）===');
{
  const calls = [];
  const domeStub = {
    setVisible: (v) => calls.push(['visible', v]),
    sync: (o) => calls.push(['sync', o.position, o.smoothness, o.color, o.top]),
  };
  const scene2 = new THREE.Scene();
  const fog2 = createFog(scene2, domeStub);
  fog2.update({ bgMode: 'dome', color: '#ff8800', height: -5, smoothness: 3, bgTop: '#101010' });
  const sync = calls.find((c) => c[0] === 'sync');
  ok('天穹拿到与雾相同的 height / smoothness', sync?.[1] === -5 && sync?.[2] === 3, JSON.stringify(sync));
  ok('天穹底部 = 雾色、顶部 = bgTop', sync?.[3] === '#ff8800' && sync?.[4] === '#101010',
    `${sync?.[3]} / ${sync?.[4]}`);
  calls.length = 0;
  fog2.update({ bgMode: 'flat', bgColor: '#000000' });
  ok('切到纯色背景时天穹隐藏', calls.some((c) => c[0] === 'visible' && c[1] === false), JSON.stringify(calls));
  calls.length = 0;
  fog2.update({ bgMode: 'dome' });
  ok('切回天穹时天穹显示', calls.some((c) => c[0] === 'visible' && c[1] === true), JSON.stringify(calls));

  // 没有 pass 时不能崩（Node 里常常没有后期链）
  ok('没有 pass 时 update 不报错', (() => {
    try { fog2.update({ height: 1 }); return true; } catch { return false; }
  })());
  fog2.dispose();
}

console.log('\n=== 6. tick：推进流动时间并写进 uniform ===');
{
  fog.update({ dynamic: true });
  fog.resetTime();
  ok('resetTime 归零', fog.time === 0 && pass.uniforms.uFogTime.value === 0, String(fog.time));
  fog.tick(0.5);
  fog.tick(0.5);
  ok('tick 累加时间', Math.abs(fog.time - 1) < 1e-9, String(fog.time));
  ok('tick 把时间写进 uniform', pass.uniforms.uFogTime.value === fog.time,
    `uniform=${pass.uniforms.uFogTime.value} getter=${fog.time}`);
  fog.tick(-1);
  fog.tick(NaN);
  fog.tick(0);
  ok('非法 dt 被忽略（负数 / NaN / 0）', Math.abs(fog.time - 1) < 1e-9, String(fog.time));
  for (let i = 0; i < 5000; i++) fog.tick(1);
  ok('长时间推进不会溢出或掉精度', fog.time >= 0 && fog.time < 3600, String(fog.time));
  fog.resetTime();
}

console.log('\n=== 7. attachPass：pass 后到也能接上 ===');
{
  const scene3 = new THREE.Scene();
  const late = makeFakePass();
  const fog3 = createFog(scene3, null);          // 先不给 pass
  fog3.update({ height: -9, depth: 33 });
  ok('没有 pass 时只记设置', fog3.settings.height === -9, String(fog3.settings.height));
  fog3.attachPass(late);
  ok('attachPass 后立刻把当前设置灌进去', late.uniforms.fogPositionY.value === -9
    && late.uniforms.fogDepth.value === 33,
    `Y=${late.uniforms.fogPositionY.value} depth=${late.uniforms.fogDepth.value}`);
  fog3.dispose();
}

console.log('\n=== 8. dispose ===');
fog.dispose();
ok('背景渐变资源已释放', fog.gradientTexture === null || fog.gradientTexture === undefined);

console.log(`\n${failures ? `存在 ${failures} 个失败项` : '雾模块测试通过（背景三态 / 天穹同步 / pass 参数 / tick / attachPass）'}\n`);
process.exitCode = failures ? 1 : 0;

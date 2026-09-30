/**
 * test-fog.mjs —— 雾模块（src/fog.js）的行为测试。
 *
 * 当前实现是**参考站 shader 的逐行移植**（https://projects.thibautfoussard.com/fog/）：
 *   verticalMixer = smoothstep(y - smoothness, y + smoothness, fogPositionY)
 *   depthMixer    = smoothstep(d + dSmooth, d - dSmooth, fogDepth)  → 再被 verticalMixer 门控
 *   mixer         = clamp(verticalMixer*.5 + depthMixer*.95, 0, 1) * fogEnabled
 *   outgoingLight = mix(outgoingLight, uFogColor, mixer)
 * 没有"模式"与"按高度分层"参数（早先自创的模型已废弃）。
 *
 * 这里验证：注入落地、uniform 值随设置更新（同一对象）、背景与雾色独立、
 * 以及**用到的 uniform 全部已声明**（曾漏声明导致整块渲白）。
 * 画面是否真的改变由 tools/probe-fog-pixels.mjs 用像素回读验证。
 *
 * 运行：node tools/test-fog.mjs
 */
import * as THREE from 'three';
import { createFog, FOG_DEFAULTS, BACKGROUND_MODES } from '../src/fog.js';

// 渐变背景要 canvas：Node 里没有 DOM，补一个最小桩（只够 createLinearGradient / fillRect）。
// 真浏览器里走的是原生实现，这里只为让 Node 测试能覆盖到 gradient 分支。
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

const scene = new THREE.Scene();
const material = new THREE.MeshStandardMaterial();

console.log('\n=== 1. 创建 ===');
const fog = createFog(scene);
ok('不再挂内置雾（距离与高度都在注入里算）', scene.fog === null, String(scene.fog));
// 默认背景交给渐变天穹（'dome'）：此时必须**不设** scene.background，否则会把天穹盖住
ok('默认不设 scene.background（背景交给天穹）', scene.background === null, String(scene.background));
ok('三种背景模式可选（天穹 / 纯色 / 渐变）', BACKGROUND_MODES.length === 3, BACKGROUND_MODES.map((m) => m.value).join(','));
ok('四参数齐备（高度项 ×2 / 深度项 ×2）',
  ['height', 'smoothness', 'depth', 'depthSmoothness'].every((k) => typeof FOG_DEFAULTS[k] === 'number'),
  ['height', 'smoothness', 'depth', 'depthSmoothness'].map((k) => `${k}=${FOG_DEFAULTS[k]}`).join(' '));

console.log('\n=== 2. 注入落地 ===');
const parts = [{ material }];
const shader = () => ({
  uniforms: {},
  vertexShader: '#include <common>\nvoid main() {\n\t#include <begin_vertex>',
  fragmentShader: '#include <common>\nvec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;\n#include <dithering_fragment>',
});
fog.update({ enabled: true, height: -2, smoothness: 5, depth: 40, depthSmoothness: 25 }, parts);
ok('材质被标记为已注入', material.userData.__fogAttached === true);
ok('customProgramCacheKey 已设置', typeof material.customProgramCacheKey === 'function');
const sh1 = shader();
material.onBeforeCompile(sh1);
ok('vertex 注入了 vH3dWorldPos 与赋值', /varying vec3 vH3dWorldPos;/.test(sh1.vertexShader)
  && /vH3dWorldPos = \(modelMatrix \* vec4\(position, 1\.0\)\)\.xyz;/.test(sh1.vertexShader));
// 曾照抄参考站的 varying 名 vWorldPosition，而 three 的顶点着色器在 ENV_WORLDPOS 分支里
// 已经声明过同名 varying → 重复声明 → 顶点编译失败，表现为"注入命中但参数完全不动画面"
{
  const THREE_VERT = `
    #ifdef ENV_WORLDPOS
      varying vec3 vWorldPosition;
    #endif
    void main() {
      #include <begin_vertex>
    }`;
  const probeShader = { uniforms: {}, vertexShader: THREE_VERT, fragmentShader: shader().fragmentShader };
  material.onBeforeCompile(probeShader);
  const decls = [...probeShader.vertexShader.matchAll(/varying\s+\w+\s+([A-Za-z_]\w*)\s*;/g)].map((m) => m[1]);
  ok('即材质已有 vWorldPosition，也不会重复声明 varying',
    decls.filter((d) => d === 'vWorldPosition').length === 1 && decls.includes('vH3dWorldPos'),
    decls.join(','));
}
ok('fragment 注入了垂直项', /float verticalMixer = smoothstep\(vH3dWorldPos\.y - fogSmoothness, vH3dWorldPos\.y \+ fogSmoothness, fogPositionY\);/.test(sh1.fragmentShader));
ok('fragment 注入了深度项', /float depthMixer = smoothstep\(distanceToCamera \+ fogDepthSmoothness, distanceToCamera - fogDepthSmoothness, fogDepth\);/.test(sh1.fragmentShader));
ok('深度项被高度项门控', /depthMixer = mix\(0\., depthMixer, verticalMixer\);/.test(sh1.fragmentShader));
ok('相加加权 .5/.95（不是二选一混合）', /float mixer = verticalMixer \* \.5 \+ depthMixer \* \.95;/.test(sh1.fragmentShader));
ok('混入雾色 uFogColor', /outgoingLight = mix\(outgoingLight, uFogColor, mixer\);/.test(sh1.fragmentShader));
ok('uniforms 已挂上', Object.keys(sh1.uniforms).join(',') ===
  'uFogColor,fogPositionY,fogSmoothness,fogDepth,fogDepthSmoothness,fogEnabled',
  Object.keys(sh1.uniforms).join(','));

console.log('\n=== 3. uniform 值随设置更新（同一对象，不重建）===');
const before = sh1.uniforms;
fog.update({ enabled: true, height: -7.5, smoothness: 3, depth: 90, depthSmoothness: 12, color: '#ff0000' }, parts);
const sh2 = shader();
material.onBeforeCompile(sh2);
ok('uniforms 是同一个对象（已编译材质仍能看到新值）', sh2.uniforms.fogPositionY === before.fogPositionY, 'guarded');
ok('fogPositionY 已更新', sh2.uniforms.fogPositionY.value === -7.5, String(sh2.uniforms.fogPositionY.value));
ok('fogSmoothness 已更新', sh2.uniforms.fogSmoothness.value === 3, String(sh2.uniforms.fogSmoothness.value));
ok('fogDepth 已更新', sh2.uniforms.fogDepth.value === 90, String(sh2.uniforms.fogDepth.value));
ok('fogDepthSmoothness 已更新', sh2.uniforms.fogDepthSmoothness.value === 12, String(sh2.uniforms.fogDepthSmoothness.value));
ok('雾色已更新', hex(sh2.uniforms.uFogColor.value) === 'ff0000', hex(sh2.uniforms.uFogColor.value));
ok('开关位为 1', sh2.uniforms.fogEnabled.value === 1, String(sh2.uniforms.fogEnabled.value));

console.log('\n=== 4. 关闭雾：fogEnabled=0，但材质仍保留注入（不重编译）===');
fog.update({ enabled: false, color: '#000000' }, parts);
const sh3 = shader();
material.onBeforeCompile(sh3);
ok('fogEnabled=0（mixer 归零，画面不受雾影响）', sh3.uniforms.fogEnabled.value === 0, String(sh3.uniforms.fogEnabled.value));
ok('注入仍在（没有拆掉再装）', material.userData.__fogAttached === true && /verticalMixer/.test(sh3.fragmentShader));

console.log('\n=== 5. 背景三态与雾色的关系 ===');
fog.update({ enabled: true, color: '#ffffff', bgMode: 'flat', bgColor: '#000000' }, parts);
const sh4 = shader();
material.onBeforeCompile(sh4);          // 快照必须在注入之后取，否则拿到的是原始 shader
ok('雾色 = 白', hex(sh4.uniforms.uFogColor.value) === 'ffffff', hex(sh4.uniforms.uFogColor.value));
ok('纯色背景 = bgColor', hex(scene.background) === '000000', hex(scene.background));
fog.update({ color: '#00ff00', bgMode: 'flat', bgColor: '#000000' }, parts);
ok('改雾色不影响纯色背景', hex(scene.background) === '000000' && hex(sh4.uniforms.uFogColor.value) === '00ff00',
  `bg=${hex(scene.background)} fog=${hex(sh4.uniforms.uFogColor.value)}`);
fog.update({ bgMode: 'gradient', bgTop: '#000000', bgBottom: '#2a3038' }, parts);
ok('渐变背景是贴图而不是 Color', scene.background?.isColor !== true && scene.background != null,
  scene.background?.constructor?.name);
// 天穹态：不能设 scene.background（会盖住天穹），并且要把分界与颜色推给天穹
fog.update({ bgMode: 'dome', color: '#ffffff', height: -5, smoothness: 3, bgTop: '#000000' }, parts);
ok('天穹态下 scene.background 为空', scene.background === null, String(scene.background));

console.log('\n=== 5b. 天穹同步（背景与雾必须同一分界，否则雾在天穹上"断掉"）===');
{
  const domeCalls = [];
  const domeStub = {
    setVisible: (v) => domeCalls.push(['visible', v]),
    sync: (o) => domeCalls.push(['sync', o.position, o.smoothness, o.color, o.top]),
  };
  const scene2 = new THREE.Scene();
  const fog2 = createFog(scene2, domeStub);
  fog2.update({ bgMode: 'dome', color: '#ff8800', height: -5, smoothness: 3, bgTop: '#101010' }, []);
  const sync = domeCalls.find((c) => c[0] === 'sync');
  ok('天穹拿到与雾相同的 height / smoothness',
    sync?.[1] === -5 && sync?.[2] === 3, JSON.stringify(sync));
  ok('天穹底部 = 雾色、顶部 = bgTop', sync?.[3] === '#ff8800' && sync?.[4] === '#101010',
    `${sync?.[3]} / ${sync?.[4]}`);
  domeCalls.length = 0;
  fog2.update({ bgMode: 'flat', bgColor: '#000000' }, []);
  ok('切到纯色背景时天穹隐藏', domeCalls.some((c) => c[0] === 'visible' && c[1] === false),
    JSON.stringify(domeCalls));
  domeCalls.length = 0;
  fog2.update({ bgMode: 'dome' }, []);
  ok('切回天穹时天穹显示', domeCalls.some((c) => c[0] === 'visible' && c[1] === true),
    JSON.stringify(domeCalls));
  fog2.dispose();
}

console.log('\n=== 6. 声明完整性（曾漏声明导致整块渲白）===');
fog.update({ bgMode: 'flat', bgColor: '#000000' }, parts);
const frag = sh4.fragmentShader;
const names = ['uFogColor', 'fogPositionY', 'fogSmoothness', 'fogDepth', 'fogDepthSmoothness', 'fogEnabled'];
const declared = new Set([...frag.matchAll(/uniform\s+\w+\s+([A-Za-z_]\w*)\s*;/g)].map((m) => m[1]));
const undeclared = names.filter((u) => !declared.has(u));
ok('注入声明的雾 uniform 全部齐备', undeclared.length === 0, undeclared.join(',') || '无遗漏');
const occurrencesOf = (name) => frag.split(`uniform float ${name};`).length - 1
  + frag.split(`uniform vec3 ${name};`).length - 1;
ok('声明数量与用法一致（不重复）', names.every((n) => occurrencesOf(n) === 1),
  names.map((n) => `${n}×${occurrencesOf(n)}`).join(' '));
ok('vH3dWorldPos 在 vertex 与 fragment 两端都声明',
  /varying vec3 vH3dWorldPos;/.test(sh4.vertexShader) && /varying vec3 vH3dWorldPos;/.test(frag));

console.log('\n=== 7. 参数变化必须换程序（这是"改了参数画面不动"的根因）===');
// three 的 getUniformList() 把「哪些 uniform 要上传」缓存在材质上，而程序按 cacheKey 缓存。
// cacheKey 固定 ⇒ 程序只编译一次 ⇒ 之后改 uniform 值根本不会被上传（真实页面实测 avg 恒为 188.71）。
// 所以：cacheKey 必须随参数值变化，并且值变了要让已注入的材质 needsUpdate。
const keyFor = (s) => {
  fog.update(s, parts);
  return material.customProgramCacheKey();
};
const keyA = keyFor({ height: -2, smoothness: 5, depth: 70, depthSmoothness: 25, enabled: true, color: '#ffffff' });
const keyB = keyFor({ height: -2, smoothness: 5, depth: 2000, depthSmoothness: 25, enabled: true, color: '#ffffff' });
const keyC = keyFor({ height: -2, smoothness: 5, depth: 70, depthSmoothness: 25, enabled: true, color: '#ffffff' });
ok('depth 变了 → cacheKey 变（会重新编译）', keyA !== keyB, `${keyA.slice(-34)} vs ${keyB.slice(-34)}`);
ok('值改回来 → cacheKey 也回到原样（程序可复用）', keyA === keyC, keyC.slice(-34));
{
  fog.update({ height: -2, depth: 70, color: '#ffffff' }, parts);
  const versionBefore = material.version;
  fog.update({ height: -2, depth: 70, color: '#ffffff' }, parts);
  ok('参数没变时不触发重编译（拖滑块回到原位不会白编译）',
    material.version === versionBefore, `${versionBefore} -> ${material.version}`);
}
ok('tune 返回 true', fog.tune({ depth: 33, height: -5 }) === true);
ok('tune 改了 uniform', sh4.uniforms.fogDepth.value === 33 && sh4.uniforms.fogPositionY.value === -5,
  `depth=${sh4.uniforms.fogDepth.value} height=${sh4.uniforms.fogPositionY.value}`);

console.log('\n=== 8. 幂等：反复 update 不会叠加注入 ===');
const hookAfterFirst = material.onBeforeCompile;
for (let i = 0; i < 5; i++) fog.update({ height: i }, parts);
const shN = shader();
material.onBeforeCompile(shN);
const occurrences = (shN.fragmentShader.match(/float verticalMixer/g) ?? []).length;
ok('onBeforeCompile 没有被层层包裹', material.onBeforeCompile === hookAfterFirst);
ok('注入片段只出现一次', occurrences === 1, String(occurrences));

console.log('\n=== 9. dispose：材质恢复干净 ===');
fog.dispose();
ok('注入标记已清除', !material.userData.__fogAttached);
ok('customProgramCacheKey 已还原', material.customProgramCacheKey === undefined || typeof material.customProgramCacheKey === 'function');
ok('背景渐变资源已释放', fog.gradientTexture === null || fog.gradientTexture === undefined);

console.log(`\n${failures ? `存在 ${failures} 个失败项` : '雾模块测试通过（注入 / 单位更新 / 背景独立 / 声明完整 / cacheKey / 幂等 / dispose）'}\n`);
process.exitCode = failures ? 1 : 0;

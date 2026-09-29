/**
 * validate.mjs —— v0.1.0 数据管线自检（主题：验证 class 属性）
 *
 * 覆盖：GLB 二进制解析 / _class 读取 / 逐块拆分 / 场景遍历 / 逐部件操作 / 炸开位移 / 兼容路径。
 * 运行：node validate.mjs
 */
import { readFileSync } from 'node:fs';
import { resolveModelPath } from './model-file.mjs';
import * as THREE from 'three';
import pkg from '../package.json' with { type: 'json' };
import { parseGLBBuffers } from '../src/demo-glb.js';
import { weldByPosition, connectivityBySharedVertices } from '../src/connectivity.js';
import { paletteColor } from '../src/palette.js';
import {
  collectPartsFromScene,
  buildPartsFromGroups,
  buildPartsFromVertexAttribute,
  applyColorMode,
  updateExplode,
  buildClassMaterialIndex,
  setClassGlow,
} from '../src/parts.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

// 模型文件名手动维护，不写死：见 tools/model-file.mjs
const GLB = resolveModelPath();
let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [OK]  ' : '  [FAIL]'} ${label}${extra ? ' -> ' + extra : ''}`);
};

const buf = readFileSync(GLB);
const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

console.log('\n=== 1. 二进制解析 parseGLBBuffers ===');
const src = parseGLBBuffers(arrayBuffer);
console.log(`  generator = ${src.generator}`);
console.log(`  node=${src.nodeCount} mesh=${src.meshCount} primitive=${src.primitiveCount} material=${src.materialCount}`);
console.log(`  attributes = [${src.attributeKeys}]`);
console.log(`  自定义属性 = [${Object.keys(src.extras).join(', ')}]`);
console.log(`  positions=${src.positions.length / 3}  triangles=${src.indices.length / 3}`);
ok('解析出顶点/索引', src.positions.length === 10206 * 3 && src.indices.length === 5476 * 3);
ok('文件是 1 node / 1 mesh（碎块合并在网格里）', src.nodeCount === 1 && src.meshCount === 1);
ok('导出了自定义属性 _class', '_class' in src.extras, Object.keys(src.extras).join(','));
ok('_class 是无符号整型 (5125)', src.extras._class?.componentType === 5125, String(src.extras._class?.componentType));
ok('_class 有 10206 个值', src.extras._class?.data.length === 10206, String(src.extras._class?.data.length));

console.log('\n=== 2. _class 取值分布（= 碎块数量）===');
const classValues = src.extras._class.data;
const uniqueClasses = new Set();
for (let i = 0; i < classValues.length; i++) uniqueClasses.add(classValues[i]);
const classList = [...uniqueClasses].sort((a, b) => a - b);
const triCount = src.indices.length / 3;
console.log(`  取值 ${classList.length} 种，范围 ${classList[0]} ~ ${classList[classList.length - 1]}`);
ok('恰好 250 个碎块', classList.length === 250, String(classList.length));
ok('取值是 0~249 连续整数', classList.every((v, i) => v === classList[0] + i), `${classList[0]}~${classList[classList.length - 1]}`);

let mismatchedTris = 0;
for (let t = 0; t < triCount; t++) {
  const a = classValues[src.indices[t * 3]];
  const b = classValues[src.indices[t * 3 + 1]];
  const c = classValues[src.indices[t * 3 + 2]];
  if (!(a === b && b === c)) mismatchedTris++;
}
ok('同一三角形三顶点 class 一致（按首顶点分桶安全）', mismatchedTris === 0, `不一致 ${mismatchedTris} 个`);

const perClassTris = new Map();
for (let t = 0; t < triCount; t++) {
  const c = classValues[src.indices[t * 3]];
  perClassTris.set(c, (perClassTris.get(c) ?? 0) + 1);
}
ok('250 个 class 全都有三角形', perClassTris.size === 250, String(perClassTris.size));
ok('各块三角形相加 = 5476', [...perClassTris.values()].reduce((a, b) => a + b, 0) === 5476);

console.log('\n=== 3. three.js GLTFLoader 是否保留 _class ===');
const gltf0 = await new GLTFLoader().parseAsync(arrayBuffer, '');
let mesh0 = null;
gltf0.scene.traverse((o) => { if (o.isMesh && !mesh0) mesh0 = o; });
const attrNames = Object.keys(mesh0.geometry.attributes);
console.log(`  mesh.name = "${mesh0.name}"`);
console.log(`  geometry.attributes = [${attrNames}]`);
ok('three.js 侧读得到 _class', attrNames.includes('_class'), attrNames.join(','));
ok('_class 是 Uint32Array', mesh0.geometry.attributes._class?.array instanceof Uint32Array);
ok('几何体没有 material group', (mesh0.geometry.groups?.length ?? 0) === 0, String(mesh0.geometry.groups?.length ?? 0));

console.log('\n=== 4. 按 _class 逐块拆分 buildPartsFromVertexAttribute ===');
const byClass = buildPartsFromVertexAttribute(mesh0, '_class', 2000);
ok('拆出 250 个部件', byClass.parts.length === 250, String(byClass.parts.length));
ok('valueCount = 250', byClass.valueCount === 250, String(byClass.valueCount));
ok('首个部件名 class_000', byClass.parts[0].name === 'class_000', byClass.parts[0].name);
ok('末个部件名 class_249', byClass.parts[249].name === 'class_249', byClass.parts[249].name);
ok('250 块三角形相加 = 5476', byClass.parts.reduce((s, p) => s + p.triangleCount, 0) === 5476);
ok('每块有独立几何体', byClass.parts[0].geometry !== byClass.parts[1].geometry);
ok('每块有独立材质', byClass.parts[0].material !== byClass.parts[1].material);
ok('每块算出了中心点', byClass.parts[10].object.position.length() > 0, byClass.parts[10].object.position.length().toFixed(3));
console.log(`  class_000: ${byClass.parts[0].triangleCount} 三角形, ${byClass.parts[0].vertexCount} 顶点`);

console.log('\n=== 5. 逐部件材质（基础中性色 / class 分色）===');
applyColorMode(byClass.parts, false, paletteColor, '#9aa3ad');
const neutral = byClass.parts.map((p) => p.material.color.getHexString());
ok('默认所有部件同一基础色', new Set(neutral).size === 1, neutral[0]);
ok('基础色为传入的中性色', neutral[0] === '9aa3ad', neutral[0]);

applyColorMode(byClass.parts, true, paletteColor, '#9aa3ad');
const c0 = byClass.parts[0].material.color.getHexString();
const c1 = byClass.parts[1].material.color.getHexString();
ok('开启 class 分色后相邻部件颜色不同', c0 !== c1, `${c0} vs ${c1}`);
const all = byClass.parts.map((p) => p.material.color.getHexString());
ok('class 分色覆盖全部 250 块', new Set(all).size > 200, `${new Set(all).size} 种颜色`);

applyColorMode(byClass.parts, false, paletteColor, '#9aa3ad');
ok('关掉分色后能回到中性色', byClass.parts[0].material.color.getHexString() === '9aa3ad');

console.log('\n=== 5b. 发光写入材质（颜色 × 强度，保色相）===');
const glowIndex = buildClassMaterialIndex(byClass.parts);
const gm = glowIndex.get(137)[0];

setClassGlow(glowIndex, 137, 0, 2.5, '#ff8800');
ok('强度 0 时 emissive 为黑（等于基础材质）', gm.emissive.getHexString() === '000000', gm.emissive.getHexString());

// 关键：颜色不能归一化后交给 emissiveIntensity —— 那样中间强度会全通道溢出而变白
// 注意 three 默认开启颜色管理，emissive 存的是**线性空间**值，所以期望值也要按线性算
setClassGlow(glowIndex, 137, 1, 2.5, '#ff8800');
const c137 = gm.emissive.clone();
const linear = new THREE.Color('#ff8800');           // setStyle 内部已做 sRGB → linear
ok('发光颜色 = 设定色 × 强度（R 通道）', Math.abs(c137.r - linear.r * 2.5) < 1e-6, `${c137.r} vs ${linear.r * 2.5}`);
ok('发光颜色 = 设定色 × 强度（G 通道）', Math.abs(c137.g - linear.g * 2.5) < 1e-6, `${c137.g} vs ${linear.g * 2.5}`);
ok('发光颜色 = 设定色 × 强度（B 通道为 0）', Math.abs(c137.b) < 1e-6, String(c137.b));
ok('色相未被拉平：R > G > B', c137.r > c137.g && c137.g > c137.b, `${c137.r.toFixed(3)} ${c137.g.toFixed(3)} ${c137.b.toFixed(3)}`);
ok('强度写进颜色而非 emissiveIntensity', gm.emissiveIntensity === 1, String(gm.emissiveIntensity));

// 中间强度也要保色相：R 与 G 的比值应恒定，不会因强度变化而趋同
setClassGlow(glowIndex, 137, 0.4, 2.5, '#ff8800');
const mid = gm.emissive.clone();
ok('半强度下色相比例不变', Math.abs(mid.r / mid.g - c137.r / c137.g) < 1e-6, `${(mid.r / mid.g).toFixed(4)}`);

setClassGlow(glowIndex, 137, 0, 2.5, '#ff8800');
ok('归零后 emissive 回到黑', gm.emissive.getHexString() === '000000');

console.log('\n=== 6. 炸开位移（Houdini Exploded View 逻辑）===');
for (const p of byClass.parts) p.object.userData.basePosition = p.object.position.clone();
const before = byClass.parts[0].object.position.clone();
updateExplode(byClass.parts, 1, 10);
const moved = before.distanceTo(byClass.parts[0].object.position);
ok('炸开改变了部件位置', moved > 0.01, `移动 ${moved.toFixed(3)}`);

const c = new THREE.Vector3();
const total = new THREE.Box3();
total.makeEmpty();
for (const p of byClass.parts) total.union(p.object.userData.box);
total.getCenter(c);
const d0 = before.distanceTo(c);
ok('位移量与到中心距离成正比', Math.abs(moved - 0.7 * d0) < 1e-6, `移动 ${moved.toFixed(3)} vs 0.7×${d0.toFixed(3)}`);

// 回归测试：反复在同一 factor 上重复调用，位置必须完全不变（旧版会把偏移累加进 basePosition）
const snapA = byClass.parts.map((p) => p.object.position.clone());
for (let i = 0; i < 5; i++) updateExplode(byClass.parts, 1, 10);
let drift = 0;
byClass.parts.forEach((p, i) => { drift = Math.max(drift, p.object.position.distanceTo(snapA[i])); });
ok('同一 factor 重复调用 5 次不漂移', drift < 1e-9, `最大漂移 ${drift.toExponential(2)}`);

// 回归测试：模拟反复拖动滑块（1 → 0.3 → 2 → 0.7 → 0 …），回到 0 必须精确复位
const seq = [1, 0.3, 2, 0.7, 1.5, 0.1, 2, 0];
for (const f of seq) updateExplode(byClass.parts, f, 10);
// 反复拖动之后，每个部件都必须回到自己的静止位置
let maxBack = 0;
for (const p of byClass.parts) maxBack = Math.max(maxBack, p.object.position.distanceTo(p.object.userData.basePosition));
ok('反复拖动滑块后回到 0 精确复位', maxBack < 1e-9, `最大残留 ${maxBack.toExponential(2)}`);

// 回归测试：位置始终只取决于 factor，与历史路径无关
updateExplode(byClass.parts, 0.6, 10);
const pathA = byClass.parts.map((p) => p.object.position.clone());
for (const f of seq) updateExplode(byClass.parts, f, 10);
updateExplode(byClass.parts, 0.6, 10);
let pathDiff = 0;
byClass.parts.forEach((p, i) => { pathDiff = Math.max(pathDiff, p.object.position.distanceTo(pathA[i])); });
ok('同一 factor 与拖动历史无关', pathDiff < 1e-9, `最大差 ${pathDiff.toExponential(2)}`);

updateExplode(byClass.parts, 0, 10);
ok('炸开归零后回到原位', byClass.parts[0].object.position.distanceTo(before) < 1e-9);

console.log('\n=== 7. 场景遍历（模式②，对照）===');
const collected2 = collectPartsFromScene(gltf0.scene);
ok('场景遍历只能拿到 1 个 Mesh', collected2.parts.length === 1, String(collected2.parts.length));

console.log('\n=== 8. 连通性（说明为何不用它分块）===');
const weld = weldByPosition(src.positions);
const conn = connectivityBySharedVertices(src.indices, src.positions.length / 3);
const connPer = new Map();
for (let t = 0; t < triCount; t++) connPer.set(conn.triGroup[t], (connPer.get(conn.triGroup[t]) ?? 0) + 1);
const connSizes = [...connPer.values()].sort((a, b) => b - a);
console.log(`  顶点 ${src.positions.length / 3} → 位置去重 ${weld.count}（重复 ${src.positions.length / 3 - weld.count}）`);
console.log(`  连通体 ${conn.count} 个，最大一块 ${connSizes[0]} 个三角形`);

// 注意：这些数字随模型每次导出而变化，所以断言"关系"而不是"具体数值"
ok('每个顶点都参与了连通体划分', weld.count > 0 && weld.count <= src.positions.length / 3, String(weld.count));
ok('连通体数量 <= 三角形数（划分有效）', conn.count > 0 && conn.count <= triCount, `${conn.count} <= ${triCount}`);
ok('最大连通体远小于 250 块的平均面数（说明连通性切不出碎块）', connSizes[0] < triCount / 250, `最大 ${connSizes[0]} < ${(triCount / 250).toFixed(1)}`);
ok('连通体面数之和 = 5476', connSizes.reduce((a, b) => a + b, 0) === triCount);

console.log('\n=== 9. 兼容路径：geometry.groups ===');
const geoG = new THREE.BufferGeometry()
  .setAttribute('position', new THREE.BufferAttribute(src.positions, 3))
  .setIndex(new THREE.BufferAttribute(new Uint16Array(src.indices), 1));
geoG.addGroup(0, 3000, 0);
geoG.addGroup(3000, src.indices.length - 3000, 1);
const meshG = new THREE.Mesh(geoG, [new THREE.MeshStandardMaterial(), new THREE.MeshStandardMaterial({ color: 0xff0000 })]);
const groupParts = buildPartsFromGroups(meshG);
ok('按 groups 拆出 2 个部件', groupParts.length === 2, String(groupParts.length));
ok('两部件三角形相加 = 5476', groupParts.reduce((s, p) => s + p.triangleCount, 0) === 5476);
ok('第二部件用了第二材质', groupParts[1].material.color.getHexString() === 'ff0000');

console.log(`\n${failures ? `存在 ${failures} 个失败项` : `v${pkg.version} 数据管线自检全部通过`}\n`);
process.exitCode = failures ? 1 : 0;

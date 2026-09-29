/**
 * parts.js —— 把模型变成"可以 for 循环的部件数组"，并支持逐部件操作。
 *
 * 四种取得部件的方式：
 *   1. collectPartsFromScene()      —— 加载后的场景图里每个 Mesh 就是一个部件（glTF 多节点/多 primitive）
 *   2. buildPartsFromGroups()       —— 未合并前的 geometry.groups（多材质槽）
 *   3. buildPartsFromVertexAttribute() —— 按几何体上的分组属性（Houdini 的 `_class`）逐块拆
 *   4. buildPartsFromSlices()       —— 一个合并网格，按连通/分区算法切出部件
 */

import * as THREE from 'three';
import { buildSubGeometry } from './palette.js';

/** 复用同一个 Color 实例解析发光色，避免每帧为每个 class 新建对象 */
const tempColor = new THREE.Color();

/* ------------------------------------------------------------------ */
/* 方式一：直接遍历场景图                                                */
/* ------------------------------------------------------------------ */

export function collectPartsFromScene(root) {
  const parts = [];
  let objectCount = 0;
  root.updateWorldMatrix(true, true);
  root.traverse((obj) => {
    objectCount++;
    if (!obj.isMesh) return;
    const geometry = obj.geometry;
    const positions = geometry.attributes.position;
    const indexCount = geometry.index ? geometry.index.count : positions.count;
    parts.push({
      name: obj.name || `(未命名 ${parts.length})`,
      object: obj,
      geometry,
      triangleCount: indexCount / 3,
      vertexCount: positions.count,
      source: 'node',
      material: obj.material,
      visible: obj.visible,
      worldMatrix: obj.matrixWorld.clone(),
    });
  });
  return { parts, objectCount };
}

/* ------------------------------------------------------------------ */
/* 方式二：geometry.groups（同一 mesh 内的多个材质槽 / 子网格）            */
/* ------------------------------------------------------------------ */

export function buildPartsFromGroups(mesh) {
  const geometry = mesh.geometry;
  const material = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const groups = geometry.groups ?? [];
  const positions = geometry.attributes.position;
  const normals = geometry.attributes.normal ? Float32Array.from(geometry.attributes.normal.array) : null;
  const pos = Float32Array.from(positions.array);
  const indices = geometry.index
    ? Uint32Array.from(geometry.index.array)
    : Uint32Array.from({ length: positions.count }, (_, i) => i);

  const parts = [];
  for (let g = 0; g < groups.length; g++) {
    const group = groups[g];
    const startTri = Math.floor(group.start / 3);
    const endTri = Math.floor((group.start + group.count) / 3);
    const tris = [];
    for (let t = startTri; t < endTri; t++) tris.push(t);
    if (!tris.length) continue;

    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const vi = indices[t * 3 + k];
        box.expandByPoint(v.set(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]));
      }
    }
    const center = box.getCenter(new THREE.Vector3());
    const geo = buildSubGeometry(pos, normals, indices, tris, center);
    const mat = material[group.materialIndex ?? g] ?? material[0];

    const object = new THREE.Mesh(geo, mat?.clone ? mat.clone() : new THREE.MeshStandardMaterial());
    object.name = `${mesh.name || 'mesh'}_group${g}`;
    object.position.copy(center);
    object.userData.box = box;

    parts.push({
      name: object.name,
      object,
      geometry: geo,
      triangleCount: tris.length,
      vertexCount: geo.attributes.position.count,
      source: 'group',
      material: object.material,
      visible: true,
      worldMatrix: mesh.matrixWorld.clone(),
    });
  }
  return parts;
}

/* ------------------------------------------------------------------ */
/* 方式三：按顶点属性分块（Houdini 的 class 属性 —— 最理想的路径）        */
/* ------------------------------------------------------------------ */

/**
 * 直接读几何体上的分组属性（Houdini 导出的 `_class`），把每个值对应的三角形抽成独立部件。
 * 这是合并网格里"最正统"的 for-each：不需要任何猜测算法，分组信息就在属性里。
 * @param mesh 单个 Mesh
 * @param attributeName 属性通道名，默认 '_class'
 * @param maxParts 最多实例化多少个部件
 */
export function buildPartsFromVertexAttribute(mesh, attributeName = '_class', maxParts = 2000) {
  const geometry = mesh.geometry;
  const attr = geometry.attributes[attributeName];
  if (!attr) return { parts: [], valueCount: 0, missing: true };

  const positions = Float32Array.from(geometry.attributes.position.array);
  const normals = geometry.attributes.normal ? Float32Array.from(geometry.attributes.normal.array) : null;
  const indices = geometry.index
    ? Uint32Array.from(geometry.index.array)
    : Uint32Array.from({ length: geometry.attributes.position.count }, (_, i) => i);

  const triCount = indices.length / 3;
  const byValue = new Map();
  const arr = attr.array;
  for (let t = 0; t < triCount; t++) {
    const value = Number(arr[indices[t * 3]]);
    let list = byValue.get(value);
    if (!list) byValue.set(value, (list = []));
    list.push(t);
  }

  const entries = [...byValue.entries()].sort((a, b) => a[0] - b[0]);
  const kept = entries.slice(0, maxParts);
  const parts = [];
  const v = new THREE.Vector3();

  for (const [value, tris] of kept) {
    const box = new THREE.Box3();
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const vi = indices[t * 3 + k];
        box.expandByPoint(v.set(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]));
      }
    }
    const center = box.getCenter(new THREE.Vector3());
    const geo = buildSubGeometry(positions, normals, indices, tris, center);

    const object = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
      metalness: 0.12,
      roughness: 0.62,
      // 发光：基色不变，靠 emissive 叠加。默认全黑 = 就是基础材质；
      // 触发时写入"颜色 × 强度"（见 setClassGlow 的说明）。
      emissive: new THREE.Color(0x000000),
      emissiveIntensity: 1,
    }));
    object.name = `${attributeName.replace(/^_/, '')}_${String(value).padStart(3, '0')}`;
    object.position.copy(center);
    object.userData.box = box;
    object.userData.groupValue = value;
    object.userData.classId = Number(value);

    parts.push({
      name: object.name,
      object,
      geometry: geo,
      triangleCount: tris.length,
      vertexCount: geo.attributes.position.count,
      source: 'attribute',
      material: object.material,
      visible: true,
      worldMatrix: mesh.matrixWorld.clone(),
    });
  }
  return { parts, valueCount: entries.length, skipped: entries.length - kept.length, missing: false };
}

/* ------------------------------------------------------------------ */
/* 方式四：合并网格 -> 按连通性/分区切出部件                              */
/* ------------------------------------------------------------------ */

/**
 * @param mesh 单个 Mesh（合并网格）
 * @param sliced [{ key, tris }] 来自 connectivity.js 的切块结果
 * @param maxParts 只实例化最大的 N 块（防止几万块把浏览器拖死）
 */
export function buildPartsFromSlices(mesh, sliced, maxParts = 600) {
  const geometry = mesh.geometry;
  const positions = Float32Array.from(geometry.attributes.position.array);
  const normals = geometry.attributes.normal ? Float32Array.from(geometry.attributes.normal.array) : null;
  const indices = geometry.index
    ? Uint32Array.from(geometry.index.array)
    : Uint32Array.from({ length: geometry.attributes.position.count }, (_, i) => i);

  const kept = sliced.slice(0, maxParts);
  const parts = [];
  const v = new THREE.Vector3();

  for (let i = 0; i < kept.length; i++) {
    const { key, tris } = kept[i];
    const box = new THREE.Box3();
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const vi = indices[t * 3 + k];
        box.expandByPoint(v.set(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]));
      }
    }
    const center = box.getCenter(new THREE.Vector3());
    const geo = buildSubGeometry(positions, normals, indices, tris, center);

    const object = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ metalness: 0.1, roughness: 0.72 }));
    object.name = `part_${String(i).padStart(4, '0')}`;
    object.position.copy(center);
    object.userData.box = box;
    object.userData.key = key;

    parts.push({
      name: object.name,
      object,
      geometry: geo,
      triangleCount: tris.length,
      vertexCount: geo.attributes.position.count,
      source: 'split',
      material: object.material,
      visible: true,
      worldMatrix: mesh.matrixWorld.clone(),
    });
  }
  return { parts, skipped: sliced.length - kept.length };
}

/* ------------------------------------------------------------------ */
/* 逐部件操作                                                           */
/* ------------------------------------------------------------------ */

/**
 * 给部件上色。两种状态：
 *   · classColors = false（默认）→ 全部用同一个基础材质中性色
 *   · classColors = true        → 每个 class 分到不同颜色，便于肉眼查看 class 分布
 * @param colorOf (index) => THREE.Color  用于生成 class 配色（黄金角调色板）
 * @param baseColor 基础材质颜色（十六进制或 CSS 字符串）
 */
export function applyColorMode(parts, classColors, colorOf, baseColor = '#9aa3ad') {
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const mat = p.material;
    if (!mat || !mat.color) continue;
    if (classColors) mat.color.copy(colorOf(i));
    else mat.color.set(baseColor);
    mat.needsUpdate = true;
  }
}

/**
 * 炸开位移 —— 对齐 Houdini Exploded View 的做法：
 *   1. 每个部件的"代表点"是它自己的包围盒中心（相当于 Houdini 里每块算一个 centroid）
 *   2. 位移方向 = 该质心相对整个模型质心的方向（向外炸开）
 *   3. 位移量随"离模型中心的远近"成比例：远处的块走得更多，近处的更少
 *      —— 所以炸开后整体轮廓会被放大，而不是所有块等距平移
 *
 * factor = 0 复位；factor = 1 时每块额外外移自身到中心距离的 70%；
 * factor = 2 时约 140%（滑块 0~2，1 是比较像 Houdini 默认 Exploded View 的位置）。
 */
export function updateExplode(parts, factor, radius, amount = 0.7) {
  // 先求所有部件的整体中心（用各自的包围盒）
  const total = new THREE.Box3();
  total.makeEmpty();
  for (const p of parts) {
    if (p.object.userData.box) total.union(p.object.userData.box);
    else total.expandByPoint(p.object.userData.basePosition ?? p.object.position);
  }
  const center = total.getCenter(new THREE.Vector3());

  const dir = new THREE.Vector3();
  for (const p of parts) {
    // 注意：basePosition 必须是"静止位置"这个不变量。
    // 它由 buildMode() 在每次重建部件时写一次，updateExplode 绝不能改写它，
    // 否则每帧都会拿"上一帧已偏移的位置"当基准再累加，导致滑块拉几次就累积出漂移、
    // 拉到 0 也回不到原位。
    const base = p.object.userData.basePosition;
    if (!base) continue;

    if (factor <= 0) {
      p.object.position.copy(base);
      continue;
    }

    // 方向：从模型中心指向这块的质心。正好在中心上的块给一个人工方向，避免原地不动。
    dir.copy(base).sub(center);
    if (dir.lengthSq() < 1e-10) dir.set(0, 1, 0);
    dir.normalize();
    // 位移量 ∝ 该块到中心的距离 —— 且基于静止位置推算，与当前帧状态无关
    p.object.position.copy(base).addScaledVector(dir, factor * amount * base.distanceTo(center));
  }
  return total;
}

export function setWireframe(parts, on) {
  for (const p of parts) {
    if (p.material && 'wireframe' in p.material) p.material.wireframe = on;
  }
}

/* ------------------------------------------------------------------ */
/* 发光（0.3 材质驱动）                                                 */
/* ------------------------------------------------------------------ */

/** 建立 class → 该 class 的材质列表；触发时按 class 找材质，不需要遍历全部部件 */
export function buildClassMaterialIndex(parts) {
  const byClass = new Map();
  for (const p of parts) {
    const id = p.object?.userData?.classId;
    if (id === undefined) continue;
    let list = byClass.get(id);
    if (!list) byClass.set(id, (list = []));
    list.push(p.material);
  }
  return byClass;
}

/**
 * 把一个 class 的材质设为发光。
 *
 * 关键：**把"颜色 × 强度"整体写进 emissive，emissiveIntensity 固定为 1**。
 * 若反过来（emissive = 归一化颜色、emissiveIntensity = 大数值），比如白以外的橙色
 * #ff8800 配强度 2.5，线性空间会得到 (2.5, 1.33, 0) —— R/G 通道一起溢出，
 * 经 tonemapping 后全变白，只有衰减到低强度时颜色才显出来（踩过）。
 * 写成 emissive = color × intensity 则超过 1 的通道仍走 tonemapping 泛白，
 * 色相在中间强度区间得以保留。
 *
 * @param {Map<number, THREE.Material[]>} index 来自 buildClassMaterialIndex
 * @param {number} classId
 * @param {number} level 0~1（最终强度 = level × peak）
 * @param {number} peak 峰值强度
 * @param {number|string|THREE.Color} color 发光颜色（数字 / CSS 字符串 / Color 都接受）
 */
export function setClassGlow(index, classId, level, peak = 2.5, color = 0xffffff) {
  const list = index.get(Number(classId));
  if (!list) return false;
  const intensity = Math.max(0, Math.min(1, level)) * peak;
  // 用 THREE.Color 统一解析：setHex 只吃数字，面板传来的是 "#ff8800" 这种字符串，
  // 直接喂给 setHex 会得到 NaN（曾实测到 emissive = #000NaN）。
  const tint = tempColor.set(color);
  for (const mat of list) {
    if (!mat) continue;
    if (mat.emissive) mat.emissive.copy(tint).multiplyScalar(intensity);
    mat.emissiveIntensity = 1;
  }
  return true;
}

/** 清空所有发光（强度归零） */
export function clearGlow(parts) {
  for (const p of parts) {
    if (!p.material) continue;
    p.material.emissive.setRGB(0, 0, 0);
    p.material.emissiveIntensity = 1;
  }
}

export function resetMaterials(parts) {
  clearGlow(parts);
}

export function restoreBasePositions(parts) {
  for (const p of parts) {
    if (p.object.userData.basePosition) p.object.position.copy(p.object.userData.basePosition);
  }
}

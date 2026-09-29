/**
 * connectivity.js —— 在 three.js 里复刻 Houdini 的 connectivity（连通体）/ partition 概念。
 *
 * Houdini 侧：`connectivity` 按共享点或按距离把几何体分块，`partition` / for-each 逐块处理。
 * three.js 侧：网格数据就是 position + index 两个 typed array，所以同样的算法可以直接跑。
 */

/** 并查集：把离散数据聚成"连通体"，这就是 for-each 的循环单位。 */
export function createUnionFind(n) {
  const parent = new Int32Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (x) => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    // 路径压缩
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  return { find, union };
}

/**
 * 把位置相同的顶点归并成一个"焊接点"。
 * Houdini 导出的破碎模型经常是每个三角形独立顶点（未焊接），必须走这一步。
 * @returns {{weld:Int32Array, count:number, rep:Float64Array}} weld[i] = 顶点 i 的焊接点 id
 */
export function weldByPosition(pos, quant = 1e-5) {
  const n = pos.length / 3;
  const map = new Map();
  const weld = new Int32Array(n);
  const repList = [];
  const q = 1 / quant;
  for (let i = 0; i < n; i++) {
    const x = pos[i * 3];
    const y = pos[i * 3 + 1];
    const z = pos[i * 3 + 2];
    const key = `${Math.round(x * q)},${Math.round(y * q)},${Math.round(z * q)}`;
    let id = map.get(key);
    if (id === undefined) {
      id = repList.length;
      map.set(key, id);
      repList.push([x, y, z]);
    }
    weld[i] = id;
  }
  return {
    weld,
    count: repList.length,
    rep: Float64Array.from(repList.flat()),
  };
}

/**
 * 按距离阈值把焊接点聚成部件 —— 等价 Houdini 的 `connectivity` 勾选 "Connectivity by distance"。
 * @param rep Float64Array 焊接点坐标
 * @param threshold 距离阈值
 */
export function clusterByDistance(rep, threshold) {
  const n = rep.length / 3;
  const { find, union } = createUnionFind(n);
  const cell = Math.max(threshold, 1e-6);
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.floor(rep[i * 3] / cell)},${Math.floor(rep[i * 3 + 1] / cell)},${Math.floor(rep[i * 3 + 2] / cell)}`;
    let bucket = grid.get(k);
    if (!bucket) grid.set(k, (bucket = []));
    bucket.push(i);
  }
  const t2 = threshold * threshold;
  for (const [key, list] of grid) {
    const parts = key.split(',');
    const cx = +parts[0];
    const cy = +parts[1];
    const cz = +parts[2];
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const other = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!other) continue;
          const same = dx === 0 && dy === 0 && dz === 0;
          for (let a = 0; a < list.length; a++) {
            const ga = list[a];
            for (let b = same ? a + 1 : 0; b < other.length; b++) {
              const gb = other[b];
              const ax = rep[ga * 3] - rep[gb * 3];
              const ay = rep[ga * 3 + 1] - rep[gb * 3 + 1];
              const az = rep[ga * 3 + 2] - rep[gb * 3 + 2];
              if (ax * ax + ay * ay + az * az <= t2) union(ga, gb);
            }
          }
        }
      }
    }
  }
  return { find, count: n };
}

/**
 * 按"面共享顶点"把三角形聚成连通体 —— 等价 Houdini 的 `connectivity`（拓扑连接）。
 * @returns {{triGroup:Int32Array, count:number}} triGroup[t] = 第 t 个三角形所属的块 id
 */
export function connectivityBySharedVertices(indices, vertexCount) {
  const { find, union } = createUnionFind(vertexCount);
  const triCount = indices.length / 3;
  for (let t = 0; t < triCount; t++) {
    const a = indices[t * 3];
    const b = indices[t * 3 + 1];
    const c = indices[t * 3 + 2];
    union(a, b);
    union(b, c);
  }
  const triGroup = new Int32Array(triCount);
  const idOf = new Map();
  for (let t = 0; t < triCount; t++) {
    const root = find(indices[t * 3]);
    let id = idOf.get(root);
    if (id === undefined) idOf.set(root, (id = idOf.size));
    triGroup[t] = id;
  }
  return { triGroup, count: idOf.size };
}

/**
 * 按轴对齐的规则网格切块 —— 演示用，模拟 Houdini 的 `partition`（按 bounding box 分块）。
 */
export function partitionByGrid(positions, indices, divisions = 2) {
  let mnx = Infinity, mny = Infinity, mnz = Infinity;
  let mxx = -Infinity, mxy = -Infinity, mxz = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < mnx) mnx = positions[i];
    if (positions[i] > mxx) mxx = positions[i];
    if (positions[i + 1] < mny) mny = positions[i + 1];
    if (positions[i + 1] > mxy) mxy = positions[i + 1];
    if (positions[i + 2] < mnz) mnz = positions[i + 2];
    if (positions[i + 2] > mxz) mxz = positions[i + 2];
  }
  const span = [mxx - mnx || 1, mxy - mny || 1, mxz - mnz || 1];
  const origin = [mnx, mny, mnz];
  const triCount = indices.length / 3;
  const groups = new Map();
  const d = Math.max(1, divisions);
  for (let t = 0; t < triCount; t++) {
    const cx = Math.min(d - 1, Math.floor(((positions[indices[t * 3] * 3] - origin[0]) / span[0]) * d));
    const cy = Math.min(d - 1, Math.floor(((positions[indices[t * 3] * 3 + 1] - origin[1]) / span[1]) * d));
    const cz = Math.min(d - 1, Math.floor(((positions[indices[t * 3] * 3 + 2] - origin[2]) / span[2]) * d));
    const key = (cz * d + cy) * d + cx;
    let arr = groups.get(key);
    if (!arr) groups.set(key, (arr = []));
    arr.push(t);
  }
  const sliced = [...groups.entries()].map(([key, tris]) => ({ key, tris }));
  sliced.sort((a, b) => b.tris.length - a.tris.length);
  return sliced;
}

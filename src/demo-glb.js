/**
 * demo-glb.js —— 演示用：直接读取/生成 GLB，不依赖加载器。
 *
 * 目的：让你看到"一个模型里有很多部分"在 glTF 二进制层面长什么样，
 * 以及导出成"多节点"时 three.js 侧就能天然地 for 循环。
 */

/** 只解析我们关心的 POSITION / NORMAL / indices，不引入 glTF 库。 */

function concatFloat(list) {
  let len = 0;
  for (const a of list) len += a.length;
  const out = new Float32Array(len);
  let w = 0;
  for (const a of list) { out.set(a, w); w += a.length; }
  return out;
}

function concatUint(list) {
  let len = 0;
  for (const a of list) len += a.length;
  const out = new Uint32Array(len);
  let w = 0;
  for (const a of list) { out.set(a, w); w += a.length; }
  return out;
}

export function parseGLBBuffers(arrayBuffer) {
  const buf = arrayBuffer;
  if (!buf || buf.byteLength < 20) {
    throw new Error(`文件太小（${buf?.byteLength ?? 0} 字节），不是 GLB`);
  }
  const view = new DataView(buf);
  const magic = view.getUint32(0, true);
  if (magic !== 0x46546c67) {
    // 最常见的情况：路径写错 / 文件被改名，dev server 把 index.html 返回了回来。
    // 这里把开头的字节读出来，直接告诉调用方拿到的是什么，别再让人对着"不是合法的 GLB"猜。
    const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(24, buf.byteLength))).trimStart();
    const looksHtml = /^<(!doctype|html)/i.test(head);
    throw new Error(
      looksHtml
        ? `拿到的是一段 HTML 而不是二进制（很可能是路径不对，服务器把 index.html 返回了）。开头：${head.slice(0, 24)}…`
        : `不是合法的 GLB 文件（magic=0x${magic.toString(16)}，开头：${head.slice(0, 24)}…）`
    );
  }
  const jsonLength = view.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLength)));
  const binStart = 20 + jsonLength + 8;

  const readAccessor = (idx) => {
    const acc = json.accessors[idx];
    const bv = json.bufferViews[acc.bufferView];
    const components = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
    const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType];
    const offset = binStart + (bv.byteOffset ?? 0) + (acc.byteOffset ?? 0);
    const dv = new DataView(buf, offset, acc.count * components * size);
    const out = new Float64Array(acc.count * components);
    for (let i = 0; i < acc.count * components; i++) {
      const p = i * size;
      out[i] =
        acc.componentType === 5126 ? dv.getFloat32(p, true) :
        acc.componentType === 5125 ? dv.getUint32(p, true) :
        acc.componentType === 5123 ? dv.getUint16(p, true) :
        dv.getUint8(p);
    }
    return out;
  };

  const mesh = json.meshes[0];
  const prim = mesh.primitives[0];
  let positions = Float32Array.from(readAccessor(prim.attributes.POSITION));
  let normals = prim.attributes.NORMAL !== undefined ? Float32Array.from(readAccessor(prim.attributes.NORMAL)) : null;
  let indices;
  if (prim.indices !== undefined) {
    const raw = readAccessor(prim.indices);
    indices = Uint32Array.from(raw);
  } else {
    indices = Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  }

  // 自定义属性（Houdini 的 class/name 会导出成 _class 这类下划线开头的通道）
  const extras = {};
  for (const [name, accIdx] of Object.entries(prim.attributes)) {
    if (name === 'POSITION' || name === 'NORMAL' || name === 'TEXCOORD_0' || name === 'TANGENT') continue;
    const acc = json.accessors[accIdx];
    extras[name] = {
      itemSize: { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type] ?? 1,
      componentType: acc.componentType,
      data: readAccessor(accIdx),
    };
  }

  // 多节点文件：把其余 mesh/primitive 也合并进来，得到整个模型的三角形总数
  const allPrims = (json.meshes ?? []).flatMap((m) => m.primitives ?? []);
  if (allPrims.length > 1) {
    const posParts = [positions];
    const norParts = normals ? [normals] : [];
    const idxParts = [indices];
    let vertexBase = positions.length / 3;
    for (let i = 1; i < allPrims.length; i++) {
      const p = allPrims[i];
      const pPos = Float32Array.from(readAccessor(p.attributes.POSITION));
      posParts.push(pPos);
      if (normals && p.attributes.NORMAL !== undefined) norParts.push(Float32Array.from(readAccessor(p.attributes.NORMAL)));
      const count = pPos.length / 3;
      if (p.indices !== undefined) {
        const pIdx = readAccessor(p.indices);
        const shifted = new Uint32Array(pIdx.length);
        for (let k = 0; k < pIdx.length; k++) shifted[k] = pIdx[k] + vertexBase;
        idxParts.push(shifted);
      } else {
        const seq = new Uint32Array(count);
        for (let k = 0; k < count; k++) seq[k] = k + vertexBase;
        idxParts.push(seq);
      }
      vertexBase += count;
    }
    positions = concatFloat(posParts);
    if (normals) normals = normals.length === positions.length ? concatFloat(norParts) : null;
    indices = concatUint(idxParts);
  }

  return {
    json,
    positions: Float32Array.from(positions),
    normals: normals ? Float32Array.from(normals) : null,
    indices,
    nodeCount: json.nodes?.length ?? 0,
    meshCount: json.meshes?.length ?? 0,
    primitiveCount: (json.meshes ?? []).reduce((s, m) => s + (m.primitives?.length ?? 0), 0),
    materialCount: json.materials?.length ?? 0,
    attributeKeys: Object.keys(prim.attributes ?? {}),
    hasNameAttribute: 'name' in (prim.attributes ?? {}),
    extras,
    generator: json.asset?.generator ?? '(未知)',
  };
}

/**
 * 把一份"合并网格"重新写成"多节点 GLB"：
 * 每个部件一个 node + 一个 mesh + 一个 material —— 这就是 three.js 最舒服的读取形态。
 * @param sliced [{ key, tris }] 每个部件的三角形列表
 * @param vertexExtras 可选的逐顶点自定义属性（如 Houdini 的 _class），会一并写进新文件
 */
export function buildMultiNodeGLB({ positions, normals, indices, sliced, namePrefix = 'piece', paletteColor, vertexExtras = null }) {
  const extraNames = vertexExtras ? Object.keys(vertexExtras) : [];
  const pieces = [];
  for (let i = 0; i < sliced.length; i++) {
    const tris = sliced[i].tris;
    const vmap = new Map();
    const pos = [];
    const nor = [];
    const ind = [];
    const extraOut = {};
    for (const n of extraNames) extraOut[n] = [];
    for (const t of tris) {
      for (let k = 0; k < 3; k++) {
        const vi = indices[t * 3 + k];
        const key = normals ? `${vi}|${normals[vi * 3]}|${normals[vi * 3 + 1]}|${normals[vi * 3 + 2]}` : `${vi}`;
        let ni = vmap.get(key);
        if (ni === undefined) {
          ni = vmap.size;
          vmap.set(key, ni);
          pos.push(positions[vi * 3], positions[vi * 3 + 1], positions[vi * 3 + 2]);
          if (normals) nor.push(normals[vi * 3], normals[vi * 3 + 1], normals[vi * 3 + 2]);
          for (const n of extraNames) {
            const src = vertexExtras[n];
            for (let c = 0; c < src.itemSize; c++) extraOut[n].push(src.data[vi * src.itemSize + c]);
          }
        }
        ind.push(ni);
      }
    }
    pieces.push({
      name: `${namePrefix}_${String(i).padStart(3, '0')}`,
      positions: pos,
      normals: nor,
      indices: ind,
      extras: extraOut,
      extraTypes: Object.fromEntries(extraNames.map((n) => [n, vertexExtras[n].componentType])),
      extraItemSizes: Object.fromEntries(extraNames.map((n) => [n, vertexExtras[n].itemSize])),
      color: paletteColor ? paletteColor(i) : { r: 0.8, g: 0.8, b: 0.8 },
    });
  }

  // ---- 组装二进制缓冲 ----
  const chunks = [];
  let offset = 0;
  const push = (typedArray) => {
    const bytes = new Uint8Array(typedArray.buffer, typedArray.byteOffset, typedArray.byteLength);
    const pad = (4 - (offset % 4)) % 4;
    if (pad) {
      chunks.push(new Uint8Array(pad));
      offset += pad;
    }
    const start = offset;
    chunks.push(bytes);
    offset += bytes.byteLength;
    return start;
  };

  const bufferViews = [];
  const accessors = [];
  const meshes = [];
  const nodes = [];
  const materials = [];

  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i];
    const posF32 = new Float32Array(p.positions);
    const norF32 = p.normals.length ? new Float32Array(p.normals) : null;

    let mn = [Infinity, Infinity, Infinity];
    let mx = [-Infinity, -Infinity, -Infinity];
    for (let v = 0; v < posF32.length; v += 3) {
      for (let c = 0; c < 3; c++) {
        const val = posF32[v + c];
        if (val < mn[c]) mn[c] = val;
        if (val > mx[c]) mx[c] = val;
      }
    }

    const posStart = push(posF32);
    bufferViews.push({ buffer: 0, byteOffset: posStart, byteLength: posF32.byteLength, target: 34962 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: posF32.length / 3, type: 'VEC3', min: mn, max: mx });
    const posAcc = accessors.length - 1;

    let norAcc;
    if (norF32) {
      const norStart = push(norF32);
      bufferViews.push({ buffer: 0, byteOffset: norStart, byteLength: norF32.byteLength, target: 34962 });
      accessors.push({ bufferView: bufferViews.length - 1, componentType: 5126, count: norF32.length / 3, type: 'VEC3' });
      norAcc = accessors.length - 1;
    }

    const useU32 = posF32.length / 3 > 65535;
    const idxTyped = useU32 ? new Uint32Array(p.indices) : new Uint16Array(p.indices);
    const idxStart = push(idxTyped);
    bufferViews.push({ buffer: 0, byteOffset: idxStart, byteLength: idxTyped.byteLength, target: 34963 });
    accessors.push({ bufferView: bufferViews.length - 1, componentType: useU32 ? 5125 : 5123, count: idxTyped.length, type: 'SCALAR' });
    const idxAcc = accessors.length - 1;

    // 自定义属性（保持原 componentType，不破坏整数语义）
    const extraAccs = {};
    for (const [name, values] of Object.entries(p.extras ?? {})) {
      const compType = p.extraTypes?.[name] ?? 5126;
      const Typed = compType === 5126 ? Float32Array : compType === 5125 ? Uint32Array : compType === 5123 ? Uint16Array : Uint8Array;
      const typed = new Typed(values);
      const start = push(typed);
      bufferViews.push({ buffer: 0, byteOffset: start, byteLength: typed.byteLength, target: 34962 });
      accessors.push({
        bufferView: bufferViews.length - 1,
        componentType: compType,
        count: typed.length / (p.extraItemSizes?.[name] ?? 1),
        type: 'SCALAR',
      });
      extraAccs[name] = accessors.length - 1;
    }

    materials.push({
      name: `mat_${p.name}`,
      pbrMetallicRoughness: {
        baseColorFactor: [p.color.r, p.color.g, p.color.b, 1],
        metallicFactor: 0.05,
        roughnessFactor: 0.75,
      },
      doubleSided: true,
    });

    const attributes = { POSITION: posAcc };
    if (norAcc !== undefined) attributes.NORMAL = norAcc;
    for (const [name, accIdx] of Object.entries(extraAccs)) attributes[name] = accIdx;
    meshes.push({ name: p.name, primitives: [{ attributes, indices: idxAcc, material: materials.length - 1, mode: 4 }] });
    nodes.push({ name: p.name, mesh: meshes.length - 1 });
  }

  const binLength = offset;
  const json = {
    asset: { version: '2.0', generator: 'h3d-stage demo re-exporter' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: binLength }],
  };

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonPad = (4 - (jsonBytes.byteLength % 4)) % 4;
  const jsonLen = jsonBytes.byteLength + jsonPad;
  const binPad = (4 - (binLength % 4)) % 4;
  const binLen = binLength + binPad;

  const totalLength = 12 + 8 + jsonLen + 8 + binLen;
  const out = new Uint8Array(totalLength);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, totalLength, true);
  dv.setUint32(12, jsonLen, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  for (let i = 0; i < jsonPad; i++) out[20 + jsonBytes.byteLength + i] = 0x20; // 空格补齐
  const binHeader = 20 + jsonLen;
  dv.setUint32(binHeader, binLen, true);
  dv.setUint32(binHeader + 4, 0x004e4942, true);
  let w = binHeader + 8;
  for (const chunk of chunks) {
    out.set(chunk, w);
    w += chunk.byteLength;
  }
  for (let i = 0; i < binPad; i++) out[w + i] = 0;

  return new Blob([out], { type: 'model/gltf-binary' });
}

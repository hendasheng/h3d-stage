import * as THREE from 'three';

const GOLDEN = 0.618033988749895;

/** 黄金角配色：相邻部件的颜色差异足够大，不会糊成一片。 */
export function paletteColor(i) {
  const h = (i * GOLDEN) % 1;
  const s = 0.55 + 0.25 * ((i * 7) % 3) / 2;
  const l = 0.5 + 0.14 * (((i * 13) % 5) / 4 - 0.5);
  return new THREE.Color().setHSL(h, s, l);
}

/**
 * 把一个带 index 的三角形子集抽成独立几何体。
 * 这就是 three.js 里"从合并网格里取出一个部件"的底层动作。
 */
export function buildSubGeometry(positions, normals, indices, triangleList, center) {
  const triCount = triangleList.length;
  const out = new Float32Array(triCount * 9);
  const outNormals = normals ? new Float32Array(triCount * 9) : null;
  let w = 0;
  for (let t = 0; t < triCount; t++) {
    const tri = triangleList[t];
    for (let k = 0; k < 3; k++) {
      const vi = indices[tri * 3 + k];
      out[w] = positions[vi * 3] - center.x;
      out[w + 1] = positions[vi * 3 + 1] - center.y;
      out[w + 2] = positions[vi * 3 + 2] - center.z;
      if (outNormals) {
        outNormals[w] = normals[vi * 3];
        outNormals[w + 1] = normals[vi * 3 + 1];
        outNormals[w + 2] = normals[vi * 3 + 2];
      }
      w += 3;
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(out, 3));
  if (outNormals) geo.setAttribute('normal', new THREE.BufferAttribute(outNormals, 3));
  else geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

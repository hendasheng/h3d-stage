/** 配置单一主光的软阴影范围，范围按模型尺寸而非固定世界坐标计算。 */
export function configureKeyShadow(light, modelRadius) {
  const extent = Math.max(modelRadius * 1.75, 5);
  light.castShadow = true;
  // 模型由许多小 class 构成；提高贴图分辨率以减少块间阴影的台阶感。
  light.shadow.mapSize.set(4096, 4096);
  light.shadow.camera.left = -extent;
  light.shadow.camera.right = extent;
  light.shadow.camera.top = extent;
  light.shadow.camera.bottom = -extent;
  light.shadow.camera.near = 0.1;
  light.shadow.camera.far = extent * 4;
  light.shadow.bias = -0.0001;
  light.shadow.normalBias = 0.02;
  light.shadow.camera.updateProjectionMatrix();
  return extent;
}

/** PCF 阴影的采样半径：小值更硬，大值更柔。 */
export function setShadowSoftness(light, value) {
  const radius = Math.min(8, Math.max(0, Number(value) || 0));
  light.shadow.radius = radius;
  return radius;
}

/** 所有 class 同时作为投射体和接收体，产生模型内部的块间阴影。 */
export function setSelfShadows(parts, enabled = true) {
  for (const part of parts) {
    if (!part.object) continue;
    part.object.castShadow = enabled;
    part.object.receiveShadow = enabled;
  }
}

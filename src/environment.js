import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';

// Three.js 官方 examples 中提供的 HDR；直接在线加载，不要求用户准备文件。
export const HDR_PRESETS = [
  { id: 'royal', name: 'Royal Esplanade · 广场', file: 'royal_esplanade_1k.hdr' },
  { id: 'sunset', name: 'Venice Sunset · 日落', file: 'venice_sunset_1k.hdr' },
  { id: 'sunrise', name: 'Blouberg Sunrise · 日出', file: 'blouberg_sunrise_2_1k.hdr' },
].map((preset) => ({ ...preset, url: `https://cdn.jsdelivr.net/gh/mrdoob/three.js@r180/examples/textures/equirectangular/${preset.file}` }));

export const ENVIRONMENT_OPTIONS = [
  { text: '默认室内', value: 'room' },
  { text: '关闭环境', value: 'none' },
  ...HDR_PRESETS.map(({ id, name }) => ({ text: name, value: id })),
];

/** 环境资源切换：保留原环境直到新 HDR 成功，较早的异步读取不能覆盖新选择。 */
export function createEnvironmentLighting(renderer, scene, onChange) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const roomTarget = pmrem.fromScene(room, 0.04);
  room.dispose();
  let hdrTarget = null;
  let current = 'room';
  let request = 0;
  let disposed = false;
  scene.environment = roomTarget.texture;

  const notify = (status, selected = current) => onChange({
    current: selected, status,
    options: ENVIRONMENT_OPTIONS,
  });
  notify('默认室内');

  async function select(id) {
    if (disposed) return;
    const token = ++request;
    let texture;
    let nextTarget;
    try {
      if (id !== 'room' && id !== 'none') {
        const preset = HDR_PRESETS.find((entry) => entry.id === id);
        if (!preset) throw new Error('没有这个 HDR 预设');
        notify(`正在加载 ${preset.name}`, id);
        const response = await fetch(preset.url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`HDR 请求失败：HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        if (token !== request || disposed) return;
        // 使用库解析；显式创建纹理使无效文件的异常和资源清理都留在此流程内。
        const data = new HDRLoader().parse(buffer);
        texture = new THREE.DataTexture(data.data, data.width, data.height, THREE.RGBAFormat, data.type);
        texture.colorSpace = THREE.LinearSRGBColorSpace;
        texture.minFilter = texture.magFilter = THREE.LinearFilter;
        texture.flipY = true;
        texture.generateMipmaps = false;
        texture.needsUpdate = true;
        nextTarget = pmrem.fromEquirectangular(texture);
      }
      scene.environment = id === 'room' ? roomTarget.texture : nextTarget?.texture ?? null;
      hdrTarget?.dispose();
      hdrTarget = nextTarget ?? null;
      current = id;
      notify(id === 'room' ? '默认室内' : id === 'none' ? '环境已关闭' : HDR_PRESETS.find((entry) => entry.id === id).name);
    } catch (error) {
      nextTarget?.dispose();
      if (token === request && !disposed) notify(`加载失败，保留原环境：${error.message}`);
    } finally {
      texture?.dispose();
    }
  }

  return {
    select,
    dispose() {
      disposed = true;
      request++;
      scene.environment = null;
      hdrTarget?.dispose();
      roomTarget.dispose();
      pmrem.dispose();
    },
  };
}

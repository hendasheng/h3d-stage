import * as THREE from 'three';

/**
 * sky-dome.js —— 渐变天穹（背景）。
 *
 * 结构照参考站 `projects.thibautfoussard.com/fog`：球体（BackSide）跟随相机，
 * 顶点拿世界坐标，片元按 `smoothstep(y ± smoothness, position)` 在顶色与底色之间渐变。
 *
 * 关键点：**底色 = 雾色、分界高度 = 雾面高度、过渡带 = 高度过渡带**，与雾用同一组参数。
 * 不同步的话雾会在天穹上"断掉"，看起来像一堵白墙而不是雾。
 *
 * 天穹**不吃雾注入**：它自己就是雾的边界，再叠一层会双重变白。
 *
 * 尺寸只有天穹半径一个常量，它有两头都会出错的约束：
 *   · 太小 → 几何会戳到球外面，那部分画面没有背景（实测半径 100 时，一块 z=-12 的板就出界）
 *   · 太大 → 球的下半球把整个世界包在"雾面以下"，画面整体刷白（实测半径 2500 时前半屏全白）
 * 所以取一个中间值。
 *
 * 更早的版本还有一块大圆地面（当雾的落点）和后墙 / 高度参考环，都已删除：
 * 后墙与圆环是臆造的（参考站没有），地面则是多余的遮挡，雾直接作用于模型与天穹即可。
 */

const DOME_RADIUS = 140;
const DOME_RENDER_ORDER = 9;

export function createSkyDome() {
  // 顶点：拿世界坐标（与雾注入同一个写法）
  // 片元：mixer = smoothstep(y - smoothness, y + smoothness, position)
  //       → 低于雾面为 1（底色），高于雾面为 0（顶色）
  const uniforms = {
    skyTop: { value: new THREE.Color(0x000000) },
    skyBottom: { value: new THREE.Color(0xffffff) },
    domePosition: { value: 0 },     // 与 fogPositionY 同步
    domeSmoothness: { value: 3 },   // 与 fogSmoothness 同步
  };

  const material = new THREE.ShaderMaterial({
    uniforms,
    side: THREE.BackSide,
    // 只写色不写深度：天穹是背景，不能去和实体抢深度
    depthWrite: false,
    // **不要** depthTest:false。那会让它在最后一个 pass 把整幅画面盖掉
    // （实测：加了之后所有像素都变成天穹色，模型全被抹掉）。参考站也是默认深度测试。
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 skyTop;
      uniform vec3 skyBottom;
      uniform float domePosition;
      uniform float domeSmoothness;
      varying vec3 vWorldPosition;
      void main() {
        float mixer = smoothstep(vWorldPosition.y - domeSmoothness, vWorldPosition.y + domeSmoothness, domePosition);
        gl_FragColor = vec4(mix(skyTop, skyBottom, mixer), 1.);
      }`,
  });

  const dome = new THREE.Mesh(new THREE.SphereGeometry(DOME_RADIUS, 36, 18), material);
  dome.name = 'h3d-sky-dome';
  dome.renderOrder = DOME_RENDER_ORDER;
  dome.frustumCulled = false;   // 它每帧跟着相机走，包围盒不参与剔除
  dome.visible = false;

  return {
    dome,
    /** 每帧跟随相机，保证任何角度都在"天空"里面 */
    followCamera(camera) {
      dome.position.copy(camera.position);
    },
    /** 由 createFog 按背景类型调用 */
    setVisible(v) { dome.visible = v; },
    /** 分界与雾保持同步（position / smoothness / 颜色） */
    sync({ position, smoothness, color, top }) {
      if (position !== undefined) uniforms.domePosition.value = position;
      if (smoothness !== undefined) uniforms.domeSmoothness.value = smoothness;
      if (color !== undefined) uniforms.skyBottom.value.set(color);
      if (top !== undefined) uniforms.skyTop.value.set(top);
    },
    dispose() {
      dome.geometry.dispose();
      material.dispose();
    },
  };
}

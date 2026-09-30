import * as THREE from 'three';

/**
 * fog.js —— 场景雾（0.5）
 *
 * ## 雾是**全局**的，不是材质效果
 *
 * 0.4 与 0.5 的第一版都用"给每个材质注入 shader"来做雾。这条路能做出来，但有一个
 * 绕不过去的性质：材质注入只改**实体表面**的像素。模型和相机之间的空间没有东西可以改，
 * 于是永远只能得到"模型表面浮着一层雾"——用户一眼就看出来了。
 *
 * 现在雾是一个**全屏后期 pass**（见 `src/fog-pass.js`）：每个像素用深度重建出世界坐标，
 * 雾作用在整个画面上。模型、模型周围的空间、远处一视同仁。
 *
 * ## 公式与 0.4 / 参考站完全一致，只是换了作用位置
 *
 *   verticalMixer = smoothstep(y - smoothness, y + smoothness, positionY + noiseOffset)
 *   depthMixer    = smoothstep(d + dSmooth, d - dSmooth, fogDepth)   → 再被 verticalMixer 门控
 *   mixer         = clamp(verticalMixer*.5 + depthMixer*.95, 0, 1) * enabled
 *
 * 三条与直觉相反的结论（写断言前先想清楚，别把公式本身当 bug）：
 *  1. 高度与深度是**相加加权**（*.5 + *.95），不是二选一混合。所以 verticalMixer=1 且
 *     depthMixer=0 时画面**已经**有 0.5 的雾量；两者同时饱和会被 clamp 到 1。
 *  2. 深度项被高度项**门控**：画面整体高于雾面时两项一起归零，这时怎么调 fogDepth 都没有雾。
 *  3. 高度是**世界坐标的绝对值**，不是"相对地面的高度"。
 *
 * 本模块只负责：背景（天穹/纯色/渐变）、参数解析、把参数写进 pass 的 uniforms。
 * 着色器本身在 `src/fog-pass.js`。
 */

export const BACKGROUND_MODES = [
  { text: '雾色（天穹）', value: 'dome' },
  { text: '纯色', value: 'flat' },
  { text: '上下渐变', value: 'gradient' },
];

/**
 * 背景渐变：用一个垂直渐变贴图当 scene.background。
 * canvas 与纹理**惰性创建**：纯色背景或非浏览器环境（Node 测试）下完全不碰 DOM。
 */
export function createGradientBackground() {
  const size = { w: 4, h: 256 };
  let canvas = null;
  let ctx = null;
  let texture = null;

  const ensure = () => {
    if (texture) return texture;
    canvas = document.createElement('canvas');
    canvas.width = size.w;
    canvas.height = size.h;
    ctx = canvas.getContext('2d');
    texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    return texture;
  };

  return {
    get texture() { return texture; },
    set(top, bottom) {
      ensure();
      const grad = ctx.createLinearGradient(0, 0, 0, size.h);
      grad.addColorStop(0, top);      // 画布顶部 = 画面上方
      grad.addColorStop(1, bottom);
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, size.w, size.h);
      texture.needsUpdate = true;
      return texture;
    },
    dispose() { texture?.dispose(); texture = null; canvas = null; ctx = null; },
  };
}

export const FOG_DEFAULTS = {
  enabled: true,
  color: '#ffffff',        // 雾色：混进画面的颜色，同时是天穹底部的颜色
  bgMode: 'dome',          // 'dome'（用天穹当背景，与雾同一分界） | 'flat' | 'gradient'
  bgColor: '#000000',      // 纯色背景（默认黑）
  bgTop: '#000000',        // 天穹顶部 / 渐变顶部
  bgBottom: '#ffffff',     // 渐变底部
  height: -2,              // fogPositionY：雾面高度（低于此处开始起雾）
  smoothness: 5,           // fogSmoothness：高度过渡带
  depth: 70,               // fogDepth：深度分界距离
  depthSmoothness: 25,     // fogDepthSmoothness：深度过渡带

  /* 动态雾 */
  dynamic: true,           // 关掉时噪声完全不参与，画面应回到静雾
  // 噪声把雾面高度上下推动多少（世界单位，**峰谷差**）。
  // 要和 smoothness 同量级才看得见：过渡带 5、强度 6 时约 14% 的像素会变。
  noiseStrength: 6,
  noiseScale: 0.06,        // 世界坐标 → 噪声 UV：1/0.06 ≈ 每 16.7 个单位一个噪声周期
  flowX: 0.012,            // 流动速度（噪声 UV/秒）
  flowY: 0.007,
  flowZ: 0.006,            // 第三轴也要流，竖直面上才不会整体平移
  warp: 0.35,              // domain warp：用一层噪声把采样位置推歪，流动才不规则
};

/**
 * 管理雾与背景。
 *
 * @param {THREE.Scene} scene
 * @param {object} [dome] 渐变天穹（src/sky-dome.js）；给了就与雾同步分界与颜色。
 *   天穹自带背景，所以 bgMode='dome' 时**不设** scene.background —— 设了会把天穹整个盖住。
 * @param {object} [pass] 全屏雾 pass（three 的 ShaderPass）。着色实际在那里发生；
 *   本模块只把参数写进它的 uniforms。**刻意做成参数而不是 import**，
 *   这样 `fog.js` 在 Node 测试里能独立加载。
 */
export function createFog(scene, dome = null, pass = null) {
  const gradient = createGradientBackground();
  scene.background = null;
  scene.fog = null;   // 不用 three 内置雾（它染不到背景，做不到全局）

  /** 当前设置，tick 与 update 共用 */
  let settings = { ...FOG_DEFAULTS };
  /** 已推进的流动时间（秒） */
  let time = 0;

  /**
   * 把设置写进 pass 的 uniforms。
   * 注意这里**没有** 0.4 那个"改了值但上传不上去"的坑：
   * 全屏 pass 每帧都重新读一遍 uniform，不需要换 cacheKey、也不需要重编译。
   */
  function writePass() {
    const u = pass?.uniforms;
    if (!u) return;
    u.uFogColor.value.set(settings.color);
    u.fogPositionY.value = settings.height;
    u.fogSmoothness.value = settings.smoothness;
    u.fogDepth.value = settings.depth;
    u.fogDepthSmoothness.value = settings.depthSmoothness;
    u.uFogEnabled.value = settings.enabled ? 1 : 0;
    u.fogNoiseScale.value = settings.noiseScale;
    u.fogNoiseStrength.value = settings.noiseStrength;
    u.uFogDynamic.value = settings.dynamic ? 1 : 0;
    u.fogFlow.value.set(settings.flowX, settings.flowY);
    if (u.fogFlowZ) u.fogFlowZ.value = settings.flowZ;
    u.fogWarp.value = settings.warp;
    u.uFogTime.value = time;
    if (settings.noiseTexture && u.uFogNoise.value !== settings.noiseTexture) {
      u.uFogNoise.value = settings.noiseTexture;
    }
  }

  return {
    /**
     * 应用设置。
     * @param {object} s 见 FOG_DEFAULTS（可额外给 noiseTexture）
     */
    update(s = {}) {
      settings = { ...settings, ...s };
      // 背景三选一。'dome' 交给渐变天穹（与雾同一分界），此时**必须把 scene.background 置空**，
      // 否则背景色会把天穹整个盖住。曾把纯色背景写成雾色，白雾连背景一起刷白 —— 两者独立。
      if (settings.bgMode === 'dome') {
        scene.background = null;
      } else if (settings.bgMode === 'gradient') {
        scene.background = gradient.set(settings.bgTop, settings.bgBottom);
      } else {
        scene.background = new THREE.Color(settings.bgColor);
      }
      // 天穹与雾面同步：分界用同一个 height/smoothness，底部用雾色，顶部用 bgTop。
      // 不同步的话雾会在天穹上"断掉"，看起来像一堵白墙而不是雾。
      dome?.setVisible(settings.bgMode === 'dome');
      dome?.sync({
        position: settings.height,
        smoothness: settings.smoothness,
        color: settings.color,
        top: settings.bgTop,
      });
      writePass();
      return settings;
    },
    /** 只更新参数（与 update 等价，保留这个名字以免调用方到处改） */
    tune(s = {}) {
      return this.update(s);
    },
    /**
     * 推进流动时间。**每帧调用**，只是把值写进 uniform。
     * 关掉动态时也照常累加：重新打开时不该从 0 跳一下。
     * @param {number} dt 秒
     */
    tick(dt) {
      if (!Number.isFinite(dt) || dt <= 0) return;
      // 取模避免长时间运行后浮点精度下降（噪声 UV 本来就能平铺，模掉不改变画面）
      time = (time + dt) % 3600;
      writePass();
    },
    /** 把流动时间归零（演出里"回到起始状态"用） */
    resetTime() {
      time = 0;
      writePass();
    },
    /** 供测试与调试读取 */
    get time() { return time; },
    get settings() { return settings; },
    /** 后接一个 pass（例如 pass 是在 createFog 之后才建好的） */
    attachPass(nextPass) {
      pass = nextPass;
      writePass();
    },
    dispose() {
      gradient.dispose();
      dome?.setVisible(false);   // 别把天穹留在可见状态（Node 测试里没有渲染循环去收拾）
    },
    get gradientTexture() { return gradient.texture; },
  };
}

import * as THREE from 'three';

/**
 * fog.js —— 场景雾（0.4）
 *
 * 目标：低处与远处融进雾色，往上、往近处逐渐清晰；背景交给渐变天穹
 * （`src/sky-dome.js`），天穹底 = 雾色、顶 = skyTop，用同一个 smoothstep 定位，
 * 于是"雾面"和"天空"是接得上的（这也是参考站的做法）。
 *
 * 雾只作用于**模型材质**：没有地面之类的落点，判断标准就是"模型本身有没有被雾染"。
 *
 * 实现方式：**逐行照抄参考站** https://projects.thibautfoussard.com/fog/ 的材质注入
 * （用 CDP 拦截它的 shaderSource 拿到原文）。公式见下面 attach() 的注释。
 *
 * 早先版本自己猜过两种模型（距离用内置 THREE.Fog、高度用注入；两者分属"模式"互不可见；外加
 * 一个"按高度分层"的混合系数），都与参考站不符，已全部废弃。
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
  color: '#ffffff',        // 雾色：注入公式混入的颜色，同时是天穹底部的颜色
  bgMode: 'dome',          // 'dome'（用天穹当背景，与雾同一分界） | 'flat' | 'gradient'
  bgColor: '#000000',      // 纯色背景（默认黑）
  bgTop: '#000000',        // 天穹顶部 / 渐变顶部
  bgBottom: '#ffffff',     // 渐变底部
  height: -2,              // fogPositionY：雾面高度（低于此处开始起雾）
  smoothness: 5,           // fogSmoothness：高度过渡带
  depth: 70,               // fogDepth：深度分界距离
  depthSmoothness: 25,     // fogDepthSmoothness：深度过渡带

  /* 以下为 0.5 的动态雾参数（见 NOTES.md 的「动态雾」） */
  dynamic: true,           // 关掉时噪声完全不参与，画面应与 0.4 逐像素一致
  // 噪声把雾面高度上下推动多少（世界单位，**峰谷差**）。
  // 这个值要和 smoothness（高度过渡带）同量级才看得出起伏：
  // 过渡带 5 宽、强度也是 5 时，雾界线会被推得明显起伏；
  // 早期默认 0.35（±0.17 对 10 宽的过渡带 = 1.7% 偏移）实测几乎看不出变化。
  noiseStrength: 6,
  noiseScale: 0.06,        // 世界坐标 → 噪声 UV 的缩放：1/0.06 ≈ 每 16.7 个单位一个噪声周期
  flowX: 0.012,            // 流动速度（噪声 UV/秒，沿 x）
  flowY: 0.007,            // 流动速度（噪声 UV/秒，沿 y）
  warp: 0.35,              // domain warp：用一层噪声把采样位置推歪，流动才不规则
};

/**
 * 管理雾与背景。update(settings, parts) 是设置应用的唯一入口。
 *
 * @param {THREE.Scene} scene
 * @param {object} [dome] 渐变天穹（src/sky-dome.js）；给了就与雾同步分界与颜色。
 *   天穹自带背景，所以 bgMode='dome' 时**不设** scene.background —— 设了会把天穹整个盖住。
 * @param {THREE.Texture} [noiseTexture] 无缝噪声贴图（src/fog-texture.js）。
 *   **故意做成参数而不是在这里 import**：`src/fog-texture.js` 用 `?url` 导入 PNG，
 *   那是 Vite 专有语法，Node 测试里会解析失败。测试传 `null` 或不传即可，
 *   动态雾本身照常可测（只断言噪声参与运算，不依赖真实贴图内容）。
 */
export function createFog(scene, dome = null, noiseTexture = null) {
  const gradient = createGradientBackground();
  scene.background = null;
  scene.fog = null;                       // 不用内置雾
  // 当前噪声贴图。**必须放在闭包里可变**：只在构造时写一次的话，
  // 之后传进来的贴图永远不会被绑上 sampler（踩过：探针里噪声恒定"没反应"，
  // 查到底才发现 uFogNoise 一直指向构造时的那个 null）。
  let noise = noiseTexture;

  /** 已注入的材质 → 共享 uniforms；始终是 Map，避免"已注入"分支拿到 null */
  const injected = new Map();
  /**
   * 共享 uniforms **只创建一次**，之后只改值。
   * 踩过：曾在每次 attach 时新建对象，而已编译的材质仍持有旧对象，
   * 于是"更新了参数但画面不动"（插桩看到 shader 里是 mix:0 / near:12 的旧值）。
   */
  const uniforms = {
    uFogColor: { value: new THREE.Color(FOG_DEFAULTS.color) },
    fogPositionY: { value: FOG_DEFAULTS.height },
    fogSmoothness: { value: FOG_DEFAULTS.smoothness },
    fogDepth: { value: FOG_DEFAULTS.depth },
    fogDepthSmoothness: { value: FOG_DEFAULTS.depthSmoothness },
    fogEnabled: { value: 0 },
    // 动态：噪声贴图 + 世界坐标缩放 + 起伏强度 + 已推进的"流动时间"
    uFogNoise: { value: noise },
    fogNoiseScale: { value: FOG_DEFAULTS.noiseScale },
    fogNoiseStrength: { value: FOG_DEFAULTS.noiseStrength },
    uFogTime: { value: 0 },
    fogDynamic: { value: FOG_DEFAULTS.dynamic ? 1 : 0 },
    fogFlow: { value: new THREE.Vector2(FOG_DEFAULTS.flowX, FOG_DEFAULTS.flowY) },
    fogWarp: { value: FOG_DEFAULTS.warp },
  };

  /**
   * 注入雾 —— 公式取自参考站（用 CDP 拦截它的 shaderSource 得到的原文）：
   *
   *   float verticalMixer = smoothstep(vWorldPosition.y - fogSmoothness,
   *                                    vWorldPosition.y + fogSmoothness, fogPositionY);
   *   float distanceToCamera = length(vWorldPosition - cameraPosition);
   *   float depthMixer = smoothstep(distanceToCamera + fogDepthSmoothness,
   *                                 distanceToCamera - fogDepthSmoothness, fogDepth);
   *   depthMixer = mix(0., depthMixer, verticalMixer);
   *   float mixer = verticalMixer * .5 + depthMixer * .95;
   *   mixer = clamp(mixer, 0., 1.);
   *   outgoingLight = mix(outgoingLight, vec3(1.), mixer);
   *
   * 注意：参考站的 varying 就叫 vWorldPosition，**我们不能照抄这个名字** —— three 自己的
   * 顶点着色器在 `ENV_WORLDPOS` 分支里已经声明了同名 varying，重名会让顶点着色器编译失败。
   * 我们用自己的 vH3dWorldPos，并在 main 开头赋值。
   *
   * 四个要点（我早先版本都做错了）：
   *  1. 高度与深度是**相加加权**（*.5 + *.95），不是二选一混合
   *  2. depthMixer 被 verticalMixer **门控**（高度以外的地方没有深度雾）
   *  3. 混入的是**纯白** vec3(1.)，不是雾色 uniform —— 我们改成混 uFogColor，
   *     默认值就是纯白，所以默认画面与参考站一致，同时"雾色"滑块才有意义
   *  4. 混入量还要乘 fogEnabled 才能关掉（参考站用宏判断）
   *
   * 动态化（0.5，见 NOTES.md 的「动态雾」）：
   *   · 噪声来自**贴图**而不是现算 —— 雾注入到每个材质上，现算噪声每像素都要付一遍代价
   *   · 噪声只扰动**雾面高度**（`fogPositionY + noiseOffset`），公式其余部分一概不动，
   *     所以关掉动态时画面与 0.4 逐像素一致
   *   · 沿时间轴平移采样坐标 = 雾自己流动；再做一次低成本 domain warp 让流动不规则
   */
  function attach(parts) {
    const code = `
      // 噪声：取世界 xz 平面作为雾的"地面"（雾面是水平的，沿 xz 铺开才对）
      vec2 noiseUv = vH3dWorldPos.xz * fogNoiseScale + vec2(uFogTime * fogFlow.x, uFogTime * fogFlow.y);
      // domain warp：用第一层噪声把采样位置推歪，得到不规则、不同步的流动
      vec2 warpOffset = texture2D(uFogNoise, noiseUv * 0.37).rg - 0.5;
      float noise = texture2D(uFogNoise, noiseUv + warpOffset * fogWarp).r;
      float noiseOffset = (noise - 0.5) * fogNoiseStrength * fogDynamic;

      float verticalMixer = smoothstep(vH3dWorldPos.y - fogSmoothness, vH3dWorldPos.y + fogSmoothness, fogPositionY + noiseOffset);
      float distanceToCamera = length(vH3dWorldPos - cameraPosition);
      float depthMixer = smoothstep(distanceToCamera + fogDepthSmoothness, distanceToCamera - fogDepthSmoothness, fogDepth);
      depthMixer = mix(0., depthMixer, verticalMixer);
      float mixer = verticalMixer * .5 + depthMixer * .95;
      mixer = clamp(mixer, 0., 1.) * fogEnabled;
      outgoingLight = mix(outgoingLight, uFogColor, mixer);`;

    /**
     * `outgoingLight` 的合成写法**每种材质都不一样**，只认一种就会静默漏掉其它材质：
     *   Standard/Physical  totalDiffuse + totalSpecular + totalEmissiveRadiance   ← 最初的唯一注入点
     *   Basic              reflectedLight.indirectDiffuse
     *   Lambert/Toon       reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance
     *   Phong              …directDiffuse + indirectDiffuse + directSpecular + indirectSpecular + totalEmissiveRadiance
     *   Matcap             diffuseColor.rgb * matcapColor.rgb
     *   Points/Sprite/Line vec3( 0.0 );  后接 outgoingLight = diffuseColor.rgb;
     *
     * 踩过的坑：探测场景用 MeshBasicMaterial 渲染，而 Basic 不在名单里，于是"注入命中了、
     * 参数也挂上了，画面一动不动"——因为注入的那行根本没插进去。全部列上，一个都不许漏。
     */
    const OUTGOING_LINES = [
      'vec3 outgoingLight = totalDiffuse + totalSpecular + totalEmissiveRadiance;',
      'vec3 outgoingLight = reflectedLight.indirectDiffuse;',
      'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + totalEmissiveRadiance;',
      'vec3 outgoingLight = reflectedLight.directDiffuse + reflectedLight.indirectDiffuse + reflectedLight.directSpecular + reflectedLight.indirectSpecular + totalEmissiveRadiance;',
      'vec3 outgoingLight = diffuseColor.rgb * matcapColor.rgb;',
      'outgoingLight = diffuseColor.rgb;',
    ];

    const materials = [...new Set(parts.map((p) => p.material).filter(Boolean))];
    for (const material of materials) {
      if (material.userData.__fogAttached) continue;   // 已注入：update 里更新 uniforms 的值即可
      const prevCompile = material.onBeforeCompile;
      const prevKey = material.customProgramCacheKey;
      material.onBeforeCompile = (shader) => {
        prevCompile?.call(material, shader);
        Object.assign(shader.uniforms, uniforms);
        // 顶点：世界坐标 varying。
        // **名字必须自己起**：three 的顶点着色器在 `ENV_WORLDPOS` 分支里已经声明过
        // `varying vec3 vWorldPosition;`（envmap 相关），重名会让顶点着色器编译失败
        // （GLSL 不允许重复声明 varying）。而顶点一挂，片元里读到的一直是 0 —— 表现为
        // "注入看起来命中了、参数却完全不动画面"。踩过。
        shader.vertexShader = shader.vertexShader
          .replace('void main() {', 'varying vec3 vH3dWorldPos;\nvoid main() {\n\tvH3dWorldPos = (modelMatrix * vec4(position, 1.0)).xyz;');
        let fragment = shader.fragmentShader.replace(
          '#include <common>',
          // 声明必须与代码里用到的 uniform 完全一致：少一个就编译失败（踩过，整块渲白）
          '#include <common>\n'
          + 'varying vec3 vH3dWorldPos;\n'
          + 'uniform vec3 uFogColor;\n'
          + 'uniform float fogPositionY;\n'
          + 'uniform float fogSmoothness;\n'
          + 'uniform float fogDepth;\n'
          + 'uniform float fogDepthSmoothness;\n'
          + 'uniform float fogEnabled;\n'
          + 'uniform sampler2D uFogNoise;\n'
          + 'uniform float fogNoiseScale;\n'
          + 'uniform float fogNoiseStrength;\n'
          + 'uniform float uFogTime;\n'
          + 'uniform float fogDynamic;\n'
          + 'uniform vec2 fogFlow;\n'
          + 'uniform float fogWarp;'
        );
        for (const line of OUTGOING_LINES) {
          if (!fragment.includes(line)) continue;
          fragment = fragment.replace(line, `${line}\n${code}`);
        }
        // 一个注入点都没命中 = 这片材质上**根本没有雾**。以前是静默跳过，于是"看起来接好了、
        // 画面纹丝不动"，很难查。这里必须出声，把材质类型打出来。
        if (!fragment.includes('verticalMixer')) {
          console.error('[fog] 注入失败：没找到 outgoingLight 合成行，该材质不会有雾', {
            type: material.type,
            name: material.name,
          });
        }
        shader.fragmentShader = fragment;
      };
      material.customProgramCacheKey = () => `${prevKey?.call(material) ?? ''}|h3d-fog|${stateKey()}`;
      material.userData.__fogAttached = true;
      material.userData.__fogPrevCompile = prevCompile;
      material.userData.__fogPrevKey = prevKey;
      material.needsUpdate = true;
      injected.set(material, uniforms);
    }
    return uniforms;
  }

  /**
   * 参数指纹。
   *
   * **这是整个雾模块最容易踩死的坑**：three 的 `getUniformList()` 会把「程序里哪些 uniform
   * 需要上传」这张表**缓存在材质上**，而程序是按 `customProgramCacheKey` 缓存的。
   * 固定 cacheKey ⇒ 程序只编译一次 ⇒ 之后不管怎么改 `uniforms.xxx.value`，
   * three 都不会再上传（`seqWithValue` 拿的是编译当时那一刻的值）。表现就是
   * 「注入明明命中了、uniform 现场值也是新的，画面一动不动」（真实页面实测 avg 恒为 188.71）。
   *
   * 参考站也有同样的结构性问题，只是它用 Leva 的初值渲染，从不在运行时改，所以看不出来。
   *
   * 对策：把参数值编进 cacheKey，值一变就换一个程序（= 重新编译 + 重新建 uniform 表）。
   * 材质数量是本项目的量级（百来个），拖滑块时重编译可以接受；换来的是"参数真的有效"。
   */
  function stateKey() {
    const u = uniforms;
    return [
      u.fogPositionY.value, u.fogSmoothness.value, u.fogDepth.value,
      u.fogDepthSmoothness.value, u.fogEnabled.value, u.uFogColor.value.getHexString(),
      // 动态雾的三个参数也进指纹：它们靠 uniform 传值，同样受"值变了必须换程序"的约束。
      // uFogTime / uFogNoise 除外 —— 前者每帧都在变，进指纹等于每帧重编译；
      // 后者是贴图句柄，运行期不动。
      u.fogDynamic.value, u.fogNoiseStrength.value, u.fogNoiseScale.value,
      u.fogFlow.value.x, u.fogFlow.value.y, u.fogWarp.value,
    ].join(',');
  }

  /** 把设置写进 uniform（值变了就强制重编译，原因见 stateKey()） */
  function bindUniforms(s) {
    const u = uniforms;
    const before = stateKey();
    if (s.noiseTexture) noise = s.noiseTexture;
    if (u.uFogNoise.value !== noise) u.uFogNoise.value = noise;
    u.uFogColor.value.set(s.color);
    u.fogPositionY.value = s.height;
    u.fogSmoothness.value = s.smoothness;
    u.fogDepth.value = s.depth;
    u.fogDepthSmoothness.value = s.depthSmoothness;
    u.fogEnabled.value = s.enabled ? 1 : 0;
    u.fogNoiseStrength.value = s.noiseStrength;
    u.fogNoiseScale.value = s.noiseScale;
    u.fogDynamic.value = s.dynamic ? 1 : 0;
    u.fogFlow.value.set(s.flowX, s.flowY);
    u.fogWarp.value = s.warp;
    // 贴图句柄也进指纹：换了贴图必须重编译，否则 sampler 还指着旧的那张
    if (u.uFogNoise.value !== noise) {
      u.uFogNoise.value = noise;
      for (const material of injected.keys()) material.needsUpdate = true;
    }
    // 值有任何变化都要让已注入的材质重编译 —— 否则 three 不会把新值传上去
    if (stateKey() !== before) {
      for (const material of injected.keys()) material.needsUpdate = true;
    }
  }

  /** 撤掉注入（材质恢复干净） */
  function detach() {
    for (const material of injected.keys()) {
      if (material.userData.__fogPrevCompile) material.onBeforeCompile = material.userData.__fogPrevCompile;
      else delete material.onBeforeCompile;
      if (material.userData.__fogPrevKey) material.customProgramCacheKey = material.userData.__fogPrevKey;
      else delete material.customProgramCacheKey;
      delete material.userData.__fogAttached;
      delete material.userData.__fogPrevCompile;
      delete material.userData.__fogPrevKey;
      material.needsUpdate = true;
    }
    injected.clear();
  }

  /** 补齐设置（现在没有模式分支：公式与参考站一致，四种参数始终同时生效） */
  const resolve = (settings = {}) => ({ ...FOG_DEFAULTS, ...settings });

  return {
    /**
     * 应用设置。parts 用来定位要注入的材质。
     * @param {object} settings 见 FOG_DEFAULTS
     * @param {Array} parts
     */
    update(settings, parts = []) {
      const s = resolve(settings);
      if (s.noiseTexture) noise = s.noiseTexture;
      // 背景三选一。'dome' 交给渐变天穹（与雾同一分界），此时**必须把 scene.background 置空**，
      // 否则背景色会把天穹整个盖住。曾把纯色背景写成雾色，白雾连背景一起刷白 —— 两者独立。
      if (s.bgMode === 'dome') {
        scene.background = null;
      } else if (s.bgMode === 'gradient') {
        scene.background = gradient.set(s.bgTop, s.bgBottom);
      } else {
        scene.background = new THREE.Color(s.bgColor);
      }
      // 天穹与雾面同步：分界用同一个 height/smoothness，底部用雾色，顶部用 bgTop。
      // 不同步的话雾会在天穹上"断掉"，看起来像一堵白墙而不是雾。
      dome?.setVisible(s.bgMode === 'dome');
      dome?.sync({
        position: s.height,
        smoothness: s.smoothness,
        color: s.color,
        top: s.bgTop,
      });
      if (parts.length) attach(parts);
      bindUniforms(s);
      return s;
    },
    /** 只更新参数（材质已注入过时最省，不触发重编译） */
    tune(settings) {
      bindUniforms(resolve(settings));
      return true;
    },
    /**
     * 推进流动时间。**每帧调用**，只是改 uniform 的值 —— 不进 cacheKey，所以不会重编译。
     * 关掉动态时也照常累加：重新打开时不该从 0 跳一下。
     * @param {number} dt 秒
     */
    tick(dt) {
      if (!Number.isFinite(dt) || dt <= 0) return;
      // 取模避免长时间运行后浮点精度下降（噪声 UV 本来就能平铺，模掉不改变画面）
      uniforms.uFogTime.value = (uniforms.uFogTime.value + dt) % 3600;
    },
    /** 把流动时间归零（演出里"回到起始状态"用） */
    resetTime() {
      uniforms.uFogTime.value = 0;
    },
    /** 当前流动时间，供测试与调试读取 */
    get time() { return uniforms.uFogTime.value; },
    dispose() {
      detach();
      gradient.dispose();
      dome?.setVisible(false);   // 别把天穹留在可见状态（Node 测试里没有渲染循环去收拾）
    },
    get gradientTexture() { return gradient.texture; },
  };
}

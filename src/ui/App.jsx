/**
 * ui/App.jsx —— 界面全部用库实现，不再手搓 DOM。
 *   · 左侧「标题 + 部件列表」：Preact 组件 + @preact/signals 响应式状态
 *   · 右侧控制项：Tweakpane
 */
import { useComputed } from '@preact/signals';
import { Pane } from 'tweakpane';
import { useEffect, useRef } from 'preact/hooks';
import { store, touch } from './store.js';
import { VERSION } from './version.js';
import { maxClassId } from '../main.js';

/* ================================================================== */
/* 右列：Tweakpane 控制参数                                  */
/* ================================================================== */

function TweakpaneControls() {
  const paneHost = useRef(null);

  useEffect(() => {
    const params = {
      model: store.models[0] ?? '',
      classColors: store.classColors.value,
      baseColor: store.baseColor.value,
      explode: store.explode.value,
      wireframe: store.wireframe.value,
      spin: store.spin.value,
      showGrid: store.showGrid.value,
      bloomEnabled: store.bloomEnabled.value,
      bloomStrength: store.bloomStrength.value,
      bloomRadius: store.bloomRadius.value,
      bloomThreshold: store.bloomThreshold.value,
      gtaoEnabled: store.gtaoEnabled.value,
      gtaoIntensity: store.gtaoIntensity.value,
      gtaoRadius: store.gtaoRadius.value,
      fogEnabled: store.fogEnabled.value,
      fogColor: store.fogColor.value,
      fogBgMode: store.fogBgMode.value,
      fogBgColor: store.fogBgColor.value,
      fogBgTop: store.fogBgTop.value,
      fogBgBottom: store.fogBgBottom.value,
      fogHeight: store.fogHeight.value,
      fogSmoothness: store.fogSmoothness.value,
      fogDepth: store.fogDepth.value,
      fogDepthSmoothness: store.fogDepthSmoothness.value,
      environment: store.environment.value,
      environmentIntensity: store.environmentIntensity.value,
      lightIntensity: store.lightIntensity.value,
      shadowSoftness: store.shadowSoftness.value,
      environmentStatus: store.environmentStatus.value,
      glowInput: Number(store.glowInput.value) || 0,
      glowDuration: store.glowDuration.value,
      glowPeak: store.glowPeak.value,
      glowColor: store.glowColor.value,
    };

    const pane = new Pane({ container: paneHost.current, title: '控制', expanded: true });

    const fModel = pane.addFolder({ title: '模型', expanded: true });
    fModel.addBinding(params, 'model', {
      label: '文件',
      // 选项来自 src/assets/models/ 的实际内容（main.js 启动时枚举）
      options: Object.fromEntries(store.models.map((m) => [m, m])),
    }).on('change', (ev) => { store.model.value = ev.value; });

    const fMat = pane.addFolder({ title: '材质', expanded: true });
    // 选色器在控制列内展开，避免默认 popup 被右侧滚动容器裁切而无法点击。
    fMat.addBinding(params, 'baseColor', { label: '基础颜色', picker: 'inline' })
      .on('change', (ev) => { store.baseColor.value = ev.value; });
    fMat.addBinding(params, 'classColors', { label: 'class 分色' })
      .on('change', (ev) => { store.classColors.value = ev.value; });

    // 场景：世界网格等环境元素（不属于模型本身）
    const fScene = pane.addFolder({ title: '场景', expanded: true });
    fScene.addBinding(params, 'showGrid', { label: '世界网格' })
      .on('change', (ev) => { store.showGrid.value = ev.value; });
    const environmentBinding = fScene.addBinding(params, 'environment', {
      label: '环境', options: store.environmentOptions,
    }).on('change', (ev) => {
      if (ev.value !== store.environment.value) void store.handlers.selectEnvironment(ev.value);
    });
    let environmentOptions = store.environmentOptions;
    fScene.addBinding(params, 'environmentStatus', { label: 'HDR 状态', readonly: true });
    fScene.addBinding(params, 'environmentIntensity', { label: '环境亮度', min: 0, max: 5, step: 0.01 })
      .on('change', (ev) => { store.environmentIntensity.value = ev.value; });
    fScene.addBinding(params, 'lightIntensity', { label: '辅助灯亮度', min: 0, max: 3, step: 0.01 })
      .on('change', (ev) => { store.lightIntensity.value = ev.value; });
    fScene.addBinding(params, 'shadowSoftness', { label: '投影柔化', min: 0, max: 8, step: 0.1 })
      .on('change', (ev) => { store.shadowSoftness.value = ev.value; });

    const fBloom = fScene.addFolder({ title: '辉光', expanded: true });
    fBloom.addBinding(params, 'bloomEnabled', { label: '开启' })
      .on('change', (ev) => { store.bloomEnabled.value = ev.value; });
    fBloom.addBinding(params, 'bloomStrength', { label: '强度', min: 0, max: 3, step: 0.01 })
      .on('change', (ev) => { store.bloomStrength.value = ev.value; });
    fBloom.addBinding(params, 'bloomRadius', { label: '范围', min: 0, max: 1, step: 0.01 })
      .on('change', (ev) => { store.bloomRadius.value = ev.value; });
    fBloom.addBinding(params, 'bloomThreshold', { label: '亮度阈值', min: 0, max: 10, step: 0.01 })
      .on('change', (ev) => { store.bloomThreshold.value = ev.value; });

    const fGtao = fScene.addFolder({ title: '接触遮蔽', expanded: true });
    fGtao.addBinding(params, 'gtaoEnabled', { label: '开启' })
      .on('change', (ev) => { store.gtaoEnabled.value = ev.value; });
    fGtao.addBinding(params, 'gtaoIntensity', { label: '强度', min: 0, max: 2, step: 0.01 })
      .on('change', (ev) => { store.gtaoIntensity.value = ev.value; });
    fGtao.addBinding(params, 'gtaoRadius', { label: '范围', min: 0.05, max: 2, step: 0.01 })
      .on('change', (ev) => { store.gtaoRadius.value = ev.value; });

    // 雾：公式与参考站一致（高度项与深度项相加加权，见 src/fog.js），四个参数始终同时生效。
    // 雾只作用于模型材质；背景由「背景」子文件夹决定（默认渐变天穹，与雾同一分界）。
    const fFog = fScene.addFolder({ title: '雾', expanded: true });
    fFog.addBinding(params, 'fogEnabled', { label: '开启' })
      .on('change', (ev) => { store.fogEnabled.value = ev.value; });
    fFog.addBinding(params, 'fogColor', { label: '雾色', picker: 'inline' })
      .on('change', (ev) => { store.fogColor.value = ev.value; });

    const fFogBg = fFog.addFolder({ title: '背景', expanded: true });
    fFogBg.addBinding(params, 'fogBgMode', {
      label: '类型', options: { '天穹（与雾同分界）': 'dome', 纯色: 'flat', 上下渐变: 'gradient' },
    }).on('change', (ev) => { store.fogBgMode.value = ev.value; });
    fFogBg.addBinding(params, 'fogBgColor', { label: '纯色', picker: 'inline' })
      .on('change', (ev) => { store.fogBgColor.value = ev.value; });
    fFogBg.addBinding(params, 'fogBgTop', { label: '天穹·顶 / 渐变·上', picker: 'inline' })
      .on('change', (ev) => { store.fogBgTop.value = ev.value; });
    fFogBg.addBinding(params, 'fogBgBottom', { label: '渐变·下', picker: 'inline' })
      .on('change', (ev) => { store.fogBgBottom.value = ev.value; });

    const fFogHeight = fFog.addFolder({ title: '高度项', expanded: true });
    fFogHeight.addBinding(params, 'fogHeight', { label: '雾面高度', min: -40, max: 40, step: 0.1 })
      .on('change', (ev) => { store.fogHeight.value = ev.value; });
    fFogHeight.addBinding(params, 'fogSmoothness', { label: '高度过渡带', min: 0.1, max: 40, step: 0.1 })
      .on('change', (ev) => { store.fogSmoothness.value = ev.value; });

    const fFogDepth = fFog.addFolder({ title: '深度项', expanded: true });
    fFogDepth.addBinding(params, 'fogDepth', { label: '雾的深度', min: 0, max: 300, step: 1 })
      .on('change', (ev) => { store.fogDepth.value = ev.value; });
    fFogDepth.addBinding(params, 'fogDepthSmoothness', { label: '深度过渡带', min: 0.1, max: 100, step: 0.1 })
      .on('change', (ev) => { store.fogDepthSmoothness.value = ev.value; });

    const fPart = pane.addFolder({ title: '每个部件', expanded: true });
    fPart.addBinding(params, 'explode', { label: '炸开距离', min: 0, max: 2, step: 0.01 })
      .on('change', (ev) => { store.explode.value = ev.value; });
    fPart.addBinding(params, 'wireframe', { label: '线框' })
      .on('change', (ev) => { store.wireframe.value = ev.value; });
    fPart.addBinding(params, 'spin', { label: '自动旋转' })
      .on('change', (ev) => { store.spin.value = ev.value; });

    const fGlow = pane.addFolder({ title: '发光', expanded: true });
    const hasClassRange = () => store.parts.length > 0 && maxClassId() > 0;
    let glowInputBinding = null;
    const setGlowInput = (raw) => {
      const max = maxClassId();
      const value = Math.min(max, Math.max(0, Math.round(Number(raw))));
      if (!Number.isFinite(value)) return;
      params.glowInput = value;
      store.glowInput.value = String(value);
    };
    const ensureGlowInputBinding = () => {
      if (glowInputBinding || !hasClassRange()) return;
      params.glowInput = Math.min(params.glowInput, maxClassId());
      glowInputBinding = fGlow.addBinding(params, 'glowInput', {
        label: `class 编号 0-${maxClassId()}`,
        min: 0,
        max: maxClassId(),
        step: 1,
      }).on('change', (ev) => {
        setGlowInput(ev.value);
        pane.refresh();
      });
    };
    ensureGlowInputBinding();
    fGlow.addButton({ title: '触发' }).on('click', () => {
      store.handlers.triggerGlow?.(params.glowInput);
    });
    fGlow.addBinding(params, 'glowDuration', { label: '长度(秒)', min: 0, max: 5, step: 0.001 })
      .on('change', (ev) => { store.glowDuration.value = ev.value; });
    fGlow.addBinding(params, 'glowPeak', { label: '发光强度', min: 0, max: 50, step: 0.1 })
      .on('change', (ev) => { store.glowPeak.value = ev.value; });
    fGlow.addBinding(params, 'glowColor', { label: '发光颜色', picker: 'inline' })
      .on('change', (ev) => { store.glowColor.value = ev.value; });

    // main.js 通过这个句柄把外部改动同步回面板显示
    store.ui = {
      refresh() { pane.refresh(); },
      syncParams() {
        params.model = store.model.value || params.model;
        params.explode = store.explode.value;
        params.classColors = store.classColors.value;
        params.baseColor = store.baseColor.value;
        params.wireframe = store.wireframe.value;
        params.spin = store.spin.value;
        params.showGrid = store.showGrid.value;
        params.bloomEnabled = store.bloomEnabled.value;
        params.bloomStrength = store.bloomStrength.value;
        params.bloomRadius = store.bloomRadius.value;
        params.bloomThreshold = store.bloomThreshold.value;
        params.gtaoEnabled = store.gtaoEnabled.value;
        params.gtaoIntensity = store.gtaoIntensity.value;
        params.gtaoRadius = store.gtaoRadius.value;
        params.fogEnabled = store.fogEnabled.value;
        params.fogColor = store.fogColor.value;
        params.fogBgMode = store.fogBgMode.value;
        params.fogBgColor = store.fogBgColor.value;
        params.fogBgTop = store.fogBgTop.value;
        params.fogBgBottom = store.fogBgBottom.value;
        params.fogHeight = store.fogHeight.value;
        params.fogSmoothness = store.fogSmoothness.value;
        params.fogDepth = store.fogDepth.value;
        params.fogDepthSmoothness = store.fogDepthSmoothness.value;
        params.environment = store.environment.value;
        params.environmentStatus = store.environmentStatus.value;
        params.environmentIntensity = store.environmentIntensity.value;
        params.lightIntensity = store.lightIntensity.value;
        params.shadowSoftness = store.shadowSoftness.value;
        if (environmentOptions !== store.environmentOptions) {
          environmentOptions = store.environmentOptions;
          environmentBinding.options = environmentOptions;
        }
        params.glowDuration = store.glowDuration.value;
        params.glowPeak = store.glowPeak.value;
        params.glowColor = store.glowColor.value;
        ensureGlowInputBinding();
        if (glowInputBinding) setGlowInput(store.glowInput.value);
        pane.refresh();
      },
    };

    return () => { pane.dispose(); store.ui = null; };
  }, []);

  return <div class="tp-wrap" ref={paneHost} />;
}

/* ================================================================== */
/* 左列：模型信息（路径 / 结构 / 诊断，由 main.js 直接写 DOM）            */
/* ================================================================== */

function ModelInfo() {
  const collapsed = useComputed(() => store.statsCollapsed.value);
  const statsHost = useRef(null);
  const diagHost = useRef(null);
  return (
    <div class={'panel' + (collapsed.value ? ' collapsed' : '')} id="stats">
      <div class="head" onClick={() => { store.statsCollapsed.value = !collapsed.value; }}>
        <button class="collapse-btn" title={collapsed.value ? '展开模型信息' : '收起模型信息'}>
          {collapsed.value ? '▸' : '▾'}
        </button>
        <b>模型信息</b>
      </div>
      <div class="stats-content">
        <h3>模型</h3>
        <div ref={statsHost} id="statsBody" />
        <h3>结构诊断</h3>
        <div ref={diagHost} id="diagBody" />
      </div>
    </div>
  );
}

/* ================================================================== */
/* 左列：标题                                                          */
/* ================================================================== */

function TitlePanel() {
  const info = useComputed(() => store.info.value);
  const v = info.value;
  return (
    <div class="panel" id="title">
      <h1>h3d-stage<span class="ver" id="ver">v{VERSION}</span></h1>
      {/* 模型名取实际加载的文件名，不写死 */}
      <div class="sub model">{v.model || '加载中…'}</div>
      <div class="sub key">{v.summary}</div>
      <div class="sub">{v.selection}</div>
      <div class="sub">{v.debug}</div>
    </div>
  );
}

/* ================================================================== */
/* 左列：部件列表                                                       */
/* ================================================================== */

function PartsList() {
  const collapsed = useComputed(() => store.partsCollapsed.value);
  const filter = useComputed(() => store.filter.value);
  const rev = useComputed(() => store.rev.value);
  const selected = useComputed(() => store.selected.value);

  // rev 参与依赖，保证显隐/选中变化后重新计算
  const rows = useComputed(() => {
    void rev.value;
    const kw = filter.value.trim().toLowerCase();
    const out = [];
    store.parts.forEach((p, i) => {
      if (kw && !p.name.toLowerCase().includes(kw)) return;
      out.push({ p, i });
    });
    return out;
  }).value;

  const total = store.parts.length;

  return (
    <div class={'panel' + (collapsed.value ? ' collapsed' : '')} id="parts">
      <div class="head" onClick={() => { store.partsCollapsed.value = !collapsed.value; }}>
        <button class="collapse-btn" title={collapsed.value ? '展开部件列表' : '收起部件列表'}>
          {collapsed.value ? '▸' : '▾'}
        </button>
        <b>{collapsed.value ? '展开列表' : '部件列表'}</b>
        <span class="hint">点击行选中，圆点显隐</span>
        <span class="count">{total} 个部件</span>
      </div>
      <div class="tools">
        <input
          type="search"
          placeholder="按名称过滤…"
          value={filter.value}
          onInput={(e) => { store.filter.value = e.currentTarget.value; }}
        />
      </div>
      <div id="partlist">
        {rows.map(({ p, i }) => (
          <div
            class={'row' + (selected.value === i ? ' active' : '') + (p.visible ? '' : ' hidden-part')}
            key={p.name + i}
            onClick={() => store.handlers.select?.(i)}
          >
            <span
              class="eye"
              title="显示 / 隐藏这个部件"
              onClick={(e) => {
                e.stopPropagation();
                p.visible = !p.visible;
                store.handlers.visibility?.(i, p.visible);
                touch();
              }}
            >
              {p.visible ? '●' : '○'}
            </span>
            <span class="swatch" style={{ background: '#' + (p.material?.color?.getHexString?.() ?? '666666') }} />
            <span class="nm">{p.name}</span>
            <span class="meta">{p.triangleCount}△</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ================================================================== */

export function App() {
  return (
    <>
      <style>{COMPONENT_CSS}</style>
      <div id="mount">
        <div id="left">
          <TitlePanel />
          <ModelInfo />
          <PartsList />
        </div>
        <div id="right">
          <TweakpaneControls />
        </div>
      </div>
    </>
  );
}

/* 组件自己的样式（外壳样式在 src/base.css） */
const COMPONENT_CSS = `
/* ---------- 标题 ---------- */
#title { padding: 11px 14px; flex: none; }
#title h1 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 14px; letter-spacing: .3px; }
#title h1 .ver {
  font: 600 10px/1 Consolas, monospace; color: #7fe3a0; background: #14351f;
  border: 1px solid #2c6b3f; border-radius: 4px; padding: 3px 5px; letter-spacing: .5px;
}
#title .sub { margin-top: 5px; color: var(--muted); font-size: 11.5px; font-family: Consolas, monospace;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#title .sub.model { color: var(--text); font-size: 13px; font-weight: 600; margin-top: 7px; }
#title .sub.key { color: var(--accent); font-size: 12.5px; margin-top: 4px; }

/* ---------- 模型信息 ---------- */
#stats { display: flex; flex: 0 1 46%; min-height: 42px; overflow: hidden; padding: 0; }
#stats .head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex: none; cursor: pointer; }
#stats:not(.collapsed) { flex-direction: column; }
#stats:not(.collapsed) .head { border-bottom: 1px solid var(--line); }
#stats .stats-content { flex: 1; min-height: 0; overflow-y: auto; padding: 0 12px 12px; }
#stats.collapsed { flex: none; }
#stats.collapsed .stats-content { display: none; }

/* ---------- 部件列表 ---------- */
#parts { display: flex; flex-direction: column; overflow: hidden; flex: 1 1 0; min-height: 44px; max-height: none; }
#parts .head { display: flex; align-items: center; gap: 8px; padding: 8px 12px; flex: none; white-space: nowrap; cursor: pointer; }
#parts:not(.collapsed) .head { border-bottom: 1px solid var(--line); }
#parts .head .hint { margin: 0; font-size: 11px; }
#parts .head .count { margin-left: auto; color: var(--muted); font-size: 11px; }
.collapse-btn {
  flex: none; width: 20px; height: 20px; line-height: 1; padding: 0;
  background: #1a2029; color: var(--muted); border: 1px solid var(--line);
  border-radius: 5px; cursor: pointer; font-family: inherit; font-size: 10px;
}
.collapse-btn:hover { color: var(--text); border-color: #3b4757; }

/* 收起：列表缩成小胶囊，宽度也跟着收 */
#parts.collapsed { flex: none; width: fit-content; align-self: flex-start; border-radius: 999px; }
#parts.collapsed .tools, #parts.collapsed #partlist, #parts.collapsed .head .hint { display: none; }
#parts.collapsed .head { padding: 6px 12px; gap: 6px; }

#parts .tools { display: flex; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--line); flex: none; }
#parts .tools input {
  flex: 1; min-width: 0; background: #0b0e12; border: 1px solid var(--line);
  color: var(--text); border-radius: 6px; padding: 5px 8px; font-size: 12px; outline: none; font-family: inherit;
}
#parts .tools input:focus { border-color: var(--accent); }
#partlist { overflow-y: auto; flex: 1; padding: 4px; }
#partlist::-webkit-scrollbar { width: 9px; }
#partlist::-webkit-scrollbar-thumb { background: #2c3542; border-radius: 5px; }
#partlist::-webkit-scrollbar-track { background: transparent; }

.row { display: flex; align-items: center; gap: 8px; padding: 5px 8px; border-radius: 6px; cursor: pointer; white-space: nowrap; }
.row:hover { background: #1b222c; }
.row.active { background: #16323f; box-shadow: inset 0 0 0 1px var(--accent); }
.row.hidden-part .nm { opacity: .35; text-decoration: line-through; }
.swatch { width: 10px; height: 10px; border-radius: 3px; flex: none; }
.nm { flex: 1; overflow: hidden; text-overflow: ellipsis; font-family: Consolas, monospace; font-size: 12px; }
.meta { color: var(--muted); font-size: 11px; flex: none; }
.eye { flex: none; opacity: .5; font-size: 11px; width: 14px; text-align: center; }
.eye:hover { opacity: 1; }

/* ---------- 诊断 ---------- */
.diag { margin: 6px 0 0; padding: 0; list-style: none; }
.diag li { display: flex; gap: 7px; padding: 4px 0; font-size: 12px; align-items: flex-start; }
.diag .dot { flex: none; margin-top: 6px; width: 6px; height: 6px; border-radius: 50%; }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.info { background: var(--accent); }
.dot.bad { background: var(--bad); }
`;

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
    fMat.addBinding(params, 'baseColor', { label: '基础颜色' })
      .on('change', (ev) => { store.baseColor.value = ev.value; });
    fMat.addBinding(params, 'classColors', { label: 'class 分色' })
      .on('change', (ev) => { store.classColors.value = ev.value; });

    // 场景：世界网格等环境元素（不属于模型本身）
    const fScene = pane.addFolder({ title: '场景', expanded: true });
    fScene.addBinding(params, 'showGrid', { label: '世界网格' })
      .on('change', (ev) => { store.showGrid.value = ev.value; });

    const fPart = pane.addFolder({ title: '每个部件', expanded: true });
    fPart.addBinding(params, 'explode', { label: '炸开距离', min: 0, max: 2, step: 0.01 })
      .on('change', (ev) => { store.explode.value = ev.value; });
    fPart.addBinding(params, 'wireframe', { label: '线框' })
      .on('change', (ev) => { store.wireframe.value = ev.value; });
    fPart.addBinding(params, 'spin', { label: '自动旋转' })
      .on('change', (ev) => { store.spin.value = ev.value; });

    // 材质驱动：按 class 触发发光（0.3 第一步，测试窗口；接 OSC 后由信号调用同一套接口）
    const fGlow = pane.addFolder({ title: '发光（测试）', expanded: true });

    // class 编号的范围必须在**模型加载后**才知道：挂载时 store.parts 还是空的，
    // 若那时就把 max 定成 0，滑块会变成 0..0 的零长度范围而拖不动（踩过）。
    // 做法：先给一个够大的上限，模型就绪后由 syncParams() 用实际最大 class 收敛回来。
    const classMaxOf = () => store.parts.reduce(
      (m, p) => Math.max(m, Number(p.object?.userData?.classId ?? -1)), 0);
    const classRange = { min: 0, max: 100000, step: 1 };

    const setGlowInput = (raw) => {
      const v = Math.round(Number(raw));
      if (!Number.isFinite(v)) return;
      params.glowInput = v;
      store.glowInput.value = String(v);
    };

    let glowInputBinding = null;
    const ensureGlowInputBinding = () => {
      if (store.parts.length === 0) return;              // 模型未就绪，等 syncParams 再来
      if (params.glowInput > classRange.max) setGlowInput(classRange.max);
      if (glowInputBinding) return;
      glowInputBinding = fGlow.addBinding(params, 'glowInput', {
        label: 'class 编号',
        ...classRange,
      }).on('change', (ev) => {
        setGlowInput(ev.value);
        pane.refresh();
      });
    };
    ensureGlowInputBinding();
    fGlow.addButton({ title: '触发' }).on('click', () => {
      store.handlers.triggerGlow?.(params.glowInput);
    });
    fGlow.addButton({ title: '释放（衰减）' }).on('click', () => {
      store.handlers.releaseGlow?.(params.glowInput);
    });
    fGlow.addButton({ title: '全部释放' }).on('click', () => {
      store.handlers.releaseAllGlow?.();
    });
    fGlow.addButton({ title: '立即熄灭' }).on('click', () => {
      store.handlers.clearGlow?.();
    });
    // 长度：step 1ms。注意 step 会把输入吸附到它的整数倍 ——
    // 之前用 0.02，输入 0.01 会被吸到 0，而 0 的语义是"持续"，看起来就像"值变没了"。
    // 0 = 持续；>0 即真实时长（最小可用 0.001 秒）
    fGlow.addBinding(params, 'glowDuration', { label: '长度(秒)', min: 0, max: 5, step: 0.001 })
      .on('change', (ev) => { store.glowDuration.value = ev.value; });
    // 强度上限放宽到 50：HDR 下高值才有明显过曝/泛光感；步长 0.1 保持可精调
    fGlow.addBinding(params, 'glowPeak', { label: '发光强度', min: 0, max: 50, step: 0.1 })
      .on('change', (ev) => { store.glowPeak.value = ev.value; });
    fGlow.addBinding(params, 'glowColor', { label: '发光颜色' })
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
        params.glowDuration = store.glowDuration.value;
        params.glowPeak = store.glowPeak.value;
        params.glowColor = store.glowColor.value;

        // 模型可能刚加载完：把 class 编号范围收敛到实际最大值，并按需补建绑定
        const max = classMaxOf();
        if (max > 0) {
          classRange.max = max;
          if (glowInputBinding) glowInputBinding.max = max;
        }
        ensureGlowInputBinding();
        if (params.glowInput > classRange.max) setGlowInput(classRange.max);

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
  const statsHost = useRef(null);
  const diagHost = useRef(null);
  return (
    <div class="panel" id="stats">
      <h3>模型</h3>
      <div ref={statsHost} id="statsBody" />
      <h3>结构诊断</h3>
      <div ref={diagHost} id="diagBody" />
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
/* 右列：部件列表                                                       */
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
        </div>
        <div id="right">
          <TweakpaneControls />
          <PartsList />
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

/* ---------- 部件列表 ---------- */
#parts { display: flex; flex-direction: column; overflow: hidden; flex: 1; min-height: 0; max-height: 460px; }
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

/* 收起：整块缩成小胶囊，宽度也跟着收 */
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

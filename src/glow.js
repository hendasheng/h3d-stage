/**
 * glow.js —— class 触发的发光状态机（0.3 材质驱动）。
 *
 * 信号模型（对应 OSC：一条信号至少两条信息 —— 编号 + 长度）：
 *
 *   编号 classId  →  哪个 class 发光
 *   长度 duration →  亮多久（秒）。语义同 MIDI 音符长度：
 *                    先满亮保持 duration 秒，再用 duration 秒线性衰减到 0（释放尾巴）
 *
 *   duration = 0 / 缺省 → "持续"：一直亮到显式 release()
 *
 * 衰减是**按时间戳算的纯函数**：不依赖帧率，掉帧也不会残留。
 * 强度最终写入材质的 emissiveIntensity。
 */

/** 当前处于发光状态的 class：Map<classId, { level, peak, holdUntil, fadeUntil, duration }> */
const active = new Map();

/** 默认峰值强度与默认衰减时长（秒）；与界面默认值保持一致（见 src/ui/store.js） */
export const GLOW_DEFAULTS = { peak: 50, duration: 0.05 };

/** 小于这个时长（秒）视为"持续"：比一帧还短，当作 0 处理，避免出现看不见的极短发光 */
export const MIN_TIMED_DURATION = 0.001;

/**
 * 触发某 class 发光。
 * @param {number|string} classId
 * @param {{ peak?: number, duration?: number, now?: number }} [opts]
 *        duration > 0 表示"信号长度"：到时自动衰减；<= 0 表示持续
 */
export function trigger(classId, opts = {}) {
  const id = Math.round(Number(classId));   // class 是整数编号
  if (!Number.isFinite(id)) return false;
  const peak = opts.peak ?? GLOW_DEFAULTS.peak;
  // 比一个步长还短的值当作持续（0），避免出现"0.0004 秒"这种谁也看不见的发光
  const rawDuration = opts.duration ?? GLOW_DEFAULTS.duration;
  const duration = rawDuration >= MIN_TIMED_DURATION ? rawDuration : 0;
  const now = opts.now ?? performance.now() / 1000;

  active.set(id, {
    peak,
    duration,
    level: 1,
    // 长度 L：先保持 L 秒，再用 L 秒线性衰减到 0；L <= 0 视为持续（fadeUntil 保持 Infinity）
    holdUntil: duration > 0 ? now + duration : Infinity,
    fadeUntil: duration > 0 ? now + duration * 2 : Infinity,
  });
  return true;
}

/**
 * 释放某 class：从当前强度开始，在 duration 秒内衰减到 0。
 * @param {number|string} classId
 * @param {{ duration?: number, now?: number }} [opts]
 */
export function release(classId, opts = {}) {
  const id = Math.round(Number(classId));
  const st = active.get(id);
  if (!st) return false;
  const duration = opts.duration ?? st.duration ?? GLOW_DEFAULTS.duration;
  const now = opts.now ?? performance.now() / 1000;
  st.holdUntil = now;
  st.fadeUntil = duration > 0 ? now + duration : now;
  return true;
}

/** 立即清空所有发光（不做衰减） */
export function clearAll() {
  active.clear();
}

export function clearOne(classId) {
  return active.delete(Math.round(Number(classId)));
}

export function activeIds() {
  return [...active.keys()].sort((a, b) => a - b);
}

/**
 * 推进时间，返回每个 class 当前的强度（0~1，已含峰值前的保持段）。
 * 到期的条目会被移除。
 * @param {number} now 秒
 * @returns {Map<number, number>} classId → 强度（0~1）
 */
export function levelsAt(now) {
  const out = new Map();
  for (const [id, st] of active) {
    if (now < st.holdUntil) {
      out.set(id, 1);
    } else if (now < st.fadeUntil) {
      const span = st.fadeUntil - st.holdUntil;
      out.set(id, span > 0 ? 1 - (now - st.holdUntil) / span : 0);
    } else {
      active.delete(id);   // 衰减结束：彻底熄灭
    }
  }
  return out;
}

/** 供测试用：当前活跃条目快照 */
export function snapshot() {
  return [...active.entries()].map(([id, st]) => ({ id, ...st }));
}

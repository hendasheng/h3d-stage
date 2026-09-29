/**
 * test-glow.mjs —— 发光状态机测试（0.3 材质驱动）。
 *
 * 覆盖「信号长度 → 保持 → 线性衰减 → 归零」的语义，以及多 class 并存、显式释放、
 * 帧率无关（按时间戳算而不是按帧累加）。纯逻辑测试，不需要 three / DOM。
 *
 * 运行：node tools/test-glow.mjs
 */
import { trigger, release, clearAll, clearOne, activeIds, levelsAt, snapshot, GLOW_DEFAULTS } from '../src/glow.js';

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? '  [OK]  ' : '  [FAIL]'} ${label}${extra ? ' -> ' + extra : ''}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

console.log('\n=== 1. 触发后保持，长度到期后开始衰减 ===');
clearAll();
trigger(137, { duration: 1, peak: 2, now: 0 });
ok('触发后进入活跃列表', activeIds().includes(137), activeIds().join(','));
ok('t=0 强度为 1', near(levelsAt(0).get(137), 1));
ok('t=0.9（长度内）仍为 1', near(levelsAt(0.9).get(137), 1));
ok('t=1.0（刚到期）仍为 1', near(levelsAt(1.0).get(137), 1));
ok('t=1.5（衰减中）约 0.5', near(levelsAt(1.5).get(137), 0.5, 1e-6), String(levelsAt(1.5).get(137)));
ok('t=1.9 约 0.1', near(levelsAt(1.9).get(137), 0.1, 1e-6));
ok('t=2.0 已归零并从活跃表移除', !levelsAt(2.0).has(137));
ok('移除后活跃列表为空', activeIds().length === 0, activeIds().join(','));

console.log('\n=== 2. duration = 0 表示"持续"，不会自动衰减 ===');
clearAll();
trigger(5, { duration: 0, now: 0 });
ok('t=100 仍为 1', near(levelsAt(100).get(5), 1));
release(5, { duration: 0.5, now: 100 });
ok('显式释放后 t=100 为 1', near(levelsAt(100).get(5), 1));
ok('t=100.25 约 0.5', near(levelsAt(100.25).get(5), 0.5, 1e-6));
ok('t=100.5 归零', !levelsAt(100.5).has(5));

console.log('\n=== 3. 显式释放：从当前强度开始衰减（不是从 1 重新开始）===');
clearAll();
trigger(9, { duration: 1, now: 0 });
ok('t=0.5 强度 1', near(levelsAt(0.5).get(9), 1));
release(9, { duration: 1, now: 0.5 });   // 从 1 开始，到 1.5 归零
ok('释放后 t=0.75 约 0.75', near(levelsAt(0.75).get(9), 0.75, 1e-6), String(levelsAt(0.75).get(9)));
ok('t=1.5 归零', !levelsAt(1.5).has(9));

console.log('\n=== 4. 多 class 并存，互不影响 ===');
clearAll();
trigger(1, { duration: 1, now: 0 });
trigger(2, { duration: 3, now: 0 });
trigger(3, { duration: 0, now: 0 });     // 持续
const at = (t) => levelsAt(t);
ok('三个同时活跃', activeIds().length === 3, activeIds().join(','));
ok('t=0.5：三者都是 1', [1, 2, 3].every((id) => near(at(0.5).get(id), 1)));
// 时间线：class1 长度1 → 保持 [0,1] 衰减 [1,2]；class2 长度3 → 保持 [0,3] 衰减 [3,6]；class3 持续
ok('t=1.5：class1 正在衰减(约0.5)，class2 仍在保持、class3 持续',
  near(at(1.5).get(1), 0.5, 1e-6) && near(at(1.5).get(2), 1) && near(at(1.5).get(3), 1),
  `1=${at(1.5).get(1)} 2=${at(1.5).get(2)} 3=${at(1.5).get(3)}`);
ok('t=2.5：class1 已灭，class2 仍在保持(1)、class3 持续',
  !at(2.5).has(1) && near(at(2.5).get(2), 1) && near(at(2.5).get(3), 1),
  `2=${at(2.5).get(2)}`);
ok('t=4.5：class2 衰减中(约0.5)', near(at(4.5).get(2), 0.5, 1e-6), String(at(4.5).get(2)));
ok('t=6.5：class2 灭，class3 仍亮', !at(6.5).has(2) && near(at(6.5).get(3), 1));

console.log('\n=== 5. 帧率无关：同一时刻无论查几次、跳多远，结果一致 ===');
clearAll();
trigger(7, { duration: 1, now: 0 });
const a = levelsAt(1.4).get(7);
// 模拟 30fps 与 144fps 两种推进方式，同一时刻读值应完全相同
for (let t = 0; t <= 1.4; t += 1 / 30) levelsAt(t);
const b = levelsAt(1.4).get(7);
ok('连续查询不改变结果（纯函数式）', near(a, b), `${a} vs ${b}`);
ok('掉帧后不残留：直接跳到 t=2', !levelsAt(2).has(7));

console.log('\n=== 6. 边界与清理 ===');
clearAll();
ok('非法编号被拒绝', trigger('abc') === false && trigger(NaN) === false && trigger(undefined) === false);
// class 是整数编号：小数一律归一到最近整数，杜绝出现 class 137.4 这种不存在的值
clearAll();
trigger(137.4, { duration: 0, now: 0 });
ok('小数 137.4 归一为 137', activeIds().join(',') === '137', activeIds().join(','));
clearAll();
trigger('137.6', { duration: 0, now: 0 });
ok('字符串小数 137.6 归一为 138', activeIds().join(',') === '138', activeIds().join(','));
clearAll();
trigger('42', { duration: 0, now: 0 });
ok('字符串整数可用', activeIds().includes(42), activeIds().join(','));
ok('release 不存在的编号返回 false', release(9999) === false);
ok('release 小数也归一（9999.2 → 9999）', release(9999.2) === false);
clearOne(42);
ok('clearOne 移除指定项', activeIds().length === 0);
trigger(1, { duration: 0, now: 0 });
trigger(2, { duration: 0, now: 0 });
clearAll();
ok('clearAll 清空', activeIds().length === 0 && levelsAt(0).size === 0);

console.log('\n=== 7. 默认值与极短长度 ===');
clearAll();
trigger(3, { now: 0 });
const st = snapshot().find((s) => s.id === 3);
ok('默认峰值取 GLOW_DEFAULTS.peak', near(st.peak, GLOW_DEFAULTS.peak), String(st.peak));
ok('默认长度取 GLOW_DEFAULTS.duration', near(st.duration, GLOW_DEFAULTS.duration), String(st.duration));
// 界面默认值（src/ui/store.js）应与这里一致，否则"触发按钮"的行为和测试假设会脱节
ok('默认长度 = 0.05 秒', near(GLOW_DEFAULTS.duration, 0.05), String(GLOW_DEFAULTS.duration));
ok('默认峰值 = 50', near(GLOW_DEFAULTS.peak, 50), String(GLOW_DEFAULTS.peak));

// 面板 step 吸附后的最小值应能被如实执行；小于一个步长的值当"持续"
clearAll();
trigger(11, { duration: 0.001, now: 0 });
ok('长度 0.001s 生效（不是持续）', Number.isFinite(snapshot()[0].holdUntil), String(snapshot()[0].holdUntil));
ok('t=0.0005 仍亮', near(levelsAt(0.0005).get(11), 1));
ok('t=0.0015 衰减中', levelsAt(0.0015).get(11) > 0 && levelsAt(0.0015).get(11) < 1, String(levelsAt(0.0015).get(11)));
ok('t=0.002 归零', !levelsAt(0.002).has(11));

clearAll();
trigger(12, { duration: 0.0005, now: 0 });
ok('长度 0.0005s 视为持续（比步长还短）', snapshot()[0].duration === 0, String(snapshot()[0].duration));
ok('持续：t=99 仍为 1', near(levelsAt(99).get(12), 1));

console.log(`\n${failures ? `存在 ${failures} 个失败项` : '发光状态机测试全部通过'}\n`);
process.exitCode = failures ? 1 : 0;

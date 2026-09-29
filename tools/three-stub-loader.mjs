/**
 * three-stub-loader.mjs —— 启动时挂载 three 桩模块钩子。
 * 用法：node --import ./three-stub-loader.mjs test-explode-reset.mjs
 */
import { register } from 'node:module';

register('./three-stub-hooks.mjs', import.meta.url);

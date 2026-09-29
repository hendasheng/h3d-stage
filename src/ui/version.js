/**
 * version.js —— 版本的唯一来源。
 * 直接读 package.json，改版本只需改那一处；UI 与文档不再各写一份。
 * （单独成模块是为了避免 App.jsx 与 main.js 互相 import 形成循环依赖。）
 */
import pkg from '../../package.json';

export const VERSION = pkg.version;

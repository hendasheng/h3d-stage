/**
 * gen-noise-texture.mjs —— 生成**可无缝平铺**的噪声贴图（供动态雾使用）。
 *
 * 为什么自己生成：
 *   · 雾在片元里对全部材质采样，所以噪声必须是**贴图**而不是运行时算（一篇参考文章的说法：
 *     "noise calculation can be expensive, especially applied to numerous materials"）。
 *   · 平铺必须无缝，否则世界坐标一铺开就出现网格状接缝。做法是**周期性梯度噪声**：
 *     格点哈希时把整数坐标对 period 取模，于是 x=period 与 x=0 拿到同一个哈希，边界天然连续。
 *   · 生成脚本进仓库，图可复现、可重新烘，不引入运行时依赖。
 *
 * 输出写进 `src/assets/textures/noise-tileable.png`（随源码打包，不要再放 public/）。
 *
 * 运行：node tools/gen-noise-texture.mjs         生成（已存在且内容一致则跳过）
 *      node tools/gen-noise-texture.mjs --check 只校验，不写文件（供 npm run check 用）
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src/assets/textures/noise-tileable.png');

const SIZE = 256;         // 贴图边长
const LATTICE = 16;       // 基础频率：一个周期内 16 个格点 → 平铺后不显网格
const OCTAVES = 4;        // fBm 层数
const GAIN = 0.5;         // 每层振幅衰减
const LACUNARITY = 2;     // 每层频率翻倍

/* ---------------- 周期性梯度噪声 ---------------- */
// 哈希：整数格点 → [0,1)。用整数混合，避免浮点误差导致边界不闭合。
function hash2(ix, iy, seed) {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (a, b, t) => a + (b - a) * t;

/**
 * 周期性 value noise：格点坐标对 period 取模。
 * 这样 x = period 处的哈希与 x = 0 处相同 → 贴图左右/上下边界严格连续。
 */
function periodicNoise(x, y, period, seed) {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = fade(x - x0);
  const fy = fade(y - y0);
  const wrap = (v) => ((v % period) + period) % period;
  const x0w = wrap(x0);
  const y0w = wrap(y0);
  const x1w = wrap(x0 + 1);
  const y1w = wrap(y0 + 1);
  const v00 = hash2(x0w, y0w, seed);
  const v10 = hash2(x1w, y0w, seed);
  const v01 = hash2(x0w, y1w, seed);
  const v11 = hash2(x1w, y1w, seed);
  return lerp(lerp(v00, v10, fx), lerp(v01, v11, fx), fy);
}

/** 分层叠加，每层周期同步翻倍，保证整体仍然平铺。 */
function fbm(u, v, basePeriod, octaves) {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    sum += amp * periodicNoise(u * period, v * period, period, o * 101 + 7);
    norm += amp;
    amp *= GAIN;
    period *= LACUNARITY;
  }
  return sum / norm;
}

/* ---------------- PNG 编码（8 位灰度，不带依赖） ---------------- */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodeGrayPng(width, height, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 0;    // color type: grayscale
  // 10-12: compression / filter / interlace 全为 0
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;   // filter: none
    pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---------------- 生成 ---------------- */
const pixels = Buffer.alloc(SIZE * SIZE);
let min = Infinity;
let max = -Infinity;
const values = new Float64Array(SIZE * SIZE);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    // 归一化到 [0,1) 后乘周期：u=1 与 u=0 等价，故平铺无缝
    const value = fbm(x / SIZE, y / SIZE, LATTICE, OCTAVES);
    values[y * SIZE + x] = value;
    if (value < min) min = value;
    if (value > max) max = value;
  }
}

// 拉到满量程：雾那边只关心相对起伏，摊开能少浪费 8 位精度
const span = max - min || 1;
for (let i = 0; i < values.length; i++) {
  pixels[i] = Math.max(0, Math.min(255, Math.round(((values[i] - min) / span) * 255)));
}

const png = encodeGrayPng(SIZE, SIZE, pixels);

/* ---------------- 平铺自检：左右/上下边界必须连续 ---------------- */
const at = (x, y) => pixels[((y % SIZE) + SIZE) % SIZE * SIZE + (((x % SIZE) + SIZE) % SIZE)];
let worstSeam = 0;
for (let i = 0; i < SIZE; i++) {
  worstSeam = Math.max(worstSeam, Math.abs(at(0, i) - at(SIZE, i)));   // 左右
  worstSeam = Math.max(worstSeam, Math.abs(at(i, 0) - at(i, SIZE)));   // 上下
}
// 相邻像素的平均差作为参照：接缝处的跳变不该明显大于普通相邻差
let avgNeighbor = 0;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE - 1; x++) avgNeighbor += Math.abs(pixels[y * SIZE + x + 1] - pixels[y * SIZE + x]);
}
avgNeighbor /= SIZE * (SIZE - 1);

const checkOnly = process.argv.includes('--check');
const existing = existsSync(OUT) ? readFileSync(OUT) : null;
const same = existing && existing.equals(png);

console.log(`噪声贴图：${SIZE}×${SIZE} 灰度，格点周期 ${LATTICE}，fBm ${OCTAVES} 层`);
console.log(`  值域 ${min.toFixed(3)} .. ${max.toFixed(3)} → 已拉满 0..255`);
console.log(`  平铺接缝最大跳变 ${worstSeam}，普通相邻像素平均差 ${avgNeighbor.toFixed(2)}`);
if (worstSeam > avgNeighbor * 4) {
  console.error('  [FAIL] 接缝跳变明显大于相邻差 —— 噪声没有真正平铺');
  process.exitCode = 1;
} else {
  console.log('  [OK]  接缝与普通相邻像素同量级，平铺无缝');
}

if (checkOnly) {
  if (same) console.log(`  [OK]  ${OUT} 与生成结果一致`);
  else if (!existing) { console.error(`  [FAIL] 缺少 ${OUT}，请运行 node tools/gen-noise-texture.mjs`); process.exitCode = 1; }
  else { console.error(`  [FAIL] ${OUT} 与生成结果不一致，请重新生成`); process.exitCode = 1; }
} else if (same) {
  console.log('  已是最新，未改动');
} else {
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, png);
  console.log(`  已写入 ${OUT}（${png.length} 字节）`);
}

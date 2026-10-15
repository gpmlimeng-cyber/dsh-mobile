#!/usr/bin/env node
// 像素取证：从 `screencap`（**不加 -p**，要 raw 头）直接统计屏幕像素。
//
// 为什么需要它：验「状态栏/系统栏颜色」这类判据时，**行均值（row mean）会把系统状态栏的
// 图标字形算进去**——时钟/电量/信号是深色像素，落在状态栏高度内，越过状态栏后消失，
// 于是行均值出现一步"变亮"的台阶，看起来像壳自绘了一层底色（实测假阳性：−6.6/255，
// 台阶位置 = 状态栏底边）。判定底色必须看**背景色（众数）**，不是均值。
//
// 用法：
//   screencap > shot.raw            # 不要 -p；多显示器时加 -d <id>
//   node scripts/screenshot-profile.mjs rows <shot.raw> [x0 x1 y0 y1]   # 行剖面（找台阶）
//   node scripts/screenshot-profile.mjs rect <shot.raw> x0 x1 y0 y1    # 矩形配色直方图（分背景/前景）
//
// raw 头：uint32 width, uint32 height, uint32 format, uint32 colorspace，随后像素。
// format 1=RGBA_8888 / 2=RGBX_8888 / 3=RGB_888 / 4=RGB_565。

import { readFileSync } from 'node:fs'

const [, , cmd, file, ...rest] = process.argv
if (!cmd || !file) {
  console.error('usage: screenshot-profile.mjs rows|rect <shot.raw> [args]')
  process.exit(2)
}

const buf = readFileSync(file)
const HDR = 16
const w = buf.readUInt32LE(0)
const h = buf.readUInt32LE(4)
const fmt = buf.readUInt32LE(8)
const bpp = fmt === 4 ? 2 : 4
const expect = HDR + w * h * bpp
if (buf.length !== expect) {
  console.error(`# size mismatch: ${buf.length} != ${expect} (${w}x${h} fmt=${fmt})`)
}

/** 取像素 [r,g,b]（8bit）。 */
function px(x, y) {
  const o = HDR + (y * w + x) * bpp
  if (bpp === 2) {
    const v = buf.readUInt16LE(o)
    return [((v >> 11) & 31) * 255 / 31, ((v >> 5) & 63) * 255 / 63, (v & 31) * 255 / 31]
  }
  return [buf[o], buf[o + 1], buf[o + 2]]
}
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b

if (cmd === 'rows') {
  const x0 = rest[0] !== undefined ? Number(rest[0]) : 0
  const x1 = rest[1] !== undefined ? Number(rest[1]) : w - 1
  const y0 = rest[2] !== undefined ? Number(rest[2]) : 0
  const y1 = rest[3] !== undefined ? Number(rest[3]) : Math.min(h - 1, 400)
  console.log(`# ${file} ${w}x${h} fmt=${fmt}  rows x=${x0}..${x1} y=${y0}..${y1}`)
  console.log('# y\tmeanR\tmeanG\tmeanB\tluma\tdLuma(prev)')
  let prev = null
  let best = { d: 0, y: y0 }
  for (let y = y0; y <= y1; y++) {
    let sr = 0, sg = 0, sb = 0, n = 0
    for (let x = x0; x <= x1; x++) { const [r, g, b] = px(x, y); sr += r; sg += g; sb += b; n++ }
    const L = luma(sr / n, sg / n, sb / n)
    const d = prev === null ? 0 : L - prev
    if (prev !== null && Math.abs(d) > Math.abs(best.d)) best = { d, y }
    prev = L
    console.log(`${y}\t${(sr / n).toFixed(2)}\t${(sg / n).toFixed(2)}\t${(sb / n).toFixed(2)}\t${L.toFixed(2)}\t${d >= 0 ? '+' : ''}${d.toFixed(2)}`)
  }
  console.log(`# max step: y=${best.y} d=${best.d >= 0 ? '+' : ''}${best.d.toFixed(2)}  ` +
    `（注意：状态栏图标字形会伪造台阶，判定底色请看 rect 的背景众数）`)
} else if (cmd === 'rect') {
  const [x0, x1, y0, y1] = rest.map(Number)
  const hist = new Map()
  let n = 0, sum = 0, min = 255, max = 0
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const [r, g, b] = px(x, y)
    const k = `${r},${g},${b}`
    hist.set(k, (hist.get(k) || 0) + 1)
    const L = luma(r, g, b)
    sum += L; n++; if (L < min) min = L; if (L > max) max = L
  }
  console.log(`rect x=${x0}..${x1} y=${y0}..${y1} n=${n} meanL=${(sum / n).toFixed(2)} minL=${min.toFixed(2)} maxL=${max.toFixed(2)} distinct=${hist.size}`)
  for (const [k, c] of [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    console.log(`   ${k}  x${c}  (${(100 * c / n).toFixed(1)}%)`)
  }
} else {
  console.error(`unknown command: ${cmd}`)
  process.exit(2)
}

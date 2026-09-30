#!/usr/bin/env node
// check-snapshot-prefix.mjs — 快照包名前缀一致性门禁（防「APK 包名 ≠ 快照前缀」的跨 App 错配回归）
//
// 背景：build-snapshot-013.mjs 曾把目标前缀硬编码为基线包 com.dsharnessmobile.shell，而
// app/build.gradle.kts 的 applicationId 默认值是二开包 com.deepcode.shell。两者分叉后，
// 默认构建会静默产出「快照内 1488 处路径指向另一个 App」的 APK —— 那些路径在目标 App 的
// 挂载命名空间里根本不存在（Android per-app namespace 下跨 App 路径恒为 ENOENT），
// 表现为一切依赖快照的 spawn 失败、或 Node 回落编译期前缀后的
// `OpenSSL configuration error: ...Permission denied... fopen(/data/data/com.termux/.../openssl.cnf)`。
//
// 用法：node scripts/check-snapshot-prefix.mjs <snapshot.tar.xz> [expectedApplicationId]
//   expectedApplicationId 缺省时从 app/build.gradle.kts 解析（与 build-snapshot-013.mjs /
//   build-apk.mjs 共用同一真源）。也可用环境变量 DSH_APPLICATION_ID 指定。
// 规则：
//   · 期望包名（applicationId）必须是快照内出现最多的 /data/(user/0|data)/com.* 前缀；
//   · 其它 com.*.shell 前缀出现 > 0 即 FAIL（com.termux 除外 —— Termux 编译期 OSS 前缀，
//     由运行期 termux-exec(LD_PRELOAD) 重写，属设计内）；
//   · DSH_ALLOW_PREFIX_RESIDUE=1 可降级为 WARN（仅供历史快照体检，不得用于发布门禁）。
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const snap = process.argv[2]
const expect = process.argv[3] || process.env.DSH_APPLICATION_ID || resolveAppId()
const IGNORE = new Set(['com.termux', 'com.android.shell'])

function resolveAppId() {
  const gradle = join(ROOT, 'app', 'build.gradle.kts')
  if (existsSync(gradle)) {
    const m = /applicationId\s*=\s*providers\.gradleProperty\("applicationIdOverride"\)\.getOrElse\("([^"]+)"\)/
      .exec(readFileSync(gradle, 'utf8'))
    if (m) return m[1]
  }
  return 'com.dsharnessmobile.shell'
}

if (!snap || !existsSync(snap)) {
  console.error('用法: node scripts/check-snapshot-prefix.mjs <snapshot.tar.xz> [expectedApplicationId]')
  console.error(`  快照不存在: ${snap}`)
  process.exit(2)
}

// 只取「作为数据目录前缀、且属 .shell 族」的包名（`com.<id>.shell` 或 `com.<id>.shell.<suffix>`）：
// 实测真实快照里另有 com.foo / com.pdaxrom.cctools 等无关内容，若一并计入会误报（修好后也 FAIL）。
const cmd = `xz -dc ${JSON.stringify(snap)} | grep -a -o -E '/data/(user/0|data)/com\\.[a-z0-9_]+\\.shell(\\.[a-z0-9_]+)?' | sed -E 's#^/data/(user/0|data)/##' | sort | uniq -c | sort -rn`
const r = spawnSync('sh', ['-c', cmd], { encoding: 'utf8', maxBuffer: 1 << 28 })
if (r.status !== 0) {
  console.error('扫描失败（需要 xz / grep 在 PATH）: ' + String(r.stderr || '').slice(0, 400))
  process.exit(2)
}

const counts = new Map()
for (const line of String(r.stdout).split('\n')) {
  const m = /^\s*(\d+)\s+(\S+)\s*$/.exec(line)
  if (m) counts.set(m[2], Number(m[1]))
}
const ranked = [...counts.entries()].filter(([p]) => !IGNORE.has(p)).sort((a, b) => b[1] - a[1])

console.log(`[snapshot-prefix] 期望包名 = ${expect}`)
for (const [p, n] of ranked.slice(0, 8)) console.log(`   ${String(n).padStart(8)}  ${p}`)

const wrong = ranked.filter(([p]) => p !== expect)
if (ranked[0]?.[0] !== expect || wrong.length > 0) {
  const msg = `快照前缀与 applicationId 不一致：期望 ${expect}，实际主前缀 ${ranked[0]?.[0] ?? '(无)'}`
    + (wrong.length ? `；异包名残留 ${wrong.map(([p, n]) => `${p}×${n}`).join(', ')}` : '')
  if (process.env.DSH_ALLOW_PREFIX_RESIDUE === '1') {
    console.warn('WARN（已降级，勿用于发布门禁）: ' + msg)
    process.exit(0)
  }
  console.error('FAIL: ' + msg)
  console.error('  修法：build-snapshot-013.mjs 的目标前缀必须取自与 applicationId 相同的真源')
  console.error('        （见 dsh-mobile-fix/0001-snapshot-prefix-single-source.patch）')
  process.exit(1)
}
console.log(`[snapshot-prefix] PASS（唯一前缀 = ${expect}；com.termux 属设计内，已忽略）`)

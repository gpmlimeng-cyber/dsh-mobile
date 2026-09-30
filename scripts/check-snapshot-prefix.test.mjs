// check-snapshot-prefix.test.mjs — 本次修复自带的反证用例（对齐 AGENTS.md §2.1「本改动自带的反证用例」）
//
// 必须同时证明两个方向，缺一不可：
//   ① 快照前缀 == 目标 applicationId  → PASS
//   ② 快照前缀指向另一个包            → FAIL，并报出那个异包名
// ② 正是本次要永久挡住的那类坏包：`com.deepcode.shell` 的 APK 里装着
// 1488 处指向 `com.dsharnessmobile.shell` 的路径（跨 App 命名空间下恒为 ENOENT）。
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const GATE = join(HERE, 'check-snapshot-prefix.mjs')

/** 造一份最小 tar.xz：内容里带一条该前缀下的路径，够门禁 grep 到即可。 */
function makeSnapshot(dir, prefix, extra = []) {
  writeFileSync(join(dir, 'payload.txt'), `#!/system/bin/sh\nexec "${prefix}/bin/bash" "$@"\n${extra.join('\n')}\n`)
  const tar = join(dir, 'snap.tar.xz')
  // 用 sh 管道显式调 xz：dsh-mobile 的 tar wrapper 会剔除 PATH，`tar -J` 在这里找不到 xz（实测）。
  execFileSync('sh', ['-c', `tar -cf - -C ${JSON.stringify(dir)} payload.txt | xz -9 > ${JSON.stringify(tar)}`])
  return tar
}

function runGate(snap, expectId) {
  try {
    const out = execFileSync('node', [GATE, snap, expectId], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

test('① 前缀 == applicationId → PASS', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-prefix-ok-'))
  try {
    const r = runGate(makeSnapshot(dir, '/data/user/0/com.deepcode.shell/files/usr'), 'com.deepcode.shell')
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /PASS/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('② 前缀指向另一个包 → FAIL（本次回归的反证）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-prefix-bad-'))
  try {
    const r = runGate(makeSnapshot(dir, '/data/user/0/com.dsharnessmobile.shell/files/usr'), 'com.deepcode.shell')
    assert.equal(r.code, 1, '错前缀必须被拒\n' + r.out)
    assert.match(r.out, /com\.dsharnessmobile\.shell/, '必须报出异包名\n' + r.out)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('③ com.termux 属设计内：不判为异包名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-prefix-termux-'))
  try {
    const r = runGate(makeSnapshot(dir, '/data/data/com.termux/files/usr'), 'com.deepcode.shell')
    assert.doesNotMatch(r.out, /异包名残留[^\n]*com\.termux/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('④ 无关 com.* 噪声不影响判定（实测真实快照里就有这些）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-prefix-noise-'))
  try {
    const noise = ['/data/data/com.foo/x', '/data/data/com.pdaxrom.cctools/y', '/data/data/com.android.shell/z']
    // 正确前缀 + 噪声 → 仍应 PASS
    const ok = runGate(makeSnapshot(dir, '/data/user/0/com.deepcode.shell/files/usr', noise), 'com.deepcode.shell')
    assert.equal(ok.code, 0, ok.out)
    assert.doesNotMatch(ok.out, /com\.foo|com\.pdaxrom|com\.android/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

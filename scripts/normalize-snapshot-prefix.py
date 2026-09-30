#!/usr/bin/env python3
"""normalize-snapshot-prefix.py — 把快照 tar.xz 里「路径形式」的旧包名前缀统一成本次的 applicationId。

为什么需要（本仓库的真实缺陷）：
  设备侧构建链（`tools/build-dev-apk.sh` → `scripts/build-apk.mjs`，以及断点续跑的
  `tools/resume-build-apk.sh`）直接拿**现成快照**当基座，而快照装配
  （`scripts/make-snapshot.sh`）只重写 `home/.dsh/profiles/*/cordis.patch.yml`、**不碰 usr 树**。
  于是「基座 = 主包前缀 + gradle 默认 applicationId = 二开包」时，会静默产出跨 App 错配的包：
  实测 `com.deepcode.shell` 的产物里，快照仍有 **2324 处** `com.dsharnessmobile.shell`
  —— 那些路径在目标 App 的挂载命名空间里根本不存在（跨 App 恒为 ENOENT）。

  CI 链（`build-snapshot-013.mjs`）在装配阶段就做了 rebrand，所以不受影响；本脚本是**打包前的
  最后一道防线**，对两条链同时生效，也让任何来源的快照都收敛到同一个判据。

只改文本成员；ELF（\\x7fELF）与符号链接原样透传 —— 内嵌的 `com.termux` 编译期前缀由运行期
termux-exec（LD_PRELOAD）负责重写，不在这里动。

用法：
  python normalize-snapshot-prefix.py <in.tar.xz> <out.tar.xz> <targetApplicationId> [oldApplicationId]

  oldApplicationId 省略时自动探测：统计所有 /data/(user/0|data)/com.<id>.shell 前缀的出现次数，
  取**非目标包名**中最高者作为待归一的旧前缀；探测不到（或已等于目标）则只做一次字节拷贝。
  退出码：0 正常（含 no-op）；1 目标前缀在校验后仍不占多数（自检失败，构建应中止）。
"""
import collections
import io
import lzma
import re
import sys
import tarfile

PREFIX_RX = re.compile(rb'/data/(?:user/0|data)/(com\.[a-z0-9_]+\.shell(?:\.[a-z0-9_]+)?)')
MAX_INLINE = 64 * 1024 * 1024  # 超大成员不读入内存（快照内不该有）


def scan(raw: bytes):
    """返回 {包名: 出现次数}（按路径前缀统计）。"""
    return collections.Counter(m.group(1).decode() for m in PREFIX_RX.finditer(raw))


def main() -> int:
    src, dst, target = sys.argv[1], sys.argv[2], sys.argv[3]
    old = sys.argv[4] if len(sys.argv) > 4 else None

    with lzma.open(src, 'rb') as f:
        raw = f.read()

    counts = scan(raw)
    total = sum(counts.values())
    if old is None:
        candidates = [(n, c) for n, c in counts.items() if n != target]
        old = max(candidates, key=lambda kv: kv[1])[0] if candidates else None

    print(f'[snapshot-prefix] 目标={target} 旧前缀={old or "(无)"} 路径前缀分布={dict(counts.most_common(5))}')

    if not old or old == target or counts.get(old, 0) == 0:
        print('[snapshot-prefix] 无需归一（已是目标前缀或探测不到旧前缀），原样写出')
        with lzma.open(dst, 'wb', preset=6) as f:
            f.write(raw)
        return 0

    old_u, old_d = f'/data/user/0/{old}'.encode(), f'/data/data/{old}'.encode()
    new_u, new_d = f'/data/user/0/{target}'.encode(), f'/data/data/{target}'.encode()

    changed, skipped_binary, skipped_big, scanned = 0, 0, 0, 0
    inbuf, outbuf = io.BytesIO(raw), io.BytesIO()
    with tarfile.open(fileobj=inbuf, mode='r:') as tin, \
            tarfile.open(fileobj=outbuf, mode='w', format=tarfile.PAX_FORMAT) as tout:
        for m in tin:
            if m.issym():
                # 符号链接的 target 也必须归一：内核解析 symlink 用的是**绝对目标**，不经过
                # termux-exec 的 open/execve 拦截 —— 指向旧前缀的链接在目标 App 里直接断
                # （实测占残留绝大多数：归一后 855 处里 ~828 处是 symlink target）。
                newlink = (m.linkname
                           .replace(f'/data/user/0/{old}', f'/data/user/0/{target}')
                           .replace(f'/data/data/{old}', f'/data/data/{target}'))
                if newlink != m.linkname:
                    nm = tarfile.TarInfo(m.name)
                    nm.type, nm.linkname = tarfile.SYMTYPE, newlink
                    nm.mode, nm.mtime = m.mode, int(m.mtime)
                    nm.uid, nm.gid, nm.uname, nm.gname = m.uid, m.gid, m.uname, m.gname
                    tout.addfile(nm)
                    changed += 1
                else:
                    tout.addfile(m)
                continue
            if not m.isfile():
                tout.addfile(m)  # 目录/硬链接：无内容，元数据透传
                continue
            if m.size > MAX_INLINE:
                # 大文件：必须给 fileobj —— tarfile 对「非零 size 的正规文件」只传 TarInfo 会抛
                # ValueError: fileobj not provided for non zero-size regular file（本机实测踩到）。
                tout.addfile(m, tin.extractfile(m))
                skipped_big += 1
                continue
            scanned += 1
            data = tin.extractfile(m).read()
            if data[:4] == b'\x7fELF':
                skipped_binary += 1
                tout.addfile(m, io.BytesIO(data))
                continue
            new = data.replace(old_u, new_u).replace(old_d, new_d)
            if new != data:
                changed += 1
            nm = tarfile.TarInfo(m.name)
            nm.size, nm.mode, nm.mtime = len(new), m.mode, int(m.mtime)
            nm.uid, nm.gid, nm.uname, nm.gname = m.uid, m.gid, m.uname, m.gname
            nm.type = m.type
            tout.addfile(nm, io.BytesIO(new))
    out = outbuf.getvalue()
    with lzma.open(dst, 'wb', preset=6) as f:
        f.write(out)

    after = scan(out)
    print(f'[snapshot-prefix] 扫描 {scanned} 成员，改写 {changed} 个，跳过 ELF {skipped_binary} 个、'
          f'大文件透传 {skipped_big} 个；'
          f'归一后分布={dict(after.most_common(5))}')

    if after.get(target, 0) == 0 or (total and after.get(old, 0) > after.get(target, 0)):
        print(f'[snapshot-prefix] FAIL：归一后 {target} 未成为主前缀（{after.get(target, 0)} vs {after.get(old, 0)}）')
        return 1
    print(f'[snapshot-prefix] PASS：{target} 已成为主前缀（{after.get(target, 0)} 处，旧前缀剩 {after.get(old, 0)}）')
    return 0


if __name__ == '__main__':
    sys.exit(main())

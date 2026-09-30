#!/usr/bin/env python3
"""inject-all.py — 快照注入单 pass 合并器（Phase 2c 结构性提速，2026-09-05）。

合并原三步链（每步各自全量解压+preset9 重压缩，~743MB tar × 3 遍）为**单 pass tar 流处理**：
  ① @dsh-android 命名空间注入（原 inject-snapshot.py：profiles/{web,headless}/node_modules/@dsh-android/<pkg>/）
  ② 根级插件注入（原 inject-external-plugins.py：undo/market 等非 scoped 包，lib/skills/清单文件）
  ③ cordis.patch.yml 权威装配覆盖（原 update-snapshot-patch.py：仅 web profile，--all-profiles 展开）
  ④ profile 级插件版本豁免写出（scripts/snapshot-config/profile-compatibility.json → 每个装配 profile 的
     compatibility.json；0.1.7 起必需，见 COMPAT_SRC 注释与坑 181）
压缩从 ×4 → ×1、解压从 ×4 → ×1；发布档 preset 由 DSH_INJECT_PRESET 控制（默认 9 保发布保真，
-Fast dev 循环传 1 —— 743MB tar 上 preset9≈380s / preset1≈75s / 多线程 xz -6≈48s 实测，2026-09-05）。
并发上限（0.14.1 系统级约束）：构建期压缩/解压不得吃满全部逻辑核（原写法是 `-T0`），否则开发机被
撑满 → 同时运行的 MuMu 模拟器卡顿/系统不稳（「模拟器优先」是铁律 2）。统一走 scripts/lib/shell.mjs
的 XZ_THREADS（默认 8，可由 DSH_CPU_THREADS 覆写）；本文件自身不调 xz（只做 lzma 流式重打包）。

用法：
  python inject-all.py <snapshot.tar.xz> <out.tar.xz> <authoritative.patch.yml> --dsh-android <dir>... --external <dir>... [--all-profiles] [--combo-cache-delta <dir>]
字节级 tar 流替换，保留 symlink 元数据（Windows bsdtar 解包 symlink 需特权——tar 流处理不物化）。

装配 profile 覆盖（0.13.8-b ST-05 / F-ENV-02）：权威 patch 与注入包默认覆盖**全部**真实装配
profile（web + headless），不再只覆盖 web——见 PROFILES / NEGATIVE_CONTROL_PROFILES 的注释。
--all-profiles 为兼容保留的显式同义开关（历史上它是唯一开关且全仓无调用者）。
"""
import io
import json as _json
import lzma
import os
import sys
import tarfile

# 真实装配 profile（0.13.8-b ST-05 / F-ENV-02）：权威 patch 与注入包必须覆盖这里的每一个，
# 否则 profile 的 cordis.patch.yml 会永久停在旧值（历史实证：headless 的 bashPath 停在
# /data/user/0/<pkg>/usr（缺 /files 段）→ 启动 assertBash() 抛错、注入包全不装配，而门禁假绿）。
PROFILES = ("web", "headless")
# 负控夹具 profile：bashPath 刻意指向不存在路径（.../usr/bin/bash-not-exist），用于验证启动期
# 「坏配置拒绝」路径。构建链**不得**用权威 patch 覆盖它（覆盖即负控失效），门禁侧对它显式列白名单。
NEGATIVE_CONTROL_PROFILES = ("headless-bad",)
DSH_ANDROID_NS = "node_modules/@dsh-android/"
EXT_INCLUDE_FILES = ("package.json", "cordis.patch.yml", "spec.json", "README.md", "README.zh-CN.md", "LICENSE")

# profile 级「插件版本豁免」随包发货（0.1.7 起必需，见 docs/AGENTS/gotchas.md 181）。
# 上游 0.1.7 新增精确版本兼容闸门：移动插件的 peerDependencies 是**精确 pin**
# （如 @deepseek-ai/dsh-bash-local: 0.1.5-rc.1），新引擎下被判定不兼容并**停用该行**——而 boot 照样
# 成功，只是没有 bash、没有移动 UI 层（最难发现的残缺）。正路出口 `dsh plugin allow-version` 写的就是
# profile 内的 compatibility.json；但快照里的 pnpm shim 烧的是**主包**前缀，共存包里 `dsh plugin`
# 不可用 ⇒ 该豁免必须随包发货，不能靠设备侧手写（否则重装 APK 重解压快照后豁免消失、能力静默残缺）。
# 源文件缺席时行为与历史完全一致（不注入）。
COMPAT_NAME = "compatibility.json"
# 必须登记进每个装配 profile 的 `dsh.profile.bundles` 的条目（见 scripts/snapshot-config/profile-bundles.json）。
# 为什么需要：出厂基座 profile 只登记 [dsh-base, dsh-web-app]，而上游 experimental bundle 不会被传递依赖
# 进来（实测：dsh-web-app 的 127 个依赖里没有 voice-input bundle）；语音输入所需的 `speech-to-text`
# 注册表与 controller 都由 voice-input bundle 插入，不登记则整条链缺失（provider 永久 pending）。
BUNDLES_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "snapshot-config", "profile-bundles.json")
COMPAT_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                          "snapshot-config", "profile-compatibility.json")


def parse_args(argv):
    if len(argv) < 4:
        print(__doc__)
        sys.exit(2)
    src, dst, patch_src = argv[1], argv[2], argv[3]
    dsh_dirs, ext_dirs, all_profiles, combo_cache_delta = [], [], False, None
    i = 4
    while i < len(argv):
        if argv[i] == "--dsh-android":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                dsh_dirs.append(argv[i]); i += 1
        elif argv[i] == "--external":
            i += 1
            while i < len(argv) and not argv[i].startswith("--"):
                ext_dirs.append(argv[i]); i += 1
        elif argv[i] == "--all-profiles":
            all_profiles = True; i += 1
        elif argv[i] == "--combo-cache-delta":
            i += 1
            if i >= len(argv):
                print("--combo-cache-delta 缺目录参数"); sys.exit(2)
            combo_cache_delta = argv[i]; i += 1
        else:
            print("未知参数: " + argv[i]); sys.exit(2)
    return src, dst, patch_src, dsh_dirs, ext_dirs, all_profiles, combo_cache_delta


def build_combo_cache_delta(delta_dir):
    """注入段 combo 缓存增量（A3）：{相对文件名 -> bytes}；目录缺席/为空返回 {}。"""
    out = {}
    if not delta_dir or not os.path.isdir(delta_dir):
        return out
    for root, _dirs, fnames in os.walk(delta_dir):
        for fn in fnames:
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, delta_dir).replace("\\", "/")
            with open(full, "rb") as f:
                out[rel] = f.read()
    return out


def build_dsh_replacements(pkg_dirs):
    """@dsh-android 包名 -> {lib 相对路径 -> bytes} + package.json bytes"""
    out = {}
    for d in pkg_dirs:
        name = os.path.basename(os.path.normpath(d))
        files = {}
        lib = os.path.join(d, "lib")
        for root, _dirs, fnames in os.walk(lib):
            for fn in fnames:
                if fn.endswith(".map"):
                    continue
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, lib).replace("\\", "/")
                with open(full, "rb") as f:
                    files["lib/" + rel] = f.read()
        with open(os.path.join(d, "package.json"), "rb") as f:
            files["package.json"] = f.read()
        out[name] = files
    return out


def build_ext_replacements(pkg_dirs):
    """根级插件：真实包名（package.json name，可 scoped）-> {rel -> bytes}"""
    out = {}
    for d in pkg_dirs:
        try:
            with open(os.path.join(d, "package.json"), "rb") as f:
                name = _json.load(f)["name"]
        except Exception:
            name = os.path.basename(os.path.normpath(d))
        files = {}
        for sub in ("lib", "skills"):
            base = os.path.join(d, sub)
            if not os.path.isdir(base):
                continue
            for root, _dirs, fnames in os.walk(base):
                for fn in fnames:
                    if fn.endswith(".map"):
                        continue
                    full = os.path.join(root, fn)
                    rel = os.path.relpath(full, d).replace("\\", "/")
                    with open(full, "rb") as f:
                        files[rel] = f.read()
        for fn in EXT_INCLUDE_FILES:
            full = os.path.join(d, fn)
            if os.path.isfile(full):
                with open(full, "rb") as f:
                    files[fn] = f.read()
        if files:
            out[name] = files
    return out


def match_dsh_android(name, dsh_names):
    """命中返回 (pkg, rel)；lib/*(-.map) 与 package.json 可注入。"""
    parts = name.split("/")
    if len(parts) < 8 or parts[0:2] != ["home", ".dsh"]:
        return None
    if parts[2] != "profiles" or parts[3] not in PROFILES:
        return None
    if parts[4:6] != ["node_modules", "@dsh-android"]:
        return None
    pkg = parts[6]
    if pkg not in dsh_names:
        return None
    rel = "/".join(parts[7:])
    if rel.startswith("lib/"):
        return (pkg, rel) if not rel.endswith(".map") else None
    return (pkg, rel) if rel == "package.json" else None


def match_ext(name, ext_names):
    """命中返回 (pkg, rel)：lib/*(-.map) / skills/* / 清单文件。"""
    if not name.startswith("home/.dsh/profiles/"):
        return None
    for pkg in ext_names:
        marker = f"/node_modules/{pkg}/"
        idx = name.find(marker)
        if idx < 0:
            continue
        rel = name[idx + len(marker):]
        if rel.startswith("lib/") and not rel.endswith(".map"):
            return (pkg, rel)
        if rel.startswith("skills/"):
            return (pkg, rel)
        if rel in EXT_INCLUDE_FILES:
            return (pkg, rel)
    return None


def main():
    src, dst, patch_src, dsh_dirs, ext_dirs, all_profiles, combo_cache_delta = parse_args(sys.argv)
    preset = int(os.environ.get("DSH_INJECT_PRESET", "9"))
    with open(patch_src, "rb") as f:
        patch_bytes = f.read()
    dsh_repl = build_dsh_replacements(dsh_dirs)
    ext_repl = build_ext_replacements(ext_dirs)
    combo_delta = build_combo_cache_delta(combo_cache_delta)
    dsh_names = set(dsh_repl.keys())
    ext_names = set(ext_repl.keys())
    # profile 级插件版本豁免（见 COMPAT_SRC 注释）：必须能解析成 {字符串: [字符串]}，否则拒绝注入
    # （坏 JSON 会让引擎的兼容读取静默失效 → 能力残缺而无人知，宁可构建期硬失败）。
    compat_bytes = None
    if os.path.exists(COMPAT_SRC):
        with open(COMPAT_SRC, "rb") as f:
            compat_bytes = f.read()
        parsed = _json.loads(compat_bytes.decode("utf-8"))
        if not isinstance(parsed, dict) or not parsed:
            print(f"inject-all: {COMPAT_SRC} 不是非空 JSON 对象——拒绝注入兼容豁免")
            sys.exit(2)
        for key, value in parsed.items():
            if not isinstance(key, str) or not isinstance(value, list) or not value \
                    or not all(isinstance(v, str) for v in value):
                print(f"inject-all: {COMPAT_SRC} 条目格式非法（{key!r}）——应为 "
                      f'{{"<pkg@版本>": ["<dsh 版本>", ...]}}')
                sys.exit(2)
    # profile bundles 补登记（幂等）：缺失的追加，已存在的不动、不重排。
    required_bundles = []
    if os.path.exists(BUNDLES_SRC):
        with open(BUNDLES_SRC, encoding="utf-8") as f:
            spec = _json.load(f)
        required_bundles = [b for b in (spec.get("bundles") or []) if isinstance(b, str) and b]
        if not required_bundles:
            print(f"inject-all: {BUNDLES_SRC} 没有有效 bundles —— 跳过 profile bundles 补登记")
    # ST-05：权威 patch 与注入包的覆盖面 = 全部真实装配 profile（默认行为，不再只写 web）。
    target_profiles = list(PROFILES)
    print(f"inject-all: preset={preset} | assembly profiles: {target_profiles} "
          f"(negative-control, untouched: {list(NEGATIVE_CONTROL_PROFILES)}) | "
          f"@dsh-android: {sorted(dsh_names)} | external: {sorted(ext_names)}")
    if all_profiles:
        print("  --all-profiles: 全覆盖已是默认行为（该开关为兼容保留）")

    with lzma.open(src, "rb") as f:
        raw = f.read()
    outbuf = io.BytesIO()
    replaced = 0
    added_files = 0
    pruned = 0
    # 逐 profile 记账：包名可能与某个 profile 已在场、另一个 profile 缺席
    # （历史实证：headless 只有 3 个 @dsh-android 包，web 已有 8 个——旧的全局 seen 集合
    #  让「web 有就等于全树有」，缺席的 profile 永远补不上）。
    seen_dsh = {}
    seen_ext = {}
    # P0（dev-incoming 实测 2026-09-12）：替换循环只命中「基座里已存在」的成员 → 包内**新增文件**
    # 被静默丢弃（包名已见 ⇒ 不触发整包追加），而 tar 内的 lib/index.js 仍 import 那些新文件
    # → 设备侧 ERR_MODULE_NOT_FOUND，引擎启动即死。修法：记录每个 (profile, 包) 在基座里见到的
    # rel 集合，循环结束后把该包**其余** rel 全部补 push（含 lib/types/**；.map 本就被排除）。
    seen_rels = {}
    seen_dirs = set()
    with tarfile.open(fileobj=io.BytesIO(raw), mode="r:*") as tin, \
            tarfile.open(fileobj=outbuf, mode="w", format=tarfile.PAX_FORMAT) as tout:

        def mode_for(data):
            # 权限归一化（0.13.3）：快照源树在 WSL 9p 挂载上恒为 0777（chmod 无效），
            # 归档权限只能在重打包时按内容判定——ELF/shebang 可执行，其余数据文件不可执行。
            # Android 侧解压器同样按内容赋权，此处让归档本身可审计、可门禁校验。
            return 0o700 if data.startswith(b'\x7fELF') or data.startswith(b'#!') else 0o600

        def push(data, name, mtime):
            newm = tarfile.TarInfo(name)
            newm.size = len(data)
            newm.mtime = mtime
            newm.mode = mode_for(data)
            tout.addfile(newm, io.BytesIO(data))

        def factory_rel(name):
            """若成员位于某个注入包目录内 → (profile, pkg, rel)（含 .map 等不可注入文件）；否则 None。
            用于**修剪陈旧成员**：源包已删的文件不得留在快照里（0.13.7 去 fork 的旧组件就是这么残留的）。"""
            parts = name.split("/")
            if len(parts) < 7 or parts[0:2] != ["home", ".dsh"] or parts[2] != "profiles" \
                    or parts[3] not in PROFILES or parts[4] != "node_modules":
                return None
            if parts[5] == "@dsh-android":
                if len(parts) < 8 or parts[6] not in dsh_names:
                    return None
                return (parts[3], parts[6], "/".join(parts[7:]))
            if parts[5].startswith("@"):
                if len(parts) < 8:
                    return None
                scoped = parts[5] + "/" + parts[6]
                if scoped not in ext_names:
                    return None
                return (parts[3], scoped, "/".join(parts[7:]))
            if parts[5] not in ext_names:
                return None
            return (parts[3], parts[5], "/".join(parts[6:]))

        for member in tin:
            name = member.name
            if member.isfile():
                data = None
                # 修剪：工厂包目录内、源包已不存在的成员一律丢弃（否则「注入后 == 源包」不成立）
                fr = factory_rel(name)
                if fr is not None:
                    fr_prof, fr_pkg, fr_rel = fr
                    fr_pool = dsh_repl if fr_pkg in dsh_names else ext_repl
                    if fr_rel not in fr_pool.get(fr_pkg, {}):
                        pruned += 1
                        if fr_pkg == "dsh-client-ui-responsive" or pruned <= 3:
                            print(f"  [prune] {fr_prof}: {fr_pkg}/{fr_rel}（源包已删）")
                        continue
                hit = match_dsh_android(name, dsh_names) or match_ext(name, ext_names)
                if hit is not None:
                    pkg, rel = hit
                    prof = name.split("/")[3]
                    pool = dsh_repl if (pkg in dsh_names and DSH_ANDROID_NS in name) else ext_repl
                    data = pool[pkg].get(rel)
                    # 无论是否替换，都把「基座里见到的该包 rel」记账：循环后据此补新增文件。
                    seen_rels.setdefault((prof, pkg), set()).add(rel)
                    if data is not None:
                        prof_seen = (seen_dsh if pkg in dsh_names else seen_ext)
                        prof_seen.setdefault(prof, set()).add(pkg)
                        push(data, name, int(member.mtime))
                        replaced += 1
                        continue
                if required_bundles and name.startswith("home/.dsh/profiles/") \
                        and name.endswith("/package.json") and "/node_modules/" not in name \
                        and name.split("/")[3] in target_profiles:
                    handle = tin.extractfile(member)
                    raw_manifest = handle.read() if handle is not None else b""
                    try:
                        manifest = _json.loads(raw_manifest.decode("utf-8"))
                        profile = manifest.setdefault("dsh", {}).setdefault("profile", {})
                        bundles = profile.get("bundles")
                        if not isinstance(bundles, list):
                            bundles = profile["bundles"] = []
                        added = [b for b in required_bundles if b not in bundles]
                        if added:
                            bundles.extend(added)
                            payload = (_json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
                            push(payload, name, int(member.mtime))
                            replaced += 1
                            print(f"  bundles += {', '.join(added)}（{name}）")
                        else:
                            push(raw_manifest, name, int(member.mtime))
                    except Exception as error:
                        print(f"  警告：{name} 解析失败，原样保留（{error}）")
                        push(raw_manifest, name, int(member.mtime))
                    continue
                if name.startswith("home/.dsh/profiles/") and name.endswith("/cordis.patch.yml") \
                        and "/node_modules/" not in name:
                    prof = name.split("/")[3]
                    if prof in target_profiles:
                        push(patch_bytes, name, int(member.mtime))
                        replaced += 1
                        print("  patch replaced:", name)
                        continue
                    print("  skip (not an assembly profile):", name)
                # 基座里已有的 compatibility.json 不透传：统一在追加段按仓库权威源写出，
                # 否则 tar 内会出现同名两张条目（解压取最后一张，属于不可审计的隐式覆盖）。
                if compat_bytes is not None and name.startswith("home/.dsh/profiles/") \
                        and name.endswith("/" + COMPAT_NAME) and "/node_modules/" not in name \
                        and name.split("/")[3] in target_profiles:
                    replaced += 1
                    print("  compat replaced:", name)
                    continue
                if data is None:
                    # 流式复制 + 只读前 4 字节判定权限（勿整文件读进内存：51k 文件 / 743MB 白花几分钟）
                    handle = tin.extractfile(member)
                    prefix = handle.read(4) if handle is not None else b''
                    if handle is not None:
                        handle.seek(0)
                    member.mode = mode_for(prefix)
                    tout.addfile(member, handle)
                else:
                    member.mode = mode_for(data)
                    tout.addfile(member, io.BytesIO(data))
            else:
                if member.isdir():
                    member.mode = 0o700
                    seen_dirs.add(name)
                # symlink/dir/hardlink：无内容，元数据原样复制
                tout.addfile(member)

        # 追加模式：快照内不存在的包 → 落到**每一个**装配 profile（ST-05：只落 web 会让
        # headless 缺包，权威 patch 覆盖过去后 headless 装配失败；目录项一并生成）。
        # 可复现性（2026-09-08）：新增文件用固定 mtime（SOURCE_DATE_EPOCH 可覆写），
        # 否则同一输入的两次构建 sha256 不同 → 设备每次装机都判定「快照变了」重解压。
        now = int(os.environ.get("SOURCE_DATE_EPOCH", "1704067200"))

        def ensure_parent_dirs(path, mtime):
            """补齐新增文件的父目录项（缺失的才 add，避免重复目录条目）。path 为文件全名。"""
            parts = path.split("/")[:-1]
            for i in range(1, len(parts) + 1):
                d = "/".join(parts[:i])
                if d in seen_dirs:
                    continue
                ti = tarfile.TarInfo(d)
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o700
                ti.mtime = mtime
                tout.addfile(ti)
                seen_dirs.add(d)

        # 补缺：包已在基座里、但包内**新增文件**未出现在 tar 中 → 逐个补齐（P0 修复）。
        for (prof, pkg) in sorted(seen_rels):
            pool = dsh_repl if pkg in dsh_names else ext_repl
            if pkg not in pool:
                continue
            base = (f"home/.dsh/profiles/{prof}/node_modules/@dsh-android/{pkg}"
                    if pkg in dsh_names else f"home/.dsh/profiles/{prof}/node_modules/{pkg}")
            missing = [rel for rel in sorted(pool[pkg]) if rel not in seen_rels[(prof, pkg)]]
            if not missing:
                (seen_dsh if pkg in dsh_names else seen_ext).setdefault(prof, set()).add(pkg)
                continue
            for rel in missing:
                ensure_parent_dirs(base + "/" + rel, now)
                push(pool[pkg][rel], base + "/" + rel, now)
                added_files += 1
            (seen_dsh if pkg in dsh_names else seen_ext).setdefault(prof, set()).add(pkg)
            print(f"  [fill] {prof}: "
                  f"{'@dsh-android/' if pkg in dsh_names else ''}{pkg} 新增 {len(missing)} 文件 "
                  f"({', '.join(missing[:4])}{'…' if len(missing) > 4 else ''})")

        for prof in target_profiles:
            for pkg in sorted(dsh_names - seen_dsh.get(prof, set())):
                base = f"home/.dsh/profiles/{prof}/node_modules/@dsh-android/{pkg}"
                for dirpath in [base, base + "/lib"]:
                    ti = tarfile.TarInfo(dirpath)
                    ti.type = tarfile.DIRTYPE
                    ti.mode = 0o700
                    ti.mtime = now
                    tout.addfile(ti)
                for rel, data in sorted(dsh_repl[pkg].items()):
                    push(data, base + "/" + rel, now)
                    added_files += 1
                print(f"  [add] {prof}: @dsh-android/{pkg} ({len(dsh_repl[pkg])} files)")
            for pkg in sorted(ext_names - seen_ext.get(prof, set())):
                base = f"home/.dsh/profiles/{prof}/node_modules/{pkg}"
                for rel, data in sorted(ext_repl[pkg].items()):
                    push(data, base + "/" + rel, now)
                    added_files += 1
                print(f"  [add] {prof}: {pkg} ({len(ext_repl[pkg])} files)")

        # profile 级插件版本豁免（见 COMPAT_SRC 注释）：与权威 patch 同覆盖面、同负控口径，
        # 固定 mtime 保可复现构建。
        if compat_bytes is not None:
            for prof in target_profiles:
                path = f"home/.dsh/profiles/{prof}/{COMPAT_NAME}"
                push(compat_bytes, path, now)
                added_files += 1
                print("  [compat] injected:", path)

        # combo 缓存注入段（A3）：注入的 client.js 由构建链预计算为 client-combos.inject.json +
        # <sha256>.map，这里作为新 tar 条目合入出厂 web profile 缓存目录（运行时按 sha256 查表，
        # 两份清单按序合并）。固定 mtime（now）保持可复现构建。
        if combo_delta:
            base = "home/.dsh/profiles/web/.combo-cache"
            for rel in sorted(combo_delta):
                ensure_parent_dirs(base + "/" + rel, now)
                push(combo_delta[rel], base + "/" + rel, now)
            print(f"  [combo-cache] injected: {len(combo_delta)} file(s) -> {base}/")

    with lzma.open(dst, "wb", preset=preset) as f:
        f.write(outbuf.getvalue())
    print(f"replaced entries: {replaced} | added files: {added_files} | pruned stale: {pruned} | preset={preset}")
    print("written:", dst, os.path.getsize(dst), "bytes")


if __name__ == "__main__":
    main()

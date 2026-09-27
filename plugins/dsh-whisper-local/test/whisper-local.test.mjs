// 本机 whisper provider 单测（无网络、无需真实模型/二进制）
//
// 锁四件事：① 自报 host-local + 语言表；② 模型不在时 preparation 报 unprepared 且 transcribe 明确报错
// （而不是 spawn 一个注定失败的进程）；③ 就绪后 transcribe 的参数与返回结构（用假二进制打桩 spawn）；
// ④ 临时 WAV 必须落在 DSH_HOME/tmp —— 本机 os.tmpdir() 指向烧死的 com.termux 前缀（实测 EACCES）。
import assert from "node:assert/strict";
import { test } from 'node:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const plugin = await import("../index.js");

function tinyWav() {
  const samples = 32;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(16000, 24);
  buffer.writeUInt32LE(32000, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(samples * 2, 40);
  return buffer;
}

function register(config) {
  const registered = [];
  const ctx = { speechToText: { register: (provider) => (registered.push(provider), async () => {}) }, effect: (fn) => fn() };
  plugin.apply(ctx, config);
  return registered[0];
}

test("info：host-local + auto/zh/en/yue 等语言提示", () => {
  const provider = register({ modelDirectory: mkdtempSync(join(tmpdir(), "whisper-info-")) });
  assert.equal(provider.info.location, "host-local");
  assert.equal(provider.info.id, "whisper-tiny", "默认档（随包 tiny）的 provider id");
  for (const language of ["auto", "zh", "en", "yue"]) assert.ok(provider.info.languages.includes(language), language);
});

test("启动阶梯：直连 → linker64 → sh -c，顺序与 argv 形态固定（app 私有 ELF 的 exec 兜底）", () => {
  // 真机实锤（2026-09-27）：Android 15+ 禁止 app 私有目录 ELF 直接 execve ⇒ spawn EACCES。
  // 壳侧起引擎自己就是「直连失败→linker64」，本插件用同一套阶梯；这里是它的回归锚点：
  // 顺序不能变（直连优先，避免无谓地绕一层 loader），argv 形态必须正确（sh 档要 exec "$0" "$@"）。
  const ladder = plugin.launchLadder('/x/whisper-cli', ['-m', 'model', '-f', 'a.wav']);
  assert.deepEqual(ladder.map((c) => c.how), ['direct', 'linker64', 'sh']);
  assert.deepEqual(ladder[0], { how: 'direct', cmd: '/x/whisper-cli', argv: ['-m', 'model', '-f', 'a.wav'] });
  assert.deepEqual(ladder[1], { how: 'linker64', cmd: '/system/bin/linker64', argv: ['/x/whisper-cli', '-m', 'model', '-f', 'a.wav'] });
  assert.deepEqual(ladder[2].argv, ['-c', 'exec "$0" "$@"', '/x/whisper-cli', '-m', 'model', '-f', 'a.wav']);
});

test("前缀推导：不吃 linker64 的 execPath（引擎里 execPath 是 linker，真机实测踩到）", () => {
  // 引擎由壳侧用 /system/bin/linker64 装载 ⇒ process.execPath === /apex/com.android.runtime/bin/linker64。
  // 若按它推导就会得到 /apex/.../whisper-cli（不存在）。三源按可靠性排序：
  // ① TERMUX__PREFIX（壳侧注入）② 由 argv[1] 反推 ③ execPath 兜底。
  const fake = mkdtempSync(join(tmpdir(), "whisper-prefix-"));
  mkdirSync(join(fake, "bin"), { recursive: true });
  mkdirSync(join(fake, "lib", "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  const argv1 = join(fake, "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");

  // ① 壳侧 env 优先
  assert.equal(plugin.resolvePrefix({ TERMUX__PREFIX: fake }, "/nonexistent/bin.js", "/apex/com.android.runtime/bin/linker64"), fake);
  // ② env 缺席时由 argv[1] 反推（五层到前缀）
  assert.equal(plugin.resolvePrefix({}, argv1, "/apex/com.android.runtime/bin/linker64"), fake);
  // ③ 都不行时退回 execPath 目录（此处 linker 目录不存在 bin/，故返回首个候选即可，不抛）
  assert.doesNotThrow(() => plugin.resolvePrefix({}, "/nonexistent/bin.js", "/apex/com.android.runtime/bin/linker64"));
});

test("线程数：显式配置优先；0/非法值按机器并行度自动（留一核，上限 8）", () => {
  // 实测（11 s 音频 / small-q5 档）：4 线程 17.7 s、6 线程 12.7 s、8 线程 10.4 s —— 线程数对
  // whisper 的 CPU 推理影响很大，故默认按机器自动而不是写死 4。
  assert.equal(plugin.resolveThreads(3), 3);
  assert.equal(plugin.resolveThreads(32), 16, "显式值封顶 16，防用户手填过大");
  assert.equal(plugin.resolveThreads(0, 10), 8, "10 核 → 留一核且封顶 8");
  assert.equal(plugin.resolveThreads(0, 4), 3);
  assert.equal(plugin.resolveThreads(undefined, 1), 2, "极小机器也保底 2");
});

test("多档注册：内置目录的四档各注册一个 provider（设置页就是模型选择器）", () => {
  const registered = [];
  const ctx = { speechToText: { register: (p) => (registered.push(p), async () => {}) }, effect: (fn) => fn() };
  plugin.apply(ctx, { modelDirectory: mkdtempSync(join(tmpdir(), "whisper-tiers-")) });
  assert.deepEqual(registered.map((p) => p.info.id), ["whisper-tiny", "whisper-base", "whisper-small-q5", "whisper-small"]);
  assert.ok(registered.every((p) => p.info.location === "host-local"));
  assert.ok(registered.every((p) => typeof p.preparation?.prepare === "function"));
});

test("中文提示词：language=zh 时 argv 必须带 --prompt（whisper 简繁/标点矫正）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whisper-zh-"));
  writeFileSync(join(dir, "ggml-tiny.bin"), "x");
  // 假 CLI：把收到的参数原样打到 stdout，用来断言 argv
  const script = join(dir, "fake-whisper-args");
  writeFileSync(script, '#!/bin/sh\nprintf "%s " "$@"\n');
  chmodSync(script, 0o755);
  const provider = register({ modelDirectory: dir, model: "ggml-tiny.bin", binary: script, models: [{ id: "whisper-tiny", file: "ggml-tiny.bin" }] });
  const result = await provider.transcribe({ audio: tinyWav(), language: "zh" }, new AbortController().signal);
  assert.match(result.text, /-l zh/);
  assert.match(result.text, /--prompt 以下是普通话的句子。/);
  // yue（粤语）不在 whisper 语言表里 → 落到 zh，同样带提示词
  const yue = await provider.transcribe({ audio: tinyWav(), language: "yue" }, new AbortController().signal);
  assert.match(yue.text, /-l zh/);
  // en 不带中文提示词
  const en = await provider.transcribe({ audio: tinyWav(), language: "en" }, new AbortController().signal);
  assert.doesNotMatch(en.text, /--prompt/);
});

test("模型缺失：preparation 报 unprepared，transcribe 给可执行错误（不 spawn 注定失败的进程）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whisper-missing-"));
  const provider = register({ modelDirectory: dir, model: "ggml-tiny.bin" });
  assert.equal(provider.preparation.snapshot().phase, "unprepared");
  await assert.rejects(
    () => provider.transcribe({ audio: tinyWav(), language: "auto" }, new AbortController().signal),
    (error) => /模型尚未就绪/.test(String(error.message)),
  );
});

test("模型在场：preparation 报 ready，transcribe 落到配置的二进制并返回契约结构", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whisper-ready-"));
  writeFileSync(join(dir, "ggml-tiny.bin"), "not-a-real-model");
  const script = join(dir, "fake-whisper");
  // 假 whisper-cli：回显一段固定文本，用来验证 spawn 参数/读取 stdout/返回结构（不依赖真实推理）
  writeFileSync(script, "#!/bin/sh\nprintf 'hello from fake whisper\\n'\n");
  chmodSync(script, 0o755);
  const provider = register({ modelDirectory: dir, model: "ggml-tiny.bin", binary: script });
  assert.equal(provider.preparation.snapshot().phase, "ready");
  const result = await provider.transcribe({ audio: tinyWav(), language: "en" }, new AbortController().signal);
  assert.equal(result.text, "hello from fake whisper");
  assert.ok(result.audioSeconds > 0);
  assert.ok(result.inferenceSeconds >= 0);
});

test("二进制缺失：报「无法启动」而不是挂死（错误信息含路径）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "whisper-nobin-"));
  writeFileSync(join(dir, "ggml-tiny.bin"), "x");
  const provider = register({ modelDirectory: dir, model: "ggml-tiny.bin", binary: join(dir, "no-such-bin") });
  await assert.rejects(
    () => provider.transcribe({ audio: tinyWav(), language: "en" }, new AbortController().signal),
    (error) => /无法启动/.test(String(error.message)),
  );
});

test("临时 WAV 落 DSH_HOME/tmp（本机 os.tmpdir() 是烧死的 com.termux 前缀）", async () => {
  const home = mkdtempSync(join(tmpdir(), "whisper-home-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const script = join(home, "fake-whisper");
    writeFileSync(script, "#!/bin/sh\nprintf ok\n");
    chmodSync(script, 0o755);
    mkdirSync(join(home, "speech-to-text", "whisper"), { recursive: true });
    writeFileSync(join(home, "speech-to-text", "whisper", "ggml-tiny.bin"), "x");
    const provider = register({ binary: script });
    assert.ok(existsSync(join(home, "tmp")), "必须创建 DSH_HOME/tmp");
    const result = await provider.transcribe({ audio: tinyWav(), language: "auto" }, new AbortController().signal);
    assert.equal(result.text, "ok");
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

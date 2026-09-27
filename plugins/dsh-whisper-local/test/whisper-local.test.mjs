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
  assert.equal(provider.info.id, "whisper-local");
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

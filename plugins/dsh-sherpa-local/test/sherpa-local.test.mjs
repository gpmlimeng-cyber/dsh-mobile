// 本机 sherpa-onnx（SenseVoice）provider 单测（无网络、无需真实模型/二进制）
//
// 锁六件事：① 自报 host-local + SenseVoice 六语言；② 资产缺失时 preparation 报 unprepared 且
// transcribe 明确报错（而不是 spawn 一个注定失败的进程）；③ 可选资产（silero VAD）缺失不阻塞主链路；
// ④ 就绪后 transcribe 的 argv 与返回契约（用假二进制打桩 spawn）；⑤ CLI 两种真实输出形态的解析；
// ⑥ 临时 WAV 必须落在 DSH_HOME/tmp —— 本机 os.tmpdir() 指向烧死的 com.termux 前缀（实测 EACCES）。
import assert from "node:assert/strict";
import { test } from 'node:test';
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

const ASSETS = [
  { file: "tokens.txt", bytes: 8, bundled: true },
  { file: "model.int8.onnx", bytes: 8, bundled: false },
  { file: "silero_vad.onnx", bytes: 8, bundled: true, optional: true },
];

/** 假 sherpa CLI：把收到的参数当成识别文本回吐（JSON 形态，与真实离线档一致）。 */
function fakeBinary(dir, name = "fake-sherpa") {
  const script = join(dir, name);
  writeFileSync(script, "#!/bin/sh\nprintf '{\"text\": \"%s\"}\\n' \"$*\"\n");
  chmodSync(script, 0o755);
  return script;
}

function materialize(dir, files = ["tokens.txt", "model.int8.onnx"]) {
  for (const file of files) writeFileSync(join(dir, file), "x");
}

function register(config) {
  const registered = [];
  const ctx = { speechToText: { register: (provider) => (registered.push(provider), async () => {}) }, effect: (fn) => fn() };
  plugin.apply(ctx, config);
  return registered[0];
}

test("info：host-local + SenseVoice 的 auto/zh/en/ja/ko/yue", () => {
  const provider = register({ modelDirectory: mkdtempSync(join(tmpdir(), "sherpa-info-")) });
  assert.equal(provider.info.id, "sherpa-sensevoice");
  assert.equal(provider.info.location, "host-local");
  for (const language of ["auto", "zh", "en", "ja", "ko", "yue"]) {
    assert.ok(provider.info.languages.includes(language), language);
  }
  assert.ok(provider.info.setupEstimate.recommendedDiskBytes >= 239 * 1024 * 1024, "磁盘预估必须覆盖 239 MB 模型");
});

test("启动阶梯：直连 → linker64 → sh -c，顺序与 argv 形态固定（app 私有 ELF 的 exec 兜底）", () => {
  // 与 dsh-whisper-local 同一套：Android 15+ 禁止 app 私有目录 ELF 直接 execve（spawn EACCES），
  // 壳侧起引擎自己就是「直连失败→linker64」。顺序不能变，sh 档必须 exec "$0" "$@"。
  const ladder = plugin.launchLadder("/x/sherpa-onnx-offline", ["--tokens=t", "a.wav"]);
  assert.deepEqual(ladder.map((c) => c.how), ["direct", "linker64", "sh"]);
  assert.deepEqual(ladder[0], { how: "direct", cmd: "/x/sherpa-onnx-offline", argv: ["--tokens=t", "a.wav"] });
  assert.deepEqual(ladder[1], { how: "linker64", cmd: "/system/bin/linker64", argv: ["/x/sherpa-onnx-offline", "--tokens=t", "a.wav"] });
  assert.deepEqual(ladder[2].argv, ["-c", 'exec "$0" "$@"', "/x/sherpa-onnx-offline", "--tokens=t", "a.wav"]);
});

test("前缀推导：不吃 linker64 的 execPath（引擎里 execPath 是 linker，真机实测踩到）", () => {
  const fake = mkdtempSync(join(tmpdir(), "sherpa-prefix-"));
  mkdirSync(join(fake, "bin"), { recursive: true });
  mkdirSync(join(fake, "lib", "node_modules", "@deepseek-ai", "dsh", "lib"), { recursive: true });
  const argv1 = join(fake, "lib", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  assert.equal(plugin.resolvePrefix({ TERMUX__PREFIX: fake }, "/nonexistent/bin.js", "/apex/com.android.runtime/bin/linker64"), fake);
  assert.equal(plugin.resolvePrefix({}, argv1, "/apex/com.android.runtime/bin/linker64"), fake);
  assert.doesNotThrow(() => plugin.resolvePrefix({}, "/nonexistent/bin.js", "/apex/com.android.runtime/bin/linker64"));
});

test("线程数：显式配置优先；0/非法值按机器并行度自动（留一核，上限 8）", () => {
  assert.equal(plugin.resolveThreads(3), 3);
  assert.equal(plugin.resolveThreads(32), 16);
  assert.equal(plugin.resolveThreads(0, 10), 8);
  assert.equal(plugin.resolveThreads(0, 4), 3);
  assert.equal(plugin.resolveThreads(undefined, 1), 2);
});

test("语言归一：SenseVoice 六值原样，其余回落默认（clamp 掉 whisper 的 jp 之类）", () => {
  assert.equal(plugin.resolveLanguage("zh"), "zh");
  assert.equal(plugin.resolveLanguage("yue"), "yue", "粤语必须原样传给 CLI，不能像 whisper 那样落成 zh");
  assert.equal(plugin.resolveLanguage("auto"), "auto");
  assert.equal(plugin.resolveLanguage("fr"), "zh", "不支持的语言回落配置默认值");
  assert.equal(plugin.resolveLanguage(undefined, "en"), "en");
  assert.equal(plugin.resolveLanguage("jp", "jp"), "auto", "默认值也非法时兜底 auto");
});

test("argv 组装：直接档与 VAD 档（VAD 档补 --silero-vad-model，wav 恒在末位）", () => {
  const direct = plugin.buildArgs({ dir: "/m", wav: "/t/a.wav", language: "zh", threads: 8 });
  assert.deepEqual(direct, [
    "--tokens=/m/tokens.txt",
    "--sense-voice-model=/m/model.int8.onnx",
    "--sense-voice-language=zh",
    "--sense-voice-use-itn=true",
    "--num-threads=8",
    "/t/a.wav",
  ]);
  const vad = plugin.buildArgs({ dir: "/m", wav: "/t/a.wav", language: "en", useItn: false, threads: 4, vad: true });
  assert.ok(vad.includes("--silero-vad-model=/m/silero_vad.onnx"));
  assert.ok(vad.includes("--sense-voice-use-itn=false"));
  assert.equal(vad.at(-1), "/t/a.wav");
  assert.ok(vad.indexOf("--silero-vad-model=/m/silero_vad.onnx") < vad.indexOf("/t/a.wav"));
});

test("输出解析：JSON 档（可带前置 wav 行）、VAD 段档（空句丢弃）、纯文本兜底", () => {
  // ① 离线档实测形态：先一行 wav 路径，再一行 JSON
  assert.equal(
    plugin.parseSenseVoiceOutput('/t/a.wav\n{"text": "今天天气不错，我们出去玩吧。", "timestamps": [0.1]}\n', "/t/a.wav"),
    "今天天气不错，我们出去玩吧。",
  );
  // ② VAD 档实测形态：每句一行 `起 -- 止: 文本`
  assert.equal(
    plugin.parseSenseVoiceOutput("0.320 -- 3.840: 今天天气不错\n3.840 -- 5.200: \n5.200 -- 7.100: 我们出去玩吧\n"),
    "今天天气不错 我们出去玩吧",
  );
  // ③ 都不是时原样返回，不得把 JSON 噪音漏出去
  assert.equal(plugin.parseSenseVoiceOutput('{"text": ""}\n'), "");
  assert.equal(plugin.parseSenseVoiceOutput("裸文本输出\n"), "裸文本输出");
  assert.equal(plugin.parseSenseVoiceOutput(""), "");
});

test("资产缺失：preparation 报 unprepared，transcribe 给可执行错误（不 spawn 注定失败的进程）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sherpa-missing-"));
  const provider = register({ modelDirectory: dir, assets: ASSETS });
  assert.equal(provider.preparation.snapshot().phase, "unprepared");
  await assert.rejects(
    () => provider.transcribe({ audio: tinyWav(), language: "zh" }, new AbortController().signal),
    (error) => /模型尚未就绪/.test(String(error.message)) && /239 MB/.test(String(error.message)),
  );
});

test("可选资产缺席不阻塞主链路：silero 不在也 ready（VAD 档自动降级为直接档）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sherpa-novad-"));
  materialize(dir); // tokens + model，故意不给 silero_vad.onnx
  const script = fakeBinary(dir);
  const provider = register({ modelDirectory: dir, assets: ASSETS, binary: script, vadBinary: script, vad: true });
  assert.equal(provider.preparation.snapshot().phase, "ready");
  const result = await provider.transcribe({ audio: tinyWav(), language: "zh" }, new AbortController().signal);
  assert.doesNotMatch(result.text, /--silero-vad-model/, "silero 缺失时必须回落直接档");
  assert.match(result.text, /--sense-voice-model=/);
});

test("就绪后：argv 落到配置的二进制并返回契约结构（text/audioSeconds/inferenceSeconds）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sherpa-ready-"));
  materialize(dir);
  const script = fakeBinary(dir);
  const provider = register({ modelDirectory: dir, assets: ASSETS, binary: script, threads: 6 });
  assert.equal(provider.preparation.snapshot().phase, "ready");
  const result = await provider.transcribe({ audio: tinyWav(), language: "zh" }, new AbortController().signal);
  assert.match(result.text, /--tokens=.*tokens\.txt/);
  assert.match(result.text, /--sense-voice-model=.*model\.int8\.onnx/);
  assert.match(result.text, /--sense-voice-language=zh/);
  assert.match(result.text, /--sense-voice-use-itn=true/);
  assert.match(result.text, /--num-threads=6/);
  assert.ok(result.audioSeconds > 0);
  assert.ok(result.inferenceSeconds >= 0);
});

test("VAD 档：silero 在场时走 vadBinary 并带 --silero-vad-model", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sherpa-vad-"));
  materialize(dir, ["tokens.txt", "model.int8.onnx", "silero_vad.onnx"]);
  const direct = fakeBinary(dir, "fake-direct");
  const vad = fakeBinary(dir, "fake-vad");
  const provider = register({ modelDirectory: dir, assets: ASSETS, binary: direct, vadBinary: vad, vad: true });
  const result = await provider.transcribe({ audio: tinyWav(), language: "yue" }, new AbortController().signal);
  assert.match(result.text, /--silero-vad-model=.*silero_vad\.onnx/);
  assert.match(result.text, /--sense-voice-language=yue/);
});

test("二进制缺失：报「无法启动」而不是挂死（错误信息含路径）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sherpa-nobin-"));
  materialize(dir);
  const provider = register({ modelDirectory: dir, assets: ASSETS, binary: join(dir, "no-such-bin") });
  await assert.rejects(
    () => provider.transcribe({ audio: tinyWav(), language: "zh" }, new AbortController().signal),
    (error) => /无法启动/.test(String(error.message)),
  );
});

test("空录音：明确报「录音为空」，不启动进程", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sherpa-empty-"));
  materialize(dir);
  const provider = register({ modelDirectory: dir, assets: ASSETS, binary: fakeBinary(dir) });
  await assert.rejects(
    () => provider.transcribe({ audio: Buffer.alloc(0), language: "zh" }, new AbortController().signal),
    (error) => /录音为空/.test(String(error.message)),
  );
});

test("临时 WAV 落 DSH_HOME/tmp 且识别后被清理（本机 os.tmpdir() 是烧死的 com.termux 前缀）", async () => {
  const home = mkdtempSync(join(tmpdir(), "sherpa-home-"));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    mkdirSync(join(home, "speech-to-text", "sherpa"), { recursive: true });
    materialize(join(home, "speech-to-text", "sherpa"));
    const script = fakeBinary(home);
    const provider = register({ assets: ASSETS, binary: script });
    assert.ok(existsSync(join(home, "tmp")), "必须创建 DSH_HOME/tmp");
    const result = await provider.transcribe({ audio: tinyWav(), language: "auto" }, new AbortController().signal);
    assert.ok(result.text.length > 0);
    const leftovers = readdirSync(join(home, "tmp")).filter((file) => file.endsWith(".wav"));
    assert.deepEqual(leftovers, [], "临时 WAV 必须清理干净");
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  }
});

test("WAV 归一化：尺寸字段陈旧也能救回（真机实测截断 jfk.wav 让 sherpa 直接退出 255）", () => {
  // 造一个「声明 352000 字节、实际只有 1000 字节」的坏容器（真机实测形态：whisper 出字、sherpa 硬失败）
  const payload = Buffer.alloc(1000, 7);
  const broken = Buffer.alloc(44 + payload.byteLength);
  broken.write("RIFF", 0, "latin1");
  broken.writeUInt32LE(352078, 4);
  broken.write("WAVE", 8, "latin1");
  broken.write("fmt ", 12, "latin1");
  broken.writeUInt32LE(16, 16);
  broken.writeUInt16LE(1, 20);
  broken.writeUInt16LE(1, 22);
  broken.writeUInt32LE(16000, 24);
  broken.writeUInt32LE(32000, 28);
  broken.writeUInt16LE(2, 32);
  broken.writeUInt16LE(16, 34);
  broken.write("data", 36, "latin1");
  broken.writeUInt32LE(352000, 40);
  payload.copy(broken, 44);

  const fixed = plugin.normalizeWav(broken);
  assert.equal(fixed.readUInt32LE(4) + 8, fixed.byteLength, "RIFF 尺寸必须等于实际长度");
  assert.equal(fixed.readUInt32LE(40), 1000, "data 尺寸必须等于真实载荷长度");
  assert.deepEqual(fixed.subarray(44), payload, "载荷不得被改动");
  assert.ok(plugin.wavSeconds(fixed) > 0);

  // 正常容器：载荷与尺寸都不变
  const good = plugin.normalizeWav(tinyWav());
  assert.equal(good.readUInt32LE(40), 64);
  assert.deepEqual(good.subarray(44), tinyWav().subarray(44));

  // 附带信息块（LIST/INFO，Lavf 常见）：块被丢弃但载荷无损
  const withList = Buffer.alloc(12 + 8 + 16 + 8 + 26 + 8 + 64);
  let off = 0;
  withList.write("RIFF", off, "latin1"); withList.writeUInt32LE(withList.byteLength - 8, off + 4); withList.write("WAVE", off + 8, "latin1"); off += 12;
  withList.write("fmt ", off, "latin1"); withList.writeUInt32LE(16, off + 4);
  withList.writeUInt16LE(1, off + 8); withList.writeUInt16LE(1, off + 10); withList.writeUInt32LE(16000, off + 12);
  withList.writeUInt32LE(32000, off + 16); withList.writeUInt16LE(2, off + 20); withList.writeUInt16LE(16, off + 22); off += 24;
  withList.write("LIST", off, "latin1"); withList.writeUInt32LE(26, off + 4); off += 34;
  withList.write("data", off, "latin1"); withList.writeUInt32LE(64, off + 4); withList.fill(9, off + 8, off + 72);
  const stripped = plugin.normalizeWav(withList);
  assert.equal(stripped.toString("latin1", 12, 16), "fmt ");
  assert.equal(stripped.toString("latin1", 36, 40), "data", "只保留 fmt + data，LIST 必须丢掉");
  assert.equal(stripped.readUInt32LE(40), 64);

  // 非 WAV / 垃圾输入：原样返回，绝不抛
  const junk = Buffer.from("not a wav at all");
  assert.equal(plugin.normalizeWav(junk), junk);
  assert.doesNotThrow(() => plugin.normalizeWav(Buffer.alloc(0)));
});

test("截断 WAV 走完 transcribe 全链：假 CLI 能拿到归一化后的文件", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sherpa-trunc-"));
  materialize(dir);
  // 假 CLI 改成回吐「文件实际字节数」，用来断言落盘的确是被修好的容器
  const script = join(dir, "fake-size");
  writeFileSync(script, "#!/bin/sh\nfor a in \"$@\"; do case \"$a\" in *.wav) printf '{\"text\": \"size=%s\"}' \"$(wc -c < \"$a\")\";; esac; done\n");
  chmodSync(script, 0o755);
  const provider = register({ modelDirectory: dir, assets: ASSETS, binary: script });
  const declared = tinyWav();
  declared.writeUInt32LE(999999, 40); // 声明远超实际
  const result = await provider.transcribe({ audio: declared, language: "zh" }, new AbortController().signal);
  assert.equal(result.text, `size=${44 + 64}`, "落盘的必须是归一化后的规范容器");
});

/** 打桩 fetch：返回可控分块 body 与 content-length，用于验证下载/校验/换源。 */
function stubFetch(chunks, contentLength, { times = Infinity } = {}) {
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    if (calls > times) throw new Error("stub exhausted");
    return {
      ok: true,
      status: 200,
      headers: { get: (name) => (name.toLowerCase() === "content-length" ? String(contentLength) : null) },
      body: (async function* () {
        for (const chunk of chunks) yield Buffer.from(chunk);
      })(),
    };
  };
  return { calls: () => calls, restore: () => { globalThis.fetch = real; } };
}

async function settled(preparation, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const phase = preparation.snapshot().phase;
    if (phase !== "preparing") return preparation.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("preparation 未在超时内落定");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

test("下载成功：内容与 sha256 相符 → ready，且 .part 不残留", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sherpa-dl-ok-"));
  const body = "sensevoice-model-dummy";
  const stub = stubFetch([body], body.length);
  try {
    const provider = register({
      modelDirectory: dir,
      assets: [{ file: "model.int8.onnx", bytes: body.length, sha256: sha256(body) }],
      modelOrigins: ["https://example.invalid/"],
    });
    assert.equal(provider.preparation.snapshot().phase, "unprepared");
    provider.preparation.prepare();
    const state = await settled(provider.preparation);
    assert.equal(state.phase, "ready", JSON.stringify(state));
    assert.equal(readFileSync(join(dir, "model.int8.onnx"), "utf8"), body);
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".part")), []);
  } finally {
    stub.restore();
  }
});

test("下载校验失败：sha256 不符 → failed（宁可失败也不喂坏权重），且换源重试", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sherpa-dl-bad-"));
  const body = "truncated-onnx";
  const stub = stubFetch([body], body.length);
  try {
    const provider = register({
      modelDirectory: dir,
      assets: [{ file: "model.int8.onnx", bytes: body.length, sha256: sha256("the-real-model") }],
      modelOrigins: ["https://a.invalid/", "https://b.invalid/"],
    });
    provider.preparation.prepare();
    const state = await settled(provider.preparation);
    assert.equal(state.phase, "failed");
    assert.match(String(state.error), /校验失败/);
    assert.equal(stub.calls(), 2, "两个源都要试过才判失败");
    assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".part")), [], "坏包必须清掉");
    assert.equal(existsSync(join(dir, "model.int8.onnx")), false, "不得把坏包改名成正式文件");
  } finally {
    stub.restore();
  }
});

test("下载不完整：content-length 与实收字节不符 → 判失败（fetch 不报错的静默截断）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sherpa-dl-short-"));
  const body = "abc";
  const stub = stubFetch([body], body.length + 100);
  try {
    const provider = register({
      modelDirectory: dir,
      assets: [{ file: "model.int8.onnx", bytes: body.length + 100, sha256: sha256(body) }],
      modelOrigins: ["https://only.invalid/"],
    });
    provider.preparation.prepare();
    const state = await settled(provider.preparation);
    assert.equal(state.phase, "failed");
    assert.match(String(state.error), /下载不完整/);
  } finally {
    stub.restore();
  }
});

test("多资产：缺哪个下哪个，已就绪的不重复下载（增量进度）", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sherpa-dl-inc-"));
  writeFileSync(join(dir, "tokens.txt"), "already-here");
  const body = "model-bytes";
  const stub = stubFetch([body], body.length);
  try {
    const provider = register({
      modelDirectory: dir,
      assets: [
        { file: "tokens.txt", bytes: 12, sha256: sha256("already-here") },
        { file: "model.int8.onnx", bytes: body.length, sha256: sha256(body) },
      ],
      modelOrigins: ["https://example.invalid/"],
    });
    provider.preparation.prepare();
    const state = await settled(provider.preparation);
    assert.equal(state.phase, "ready");
    assert.equal(stub.calls(), 1, "已在场的 tokens 不得重下");
  } finally {
    stub.restore();
  }
});

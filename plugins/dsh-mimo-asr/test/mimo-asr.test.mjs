// MiMo 云端 ASR provider 单测（无网络：fetch 被打桩）
//
// 锁三件实测踩过的事：① 端点必须是 token-plan-cn.xiaomimimo.com（api.xiaomimimo.com 会 401
// invalid_key）；② 请求体形状（model/input_audio/asr_options）；③ 正文前的语言标签要剥掉。
import assert from "node:assert/strict";
import { test } from 'node:test';
import { apply, stripLanguageTag } from "../index.js";

/** 极小合法 WAV（44 字节头 + 32 个静音样本，16 kHz 单声道 16 bit）。 */
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

function registerOnce(extraCtx = {}) {
  const registered = [];
  const ctx = {
    speechToText: { register: (provider) => (registered.push(provider), async () => {}) },
    effect: (fn) => fn(),
    ...extraCtx,
  };
  apply(ctx, { apiKey: "test-key" });
  return registered[0];
}

/** 只装配凭据服务、不显式给 apiKey 的实例（复现真机：key 在凭据服务里、不在进程 env）。 */
function registerWithCredentials(credentials) {
  const registered = [];
  const ctx = {
    speechToText: { register: (provider) => (registered.push(provider), async () => {}) },
    effect: (fn) => fn(),
    get: (name) => (name === "credentials" ? credentials : undefined),
  };
  apply(ctx, { apiKey: "", apiKeyEnv: "XIAOMI_TOKEN_PLAN_CN_API_KEY" });
  return registered[0];
}

test("info：声明为 cloud provider，语言含 auto/zh/en", () => {
  const provider = registerOnce();
  assert.equal(provider.info.location, "cloud");
  assert.equal(provider.info.id, "mimo-asr");
  assert.deepEqual(provider.info.languages, ["auto", "zh", "en"]);
});

test("无准备要求：preparation 省略时上层视为 ready（云 provider 不下载任何资源）", () => {
  assert.equal(registerOnce().preparation, undefined);
});

test("请求：端点固定 token-plan-cn + 请求体形状 + 语言提示映射", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init });
    return new Response(JSON.stringify({ choices: [{ message: { content: "<chinese> 你好世界" } }] }), { status: 200 });
  };
  try {
    const result = await registerOnce().transcribe({ audio: tinyWav(), language: "zh" }, new AbortController().signal);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "https://token-plan-cn.xiaomimimo.com/v1/chat/completions");
    const body = JSON.parse(seen[0].init.body);
    assert.equal(body.model, "mimo-v2.5-asr");
    assert.equal(body.asr_options.language, "zh");
    assert.equal(body.messages[0].content[0].type, "input_audio");
    assert.match(body.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
    assert.equal(result.text, "你好世界", "语言标签必须剥掉");
    assert.ok(result.audioSeconds > 0, "wavSeconds 必须从 WAV 头算出时长");
    assert.ok(result.inferenceSeconds >= 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("语言提示：provider 不支持时回落 auto（不把非法值透传给服务端）", async () => {
  const seen = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    seen.push(JSON.parse(init.body).asr_options.language);
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  };
  try {
    await registerOnce().transcribe({ audio: tinyWav(), language: "yue" }, new AbortController().signal);
    assert.deepEqual(seen, ["auto"]);
  } finally {
    globalThis.fetch = original;
  }
});

test("无密钥：报可执行的错误（指引 env 或 key 文件）", async () => {
  const registered = [];
  const ctx = { speechToText: { register: (p) => (registered.push(p), async () => {}) }, effect: (fn) => fn() };
  const envBackup = process.env.MIMO_API_KEY;
  delete process.env.MIMO_API_KEY;
  apply(ctx, { apiKeyEnv: "MIMO_API_KEY", apiKeyFile: "" });
  try {
    await registered[0].transcribe({ audio: tinyWav(), language: "auto" }, new AbortController().signal);
    assert.fail("必须抛错");
  } catch (error) {
    assert.match(String(error.message), /no API key/);
    assert.match(String(error.message), /MIMO_API_KEY/);
  } finally {
    if (envBackup !== undefined) process.env.MIMO_API_KEY = envBackup;
  }
});

test("凭据服务优先：key 在 ctx.credentials 里（进程 env 没有）也必须能识别", async () => {
  // 真机实锤（2026-09-27）：DSH 的供应商 key 落在 $DSH_HOME/.credentials.yaml，由凭据服务按 ref
  // 解析，**不导出到进程环境变量** ⇒ 只查 process.env 的实现在真机上恒报 no API key。
  const seen = [];
  const original = globalThis.fetch;
  const envBackup = process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY;
  delete process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY;
  globalThis.fetch = async (url, init) => {
    seen.push(init.headers);
    return new Response(JSON.stringify({ choices: [{ message: { content: "凭据服务取到的 key 生效" } }] }), { status: 200 });
  };
  try {
    const provider = registerWithCredentials({
      resolve: async (ref) => (ref === "XIAOMI_TOKEN_PLAN_CN_API_KEY" ? { value: "tp-from-store", source: "file" } : undefined),
    });
    const result = await provider.transcribe({ audio: tinyWav(), language: "zh" }, new AbortController().signal);
    assert.equal(result.text, "凭据服务取到的 key 生效");
    assert.equal(seen[0]["api-key"], "tp-from-store");
  } finally {
    globalThis.fetch = original;
    if (envBackup !== undefined) process.env.XIAOMI_TOKEN_PLAN_CN_API_KEY = envBackup;
  }
});

test("凭据服务缺席/解析失败：回落到 env 后再报可执行错误（不因服务异常整条不可用）", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
  try {
    // resolve 抛错 → 必须继续回落（这里 env 也没有 → 报 no API key，而不是把凭据异常抛给用户）
    const provider = registerWithCredentials({ resolve: async () => { throw new Error("store unreadable"); } });
    await assert.rejects(
      () => provider.transcribe({ audio: tinyWav(), language: "zh" }, new AbortController().signal),
      (error) => /no API key/.test(String(error.message)),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("标签剥离：只吃行首语言标签，正文里的尖括号不受影响", () => {
  assert.equal(stripLanguageTag("<chinese> 你好"), "你好");
  assert.equal(stripLanguageTag("<english>hello"), "hello");
  assert.equal(stripLanguageTag("你好 <chinese>"), "你好 <chinese>");
  assert.equal(stripLanguageTag(""), "");
  assert.equal(stripLanguageTag(undefined), "");
});

test("HTTP 失败：错误里带状态码与响应片段（便于用户判断是 key 还是配额）", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"error":{"type":"invalid_key"}}', { status: 401, statusText: "Unauthorized" });
  try {
    await assert.rejects(
      () => registerOnce().transcribe({ audio: tinyWav(), language: "auto" }, new AbortController().signal),
      (error) => /HTTP 401/.test(String(error.message)) && /invalid_key/.test(String(error.message)),
    );
  } finally {
    globalThis.fetch = original;
  }
});

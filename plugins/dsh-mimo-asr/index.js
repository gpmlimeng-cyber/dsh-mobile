/**
 * dsh-mimo-asr — Xiaomi MiMo-V2.5-ASR provider for DSH voice input.
 *
 * Registers exactly one cloud recognizer on the host's `speechToText` registry
 * (`@deepseek-ai/dsh-experimental-speech-to-text`). The contract implemented here:
 *
 *   register({ info, transcribe })
 *   info:       { id, name, location: 'host-local' | 'cloud', languages[] }
 *   transcribe: ({ audio: Uint8Array /* WAV *\/, language }, AbortSignal)
 *               -> { text, audioSeconds, inferenceSeconds }
 *
 * No `preparation` object is exposed on purpose: a cloud provider needs no local
 * resources, and SpeechToText#snapshot() reports `{ phase: 'ready' }` when a
 * provider omits it, so the voice UI becomes usable immediately.
 *
 * The API key is resolved lazily on every transcription, never at plugin load, so a
 * key can be dropped in after boot without another engine restart:
 *   config.apiKey  ->  process.env[config.apiKeyEnv]  ->  each file in config.apiKeyFile
 */
import { readFileSync } from "node:fs";

export const name = "dsh-mimo-asr";
export const inject = ["speechToText"];

const DEFAULTS = {
  providerId: "mimo-asr",
  displayName: "MiMo-V2.5-ASR (cloud)",
  baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
  model: "mimo-v2.5-asr",
  apiKey: "",
  apiKeyEnv: "MIMO_API_KEY",
  apiKeyFile: "",
  timeoutMs: 60000,
  // MiMo caps the base64 audio payload at 10 MB; keep the raw WAV cap below that
  // (base64 inflates by ~4/3, so 7 MB raw -> ~9.3 MB encoded).
  maxAudioBytes: 7 * 1024 * 1024,
};

/** Duration of a RIFF/WAVE buffer in seconds, or 0 when the header is not readable. */
function wavSeconds(bytes) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.byteLength < 44 || view.getUint32(0, false) !== 0x52494646) return 0; // 'RIFF'
    let offset = 12;
    let byteRate = 0;
    while (offset + 8 <= view.byteLength) {
      const id = view.getUint32(offset, false);
      const size = view.getUint32(offset + 4, true);
      if (id === 0x666d7420 && offset + 16 <= view.byteLength) {
        byteRate = view.getUint32(offset + 16, true); // 'fmt ' -> byteRate
      } else if (id === 0x64617461) {
        // 'data'
        const seconds = byteRate > 0 ? size / byteRate : 0;
        return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
      }
      offset += 8 + size + (size % 2);
    }
  } catch {
    /* fall through */
  }
  return 0;
}

/**
 * Resolve the API key. 顺序（2026-09-27 修正）：
 *   ① config.apiKey（显式配置）
 *   ② **引擎凭据服务 `ctx.credentials.resolve(<ref>)`** —— DSH 的密钥真源！
 *      在 DSH 里「设置 → 添加自定义供应商」写下的 key 落在 `$DSH_HOME/.credentials.yaml`，
 *      由凭据服务按 ref 解析；**它不会导出到进程环境变量**。此前只查 process.env，于是必然报
 *      「no API key」，而 key 明明已经配好了（真机实锤）。
 *   ③ process.env（壳侧注入的情形，如 DASHSCOPE_API_KEY）
 *   ④ apiKeyFile（把文件内容整份当 key）
 * 全部落空才抛错，错误信息给出三条可执行路径。
 */
async function resolveApiKey(ctx, settings) {
  if (typeof settings.apiKey === "string" && settings.apiKey.trim()) return settings.apiKey.trim();
  const credentials = typeof ctx?.get === "function" ? ctx.get("credentials") : undefined;
  if (credentials !== undefined && settings.apiKeyEnv) {
    try {
      const resolved = await credentials.resolve(settings.apiKeyEnv);
      const value = resolved?.value;
      if (typeof value === "string" && value.trim()) return value.trim();
    } catch {
      /* 凭据服务不可用/读取失败：继续走后面的回落，不要因此让识别整条不可用 */
    }
  }
  const fromEnv = settings.apiKeyEnv ? process.env[settings.apiKeyEnv] : undefined;
  if (typeof fromEnv === "string" && fromEnv.trim()) return fromEnv.trim();
  const files = (Array.isArray(settings.apiKeyFile) ? settings.apiKeyFile : [settings.apiKeyFile]).filter(
    (file) => typeof file === "string" && file.length > 0,
  );
  for (const file of files) {
    try {
      const value = readFileSync(file, "utf8").trim();
      if (value) return value;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(
    `MiMo ASR: no API key. 在 DSH「设置 → 供应商」里为该路由填 key（落到 $DSH_HOME/.credentials.yaml），` +
      `或设环境变量 ${settings.apiKeyEnv || "MIMO_API_KEY"}，或写入文件 ${files.join(", ") || "<apiKeyFile>"}。`,
  );
}

/**
 * 剥掉 MiMo 在正文前加的语言标签（实测返回 `"<chinese> And so, ..."`）。
 * 导出为纯函数：这是「返回给上层的文本必须干净」的回归点，单测直接锁它。
 */
export function stripLanguageTag(raw) {
  return String(raw ?? "").replace(/^\s*<[a-z-]+>\s*/i, "");
}

/** Trim float noise so the UI does not show 3.0000000000000004-style durations. */
const seconds = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0);

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config };
  const info = {
    id: settings.providerId,
    name: settings.displayName,
    location: "cloud",
    /** Exactly the hints MiMo-V2.5-ASR accepts in `asr_options.language`. */
    languages: ["auto", "zh", "en"],
  };

  const transcribe = async ({ audio, language }, signal) => {
    if (!audio || audio.byteLength === 0) throw new Error("MiMo ASR: empty recording");
    if (audio.byteLength > settings.maxAudioBytes) {
      throw new Error(
        `MiMo ASR: recording is ${audio.byteLength} bytes, above the ${settings.maxAudioBytes}-byte limit`,
      );
    }
    const apiKey = await resolveApiKey(ctx, settings);
    const hint = info.languages.includes(language) ? language : "auto";
    const startedAt = Date.now();
    const budget =
      signal && AbortSignal.any && AbortSignal.timeout
        ? AbortSignal.any([signal, AbortSignal.timeout(settings.timeoutMs)])
        : signal;

    let response;
    try {
      response = await fetch(`${settings.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        signal: budget,
        headers: { "api-key": apiKey, authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: settings.model,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "input_audio",
                  input_audio: {
                    data: `data:audio/wav;base64,${Buffer.from(audio).toString("base64")}`,
                  },
                },
              ],
            },
          ],
          asr_options: { language: hint },
        }),
      });
    } catch (error) {
      throw new Error(`MiMo ASR: request failed (${error?.name ?? "error"}: ${error?.message ?? error})`);
    }

    const body = await response.text();
    if (!response.ok) {
      throw new Error(`MiMo ASR: HTTP ${response.status} ${response.statusText} — ${body.slice(0, 300)}`);
    }
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      throw new Error(`MiMo ASR: non-JSON response — ${body.slice(0, 200)}`);
    }
    const content = payload?.choices?.[0]?.message?.content;
    const raw = typeof content === "string" ? content : typeof payload?.text === "string" ? payload.text : "";
    // MiMo 会在正文前加语言标签（实测返回 "<chinese> And so, ..."），对上层只交付纯文本。
    const text = stripLanguageTag(raw);
    return {
      text: text.trim(),
      audioSeconds: seconds(wavSeconds(audio)),
      inferenceSeconds: seconds((Date.now() - startedAt) / 1000),
    };
  };

  ctx.effect(() => {
    const unregister = ctx.speechToText.register({ info, transcribe });
    return async () => {
      await unregister();
    };
  });
}

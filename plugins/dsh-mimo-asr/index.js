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

/** Resolve the API key from config, environment, or key files. Throws a clear, actionable error. */
function resolveApiKey(settings) {
  if (typeof settings.apiKey === "string" && settings.apiKey.trim()) return settings.apiKey.trim();
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
    `MiMo ASR: no API key. Set ${settings.apiKeyEnv || "MIMO_API_KEY"}, or write the key to ${files.join(", ") || "<apiKeyFile>"}.`,
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
    const apiKey = resolveApiKey(settings);
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

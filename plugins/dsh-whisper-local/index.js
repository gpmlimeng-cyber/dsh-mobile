/**
 * dsh-whisper-local — 本机 whisper.cpp 识别 provider（DSH voice input 的 speechToText 后端）
 *
 * 为什么需要它：上游 `dsh-experimental-speech-to-text-sensevoice` 依赖 `sherpa-onnx-node` 的原生
 * addon，而该项目**从未发布 android-arm64 绑定**（npm optionalDependencies 只有 darwin/linux/win），
 * Android 上必然抛 "Local speech is unavailable for android-arm64"。本插件改用 whisper.cpp
 * （C++ 自带 ggml、无第三方运行时依赖，可在本机原生编译），把 DSH 送来的 canonical WAV 落盘后交给
 * `whisper-cli` 识别，再把结果映射回 provider 契约。
 *
 * 契约（与上游 sensevoice provider 同形，前端 UI 无需改动）：
 *   ctx.speechToText.register({ info, preparation, transcribe })
 *   info:        { id, name, location: 'host-local', languages[], setupEstimate }
 *   preparation: { subscribe, snapshot, prepare, cancel }   ← 模型下载/就绪状态机
 *   transcribe:  ({ audio: Buffer(canonical WAV), language }, AbortSignal)
 *                -> { text, audioSeconds, inferenceSeconds }
 *
 * 模型策略：**不随包发货**，首次使用按需下载（默认 hf-mirror 的 ggml-tiny，77 MB；可换成
 * base/small）。下载进度经 preparation 状态机透出到语音设置页；就绪后每次识别只 spawn 一次 CLI。
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { dirname, join } from "node:path";

export const name = "dsh-whisper-local";
export const inject = ["speechToText"];

const DEFAULTS = {
  providerId: "whisper-local",
  displayName: "Whisper（本机）",
  /**
   * whisper-cli 路径；留空 = 从引擎自己的 node 位置推导（`<pkg>/files/usr/bin/whisper-cli`）。
   * 不写死包名：同一份插件既要在主包(`com.dsharnessmobile.shell`)也要在共存包(`com.deepcode.shell`)里可用。
   */
  binary: "",
  /** 模型目录；留空 = $DSH_HOME/speech-to-text/whisper。 */
  modelDirectory: "",
  /**
   * whisper 专属共享库目录（libggml 系列 + libwhisper + libc++_shared）。
   * 为什么单独一份 libc++：本机快照里的 libc++_shared.so 比编译 whisper 时用的 NDK libc++ 旧，
   * 直接跑会 `cannot locate symbol __hash_memory ... referenced by libggml-base.so`；而替换全局
   * libc++ 会波及快照里所有 Termux 二进制。故只给本 CLI 子进程前置一个专属目录（LD_LIBRARY_PATH
   * 优先于二进制 RUNPATH），互不影响。
   */
  libraryPath: "/data/data/com.deepcode.shell/files/usr/lib/dsh-whisper",
  model: "ggml-tiny.bin",
  /** 模型下载源前缀（按序尝试）。默认 hf-mirror：国内可达性优于 huggingface.co。 */
  modelOrigins: [
    "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/",
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/",
  ],
  threads: 4,
  timeoutMs: 300000,
  /** 对外声明的语言提示；yue 不在 whisper 语言表内，映射为 zh。 */
  languages: ["auto", "zh", "en", "yue", "ja", "ko"],
};

const WHISPER_LANGUAGE = { yue: "zh" };

/** RIFF/WAVE 时长（秒）：只读头，不解码音频。识别不出返回 0。 */
function wavSeconds(bytes) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.byteLength < 44 || view.getUint32(0, false) !== 0x52494646) return 0; // 'RIFF'
    let offset = 12;
    let byteRate = 0;
    while (offset + 8 <= view.byteLength) {
      const id = view.getUint32(offset, false);
      const size = view.getUint32(offset + 4, true);
      if (id === 0x666d7420 && offset + 16 <= view.byteLength) byteRate = view.getUint32(offset + 16, true); // 'fmt '
      else if (id === 0x64617461) {
        // 'data'
        const seconds = byteRate > 0 ? size / byteRate : 0;
        return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
      }
      offset += 8 + size + (size % 2);
    }
  } catch {
    /* 头不可读按 0 处理 */
  }
  return 0;
}

const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0);

/** 模型就绪状态机：模型在 → ready；不在 → unprepared（prepare() 才下载，幂等、可取消）。 */
class ModelPreparation {
  listeners = new Set();
  state = { phase: "unprepared", steps: [{ kind: "model", status: "pending" }] };
  preparing = null;

  constructor(options) {
    this.dir = options.dir;
    this.modelName = options.model;
    this.modelPath = join(options.dir, options.model);
    this.origins = options.origins;
    this.inspect();
  }

  inspect() {
    const present = existsSync(this.modelPath) && statSync(this.modelPath).size > 0;
    this.publish({
      phase: present ? "ready" : "unprepared",
      steps: [{ kind: "model", status: present ? "complete" : "pending", detail: present ? this.modelPath : undefined }],
    });
  }

  snapshot() {
    return this.state;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(state) {
    this.state = { ...this.state, ...state };
    for (const listener of this.listeners) {
      try {
        listener();
      } catch {
        /* 监听方异常不得影响识别链路 */
      }
    }
  }

  prepare() {
    if (this.state.phase === "ready" || this.preparing) return;
    const abort = new AbortController();
    this.preparing = { abort, completed: false };
    this.publish({ phase: "preparing", step: "model", steps: [{ kind: "model", status: "running", startedAt: Date.now() }] });
    void this.download(abort.signal).then(
      () => {
        this.preparing = null;
        this.inspect();
      },
      (error) => {
        this.preparing = null;
        this.publish({
          phase: abort.signal.aborted ? "cancelled" : "failed",
          error: abort.signal.aborted ? "已取消" : String(error?.message ?? error),
          steps: [{ kind: "model", status: "failed" }],
        });
      },
    );
  }

  async cancel() {
    this.preparing?.abort.abort(new Error("preparation cancelled"));
  }

  async download(signal) {
    mkdirSync(this.dir, { recursive: true });
    const part = this.modelPath + ".part";
    let lastError = null;
    for (const origin of this.origins) {
      const url = (origin.endsWith("/") ? origin : origin + "/") + this.modelName;
      const file = createWriteStream(part);
      try {
        const response = await fetch(url, { signal });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} @ ${origin}`);
        const total = Number(response.headers.get("content-length") ?? 0);
        let received = 0;
        const startedAt = this.state.steps[0]?.startedAt ?? Date.now();
        // 流式落盘：模型 77–466 MB，不整块进内存；进度透出到设置页。
        for await (const chunk of response.body) {
          if (signal.aborted) throw signal.reason ?? new Error("cancelled");
          received += chunk.length;
          if (!file.write(chunk)) await once(file, "drain");
          this.publish({
            phase: "preparing",
            step: "model",
            steps: [{
              kind: "model",
              status: "running",
              startedAt,
              progress: total > 0 ? { receivedBytes: received, totalBytes: total } : undefined,
            }],
          });
        }
        await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
        renameSync(part, this.modelPath);
        return;
      } catch (error) {
        lastError = error;
        file.destroy();
        try {
          unlinkSync(part);
        } catch {
          /* 忽略 */
        }
        if (signal.aborted) throw error;
      }
    }
    throw lastError ?? new Error("没有可用的模型下载源");
  }
}

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config };
  const home = process.env.DSH_HOME ?? ".";
  // 配置里显式传了 undefined/空串时要落回默认值（对象展开会覆盖默认），否则共享库目录会指向空。
  if (typeof settings.binary !== "string" || settings.binary.length === 0) {
    settings.binary = join(dirname(process.execPath), "whisper-cli");
  }
  if (typeof settings.libraryPath !== "string" || settings.libraryPath.length === 0) {
    settings.libraryPath = join(dirname(settings.binary), "..", "lib", "dsh-whisper");
  }
  const dir = settings.modelDirectory || join(home, "speech-to-text", "whisper");
  // 临时 WAV 落 DSH_HOME/tmp：本机 os.tmpdir() 指向烧死的 com.termux 前缀（EACCES），
  // 而 DSH_HOME 由壳侧按真实前缀注入。
  const tmpRoot = join(home, "tmp");
  mkdirSync(tmpRoot, { recursive: true });
  const preparation = new ModelPreparation({ dir, model: settings.model, origins: settings.modelOrigins });

  const info = {
    id: settings.providerId,
    name: settings.displayName,
    location: "host-local",
    languages: settings.languages,
    setupEstimate: {
      recommendedDiskBytes: 2 * 1024 * 1024 * 1024,
      expectedMemoryBytes: 1024 * 1024 * 1024,
      minimumMinutes: 1,
      maximumMinutes: 15,
    },
  };

  const transcribe = async ({ audio, language }, signal) => {
    if (!audio || audio.byteLength === 0) throw new Error("Whisper：录音为空");
    const phase = preparation.snapshot().phase;
    if (phase !== "ready" && phase !== "standby") throw new Error("Whisper：模型尚未就绪，请先在语音设置里准备模型");
    const hint = WHISPER_LANGUAGE[language] ?? (info.languages.includes(language) ? language : "auto");
    const wav = join(tmpRoot, `dsh-whisper-${process.pid}-${Date.now()}.wav`);
    writeFileSync(wav, Buffer.from(audio));
    const startedAt = Date.now();
    try {
      const text = await new Promise((resolve, reject) => {
        const child = spawn(
          settings.binary,
          ["-m", preparation.modelPath, "-f", wav, "-l", hint, "-t", String(settings.threads), "--no-timestamps", "--no-prints"],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              LD_LIBRARY_PATH: [settings.libraryPath, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":"),
            },
          },
        );
        let out = "";
        let err = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          reject(new Error(`Whisper：识别超时（${settings.timeoutMs} ms）`));
        }, settings.timeoutMs);
        const onAbort = () => {
          clearTimeout(timer);
          child.kill("SIGKILL");
          reject(signal?.reason instanceof Error ? signal.reason : new Error("识别已取消"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout.on("data", (data) => (out += data));
        child.stderr.on("data", (data) => (err += data));
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(new Error(`Whisper：无法启动 ${settings.binary}（${error.message}）`));
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) return;
          if (code !== 0) reject(new Error(`Whisper：退出码 ${code}；${err.trim().slice(0, 300)}`));
          else resolve(out.trim());
        });
      });
      return {
        text,
        audioSeconds: round(wavSeconds(Buffer.from(audio))),
        inferenceSeconds: round((Date.now() - startedAt) / 1000),
      };
    } finally {
      try {
        unlinkSync(wav);
      } catch {
        /* 临时文件清理失败不影响结果 */
      }
    }
  };

  ctx.effect(() => {
    const unregister = ctx.speechToText.register({ info, preparation, transcribe });
    return async () => {
      await preparation.cancel();
      await unregister();
      rmSync(preparation.modelPath + ".part", { force: true });
    };
  });
}

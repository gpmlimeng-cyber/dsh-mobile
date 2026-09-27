/**
 * dsh-whisper-local — 本机 whisper.cpp 识别 provider（多档模型并存，设置页可直接切换）
 *
 * 为什么需要它：上游唯一的本地 provider（sensevoice）依赖 `sherpa-onnx-node` 的原生 addon，而该项目
 * **从未发布 android-arm64 绑定**（npm optionalDependencies 只有 darwin/linux/win）⇒ Android 上必然
 * 「准备失败: Local speech is unavailable for android-arm64」。本插件改用 whisper.cpp（C++ 自带 ggml、
 * 无第三方运行时依赖，可本机原生编译）。
 *
 * 与上游契约同形（`ctx.speechToText.register({ info, preparation, transcribe })`），前端 UI 无需改动。
 *
 * 设计要点（都是真机踩出来的）：
 *  ① **一档模型 = 一个 provider**：设置页的「识别服务」下拉就是模型选择器。随包的 tiny 立刻可用；
 *     base / small-q5 / small 按需下载（`preparation.prepare()` 带进度），用户不必改配置文件。
 *  ② **中文要 `-l zh` + 初始提示词**：whisper 自由模式爱输出繁体、丢标点；`--prompt "以下是普通话的句子。"`
 *     是 whisper.cpp 社区验证过的简繁/标点矫正法（本项目对 zh/yue 自动带上）。
 *  ③ **启动阶梯**：Android 15+ 禁止 app 私有目录 ELF 直接 execve，故「直连 → /system/bin/linker64 →
 *     sh -c exec」逐档回退（与壳侧起引擎同一套）。
 *  ④ 共享库用**专属目录**（内含与编译期同源的 libc++），避免替换全局 libc++ 波及快照里其它二进制。
 *  ⑤ 临时 WAV 落 `$DSH_HOME/tmp`（本机 `os.tmpdir()` 指向烧死的 com.termux 前缀）。
 */
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { dirname, join } from "node:path";

export const name = "dsh-whisper-local";
export const inject = ["speechToText"];

/** 模型档位目录（默认）。bytes 仅用于 UI 的磁盘/时间预估，不参与判据。 */
const MODEL_CATALOG = [
  { id: "whisper-tiny", file: "ggml-tiny.bin", label: "Whisper Tiny（随包 · 最快）", bytes: 77 * 1024 * 1024 },
  { id: "whisper-base", file: "ggml-base.bin", label: "Whisper Base（需下载 142 MB）", bytes: 142 * 1024 * 1024 },
  { id: "whisper-small-q5", file: "ggml-small-q5_1.bin", label: "Whisper Small q5（需下载 190 MB · 中文推荐）", bytes: 190 * 1024 * 1024 },
  { id: "whisper-small", file: "ggml-small.bin", label: "Whisper Small（需下载 466 MB · 中文最准）", bytes: 466 * 1024 * 1024 },
];

const DEFAULTS = {
  /** 档位列表；null = 用上面内置目录（也可整体覆写）。 */
  models: null,
  /** whisper-cli 路径；留空 = 从引擎自己的 node 位置推导（`<pkg>/files/usr/bin/whisper-cli`）。 */
  binary: "",
  /** whisper 专属共享库目录（含同源 libc++）；留空 = 由 binary 推导 `../lib/dsh-whisper`。 */
  libraryPath: "",
  /** 模型目录；留空 = `$DSH_HOME/speech-to-text/whisper`。 */
  modelDirectory: "",
  modelOrigins: [
    "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/",
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/",
  ],
  threads: 4,
  timeoutMs: 300000,
  launcher: "auto",
  /** 按语言给的初始提示词（whisper.cpp 的简繁/标点矫正法）。 */
  prompts: { zh: "以下是普通话的句子。" },
  languages: ["auto", "zh", "en", "yue", "ja", "ko"],
};

/** whisper 的语言表里没有 yue（粤语），落到 zh。 */
const WHISPER_LANGUAGE = { yue: "zh" };
const SYSTEM_LINKER = "/system/bin/linker64";
const SYSTEM_SH = "/system/bin/sh";

/** RIFF/WAVE 时长（秒）；只读头，不解码。 */
function wavSeconds(bytes) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.byteLength < 44 || view.getUint32(0, false) !== 0x52494646) return 0;
    let offset = 12;
    let byteRate = 0;
    while (offset + 8 <= view.byteLength) {
      const id = view.getUint32(offset, false);
      const size = view.getUint32(offset + 4, true);
      if (id === 0x666d7420 && offset + 16 <= view.byteLength) byteRate = view.getUint32(offset + 16, true);
      else if (id === 0x64617461) {
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

/**
 * 启动候选阶梯（顺序即优先级）。导出为纯函数：这是「app 私有 ELF 怎么起得来」的回归锚点。
 * @returns [{how, cmd, argv}]
 */
export function launchLadder(binary, args) {
  return [
    { how: "direct", cmd: binary, argv: [...args] },
    { how: "linker64", cmd: SYSTEM_LINKER, argv: [binary, ...args] },
    { how: "sh", cmd: SYSTEM_SH, argv: ["-c", 'exec "$0" "$@"', binary, ...args] },
  ];
}

/** 依次尝试阶梯；只有**启动失败**才降级（进程起来之后的失败不换档）。 */
async function spawnWithLadder(binary, args, options, preferred) {
  const all = launchLadder(binary, args);
  const order = preferred && preferred !== "auto"
    ? [...all.filter((c) => c.how === preferred), ...all.filter((c) => c.how !== preferred)]
    : all;
  let lastError = null;
  const tried = [];
  for (const candidate of order) {
    const child = spawn(candidate.cmd, candidate.argv, options);
    const ok = await new Promise((resolve) => {
      let settled = false;
      const onError = (error) => {
        if (settled) return;
        settled = true;
        lastError = error;
        resolve(false);
      };
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        child.removeListener("error", onError);
        resolve(true);
      };
      child.once("error", onError);
      child.once("spawn", onSpawn);
    });
    tried.push(candidate.how);
    if (ok) return { child, how: candidate.how, tried };
  }
  const error = lastError ?? new Error("无法启动");
  error.tried = tried;
  throw error;
}

/** 某档模型的就绪状态机：模型在 → ready；不在 → unprepared（`prepare()` 才下载，可取消）。 */
class ModelPreparation {
  listeners = new Set();
  state = { phase: "unprepared", steps: [{ kind: "model", status: "pending" }] };
  preparing = null;

  constructor(options) {
    this.dir = options.dir;
    this.modelName = options.model;
    this.modelPath = join(options.dir, options.model);
    this.origins = options.origins;
    this.label = options.label ?? options.model;
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
  if (typeof settings.binary !== "string" || settings.binary.length === 0) {
    settings.binary = join(dirname(process.execPath), "whisper-cli");
  }
  if (typeof settings.libraryPath !== "string" || settings.libraryPath.length === 0) {
    settings.libraryPath = join(dirname(settings.binary), "..", "lib", "dsh-whisper");
  }
  const dir = settings.modelDirectory || join(home, "speech-to-text", "whisper");
  const tmpRoot = join(home, "tmp");
  mkdirSync(tmpRoot, { recursive: true });

  const models = (Array.isArray(settings.models) && settings.models.length > 0 ? settings.models : MODEL_CATALOG)
    .filter((m) => m && typeof m.file === "string" && typeof m.id === "string");

  const children = [];
  for (const model of models) {
    const preparation = new ModelPreparation({ dir, model: model.file, origins: settings.modelOrigins, label: model.label });

    const info = {
      id: model.id,
      name: model.label ?? model.file,
      location: "host-local",
      languages: settings.languages,
      setupEstimate: {
        recommendedDiskBytes: (model.bytes ?? 200 * 1024 * 1024) * 3,
        expectedMemoryBytes: (model.bytes ?? 200 * 1024 * 1024) * 2,
        minimumMinutes: 1,
        maximumMinutes: 15,
      },
    };

    const transcribe = async ({ audio, language }, signal) => {
      if (!audio || audio.byteLength === 0) throw new Error("Whisper：录音为空");
      const phase = preparation.snapshot().phase;
      if (phase !== "ready" && phase !== "standby") {
        throw new Error(`Whisper：模型尚未就绪（${preparation.modelName}），请先在语音设置里准备模型`);
      }
      if (!existsSync(settings.binary)) throw new Error(`Whisper：无法启动 ${settings.binary}（文件不存在）`);
      const hint = WHISPER_LANGUAGE[language] ?? (info.languages.includes(language) ? language : "auto");
      const wav = join(tmpRoot, `dsh-whisper-${process.pid}-${Date.now()}.wav`);
      writeFileSync(wav, Buffer.from(audio));
      const startedAt = Date.now();
      try {
        const args = [
          "-m", preparation.modelPath, "-f", wav, "-l", hint, "-t", String(settings.threads),
          "--no-timestamps", "--no-prints",
        ];
        // 中文输出矫正：whisper 自由模式爱出繁体/丢标点，初始提示词是社区验证过的稳妥做法。
        const prompt = settings.prompts?.[hint] ?? settings.prompts?.[language];
        if (prompt) args.push("--prompt", String(prompt));

        const childEnv = {
          ...process.env,
          LD_LIBRARY_PATH: [settings.libraryPath, join(dirname(settings.binary), "..", "lib"), process.env.LD_LIBRARY_PATH]
            .filter(Boolean)
            .join(":"),
        };
        if (!childEnv.LD_PRELOAD) {
          const preload = join(dirname(settings.binary), "..", "lib", "libtermux-exec-ld-preload.so");
          if (existsSync(preload)) childEnv.LD_PRELOAD = preload;
        }

        const text = await new Promise((resolve, reject) => {
          let child = null;
          let timer = null;
          const onLaunched = (live) => {
            child = live;
            let out = "";
            let err = "";
            timer = setTimeout(() => {
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
            child.on("close", (code) => {
              clearTimeout(timer);
              signal?.removeEventListener("abort", onAbort);
              if (signal?.aborted) return;
              if (code !== 0) reject(new Error(`Whisper：退出码 ${code}；${err.trim().slice(0, 300)}`));
              else resolve(out.trim());
            });
          };
          spawnWithLadder(settings.binary, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv }, settings.launcher)
            .then(({ child: live, how, tried }) => {
              if (how !== "direct") console.error(`Whisper(${model.id}): 用 ${how} 档启动成功（尝试序列 ${tried.join(" → ")}）`);
              onLaunched(live);
            }, (error) => {
              if (timer) clearTimeout(timer);
              const tried = Array.isArray(error?.tried) ? `；尝试序列 ${error.tried.join(" → ")}` : "";
              reject(new Error(`Whisper：无法启动 ${settings.binary}（${error?.message ?? error}${tried}）`));
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

    const unregister = ctx.speechToText.register({ info, preparation, transcribe });
    children.push({ preparation, unregister });
  }

  ctx.effect(() => () => {
    void (async () => {
      for (const child of children) {
        await child.preparation.cancel();
        for (const model of models) rmSync(join(dir, model.file + ".part"), { force: true });
        await child.unregister();
      }
    })();
  });
}

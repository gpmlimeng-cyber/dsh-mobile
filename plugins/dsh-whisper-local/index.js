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
  libraryPath: "",
  /**
   * 启动方式：`auto`（默认，按阶梯回退）/ `direct` / `linker64` / `sh`。
   * 为什么需要阶梯：Android 15+（部分 ROM 更早）**禁止 app 私有目录里的 ELF 直接 execve**
   * （真机实测 `spawn whisper-cli EACCES`）。壳侧起引擎自己就是「直连失败→ `/system/bin/linker64`
   * 重试」（EngineManager.startWithArgs），termux-exec 的 execve 钩子也只覆盖它认识的那条路；
   * 本插件自带同款阶梯，三种走法任一可用即可，不再依赖父进程环境是否恰好带钩子。
   */
  launcher: "auto",
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

const SYSTEM_LINKER = "/system/bin/linker64";
const SYSTEM_SH = "/system/bin/sh";

/**
 * 启动候选阶梯（顺序即优先级）。导出为纯函数：这是「app 私有 ELF 怎么起得来」的回归锚点。
 * @returns [{cmd, argv, how}] —— how 仅用于诊断输出
 */
export function launchLadder(binary, args) {
  return [
    { how: "direct", cmd: binary, argv: [...args] },
    { how: "linker64", cmd: SYSTEM_LINKER, argv: [binary, ...args] },
    { how: "sh", cmd: SYSTEM_SH, argv: ["-c", 'exec "$0" "$@"', binary, ...args] },
  ];
}

/**
 * 依次尝试阶梯；返回第一个**真正启动成功**的句柄与档位名。
 * 判据用 Node 的 'spawn' / 'error' 事件：只有启动失败才降级（进程起来之后的失败不换档）。
 */
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
        lastError = error;          // 保留最后一次失败的实参给调用方诊断
        resolve(false);
      };
      const onSpawn = () => {
        if (settled) return;
        settled = true;
        child.removeListener("error", onError);   // 成功的子进程不留悬挂的 error 探针
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
    // 先做存在性检查：否则「二进制缺失」会走到 sh 档并退化成「退出码 127」，用户看不出真因
    if (!existsSync(settings.binary)) throw new Error(`Whisper：无法启动 ${settings.binary}（文件不存在）`);
    const hint = WHISPER_LANGUAGE[language] ?? (info.languages.includes(language) ? language : "auto");
    const wav = join(tmpRoot, `dsh-whisper-${process.pid}-${Date.now()}.wav`);
    writeFileSync(wav, Buffer.from(audio));
    const startedAt = Date.now();
    try {
      const args = ["-m", preparation.modelPath, "-f", wav, "-l", hint, "-t", String(settings.threads), "--no-timestamps", "--no-prints"];
      // 共享库与 loader 钩子：whisper 专属目录在前（同源 libc++），再补快照前缀 lib，最后继承原值。
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
        let child;
        const launched = spawnWithLadder(
          settings.binary,
          args,
          { stdio: ["ignore", "pipe", "pipe"], env: childEnv },
          settings.launcher,
        );
        // 阶梯是异步判定的：先挂「启动失败」兜底，再在成功回调里挂正常监听
        launched.then(({ child: live, how, tried }) => {
          child = live;
          if (how !== "direct") console.error(`Whisper: 用 ${how} 档启动成功（尝试序列 ${tried.join(" → ")}）`);
          onLaunched(live);
        }, (error) => {
          clearTimeout(timer);
          const tried = Array.isArray(error?.tried) ? `；尝试序列 ${error.tried.join(" → ")}` : "";
          reject(new Error(`Whisper：无法启动 ${settings.binary}（${error?.message ?? error}${tried}）`));
        });
        const onLaunched = (child) => {
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
        let timer = null;
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

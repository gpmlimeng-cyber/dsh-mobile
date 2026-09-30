/**
 * dsh-sherpa-local — 本机 sherpa-onnx（SenseVoice）识别 provider
 *
 * 为什么需要它：上游的本地 provider 走 `sherpa-onnx-node`，而该 npm 包**从未发布 android-arm64 绑定**，
 * 安卓上必然「准备失败: Local speech is unavailable for android-arm64」。whisper.cpp 之路（dsh-whisper-local）
 * 已解决「有没有」，但中文质量是 whisper 的短板；sherpa-onnx 官方发布的 **Android aarch64 Termux 预编译包
 * 在本机实测可跑**（sherpa-onnx version 1.13.8 / onnxruntime 1.28.2，退出码 0），其中 `sherpa-onnx-offline`
 * 带 `--sense-voice-*` 参数。故这里直接 spawn 官方 CLI，不碰 node addon。
 *
 * 与上游契约同形（`ctx.speechToText.register({ info, preparation, transcribe })`），前端 UI 无需改动。
 *
 * 设计要点：
 *  ① **SenseVoice 只做中文/多语的整段识别**（非流式）：普通话、粤语、英日韩都显著强于 whisper-tiny，
 *     ITN 打开后自带标点与阿拉伯数字，直接可用作聊天输入。
 *  ② **大模型按需下载**：int8 模型 239 MB 不随包（APK 体积），随包只有 tokens 与 silero VAD（几百 KB 级）；
 *     `preparation.prepare()` 带进度、可取消。
 *  ③ **启动阶梯**：Android 15+ 禁止 app 私有目录 ELF 直接 execve，故「直连 → /system/bin/linker64 →
 *     sh -c exec」逐档回退（与壳侧起引擎、whisper 插件同一套）。
 *  ④ 共享库用**专属目录**（`usr/lib/sherpa-onnx`，含同源 libonnxruntime），避免污染快照里其它二进制。
 *  ⑤ 临时 WAV 落 `$DSH_HOME/tmp`（本机 `os.tmpdir()` 指向烧死的 com.termux 前缀）。
 *  ⑥ VAD 档（`vad: true`）改走 `sherpa-onnx-vad-with-offline-asr`：长录音先切句再识别，避免整段被静音拖累。
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { dirname, join, resolve } from "node:path";
import { availableParallelism } from "node:os";

export const name = "dsh-sherpa-local";
export const inject = ["speechToText"];

/** SenseVoice 语言提示（CLI 原样接受这六个值；引擎侧语言不在表内时回落 auto）。 */
const SENSE_VOICE_LANGUAGES = ["auto", "zh", "en", "ja", "ko", "yue"];

/**
 * 随包/下载的资产清单（相对模型目录）。
 *  `file`     落盘文件名
 *  `bytes`    仅用于进度与磁盘预估
 *  `bundled`  true = 随快照发布（缺失时才回退下载）；false = 一定按需下载
 */
const ASSET_CATALOG = [
  { file: "tokens.txt", bytes: 315894, bundled: true, sha256: "f449eb28dc567533d7fa59be34e2abca8784f771850c78a47fb731a31429a1dc" },
  { file: "model.int8.onnx", bytes: 239233841, bundled: false, sha256: "c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51" },
  { file: "silero_vad.onnx", bytes: 643854, bundled: true, optional: true, sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6" },
];

const DEFAULTS = {
  /** provider id（设置页「识别服务」里的标识）。 */
  id: "sherpa-sensevoice",
  label: "SenseVoice Small int8（需下载 239 MB · 中英日韩粤）",
  /** 资产清单；null = 用内置目录。 */
  assets: null,
  /** sherpa 离线识别二进制；留空 = `<prefix>/bin/sherpa-onnx-offline`。 */
  binary: "",
  /** VAD 档二进制；留空 = `<prefix>/bin/sherpa-onnx-vad-with-offline-asr`。 */
  vadBinary: "",
  /** sherpa 专属共享库目录；留空 = `<prefix>/lib/sherpa-onnx`。 */
  libraryPath: "",
  /** 模型目录；留空 = `$DSH_HOME/speech-to-text/sherpa`。 */
  modelDirectory: "",
  /** true = 走 VAD 切句档（长录音更稳；短句无差别）。 */
  vad: false,
  /** true = 打开 ITN（标点 + 阿拉伯数字）。 */
  useItn: true,
  /** 默认语言提示；引擎传语言时以引擎为准。 */
  language: "zh",
  /** 推理线程数；0 = 自动（`min(8, 可用并行度 - 1)`）。 */
  threads: 0,
  timeoutMs: 300000,
  launcher: "auto",
  modelOrigins: [
    "https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/",
    "https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/",
  ],
  /**
   * silero VAD 的下载源。官方 GitHub release 资产在本机实测**超时**（release-assets 不可达，
   * 只有 API/页面可达），故默认走 HF 镜像上实测可达的同版本 silero v5 仓库；VAD 缺席时整体
   * 不失败（自动回落直接档），所以这里只是「可选资产的补货路径」。
   */
  vadOrigins: [
    "https://hf-mirror.com/R4kSo1997/sherpa-onnx-silero-vad-v5/resolve/main/",
  ],
};

/**
 * 解析运行时前缀（`<pkg>/files/usr`）。**不能只看 `process.execPath`**：引擎由壳侧用
 * `/system/bin/linker64` 装载，`process.execPath` 会是 `/apex/com.android.runtime/bin/linker64`
 * ⇒ 按它推导会得到不存在的路径。三源按可靠性排序：① 壳侧注入的 `TERMUX__PREFIX`；
 * ② 由引擎入口 `process.argv[1]` 反推；③ execPath 兜底。
 */
export function resolvePrefix(env = process.env, argv1 = process.argv[1], execPath = process.execPath) {
  const candidates = [];
  if (typeof env.TERMUX__PREFIX === "string" && env.TERMUX__PREFIX) candidates.push(env.TERMUX__PREFIX);
  if (typeof argv1 === "string" && argv1.length > 0) candidates.push(resolve(dirname(argv1), "../../../../.."));
  if (typeof execPath === "string" && execPath.length > 0) candidates.push(dirname(execPath));
  for (const candidate of candidates) {
    try {
      if (existsSync(join(candidate, "bin"))) return candidate;
    } catch {
      /* 继续下一个候选 */
    }
  }
  return candidates[0] ?? ".";
}

/** 线程数解析：显式配置优先，0/非法值按机器并行度自动定（留一核给系统，上限 8）。 */
export function resolveThreads(configured, parallelism = availableParallelism?.() ?? 4) {
  if (Number.isInteger(configured) && configured >= 1) return Math.min(configured, 16);
  const count = Number.isFinite(parallelism) && parallelism > 0 ? parallelism : 4;
  return Math.max(2, Math.min(8, count - 1));
}

/** 语言提示归一：只接受 SenseVoice 支持的值，其余回落默认档（yue/zh 都合法）。 */
export function resolveLanguage(requested, fallback = "zh") {
  if (typeof requested === "string" && SENSE_VOICE_LANGUAGES.includes(requested)) return requested;
  return SENSE_VOICE_LANGUAGES.includes(fallback) ? fallback : "auto";
}

const round = (value) => (Number.isFinite(value) ? Math.round(value * 1000) / 1000 : 0);

/**
 * 把入口 WAV 归一化成「尺寸与实际字节一致」的规范容器（纯函数，单测锚点）。
 *
 * 为什么必须做：sherpa 的 wave-reader **按 RIFF 声明长度整块读**，声明值与实际不符就直接失败
 * （真机实测：一个被截断的 jfk.wav 声明 data=352000、实际只有 288498 字节 →
 * `Failed to read 352000 bytes` + 退出码 255；whisper 因为宽容而照样出字）。录音链路上游
 * （浏览器 MediaRecorder / 快照桥）只要有一次尺寸字段陈旧，用户看到的就是「识别失败」。
 * 这里只保留 fmt + data 两块并重写 RIFF/data 尺寸（16 位 PCM 顺带丢掉半帧尾字节），
 * 解析不出来就原样返回，绝不因为归一化本身把可用音频弄坏。
 */
export function normalizeWav(input) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input ?? Buffer.alloc(0));
  try {
    if (bytes.byteLength < 44 || bytes.readUInt32BE(0) !== 0x52494646) return bytes;
    if (bytes.toString("latin1", 8, 12) !== "WAVE") return bytes;
    let offset = 12;
    let fmt = null;
    let data = null;
    while (offset + 8 <= bytes.byteLength) {
      const id = bytes.toString("latin1", offset, offset + 4);
      const size = bytes.readUInt32LE(offset + 4);
      const start = offset + 8;
      const available = Math.max(0, Math.min(size, bytes.byteLength - start));
      if (id === "fmt ") fmt = bytes.subarray(start, start + available);
      else if (id === "data") {
        data = bytes.subarray(start, start + available);
        break;
      }
      offset = start + size + (size % 2);
    }
    if (!fmt || !data || data.byteLength === 0) return bytes;
    // 16 位 PCM 的半帧尾字节会让解码器读到不完整样本，按帧长对齐后再写。
    let payload = data;
    if (fmt.byteLength >= 16) {
      const channels = fmt.readUInt16LE(2);
      const bits = fmt.readUInt16LE(14);
      const frame = channels * (bits / 8);
      if (Number.isFinite(frame) && frame >= 1) payload = data.subarray(0, data.byteLength - (data.byteLength % frame));
    }
    if (payload.byteLength === 0) return bytes;
    const pad = payload.byteLength % 2;
    const out = Buffer.alloc(20 + fmt.byteLength + 8 + payload.byteLength + pad);
    out.write("RIFF", 0, "latin1");
    out.writeUInt32LE(out.byteLength - 8, 4);
    out.write("WAVE", 8, "latin1");
    out.write("fmt ", 12, "latin1");
    out.writeUInt32LE(fmt.byteLength, 16);
    fmt.copy(out, 20);
    const dataOffset = 20 + fmt.byteLength;
    out.write("data", dataOffset, "latin1");
    out.writeUInt32LE(payload.byteLength, dataOffset + 4);
    payload.copy(out, dataOffset + 8);
    return out;
  } catch {
    return bytes;
  }
}

/** RIFF/WAVE 时长（秒）；只读头，不解码。 */
export function wavSeconds(bytes) {
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

/** 启动候选阶梯（顺序即优先级）。导出为纯函数：这是「app 私有 ELF 怎么起得来」的回归锚点。 */
export function launchLadder(binary, args) {
  return [
    { how: "direct", cmd: binary, argv: [...args] },
    { how: "linker64", cmd: "/system/bin/linker64", argv: [binary, ...args] },
    { how: "sh", cmd: "/system/bin/sh", argv: ["-c", 'exec "$0" "$@"', binary, ...args] },
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

/**
 * 组装 CLI 参数（纯函数，单测锚点）。
 * 直接档：`sherpa-onnx-offline --tokens=… --sense-voice-model=… [--sense-voice-language=…] [--sense-voice-use-itn=…] --num-threads=N <wav>`
 * VAD 档：同参数但换二进制，并补 `--silero-vad-model=…`。
 */
export function buildArgs(options) {
  const {
    dir, wav, language = "zh", useItn = true, threads = 2, vad = false, vadModel = "silero_vad.onnx",
  } = options;
  const args = [
    `--tokens=${join(dir, "tokens.txt")}`,
    `--sense-voice-model=${join(dir, "model.int8.onnx")}`,
    `--sense-voice-language=${resolveLanguage(language)}`,
    `--sense-voice-use-itn=${useItn ? "true" : "false"}`,
    `--num-threads=${threads}`,
  ];
  if (vad) args.splice(2, 0, `--silero-vad-model=${join(dir, vadModel)}`);
  args.push(wav);
  return args;
}

/**
 * 解析 CLI stdout（纯函数，单测锚点）。两种真实输出形态都要吃下：
 *   ① 离线档：`{"text": "…", "timestamps": …, "tokens": …}`（可能前面带一行 wav 路径）
 *   ② VAD 档：`0.320 -- 3.840: 今天天气不错`（每句一行；空句 `: ` 要丢掉）
 * 兜底：都不是时，去掉 wav 路径行后原样拼接，绝不返回 JSON 噪音。
 */
export function parseSenseVoiceOutput(stdout, wav = "") {
  const lines = String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const texts = [];
  for (const line of lines) {
    if (wav && line === wav) continue;
    if (line.startsWith("{")) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed.text === "string") {
          if (parsed.text.trim()) texts.push(parsed.text.trim());
          continue;
        }
      } catch {
        /* 非 JSON，走下面的文本分支 */
      }
    }
    const segment = line.match(/^-?[\d.]+\s*--\s*-?[\d.]+\s*:\s*(.*)$/);
    if (segment) {
      if (segment[1].trim()) texts.push(segment[1].trim());
      continue;
    }
    texts.push(line);
  }
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

/** 某档模型的就绪状态机：全部资产齐 → ready；缺 → unprepared（`prepare()` 才下载，可取消）。 */
class ModelPreparation {
  listeners = new Set();
  state = { phase: "unprepared", steps: [] };
  preparing = null;

  constructor(options) {
    this.dir = options.dir;
    this.assets = options.assets;
    this.origins = options.origins;
    this.inspect();
  }

  /** 单资产路径 + 是否已在盘上（可选资产缺失不算缺）。 */
  assetStates() {
    return this.assets.map((asset) => {
      const path = join(this.dir, asset.file);
      let present = false;
      try {
        present = existsSync(path) && statSync(path).size > 0;
      } catch {
        present = false;
      }
      return { ...asset, path, present };
    });
  }

  inspect() {
    const states = this.assetStates();
    const missing = states.filter((state) => !state.present && !state.optional);
    // 可选资产（silero VAD）不在盘上时走**直接档**，不能让整体卡在 unprepared。
    this.ready = missing.length === 0;
    this.optionalMissing = states.filter((state) => !state.present && state.optional).map((state) => state.file);
    this.publish({
      phase: this.ready ? "ready" : "unprepared",
      steps: states.map((state) => ({
        kind: "model",
        status: state.present ? "complete" : state.optional ? "skipped" : "pending",
        detail: state.present ? state.path : undefined,
      })),
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
    if (this.ready || this.preparing) return;
    const abort = new AbortController();
    this.preparing = { abort };
    const startedAt = Date.now();
    this.report(startedAt);
    void this.downloadAll(abort.signal, startedAt).then(
      () => {
        this.preparing = null;
        this.inspect();
      },
      (error) => {
        this.preparing = null;
        this.publish({
          phase: abort.signal.aborted ? "cancelled" : "failed",
          error: abort.signal.aborted ? "已取消" : String(error?.message ?? error),
          steps: this.assetStates().map((state) => ({ kind: "model", status: state.present ? "complete" : "failed" })),
        });
      },
    );
  }

  /** 把「缺哪些资产」投影成进度步骤（含已下载字节）。 */
  report(startedAt, progress) {
    this.publish({
      phase: "preparing",
      step: "model",
      steps: this.assetStates().map((state) => {
        const active = progress?.file === state.file;
        if (state.present) return { kind: "model", status: "complete", detail: state.path };
        if (state.optional && !active) return { kind: "model", status: "skipped" };
        return {
          kind: "model",
          status: active ? "running" : "pending",
          startedAt: active ? startedAt : undefined,
          progress: active ? progress.progress : undefined,
        };
      }),
    });
  }

  async cancel() {
    this.preparing?.abort.abort(new Error("preparation cancelled"));
  }

  async downloadAll(signal, startedAt) {
    mkdirSync(this.dir, { recursive: true });
    for (const asset of this.assetStates()) {
      if (asset.present) continue;
      if (signal.aborted) throw signal.reason ?? new Error("cancelled");
      if (asset.optional) {
        // 可选资产失败不算失败：VAD 档降级为直接档，主链路不受影响。
        try {
          await this.download(asset, signal, startedAt);
        } catch (error) {
          if (signal.aborted) throw error;
          this.optionalMissing.push(asset.file);
        }
        continue;
      }
      await this.download(asset, signal, startedAt);
    }
  }

  async download(asset, signal, startedAt) {
    const origins = asset.file === "silero_vad.onnx" ? this.origins.vad : this.origins.model;
    const target = asset.path;
    const part = target + ".part";
    let lastError = null;
    for (const origin of origins) {
      const url = (origin.endsWith("/") ? origin : origin + "/") + asset.file;
      const file = createWriteStream(part);
      try {
        const response = await fetch(url, { signal });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} @ ${origin}`);
        const total = Number(response.headers.get("content-length") ?? 0) || asset.bytes || 0;
        let received = 0;
        for await (const chunk of response.body) {
          if (signal.aborted) throw signal.reason ?? new Error("cancelled");
          received += chunk.length;
          if (!file.write(chunk)) await once(file, "drain");
          this.report(startedAt, {
            file: asset.file,
            progress: { receivedBytes: received, totalBytes: total },
          });
        }
        await new Promise((resolve, reject) => file.end((error) => (error ? reject(error) : resolve())));
        // 声明长度对不上 = 连接中途断了（fetch 不报错时最容易漏），当失败处理并换源重试。
        if (total > 0 && received !== total) throw new Error(`下载不完整：${asset.file}（${received}/${total} 字节）`);
        // 权重文件必须逐字节可信：静默截断的 239 MB onnx 会变成一句看不懂的 onnx 报错，
        // 而 tokens 与权重不同源时更会直接错字。流式校验，不把整包读进内存。
        if (asset.sha256) {
          const digest = await new Promise((resolve, reject) => {
            const hash = createHash("sha256");
            const stream = createReadStream(part);
            stream.on("error", reject);
            stream.on("data", (chunk) => hash.update(chunk));
            stream.on("end", () => resolve(hash.digest("hex")));
          });
          if (digest !== asset.sha256) {
            throw new Error(`校验失败：${asset.file}（期望 ${asset.sha256.slice(0, 12)}…，实际 ${digest.slice(0, 12)}…）`);
          }
        }
        renameSync(part, target);
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
    throw lastError ?? new Error(`没有可用的下载源：${asset.file}`);
  }
}

export function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config };
  const home = process.env.DSH_HOME ?? ".";
  const prefix = resolvePrefix();
  if (!settings.binary) settings.binary = join(prefix, "bin", "sherpa-onnx-offline");
  if (!settings.vadBinary) settings.vadBinary = join(prefix, "bin", "sherpa-onnx-vad-with-offline-asr");
  if (!settings.libraryPath) settings.libraryPath = join(prefix, "lib", "sherpa-onnx");
  settings.threads = resolveThreads(settings.threads);
  const dir = settings.modelDirectory || join(home, "speech-to-text", "sherpa");
  const tmpRoot = join(home, "tmp");
  mkdirSync(tmpRoot, { recursive: true });

  const assets = (Array.isArray(settings.assets) && settings.assets.length > 0 ? settings.assets : ASSET_CATALOG)
    .filter((asset) => asset && typeof asset.file === "string");

  const preparation = new ModelPreparation({
    dir,
    assets,
    origins: { model: settings.modelOrigins, vad: settings.vadOrigins },
  });

  const info = {
    id: settings.id,
    name: settings.label,
    location: "host-local",
    languages: [...SENSE_VOICE_LANGUAGES],
    setupEstimate: {
      recommendedDiskBytes: 700 * 1024 * 1024,
      expectedMemoryBytes: 500 * 1024 * 1024,
      minimumMinutes: 2,
      maximumMinutes: 20,
    },
  };

  const transcribe = async ({ audio, language }, signal) => {
    if (!audio || audio.byteLength === 0) throw new Error("SenseVoice：录音为空");
    const phase = preparation.snapshot().phase;
    if (phase !== "ready" && phase !== "standby") {
      throw new Error("SenseVoice：模型尚未就绪，请先在语音设置里准备模型（SenseVoice Small int8，239 MB）");
    }
    // VAD 档需要 silero 模型；缺了就退回直接档（不因可选资产缺失而失败）。
    const useVad = Boolean(settings.vad) && !preparation.optionalMissing.includes("silero_vad.onnx");
    const binary = useVad ? settings.vadBinary : settings.binary;
    if (!existsSync(binary)) throw new Error(`SenseVoice：无法启动 ${binary}（文件不存在）`);

    const wav = join(tmpRoot, `dsh-sherpa-${process.pid}-${Date.now()}.wav`);
    // 归一化后再落盘：sherpa 按 RIFF 声明长度整块读，声明与实际不符即硬失败（见 normalizeWav 注释）。
    const normalized = normalizeWav(Buffer.from(audio));
    writeFileSync(wav, normalized);
    const startedAt = Date.now();
    try {
      const args = buildArgs({
        dir,
        wav,
        language: resolveLanguage(language, settings.language),
        useItn: settings.useItn,
        threads: settings.threads,
        vad: useVad,
      });
      /**
       * 子进程的库环境**只给专属目录**，而且不给它挂 termux-exec 预载。
       *
       * 真机实测（引擎内、经 linker64 档启动）：把 `<prefix>/lib` 放进 `LD_LIBRARY_PATH` 会报
       *   CANNOT LINK EXECUTABLE ".../sherpa-onnx-offline": cannot locate symbol "Xzs_Construct"
       *   referenced by "/system/lib64/libunwindstack.so"
       * ——官方 Termux 版 CLI 经 `libandroid.so` 拉进系统库，系统库要的是**系统** `liblzma`，而
       * `LD_LIBRARY_PATH` 里的 Termux `liblzma` 会把它顶掉（同一份文件在应用域直连执行时不报，
       * 说明是「经 linker64 启动 + 前缀库参与解析」的组合）。CLI 的 NEEDED 只有 onnxruntime 与
       * libc++（都在专属目录），故这里既不需要前缀库、也不需要 termux-exec 预载。
       */
      const childEnv = { ...process.env, LD_LIBRARY_PATH: settings.libraryPath };
      delete childEnv.LD_PRELOAD;

      const stdout = await new Promise((resolve, reject) => {
        let timer = null;
        const onLaunched = (child) => {
          let out = "";
          let err = "";
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`SenseVoice：识别超时（${settings.timeoutMs} ms）`));
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
            if (code !== 0) reject(new Error(`SenseVoice：退出码 ${code}；${err.trim().slice(0, 300)}`));
            else resolve({ out, err });
          });
        };
        spawnWithLadder(binary, args, { stdio: ["ignore", "pipe", "pipe"], env: childEnv }, settings.launcher)
          .then(({ child, how, tried }) => {
            if (how !== "direct") console.error(`SenseVoice: 用 ${how} 档启动成功（尝试序列 ${tried.join(" → ")}）`);
            onLaunched(child);
          }, (error) => {
            if (timer) clearTimeout(timer);
            const tried = Array.isArray(error?.tried) ? `；尝试序列 ${error.tried.join(" → ")}` : "";
            reject(new Error(`SenseVoice：无法启动 ${binary}（${error?.message ?? error}${tried}）`));
          });
      });

      const text = parseSenseVoiceOutput(stdout.out, wav);
      if (!text) throw new Error(`SenseVoice：没有识别出文本；${stdout.err.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
      return {
        text,
        audioSeconds: round(wavSeconds(normalized)),
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

  ctx.effect(() => () => {
    void (async () => {
      await preparation.cancel();
      for (const asset of assets) rmSync(join(dir, asset.file + ".part"), { force: true });
      await unregister();
    })();
  });
}

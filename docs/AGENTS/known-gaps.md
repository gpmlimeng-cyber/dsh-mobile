# known-gaps.md — 待办与已知缺口（非本轮范围，防再探）

## 8. 待办与已知缺口（非本轮范围，记录防止再探）

- F2「T1 授权豁免自动升级」未落地（电池白名单仅引导 Intent；指数退避仅日志不改调度）——涉及系统策略写面，不自动执行。
- F1.10 引擎更新通道未实现；F0.3 引擎事件桥未实现。
- 子代理 PRD 评审完整清单见协调仓库 `docs/review-0.13.0-20260823.md §九` 与 `.deploy-tmp/prd-gap-review.md`（U4/U5、A4/A6/A8、B4/B5/B7、F4、P4 未修项）。
- **~~扫描/图片版 PDF → 页图渲染受限~~（0.13.1 已修，0.13.0 记录作废）**：原记录「`@napi-rs/canvas` 仅 glibc 预编译装不上」系**误判**——npm 有 `@napi-rs/canvas-android-arm64`（N-API/Bionic 预编译，os=android cpu=arm64，真机 createCanvas 实测可用）。0.13.1 起随出厂快照装配（profiles/web package.json 登记 + tarball 解入，仅 arm64；npm 无 android-x86_64 triple，x86_64 模拟器维持守卫降级）。构建脚本 7c2 段。
- **marketplace 惰性加载决策（0.13.0 D4）**：cordis 装配层无惰性概念；拆装配违反 F4「内置市场」。启动速度优化由 D2（快照瘦身）+ D3（NODE_COMPILE_CACHE）承担，marketplace 保持启动装配。
- **provider 命名混淆（0.13.0 C3 实锤）**：默认 pin 曾为 `opencode-go`（OpenCode Zen Go 网关，`opencode.ai/zen/go/v1`，实测 404）——用户误以为配了 OpenRouter。0.13.0 默认 pin 改 `deepseek-official`（壳注 DEEPSEEK_API_KEY），opencode-go/OpenRouter 需在「添加自定义供应商」显式配置；设置页文案与文档需持续提醒区分。

---

## 无障碍通道待办（0.13.5 W4 未完项，2026-09-14 对账）

- **无障碍输入法**（API 33+，`FLAG_INPUT_METHOD_EDITOR` + `InputMethod`）：**【已核实不可行】**——javap 校验 android-36 的 `android.jar`，`AccessibilityNodeInfo` 无相关符号（见下方 0.13.8 批 F 登记）；非编辑节点中文输入继续由 `ACTION_SET_TEXT` + ADBKeyboard 承担。
- **`getSystemActions()` 驱动全局动作面**：**【0.13.8 E6 已落地】**——由系统动作集合驱动（核心 back/home/recents/notifications 恒放行），见 `GlobalActionCatalog.kt`。
- **节点动作面**：**【部分落地】**长按（`ACTION_LONG_CLICK`/`ACTION_PRESS_AND_HOLD`）已接；展开折叠/复制粘贴/翻页/拖拽仍未暴露为工具参数。
- **单窗口截屏**（API 34 `takeScreenshotOfWindow`）与多窗口选择（`getWindows()`）未接。
- **API <30 设备**：**【已回落】**0.13.8 E6 起无障碍截屏失败自动回落 ADB `screencap`；回落分支的真实触发设备验证仍未做（本机 API 35 无障碍截屏可用）。
- **arm64 真机验证**：0.13.6 曾完成 V2425A 链路验证；0.13.7fx-1 之后各版发布说明均标注「arm64 真机待验」，0.14.0-preview 同样待补。

## 0.14.0 收尾登记（2026-09-14，发布后工作区）

- **BrowserHost 与浏览器控制面：工作区已实现、未设备回归**：壳侧 `BrowserHost`（隔离 WebView + 拒绝面 + 视口 letterbox）与六条桥 op、面板视口下拉已就绪；`plugins/dsh-android-browser` 的 17 条工具契约与 `tools.ts` 实现（open/snapshot/click/type/press/scroll/get_text/wait/navigate/back/forward/reload/tabs/identity/viewport/screenshot/tier）已在工作区落地——**但 0.14.0-preview 发布时壳侧宿主未落地（面板只读），工作区代码未过设备端到端回归**；页代次/旧 ref 拒绝、截图权限与身份切换的设备验收待补。
- **虚拟屏多屏能力：工作区已实现、未设备回归**：壳侧已含实时 display registry（stable alias + 动态 displayId）、controller 自有选择目标、每查看器独立 bounds、查看器仲裁（同一 Surface 不能挂两个查看器，冲突返回 `viewer-target-occupied`）、`MAX_VIRTUAL_DISPLAYS=1`（0.14.0 发布提交起就是 1；旧文档写 2 是漂移）；面板已渲染「呈现目标」下拉（调 `vdisplaySelect`）。**发布版（0.14.0-preview）不含这些；工作区的 viewer 接管/重挂、双查看器冲突、横竖屏几何与截图仍未过设备回归。** 真实屏明确不可镜像（`screen-not-selectable`）。
- **Shizuku 完整特权体验未收口**：UserService/AIDL v1 与固定 argv 执行已落地、建屏/launch/back 探针设备通过；「无障碍关闭时 Shizuku 提供完整特权体验」（U-4）仍缺工具面改名/能力迁移与设备矩阵；ADB 配对页仍作为迁移/诊断面保留，未按 U-4 退役。
  **2026-09-19 设备实测更正**：本条登记的「设备矩阵」已由用户手工跑出，结论不是「未测」而是**确已损坏**——
  工具面 `android_capabilities` 在冷启动后报「Shizuku 未就绪」而壳侧实测已授权（模型据此放弃可用能力），
  且 `android_privilege_status` 把 Shizuku 结论挂在 `ADB 提示：` 标签下。根因与落点见协调仓
  `docs/0.14.1-preview-DEVICE-DEFECT-TRIAGE-AND-TEST-REFLECTION.md` §2（A1/A2）。
- **开放屏幕范围**：native 真源与执行点复查已落地；`virtual-only` 下真实屏观察面（含无障碍直连队列）的完整设备矩阵未跑。
  **2026-09-19 设备实测更正**：矩阵已跑，**`virtual-only` 下的工具可用性是坏的**——
  `android_act_input` 声明的 `screenId` 永远无法兑现（`input <verb>` 无屏幕维度，范围门在
  `bridge/src/index.ts:710` 早退恒拒）；`android_ui_tree` 因 `uiautomator` 家族被断言「无目标屏参数」而恒拒
  （与本仓 `:127` 的设备读数冲突）；`android_ui_click` 生效校验不带屏、在 virtual-only 下必然报
  `screen-out-of-scope`（根因是引擎/壳侧两份真实屏 op 清单不一致）；指引承诺的 `android_vdisplay_input`
  从未实现；`android_app_launch {screenId}` 无落点回读，会报成功而应用落在真实屏。
  根因、方案与新增门禁清单见协调仓同名文档 §3/§4/§6/§7。
- **按需 skill 注入（U-5）未实施**：控制流程仍会进入常驻上下文/schema 的部分未清点，token 预算门禁未做。
- **Shizuku 许可登记缺口**：gradle aar 依赖不在 `check-third-party.mjs` 的 dpkg 矩阵覆盖内，`assets/licenses/THIRD_PARTY_NOTICES.md` 无 Shizuku 条目（Apache-2.0）——发版合规需补。
- **性能 A1 结论未定**：`check-perf-instrumentation` 的 P-AC-01 要求出厂值 `patchReload: startup`，但 0.14.0 设备 A/B 观测 `live` 组中位约 12.5-13.0s 快于 `startup` 组 14.6-15.0s（n 小、compose 探针缺失、单机型）——方向与方案主张相反，需 owner 拍板是锁正确性语义还是改基线（见 `docs/0.14.0-preview-VERIFICATION-LOG.md` §50）。
- **单 ABI 静默交付**：0.13.8-b 实测「某 ABI 被拒后链路仍 exit 0」已由 `check-build-chain-abort.mjs` 拦下（坑 94），门禁已入 17 项集合。

## 0.13.8 收尾新增登记（2026-09-12 晚）

- **滚动条未吸附到最右侧（布局边界不匹配）**：用户真机反馈——滚动条与容器右边界之间有缝，
  没有贴在屏/面板最右（与 apk #197 的布局视口/边界同族，但独立现象，本轮未修）。待定位：
  ① WebView 右侧是否残留 padding 或系统手势区（壳侧 `setPadding` 目前只动 bottom）；
  ② 页面侧滚动容器的 `scrollbar-gutter`/`padding-right`/`max-width` 与
  `--dsh-mobile-popup-max-width` 等钳制变量是否把滚动条挤离边界（`composer-menu.css.ts` 的
  viewport 宽度钳制是重点嫌疑）；③ 移动形态下轨道宽度是否被 `ComposerPopupGuard` 按 CSS 宽度
  而非内容盒计算。定位方法：设备上量 `scrollContainer.getBoundingClientRect().right` 与
  `innerWidth`，以及 `getComputedStyle(el).scrollbarGutter / paddingRight`——先取数再改。
- **悬浮球动效手感（M4-M8）**：时长/幅度未经人眼走查（静态截图断言不了），发布前真机确认一次。
- **`KeyboardBoundary` 机制①的最终形态**：壳侧已把 IME inset 施加到 WebView 布局尺寸，
  页面侧的 `visualViewport.offsetTop` 补偿因此**刻意没有实现**（按 #197 建议修法 1，机制①
  从根上消失后该补偿即冗余）。若真机仍见残留平移，再补页面侧补偿——届时它是第二道防线而非主修。

## 0.13.8 批 F 收尾登记（2026-09-12）

- **API 33+「无障碍输入法」（E6d）无法实现**：`javap` 校验 android-36 的 `android.jar`，
  `AccessibilityNodeInfo` 无 `INPUT_METHOD_EDITOR` 相关符号，设计文档设想的路径在当前 SDK
  上不存在。`ACTION_SET_TEXT` 不被接受的场景由 ADB-IME 通道（`AdbKeyboardService`）承担。
- **截图回落 ADB 的触发路径未在设备上跑通**：本机 API 35 无障碍截屏可用，回落分支只能在
  API<30 设备上真实触发（ADB `screencap` 本身已多次实测）。
- **profile patch 合并语义「按 id 只增不删」**（坑 70）：我们注入的 row 一旦写进设备
  `home/.dsh/profiles/web/cordis.patch.yml` 就**删不掉**（改代码 + 重装 + 重解压都不生效）。
  影响：0.13.8 之后若要下线已注入 row，需要在 `SnapshotTransaction.mergePatchYamlById` 上给
  「上游注入行以 staged 为准」留口子（当前无标记区分「我们注入的」与「用户手改的」，
  实现前先设计标记方式，勿草率改成覆盖语义——那会吃掉用户手改）。
- **悬浮球动效 M4–M8 未做**（G3 余项）：待答卡位移渐隐 / 状态行 TextSwitcher / 琥珀呼吸 /
  PENDING 脉冲。M1/M2/M9/M10/M11 与降级门（`DsUi.animationsEnabled`）已在 #191 落地。

## 0.14.1 undo 链（2026-09-19）

- **`UndoGate.clearMarker` / `armedToDisplay` 仍是死代码（本轮只登记不修）**：两函数在全仓
  **零调用点**（`clearMarker` 仅自身定义，`armedToDisplay` 同），与 `UndoGate.kt` 类注释声称的
  「用户手动重试/手动 undo 后清除标记」及「供启动页显示」两处文档不符。实际只有 `disarm`
  （被 `EngineService` 在 IDLE 时调用）会删 `.undo-auto-armed`，而 `.undo-auto-done` marker
  **永不被清**——于是「上次自动 undo 成功」在 `RETRY_WINDOW_MS`（30 分钟）内持续压制后续崩溃纪元
  的自动回撤。**未修的真实原因**：清除时机是一个产品判断（哪些用户动作算「新的崩溃纪元」），
  仓促接线会把「用户刚修好又立刻崩溃」误判成旧纪元而拒绝自救，风险高于收益。
  最小落点：把 `clearMarker` 接在「用户显式重启引擎」（`EngineStartFlow.restart`）与
  「引擎健康确认跨越 N 拍」两处，并为其补一条能判红的单测。
- **0.14.1 已修的同类缺陷（留档对照）**：`WatchdogV2.planTick` 的熔断锁存盲区——`tripped()` 曾排在
  `undoReady()` 之前且一旦为真即永久 HOLD，而熔断在 60s 打开、托管子进程启动预算却是 90s，导致
  「子进程存活但 HTTP 永不健康」时 undo 与 restart 双双永久失效。修法 = undo 提到熔断之前
  + undo 成功路径补 `WatchdogV2.reset()`；防线见 `WatchdogLadderTest` 三个新用例与
  `UndoGateDecisionTest`。真因见坑 153。

## 0.14.1 预览轮登记（2026-09-19，T6）

- **[已闭合，2026-09-19 设备实测] `t_compose_total` 产品口径**：原文（本轮早些时候）称「出厂件上
  `t_compose_total` 仍会是 -1」——**该状态已被设备推翻**。引擎侧落点选了「产品内探针」形态：
  新增引擎树补丁 `combo-probe-P1`（`scripts/patches/apply-patches.mjs`）在 `dsh-client-modules` 的
  `compose()` 返回处直接打印 `[perf] compose #N at=… dur=…` / `[perf] TOTAL calls=… totalMs=… …
  loopP99Ms=… loopSamples=…`（只主线程安装，worker 不得冒充；不新增快照成员），壳侧解析器**零改动**
  （口径早已兼容）。设备（MuMu x86_64 / API 35 / 出厂树 + A5/C3/P1 补丁）实测：
  ```
  engine.log:            [perf] TOTAL calls=1 totalMs=1024 instances=1 firstAt=2079ms singles=0 loopP99Ms=37.0 loopSamples=55 comboCache=loaded hits=56 misses=0
  boot-segments.log:     t_compose_total=1024 t_compose_source=preload-total   ← 非 -1
  ```
  `t_compose_source` 的合法取值与含义：`preload-total` = 引擎产品内探针已落 TOTAL（本轮形态）；
  `none` = 该 boot 尚未收到 TOTAL（通常为 boot-start / listen 阶段的行，属正常中间态，**不是缺陷**）。
  - **仍缺席**：可用的**测量用 preload 发行路径**（`scripts/perf/count-compose.mjs` 仍不进快照）——
    已**不再需要**：产品内探针取代了它的发行角色，preload 仅用于设备取证时的对照。
  - **仍未闭合**：C4 的目标口径。产品内探针报的是**冷启动窗口内**的 `monitorEventLoopDelay()` p99
    （设备实测 37.0 / 56.2 / 61.6 / 77.1 ms，样本 25~92），**不是稳态 p99**；「稳态 <50ms」这条
    既有口径目前**没有任何探针在测**，见 `docs/0.14.1-preview-BOOT-SPEED-AND-LAZY-PLUGINS.md` §6。
- **块L 页面侧字段（pendingEntries / failedEntries / graphLoaded / waitingForMs 等）本轮未做**：
  其取数面在 `dsh-host-web-compat/lib/index.js` 的 `BOOT_WATCHDOG_SCRIPT`（注入层，本仓可改）
  与页面侧 `BootPage.states`（上游 dist，需构建链降级），**属别的写面**。本轮壳侧只交付
  「落盘 + 不可得时显式标注」，故详情档 §6.2 建议字段中的页面侧部分仍缺席。
  最小落点：把逐条 fiber 状态由页面侧**主动发布到一个全局**（一个赋值语句），诊断脚本只读；
  全局缺失时必须输出「页面侧状态不可得」而不是空数组（空数组正是本次误导的根源）。
- **NSC 明文放行未收敛到私有网段**（0.14.1 块K）：`base-config cleartextTrafficPermitted="true"`
  是全域明文。Android NSC 的 `<domain>` 不支持 CIDR/前缀，无法用静态 XML 表达「192.168.0.0/16」，
  故按用户裁定取全域撑开；若将来要收敛，需**设置页显式开关 + 安全提示**（详档 §3.2 F6 的建议形态），
  或改用运行时 `NetworkSecurityPolicy` 无法覆盖的方案——属未做项。

## 0.14.1 块G F6 收口状态（2026-09-19，T6）

- **已收口（三层都落地，各有反证）**：
  1. 桥侧范围门禁接受「已注册虚拟屏的 SurfaceFlinger token」（`screen-scope.ts` 的
     `adbCommandDisplayTokens` / `screenTokensFromSfDump` + `index.ts` 的 `registeredVirtualScreens` /
     `shellSfVirtualDisplayTokens`）。真因与设备读数见坑 147。
  2. 壳侧执行点门禁（F5，`ShellOps.targetsRegisteredVirtualScreen`）同样接受 token——否则桥侧放行后
     会被壳侧二次拦死（F5 的由来）。
  3. manage 的 ADB 回落路径（`android_screenshot`）已**真正消费**反查：虚拟屏目标先 `resolveVirtualDisplayToken`
     拿 SF token 再 `screencap -d <token>`；反查失败**fail-closed**（不回 displayId、不回真实屏）。
- **a11y 路线的定性已更正（2026-09-19 收口轮，设备实测）**：原记「对虚拟屏**不可用**」——该结论
  **只对当时（0.14.0 装机版、F1 未修）成立**，真因是**范围门按 op 名/real 一刀切**（screen-blind），
  不是 a11y 能力缺失。F1（`bridge/index.ts:832-838` 按 `args.screenId` 经 `screenAccessResolved` 判定）
  之后，virtual-only 下指虚拟屏的 a11y op 不再被门拒。当日设备实测（MuMu x86_64 / API 35，
  虚拟屏 active、a11y 服务 bound）：
  - `dumpsys window windows` → `WindowsForAccessibilityObserver{mDisplayId=10, mInitialized=true}`
  - `uiautomator dump --display 10` → 1916 B 真实节点表（可解析、非空）
    **2026-09-19 判定性实测更正（见坑 165）**：这一条当时被当成「`--display` 生效」的证据，**结论不成立**。
    在虚拟屏 `virtual-1`（displayId=2）上放好 Settings（`dumpsys` 确认 task 在 display 2）后，
    **无参 dump / `--display 2` / `--display 0` 三者输出逐字节相同**（7799 B、19 节点、全是真实屏上的应用）
    ⇒ `uiautomator dump` **收下 `--display` 但不生效**，恒 dump 默认屏。上面那 1916 B 几乎确定是**真实屏**的树。
    由此：`screen-scope.ts` 把 `uiautomator` 家族的目标屏参数判为「无」**实质正确**，不得放开；
    `android_ui_tree` 已删除它无法兑现的 `screenId` 参数（坑 163）。
  即 **a11y 通道对虚拟屏可达**；原「不可用」判读作废（原文与更正见坑 152）。
  - **仍未确证**：`takeScreenshot(displayId≠0)` 对**应用自建 private display** 是否成功（详档 §6 U5），
    需引擎工具面端到端调用定性。故 **ADB 回落仍是已验证可用的承重路径**，上面的 SF token 修法不是兜底。
  - 注意：上面「不可用」的原始读数取自 0.14.0 装机版（无本轮改动）。
- **仍未做的一项（如实登记）**：`android_screenshot {screenId:"virtual-1"}` 在**装机版上**的
  端到端出图**未验收**——本轮改动未打包装机（禁 gradle/打包）。已完成的替代证据：
  - 用**真实构建产物** `lib/vd-shot.js` 解析设备真实 `dumpsys SurfaceFlinger` 输出 →
    得到 token `11529215047793762666`（字符串，超 2^53 与 2^63-1）→ 真机执行
    `screencap -d <token>` → **成功 5,815 B PNG，675x1200**（虚拟屏像素，3 种 RGB、非全黑）；
    同期 `screencap -p` 真实屏 = 189,141 B / **900x1600**（256 种 RGB）；同期
    `screencap -d 7`（该世代 DisplayManager displayId）→ `Status: -2`、无文件。
  - 三段式子路径（桥侧门禁 / 壳侧 F5 / manage 反查+回落）各有单测，且都做过**改前判红**。
  - 装机后最小复验：调 `android_screenshot {screenId:"virtual-1"}`，断言返回 675x1200 级别像素、
    非真实屏画面（与真机 900x1600 对照）、非全黑。

## 0.14.1 设备缺陷修复轮（2026-09-19，三个 P0）

本轮修的是**设备实测**暴露的三类缺陷（定性见协调仓 `docs/0.14.1-preview-DEVICE-DEFECT-TRIAGE-AND-TEST-REFLECTION.md`，
坑 161-165）：A1 工具面把「尚未探测」渲染成「Shizuku 未就绪」；B 缺省 virtual-only 下工具大面积不可用
（跨语言 op 清单漂移 + 参数无法兑现 + 承诺的工具不存在）；C 跨屏拉起以退出码判成功、应用落在真实屏。

**已修并在代码层/门禁层验证**（逐条判据见坑位）：

- A1：三态 + caps 补探（`shizukuChannelProbed`）；`android_privilege_status` 独立特权行；状态路由同步补探。
- B：壳侧 `REAL_SCREEN_OPS` 11 → 8 条并与引擎锁死（新门禁 `check-op-registry-parity.mjs`）；
  `android_act_input` 虚拟屏路径走 `vdInput`；`android_ui_tree` 删掉无法兑现的 `screenId`；
  **补实现 `android_vdisplay_input`**（新门禁 `check-tool-name-promises.mjs` 守承诺面）。
- C：`launchApp` 落点回读（三态：`vd-launched` / `vd-launch-denied` / `vd-launched-unverified`），
  并为避开 16 KiB stdout 截断改用固定字面量过滤（42 KB → 1.97 KB）。

**新增设备套件**：`scripts/verify-screen-scope-matrix.mjs`（跨面一致性 + 落点回读 + 双屏像素对照 +
real-only 反证；判据全在设备事实上，证据不足判 `INCONCLUSIVE` 而非通过；`--self-test` 6 例判别力）。
**它刻意不进聚合门禁**：无设备环境下强行声明只会制造「SKIP 即通过」的假绿；当前定位是
**发布前设备门禁**，由操作者按 `docs/AGENTS/emulator-test-protocol.md` 在真机/模拟器上跑。

**仍未做 / 待设备判定（如实登记）**：

- **本套件尚未在装机版上跑过一次**：本轮改动完成打包，但套件的首次真跑证据尚未产出——
  下一个动作就是跑它并把结论贴进 PR 描述（三层验收的 B 轨）。
- **`takeScreenshot(displayId≠0)` 对应用自建 private display 是否成功**仍未知（承接上文 U5；
  套件的 P3 用 SF token 的 `screencap -d <token>` 取虚拟屏像素，走的是另一条路，不回答这个问题）。
- **第三方应用能否被拉起到 private 虚拟屏**：本次判定性实测在 MuMu x86_64/API 35 上**成功**
  （`com.endday.game` 落在 display 2），且 `am start --display 2` 经普通 adb shell（uid 2000）也成立——
  这与 `VdisplayController.kt` 创建处注释「uid 2000 与 10053 两条路实测被拒」**冲突**；
  只在本机型证实，未在第二台 ROM 复核。注释已按实测改写为「本机型成立、他机型待复核」。
- **虚拟屏上限仍为 1**（`MAX_VIRTUAL_DISPLAYS`）：套件的多屏分支未覆盖。

## 0.14.1 审查轮登记的缺口（承接 `docs/COMPAT-REVIEW-0.14.0-2026-09-19.md`，进度见协调仓 `0.14.1-REVIEW-CHECKLIST-PROGRESS.md`）

| # | 缺口 | 现状 |
|---|---|---|
| K-A | **侧栏浏览器自动落位的时机洞**：`browser-auto-place.ts` 的 `tick()` 在「首次观测到某 owner 且已有页面」时只建基线就 return（`seenEmpty` 守卫）；若 `browserCaps` 与 `browser_open` 落在同一拍 1s 轮询内，该页**永远不会注册成侧栏 tab** | 未修。修法：壳侧 `status()` 增页面创建时间戳（如 `lastPageAtMs`），前端按 `pageCreatedAt > UI 加载时刻` 判真实边沿，替代近似守卫 |
| K-B | **A3 悬浮窗背景启动限制在多 ROM 上未复核**（0.14.1 块 H 自述残留） | 需多 ROM 真机各跑一次（权限缺失/开关关闭/无虚拟屏三种 fail-closed 形态） |
| K-C | **块 J① FIX-3「双起点验收」设备级证据缺**：`files/notify-responder.log` 的 `result=` 判据此前读错文件（真因已修），修后需再装机复验 | 未复验 |
| K-G | **发布链 `build-release.ps1` 的两处顺序/耦合缺口**（0.14.1-preview 组装实测） | ① **注入后组合缓存失配**：`check-combo-cache.mjs` 要求「快照内每个客户端 bundle 都能在 `.combo-cache/*.json` 里按 sha256 命中」，而注入会**替换**插件文件（本轮实测 `replaced entries: 194`）——若注入后没有按新字节重算缓存清单，门禁就在 `check-combo-cache.mjs(<abi>)` 判红（实测复现两次，与插件是否重构建无关地偶发）。② **前置门禁跑在注入之前**：`build-release.ps1:60` 用 `--snapshot-dir dsh-mobile-apk/snapshot` 跑全量门禁，而该目录在链内**随后**才被注入（`:109`）——于是「注入后产物」类断言（api-route-auth 的 post-injection marker、boot-budget 的 C5 正向对照）在第一次运行时必然取不到判据；本轮已把 boot-budget 的该 SKIP 具名声明化（`scripts/gate-skips-declared.json`），但**根治应是把前置门禁换成「注入后快照」或把该步移到注入之后**。现状：本轮发布资产按 `build-apk-013.ps1 -Suffix "-preview"` 的双 ABI 产物 + 注入后快照手工组装，门禁已用 `--snapshot-dir release/v0.14.1-preview/snapshot` 实跑 29/29（4 处 SKIP 全部具名声明）。 |
| K-F | **自动回滚（UndoGate + 急救 CLI）** | **已修并设备验收**（2026-09-21）：① 回滚目标改为**壳侧探活 HEALTHY 时记录的 known-good 快照**（不再认插件自报的 `boot-state.lastGoodAt`——它会在崩溃那次启动就写 ok）；② 加**安装指纹护栏**：跨版本一律不自动回滚，避免「新 APK + 旧配置」把新版本改动吃掉；③ 回滚被拒时复位看门狗锁存（否则引擎再也不被重试）。判据 `scripts/verify-auto-undo.mjs`（P1-P4 PASS：坏插件被剔除装配、171 个自带插件文件逐条 sha256 不变；`--cross-version` 验跨版本护栏）。**同轮补第③条**：坏插件让引擎进入 `DEGRADED_LOG`（日志 `plugin tree failed to load`、HTTP 仍活着）时，`planTick` 原本直接早退 IDLE ⇒ 自动回滚**根本不会触发**（设备实测：`undo-gate.log` 连 armed 都没有，只能手动重启）。已修：只对**装配失败**这一条签名放行到 undo 决策，且不让熔断把它锁成永久 HOLD（`WatchdogPluginTreeTest` 5 例，含「改前必红」的 IDLE→UNDO 断言与「活动 turn 不得被打扰」的反向对照）。**同轮改设计（2026-09-21 用户拍板）**：整份配置回滚会静默吞掉「最后一次健康启动之后用户装的插件」，故改为**清单式外科拔除**——硬清单（随版本并集，强制保留）+ 软清单（只在「清单变化 + 壳侧探活健康」时更新）；故障时能点名则**只拔坏的那一块**，点不出名且清单变过则拒绝整份回滚。设备验收（`-SN-1-18`）：`PASS=12 FAIL=0`，`pulled plugin=@dsh-android/dsh-bad-probe` 后清单**与基线逐字节相同**。**遗留**：插件**代码树不在快照范围内**（本机 20 份快照恒为「文件6 插件0」，坏插件「只改代码不改配置」这一类仍无法回滚）→ `#239`；坏插件**目录残留**仍在（剔除的是装配，不是文件） |
| K-E | **通知消费停摆（真机 #238：有消息不弹横幅 / 长按查看汇报空白）** | **已修并设备验收**：消费不再只靠一次文件事件——看门狗 5 s tick 兜底 `NotifyStore.drainTick` + 监听位扩到 `MOVED_TO/CLOSE_WRITE` + `drain` 加锁且先投递再推进偏移 + 长按面板文件回落 + 同内容 2 s 去重。设备判据 `scripts/verify-notify-consumption.mjs`（PASS=5/FAIL=0，含「硬链接注入只有兜底能消费」这条主判据）与横幅截图见 `dsh-mobile/docs/0.14.1-preview-NOTIFY-CONSUMPTION-STALL-FIX-PLAN.md` §9.4。**遗留**：真机停摆的触发源未坐实（候选 C5：目录 inode 被换后 inotify 静默失效）；长按面板本身未在设备上截到（本机未开悬浮球开关） |
| K-D | **execAdbLine 档位门的会话来源依赖工具入口绑定**（0.14.1 S-5 引入）：会话经 `guard()` 的 AsyncLocalStorage 绑定传递；若将来出现不经工具入口的后台调用路径，会被 fail-closed 拒（预期行为，但需要一条测试钉住） | 已在审查进度文档 §3.4 登记 |

### 0.14.1 设备验收轮补充发现（2026-09-19 晚）

- **`com.endday.game`（Godot 游戏）在虚拟屏上会 SIGSEGV 崩溃**：crash 缓冲实测两次
  （`19:30:30` 与 `21:05:53`，`fault addr 0x134`），栈落在
  `org.godotengine.godot.input.GodotInputHandler.onInputDeviceAdded / handleJoystickConnectionChangedEvent`
  ——输入设备变化事件触发。**本包一次都没崩**（crash 缓冲内 `grep -c dsharnessmobile` = 0），
  即这是第三方应用自身的健壮性问题，不是壳侧缺陷。影响：`verify-screen-scope-matrix.mjs` 用该包做
  「虚拟屏落点」样本时，任务期间它可能自行退出 → P2 会得 INCONCLUSIVE（回读找不到 ActivityRecord），
  这是**如实的证据不足**而非假绿。换一个更稳的第三方样本（或有 launcher 入口的系统应用）可缓解。
- **自然提示（不写工具名、不写解锁）那一轮的观察**：模型**自己**发现要先解锁——实测它调用了
  `android_capabilities · all`（见证据目录 `p2-conversation.txt`），随后仍在推理中被本轮取证打断，
  未取到完成态。故「解锁链路是否被模型自主走通」目前只有**一次未完成的观察**，
  尚不足以判定（既不能算通过，也不能算断链）。

## 引擎升级到 0.1.7-rc.2 后的已知缺口（2026-09-26，deepcode 二开线）

- **combo 缓存族未移植（A3/A5/C3/P1）**：上游重写了 `dsh-client-modules` 的组合模型
  （`orderByModuleGraph` + `partitionComboRecords` + `buildBatch`），四条补丁针对的旧模型已不存在，
  故在 0.1.7 上判「不适用」。**影响面**：丢掉「构建期 combo 预计算 + 单条惰性 + 并行 + 探针」这层
  启动优化 ⇒ 冷启动变慢（功能不受影响）。要做，需在新模型上重做等价物，属独立工程。
  A4（compose 惰性 + 去重）在新模型上仍可施加，已保留。
- **8 个 @deepseek-ai 包在 0.1.7-rc.2 未发布**：`dsh-code-runtime`、`dsh-code-runtime-worker-thread`、
  `dsh-e2b`、`dsh-experimental-agent-team-web-profile`、`dsh-fs-e2b`、`dsh-settings-file`、
  `dsh-subprocess-e2b`、`dsh-workflow-worker-thread`。装配时经「已装配树内是否存在依赖者 + 是否被
  补丁层点名」双向核对后**省略**（无人依赖、未被点名）；`dsh-agent-presets` 因被
  `dsh-host-apiproxy` 的 peer 引用而回落到其最新可用版 `0.1.5-rc.3`。若上游后续需要这些包，
  需回查其可用版本线。
- **`patchReload` 特性被上游移除**：移动壳当初为 Android 强制 `startup` 档（避免 live reload 的
  冷启动开销）的优化**失去对象**（见坑 182）。若上游以其它机制保留了热重载，需在新机制上重新评估
  Android 侧的冷启动代价。
- **F9 垫片尚未接进官方快照构建链（但已进 APK 产物）**：`node-addon-require-builtin-android-arm64` 的纯 JS
  垫片（源码留档工作区 `tools/f9-android-shim/`）已随本轮手工装配的引擎树**烘进可安装 APK 的快照**（装上即带，
  不再依赖设备侧换树）；但它仍是**手工步骤**——`build-snapshot`/`inject-all` 的注入面里没有它，重跑官方
  快照链不会自动生成。要做成可复现形态，需把它作为额外包注入（可复用 overlay 的 `extraPresent` 机制，见坑 180）。
- **新引擎快照目前是「手工建树 + 手工补两步」的产物，官方快照链在本机未跑通**：`scripts/snapshot-config/engine-overlay.json`
  已按 0.1.7-rc.2 树重写（310 包 / vendorTop 17 / 4 个未发布保留），但 `build-snapshot-013.mjs` 第 0e 步的
  「逐包拉 npm + 补依赖闭包」在本机（arm64 Android）尚未完整验证过。本轮的可用路径是：按 overlay 拉树 →
  打补丁 → `tools/normalize-modes.py` 归一权限 → `--degrade` 降级 → `tools/rebuild-snapshot-engine.py` 换子树
  → `xz -T0`（见 build-and-env §3.6）。**缺口**：这条路没有进入 CI/官方链，重出快照需人工照做。
- **`scripts/patches/**` 的改动尚未同步协调仓**：本轮改了 `apply-patches.mjs`（`applies` 归一 + 三条重复
  `applies` 删除）与 `registry.json`（5 条 `featureAnchor`）。该目录是**双仓逐字节镜像面**（铁律 6）——
  本地 `check-patch-mirror.mjs` 因对端树不在场而 SKIP，但**云端自包含构建用的仍是旧副本**，合并前必须
  按「先本仓镜像 PR、再协调仓权威源 PR」的顺序同步。
- **门禁的「第三态」目前只覆盖两条**：`check-engine-overlay`（marker vs `featureAnchor`）与
  `check-perf-instrumentation`（`na()`）已能表达「上游已移除该特性」。其余门禁若将来也遇到「上游整块删掉
  被测对象」，需按同一原则各自加 N/A 出口——**不得**用「放宽判据」或「永久 SKIP」代替（见坑 184）。
- **`dsh plugin` 子命令在共存包里不可用**：快照里的 `pnpm` shim 烧的是主包前缀
  （`/data/user/0/com.dsharnessmobile.shell/…`），dev 包（`com.deepcode.shell`）调用必失败 ⇒
  版本豁免只能手写 `compatibility.json`（见坑 181）；同理其它走 pnpm 的插件管理动作在共存包里都不可用。
- **语音输入在 Android 上由「本机 whisper.cpp + 云端 MiMo」两条自研 provider 提供，上游 sensevoice 路线不可用**：
  上游 `dsh-experimental-speech-to-text-sensevoice` 依赖 `sherpa-onnx-node` 的原生 addon，而该项目 npm 上
  **只有 darwin/linux/win 绑定、android-arm64 从未发布** ⇒ 在 Android 上打开语音设置只会得到
  「准备失败: Local speech is unavailable for android-arm64」。本仓新增 `plugins/dsh-whisper-local`
  （本机离线：随包 whisper-cli + tiny 模型，实测 11 s 音频 ≈ 2 s）与 `plugins/dsh-mimo-asr`
  （云端：复用 `llm-pi-ai` 的 `xiaomi-token-plan-cn` 路由与 key，实测 ≈ 1.1 s），默认走本机 whisper。
  三件必要件（bundle 登记 / provider 后端 / 壳侧麦克风双门）与实测判据见坑 193-195。
- **语音后端的二进制与模型由「工作区资产」注入，尚未进 CI/官方链**：`whisper-cli` 是本机原生编译产物
  （链上不该为此装 500 MB 工具链），模型是 77 MB 二进制；二者经 `tools/snapshot-assets.json` +
  `tools/add-snapshot-assets.py` 在「引擎树换好之后、压缩之前」注入快照，**与 F9 垫片同族**（本地可复现、
  云端链不产生）。要做成可发布形态有两条路：把 whisper.cpp 构建纳入快照链（需给链装工具链），或把
  CLI/模型作为 Release 资产随构建下载。
- **语音识别是「整段录音 → 整段推理」，不是流式**：provider 契约本来就是「一次录音一次 transcribe」，
  本仓两条实现都按此；长句子的实时字幕/边说边出字需要另做（上游亦无此能力）。
- **上游 sensevoice provider 仍会出现在语音设置页（失败态）**：`- id: speech-to-text-sensevoice / disabled: true`
  对 **bundle 插入行不生效**（成因见坑 191），故设置页可能列出三个 provider、其中 SenseVoice 显示「准备失败」。
  默认选择是我们声明的 `whisper-local`，不影响使用。
- **升级安装的 profile `package.json` 走「并集」合并 ⇒ 工厂已删除的 bundle 在 live 侧永久残留**：
  `SnapshotTransaction` 对 `dsh.profile.bundles` 取并集（同名冲突保留 live）。实测：dev 包 live 的 bundles
  里带着 `voice-input-bundle` / `experimental-agent-team-profile` / `experimental-auto-review` 三项工厂从未
  声明的条目，升级后仍在 ⇒ 语音输入页面在**升级设备**上依旧出现，而全新安装不会（见坑 191/192）。要彻底
  收敛，需要壳侧在合并时按工厂参考**剪除**未知 bundle（属独立改动，涉及快照事务语义，未做）。

### 语音：流式听写（边说边出字）未实现（2026-09-27 登记）

- **现状**：三个 provider 都是**整段识别**——`speech.transcribe` 的契约本身就是一次性的（一段 canonical WAV 进、一段文本出），所以 UI 上是「说完再出字」。
- **要做出流式**需要三件东西，缺一不可：① 引擎侧一条**流式**路由（现有 `speech.transcribe` 不是）；② 本机流式模型（sherpa-onnx 官方 CLI 已随包提供 `sherpa-onnx-online-websocket-server` 与 `sherpa-onnx-vad-with-online-asr`，模型可用 `sherpa-onnx-streaming-zipformer-*` / `streaming-paraformer-*`，**都要另下权重**）；③ 自定义**客户端** voice-input 插件（上游 `ui-voice-input` 只按一次性契约工作）。
- **不是缺陷**：这是产品形态选择，SenseVoice 的非流式识别在短句上延迟已很低（2.4 s 墙钟、其中 1.3 s 是模型装载）；若要做常驻进程还可把这 1.3 s 摊掉。

### 语音：SenseVoice 权重不随包 + VAD 默认关（2026-09-27 登记）

- `model.int8.onnx`（239 MB）按需下载，首用需一次联网下载（下载完整性已用 `content-length` + sha256 双锁保证）。
- VAD 档（`sherpa-onnx-vad-with-offline-asr` + silero）随包但默认 `vad: false`：短句（语音输入的主场景）直接档更快；长录音/多句场景可在 profile 行打开 `vad: true`。
- `defaultProvider` 仍为 `whisper-tiny`（新装 APK 零下载即可用）；质量优先需在设置页切到 `sherpa-sensevoice`（首次触发下载）。

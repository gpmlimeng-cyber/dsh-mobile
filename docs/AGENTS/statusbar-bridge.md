# 状态栏桥协议（页面 ↔ 壳）

> 适用：Android 壳（`com.deepcode.shell` / `com.dsharnessmobile.shell`），自 0.14.1（2026-10-15）起。
> 对应提单：**「状态栏：支持透明/半透明 + 给页面一个可调的接口」**。
> 实现：`app/src/main/java/com/dsharnessmobile/shell/StatusBarChrome.kt`（单测 `StatusBarChromeTest.kt`）。

## 1. 默认行为（页面什么都不做）

- 状态栏 **透明 + edge-to-edge**：WebView 从 `y=0` 开始绘制，滚动内容会**穿过状态栏下方**；
- 若页面声明了 `<meta name="theme-color">`，壳**跟随它**（页面里该 meta 增删改，壳自动重推，幂等）；
- 图标明暗按最终底色的**相对亮度**自动切（>0.45 → 深色图标，浅底场景）；
- 主题里 `android:statusBarColor` 已置 `transparent`（4 个主题文件）；导航栏未动。

## 2. 页面可调的桥

对象：`window.dshStatusBarBridge`（与 `__dshThemeBridge` 同样是**页面加载即可用**的注入桥；重复调用安全）。

```js
// 主入口：三个参数都是字符串；不需要的项传空串
window.dshStatusBarBridge.set(mode, color, appearance)

// 复位：清除页面显式设置 → 回到「跟随 <meta name="theme-color">；未声明则透明」
window.dshStatusBarBridge.reset()

// 兼容入口（等价 set('solid', color, '')；传空串 = set('transparent','','')）
window.dshStatusBarBridge.apply(cssColor)
```

| 参数 | 取值 | 说明 |
|---|---|---|
| `mode` | `"transparent"` | 状态栏透明，内容透出（配合页面自绘半透明/磨砂层 = 目标观感） |
| | `"solid"` | 固定色，取 `color` |
| | `""`（或其它） | **不指定**：跟随 `<meta name="theme-color">` |
| `color` | 任意 CSS 颜色 | `#f8f8f8` / `#fff` / `rgb(248,248,248)` / `rgb(248 248 248 / 80%)` / `rgba(248,248,248,.8)` / `#00ff0080`；**支持 alpha（半透明）** |
| `appearance` | `"auto"` / `""` | 按最终底色亮度自动 |
| | `"dark"` | 强制**深色图标**（浅底场景） |
| | `"light"` | 强制**浅色图标**（深底场景） |

**优先级**：页面显式 `set()` **>** `<meta name="theme-color">` **>** 透明。
（`set('solid', '色')` 之后，页面 meta 再变**不会**推翻它；要交还控制权就调 `reset()`。）

> ⚠️ **`mode="transparent"` 时 `color` 参数被忽略**：壳直接写 `window.statusBarColor = 0x00000000`（不画任何色），
> 既不读 `color` 也不读 meta。该语义由单测固定（`StatusBarChromeTest.kt` 的 `decideColor("transparent", …) == null`）。
> 想给状态栏区着色只有 `mode="solid"` 一条路——但那是不透明条带，会**盖住**该区域内的页面内容。
> 若页面看到的"状态栏区有色差"，先按 `docs/AGENTS/statusbar-transparent-band-verification.md` 的口径复测
> （行均值会把系统图标字形算成台阶，判底色要看背景众数）。

### 典型用法

```js
// ① 目标观感（内容穿过状态栏，页面自己画磨砂层）
window.dshStatusBarBridge.set('transparent', '', 'auto')

// ② 固定半透明白（页面侧不画磨砂，也要与内容区分时）
window.dshStatusBarBridge.set('solid', 'rgba(248,248,248,0.8)', 'dark')

// ③ 跟随主题切换（每次主题变化都调一次，幂等）
window.dshStatusBarBridge.set('solid', dark ? '#080a09' : '#f8f8f8', 'auto')
```

## 3. 时机与幂等

- **页面加载后**随时可调（壳在 `onPageFinished` 安装 meta 观察器；桥在 `onCreate` 即注册）；
- **颜色/主题变化时重复调**：无副作用、不累积状态，最后一次调用生效；
- 沉浸式开关（设置页「状态栏常态收起」）切换后，壳会**自动重放**当前设置，无需页面重调。

## 4. 不变的契约（页面依赖）

- `--dsh-android-system-top` / `--dsh-android-system-bottom` / `--dsh-android-system-left` /
  `--dsh-android-system-right` / `--dsh-android-ime-bottom` 的**取值路径与语义不变**
  （仍在 `MainActivity.pushWebInsets`，由 `WindowInsetsCompat` 计算）；
- **透明状态栏不改变状态栏高度**：`bars.top` 原样，页面仍可用该值铺自己那层磨砂/对齐内容。

## 5. 验收对照（提单四条）

| 提单判据 | 壳侧行为 |
|---|---|
| 调 `transparent` 后滚动内容可见于状态栏下方 | WebView 从 `y=0` 铺满（`setDecorFitsSystemWindows(false)`）；静态截屏实测状态栏带已是页面像素（差 ≤2/255） |
| 调 `solid` 成任意色，状态栏随之变化 | `set('solid', 色)` → `window.statusBarColor = 解析值`，壳日志 `dsh-statusbar: apply mode=solid color=#...` |
| 浅/深底色图标自动切换、读得清 | `appearance=auto` 按相对亮度（阈值 0.45）；也可用 `light`/`dark` 强制 |
| `--dsh-android-system-top/bottom` 数值不变 | 本改动零命中 inset 通道（`git diff` 可验） |

## 6. 排障

壳日志标签：`adb logcat -s dsh-statusbar`，每次应用都会打一行：

```
I dsh-statusbar: apply mode=solid color=#CCF8F8F8 declared=(none) appearance=dark lightIcons=true
```

- `mode=(meta)` 表示当前是「跟随 meta」档（页面没调 `set()`）；
- `color=#00000000` = 透明档；
- `lightIcons=true` = 深色图标（浅底），`false` = 浅色图标（深底）。

## 7. 未做的部分（如需要再说）

- **导航栏**（底部）仍由主题 `@color/ds_bg` 固定，未纳入本协议；
- `console.html`（开发者控制台 Activity）保留自己的 `#080A09`，未纳入。

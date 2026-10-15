# 复核：dev 壳「透明态状态栏区自绘底色 / 顶部分割线」（2026-10-16）

- 提单：`docs/requirements/2026-10-16-statusbar-transparent-scrim.md`（DS Bot 团队，2026-10-16 00:2x）
- 被测壳：`com.deepcode.shell` 0.14.1 / code 40（含状态栏桥，即本仓 `a3817e3`）
- 复核方式：从 base 壳（`com.dsharnessmobile.shell`）独立复测——raw 帧缓冲 + 源码取证
- 设备：1672×2364、440dpi（density 2.75）；`SurfaceFlinger` 报状态栏层 `bounds={0,0,140,1672}` ⇒ 状态栏高 **140 device px = 50.9 CSS px**

## 0. 结论（先给结果）

| 提单请求 | 现有壳的实际状态 | 是否需要改壳 |
|---|---|---|
| ① 透明态不要自绘 scrim/底色 | 透明态下壳**什么都没画**（`window.statusBarColor = 0x00000000`，全仓无第二处绘制点）| **不需要**——该区域已无壳侧图层 |
| ② 透明态支持"scrim 颜色"参数 | **不支持，且是既有语义**：`transparent` 分支直接忽略 `color`（`decideColor()` 命中即 `return null`；单测 `StatusBarChromeTest.kt:75` 固定）| 需要改代码，但按 ③ 无必要 |
| ③ solid 只作背景层、不覆盖内容 | `solid` 是把**不透明色写给平台的 `window.statusBarColor`**，由平台在窗口层覆盖该条带；壳没有自绘 View 可以"只作背景" | 需要改结构（见 §4） |

**并且：提单里「暗 13.5/255、在 CSS 51 处收出横线」这一现象，本次复测未能复现**——它的位置与量级可由**测量口径**完全解释（§3）。

## 1. 透明态下壳不画东西（源码 + 实测双侧一致）

唯一绘制点（`StatusBarChrome.applyNow`）：

```kotlin
val effective = decideColor(explicitMode, explicitColor, pageDeclared)
window.statusBarColor = effective ?: TRANSPARENT   // TRANSPARENT = 0x00000000
```

`decideColor` 对 `mode="transparent"` **直接 `return null`**（不读 `color`、不读 meta），于是写进窗口的就是全透明。

实测（dev 壳 pid 9065，页面正在调用 `set('transparent', …)`）：

```
10-16 00:28:51.619  9065  9065 I dsh-statusbar: apply mode=transparent color=#00000000 \
    declared=rgb(252, 252, 252) appearance=auto lightIcons=true
```

即：**页面调的透明态已生效，壳写入的底色是全透明（不画）**，页面 meta 声明是 `#fcfcfc`(252)。

另外两条源码取证：

- `grep -rniE "scrim|contrastenforced" app/src/main/java app/src/main/res` 只命中一个颜色资源 `@color/ds_scrim`（用于引导/面板，不在状态栏路径上），**没有任何状态栏 scrim 绘制**；
- `grep -rn "style.background|style.backgroundColor|setProperty('background" app/src/main/java` **零命中** ⇒ 提单旁证里「壳会向页面 `<html>` 写入 inline `background: rgb(241,243,241)`」**不是壳做的**，写入方只能是页面自己的脚本（建议页面侧自查 `ds-bot/src/client/status-bar.js` 一带）。

## 2. 静息态实测：状态栏区背景 = 下方背景 = `252,252,252`

抓帧与前台确认放在**同一条 shell 命令**内，避免前台漂移：

```sh
am start -n com.deepcode.shell/com.dsharnessmobile.shell.MainActivity
sleep 2
dumpsys activity activities | grep -m1 ResumedActivity   # → com.deepcode.shell/…MainActivity
screencap > /sdcard/DSH/tmp/who.raw                      # 1672×2364 RGBA_8888
```

用本仓 `scripts/screenshot-profile.mjs rect` 统计**背景众数**（x 取 400..1200，避开左右两侧的时钟与状态图标）：

| 矩形 | 众数（占比） | distinct | meanL | minL |
|---|---|---|---|---|
| `y=10..50`（状态栏区上半） | `252,252,252` (93.9%) | 2 | 252.06 | 252.00 |
| `y=115..135`（状态栏区下半） | `252,252,252` (92.9%) | 2 | 252.07 | 252.00 |
| `y=60..100`（图标所在行） | `252,252,252` (91.4%) + `88,88,88`/`63,63,63` | 121 | 248.30 | 63.00 |
| 全宽 `x=60..1610, y=0..55` | `252,252,252` (93.8%) | **2** | 252.06 | 252.00 |

⇒ 状态栏条带的**背景**与条带下方**同色**（都是页面自己声明的 252）；条带内唯一的深色像素是**系统图标字形**。**没有 scrim，也没有可见底色层。**

## 3. 那个 13.56 台阶是测量口径造的：行均值把图标算进去了

提单的方法是"全宽行均值（device x=60..1610）"。我用同一口径复算，**同样得到一步台阶**：

```
条带[y=0..109] RGB=(244.2,245.6,244.4) L=245.21
下方[y=110..]  RGB=(251.8,251.8,252.1) L=251.82
dL = -6.61，台阶落在 y=110（= 图标字形的底边）
```

即：**图标字形把含它们的行压低，越过字形后整行回到页面底色** ⇒ 人为台阶。
台阶位置 = "图标区底边"：提单测到 `y=140`，恰好等于 `SurfaceFlinger` 报的状态栏高度 **140 px = CSS 51**（也就是他们写成的 `--dsh-mobile-top-inset`），量级差异只是当时状态栏里图标疏密不同（我这次 −6.6，他们那次 −13.5）。

**这也解释了他们的 A/B**：把页面 `.bt-topfade` 设 `display:none` 后剖面"逐行差 0.00"——因为台阶本来就不是页面那层遮罩造成的，**也不是壳**，而是图标。

判据修法：**不看行均值，看背景众数**（本仓新增 `scripts/screenshot-profile.mjs rect`），或取不含字形的列区间。

## 4. 三条请求的壳侧答复

① **透明态不自绘**：现状即是（§1）。无需改壳；建议页面侧按 §3 复测确认。若他们仍能肉眼看到"横线"，用 §5 的决定性实验定位。

② **透明态 scrim 颜色参数**：现有壳不支持——`transparent` 忽略 `color`（§1，已有单测固定）。**并且不建议做**：若把它实现成"给 `window.statusBarColor` 写一个不透明色"，那等价于 `solid`，反而会**盖住**页面内容（违反验收第 2 条"仍能看到滚上去的半透明文字"）。

③ **solid 只作背景层**：`solid` 的实现是 `window.statusBarColor = <不透明色>`，这条带是**平台在窗口层画的**，不是壳的 View，所以"不覆盖 WebView"在 `statusBarColor` 语义下做不到。真要实现只有一条路：**透明态下另起一个位于 WebView 之后的 View 画色**，并把 `webView.setBackgroundColor(TRANSPARENT)`（当前是 `0xFF1E1E1E`，`MainActivity.kt:144/234`）——但这只在**页面该区域背景透明**时才可见，页面若自绘底色则依旧被页面盖住。属结构性改动，建议单独提单，不建议为当前现象做。

## 5. 建议页面侧下一步（两条，成本各几分钟）

1. **换判据复测**：同一设备、同一页面，按 `rect` 背景众数对比 `y=10..50` 与 `y=115..135`；预期两者同为页面底色（≤1/255）。
2. **决定性实验（若仍能看到横线）**：把系统状态栏**收起**（壳设置页「状态栏常态收起」／沉浸式），同位置再抓一次：
   - 横线**消失** ⇒ 它属于状态栏条带，需要继续定位（届时把两张 raw 交给壳侧）；
   - 横线**仍在** ⇒ 它根本不在状态栏区域，是页面自绘（页面侧可直接修）。

## 6. 复现命令（供页面侧/壳侧重跑）

```sh
# 1) 抓 raw（不要 -p，保留 raw 头；多显示器时加 -d <id>）
screencap > /sdcard/DSH/tmp/shot.raw

# 2) 背景众数（判定底色，避免图标污染）
node scripts/screenshot-profile.mjs rect /sdcard/DSH/tmp/shot.raw 400 1200 10 50
node scripts/screenshot-profile.mjs rect /sdcard/DSH/tmp/shot.raw 400 1200 115 135

# 3) 行剖面（只在需要看台阶形状时用，且必须知道它会受图标影响）
node scripts/screenshot-profile.mjs rows /sdcard/DSH/tmp/shot.raw 60 1610 0 200
```

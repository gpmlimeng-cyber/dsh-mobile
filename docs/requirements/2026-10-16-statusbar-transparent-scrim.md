# 壳需求：透明态下状态栏区自绘了一层底色，造成顶部分割线

- 提出方：DS Bot 团队（Lead）
- 日期：2026-10-16 00:2x
- 目标壳：`com.deepcode.shell` 0.14.1 / code 40（`lastUpdateTime 2026-10-15 23:05:28`）
- 相关页面：DS Bot 移动端，页面指纹 `b20a0d6a`（分支 `better-sidebar`）
- 设备：主屏 1672×2364（device），CSS 608×859；`screencap -d 4639175068132267009`
- 桥：`window.dshStatusBarBridge`（`set/apply/reset/declared`，见 `docs/AGENTS/statusbar-bridge.md`）

## 现象

页面调用 `dshStatusBarBridge.set('transparent', '', 'auto')` 时，屏幕最上方 51 CSS px（= 状态栏区 = `--dsh-mobile-top-inset`）
比其正下方**暗约 13.5/255（≈5.3%）**，并在 **CSS 51 处收出一条可见的横线**（用户描述："状态栏下方绝对有东西/分割线"）。

## 证据（页面侧可复现）

1. **全宽行均值剖面**（每行取 device x=60..1610 的平均亮度，device y=0..396）：
   ```
   device 137: −4.04   139: +1.72   140: +13.56   ← 一步台阶，落在 y=140 = CSS 51
   ```
2. **A/B（证明与页面自绘无关）**：把页面的顶部遮罩 `.bt-topfade` 注入 `display:none` 后重测同一剖面——
   ```
   device y=0..396 逐行差全部 = 0.00
   ```
   ⇒ 该台阶不是页面画的（页面自己那层遮罩开关与否，读数逐行相同）。
3. **与控件无关**：顶部三块浮动控件在 device y=168..278（CSS 61..101），与 device 140 相差 28px。
4. **旁证（solid 态直接绘制）**：探针 `set('solid','rgb(241,243,241)')` 时 device y=0..130 恒为 **241**；
   另观察到壳会向页面 `<html>` 写入 inline `background: rgb(241,243,241)`。
   `set('transparent','','auto')` 时该区读数约 251~253，但仍比下方整体暗 13.5。

## 请求（按优先级）

1. **透明态下，请不要在该区域自绘 scrim/底色**（或提供关闭开关），让 WebView 内容（包含滚上去的半透明文字）直接显示到状态栏之下；
2. 若第 1 条不可行：**透明态支持一个"scrim 颜色"参数**（页面会传 `#fcfcfc`），使该层的合成结果与页面底色一致、台阶不可见；
3. 顺带：`solid` 态目前会完全遮住页面内容（第 4 条已证恒 241）。若可能，希望 solid 只作背景层，不覆盖 WebView 内容。

## 验收（页面侧可直接复核）

- 同一行均值剖面：`device y=140` 处台阶 **≤ ±2/255**；
- 状态栏区（CSS 0..51）**仍能看到页面滚上去的半透明文字**（不是被盖平）。

## 备注

- 页面侧当前使用 `set('transparent','','auto')`，位于 `ds-bot/src/client/status-bar.js`。
- 页面侧无法修正此现象：该层位于 WebView 之上，页面绘制不到。
- 若需要现场数据，DS Bot 团队可随时按上述方法在同一设备复测并回报。

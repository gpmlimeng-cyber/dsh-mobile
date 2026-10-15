package com.dsharnessmobile.shell

import android.app.Activity
import android.graphics.Color
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 状态栏与页面同色（edge-to-edge 收口）—— 用户提单 2026-10 的实现。
 *
 * ## 问题（页面侧实测，复现过）
 * 主题把 `android:statusBarColor` 写成固定色 `@color/ds_bg`（日 `#F1F3F1` / 夜 `#080A09`），
 * 而 WebView 内容区是 `rgb(248,248,248)`：**差 7/255，顶端一条肉眼可见的硬分界**。
 * 页面侧三条路都改不动它（`<meta name="theme-color">`、`--dsw-alias-bg-base`、
 * `html{background}`），而且该值随**壳的昼夜主题**变化（实测 07:15–07:34 一度是 `#070a09`）——
 * 页面永远追不上，两边注定可能不同色。
 *
 * ## 做法（提单方案 1：edge-to-edge / 状态栏透明）
 * 1. 主题里 `android:statusBarColor` 置 `@android:color/transparent`（4 个主题文件），
 *    本类再显式写一次 `TRANSPARENT`：状态栏区域由**页面自己的底色**透上来 ⇒ 天然同色，
 *    页面换肤/换主题/渐变都自动跟随，壳侧零维护。
 * 2. 兼容路径（提单方案 2 的机制）：页面若显式声明 `<meta name="theme-color">`，
 *    注入的观察器把它推给壳，壳直接按该色给状态栏着色 —— 于是「页面把 theme-color
 *    改成任意值，状态栏随之变化」这条验收也成立。未声明/声明为 transparent 时走第 1 条。
 * 3. 图标明暗按**最终生效底色**的亮度自动切（浅底→深图标 `APPEARANCE_LIGHT_STATUS_BARS`，
 *    深底→浅图标）。透明时以壳的 `@color/ds_bg`（昼夜感知）判断，页面声明后改用声明值。
 *
 * ## 契约（不要动）
 * 本类**不碰** inset 通道：`--dsh-android-system-top/bottom/left/right` 与
 * `--dsh-android-ime-bottom` 的取值路径仍在 `MainActivity.pushWebInsets`（值语义不变）。
 * 透明状态栏不改变 `bars.top`（状态栏仍占位），页面布局依赖的值原样。
 */
internal object StatusBarChrome {
  private const val TAG = "dsh-statusbar"

  /** 页面最近一次声明的 theme-color（空串/未声明 = 走透明透出）。 */
  @Volatile
  private var pageDeclared: String? = null

  /**
   * 幂等观察器：读 `<meta name="theme-color">`，变化即回调壳。
   * 覆盖三种变化源——meta 增删改、根元素 style/class/主题属性变化。重复注入直接返回。
   */
  val WATCH_SCRIPT: String = """
    (function(){
      if (window.__dshStatusBarWatched) return 'already';
      window.__dshStatusBarWatched = true;
      var applied = null;
      function read(){
        var m = document.querySelector('meta[name="theme-color"]');
        return m ? (m.getAttribute('content') || '') : '';
      }
      function push(force){
        var c = read();
        if (!force && c === applied) return;
        applied = c;
        try { window.dshStatusBarBridge && window.dshStatusBarBridge.apply(c || ''); } catch (e) {}
      }
      try {
        new MutationObserver(function(){ push(false); }).observe(
          document.head || document.documentElement,
          { childList: true, subtree: true, attributes: true, attributeFilter: ['content','name'] });
      } catch (e) {}
      try {
        new MutationObserver(function(){ push(false); }).observe(
          document.documentElement,
          { attributes: true, attributeFilter: ['style','class','data-theme','data-dsw-theme'] });
      } catch (e) {}
      push(true);
      return 'ok';
    })();
  """.trimIndent()

  /** 页面注入的桥：`window.dshStatusBarBridge.apply('<css color>')`（JS 线程回调）。 */
  class Bridge(private val activity: Activity) {
    @JavascriptInterface
    fun apply(cssColor: String) {
      pageDeclared = cssColor
      activity.runOnUiThread { applyNow(activity) }
    }
  }

  /** onCreate / 沉浸式切换 / onPageFinished 之后重放（隐藏或显示系统栏会重置窗口外观）。 */
  fun reapply(activity: Activity) {
    try {
      activity.runOnUiThread { applyNow(activity) }
    } catch (t: Throwable) {
      Log.w(TAG, "reapply failed: " + t.message)
    }
  }

  /** 把当前应生效的底色写到窗口，并据此切图标明暗。主线程调用。 */
  @Suppress("DEPRECATION")
  fun applyNow(activity: Activity) {
    try {
      val window = activity.window
      val declared = parseCssColor(pageDeclared)
      // 未声明 / 显式透明 ⇒ 透明状态栏（提单方案 1：页面底色透上来）
      val effective = declared ?: Color.TRANSPARENT
      window.statusBarColor = effective
      val lightIcons = shouldUseLightIcons(activity, effective)
      WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars = lightIcons
      Log.i(
        TAG,
        "statusBar effective=#" + String.format("%08X", effective) +
          " declared=" + (pageDeclared ?: "(none)") + " lightIcons=" + lightIcons,
      )
    } catch (t: Throwable) {
      Log.w(TAG, "applyNow failed: " + t.message)
    }
  }

  /** 在 WebView 里安装观察器（onPageFinished / onResume 调用；脚本自身幂等）。 */
  fun installWatcher(view: WebView) {
    try {
      view.evaluateJavascript(WATCH_SCRIPT, null)
    } catch (_: Exception) {
      // 页面未就绪：onPageFinished 会再装一次。
    }
  }

  /**
   * 图标明暗：`isAppearanceLightStatusBars = true` 表示**深色图标**（用于浅底）。
   * 底色透明时状态栏下是页面/窗口底色，退到壳的 `@color/ds_bg`（昼夜感知）判断。
   */
  private fun shouldUseLightIcons(activity: Activity, effective: Int): Boolean {
    val sample = if (effective == Color.TRANSPARENT) {
      try {
        ContextCompat.getColor(activity, R.color.ds_bg)
      } catch (_: Throwable) {
        Color.WHITE
      }
    } else {
      effective
    }
    return Color.luminance(sample) > 0.45
  }

  /**
   * 解析页面给的 CSS 颜色。支持 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` /
   * `rgb(r,g,b)` / `rgba(r,g,b,a)` / `transparent`。
   * @return 不透明色（ARGB）；未声明、无法解析、或 alpha=0 时返回 null（= 透明透出）。
   */
  internal fun parseCssColor(raw: String?): Int? {
    val s = raw?.trim()?.lowercase() ?: return null
    if (s.isEmpty() || s == "transparent" || s == "initial" || s == "inherit" || s == "unset") return null
    if (s.startsWith("#")) {
      val h = s.substring(1)
      if (h.length != 3 && h.length != 4 && h.length != 6 && h.length != 8) return null
      if (!h.all { it.isDigit() || it in 'a'..'f' }) return null
      fun hex(part: String): Int = part.toInt(16)
      val r: Int; val g: Int; val b: Int; val a: Int
      when (h.length) {
        3, 4 -> {
          r = hex("" + h[0] + h[0]); g = hex("" + h[1] + h[1]); b = hex("" + h[2] + h[2])
          a = if (h.length == 4) hex("" + h[3] + h[3]) else 255
        }
        else -> {
          r = hex(h.substring(0, 2)); g = hex(h.substring(2, 4)); b = hex(h.substring(4, 6))
          a = if (h.length == 8) hex(h.substring(6, 8)) else 255
        }
      }
      if (a == 0) return null
      return Color.argb(a, r, g, b)
    }
    val m = Regex("^rgba?\\(([^)]*)\\)$").find(s) ?: return null
    val parts = m.groupValues[1].split(",", " ", "/").map { it.trim() }.filter { it.isNotEmpty() }
    if (parts.size < 3) return null
    fun channel(v: String): Int {
      if (v.endsWith("%")) {
        val f = v.dropLast(1).toFloatOrNull() ?: return -1
        return Math.round(f * 2.55f)
      }
      return v.toFloatOrNull()?.toInt() ?: -1
    }
    val r = channel(parts[0]); val g = channel(parts[1]); val b = channel(parts[2])
    if (r < 0 || g < 0 || b < 0) return null
    val a = if (parts.size >= 4) {
      val raw4 = parts[3]
      val av = raw4.toFloatOrNull() ?: return null
      (if (raw4.endsWith("%")) av * 2.55f else av * 255f).toInt()
    } else 255
    if (a == 0) return null
    return Color.argb(a.coerceIn(0, 255), r.coerceIn(0, 255), g.coerceIn(0, 255), b.coerceIn(0, 255))
  }
}

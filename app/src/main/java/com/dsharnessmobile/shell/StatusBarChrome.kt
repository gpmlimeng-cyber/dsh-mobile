package com.dsharnessmobile.shell

import android.app.Activity
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * 状态栏：透明/半透明 + **页面可调**（用户提单 2026-10 第二条）。
 *
 * ## 协议（页面侧调用；幂等，可重复调）
 * ```js
 * // 主入口：mode = 'transparent' | 'solid'；color 仅 solid 用（任意 CSS 颜色，含 rgba 半透明）；
 * // appearance = 'auto' | 'light' | 'dark'（light = 浅色图标[深底]，dark = 深色图标[浅底]，'' = auto）
 * window.dshStatusBarBridge.set('transparent', '', 'auto')
 * window.dshStatusBarBridge.set('solid', 'rgba(248,248,248,0.8)', 'dark')
 *
 * // 复位：清除页面显式设置 → 回到「跟随 <meta name="theme-color">，未声明则透明」
 * window.dshStatusBarBridge.reset()
 *
 * // 兼容旧入口（等价 set('solid', color, '')；空串 = transparent）
 * window.dshStatusBarBridge.apply('#00ff00')
 * ```
 * 页面**不调用**时的默认档（无需任何页面配合）：状态栏**透明**，内容直接透出；
 * 若页面声明了 `<meta name="theme-color">`，壳跟随它（观察器在页面变化时自动重推）。
 *
 * 优先级：页面显式 `set()` > `<meta name="theme-color">` > 透明。
 *
 * ## 契约（不要动）
 * 本类**不碰** inset 通道：`--dsh-android-system-top/bottom/left/right` 与
 * `--dsh-android-ime-bottom` 的取值路径仍在 `MainActivity.pushWebInsets`（值语义不变）。
 * 透明状态栏不改变 `bars.top`（状态栏仍占位），页面布局依赖的值原样 —— 页面侧仍能据此
 * 在状态栏下方自绘磨砂层。
 */
internal object StatusBarChrome {
  private const val TAG = "dsh-statusbar"

  // ── 状态（JS 线程写、UI 线程读，均 volatile）──────────────────────────────
  /** 页面显式 mode：`transparent` | `solid` | null（未指定 → 跟随 meta）。 */
  @Volatile private var explicitMode: String? = null

  /** 页面显式颜色（mode=solid 时用；任意 CSS 颜色，含 rgba 半透明）。 */
  @Volatile private var explicitColor: String = ""

  /** 页面显式图标明暗：`light` | `dark` | `auto`/空（按亮度自动）。 */
  @Volatile private var explicitAppearance: String = ""

  /** 页面最近声明的 `<meta name="theme-color">`（空 = 未声明 → 透明）。 */
  @Volatile private var pageDeclared: String = ""

  /**
   * 幂等观察器：读 `<meta name="theme-color">`，变化即回调壳的 `declared()`。
   * 只上报「声明值」，**不覆盖**页面显式设置（优先级见类注释）。
   */
  val WATCH_SCRIPT: String = """
    (function(){
      if (window.__dshStatusBarWatched) return 'already';
      window.__dshStatusBarWatched = true;
      var sent = null;
      function read(){
        var m = document.querySelector('meta[name="theme-color"]');
        return m ? (m.getAttribute('content') || '') : '';
      }
      function push(force){
        var c = read();
        if (!force && c === sent) return;
        sent = c;
        try { window.dshStatusBarBridge && window.dshStatusBarBridge.declared(c || ''); } catch (e) {}
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

  /** 页面注入的桥（`window.dshStatusBarBridge`）。 */
  class Bridge(private val activity: Activity) {

    /** 主入口：显式设置模式/颜色/图标明暗。任意参数可为空串（= 该项不指定）。 */
    @JavascriptInterface
    fun set(mode: String, color: String, appearance: String) {
      val m = mode.trim().lowercase()
      explicitMode = when (m) {
        "transparent", "solid" -> m
        else -> null
      }
      explicitColor = color.trim()
      explicitAppearance = appearance.trim().lowercase()
      reapply(activity)
    }

    /** 复位：清除页面显式设置，回到「跟随 meta / 透明」。 */
    @JavascriptInterface
    fun reset() {
      explicitMode = null
      explicitColor = ""
      explicitAppearance = ""
      reapply(activity)
    }

    /** 页面 `<meta name="theme-color">` 声明（观察器上报；不覆盖显式设置）。 */
    @JavascriptInterface
    fun declared(cssColor: String) {
      pageDeclared = cssColor.trim()
      reapply(activity)
    }

    /** 兼容旧入口：等价 `set('solid', color, '')`；空串 = `set('transparent','','')`。 */
    @JavascriptInterface
    fun apply(cssColor: String) {
      val c = cssColor.trim()
      if (c.isEmpty()) set("transparent", "", "") else set("solid", c, "")
    }
  }

  /** onCreate / 沉浸式切换 / 页面变化之后重放（隐藏或显示系统栏会重置窗口外观）。 */
  fun reapply(activity: Activity) {
    try {
      activity.runOnUiThread { applyNow(activity) }
    } catch (t: Throwable) {
      Log.w(TAG, "reapply failed: " + t.message)
    }
  }

  /** 把当前应生效的底色写到窗口并切图标明暗。主线程调用。 */
  @Suppress("DEPRECATION")
  fun applyNow(activity: Activity) {
    try {
      val window = activity.window
      val effective = decideColor(explicitMode, explicitColor, pageDeclared)
      window.statusBarColor = effective ?: TRANSPARENT
      val lightIcons = decideLightIcons(
        explicitAppearance,
        effective,
        fallbackSample(activity),
      )
      WindowInsetsControllerCompat(window, window.decorView).isAppearanceLightStatusBars = lightIcons
      Log.i(
        TAG,
        "apply mode=" + (explicitMode ?: "(meta)") +
          " color=" + argbHex(effective ?: TRANSPARENT) +
          " declared=" + (pageDeclared.ifEmpty { "(none)" }) +
          " appearance=" + (explicitAppearance.ifEmpty { "auto" }) +
          " lightIcons=" + lightIcons,
      )
    } catch (t: Throwable) {
      Log.w(TAG, "applyNow failed: " + t.message)
    }
  }

  /** 在 WebView 里安装观察器（onPageFinished 调用；脚本自身幂等）。 */
  fun installWatcher(view: WebView) {
    try {
      view.evaluateJavascript(WATCH_SCRIPT, null)
    } catch (_: Exception) {
      // 页面未就绪：onPageFinished 会再装一次。
    }
  }

  // ── 决策与解析（纯函数：JVM 单测直接覆盖，不碰 android.graphics）────────────

  /** 透明（0x00000000）。Android 的 `Color.TRANSPARENT` 值，避免单测依赖 android.graphics。 */
  internal const val TRANSPARENT: Int = 0

  /**
   * 决策最终底色。
   * @return 不透明/半透明 ARGB；null = 透明。
   */
  internal fun decideColor(mode: String?, color: String, declared: String): Int? {
    when (mode?.lowercase()) {
      "transparent" -> return null
      "solid" -> return parseCssColor(color) ?: parseCssColor(declared)
    }
    return parseCssColor(declared)
  }

  /**
   * 决策图标明暗：`true` = **深色图标**（用于浅底），`false` = 浅色图标（用于深底）。
   * `appearance` 显式给 light/dark 时优先；其余按最终底色的相对亮度自动。
   * @param effective 最终底色（null = 透明，此时用 sample 兜底）。
   * @param sample 透明时的兜底采样色（页面/窗口底色）。
   */
  internal fun decideLightIcons(appearance: String, effective: Int?, sample: Int): Boolean {
    when (appearance.lowercase()) {
      "dark" -> return true
      "light" -> return false
    }
    return relativeLuminance(effective ?: sample) > 0.45
  }

  /** 相对亮度（WCAG，0..1）。 */
  internal fun relativeLuminance(color: Int): Double {
    fun lin(c: Int): Double {
      val s = c / 255.0
      return if (s <= 0.03928) s / 12.92 else Math.pow((s + 0.055) / 1.055, 2.4)
    }
    val r = lin((color shr 16) and 0xFF)
    val g = lin((color shr 8) and 0xFF)
    val b = lin(color and 0xFF)
    return 0.2126 * r + 0.7152 * g + 0.0722 * b
  }

  internal fun argbHex(color: Int): String = String.format("#%08X", color)

  /** 透明时的兜底采样：壳的 `@color/ds_bg`（昼夜感知）。 */
  private fun fallbackSample(activity: Activity): Int = try {
    ContextCompat.getColor(activity, R.color.ds_bg)
  } catch (_: Throwable) {
    WHITE
  }

  internal const val WHITE: Int = 0xFFFFFFFF.toInt()

  /**
   * 解析页面给的 CSS 颜色。支持 `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` /
   * `rgb(r,g,b)` / `rgb(r g b)` / `rgb(r%,g%,b%)` / `rgba(...,a)` / `transparent`。
   * @return ARGB（alpha 可为 0..255，支持半透明）；未声明、无法解析、或完全透明时返回 null。
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
      return argb(a, r, g, b)
    }
    val m = Regex("^rgba?\\(([^)]*)\\)$").find(s) ?: return null
    val parts = m.groupValues[1]
      .replace("/", " ")
      .split(",", " ")
      .map { it.trim() }
      .filter { it.isNotEmpty() }
    if (parts.size < 3) return null
    fun channel(v: String): Int {
      if (v.endsWith("%")) {
        val f = v.dropLast(1).toDoubleOrNull() ?: return -1
        return Math.round(f * 2.55).toInt()
      }
      return v.toDoubleOrNull()?.toInt() ?: -1
    }
    val r = channel(parts[0]); val g = channel(parts[1]); val b = channel(parts[2])
    if (r < 0 || g < 0 || b < 0) return null
    val a = if (parts.size >= 4) {
      val raw4 = parts[3]
      // 注意顺序：**先剥 `%` 再解析**（`"80%".toDoubleOrNull()` = null——单测抓到的真 bug，
      // 页面用现代语法 `rgb(248 248 248 / 80%)` 时必踩）。
      val isPercent = raw4.endsWith("%")
      val num = (if (isPercent) raw4.dropLast(1) else raw4).toDoubleOrNull() ?: return null
      val scaled = if (isPercent) num * 2.55 else num * 255.0
      scaled.toInt().coerceIn(0, 255)
    } else 255
    if (a == 0) return null
    return argb(a, r.coerceIn(0, 255), g.coerceIn(0, 255), b.coerceIn(0, 255))
  }

  /** 纯函数版 `Color.argb`（避免单测依赖 android.graphics）。 */
  internal fun argb(a: Int, r: Int, g: Int, b: Int): Int =
    ((a and 0xFF) shl 24) or ((r and 0xFF) shl 16) or ((g and 0xFF) shl 8) or (b and 0xFF)
}

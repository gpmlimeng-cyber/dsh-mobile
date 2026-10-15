package com.dsharnessmobile.shell

import com.dsharnessmobile.shell.StatusBarChrome.decideColor
import com.dsharnessmobile.shell.StatusBarChrome.decideLightIcons
import com.dsharnessmobile.shell.StatusBarChrome.parseCssColor
import com.dsharnessmobile.shell.StatusBarChrome.relativeLuminance
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 状态栏桥的解析与决策回归（2026-10 第二条提单）。
 *
 * 为什么单测这一层：桥的**调用只可能来自页面 JS**，设备侧无法从外部触发——
 * 若不做纯函数级的判定，就只能等页面接完才第一次验证「solid 任意色 / appearance 指定 /
 * 优先级 > meta」这些语义。这里把语义钉死在 JVM 单测上：
 *
 *  - `parseCssColor`：页面可能给任何 CSS 颜色（含 `rgba(...,.8)` 这种半透明），
 *    解析失败必须回落到「跟随 meta / 透明」而不是画出错误颜色；
 *  - `decideColor`：优先级 = 页面显式 set() > `<meta name="theme-color">` > 透明；
 *  - `decideLightIcons`：`dark` = 深色图标（浅底）/ `light` = 浅色图标（深底）/
 *    `auto` 按相对亮度（阈值 0.45）。
 *
 * 注意：本测试**不碰** `android.graphics.Color`（JVM 单测里是 stub），解析/亮度/argb
 * 全是本类内的纯 Kotlin 实现——这也是把它们写成 internal 纯函数的原因。
 */
class StatusBarChromeTest {

  // ── parseCssColor ─────────────────────────────────────────────────────────

  @Test
  fun parsesHexForms() {
    assertEquals(0xFFF8F8F8.toInt(), parseCssColor("#f8f8f8"))
    assertEquals(0xFFFFFFFF.toInt(), parseCssColor("#fff"))
    assertEquals(0xFF00FF00.toInt(), parseCssColor("#00FF00"))
    // #rgba / #rrggbbaa：保留 alpha（半透明是提单明确要支持的一档）
    assertEquals(0x88FF0000.toInt(), parseCssColor("#f00" + "8"))
    assertEquals(0x8000FF00.toInt(), parseCssColor("#00ff0080"))
    assertEquals(0xFF123456.toInt(), parseCssColor("  #123456  "))
  }

  @Test
  fun parsesFunctionalForms() {
    assertEquals(0xFFF8F8F8.toInt(), parseCssColor("rgb(248,248,248)"))
    assertEquals(0xFFF8F8F8.toInt(), parseCssColor("rgb(248 248 248)"))
    assertEquals(0xFF00FF00.toInt(), parseCssColor("rgba(0, 255, 0, 1)"))
    // rgba(...,0.8) → alpha = 204
    assertEquals(0xCCF8F8F8.toInt(), parseCssColor("rgba(248,248,248,0.8)"))
    // 现代语法 rgb(248 248 248 / 80%)
    assertEquals(0xCCF8F8F8.toInt(), parseCssColor("rgb(248 248 248 / 80%)"))
    // 百分比通道
    assertEquals(0xFFFFFFFF.toInt(), parseCssColor("rgb(100%,100%,100%)"))
  }

  @Test
  fun rejectsUnusableValuesAsTransparent() {
    assertNull(parseCssColor(null))
    assertNull(parseCssColor(""))
    assertNull(parseCssColor("   "))
    assertNull(parseCssColor("transparent"))
    assertNull(parseCssColor("initial"))
    assertNull(parseCssColor("#00000000"))   // 完全透明 = 透明档
    assertNull(parseCssColor("rgba(0,0,0,0)"))
    assertNull(parseCssColor("#12345"))       // 长度非法
    assertNull(parseCssColor("#gggggg"))      // 非十六进制
    assertNull(parseCssColor("hsl(1,2%,3%)")) // 不支持的语法：回落透明而非乱画
  }

  // ── decideColor：优先级 ────────────────────────────────────────────────────

  @Test
  fun explicitTransparentWinsOverDeclared() {
    assertNull(decideColor("transparent", "#00ff00", "#f8f8f8"))
  }

  @Test
  fun explicitSolidUsesPageColor() {
    assertEquals(0xFF00FF00.toInt(), decideColor("solid", "#00ff00", "#f8f8f8"))
  }

  @Test
  fun solidFallsBackToDeclaredWhenColorUnusable() {
    assertEquals(0xFFF8F8F8.toInt(), decideColor("solid", "not-a-color", "#f8f8f8"))
  }

  @Test
  fun noExplicitModeFollowsMetaThenTransparent() {
    assertEquals(0xFFF8F8F8.toInt(), decideColor(null, "", "#f8f8f8"))
    assertNull(decideColor(null, "", ""))
    assertNull(decideColor("", "", ""))
    // 未知 mode 视同未指定（不静默变成某档）
    assertEquals(0xFFF8F8F8.toInt(), decideColor("weird", "#00ff00", "#f8f8f8"))
  }

  // ── decideLightIcons ──────────────────────────────────────────────────────

  @Test
  fun autoPicksIconsFromLuminance() {
    val white = 0xFFFFFFFF.toInt()
    val black = 0xFF000000.toInt()
    assertTrue("浅底应给深色图标", decideLightIcons("auto", white, black))
    assertFalse("深底应给浅色图标", decideLightIcons("auto", black, white))
    assertTrue("空 appearance 等同 auto", decideLightIcons("", white, black))
  }

  @Test
  fun transparentUsesFallbackSample() {
    val white = 0xFFFFFFFF.toInt()
    val black = 0xFF000000.toInt()
    assertTrue(decideLightIcons("auto", null, white))
    assertFalse(decideLightIcons("auto", null, black))
  }

  @Test
  fun explicitAppearanceOverridesLuminance() {
    val white = 0xFFFFFFFF.toInt()
    assertFalse("appearance=light → 浅色图标（深底场景），无视浅底色", decideLightIcons("light", white, white))
    assertTrue("appearance=dark → 深色图标（浅底场景）", decideLightIcons("dark", 0xFF000000.toInt(), 0xFF000000.toInt()))
    assertTrue(decideLightIcons("DARK", 0xFF000000.toInt(), 0xFF000000.toInt()))
  }

  @Test
  fun semiTransparentStillJudgedByItsOwnRgb() {
    // rgba(248,248,248,.8)：亮底 → 深色图标（半透明不改判据色本身）
    assertTrue(decideLightIcons("auto", parseCssColor("rgba(248,248,248,0.8)"), 0xFF000000.toInt()))
  }

  // ── 亮度与 argb ───────────────────────────────────────────────────────────

  @Test
  fun luminanceEndpoints() {
    assertEquals(1.0, relativeLuminance(0xFFFFFFFF.toInt()), 0.001)
    assertEquals(0.0, relativeLuminance(0xFF000000.toInt()), 0.001)
    assertTrue(relativeLuminance(0xFFF1F3F1.toInt()) > 0.45)
  }

  @Test
  fun argbPacksChannels() {
    assertEquals(0xCC112233.toInt(), StatusBarChrome.argb(0xCC, 0x11, 0x22, 0x33))
  }
}

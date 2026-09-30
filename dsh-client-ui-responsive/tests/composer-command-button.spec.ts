// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ComposerCommandButtonEnhancer, composerToolbarButtonOf } from '../src/client/composer-command-button.ts'
import { COMPOSER_MENU_CSS } from '../src/client/composer-menu.css.ts'
import { ATTACHMENT_PICKER_MENU_CSS } from '../src/client/attachment-picker-menu.css.ts'

let enhancer: ComposerCommandButtonEnhancer
let plus: HTMLButtonElement
let model: HTMLButtonElement
let editor: HTMLElement

/** Composer card with the upstream `+` (aria-haspopup=listbox) and the model menu trigger. */
function mountComposer(): void {
  const card = document.createElement('div')
  card.setAttribute('data-composer-card', '')
  plus = document.createElement('button')
  plus.type = 'button'
  plus.setAttribute('aria-haspopup', 'listbox')
  plus.setAttribute('aria-expanded', 'false')
  plus.textContent = 'plus'
  model = document.createElement('button')
  model.type = 'button'
  model.setAttribute('aria-haspopup', 'menu')
  model.textContent = 'model'
  editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  editor.tabIndex = 0
  card.append(plus, model, editor)
  document.body.append(card)
}

/**
 * Tap the composer surface (the editor / card body) — the gesture that means "I want to type".
 *
 * Editor focus only counts as user-initiated within a window of such a gesture, mirroring a phone:
 * a focus nobody asked for is upstream's mount-time autofocus and is undone.
 */
function tapComposerSurface(): void {
  editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
}

/** Tap the `+` the way a phone does: pointerdown, then the mouse/click pair. */
function tapCommandButton(): void {
  plus.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
  plus.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  plus.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

beforeEach(() => {
  mountComposer()
  enhancer = new ComposerCommandButtonEnhancer()
  enhancer.attach()
})

afterEach(() => {
  enhancer.detach()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

describe('composerToolbarButtonOf', () => {
  it('resolves the toolbar button from a nested target', () => {
    const glyph = document.createElement('span')
    plus.append(glyph)
    expect(composerToolbarButtonOf(glyph)).toBe(plus)
  })

  it('covers every composer toolbar button, not just the listbox one', () => {
    // 真机形态：dev 版里最左那个「+」就是隐藏文件输入的所有者（我方附件菜单挂在它上面），
    // 它未必带 aria-haspopup——按 aria 收窄会漏掉用户真正点的那颗。
    const fileOwner = document.createElement('button')
    fileOwner.type = 'button'
    document.querySelector('[data-composer-card]')!.append(fileOwner)
    expect(composerToolbarButtonOf(fileOwner)).toBe(fileOwner)
    expect(composerToolbarButtonOf(model)).toBe(model)
  })

  it('ignores buttons outside the composer card and non-elements', () => {
    const outside = document.createElement('button')
    document.body.append(outside)
    expect(composerToolbarButtonOf(outside)).toBeNull()
    expect(composerToolbarButtonOf(document)).toBeNull()
    expect(composerToolbarButtonOf(null)).toBeNull()
  })

  it('ignores a disabled toolbar button', () => {
    plus.disabled = true
    expect(composerToolbarButtonOf(plus)).toBeNull()
  })
})

describe('ComposerCommandButtonEnhancer', () => {
  it('keeps the soft keyboard down when `+` is tapped from an unfocused composer', () => {
    const openMenu = vi.fn()
    // 0.1.5: onMouseDown keepFocus() focuses the editor.
    plus.addEventListener('mousedown', () => { editor.focus() })
    // 0.1.7: the click focuses the editor again before toggling the launcher.
    plus.addEventListener('click', () => { editor.focus(); openMenu() })

    tapCommandButton()

    expect(editor).not.toBe(document.activeElement)
    expect(openMenu).toHaveBeenCalledTimes(1)
  })

  it('leaves an already focused editor alone (the user is typing to filter)', () => {
    plus.addEventListener('mousedown', () => { editor.focus() })
    plus.addEventListener('click', () => { editor.focus() })
    tapComposerSurface()
    editor.focus()

    tapCommandButton()

    expect(document.activeElement).toBe(editor)
  })

  it('does not count a gesture outside the composer card as "I want to type"', () => {
    const outside = document.createElement('button')
    const focusEditor = vi.fn(() => { editor.focus() })
    outside.addEventListener('click', focusEditor)
    document.body.append(outside)

    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    // 卡片外的手势不会开启「用户要输入」窗口，因此这样的聚焦仍被当作程序化聚焦撤销。
    expect(focusEditor).toHaveBeenCalledTimes(1)
    expect(editor).not.toBe(document.activeElement)
  })

  it('releases on the next non-toolbar gesture (attachment menu claims the click first)', () => {
    // 附件菜单在 document 捕获阶段先注册并 stopImmediatePropagation，本增强器的 click 监听收不到，
    // 因此抑制必须在「下一次非工具栏 pointerdown」立刻解除，否则用户随后点输入框会像点不动。
    plus.addEventListener('click', () => { editor.focus() })
    tapCommandButton()

    editor.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    editor.focus()

    expect(document.activeElement).toBe(editor)
  })

  it('releases the suppression after the gesture (a later deliberate focus sticks)', async () => {
    plus.addEventListener('click', () => { editor.focus() })
    tapCommandButton()
    expect(editor).not.toBe(document.activeElement)

    await new Promise((resolve) => { window.setTimeout(resolve, 0) })
    editor.focus()

    expect(document.activeElement).toBe(editor)
  })
})

describe('opaque menu surfaces on the phone form', () => {
  it('overrides the translucent menu tokens instead of matching upstream class names', () => {
    // 0.1.7: --dsw-menu-surface-fill is #f8f9fa94 / #43454a73 (58% / 45% opaque) and the blur token
    // is blur(40px) saturate(150%); every menu surface paints that pair (primitives MenuSurface).
    expect(COMPOSER_MENU_CSS).toContain('--dsw-menu-surface-fill: var(--dsw-alias-bg-layer-3)')
    expect(COMPOSER_MENU_CSS).toContain('--dsw-menu-backdrop-filter: none')
    // 作用域只落在弹层上：composer 卡片自己也是这个 token 的消费者，不该被顺手改观感。
    expect(COMPOSER_MENU_CSS).toContain("html[data-dsh-mobile-form] [role='menu']")
    expect(COMPOSER_MENU_CSS).toContain("html[data-dsh-mobile-form] [role='listbox']")
    expect(COMPOSER_MENU_CSS).toContain('html[data-dsh-mobile-form] [data-dsh-attachment-picker-menu]')
  })

  it('paints the attachment menu on the opaque elevation surface', () => {
    // 真机截图：该菜单能看见底下的输入框占位文字（--dsw-specific-menu 在 0.1.7 只有 58% / 45%）。
    expect(ATTACHMENT_PICKER_MENU_CSS).toContain('background: var(--dsw-alias-bg-layer-3, var(--dsw-specific-menu))')
  })
})

describe('settling window discipline', () => {
  it('keeps the window of the tap in flight (no stale timer releases it mid-gesture)', () => {
    vi.useFakeTimers()
    try {
      plus.addEventListener('click', () => { editor.focus() })
      // 手势 1：此后 1200ms 的窗口开始计时。
      plus.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      plus.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      plus.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      // 1000ms 后手势 2（真机上是「连点两下」的节奏）：旧实现里手势 1 的定时器会在
      // 200ms 后把抑制解掉，于是手势 2 里再来的聚焦就不再被撤销——这就是「第一次弹键盘」的机制。
      vi.advanceTimersByTime(1000)
      plus.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
      vi.advanceTimersByTime(300)
      editor.focus()
      expect(editor).not.toBe(document.activeElement)
    } finally {
      vi.useRealTimers()
    }
  })

  it('undoes editor focus while the attachment menu is open, outside any tap window', () => {
    const menu = document.createElement('div')
    menu.setAttribute('data-dsh-attachment-picker-menu', '')
    document.body.append(menu)

    editor.focus()

    expect(editor).not.toBe(document.activeElement)
  })

  it('lets the editor keep focus once the attachment menu is closed', () => {
    tapComposerSurface()
    editor.focus()

    expect(document.activeElement).toBe(editor)
  })
})

describe('mousedown interception (prevent the focus, do not undo it)', () => {
  it('keeps upstream keepFocus from running when the composer is not focused', () => {
    // 真机轨迹：聚焦每次都被同步撤销，键盘照样弹——Chromium 的「显示软输入」是异步派发的，
    // focus→同任务 blur 取消不掉已排队的请求。所以必须让聚焦根本不发生。
    const upstreamKeepFocus = vi.fn()
    const openMenu = vi.fn()
    plus.addEventListener('mousedown', upstreamKeepFocus)
    plus.addEventListener('click', openMenu)

    tapCommandButton()

    expect(upstreamKeepFocus).not.toHaveBeenCalled()
    expect(openMenu).toHaveBeenCalledTimes(1)
    expect(editor).not.toBe(document.activeElement)
  })

  it('leaves the mousedown alone while the user is typing', () => {
    const upstreamKeepFocus = vi.fn()
    plus.addEventListener('mousedown', upstreamKeepFocus)
    tapComposerSurface()
    editor.focus()

    plus.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    plus.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    expect(upstreamKeepFocus).toHaveBeenCalledTimes(1)
  })

  it('does not intercept a mousedown outside the composer card', () => {
    const outside = document.createElement('button')
    const listener = vi.fn()
    outside.addEventListener('mousedown', listener)
    document.body.append(outside)

    outside.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))

    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('programmatic autofocus (the real first-tap keyboard)', () => {
  it('undoes an editor focus that no composer gesture asked for', () => {
    // 真机轨迹：上游在页面加载时 focusDraftEditor；Android 要等用户手势才把 IME 请求放出去，
    // 于是键盘在「第一次点任何东西」时弹出。非用户手势的聚焦必须当场撤掉。
    vi.spyOn(Date, 'now').mockReturnValue(1_000_000)

    editor.focus()

    expect(editor).not.toBe(document.activeElement)
  })

  it('keeps an editor focus the user asked for by tapping the composer', () => {
    const now = vi.spyOn(Date, 'now')
    now.mockReturnValue(2_000_000)
    tapComposerSurface()
    now.mockReturnValue(2_000_100)

    editor.focus()

    expect(document.activeElement).toBe(editor)
  })
})

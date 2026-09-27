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
    editor.focus()

    tapCommandButton()

    expect(document.activeElement).toBe(editor)
  })

  it('does not suppress a gesture outside the composer card', () => {
    const outside = document.createElement('button')
    outside.addEventListener('click', () => { editor.focus() })
    document.body.append(outside)

    outside.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }))
    outside.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(document.activeElement).toBe(editor)
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
    editor.focus()

    expect(document.activeElement).toBe(editor)
  })
})

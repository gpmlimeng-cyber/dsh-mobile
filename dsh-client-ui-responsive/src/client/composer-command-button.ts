/**
 * Composer toolbar-button keyboard guard.
 *
 * Upstream wires the composer's toolbar buttons so that pressing one hands focus back to the draft
 * editor: `onMouseDown: keepFocus` (`event.preventDefault()` plus
 * `editor.getRootElement().focus()`) and, from 0.1.7 on, an `onClick` that focuses the editor again
 * (`focusDraftEditor(editor, revealSelection)`) before toggling the command launcher.
 *
 * That is desktop semantics: while a menu is open you keep typing to filter it, so the editor keeps
 * focus. On Android the same focus raises the soft keyboard, so tapping the composer's leftmost `+`
 * covers half the screen with an IME the user never asked for (reported on the phone form).
 *
 * Fix: while the tap is not a deliberate gesture into the editor, undo the editor focus this
 * toolbar tap hands over — synchronously inside the `focusin` the focus call fires, so the IME
 * never becomes visible. Two conditions undo it (see {@link ComposerCommandButtonEnhancer.onFocusIn}):
 * the tap's suppression window, and "our attachment-source menu is open" (a source chooser needs no
 * editor focus, and upstream can focus the editor *after* the tap through a state-update effect —
 * the first-tap-only keyboard the phone report described, confirmed by an on-device trace where the
 * late focus arrived while the menu was already open).
 *
 * Why not claim the click the way the attachment menu does: the menus are upstream React state, so
 * re-implementing their open would fork the feature. This guard only edits focus, which is the part
 * the phone form disagrees with.
 */

/** Toolbar buttons of the composer card. */
const TRIGGER_SELECTOR = "[data-composer-card] button"

/** The draft editor root (rich-text, hence contenteditable rather than input). */
const EDITOR_SELECTOR = '[data-composer-card] [contenteditable="true"]'

/** Our own attachment-source menu (ported to <body>, hence not inside the composer card). */
const ATTACHMENT_MENU_SELECTOR = '[data-dsh-attachment-picker-menu]'

/**
 * How long one toolbar tap keeps undoing editor focus.
 *
 * Not "the gesture" but "the gesture's settling window": upstream's late focus (a state-update
 * effect calling `focusDraftEditor`) can land after the click. Any gesture that is not a composer
 * toolbar button ends the window earlier, so a deliberate tap into the editor is never swallowed.
 */
const SUPPRESS_MAX_MS = 1200

/**
 * The composer toolbar button a pointer/click event belongs to.
 *
 * Deliberately not narrowed to `aria-haspopup='listbox'`: the phone report is about the leftmost
 * `+`, and that button's role differs per engine (0.1.7 renders it as the command trigger *and* as
 * the owner of the hidden file input our attachment menu claims — the on-device screenshot shows
 * our own upload menu opening from it). What the shapes share is "a toolbar button that focuses the
 * draft editor as a side effect".
 *
 * @param target - event target.
 * @returns the button, or null when the event is not on a composer toolbar button.
 */
export function composerToolbarButtonOf(target: EventTarget | null): HTMLButtonElement | null {
  if (!(target instanceof Element)) return null
  const button = target.closest<HTMLButtonElement>(TRIGGER_SELECTOR)
  return button === null || button.disabled ? null : button
}

/** The composer's draft editor root, if the page has one. */
function composerEditor(): HTMLElement | null {
  return document.querySelector<HTMLElement>(EDITOR_SELECTOR)
}

/** Whether the draft editor currently owns focus. */
function editorHasFocus(editor: HTMLElement | null): boolean {
  if (editor === null) return false
  const active = document.activeElement
  return active !== null && (active === editor || editor.contains(active))
}

/** Whether our attachment-source menu is open. */
function attachmentMenuOpen(): boolean {
  return document.querySelector(ATTACHMENT_MENU_SELECTOR) !== null
}

/** Keeps the soft keyboard down when a toolbar button is tapped from an unfocused composer. */
export class ComposerCommandButtonEnhancer {
  /** Editor owned focus before this gesture started. */
  private editorFocusedBefore = false
  /** Undo editor focus for the remainder of this gesture (and its settling window). */
  private suppress = false
  /**
   * The single outstanding "release suppression" timer.
   *
   * Exactly one, always cleared before the next one is scheduled: a leftover timer from an earlier
   * tap used to fire mid-gesture and release the suppression early (on-device trace: a tap's
   * `after-tap` snapshot showed `suppress=false` while its own window had not elapsed), which is
   * exactly how "the first tap still raises the keyboard, later ones do not" happens.
   */
  private releaseTimer: number | null = null

  private readonly onPointerDown = (event: PointerEvent): void => {
    const button = composerToolbarButtonOf(event.target)
    if (button === null) {
      // Any other gesture ends the suppression immediately. It cannot rely on this enhancer's own
      // click listener alone: the attachment menu claims the click with stopImmediatePropagation()
      // (it is registered first), so for that button no later listener of ours runs. Without this
      // release a tapped `+` would keep blurring the editor for the rest of the window — i.e. the
      // user's next tap into the composer would seem dead.
      this.release()
      return
    }
    const editor = composerEditor()
    this.editorFocusedBefore = editorHasFocus(editor)
    // Upstream focuses the editor on mousedown (and again on click from 0.1.7): this gesture must
    // not leave the editor focused when the user was not typing to begin with.
    this.suppress = !this.editorFocusedBefore
    this.scheduleRelease(SUPPRESS_MAX_MS)
  }

  /**
   * Undo a focus handed to the editor while it must not hold one.
   *
   * Runs as a capture listener on `focusin`, i.e. synchronously inside the `focus()` call itself:
   * blurring here keeps the IME from ever being raised (an asynchronous blur would let it flash up
   * first).
   */
  private readonly onFocusIn = (event: FocusEvent): void => {
    const editor = composerEditor()
    const target = event.target
    if (editor === null || !(target instanceof Node) || !(target === editor || editor.contains(target))) return
    if (!this.suppress && !attachmentMenuOpen()) return
    editor.blur()
  }

  /** Let the settling window run out once this tap's click has been delivered. */
  private readonly onClick = (event: MouseEvent): void => {
    if (composerToolbarButtonOf(event.target) === null) return
    this.scheduleRelease(0)
  }

  /** Start watching composer toolbar gestures. */
  attach(): void {
    document.addEventListener('pointerdown', this.onPointerDown, true)
    document.addEventListener('focusin', this.onFocusIn, true)
    document.addEventListener('click', this.onClick, true)
  }

  /** Stop watching and drop any pending suppression. */
  detach(): void {
    document.removeEventListener('pointerdown', this.onPointerDown, true)
    document.removeEventListener('focusin', this.onFocusIn, true)
    document.removeEventListener('click', this.onClick, true)
    this.release()
    this.editorFocusedBefore = false
  }

  /** Schedule the (single) release, replacing any earlier one. */
  private scheduleRelease(delayMs: number): void {
    if (this.releaseTimer !== null) window.clearTimeout(this.releaseTimer)
    this.releaseTimer = window.setTimeout(() => {
      this.releaseTimer = null
      this.suppress = false
    }, delayMs)
  }

  /** Release the suppression now and drop the pending timer. */
  private release(): void {
    if (this.releaseTimer !== null) {
      window.clearTimeout(this.releaseTimer)
      this.releaseTimer = null
    }
    this.suppress = false
  }
}

/**
 * Composer toolbar-button keyboard guard.
 *
 * Upstream wires the composer's toolbar buttons so that pressing one hands focus back to the draft
 * editor: `onMouseDown: keepFocus` (`event.preventDefault()` plus `editor.getRootElement().focus()`)
 * and, from 0.1.7 on, an `onClick` that focuses the editor again (`focusDraftEditor(editor,
 * revealSelection)`) before toggling the command launcher. Upstream also focuses the editor on mount.
 *
 * That is desktop semantics: while a menu is open you keep typing to filter it, so the editor keeps
 * focus. On Android every one of those focuses raises the soft keyboard, so the phone form ends up
 * with a keyboard nobody asked for:
 *   - switching to the app pops it (the mount-time focus is already there and Chromium flushes the
 *     queued "show soft input" on the next user gesture),
 *   - the first tap on the composer's leftmost `+` pops it (that gesture is what flushes it),
 *   - every later `+` tap pops it again through `keepFocus`.
 *
 * Policy this guard enforces on the phone form: the draft editor holds focus only when the user just
 * asked for it — i.e. a pointer gesture inside the composer card, other than a toolbar button, within
 * {@link CARD_GESTURE_MS}. Everything else is undone:
 *   - {@link onMouseDown} stops `keepFocus` before it runs, so the editor is never focused at all
 *     (a synchronous blur after the fact is not enough: Chromium posts the IME request to the browser
 *     side and a same-task blur does not reliably cancel it — measured on device),
 *   - {@link onFocusIn} undoes a focus that still arrives (upstream's click handler on 0.1.7+, or a
 *     state-update effect),
 *   - {@link ComposerCommandButtonEnhancer.clearUnrequestedFocus} runs at attach and again shortly
 *     after, because the mount-time focus happens *before* this plugin loads and therefore produces no
 *     event we could listen for.
 *
 * Why not claim the click the way the attachment menu does: the menus are upstream React state, so
 * re-implementing their open would fork the feature. This guard only edits focus, which is the part
 * the phone form disagrees with.
 */

/** Toolbar buttons of the composer card. */
const TRIGGER_SELECTOR = "[data-composer-card] button"

/**
 * Candidate editable roots.
 *
 * The attribute is checked as a set rather than the literal `"true"`: rich-text editors legitimately
 * use `contenteditable=""` (empty string means true) or `plaintext-only`, and ProseMirror adds its own
 * class. {@link isEditable} is the authority.
 */
const EDITABLE_SELECTOR = '[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], .ProseMirror'

/** Our own attachment-source menu (ported to <body>, hence not inside the composer card). */
const ATTACHMENT_MENU_SELECTOR = '[data-dsh-attachment-picker-menu]'

/**
 * How long one toolbar tap keeps undoing editor focus.
 *
 * Not "the gesture" but "the gesture's settling window": upstream's late focus (a state-update effect
 * calling `focusDraftEditor`) can land after the click. Any gesture that is not a composer toolbar
 * button ends the window earlier, so a deliberate tap into the editor is never swallowed.
 */
const SUPPRESS_MAX_MS = 1200

/**
 * How long after a pointer gesture inside the composer card an editor focus still counts as
 * user-initiated.
 *
 * Anything longer than the tap itself, so a slow state update that focuses the editor *because* the
 * user tapped the composer still keeps their keyboard.
 */
const CARD_GESTURE_MS = 1500

/**
 * The composer toolbar button a pointer/click event belongs to.
 *
 * Deliberately not narrowed to `aria-haspopup='listbox'`: the phone report is about the leftmost `+`,
 * and that button's role differs per engine (0.1.7 renders it as the command trigger *and* as the
 * owner of the hidden file input our attachment menu claims — the on-device screenshot shows our own
 * upload menu opening from it). What the shapes share is "a toolbar button that focuses the draft
 * editor as a side effect".
 *
 * @param target - event target.
 * @returns the button, or null when the event is not on a composer toolbar button.
 */
export function composerToolbarButtonOf(target: EventTarget | null): HTMLButtonElement | null {
  if (!(target instanceof Element)) return null
  const button = target.closest<HTMLButtonElement>(TRIGGER_SELECTOR)
  return button === null || button.disabled ? null : button
}

/**
 * Whether an element is editable, per the contenteditable attribute's own rules.
 *
 * `""`, `"true"` and `"plaintext-only"` are editable, `"false"` is not; an element that carries no
 * attribute at all (a class-tagged editor host) falls back to the live DOM's `isContentEditable`. The
 * attribute branch matters for tests: jsdom does not implement contenteditable behavior, so
 * `isContentEditable` is always false there.
 *
 * @param element - candidate element.
 * @returns true when the element accepts editable input.
 */
function isEditable(element: HTMLElement): boolean {
  const attribute = element.getAttribute('contenteditable')
  if (attribute !== null) return attribute !== 'false'
  return element.isContentEditable === true
}

/**
 * The composer's draft editor that owns `node`, if any.
 *
 * Resolved from the live DOM plus the closest editable ancestor inside the composer card, so it works
 * for every engine's editor markup.
 *
 * @param node - element to resolve (usually an event target or `document.activeElement`).
 * @returns the editable root inside the composer card, or null.
 */
function editableWithin(node: EventTarget | null): HTMLElement | null {
  if (!(node instanceof Element)) return null
  const candidate = node.closest<HTMLElement>(EDITABLE_SELECTOR)
  if (candidate === null || !isEditable(candidate)) return null
  return candidate.closest('[data-composer-card]') === null ? null : candidate
}

/** The composer draft editor that currently owns focus, if any. */
function focusedEditor(): HTMLElement | null {
  return editableWithin(document.activeElement)
}

/** Whether our attachment-source menu is open. */
function attachmentMenuOpen(): boolean {
  return document.querySelector(ATTACHMENT_MENU_SELECTOR) !== null
}

/** Keeps the soft keyboard down when the composer editor was not asked for. */
export class ComposerCommandButtonEnhancer {
  /** Editor owned focus before this gesture started. */
  private editorFocusedBefore = false
  /** Undo editor focus for the remainder of this gesture (and its settling window). */
  private suppress = false
  /**
   * Timestamp of the last pointer gesture inside the composer card (0 = none this page).
   *
   * Distinguishes "the user asked for the composer" from upstream's programmatic focus.
   */
  private lastCardGestureAt = 0
  /**
   * The single outstanding "release suppression" timer.
   *
   * Exactly one, always cleared before the next one is scheduled: a leftover timer from an earlier tap
   * used to fire mid-gesture and release the suppression early (on-device trace: a tap's
   * `after-tap` snapshot showed the suppression already released while its own window had not
   * elapsed), which is exactly how "the first tap still raises the keyboard, later ones do not"
   * happens.
   */
  private releaseTimer: number | null = null
  /** Watchdog timers armed by {@link attach}. */
  private readonly watchdogs: number[] = []

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.target instanceof Element && event.target.closest('[data-composer-card]') !== null) {
      this.lastCardGestureAt = Date.now()
    }
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
    this.editorFocusedBefore = focusedEditor() !== null
    // Upstream focuses the editor on mousedown (and again on click from 0.1.7): this gesture must not
    // leave the editor focused when the user was not typing to begin with.
    this.suppress = !this.editorFocusedBefore
    this.scheduleRelease(SUPPRESS_MAX_MS)
  }

  /**
   * Stop upstream's `onMouseDown: keepFocus` before it runs.
   *
   * Measured on device: every focus it produced *was* blurred synchronously, yet the keyboard still
   * came up — Chromium posts "show soft input" to the browser side and a same-task blur does not
   * reliably cancel a request that is already queued. So the fix has to be "never focus", not "focus
   * then undo": swallowing the mousedown keeps it from reaching React's root listener, upstream's
   * `preventDefault()` + `editor.focus()` never run, and the browser's default simply gives the tap
   * target focus (a button, hence no IME).
   *
   * The click still fires, so upstream's state machine (launcher toggle) and our attachment menu are
   * unaffected. A user who is already typing keeps upstream's behavior untouched.
   */
  private readonly onMouseDown = (event: MouseEvent): void => {
    const button = composerToolbarButtonOf(event.target)
    if (button === null) return
    if (focusedEditor() !== null) return
    event.stopImmediatePropagation()
  }

  /**
   * Undo a focus handed to the editor while it must not hold one.
   *
   * Runs as a capture listener on `focusin`, i.e. synchronously inside the `focus()` call itself:
   * blurring here keeps the IME from ever being raised (an asynchronous blur would let it flash up
   * first).
   */
  private readonly onFocusIn = (event: FocusEvent): void => {
    const editor = editableWithin(event.target)
    if (editor === null) return
    // Keep focus only when the user just asked for the composer and nothing says otherwise.
    if (!this.suppress && !attachmentMenuOpen() && Date.now() - this.lastCardGestureAt <= CARD_GESTURE_MS) return
    editor.blur()
  }

  /** Let the settling window run out once this tap's click has been delivered. */
  private readonly onClick = (event: MouseEvent): void => {
    if (composerToolbarButtonOf(event.target) === null) return
    this.scheduleRelease(0)
  }

  /** Start watching composer toolbar gestures and clear focus nobody asked for. */
  attach(): void {
    document.addEventListener('pointerdown', this.onPointerDown, true)
    document.addEventListener('mousedown', this.onMouseDown, true)
    document.addEventListener('focusin', this.onFocusIn, true)
    document.addEventListener('click', this.onClick, true)
    // Upstream focuses the editor on mount, before this plugin loads, so no `focusin` ever reaches us
    // for it. Inspect now and again shortly after, otherwise that unrequested focus survives and the
    // keyboard pops the next time the app is brought forward.
    this.clearUnrequestedFocus()
    for (const delay of [400, 1200]) {
      this.watchdogs.push(window.setTimeout(() => { this.clearUnrequestedFocus() }, delay))
    }
  }

  /** Stop watching and drop any pending suppression. */
  detach(): void {
    document.removeEventListener('pointerdown', this.onPointerDown, true)
    document.removeEventListener('mousedown', this.onMouseDown, true)
    document.removeEventListener('focusin', this.onFocusIn, true)
    document.removeEventListener('click', this.onClick, true)
    for (const timer of this.watchdogs) window.clearTimeout(timer)
    this.watchdogs.length = 0
    this.release()
    this.editorFocusedBefore = false
    this.lastCardGestureAt = 0
  }

  /** Blur the composer editor when no composer gesture asked for its focus. */
  private clearUnrequestedFocus(): void {
    const editor = focusedEditor()
    if (editor === null) return
    if (this.suppress || attachmentMenuOpen() || Date.now() - this.lastCardGestureAt <= CARD_GESTURE_MS) return
    editor.blur()
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

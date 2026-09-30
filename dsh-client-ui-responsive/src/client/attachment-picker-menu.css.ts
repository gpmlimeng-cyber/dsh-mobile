/** Composer paperclip source chooser, built from DSH semantic surface and elevation tokens. */
export const ATTACHMENT_PICKER_MENU_CSS = `
[data-dsh-attachment-picker-menu] {
  position: fixed;
  z-index: 2147483000;
  display: grid;
  gap: 2px;
  box-sizing: border-box;
  padding: 6px;
  border: 1px solid var(--dsw-alias-border-l4);
  border-radius: 12px;
  /* 0.1.7 起 --dsw-specific-menu → --dsw-menu-surface-fill 是 #f8f9fa94 / #43454a73（58% / 45%），
     真机实测本菜单因此半透明（能看见底下的输入框占位文字）。自己的面板直接取主题的不透明抬升面：
     颜色等效、底透不上来，且不依赖 composer-menu.css 里那条 token 覆盖的作用域。 */
  background: var(--dsw-alias-bg-layer-3, var(--dsw-specific-menu));
  box-shadow: var(--dsw-elevation-panel);
  color: var(--dsw-alias-label-primary);
  font: var(--dsw-font-markdown-base);
}
[data-dsh-attachment-picker-menu] [data-dsh-attachment-picker-item] {
  display: flex;
  min-height: 40px;
  width: 100%;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
}
[data-dsh-attachment-picker-menu] [data-dsh-attachment-picker-item] svg {
  flex: none;
  color: var(--dsw-alias-label-secondary);
}
[data-dsh-attachment-picker-menu] [data-dsh-attachment-picker-item]:hover,
[data-dsh-attachment-picker-menu] [data-dsh-attachment-picker-item]:focus-visible {
  outline: none;
  background: var(--dsw-alias-bg-layer-2);
}
[data-dsh-attachment-picker-menu] [data-dsh-attachment-picker-item]:active {
  background: var(--dsw-alias-bg-layer-1);
}
`

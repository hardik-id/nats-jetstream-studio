import type { MenuItemConstructorOptions } from 'electron'

export interface MenuContext {
  isMac: boolean
  /** True in an installed build; reload and dev tools exist only when false. */
  isPackaged: boolean
}

/**
 * The application menu. Electron's default menu binds Ctrl/Cmd+R (reload, loses unsaved state),
 * Ctrl+Shift+I (dev tools) and Ctrl/Cmd+W (close window), so the menu is spelled out instead.
 * Never add a "close window" item: Ctrl/Cmd+W belongs to the studio's own tab handling.
 * F11 (full screen) is kept: it only changes the window state and loses nothing.
 */
export function buildMenuTemplate({
  isMac,
  isPackaged
}: MenuContext): MenuItemConstructorOptions[] {
  const edit: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' }
    ]
  }

  const view: MenuItemConstructorOptions[] = [
    { role: 'resetZoom' },
    { role: 'zoomIn' },
    { role: 'zoomOut' },
    { type: 'separator' },
    { role: 'togglefullscreen' }
  ]
  if (!isPackaged) {
    view.push({ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' })
  }

  const template: MenuItemConstructorOptions[] = []
  if (isMac) {
    template.push({
      label: 'NATS JetStream Studio',
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }
  template.push(edit, { label: 'View', submenu: view })
  if (isMac) {
    template.push({ label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }] })
  }
  return template
}

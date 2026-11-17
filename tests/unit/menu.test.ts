import { describe, expect, it } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { buildMenuTemplate } from '../../src/main/menu'

function items(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return template.flatMap((top) => [top, ...((top.submenu as MenuItemConstructorOptions[]) ?? [])])
}
const roles = (t: MenuItemConstructorOptions[]): string[] =>
  items(t).flatMap((i) => (i.role ? [i.role] : []))

describe('application menu', () => {
  for (const isMac of [false, true]) {
    const name = isMac ? 'macOS' : 'Windows/Linux'

    it(`${name}, packaged: no reload, dev tools or close window`, () => {
      const t = buildMenuTemplate({ isMac, isPackaged: true })
      const r = roles(t).map((x) => x.toLowerCase())
      for (const banned of ['reload', 'forcereload', 'toggledevtools', 'close', 'windowmenu']) {
        expect(r).not.toContain(banned)
      }
      for (const item of items(t)) {
        const acc = String(item.accelerator ?? '').toLowerCase()
        expect(acc).not.toMatch(/\+w$|^f12$|\+r$/)
      }
    })

    it(`${name}: edit roles and zoom are present`, () => {
      const r = roles(buildMenuTemplate({ isMac, isPackaged: true }))
      for (const role of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) {
        expect(r).toContain(role)
      }
      for (const role of ['zoomIn', 'zoomOut', 'resetZoom']) expect(r).toContain(role)
    })

    it(`${name}, not packaged: reload and dev tools are available, close still absent`, () => {
      const r = roles(buildMenuTemplate({ isMac, isPackaged: false }))
      expect(r).toContain('reload')
      expect(r).toContain('toggleDevTools')
      expect(r).not.toContain('close')
    })
  }

  it('app menu items exist only on macOS', () => {
    const mac = roles(buildMenuTemplate({ isMac: true, isPackaged: true }))
    const other = roles(buildMenuTemplate({ isMac: false, isPackaged: true }))
    for (const role of ['about', 'hide', 'hideOthers', 'unhide', 'quit']) {
      expect(mac).toContain(role)
      expect(other).not.toContain(role)
    }
  })
})

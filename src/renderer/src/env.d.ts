/// <reference types="vite/client" />
import type { DesktopBridge } from '@shared/desktop'

declare global {
  interface Window {
    /** Present only in the desktop app, where the preload script provides it. */
    studioDesktop?: DesktopBridge
  }
}

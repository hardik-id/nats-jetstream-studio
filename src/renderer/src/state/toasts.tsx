import type { ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react'
import { create } from 'zustand'
import { cx, errorMessage } from '../components/ui'

export interface Toast {
  id: number
  tone: 'ok' | 'error' | 'info'
  message: string
}

interface ToastState {
  toasts: Toast[]
  push(tone: Toast['tone'], message: string): void
  dismiss(id: number): void
}

let nextId = 1

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(tone, message) {
    const id = nextId++
    set({ toasts: [...get().toasts.slice(-4), { id, tone, message }] })
    // Errors stay until dismissed; confirmations go away on their own.
    if (tone !== 'error') setTimeout(() => get().dismiss(id), 4000)
  },
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) })
  }
}))

export const toast = {
  ok: (message: string): void => useToasts.getState().push('ok', message),
  info: (message: string): void => useToasts.getState().push('info', message),
  error: (error: unknown): void => useToasts.getState().push('error', errorMessage(error))
}

export function Toaster(): ReactNode {
  const { toasts, dismiss } = useToasts()
  return (
    <div
      className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-2"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          role={t.tone === 'error' ? 'alert' : 'status'}
          className={cx(
            'pointer-events-auto flex items-start gap-2 rounded-md border bg-panel px-3 py-2 shadow-lg',
            t.tone === 'error' ? 'border-danger/50' : 'border-line'
          )}
        >
          {t.tone === 'ok' && (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
          )}
          {t.tone === 'error' && (
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
          )}
          {t.tone === 'info' && (
            <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
          )}
          <span className="min-w-0 flex-1 break-words">{t.message}</span>
          <button
            aria-label="Dismiss"
            className="text-faint hover:text-fg"
            onClick={() => dismiss(t.id)}
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
      ))}
    </div>
  )
}

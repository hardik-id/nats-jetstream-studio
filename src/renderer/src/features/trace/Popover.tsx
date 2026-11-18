import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'
import { cx } from '../../components/ui'

/** A button that opens a small panel under it. Closes on Escape and on a click outside. */
export function Popover({
  label,
  summary,
  children,
  className
}: {
  /** What the button is called (its accessible name starts with it). */
  label: string
  /** The current choice, shown on the button after the label. */
  summary?: string
  children: ReactNode
  className?: string
}): ReactNode {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const panelId = useId()

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const key = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', key)
    }
  }, [open])

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={summary ? `${label}: ${summary}` : label}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-8 max-w-56 items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 text-[13px] hover:bg-hover"
      >
        <span className="text-muted">{label}</span>
        {summary && <span className="min-w-0 truncate font-medium">{summary}</span>}
        <ChevronDown className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
      </button>
      {open && (
        <div
          id={panelId}
          role="group"
          aria-label={label}
          className={cx(
            'absolute top-full left-0 z-40 mt-1 w-72 max-w-[85vw] rounded-md border border-line bg-panel p-2 shadow-lg',
            className
          )}
        >
          {children}
        </div>
      )}
    </div>
  )
}

import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes
} from 'react'
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Copy,
  Info,
  Loader2,
  MinusCircle,
  X,
  XCircle
} from 'lucide-react'
import { GatewayError } from '@shared/api'

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

// ───────────── Button ─────────────

/** `default` is the secondary button (raised fill, 1 px border); `secondary` is an alias. */
type ButtonVariant = 'primary' | 'default' | 'secondary' | 'ghost' | 'danger'

interface ButtonBaseProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  /** `md` is 32 px high, `sm` (compact) is 28 px. */
  size?: 'sm' | 'md'
  icon?: ReactNode
  busy?: boolean
}

/** A button without text is icon-only (square), and then it must carry an `aria-label`. */
type ButtonProps = ButtonBaseProps &
  ({ children: ReactNode } | { children?: undefined; 'aria-label': string })

const VARIANTS: Record<ButtonVariant, string> = {
  primary: 'bg-accent text-accent-fg border-transparent hover:brightness-110',
  default: 'bg-raised text-fg border-line hover:bg-hover',
  secondary: 'bg-raised text-fg border-line hover:bg-hover',
  ghost: 'bg-transparent text-muted border-transparent hover:bg-hover hover:text-fg',
  // Tinted: soft fill, danger text and border, a stronger tint on hover.
  danger: 'bg-danger-soft text-danger border-danger/40 hover:border-danger/70 hover:brightness-110'
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'default',
    size = 'md',
    icon,
    busy,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border font-medium whitespace-nowrap select-none',
        'disabled:cursor-not-allowed disabled:opacity-50',
        size === 'sm' ? 'h-7 text-xs' : 'h-8 text-[13px]',
        // Icon-only buttons are square; the padding classes must not both be present.
        children ? (size === 'sm' ? 'px-2.5' : 'px-3') : size === 'sm' ? 'w-7' : 'w-8',
        VARIANTS[variant],
        className
      )}
      {...rest}
    >
      {busy ? <Loader2 className="spin h-3.5 w-3.5" aria-hidden /> : icon}
      {children}
    </button>
  )
})

// ───────────── Form controls ─────────────

const CONTROL =
  'rounded-md border border-line bg-panel px-2.5 text-[13px] text-fg placeholder:text-faint disabled:cursor-not-allowed disabled:bg-raised disabled:text-muted'

/** Controls fill their container unless the caller gives a width; two width classes would fight. */
const fill = (className: string | undefined): string | false =>
  !/(^|\s)!?w-/.test(className ?? '') && 'w-full'

export const Input = forwardRef<
  HTMLInputElement,
  InputHTMLAttributes<HTMLInputElement> & {
    invalid?: boolean
    /** Subject and JSONPath fields use the mono font. */
    mono?: boolean
    /** 28 px high instead of 32 px. */
    compact?: boolean
  }
>(function Input({ className, invalid, mono, compact, ...rest }, ref) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid || undefined}
      className={cx(
        CONTROL,
        fill(className),
        compact ? 'h-7' : 'h-8',
        mono && 'font-mono text-xs',
        invalid && 'border-danger',
        className
      )}
      {...rest}
    />
  )
})

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }
>(function TextArea({ className, invalid, ...rest }, ref) {
  return (
    <textarea
      ref={ref}
      aria-invalid={invalid || undefined}
      spellCheck={false}
      className={cx(
        CONTROL,
        fill(className),
        'py-1.5 font-mono text-xs leading-5',
        invalid && 'border-danger',
        className
      )}
      {...rest}
    />
  )
})

export const Select = forwardRef<
  HTMLSelectElement,
  SelectHTMLAttributes<HTMLSelectElement> & { mono?: boolean; compact?: boolean }
>(function Select({ className, children, mono, compact, ...rest }, ref) {
  return (
    <select
      ref={ref}
      className={cx(
        CONTROL,
        fill(className),
        compact ? 'h-7' : 'h-8',
        'pr-6',
        mono && 'font-mono text-xs',
        className
      )}
      {...rest}
    >
      {children}
    </select>
  )
})

export function Checkbox({
  label,
  hint,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  label: ReactNode
  hint?: ReactNode
}): ReactNode {
  return (
    <label
      className={cx('flex items-start gap-2 text-[13px]', rest.disabled && 'opacity-60', className)}
    >
      <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 accent-[var(--accent)]" {...rest} />
      <span>
        {label}
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </label>
  )
}

/** A labelled form row. The label is tied to the first control inside it. */
export function Field({
  label,
  hint,
  error,
  children,
  className
}: {
  label: ReactNode
  hint?: ReactNode
  error?: string | null
  children: (id: string) => ReactNode
  className?: string
}): ReactNode {
  const id = useId()
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-muted">
        {label}
      </label>
      {children(id)}
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : (
        hint && <p className="text-xs text-faint">{hint}</p>
      )}
    </div>
  )
}

// ───────────── Small pieces ─────────────

type Tone = 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'
/** Status variants always show an icon and a word, so colour is never the only signal. */
export type BadgeStatus = 'ok' | 'warn' | 'danger' | 'info' | 'neutral'
const STATUS: Record<BadgeStatus, { tone: Tone; Icon: typeof Info }> = {
  ok: { tone: 'ok', Icon: CheckCircle2 },
  warn: { tone: 'warn', Icon: AlertTriangle },
  danger: { tone: 'danger', Icon: XCircle },
  info: { tone: 'accent', Icon: Info },
  neutral: { tone: 'neutral', Icon: MinusCircle }
}
const TONES: Record<Tone, string> = {
  neutral: 'bg-raised text-muted border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  danger: 'bg-danger-soft text-danger border-transparent'
}

export function Badge({
  tone = 'neutral',
  status,
  children,
  title,
  className
}: {
  tone?: Tone
  /** A status variant: coloured, with an icon in front of the word. Wins over `tone`. */
  status?: BadgeStatus
  children: ReactNode
  title?: string
  className?: string
}): ReactNode {
  if (status) {
    const { tone: statusTone, Icon } = STATUS[status]
    return (
      <span
        title={title}
        className={cx(
          'inline-flex h-[18px] items-center gap-1 rounded border px-1.5 text-[11px] font-medium whitespace-nowrap',
          TONES[statusTone],
          className
        )}
      >
        <Icon className="h-3 w-3 shrink-0" aria-hidden />
        {children}
      </span>
    )
  }
  return (
    <span
      title={title}
      className={cx(
        'inline-flex h-[18px] items-center rounded border px-1.5 text-[11px] font-medium whitespace-nowrap',
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  )
}

export function Spinner({ label }: { label?: string }): ReactNode {
  return (
    <span role="status" className="inline-flex items-center gap-2 text-muted">
      <Loader2 className="spin h-4 w-4" aria-hidden />
      {label ?? 'Loading'}
    </span>
  )
}

export function EmptyState({
  title,
  children,
  icon
}: {
  title: string
  children?: ReactNode
  icon?: ReactNode
}): ReactNode {
  return (
    <div className="flex h-full min-h-40 flex-col items-center justify-center gap-2 p-8 text-center">
      {icon && <div className="text-faint">{icon}</div>}
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-md text-muted">{children}</div>}
    </div>
  )
}

export function errorMessage(error: unknown): string {
  if (error instanceof GatewayError) return error.message
  if (error instanceof Error) return error.message
  return String(error)
}

export function ErrorNote({
  error,
  onRetry,
  className
}: {
  error: unknown
  onRetry?: () => void
  className?: string
}): ReactNode {
  if (!error) return null
  return (
    <div
      role="alert"
      className={cx(
        'flex items-start gap-2 rounded-md border border-danger/40 bg-danger-soft px-3 py-2 text-danger',
        className
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{errorMessage(error)}</span>
      {onRetry && (
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      )}
    </div>
  )
}

export function Notice({
  tone = 'neutral',
  children,
  className
}: {
  tone?: Tone
  children: ReactNode
  className?: string
}): ReactNode {
  return <div className={cx('rounded-md border px-3 py-2', TONES[tone], className)}>{children}</div>
}

export function Kbd({ children }: { children: ReactNode }): ReactNode {
  return (
    <kbd className="rounded border border-line bg-raised px-1 font-mono text-[11px] text-muted">
      {children}
    </kbd>
  )
}

export function CopyButton({
  text,
  label = 'Copy',
  size = 'sm'
}: {
  text: string | (() => string)
  label?: string
  size?: 'sm' | 'md'
}): ReactNode {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      size={size}
      variant="ghost"
      title={label}
      aria-label={label}
      icon={
        copied ? (
          <Check className="h-3.5 w-3.5 text-ok" aria-hidden />
        ) : (
          <Copy className="h-3.5 w-3.5" aria-hidden />
        )
      }
      onClick={() => {
        void navigator.clipboard.writeText(typeof text === 'function' ? text() : text).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1200)
        })
      }}
    />
  )
}

/** Label and value pairs laid out in a grid, used on every detail page. */
export function Facts({
  items,
  columns = 2
}: {
  items: [label: string, value: ReactNode][]
  columns?: 1 | 2 | 3
}): ReactNode {
  return (
    <dl
      className={cx(
        'grid gap-x-6 gap-y-2',
        columns === 1 ? 'grid-cols-1' : columns === 2 ? 'grid-cols-2' : 'grid-cols-3'
      )}
    >
      {items.map(([label, value]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs text-muted">{label}</dt>
          <dd className="truncate" title={typeof value === 'string' ? value : undefined}>
            {value === undefined || value === null || value === '' ? (
              <span className="text-faint">-</span>
            ) : (
              value
            )}
          </dd>
        </div>
      ))}
    </dl>
  )
}

export function Card({
  title,
  actions,
  children,
  className
}: {
  title?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}): ReactNode {
  return (
    <section className={cx('rounded-lg border border-line bg-panel', className)}>
      {(title || actions) && (
        <header className="flex min-h-9 items-center justify-between gap-2 border-b border-line px-3 py-1.5">
          <h3 className="text-xs font-semibold tracking-wide text-muted uppercase">{title}</h3>
          <div className="flex items-center gap-1">{actions}</div>
        </header>
      )}
      <div className="p-3">{children}</div>
    </section>
  )
}

// ───────────── Tabs ─────────────

export function SubTabs<T extends string>({
  tabs,
  active,
  onChange
}: {
  tabs: { id: T; label: ReactNode }[]
  active: T
  onChange: (id: T) => void
}): ReactNode {
  return (
    <div className="shrink-0 border-b border-line px-3 py-2">
      <div
        role="tablist"
        className="inline-flex max-w-full gap-0.5 overflow-x-auto rounded-md border border-line bg-raised p-0.5"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            role="tab"
            aria-selected={tab.id === active}
            onClick={() => onChange(tab.id)}
            className={cx(
              'h-6 rounded px-3 text-[13px] font-medium whitespace-nowrap',
              tab.id === active
                ? 'border border-line bg-panel text-fg'
                : 'border border-transparent text-muted hover:text-fg'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  )
}

// ───────────── Dialogs ─────────────

export function Dialog({
  title,
  onClose,
  children,
  footer,
  width = 520
}: {
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const root = ref.current
    // Focus the first field so the dialog can be used straight from the keyboard.
    const first = root?.querySelector<HTMLElement>(
      '[autofocus], input:not([type=hidden]), textarea, select, button:not([data-close])'
    )
    ;(first ?? root)?.focus()
    return () => previous?.focus?.()
  }, [])

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/45 p-6 pt-[8vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        style={{ width }}
        className="flex max-h-[84vh] max-w-full flex-col rounded-lg border border-line bg-panel shadow-xl outline-none"
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
          if (e.key === 'Tab') trapFocus(e, ref.current)
        }}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-line px-4 py-2.5">
          <h2 id={titleId} className="text-sm font-semibold">
            {title}
          </h2>
          <Button
            data-close
            variant="ghost"
            size="sm"
            aria-label="Close"
            onClick={onClose}
            icon={<X className="h-4 w-4" aria-hidden />}
          />
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>
        {footer && (
          <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-line px-4 py-2.5">
            {footer}
          </footer>
        )}
      </div>
    </div>
  )
}

function trapFocus(e: React.KeyboardEvent, root: HTMLElement | null): void {
  if (!root) return
  const focusable = Array.from(
    root.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
  ).filter((el) => !el.hasAttribute('disabled'))
  if (focusable.length === 0) return
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault()
    last.focus()
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault()
    first.focus()
  }
}

/**
 * Confirmation for actions that cannot be undone. With `typeToConfirm` the user must type that
 * exact text (a stream name, say) before the button becomes active.
 */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  typeToConfirm,
  danger = true,
  onConfirm,
  onClose
}: {
  title: string
  children: ReactNode
  confirmLabel: string
  typeToConfirm?: string
  danger?: boolean
  onConfirm: () => Promise<unknown> | void
  onClose: () => void
}): ReactNode {
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const ready = !typeToConfirm || typed === typeToConfirm

  const run = async (): Promise<void> => {
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      await onConfirm()
      onClose()
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }

  return (
    <Dialog
      title={title}
      onClose={onClose}
      width={460}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            disabled={!ready}
            busy={busy}
            onClick={() => void run()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void run()
        }}
      >
        <div className="text-[13px]">{children}</div>
        {typeToConfirm && (
          <Field
            label={
              <>
                Type <span className="font-mono text-fg">{typeToConfirm}</span> to confirm
              </>
            }
          >
            {(id) => (
              <Input
                id={id}
                mono
                autoFocus
                autoComplete="off"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
              />
            )}
          </Field>
        )}
        <ErrorNote error={error} />
      </form>
    </Dialog>
  )
}

// ───────────── Menu ─────────────

export interface MenuItem {
  /** Shown on one line and cut short with an ellipsis when it is wider than the menu. */
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
  /** The tooltip. Without one the tooltip is the label, so a label that was cut can be read. */
  title?: string
}

export function Menu({
  trigger,
  items,
  align = 'left'
}: {
  trigger: (props: {
    onClick: (e: React.MouseEvent) => void
    'aria-expanded': boolean
    'aria-haspopup': 'menu'
  }) => ReactNode
  items: MenuItem[]
  align?: 'left' | 'right'
}): ReactNode {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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
      {trigger({
        onClick: (e) => {
          e.stopPropagation()
          setOpen((v) => !v)
        },
        'aria-expanded': open,
        'aria-haspopup': 'menu'
      })}
      {open && (
        <div
          role="menu"
          className={cx(
            'absolute top-full z-40 mt-1 w-max max-w-80 min-w-44 rounded-md border border-line bg-panel py-1 shadow-lg',
            align === 'right' ? 'right-0' : 'left-0'
          )}
        >
          {/* Keyed by position: labels can repeat, for example a saved filter that is named like
              one of the fixed entries, and the list is rebuilt whenever it changes. */}
          {items.map((item, index) => (
            <button
              key={index}
              role="menuitem"
              disabled={item.disabled}
              title={item.title ?? item.label}
              onClick={(e) => {
                e.stopPropagation()
                setOpen(false)
                item.onSelect()
              }}
              className={cx(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] hover:bg-hover disabled:cursor-not-allowed disabled:opacity-50',
                item.danger && 'text-danger'
              )}
            >
              {item.icon}
              <span className="min-w-0 truncate">{item.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** A horizontal meter: how much of a limit is used. */
export function Meter({
  value,
  max,
  label
}: {
  value: number
  max: number
  label: string
}): ReactNode {
  const unlimited = !(max > 0)
  const pct = unlimited ? 0 : Math.min(100, (value / max) * 100)
  const tone = pct >= 90 ? 'bg-danger' : pct >= 75 ? 'bg-warn' : 'bg-accent'
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={unlimited ? undefined : max}
      aria-valuenow={value}
      className="h-1.5 w-full overflow-hidden rounded-full bg-hover"
    >
      {!unlimited && (
        <div
          className={cx('h-full rounded-full', tone)}
          style={{ width: `${Math.max(pct, value > 0 ? 1.5 : 0)}%` }}
        />
      )}
    </div>
  )
}

/** The standard frame of a tab: a title row with actions, then the content. */
export function Page({
  title,
  subtitle,
  filter,
  actions,
  children,
  scroll = true
}: {
  title: ReactNode
  subtitle?: ReactNode
  /** Search and filter controls, shown on the right of the header before the actions. */
  filter?: ReactNode
  actions?: ReactNode
  children: ReactNode
  /** False when the content manages its own scrolling (tables). */
  scroll?: boolean
}): ReactNode {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-h-14 shrink-0 flex-wrap items-center gap-2 border-b border-line bg-panel px-4 py-2">
        <div className="mr-auto min-w-0">
          <h1 className="truncate text-[20px] leading-7 font-semibold">{title}</h1>
          {subtitle && (
            <p className="truncate text-xs text-faint" role="status">
              {subtitle}
            </p>
          )}
        </div>
        {filter}
        {actions}
      </header>
      <div className={cx('min-h-0 flex-1', scroll ? 'overflow-y-auto p-4' : 'flex flex-col')}>
        {children}
      </div>
    </div>
  )
}

/** Wraps a control that changes server state: disabled with an explanation on read-only connections. */
export function readOnlyProps(readOnly: boolean | undefined): {
  disabled?: boolean
  title?: string
} {
  return readOnly
    ? {
        disabled: true,
        title:
          'This connection is read-only. Turn off read-only mode on the connection to make changes.'
      }
    : {}
}

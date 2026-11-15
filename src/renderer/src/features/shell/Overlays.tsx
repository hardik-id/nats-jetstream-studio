import { useEffect, useState, type ReactNode } from 'react'
import type { UpdateEvent } from '@shared/desktop'
import { Button, Dialog, Facts, Kbd, Notice } from '../../components/ui'
import { useAppInfo } from '../../lib/hooks'

const SHORTCUTS: [keys: string[], what: string][] = [
  [['Ctrl/⌘', 'K'], 'Search streams, consumers and buckets, or run an action'],
  [['Ctrl/⌘', 'B'], 'Collapse or expand the sidebar'],
  [['?'], 'Show this list'],
  [['Ctrl/⌘', 'W'], 'Close the current tab'],
  [['Ctrl', 'Tab'], 'Next tab (add Shift for the previous one)'],
  [['↑', '↓'], 'Move through the rows of a table'],
  [['PgUp', 'PgDn', 'Home', 'End'], 'Jump through a table'],
  [['Enter'], 'Open the selected row'],
  [['Space'], 'Tick the selected message in the message browser'],
  [['Esc'], 'Close a dialog, the search box or the message panel'],
  [['Alt', '↑ / ↓'], 'Previous or next message while the message panel is open'],
  [['Ctrl/⌘', 'Enter'], 'Send, in the publish form']
]

/** Lists the keyboard shortcuts (PBI-093). */
export function HelpOverlay({ onClose }: { onClose: () => void }): ReactNode {
  return (
    <Dialog
      title="Keyboard shortcuts"
      onClose={onClose}
      width={520}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <table className="w-full border-collapse">
        <tbody>
          {SHORTCUTS.map(([keys, what]) => (
            <tr key={what} className="border-t border-line first:border-t-0">
              <td className="w-48 py-1.5 pr-3 whitespace-nowrap">
                {keys.map((k, i) => (
                  <span key={k}>
                    {i > 0 && <span className="px-1 text-faint">+</span>}
                    <Kbd>{k}</Kbd>
                  </span>
                ))}
              </td>
              <td className="py-1.5">{what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  )
}

export function AboutDialog({ onClose }: { onClose: () => void }): ReactNode {
  const info = useAppInfo()
  const [update, setUpdate] = useState<UpdateEvent | null>(null)
  const desktop = window.studioDesktop
  useEffect(() => desktop?.onUpdateEvent(setUpdate), [desktop])

  return (
    <Dialog
      title="About NATS JetStream Studio"
      onClose={onClose}
      width={460}
      footer={<Button onClick={onClose}>Close</Button>}
    >
      <div className="flex flex-col gap-4">
        <Facts
          columns={2}
          items={[
            ['App version', info?.version],
            ['NATS client version', info?.natsClientVersion],
            ['Mode', info?.mode === 'web' ? 'Web (server)' : 'Desktop'],
            ['Platform', info?.platform],
            [
              'Secret storage',
              info ? (info.secretStorage ? 'OS keychain' : 'Not available') : undefined
            ],
            [
              'NATS CLI contexts',
              <span key="dir" className="font-mono text-xs" title={info?.cliContextDir}>
                {info?.cliContextDir}
              </span>
            ]
          ]}
        />
        {desktop && (
          <div className="flex items-center gap-2">
            <Button onClick={() => void desktop.checkForUpdates()}>Check for updates</Button>
            <span className="text-muted" role="status">
              {update?.type === 'checking' && 'Checking...'}
              {update?.type === 'not-available' && 'You have the latest version.'}
              {update?.type === 'available' && `Version ${update.version} is available.`}
              {update?.type === 'error' && `Update check failed: ${update.message}`}
            </span>
          </div>
        )}
      </div>
    </Dialog>
  )
}

/** Offers an update when one exists. Nothing is downloaded or installed until the user asks (PBI-100). */
export function UpdateBanner(): ReactNode {
  const desktop = window.studioDesktop
  const [event, setEvent] = useState<UpdateEvent | null>(null)
  const [deferred, setDeferred] = useState(false)
  useEffect(() => desktop?.onUpdateEvent(setEvent), [desktop])
  if (!desktop || !event || deferred) return null

  if (event.type === 'available') {
    return (
      <Notice tone="accent" className="m-2 flex shrink-0 items-center gap-2">
        <span className="mr-auto">
          Version {event.version} of NATS JetStream Studio is available.
        </span>
        <Button size="sm" variant="primary" onClick={() => void desktop.downloadUpdate()}>
          Download
        </Button>
        <Button size="sm" onClick={() => setDeferred(true)}>
          Later
        </Button>
      </Notice>
    )
  }
  if (event.type === 'progress') {
    return <Notice className="m-2 shrink-0">Downloading the update: {event.percent}%</Notice>
  }
  if (event.type === 'downloaded') {
    return (
      <Notice tone="ok" className="m-2 flex shrink-0 items-center gap-2">
        <span className="mr-auto">Version {event.version} is ready to install.</span>
        <Button size="sm" variant="primary" onClick={() => void desktop.installUpdate()}>
          Restart to install
        </Button>
        <Button size="sm" onClick={() => setDeferred(true)}>
          Later
        </Button>
      </Notice>
    )
  }
  return null
}

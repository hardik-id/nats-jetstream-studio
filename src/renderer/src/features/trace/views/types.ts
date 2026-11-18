import type { ComponentType } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Trace } from '../model/trace'

/** The stored settings of the views of a tab: control id to value. Kept in the tab spec. */
export type ViewSettings = Readonly<Record<string, string | boolean>>

/** What every view of a trace gets. Views draw; they never fetch and never compute the trace. */
export interface TraceViewProps {
  trace: Trace
  /** The id of the selected message (see `messageId`), or null. */
  selected: string | null
  /** The selection moved (arrow keys, a click). */
  onSelect: (id: string) => void
  /** A click, Enter or double-click on a message: show it in the detail pane. */
  onOpen: (id: string) => void
  /** The view's own settings, completed with the defaults of its controls (see `resolveSettings`). */
  settings: ViewSettings
  /** The detail pane is open, so it already shows the selected message. */
  detailOpen: boolean
}

/** Where the toolbar puts a control: next to the View dropdown, or in the "More" popover. */
export type ControlPlacement = 'bar' | 'more'

interface ControlBase {
  /** The key in `ViewSettings`. Views share one flat object, so ids are specific (`laneBy`). */
  id: string
  label: string
  placement?: ControlPlacement
  /** The control is shown but cannot be changed while this is true (given the settings). */
  disabled?: (settings: ViewSettings) => boolean
}

/** A choice from a short list, shown as a dropdown. */
export interface SelectControl extends ControlBase {
  kind: 'select'
  options: readonly { value: string; label: string }[]
  default: string
}

/** An on/off option, shown as a checkbox. */
export interface ToggleControl extends ControlBase {
  kind: 'toggle'
  hint?: string
  default: boolean
}

export type ViewControl = SelectControl | ToggleControl

export interface TraceViewDef {
  id: string
  label: string
  icon: LucideIcon
  /** The controls of the view; the toolbar shows them while the view is active. */
  controls?: readonly ViewControl[]
  Component: ComponentType<TraceViewProps>
}

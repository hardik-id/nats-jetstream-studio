import type { ReactNode } from 'react'
import { FilterButton } from '../../components/JsonView'

/**
 * The subject cell of a message row (PBI-129): the subject, and "Filter to" and "Exclude" buttons
 * that appear over its right end on hover and on keyboard focus. Only the open row's buttons are
 * tab stops, so the table keeps its single tab stop (arrow keys move the open row); the buttons
 * of other rows are for the pointer. Clicks do not reach the row, so they never change selection.
 */
export function SubjectCell({
  subject,
  tabbable,
  onFilter
}: {
  subject: string
  /** True for the open row: its buttons are reached with Tab. */
  tabbable: boolean
  onFilter: (exclude: boolean) => void
}): ReactNode {
  return (
    <div className="group/subject relative flex items-center">
      <span className="min-w-0 flex-1 truncate">{subject}</span>
      <span
        className="absolute top-1/2 right-0 inline-flex -translate-y-1/2 gap-1 opacity-0 group-focus-within/subject:opacity-100 group-hover/subject:opacity-100"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <FilterButton
          exclude={false}
          text=""
          tabIndex={tabbable ? 0 : -1}
          label={`Filter to subject ${subject}`}
          onClick={() => onFilter(false)}
        />
        <FilterButton
          exclude
          text=""
          tabIndex={tabbable ? 0 : -1}
          label={`Exclude subject ${subject}`}
          onClick={() => onFilter(true)}
        />
      </span>
    </div>
  )
}

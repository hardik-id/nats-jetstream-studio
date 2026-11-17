import type { ReactNode, Ref } from 'react'
import { ChevronsDownUp, ChevronsUpDown, Search } from 'lucide-react'
import { Button, Checkbox, cx, Input, Select } from '../../components/ui'
import type { SubjectSort, SubjectSource } from './subjectTree'

export type LevelChoice = 1 | 2 | 3 | 'all'

const SOURCES: { id: SubjectSource; label: string; hint: string }[] = [
  { id: 'all', label: 'All', hint: 'Stored subjects and subjects seen in a live tail' },
  { id: 'streams', label: 'Streams', hint: 'Only subjects with stored messages' },
  { id: 'live', label: 'Live', hint: 'Only subjects seen in a live tail this session' }
]

const toolButton = (pressed?: boolean): string =>
  cx(
    'inline-flex h-7 items-center rounded border px-2.5 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50',
    pressed ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-fg'
  )

/** The search, expansion, sort and filter controls of the Subjects screen. */
export function SubjectsToolbar({
  searchRef,
  search,
  onSearch,
  matchCount,
  onExpandAll,
  onCollapseAll,
  onLevel,
  sort,
  onSort,
  onlyWithMessages,
  onOnlyWithMessages,
  source,
  onSource,
  disabled
}: {
  searchRef?: Ref<HTMLInputElement>
  search: string
  onSearch: (text: string) => void
  /** Number of matches while a search is active, otherwise null. */
  matchCount: number | null
  onExpandAll: () => void
  onCollapseAll: () => void
  onLevel: (level: LevelChoice) => void
  sort: SubjectSort
  onSort: (sort: SubjectSort) => void
  onlyWithMessages: boolean
  onOnlyWithMessages: (on: boolean) => void
  source: SubjectSource
  onSource: (source: SubjectSource) => void
  disabled?: boolean
}): ReactNode {
  return (
    <div
      role="toolbar"
      aria-label="Subject tree controls"
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-panel px-4 py-2"
    >
      <div className="relative w-56 max-w-full">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2 text-faint"
          aria-hidden
        />
        <Input
          ref={searchRef}
          compact
          type="search"
          className="pl-8"
          aria-label="Search subjects"
          placeholder="Search or pattern"
          title="Substring of the subject, or a subject pattern with * or >. Press / to jump here."
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && search) {
              e.preventDefault()
              e.stopPropagation()
              onSearch('')
            }
          }}
        />
      </div>
      {matchCount !== null && (
        <span role="status" className="text-xs whitespace-nowrap text-muted">
          {matchCount === 1 ? '1 match' : `${matchCount.toLocaleString('en-US')} matches`}
        </span>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <Button
          size="sm"
          icon={<ChevronsUpDown className="h-3.5 w-3.5" aria-hidden />}
          disabled={disabled}
          onClick={onExpandAll}
        >
          Expand all
        </Button>
        <Button
          size="sm"
          icon={<ChevronsDownUp className="h-3.5 w-3.5" aria-hidden />}
          disabled={disabled}
          onClick={onCollapseAll}
        >
          Collapse all
        </Button>
        <span className="inline-flex items-center gap-0.5" role="group" aria-label="Levels">
          <span className="pr-1 text-xs text-faint">Levels</span>
          {([1, 2, 3, 'all'] as LevelChoice[]).map((l) => (
            <button
              key={l}
              type="button"
              disabled={disabled}
              className={toolButton()}
              title={
                l === 'all' ? 'Open every level (up to 5,000 rows)' : `Open down to level ${l}`
              }
              onClick={() => onLevel(l)}
            >
              {l === 'all' ? 'All' : l}
            </button>
          ))}
        </span>
      </div>

      <label className="inline-flex items-center gap-1.5 text-xs text-muted">
        Sort
        <Select
          compact
          className="w-32"
          aria-label="Sort subjects"
          value={sort}
          onChange={(e) => onSort(e.target.value as SubjectSort)}
        >
          <option value="messages">Messages</option>
          <option value="name">Name (A-Z)</option>
          <option value="live">Live</option>
        </Select>
      </label>

      <Checkbox
        className="items-center text-xs text-muted"
        label="Only with messages"
        checked={onlyWithMessages}
        onChange={(e) => onOnlyWithMessages(e.target.checked)}
      />

      <span className="inline-flex items-center gap-0.5" role="group" aria-label="Source">
        <span className="pr-1 text-xs text-faint">Source</span>
        {SOURCES.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={source === s.id}
            title={s.hint}
            className={toolButton(source === s.id)}
            onClick={() => onSource(s.id)}
          >
            {s.label}
          </button>
        ))}
      </span>
    </div>
  )
}

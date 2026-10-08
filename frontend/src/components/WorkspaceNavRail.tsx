/**
 * Workspace navigation rail.
 *
 * The workspace views (FR-UI-06) live in a vertical tablist down the
 * left edge of the workspace rather than in the top bar, which leaves the
 * header for session identity and export actions. Follows the ARIA tabs
 * pattern for a vertical list: one tab stop, arrows to move between tabs.
 */

import { useRef } from 'react'

export type WorkspaceViewMode = 'map' | 'logs'

// Turn-by-turn is not a view of its own: it lives in the map's own drawer,
// next to the milestones it belongs with (FR-MAP-05).
const VIEWS = [
  { mode: 'map', label: 'Route Map', Icon: MapIcon },
  { mode: 'logs', label: 'Log Sheets', Icon: SheetIcon },
] as const

interface Props {
  value: WorkspaceViewMode
  onChange: (mode: WorkspaceViewMode) => void
}

export function WorkspaceNavRail({ value, onChange }: Props) {
  const tabs = useRef<Array<HTMLButtonElement | null>>([])

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = VIEWS.length - 1
    let next: number | null = null
    if (event.key === 'ArrowDown') next = index === last ? 0 : index + 1
    else if (event.key === 'ArrowUp') next = index === 0 ? last : index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next === null) return
    event.preventDefault()
    onChange(VIEWS[next].mode)
    tabs.current[next]?.focus()
  }

  return (
    <nav className="workspace-nav-rail no-print">
      <div className="nav-rail-tabs" role="tablist" aria-orientation="vertical" aria-label="Workspace view">
        {VIEWS.map(({ mode, label, Icon }, index) => (
          <button
            key={mode}
            ref={(element) => {
              tabs.current[index] = element
            }}
            type="button"
            role="tab"
            id={`tab-${mode}`}
            aria-selected={value === mode}
            aria-controls={`panel-${mode}`}
            tabIndex={value === mode ? 0 : -1}
            className={`nav-rail-tab font-sans${value === mode ? ' is-active' : ''}`}
            onClick={() => onChange(mode)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            <Icon />
            {/* Hidden at narrow widths, where the rail is icon-only. */}
            <span className="nav-rail-label">{label}</span>
          </button>
        ))}
      </div>
    </nav>
  )
}

function MapIcon() {
  return (
    <svg className="button-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M6 2.5 2.5 4v9.5L6 12l4 1.5 3.5-1.5V2.5L10 4 6 2.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M6 2.5V12M10 4v9.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function SheetIcon() {
  return (
    <svg className="button-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect
        x="2.25"
        y="3"
        width="11.5"
        height="10"
        rx="1"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <path d="M2.25 6.25h11.5M6 6.25V13M9.75 6.25V13" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

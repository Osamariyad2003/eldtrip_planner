/**
 * What the planner had to assume or work around, shown above the workspace.
 *
 * Two things the user cannot see from the map or the sheets:
 *
 *  - FR-RTE-02 / FR-INP-06 / INT-04 notices. When ORS is down the route is
 *    recomputed on a car profile, and truck times quietly stop applying. A
 *    plan that was degraded and does not say so is worse than one that failed.
 *  - FR-UI-07 assumptions. The engine assumes a fresh driver, a fixed cycle
 *    and a fuel interval; a reviewer comparing the output against their own
 *    arithmetic needs those stated, not inferred.
 *
 * Notices are always visible because they change how the output should be
 * read. Assumptions are one click away because they are the same every run.
 */

import { useState } from 'react'

interface Props {
  notices: string[]
  assumptions: string[]
}

export function PlanNotices({ notices, assumptions }: Props) {
  const [open, setOpen] = useState(false)

  if (notices.length === 0 && assumptions.length === 0) return null

  return (
    <div className="plan-notices no-print">
      {notices.length > 0 && (
        <ul className="notice-list" role="status" aria-label="Plan notices">
          {notices.map((notice) => (
            <li key={notice} className="notice-item font-sans">
              <WarningIcon />
              <span>{notice}</span>
            </li>
          ))}
        </ul>
      )}

      {assumptions.length > 0 && (
        <div className="assumptions-block">
          <button
            type="button"
            className="assumptions-toggle font-sans"
            onClick={() => setOpen((value) => !value)}
            aria-expanded={open}
            aria-controls="plan-assumptions"
          >
            <ChevronIcon open={open} />
            Planning assumptions
            <span className="assumptions-count font-mono">{assumptions.length}</span>
          </button>
          {open && (
            <ul id="plan-assumptions" className="assumptions-list font-sans">
              {assumptions.map((assumption) => (
                <li key={assumption}>{assumption}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function WarningIcon() {
  return (
    <svg className="notice-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M8 2.6 14.2 13H1.8L8 2.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8 6.4v3.1" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="8" cy="11.3" r="0.8" fill="currentColor" />
    </svg>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      className={`chevron-icon${open ? ' is-open' : ''}`}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M6 4.5 9.5 8 6 11.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

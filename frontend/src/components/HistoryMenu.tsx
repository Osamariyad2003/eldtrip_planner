/** Header dropdown listing recently planned trips from this browser. */

import { useEffect, useRef, useState } from 'react'

import { formatSavedAt, type HistoryEntry } from '../lib/history'
import { formatMiles } from '../lib/vocab'

interface Props {
  entries: HistoryEntry[]
  onOpen: (entry: HistoryEntry) => void
  onClear: () => void
  disabled?: boolean
}

export function HistoryMenu({ entries, onOpen, onClear, disabled }: Props) {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div className="history-menu" ref={boxRef}>
      <button
        type="button"
        className="button-top-ghost font-sans"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="menu"
        title="Recently planned trips"
      >
        <HistoryIcon />
        History
        {entries.length > 0 && <span className="history-count font-mono">{entries.length}</span>}
      </button>

      {open && (
        <div className="history-panel" role="menu" aria-label="Recent trips">
          <div className="history-panel-head">
            <span className="history-panel-title font-mono">Recent Trips</span>
            {entries.length > 0 && (
              <button type="button" className="history-clear font-sans" onClick={onClear}>
                Clear
              </button>
            )}
          </div>

          {entries.length === 0 ? (
            <p className="history-empty">
              No trips yet. Generated plans are saved here on this device.
            </p>
          ) : (
            <ul className="history-list">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="history-item"
                    role="menuitem"
                    disabled={disabled}
                    onClick={() => {
                      setOpen(false)
                      onOpen(entry)
                    }}
                  >
                    <span className="history-route">
                      <strong>{entry.from}</strong>
                      <span className="history-arrow" aria-hidden="true">
                        →
                      </span>
                      <strong>{entry.to}</strong>
                    </span>
                    <span className="history-meta font-mono">
                      {formatMiles(entry.totalMiles)} mi · {entry.numDays}d ·{' '}
                      {formatSavedAt(entry.savedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function HistoryIcon() {
  return (
    <svg className="button-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <path d="M2.2 2.9v2.6h2.6" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M8 5.2V8l2 1.3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

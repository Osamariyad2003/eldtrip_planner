/** The Daily Logs tab: day tabs, prev/next, PDF and print (FR-UI-06, FR-EXP). */

import { useCallback, useRef, useState } from 'react'

import { exportLogsToPdf, pdfFilename } from '../lib/pdf'
import type { TripPlan } from '../lib/types'
import { formatDate, formatHours } from '../lib/vocab'
import { LogSheet } from './LogSheet'

interface Props {
  plan: TripPlan
  onToast: (message: string) => void
}

export function LogView({ plan, onToast }: Props) {
  const logs = plan.daily_logs
  const [selectedDay, setSelectedDay] = useState(0)
  const [exporting, setExporting] = useState(false)
  const sheetHost = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])

  // A new plan can have fewer days than the one before it, so the visible day
  // is clamped during render rather than corrected in an effect afterwards.
  const day = Math.min(selectedDay, logs.length - 1)
  const setDay = setSelectedDay
  const current = logs[day]

  const onPdf = useCallback(async () => {
    const sheets = Array.from(
      sheetHost.current?.querySelectorAll<SVGSVGElement>('svg.log-sheet') ?? [],
    ).sort(
      (a, b) =>
        Number(a.dataset.dayIndex ?? 0) - Number(b.dataset.dayIndex ?? 0),
    )
    setExporting(true)
    try {
      await exportLogsToPdf(sheets, pdfFilename(logs[0].date, logs.length))
    } catch {
      onToast('PDF export failed. You can still use Print.')
    } finally {
      setExporting(false)
    }
  }, [logs, onToast])

  // Keyboard support for the tab list (NFR-ACC-01).
  const onTabKeyDown = (event: React.KeyboardEvent, index: number) => {
    const last = logs.length - 1
    let next: number | null = null
    if (event.key === 'ArrowRight') next = index === last ? 0 : index + 1
    else if (event.key === 'ArrowLeft') next = index === 0 ? last : index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    if (next !== null) {
      event.preventDefault()
      setDay(next)
      tabRefs.current[next]?.focus()
    }
  }

  return (
    <div className="log-view">
      <div className="log-toolbar no-print">
        <div className="log-tabs" role="tablist" aria-label="Log sheet days">
          {logs.map((log, index) => (
            <button
              key={log.date}
              ref={(element) => {
                tabRefs.current[index] = element
              }}
              type="button"
              role="tab"
              id={`day-tab-${index}`}
              aria-selected={index === day}
              aria-controls={`day-panel-${index}`}
              tabIndex={index === day ? 0 : -1}
              className={`log-tab${index === day ? ' is-active' : ''}`}
              onClick={() => setDay(index)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              <span className="log-tab-day">Day {index + 1}</span>
              <span className="log-tab-date">{formatDate(log.date)}</span>
            </button>
          ))}
        </div>
        <div className="log-actions">
          <button
            type="button"
            className="button-ghost"
            onClick={() => setDay((d) => Math.max(0, d - 1))}
            disabled={day === 0}
            aria-label="Previous day"
          >
            ◀ Prev
          </button>
          <button
            type="button"
            className="button-ghost"
            onClick={() => setDay((d) => Math.min(logs.length - 1, d + 1))}
            disabled={day >= logs.length - 1}
            aria-label="Next day"
          >
            Next ▶
          </button>
          <button type="button" className="button-primary compact" onClick={onPdf} disabled={exporting}>
            {exporting && <span className="button-spinner" aria-hidden="true" />}
            {exporting ? 'Building PDF…' : 'Download PDF'}
          </button>
          <button type="button" className="button-ghost" onClick={() => window.print()}>
            Print
          </button>
        </div>
      </div>

      <div className="log-day-summary no-print">
        <strong>{formatDate(current.date)}</strong>
        <span>
          Off {formatHours(current.totals.off_duty)} · SB {formatHours(current.totals.sleeper_berth)} ·
          Driving {formatHours(current.totals.driving)} · On duty{' '}
          {formatHours(current.totals.on_duty)}
        </span>
        <span>{current.miles_today.toLocaleString('en-US')} mi driven</span>
      </div>

      {/*
        Every day is mounted so the PDF export and Print can reach all of
        them; only the selected one is visible on screen.
      */}
      <div className="log-sheets" ref={sheetHost}>
        {logs.map((log, index) => (
          <div
            key={log.date}
            id={`day-panel-${index}`}
            role="tabpanel"
            aria-labelledby={`day-tab-${index}`}
            className={`log-sheet-page${index === day ? ' is-visible' : ''}`}
          >
            <LogSheet log={log} timezone={plan.summary.timezone} dayIndex={index} />
          </div>
        ))}
      </div>
    </div>
  )
}

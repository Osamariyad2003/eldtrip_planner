/**
 * Interactive ELD Log Sheet View for Spotter LogMaster (Right Panel).
 * Features multi-day horizontal tabs, real-time FMCSA duty status breakdown cards,
 * PDF export, and print action triggers.
 */

import { useCallback, useRef, useState } from 'react'

import { exportLogsToPdf, pdfFilename } from '../lib/pdf'
import type { TripPlan } from '../lib/types'
import { STATUS_COLOR, formatDate, formatHours } from '../lib/vocab'
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
      onToast('PDF export failed. You can still use Print Inspection Sheet.')
    } finally {
      setExporting(false)
    }
  }, [logs, onToast])

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
    <div className="log-view-panel">
      {/* Top Controls Toolbar */}
      <div className="log-view-header no-print">
        {/* Multi-day Horizontal Tabs */}
        <div className="log-day-tabs-container" role="tablist" aria-label="Daily Log Sheets">
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
              className={`log-day-tab${index === day ? ' is-active' : ''}`}
              onClick={() => setDay(index)}
              onKeyDown={(event) => onTabKeyDown(event, index)}
            >
              <span className="tab-day-number font-mono">Day {index + 1}</span>
              <span className="tab-day-date font-mono">{formatDate(log.date)}</span>
            </button>
          ))}
        </div>

        {/* Action Buttons */}
        <div className="log-view-actions">
          <button
            type="button"
            className="button-ghost compact"
            onClick={() => setDay((d) => Math.max(0, d - 1))}
            disabled={day === 0}
            aria-label="Previous Day"
          >
            ◀ Prev
          </button>
          <button
            type="button"
            className="button-ghost compact"
            onClick={() => setDay((d) => Math.min(logs.length - 1, d + 1))}
            disabled={day >= logs.length - 1}
            aria-label="Next Day"
          >
            Next ▶
          </button>
          <button
            type="button"
            className="button-primary compact"
            onClick={onPdf}
            disabled={exporting}
          >
            {exporting && <span className="button-spinner" aria-hidden="true" />}
            <span>{exporting ? 'Building PDF…' : '📄 Export Daily Log as PDF'}</span>
          </button>
          <button
            type="button"
            className="button-ghost compact"
            onClick={() => window.print()}
          >
            🖨️ Print Inspection Sheet
          </button>
        </div>
      </div>

      {/* FMCSA Real-Time Duty Status Summary Bar */}
      <div className="log-status-summary-bar no-print font-mono">
        <div className="status-chip" style={{ borderColor: `${STATUS_COLOR.off_duty}40` }}>
          <span className="status-chip-dot" style={{ backgroundColor: STATUS_COLOR.off_duty }} />
          <span className="status-chip-name">OFF:</span>
          <span className="status-chip-val">{formatHours(current.totals.off_duty)}h</span>
        </div>

        <div className="status-chip" style={{ borderColor: `${STATUS_COLOR.sleeper_berth}40` }}>
          <span className="status-chip-dot" style={{ backgroundColor: STATUS_COLOR.sleeper_berth }} />
          <span className="status-chip-name">SB:</span>
          <span className="status-chip-val">{formatHours(current.totals.sleeper_berth)}h</span>
        </div>

        <div className="status-chip" style={{ borderColor: `${STATUS_COLOR.driving}40` }}>
          <span className="status-chip-dot" style={{ backgroundColor: STATUS_COLOR.driving }} />
          <span className="status-chip-name">D:</span>
          <span className="status-chip-val">{formatHours(current.totals.driving)}h</span>
        </div>

        <div className="status-chip" style={{ borderColor: `${STATUS_COLOR.on_duty}40` }}>
          <span className="status-chip-dot" style={{ backgroundColor: STATUS_COLOR.on_duty }} />
          <span className="status-chip-name">ON:</span>
          <span className="status-chip-val">{formatHours(current.totals.on_duty)}h</span>
        </div>

        <div className="status-chip-miles">
          <span>Miles Today:</span>
          <strong>{current.miles_today.toLocaleString('en-US')} mi</strong>
        </div>
      </div>

      {/* Rendered Log Sheets Host */}
      <div className="log-sheets-viewport" ref={sheetHost}>
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

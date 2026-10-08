/**
 * Spotter LogMaster - Enterprise Fleet Trip Planning & FMCSA HOS Automation Dashboard.
 * Full-viewport (100vh) 3-column split workspace: Left Panel (360px), Center View, Right Panel (500px).
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { flushSync } from 'react-dom'

import { DriverStatusChip } from './components/DriverStatusChip'
import { HistoryMenu } from './components/HistoryMenu'
import { LiveStatusCard } from './components/LiveStatusCard'
import { LogView } from './components/LogView'
import { PlanNotices } from './components/PlanNotices'
import { RouteMilestonesDrawer } from './components/StopTimeline'
import { TripMap } from './components/TripMap'
import { TripForm } from './components/TripForm'
import { WorkspaceNavRail, type WorkspaceViewMode } from './components/WorkspaceNavRail'
import { ApiError, planTrip } from './lib/api'
import { EMPTY_FORM, SAMPLE_FORM, type FieldErrors, validate } from './lib/form'
import { clearHistory, type HistoryEntry, loadHistory, rememberTrip } from './lib/history'
import { useLiveStatus } from './lib/liveStatus'
import { exportLogsToPdf, pdfFilename } from './lib/pdf'
import type { TripFormState, TripPlan } from './lib/types'

interface Toast {
  message: string
  retry?: boolean
  requestId?: string
  /** The trip this toast is about, so Retry re-sends it and not a later edit. */
  failed?: TripFormState
}

const COLD_START_NOTICE_MS = 5000

export default function App() {
  const [form, setForm] = useState<TripFormState>(EMPTY_FORM)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [plan, setPlan] = useState<TripPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  const [stale, setStale] = useState(false)
  const [viewMode, setViewMode] = useState<WorkspaceViewMode>('map')
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory())
  const [selectedStop, setSelectedStop] = useState<number | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [toast, setToast] = useState<Toast | null>(null)
  const lastSubmitted = useRef<TripFormState | null>(null)

  const showToast = useCallback((message: string, extra?: Omit<Toast, 'message'>) => {
    setToast({ message, ...extra })
  }, [])

  const submit = useCallback(
    async (candidate: TripFormState) => {
      const found = validate(candidate)
      setErrors(found)
      if (Object.keys(found).length > 0) return

      setBusy(true)
      setSlow(false)
      setToast(null)
      const slowTimer = window.setTimeout(() => setSlow(true), COLD_START_NOTICE_MS)
      try {
        const resultPlan = await planTrip(candidate)
        setPlan(resultPlan)
        setStale(false)
        setSelectedStop(null)
        setStartedAt(null)
        lastSubmitted.current = candidate
        setHistory((entries) => rememberTrip(entries, candidate, resultPlan))
      } catch (cause) {
        if (cause instanceof ApiError) {
          if (Object.keys(cause.fields).length > 0) {
            setErrors(mapServerFields(cause.fields))
            if (cause.code !== 'validation_error' && cause.code !== 'not_found') {
              showToast(cause.message, { requestId: cause.requestId, failed: candidate })
            }
          } else {
            showToast(cause.message, {
              retry: ['provider_unavailable', 'network_error', 'rate_limited'].includes(cause.code),
              requestId: cause.requestId,
              failed: candidate,
            })
          }
        } else {
          showToast('Something went wrong during route calculation.', { failed: candidate })
        }
      } finally {
        window.clearTimeout(slowTimer)
        setBusy(false)
        setSlow(false)
      }
    },
    [showToast],
  )

  const onFormChange = (next: TripFormState) => {
    setForm(next)
    if (plan && lastSubmitted.current && !sameForm(next, lastSubmitted.current)) setStale(true)
  }

  const onSample = () => {
    setForm(SAMPLE_FORM)
    setErrors({})
    if (plan) setStale(true)
  }

  const onOpenHistory = (entry: HistoryEntry) => {
    setForm(entry.form)
    setErrors({})
    submit(entry.form)
  }

  const onClearHistory = () => setHistory(clearHistory())

  const handleTopPdfExport = async () => {
    if (!plan) return
    // The log sheets only exist in the DOM while the Log Sheets tab is open.
    if (viewMode !== 'logs') {
      setViewMode('logs')
      await nextPaint()
    }
    const sheets = Array.from(
      document.querySelectorAll<SVGSVGElement>('svg.log-sheet') ?? [],
    ).sort(
      (a, b) => Number(a.dataset.dayIndex ?? 0) - Number(b.dataset.dayIndex ?? 0),
    )
    if (sheets.length === 0) {
      showToast('Log sheets are not ready yet. Try the export again in a moment.')
      return
    }
    try {
      await exportLogsToPdf(sheets, pdfFilename(plan.daily_logs[0].date, plan.daily_logs.length))
    } catch {
      showToast('PDF export failed. You can still use Print Inspection Sheet.')
    }
  }

  /** FR-EXP-02: the sheets are only in the DOM while the Log Sheets tab is open. */
  const printLogSheets = useCallback(async () => {
    if (!plan) return
    if (viewMode !== 'logs') {
      setViewMode('logs')
      await nextPaint()
    }
    window.print()
  }, [plan, viewMode])

  // The browser's own print command bypasses the button, so the same switch
  // happens on beforeprint. flushSync lands the sheets in the DOM before the
  // browser snapshots the page.
  useEffect(() => {
    const onBeforePrint = () => {
      if (plan && viewMode !== 'logs') flushSync(() => setViewMode('logs'))
    }
    window.addEventListener('beforeprint', onBeforePrint)
    return () => window.removeEventListener('beforeprint', onBeforePrint)
  }, [plan, viewMode])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), toast.retry ? 15_000 : 8000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const live = useLiveStatus(plan, startedAt)

  return (
    <div className="telematics-dashboard-app">
      {/* Navigation Top Bar */}
      <header className="telematics-top-bar no-print">
        <div className="top-bar-inner">
          <div className="brand-group">
            <img src="/spotter_logo.jpg" alt="Spotter LogMaster" className="brand-logo-img" />
            <div>
              <div className="brand-title-row">
                <h1 className="brand-title">Spotter LogMaster</h1>
              </div>
            </div>
          </div>

          {/* Driver Status, History & Top Action Buttons */}
          <div className="top-bar-actions">
            <DriverStatusChip live={live} hasPlan={Boolean(plan)} />

            {plan && (
              <button
                type="button"
                className={`button-start-trip font-sans${startedAt !== null ? ' is-running' : ''}`}
                onClick={() => setStartedAt(startedAt === null ? Date.now() : null)}
                title={
                  startedAt === null
                    ? 'Follow this plan live from right now'
                    : 'Stop following the plan live'
                }
              >
                {startedAt === null ? <PlayIcon /> : <StopIcon />}
                {startedAt === null ? 'Start trip' : 'Stop'}
              </button>
            )}

            <span className="top-bar-divider" aria-hidden="true" />

            <HistoryMenu
              entries={history}
              onOpen={onOpenHistory}
              onClear={onClearHistory}
              disabled={busy}
            />

            <button
              type="button"
              className="button-top-primary font-sans"
              onClick={handleTopPdfExport}
              disabled={!plan || busy}
            >
              <DocumentIcon />
              Export Daily Log as PDF
            </button>
            <button
              type="button"
              className="button-top-ghost font-sans"
              onClick={printLogSheets}
              disabled={!plan || busy}
            >
              <PrinterIcon />
              Print Inspection Sheet
            </button>
          </div>
        </div>
      </header>

      {/* Main Full-Viewport Workspace */}
      <main className="telematics-main-workspace">
        {/* Left Panel (360px) */}
        <aside className="workspace-left-panel no-print">
          <TripForm
            form={form}
            errors={errors}
            busy={busy}
            stale={stale}
            onChange={onFormChange}
            onSubmit={() => submit(form)}
            onSample={onSample}
          />
        </aside>

        {/* View switcher rail, between the trip planner and the viewports */}
        <WorkspaceNavRail value={viewMode} onChange={setViewMode} />

        {/* Center & Right Viewports */}
        <section className="workspace-center-right">

          {/* Stale Warning Bar */}
          {stale && plan && (
            <div className="stale-warning-bar no-print font-sans" role="status">
              <span>⚠️ Inputs changed — press <strong>Generate ELD Trip Plan</strong> to update route and log sheets.</span>
            </div>
          )}

          {/* What the planner had to assume or work around (FR-RTE-02, FR-UI-07) */}
          {!busy && plan && (
            <PlanNotices notices={plan.notices} assumptions={plan.assumptions} />
          )}

          {/* Computation Skeleton Loader */}
          {busy && <TelematicsPlanSkeleton slow={slow} />}

          {/* Empty Workspace State */}
          {!busy && !plan && (
            <div className="empty-workspace-shell">
              <div className="empty-hero-card font-sans">
                <div className="hero-icon-wrapper">
                  <span className="hero-icon">🚛</span>
                </div>
                <h3 className="hero-title font-sans">Spotter LogMaster Fleet Planning</h3>
                <p className="hero-sub font-sans">
                  Enter origin, pickup, dropoff, and current cycle hours in the left control panel, or click <strong>⚡ Load Sample Trip</strong> to compute legal HOS driving chunks, interactive map geometry, and drawn DOT 24-hour daily logs.
                </p>
                <div className="hero-actions">
                  <button type="button" className="button-telematics-primary font-sans" onClick={onSample}>
                    ⚡ Load Sample Trip (Dallas &rarr; Chicago)
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Active Trip Workspace */}
          {!busy && plan && (
            <div className={`workspace-split-container mode-${viewMode}`}>
              {/* Map tab: interactive map & collapsible milestones drawer */}
              {viewMode === 'map' && (
                <div
                  className="workspace-center-pane"
                  role="tabpanel"
                  id="panel-map"
                  aria-labelledby="tab-map"
                >
                  <div className="map-wrapper-card">
                    <TripMap
                      plan={plan}
                      selectedIndex={selectedStop}
                      onSelect={setSelectedStop}
                    />
                    <LiveStatusCard live={live} />
                    <RouteMilestonesDrawer
                      plan={plan}
                      selectedIndex={selectedStop}
                      onSelect={setSelectedStop}
                    />
                  </div>
                </div>
              )}

              {/* Log Sheets tab: interactive SVG ELD daily logs */}
              {viewMode === 'logs' && (
                <div
                  className="workspace-right-pane"
                  role="tabpanel"
                  id="panel-logs"
                  aria-labelledby="tab-logs"
                >
                  <LogView plan={plan} onToast={showToast} />
                </div>
              )}
            </div>
          )}
        </section>
      </main>

      {/* Toast Alert Overlay */}
      {toast && (
        <div className="telematics-toast font-mono" role="alert">
          <p className="toast-message font-sans">{toast.message}</p>
          {toast.requestId && <p className="toast-id">Request ID: {toast.requestId}</p>}
          <div className="toast-actions">
            {toast.retry && (
              <button
                type="button"
                className="button-ghost compact"
                onClick={() => submit(toast.failed ?? form)}
              >
                Retry Calculation
              </button>
            )}
            <button
              type="button"
              className="button-ghost compact"
              onClick={() => setToast(null)}
              aria-label="Dismiss"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

/** Resolve after the browser has painted, so freshly mounted nodes exist. */
function nextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
}



function PlayIcon() {
  return (
    <svg className="button-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M5 3.2 12.2 8 5 12.8V3.2Z" fill="currentColor" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg className="button-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="4.2" y="4.2" width="7.6" height="7.6" rx="1.2" fill="currentColor" />
    </svg>
  )
}


function DocumentIcon() {
  return (
    <svg className="button-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M9.5 1.5H4.5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5l-3-3Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M9.25 1.75V4.5h2.75" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5.75 8.5h4.5M5.75 11h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}

function PrinterIcon() {
  return (
    <svg className="button-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M4.5 6.5v-4h7v4M4.5 12H3a1 1 0 0 1-1-1V7.5a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1V11a1 1 0 0 1-1 1h-1.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <rect x="4.5" y="10" width="7" height="4" rx="0.75" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

function TelematicsPlanSkeleton({ slow }: { slow: boolean }) {
  return (
    <div className="telematics-skeleton-shell" aria-busy="true">
      <div className="skeleton-header-bar skeleton-shimmer" />
      <div className="skeleton-grid">
        <div className="skeleton-card skeleton-shimmer" />
        <div className="skeleton-card skeleton-shimmer" />
      </div>
      <p className="skeleton-status-msg font-mono" role="status">
        {slow ? '⏳ Waking up backend telematics engine...' : '🛰️ Computing HOS driving chunks &amp; route geometry...'}
      </p>
    </div>
  )
}

function mapServerFields(fields: Record<string, string>): FieldErrors {
  const mapped: FieldErrors = {}
  for (const [key, message] of Object.entries(fields)) {
    const base = key.split('.')[0]
    const camel = base.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())
    mapped[key] = message
    mapped[base] ??= message
    mapped[camel] ??= message
  }
  return mapped
}

function sameForm(a: TripFormState, b: TripFormState): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** The app shell: form, Route and Daily Logs tabs, notices and footer. */

import { useCallback, useEffect, useRef, useState } from 'react'

import { LogView } from './components/LogView'
import { StopTimeline, Directions } from './components/StopTimeline'
import { TripMap } from './components/TripMap'
import { TripForm } from './components/TripForm'
import { AssumptionsPanel, TripSummaryPanel } from './components/TripSummaryPanel'
import { ApiError, planTrip } from './lib/api'
import { EMPTY_FORM, SAMPLE_FORM, type FieldErrors, validate } from './lib/form'
import type { TripFormState, TripPlan } from './lib/types'

type Tab = 'route' | 'logs'

/** FR-UI-08: after 5 s of waiting, warn about a cold free-tier server. */
const COLD_START_NOTICE_MS = 5000

export default function App() {
  const [form, setForm] = useState<TripFormState>(EMPTY_FORM)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [plan, setPlan] = useState<TripPlan | null>(null)
  const [busy, setBusy] = useState(false)
  const [slow, setSlow] = useState(false)
  const [stale, setStale] = useState(false)
  const [tab, setTab] = useState<Tab>('route')
  const [selectedStop, setSelectedStop] = useState<number | null>(null)
  const [toast, setToast] = useState<{ message: string; retry?: boolean; requestId?: string } | null>(
    null,
  )
  const lastSubmitted = useRef<TripFormState | null>(null)

  const showToast = useCallback((message: string, extra?: { retry?: boolean; requestId?: string }) => {
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
        const result = await planTrip(candidate)
        // WF-4: a new result replaces the old one entirely.
        setPlan(result)
        setStale(false)
        setSelectedStop(null)
        setTab('route')
        lastSubmitted.current = candidate
      } catch (cause) {
        if (cause instanceof ApiError) {
          // Section 10: field errors inline, everything else as a toast.
          if (Object.keys(cause.fields).length > 0) {
            setErrors(mapServerFields(cause.fields))
            if (cause.code !== 'validation_error' && cause.code !== 'not_found') {
              showToast(cause.message, { requestId: cause.requestId })
            }
          } else {
            showToast(cause.message, {
              retry: ['provider_unavailable', 'network_error', 'rate_limited'].includes(cause.code),
              requestId: cause.requestId,
            })
          }
        } else {
          showToast('Something went wrong.')
        }
      } finally {
        window.clearTimeout(slowTimer)
        setBusy(false)
        setSlow(false)
      }
    },
    [showToast],
  )

  // WF-4: editing inputs after a result dims it until the next plan.
  const onFormChange = (next: TripFormState) => {
    setForm(next)
    if (plan && lastSubmitted.current && !sameForm(next, lastSubmitted.current)) setStale(true)
  }

  const onSample = () => {
    setForm(SAMPLE_FORM)
    setErrors({})
    if (plan) setStale(true)
  }

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), toast.retry ? 15_000 : 8000)
    return () => window.clearTimeout(timer)
  }, [toast])

  return (
    <div className="app">
      <header className="app-header no-print">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ELD
          </span>
          <div>
            <h1 className="brand-title">Trip Planner</h1>
            <p className="brand-sub">Hours of Service schedules and daily log sheets</p>
          </div>
        </div>
      </header>

      <main className="app-body">
        <aside className="app-sidebar no-print">
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

        <section className="app-main">
          {plan && (
            <nav className="tabs no-print" role="tablist" aria-label="Result views">
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'route'}
                className={`tab${tab === 'route' ? ' is-active' : ''}`}
                onClick={() => setTab('route')}
              >
                Route
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === 'logs'}
                className={`tab${tab === 'logs' ? ' is-active' : ''}`}
                onClick={() => setTab('logs')}
              >
                Daily Logs
                <span className="tab-count">{plan.daily_logs.length}</span>
              </button>
            </nav>
          )}

          {busy && <PlanSkeleton slow={slow} />}

          {!busy && !plan && (
            <div className="result-shell">
              <TripMap plan={null} selectedIndex={null} onSelect={() => {}} />
            </div>
          )}

          {!busy && plan && (
            <div className={`result-shell${stale ? ' is-stale' : ''}`}>
              {stale && (
                <p className="stale-banner no-print" role="status">
                  Inputs changed — press Plan to update.
                </p>
              )}
              {plan.notices.length > 0 && (
                <ul className="notices no-print">
                  {plan.notices.map((notice) => (
                    <li key={notice}>{notice}</li>
                  ))}
                </ul>
              )}

              {tab === 'route' ? (
                <div className="route-layout">
                  <TripMap plan={plan} selectedIndex={selectedStop} onSelect={setSelectedStop} />
                  <div className="route-panels">
                    <TripSummaryPanel plan={plan} />
                    <StopTimeline
                      stops={plan.stops}
                      selectedIndex={selectedStop}
                      onSelect={setSelectedStop}
                    />
                    <Directions legs={plan.route.legs} />
                    <AssumptionsPanel assumptions={plan.assumptions} />
                  </div>
                </div>
              ) : (
                <LogView plan={plan} onToast={showToast} />
              )}
            </div>
          )}
        </section>
      </main>

      <footer className="app-footer no-print">
        {/* FR-UI-09 */}
        <p className="disclaimer">
          Planning tool — projected logs, not an FMCSA-registered ELD.
        </p>
        <p className="attribution">
          Map data &copy;{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap
          </a>{' '}
          contributors · Tiles &copy;{' '}
          <a href="https://carto.com/attributions" target="_blank" rel="noreferrer">
            CARTO
          </a>{' '}
          · Routing and geocoding by{' '}
          <a href="https://openrouteservice.org/" target="_blank" rel="noreferrer">
            OpenRouteService
          </a>
        </p>
      </footer>

      {toast && (
        <div className="toast" role="alert">
          <p>{toast.message}</p>
          {toast.requestId && <p className="toast-id">Request {toast.requestId}</p>}
          <div className="toast-actions">
            {toast.retry && (
              <button type="button" className="button-ghost compact" onClick={() => submit(form)}>
                Retry
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

/** FR-UI-08: skeleton placeholders while planning. */
function PlanSkeleton({ slow }: { slow: boolean }) {
  return (
    <div className="result-shell" aria-busy="true">
      <div className="skeleton-map skeleton" />
      <div className="skeleton-panels">
        <div className="skeleton skeleton-row" />
        <div className="skeleton skeleton-row" />
        <div className="skeleton skeleton-row short" />
      </div>
      <p className="skeleton-status" role="status">
        {slow ? 'Waking up the server, this can take up to a minute.' : 'Planning your trip…'}
      </p>
    </div>
  )
}

/** Map the server's dotted field paths onto the form's error keys. */
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

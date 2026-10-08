/**
 * Recent trip history.
 *
 * Persistent storage of trips is out of scope for the backend (SRS section 1),
 * so history lives in this browser only. Entries keep the submitted form plus
 * a small summary; re-opening one re-plans rather than replaying a stored
 * result, which keeps the payload small and the plan fresh.
 */

import type { TripFormState, TripPlan } from './types'

const STORAGE_KEY = 'spotter.trip-history.v1'
const MAX_ENTRIES = 10

export interface HistoryEntry {
  id: string
  savedAt: number
  from: string
  to: string
  totalMiles: number
  numDays: number
  form: TripFormState
}

export function loadHistory(): HistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isEntry).slice(0, MAX_ENTRIES)
  } catch {
    // Private mode, blocked storage or corrupt JSON: history is a convenience.
    return []
  }
}

/** Prepend a trip, de-duplicating by route so repeated runs do not pile up. */
export function rememberTrip(
  existing: HistoryEntry[],
  form: TripFormState,
  plan: TripPlan,
): HistoryEntry[] {
  const entry: HistoryEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    savedAt: Date.now(),
    from: form.current.label,
    to: form.dropoff.label,
    totalMiles: plan.summary.total_miles,
    numDays: plan.summary.num_days,
    form,
  }
  const sameRoute = (other: HistoryEntry) =>
    other.from === entry.from && other.to === entry.to && other.form.pickup.label === form.pickup.label
  const next = [entry, ...existing.filter((other) => !sameRoute(other))].slice(0, MAX_ENTRIES)
  persist(next)
  return next
}

export function clearHistory(): HistoryEntry[] {
  persist([])
  return []
}

function persist(entries: HistoryEntry[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries))
  } catch {
    // Storage full or unavailable; the in-memory list still works this session.
  }
}

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Partial<HistoryEntry>
  return (
    typeof entry.id === 'string' &&
    typeof entry.savedAt === 'number' &&
    typeof entry.from === 'string' &&
    typeof entry.to === 'string' &&
    isForm(entry.form)
  )
}

/**
 * Re-opening an entry re-plans it, so a half-written or hand-edited record
 * would throw on submit. Anything that is not a usable form is dropped here.
 */
function isForm(value: unknown): value is TripFormState {
  if (typeof value !== 'object' || value === null) return false
  const form = value as Partial<TripFormState>
  return (
    isLocation(form.current) &&
    isLocation(form.pickup) &&
    isLocation(form.dropoff) &&
    typeof form.cycleUsedHr === 'string'
  )
}

function isLocation(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  const location = value as Partial<TripFormState['current']>
  return typeof location.label === 'string'
}

export function formatSavedAt(savedAt: number): string {
  const minutes = Math.round((Date.now() - savedAt) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return new Date(savedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

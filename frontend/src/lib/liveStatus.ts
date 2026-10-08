/**
 * "What is the driver doing right now?"
 *
 * The plan is projected rather than telemetry, so "now" means: wall-clock time
 * falls inside a duty event's window. API timestamps carry the trip's UTC
 * offset, so they compare directly against Date.now().
 */

import { useEffect, useMemo, useState } from 'react'

import type { DutyEvent, TripPlan } from './types'

/** How often to re-check whether the active event changed. */
const TICK_MS = 30_000

export type LivePhase = 'before' | 'during' | 'after'

export interface LiveStatus {
  /** The event containing `now`, or null when the trip is not under way. */
  event: DutyEvent | null
  /** Where now sits relative to the whole trip window. */
  phase: LivePhase
  /** 0-100 through the active event; 0 when there is none. */
  progress: number
  /** Whole minutes until the active event ends; 0 when there is none. */
  remainingMin: number
  /** Position on the plan's timeline, which "Start trip" shifts to now. */
  now: number
}

/**
 * @param startedAt When the driver pressed "Start trip", if they did. Real time
 *   elapsed since then is mapped onto the plan's own timeline, so a projected
 *   schedule can be followed live without re-planning it for the current clock.
 */
export function useLiveStatus(plan: TripPlan | null, startedAt: number | null = null): LiveStatus {
  const [wallClock, setWallClock] = useState(() => Date.now())

  useEffect(() => {
    if (!plan) return
    const timer = window.setInterval(() => setWallClock(Date.now()), TICK_MS)
    return () => window.clearInterval(timer)
  }, [plan])

  const now =
    plan && startedAt !== null
      ? Date.parse(plan.summary.trip_start) + (wallClock - startedAt)
      : wallClock

  return useMemo(() => {
    if (!plan) return { event: null, phase: 'before', progress: 0, remainingMin: 0, now }

    const start = Date.parse(plan.summary.trip_start)
    const end = Date.parse(plan.summary.trip_end)
    const phase: LivePhase = now < start ? 'before' : now >= end ? 'after' : 'during'

    const event = activeEvent(plan.events, now)
    if (!event) return { event: null, phase, progress: 0, remainingMin: 0, now }

    const from = Date.parse(event.start)
    const to = Date.parse(event.end)
    const span = to - from
    const progress = span > 0 ? Math.min(100, Math.max(0, ((now - from) / span) * 100)) : 0
    const remainingMin = Math.max(0, Math.round((to - now) / 60_000))

    return { event, phase, progress, remainingMin, now }
  }, [plan, now])
}

/** The event whose [start, end) window contains `now`, if any. */
export function activeEvent(events: DutyEvent[], now: number): DutyEvent | null {
  for (const event of events) {
    if (now >= Date.parse(event.start) && now < Date.parse(event.end)) return event
  }
  return null
}

export function formatRemaining(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

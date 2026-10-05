/** Shared labels, colours and marker shapes for stops and duty statuses.
 *
 * FR-MAP-02 requires icons that differ in shape, not only colour, so each
 * stop kind carries both a hue and a distinct glyph.
 */

import type { DutyStatus, EventKind } from './types'

export const STATUS_ROWS: DutyStatus[] = ['off_duty', 'sleeper_berth', 'driving', 'on_duty']

export const STATUS_LABEL: Record<DutyStatus, string> = {
  off_duty: 'Off Duty',
  sleeper_berth: 'Sleeper Berth',
  driving: 'Driving',
  on_duty: 'On Duty (not driving)',
}

export const STATUS_SHORT: Record<DutyStatus, string> = {
  off_duty: 'OFF',
  sleeper_berth: 'SB',
  driving: 'D',
  on_duty: 'ON',
}

export interface StopStyle {
  label: string
  color: string
  /** A single glyph, so markers are distinguishable without colour. */
  glyph: string
  shape: 'circle' | 'square' | 'diamond' | 'triangle' | 'pin'
}

export const STOP_STYLE: Record<string, StopStyle> = {
  start: { label: 'Trip start', color: '#1e6f3f', glyph: 'S', shape: 'pin' },
  pre_trip: { label: 'Pre-trip inspection', color: '#1e6f3f', glyph: 'S', shape: 'pin' },
  pickup: { label: 'Pickup', color: '#1f5fa8', glyph: 'P', shape: 'square' },
  dropoff: { label: 'Dropoff', color: '#7a2d8f', glyph: 'D', shape: 'diamond' },
  fuel: { label: 'Fuel stop', color: '#b4620a', glyph: 'F', shape: 'triangle' },
  break: { label: '30-min break', color: '#8a6d00', glyph: 'B', shape: 'circle' },
  rest_10: { label: '10-hr rest', color: '#3a4a9e', glyph: 'R', shape: 'circle' },
  restart_34: { label: '34-hr restart', color: '#a01f36', glyph: '34', shape: 'circle' },
  post_trip: { label: 'Post-trip inspection', color: '#1e6f3f', glyph: 'E', shape: 'pin' },
  off: { label: 'Off duty', color: '#5b6470', glyph: 'O', shape: 'circle' },
  drive: { label: 'Driving', color: '#2f6f4f', glyph: '>', shape: 'circle' },
}

export function stopStyle(kind: EventKind | string): StopStyle {
  return STOP_STYLE[kind] ?? STOP_STYLE.off
}

/** Hours as the log sheet reads them: one or two decimals, no trailing zeros. */
export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0$/, '')
}

export function formatMiles(miles: number): string {
  return miles.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

/** Minutes from midnight as HH:MM, with 1,440 shown as 24:00. */
export function minuteToClock(minute: number): string {
  if (minute >= 1440) return '24:00'
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/**
 * An ISO timestamp's wall-clock time, read exactly as the server sent it.
 *
 * The plan is already expressed in the log time zone (API-04), so the offset
 * in the string is authoritative and must not be re-interpreted in the
 * browser's local zone.
 */
export function clockFromIso(iso: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(iso)
  return match ? `${match[1]}:${match[2]}` : ''
}

export function dateFromIso(iso: string): string {
  return iso.slice(0, 10)
}

/** "Mon 3 Mar" for tabs and popups, from a plain YYYY-MM-DD date. */
export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

export function formatDateLong(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

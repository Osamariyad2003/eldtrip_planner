/** Shared labels, colours and marker shapes for stops and duty statuses.
 * Samsara Enterprise Design Tokens: Daintree Navy #00263E, Cyan #00A3C4, Emerald #059669.
 * FMCSA Official Duty Status Tokens: OFF #64748B, SB #6366F1, D #059669, ON #D97706.
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

/** FMCSA Official Duty Status Brand Colors */
export const STATUS_COLOR: Record<DutyStatus, string> = {
  off_duty: '#64748B',      // OFF (Off Duty): Slate Gray #64748B
  sleeper_berth: '#6366F1', // SB (Sleeper Berth): Indigo #6366F1
  driving: '#059669',       // D (Driving): Emerald Green #059669
  on_duty: '#D97706',       // ON (On Duty Not Driving): Amber #D97706
}

export interface StopStyle {
  label: string
  color: string
  glyph: string
  shape: 'circle' | 'square' | 'diamond' | 'triangle' | 'pin'
}

export const STOP_STYLE: Record<string, StopStyle> = {
  start: { label: 'Trip Start', color: '#00263E', glyph: '🚀', shape: 'pin' },
  pre_trip: { label: 'Pre-trip Inspection', color: '#059669', glyph: '📋', shape: 'pin' },
  pickup: { label: 'Pickup (1h Loading)', color: '#FFC700', glyph: '📦', shape: 'square' },
  dropoff: { label: 'Dropoff (1h Unloading)', color: '#E11D48', glyph: '🎯', shape: 'diamond' },
  fuel: { label: 'Fuel Stop (≤1,000 mi)', color: '#FFC700', glyph: '⛽', shape: 'triangle' },
  break: { label: '30-min Break', color: '#059669', glyph: '☕', shape: 'circle' },
  rest_10: { label: '10-hr Rest', color: '#6366F1', glyph: '🌙', shape: 'circle' },
  restart_34: { label: '34-hr Restart', color: '#DC2626', glyph: '34', shape: 'circle' },
  post_trip: { label: 'Post-trip Inspection', color: '#059669', glyph: '✅', shape: 'pin' },
  off: { label: 'Off Duty', color: '#64748B', glyph: 'O', shape: 'circle' },
  drive: { label: 'Driving', color: '#059669', glyph: '>', shape: 'circle' },
}

export function stopStyle(kind: EventKind | string): StopStyle {
  return STOP_STYLE[kind] ?? STOP_STYLE.off
}

export function formatHours(hours: number): string {
  const rounded = Math.round(hours * 100) / 100
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0$/, '')
}

export function formatMiles(miles: number): string {
  return miles.toLocaleString('en-US', { maximumFractionDigits: 1 })
}

export function minuteToClock(minute: number): string {
  if (minute >= 1440) return '24:00'
  const h = Math.floor(minute / 60)
  const m = minute % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

export function clockFromIso(iso: string): string {
  const match = /T(\d{2}):(\d{2})/.exec(iso)
  return match ? `${match[1]}:${match[2]}` : ''
}

export function dateFromIso(iso: string): string {
  return iso.slice(0, 10)
}

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

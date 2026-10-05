/** Form defaults and client-side validation, mirroring section 4.1.
 *
 * The server revalidates everything (NFR-SEC-03); these rules only let the
 * form report problems before a request is made.
 */

import type { LocationInput, TripFormState } from './types'

const CYCLE_MAX = 70
const TEXT_MAX = 80
const DAY_MS = 86_400_000

export const EMPTY_LOCATION: LocationInput = { label: '', lat: null, lng: null }

export const EMPTY_FORM: TripFormState = {
  current: { ...EMPTY_LOCATION },
  pickup: { ...EMPTY_LOCATION },
  dropoff: { ...EMPTY_LOCATION },
  cycleUsedHr: '',
  startTime: '',
  driver: '',
  carrier: '',
  mainOffice: '',
  homeTerminal: '',
  vehicle: '',
  shipper: '',
  commodity: '',
}

/** FR-INP-04: Dallas → Oklahoma City → Chicago with 22.5 hrs cycle used. */
export const SAMPLE_FORM: TripFormState = {
  ...EMPTY_FORM,
  current: { label: 'Dallas, TX', lat: 32.7767, lng: -96.797 },
  pickup: { label: 'Oklahoma City, OK', lat: 35.4676, lng: -97.5164 },
  dropoff: { label: 'Chicago, IL', lat: 41.8781, lng: -87.6298 },
  cycleUsedHr: '22.5',
}

export type FieldErrors = Record<string, string>

const TEXT_FIELDS = [
  'driver',
  'carrier',
  'mainOffice',
  'homeTerminal',
  'vehicle',
  'shipper',
  'commodity',
] as const

export function validate(form: TripFormState): FieldErrors {
  const errors: FieldErrors = {}

  // FR-INP-01
  for (const key of ['current', 'pickup', 'dropoff'] as const) {
    const label = form[key].label.trim()
    if (!label) errors[key] = 'Enter a location.'
    else if (label.length < 2) errors[key] = 'Enter at least 2 characters.'
  }

  // FR-INP-02
  const raw = form.cycleUsedHr.trim()
  if (!raw) {
    errors.cycle_used_hr = 'Enter your cycle hours used.'
  } else {
    const hours = Number(raw)
    if (!Number.isFinite(hours)) errors.cycle_used_hr = 'Enter a number.'
    else if (hours < 0 || hours > CYCLE_MAX) errors.cycle_used_hr = 'Enter 0–70 hours.'
  }

  // FR-INP-03
  if (form.startTime) {
    const when = new Date(form.startTime).getTime()
    if (Number.isNaN(when)) errors.start_time = 'Enter a valid date and time.'
    else if (when < Date.now() - 7 * DAY_MS) errors.start_time = 'No more than 7 days in the past.'
    else if (when > Date.now() + 365 * DAY_MS) errors.start_time = 'No more than a year ahead.'
  }
  for (const key of TEXT_FIELDS) {
    if (form[key].length > TEXT_MAX) errors[key] = `Keep this under ${TEXT_MAX} characters.`
  }
  return errors
}

export function isValid(form: TripFormState): boolean {
  return Object.keys(validate(form)).length === 0
}

/** The hint under the cycle field: how much of the 70 hours is left. */
export function cycleAvailable(raw: string): number | null {
  const hours = Number(raw.trim())
  if (raw.trim() === '' || !Number.isFinite(hours) || hours < 0 || hours > CYCLE_MAX) return null
  return CYCLE_MAX - Math.round(hours * 4) / 4
}

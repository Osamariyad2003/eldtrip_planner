/** The API client. All provider calls happen server-side (FR-SYS-02). */

import type { ApiErrorBody, Place, TripFormState, TripPlan } from './types'

const BASE = (import.meta.env.VITE_API_URL ?? 'http://localhost:8000').replace(/\/$/, '')

/** No response within 90 s is treated as unreachable (section 10). */
const REQUEST_TIMEOUT_MS = 90_000

export class ApiError extends Error {
  code: string
  fields: Record<string, string>
  requestId: string

  constructor(code: string, message: string, fields: Record<string, string> = {}, requestId = '') {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.fields = fields
    this.requestId = requestId
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  let response: Response
  try {
    response = await fetch(`${BASE}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    })
  } catch (cause) {
    const aborted = cause instanceof DOMException && cause.name === 'AbortError'
    throw new ApiError(
      'network_error',
      aborted ? 'Server not reachable — the request timed out.' : 'Server not reachable.',
    )
  } finally {
    window.clearTimeout(timer)
  }

  const requestId = response.headers.get('X-Request-ID') ?? ''
  if (!response.ok) {
    let body: ApiErrorBody | undefined
    try {
      body = (await response.json()) as ApiErrorBody
    } catch {
      /* a non-JSON error body, e.g. a gateway page */
    }
    const error = body?.error
    throw new ApiError(
      error?.code ?? 'request_failed',
      error?.message ?? `Request failed (${response.status}).`,
      error?.fields ?? {},
      error?.request_id || requestId,
    )
  }
  return (await response.json()) as T
}

/** API-02: up to 5 US suggestions. */
export function geocode(query: string, signal?: AbortSignal): Promise<Place[]> {
  return request<Place[]>(`/api/geocode/?q=${encodeURIComponent(query)}`, { signal })
}

/** API-01: plan the trip. */
export function planTrip(form: TripFormState): Promise<TripPlan> {
  return request<TripPlan>('/api/trips/plan/', {
    method: 'POST',
    body: JSON.stringify(toRequestBody(form)),
  })
}

export function toRequestBody(form: TripFormState): Record<string, unknown> {
  const location = (input: TripFormState['current']) =>
    input.lat !== null && input.lng !== null
      ? { label: input.label, lat: input.lat, lng: input.lng }
      : { label: input.label }

  const body: Record<string, unknown> = {
    current: location(form.current),
    pickup: location(form.pickup),
    dropoff: location(form.dropoff),
    cycle_used_hr: Number(form.cycleUsedHr),
  }
  // Optional "Log details" fields are sent only when filled, so the server
  // applies its BR-PLN-07 defaults.
  const optional: Array<[keyof TripFormState, string]> = [
    ['startTime', 'start_time'],
    ['driver', 'driver'],
    ['carrier', 'carrier'],
    ['mainOffice', 'main_office'],
    ['homeTerminal', 'home_terminal'],
    ['vehicle', 'vehicle'],
    ['shipper', 'shipper'],
    ['commodity', 'commodity'],
  ]
  for (const [key, field] of optional) {
    const value = form[key]
    if (typeof value === 'string' && value.trim()) {
      body[field] = field === 'start_time' ? new Date(value).toISOString() : value.trim()
    }
  }
  return body
}

export function healthUrl(): string {
  return `${BASE}/api/health/`
}

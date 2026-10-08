/** Response types mirroring the API contract in section 7.1 / 8.1. */

export type DutyStatus = 'off_duty' | 'sleeper_berth' | 'driving' | 'on_duty'

export type EventKind =
  | 'pre_trip'
  | 'drive'
  | 'pickup'
  | 'dropoff'
  | 'fuel'
  | 'break'
  | 'rest_10'
  | 'restart_34'
  | 'post_trip'
  | 'off'

export interface Place {
  label: string
  lat: number
  lng: number
  city?: string
  state?: string
}

export interface Instruction {
  text: string
  distance_mi: number
  duration_min: number
  /** Where the manoeuvre happens; null when the provider did not report it. */
  lat: number | null
  lng: number | null
}

export interface RouteLeg {
  from_label: string
  to_label: string
  distance_mi: number
  duration_hr: number
  geometry: [number, number][]
  instructions: Instruction[]
}

export interface DutyEvent {
  status: DutyStatus
  kind: EventKind
  start: string
  end: string
  duration_hr: number
  miles_start: number
  miles_end: number
  lat: number | null
  lng: number | null
  location: string
  note: string
}

export interface Stop extends DutyEvent {
  miles_from_start: number
}

export interface LogSegment {
  status: DutyStatus
  start_min: number
  end_min: number
  kind: string
}

export interface Remark {
  minute: number
  location: string
  note: string
}

export interface Bracket {
  start_min: number
  end_min: number
}

export interface Recap {
  on_duty_today: number
  total_last_8_days: number
  available_tomorrow: number
  restart_taken: boolean
}

export interface LogHeader {
  date: string
  driver: string
  co_driver: string
  carrier: string
  main_office: string
  home_terminal: string
  vehicle: string
  shipper: string
  commodity: string
  shipping_document: string
  from_label: string
  to_label: string
  miles_today: number
  [key: string]: string | number
}

export interface DailyLog {
  date: string
  day_index: number
  miles_today: number
  header: LogHeader
  segments: LogSegment[]
  totals: Record<DutyStatus, number>
  remarks: Remark[]
  brackets: Bracket[]
  recap: Recap
}

export interface TripSummary {
  total_miles: number
  driving_hours: number
  on_duty_hours: number
  trip_start: string
  trip_end: string
  total_elapsed_hours: number
  num_days: number
  num_fuel_stops: number
  num_rests: number
  num_restarts: number
  timezone: string
  routing_provider: string
}

export interface TripPlan {
  summary: TripSummary
  route: { geometry: [number, number][]; legs: RouteLeg[] }
  stops: Stop[]
  events: DutyEvent[]
  daily_logs: DailyLog[]
  notices: string[]
  assumptions: string[]
}

/** The form's own state, before it becomes a request body. */
export interface LocationInput {
  label: string
  lat: number | null
  lng: number | null
}

export interface TripFormState {
  current: LocationInput
  pickup: LocationInput
  dropoff: LocationInput
  cycleUsedHr: string
  startTime: string
  driver: string
  carrier: string
  mainOffice: string
  homeTerminal: string
  vehicle: string
  shipper: string
  commodity: string
}

/** Section 10 error body. */
export interface ApiErrorBody {
  error: {
    code: string
    message: string
    fields: Record<string, string>
    request_id: string
  }
}

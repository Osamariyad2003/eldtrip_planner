/**
 * Live duty-status card over the map.
 *
 * Shows whatever the projected schedule has the driver doing at the current
 * wall-clock time: rolling, resting, sleeping or working on duty. The artwork
 * switches between a moving cab and a parked one; everything else is driven by
 * the FMCSA status colour so the card matches the log sheet.
 */

import type { DutyStatus, EventKind } from '../lib/types'
import { formatRemaining, type LiveStatus } from '../lib/liveStatus'
import { clockFromIso, formatMiles, STATUS_COLOR, STATUS_LABEL, stopStyle } from '../lib/vocab'

/**
 * Artwork for the specific thing the driver is doing. Kind is more precise
 * than status — fuelling and unloading are both "on duty" but look nothing
 * alike — so kind is matched first and status is only the fallback.
 */
const ART_BY_KIND: Partial<Record<EventKind, string>> = {
  drive: '/driving_now.gif',
  fuel: '/fuel_now.gif',
  pickup: '/pickup_now.gif',
  dropoff: '/dropoff_now.gif',
  break: '/break_now.gif',
}

/** Anything without its own art falls back to the parked cab. */
const ART_BY_STATUS: Record<DutyStatus, string> = {
  driving: '/driving_now.gif',
  off_duty: '/parked_now.gif',
  sleeper_berth: '/parked_now.gif',
  on_duty: '/parked_now.gif',
}

const EYEBROW: Record<DutyStatus, string> = {
  driving: 'Driving now',
  off_duty: 'Off duty now',
  sleeper_berth: 'Sleeper berth',
  on_duty: 'On duty now',
}

interface Props {
  live: LiveStatus
}

export function LiveStatusCard({ live }: Props) {
  const { event, progress, remainingMin } = live
  if (!event) return null

  const color = STATUS_COLOR[event.status]
  // The event kind is more specific than the status: "30-min Break" beats
  // "Off Duty" when both are true.
  const detail = stopStyle(event.kind).label
  const art = ART_BY_KIND[event.kind] ?? ART_BY_STATUS[event.status]

  return (
    <aside
      className={`live-status-card status-${event.status}`}
      style={{ '--status-color': color } as React.CSSProperties}
      role="status"
      aria-live="polite"
      aria-label={`${STATUS_LABEL[event.status]} — ${detail}, ${formatRemaining(remainingMin)} remaining`}
    >
      <img className="live-status-art" src={art} alt="" aria-hidden="true" />

      <div className="live-status-body">
        <p className="live-status-eyebrow font-mono">
          <span className="live-status-pulse" aria-hidden="true" />
          {EYEBROW[event.status]}
        </p>
        <p className="live-status-detail">{detail}</p>
        <p className="live-status-place">{event.location || 'En route'}</p>

        <div className="live-status-track" aria-hidden="true">
          <span className="live-status-fill" style={{ width: `${progress}%` }} />
        </div>

        <dl className="live-status-meta font-mono">
          <div>
            <dt>Until</dt>
            <dd>{clockFromIso(event.end)}</dd>
          </div>
          <div>
            <dt>Left</dt>
            <dd>{formatRemaining(remainingMin)}</dd>
          </div>
          <div>
            <dt>Odo</dt>
            <dd>{formatMiles(event.miles_end)} mi</dd>
          </div>
        </dl>
      </div>
    </aside>
  )
}

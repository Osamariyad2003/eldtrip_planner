/** Header chip: the driver's projected duty status at the current moment. */

import type { LiveStatus } from '../lib/liveStatus'
import { formatRemaining } from '../lib/liveStatus'
import { STATUS_COLOR, STATUS_SHORT, STATUS_LABEL } from '../lib/vocab'

interface Props {
  live: LiveStatus
  hasPlan: boolean
}

export function DriverStatusChip({ live, hasPlan }: Props) {
  if (!hasPlan) {
    return (
      <div className="driver-status-chip is-idle font-sans" title="No trip planned">
        <span className="driver-status-dot" />
        <span className="driver-status-text">No trip</span>
      </div>
    )
  }

  const { event, phase, remainingMin } = live

  if (!event) {
    const text = phase === 'before' ? 'Not started' : 'Trip complete'
    return (
      <div className="driver-status-chip is-idle font-sans" title={text}>
        <span className="driver-status-dot" />
        <span className="driver-status-text">{text}</span>
      </div>
    )
  }

  const color = STATUS_COLOR[event.status]
  return (
    <div
      className={`driver-status-chip is-live font-sans${event.status === 'driving' ? ' is-driving' : ''}`}
      style={{ '--status-color': color } as React.CSSProperties}
      title={`${STATUS_LABEL[event.status]} — ${formatRemaining(remainingMin)} remaining`}
    >
      <span className="driver-status-dot" />
      <span className="driver-status-code font-mono">{STATUS_SHORT[event.status]}</span>
      <span className="driver-status-text">{STATUS_LABEL[event.status]}</span>
      <span className="driver-status-time font-mono">{formatRemaining(remainingMin)}</span>
    </div>
  )
}

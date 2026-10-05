/** The ordered stop list (FR-MAP-04) and the per-leg directions (FR-MAP-05). */

import { useState } from 'react'

import type { RouteLeg, Stop } from '../lib/types'
import { clockFromIso, formatMiles, stopStyle } from '../lib/vocab'

interface TimelineProps {
  stops: Stop[]
  selectedIndex: number | null
  onSelect: (index: number | null) => void
}

export function StopTimeline({ stops, selectedIndex, onSelect }: TimelineProps) {
  return (
    <section className="panel" aria-labelledby="timeline-heading">
      <h3 id="timeline-heading" className="panel-title">
        Stop timeline
      </h3>
      <ol className="timeline">
        {stops.map((stop, index) => {
          const style = stopStyle(stop.kind)
          const selected = index === selectedIndex
          return (
            <li key={`${stop.kind}-${stop.start}`}>
              <button
                type="button"
                className={`timeline-row${selected ? ' is-selected' : ''}`}
                aria-current={selected || undefined}
                onClick={() => onSelect(selected ? null : index)}
                onMouseEnter={() => onSelect(index)}
              >
                <span
                  className={`legend-shape shape-${style.shape}`}
                  style={{ '--stop-color': style.color } as React.CSSProperties}
                  aria-hidden="true"
                >
                  <span className="stop-marker-glyph">{style.glyph}</span>
                </span>
                <span className="timeline-main">
                  <span className="timeline-kind">{style.label}</span>
                  <span className="timeline-place">{stop.location}</span>
                </span>
                <span className="timeline-meta">
                  <span className="timeline-time">
                    {clockFromIso(stop.start)} – {clockFromIso(stop.end)}
                  </span>
                  <span className="timeline-detail">
                    {stop.duration_hr} h · {formatMiles(stop.miles_from_start)} mi
                  </span>
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </section>
  )
}

export function Directions({ legs }: { legs: RouteLeg[] }) {
  const [open, setOpen] = useState<number | null>(0)
  return (
    <section className="panel" aria-labelledby="directions-heading">
      <h3 id="directions-heading" className="panel-title">
        Directions
      </h3>
      {legs.map((leg, index) => {
        const expanded = open === index
        return (
          <div key={`${leg.from_label}-${leg.to_label}`} className="leg">
            <button
              type="button"
              className="leg-toggle"
              aria-expanded={expanded}
              onClick={() => setOpen(expanded ? null : index)}
            >
              <span className="leg-chevron" aria-hidden="true">
                {expanded ? '▾' : '▸'}
              </span>
              <span className="leg-title">
                Leg {index + 1}: {leg.from_label} → {leg.to_label}
              </span>
              <span className="leg-meta">
                {formatMiles(leg.distance_mi)} mi · {leg.duration_hr} h
              </span>
            </button>
            {expanded && (
              <ol className="instructions">
                {leg.instructions.length === 0 && (
                  <li className="instruction-empty">
                    No turn-by-turn steps were returned for this leg.
                  </li>
                )}
                {leg.instructions.map((instruction, stepIndex) => (
                  <li key={`${stepIndex}-${instruction.text}`}>
                    <span className="instruction-text">{instruction.text}</span>
                    <span className="instruction-meta">
                      {formatMiles(instruction.distance_mi)} mi ·{' '}
                      {Math.round(instruction.duration_min)} min
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )
      })}
    </section>
  )
}

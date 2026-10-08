/**
 * Collapsible Bottom Drawer for Spotter LogMaster.
 * Renders step-by-step route milestones, turn-by-turn directions, and HOS trip statistics.
 */

import { useState } from 'react'

import type { RouteLeg, Stop, TripPlan } from '../lib/types'
import { clockFromIso, formatDate, formatHours, formatMiles, stopStyle } from '../lib/vocab'

interface DrawerProps {
  plan: TripPlan
  selectedIndex: number | null
  onSelect: (index: number | null) => void
}

type DrawerTab = 'timeline' | 'directions' | 'summary'

export function RouteMilestonesDrawer({ plan, selectedIndex, onSelect }: DrawerProps) {
  const [isOpen, setIsOpen] = useState(true)
  const [activeTab, setActiveTab] = useState<DrawerTab>('timeline')

  return (
    <div className={`milestones-drawer${isOpen ? ' is-open' : ' is-collapsed'}`}>
      {/* Drawer Handle Header */}
      <div className="drawer-handle-bar">
        <div className="drawer-title-group font-mono">
          <button
            type="button"
            className="drawer-toggle-btn"
            onClick={() => setIsOpen(!isOpen)}
            aria-label={isOpen ? 'Collapse drawer' : 'Expand drawer'}
          >
            <span>{isOpen ? '▼' : '▲'}</span>
            <span className="drawer-title font-sans">Route Milestones &amp; Directions</span>
          </button>
          <span className="drawer-count-badge">{plan.stops.length} Stops</span>
          <span className="drawer-dist-badge">{formatMiles(plan.summary.total_miles)} mi</span>
        </div>

        {isOpen && (
          <div className="drawer-tabs font-mono" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'timeline'}
              className={`drawer-tab${activeTab === 'timeline' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('timeline')}
            >
              📍 Milestones ({plan.stops.length})
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'directions'}
              className={`drawer-tab${activeTab === 'directions' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('directions')}
            >
              🗺️ Directions ({plan.route.legs.length} Legs)
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'summary'}
              className={`drawer-tab${activeTab === 'summary' ? ' is-active' : ''}`}
              onClick={() => setActiveTab('summary')}
            >
              📊 Stats &amp; Rules
            </button>
          </div>
        )}
      </div>

      {/* Drawer Body Content */}
      {isOpen && (
        <div className="drawer-content-body">
          {activeTab === 'timeline' && (
            <StopTimeline stops={plan.stops} selectedIndex={selectedIndex} onSelect={onSelect} />
          )}
          {activeTab === 'directions' && <Directions legs={plan.route.legs} />}
          {activeTab === 'summary' && <DrawerSummary plan={plan} />}
        </div>
      )}
    </div>
  )
}

export function StopTimeline({
  stops,
  selectedIndex,
  onSelect,
}: {
  stops: Stop[]
  selectedIndex: number | null
  onSelect: (index: number | null) => void
}) {
  return (
    <div className="milestones-timeline-grid">
      {stops.map((stop, index) => {
        const style = stopStyle(stop.kind)
        const selected = index === selectedIndex
        return (
          <button
            key={`${stop.kind}-${stop.start}`}
            type="button"
            className={`milestone-chip-card font-mono${selected ? ' is-selected' : ''}`}
            onClick={() => onSelect(selected ? null : index)}
          >
            <div className="milestone-chip-left">
              <span className="milestone-glyph-badge" style={{ backgroundColor: style.color }}>
                {style.glyph}
              </span>
              <div className="milestone-text font-sans">
                <span className="milestone-kind" style={{ color: style.color }}>
                  {style.label}
                </span>
                <span className="milestone-location">{stop.location}</span>
              </div>
            </div>

            <div className="milestone-chip-right font-mono">
              <span className="milestone-time font-bold">
                {clockFromIso(stop.start)} – {clockFromIso(stop.end)}
              </span>
              <span className="milestone-sub">
                {stop.duration_hr}h · {formatMiles(stop.miles_from_start)}mi
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )
}

export function Directions({ legs }: { legs: RouteLeg[] }) {
  const [openLeg, setOpenLeg] = useState<number | null>(0)

  return (
    <div className="directions-container font-mono">
      {legs.map((leg, index) => {
        const expanded = openLeg === index
        return (
          <div key={`${leg.from_label}-${leg.to_label}`} className="directions-leg">
            <button
              type="button"
              className="leg-header-btn font-sans"
              onClick={() => setOpenLeg(expanded ? null : index)}
            >
              <span>{expanded ? '▼' : '▶'}</span>
              <span className="font-bold">
                Leg {index + 1}: {leg.from_label} &rarr; {leg.to_label}
              </span>
              <span className="leg-dist-chip font-mono">
                {formatMiles(leg.distance_mi)} mi · {leg.duration_hr} h
              </span>
            </button>
            {expanded && (
              <ol className="leg-instruction-list font-mono">
                {leg.instructions.length === 0 && (
                  <li className="instruction-empty font-sans">No turn-by-turn steps available.</li>
                )}
                {leg.instructions.map((instruction, stepIndex) => (
                  <li key={`${stepIndex}-${instruction.text}`} className="instruction-item font-sans">
                    <span className="step-num font-mono">{stepIndex + 1}.</span>
                    <span className="step-text">{instruction.text}</span>
                    <span className="step-meta font-mono">
                      {formatMiles(instruction.distance_mi)} mi · {Math.round(instruction.duration_min)} min
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )
      })}
    </div>
  )
}

function DrawerSummary({ plan }: { plan: TripPlan }) {
  const s = plan.summary
  return (
    <div className="drawer-summary-grid font-mono">
      <div className="summary-card">
        <span className="summary-card-label">Total Miles</span>
        <span className="summary-card-val">{formatMiles(s.total_miles)} mi</span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">Driving Hours</span>
        <span className="summary-card-val">{formatHours(s.driving_hours)} h</span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">On-Duty Hours</span>
        <span className="summary-card-val">{formatHours(s.on_duty_hours)} h</span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">Elapsed Time</span>
        <span className="summary-card-val">{formatHours(s.total_elapsed_hours)} h</span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">Log Sheet Days</span>
        <span className="summary-card-val">{s.num_days} Days</span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">Fuel Stops Scheduled</span>
        <span className="summary-card-val">{s.num_fuel_stops} Stops</span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">10-hr Rests</span>
        <span className="summary-card-val">{s.num_rests} Rests</span>
      </div>
      <div className="summary-card">
        <span className="summary-card-label">Start / End Time</span>
        <span className="summary-card-sub font-sans">
          {formatDate(s.trip_start.slice(0, 10))} {clockFromIso(s.trip_start)} &rarr; {formatDate(s.trip_end.slice(0, 10))} {clockFromIso(s.trip_end)}
        </span>
      </div>
    </div>
  )
}

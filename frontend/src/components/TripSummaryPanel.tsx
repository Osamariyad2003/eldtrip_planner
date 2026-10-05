/** Trip summary figures (FR-MAP-06) and the assumptions panel (FR-UI-07). */

import type { TripPlan } from '../lib/types'
import { clockFromIso, formatDate, formatHours, formatMiles } from '../lib/vocab'

export function TripSummaryPanel({ plan }: { plan: TripPlan }) {
  const s = plan.summary
  const items: Array<[string, string]> = [
    ['Total miles', formatMiles(s.total_miles)],
    ['Driving hours', formatHours(s.driving_hours)],
    ['On-duty hours', formatHours(s.on_duty_hours)],
    ['Elapsed hours', formatHours(s.total_elapsed_hours)],
    ['Trip start', `${formatDate(s.trip_start.slice(0, 10))} ${clockFromIso(s.trip_start)}`],
    ['Trip end', `${formatDate(s.trip_end.slice(0, 10))} ${clockFromIso(s.trip_end)}`],
    ['Days / log sheets', String(s.num_days)],
    ['Fuel stops', String(s.num_fuel_stops)],
    ['10-hour rests', String(s.num_rests)],
    ['34-hour restarts', String(s.num_restarts)],
  ]
  return (
    <section className="panel" aria-labelledby="summary-heading">
      <h3 id="summary-heading" className="panel-title">
        Summary
      </h3>
      <dl className="summary-grid">
        {items.map(([label, value]) => (
          <div key={label} className="summary-item">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p className="summary-foot">
        Times in {s.timezone}. Routing via {s.routing_provider}.
      </p>
    </section>
  )
}

export function AssumptionsPanel({ assumptions }: { assumptions: string[] }) {
  return (
    <section className="panel" aria-labelledby="assumptions-heading">
      <h3 id="assumptions-heading" className="panel-title">
        Assumptions
      </h3>
      <ul className="assumptions">
        {assumptions.map((assumption) => (
          <li key={assumption}>{assumption}</li>
        ))}
      </ul>
    </section>
  )
}

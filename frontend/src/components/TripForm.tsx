/**
 * Modernized Floating Control Panel (360px) for Spotter LogMaster.
 * Features an interactive visual Radial Cycle Hours Gauge, color-coded HOS warnings,
 * quick compliance badges, and auto-complete location fields.
 */

import { useId, useState } from 'react'

import { type FieldErrors, cycleAvailable, isValid } from '../lib/form'
import type { TripFormState } from '../lib/types'
import { LocationField } from './LocationField'

interface Props {
  form: TripFormState
  errors: FieldErrors
  busy: boolean
  stale: boolean
  onChange: (form: TripFormState) => void
  onSubmit: () => void
  onSample: () => void
}

export function TripForm({ form, errors, busy, stale, onChange, onSubmit, onSample }: Props) {
  const [detailsOpen, setDetailsOpen] = useState(false)
  const cycleId = useId()
  const startId = useId()

  const set = <K extends keyof TripFormState>(key: K, value: TripFormState[K]) =>
    onChange({ ...form, [key]: value })

  const cycleNum = Number(form.cycleUsedHr) || 0
  const available = cycleAvailable(form.cycleUsedHr)

  // Color-coded HOS threshold logic
  const isDanger = cycleNum >= 65
  const isWarning = cycleNum >= 50 && cycleNum < 65
  const statusColor = isDanger ? '#EF4444' : isWarning ? '#F59E0B' : '#10B981'
  const statusLabel = isDanger ? 'Critical (70h Cap)' : isWarning ? 'Approaching Limit' : 'Compliant'

  // Block submission if invalid or request in flight
  const blocked = busy || !isValid(form)

  return (
    <form
      className="trip-form-panel"
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked) onSubmit()
      }}
      noValidate
    >
      {/* Panel Header */}
      <div className="panel-header">
        <div className="panel-title-group">
          <span className="telematics-pulse-badge">LIVE</span>
          <h2 className="panel-title-text">Trip Parameters</h2>
        </div>
        <button
          type="button"
          className="button-sample-chip"
          onClick={onSample}
          disabled={busy}
        >
          ⚡ Sample Trip
        </button>
      </div>

      {/* Radial Cycle Gauge Section */}
      <div className="radial-gauge-card">
        <div className="radial-gauge-top">
          <span className="gauge-heading">70h / 8-Day Cycle Status</span>
          <span className="gauge-status-badge" style={{ backgroundColor: `${statusColor}18`, color: statusColor, borderColor: `${statusColor}40` }}>
            {statusLabel}
          </span>
        </div>

        <div className="radial-gauge-body">
          <svg className="radial-svg" viewBox="0 0 120 120">
            {/* Background Arc */}
            <circle cx="60" cy="60" r="50" className="radial-bg-track" />
            {/* Animated Progress Arc */}
            <circle
              cx="60"
              cy="60"
              r="50"
              className="radial-progress-arc"
              style={{
                stroke: statusColor,
                strokeDasharray: 314.16,
                strokeDashoffset: 314.16 - (Math.min(cycleNum, 70) / 70) * 314.16,
              }}
            />
          </svg>
          <div className="radial-center-content">
            <span className="radial-hours-val font-sans">{cycleNum.toFixed(1)}</span>
            <span className="radial-hours-unit font-sans">/ 70.0 hrs</span>
            <span className="radial-avail-text font-sans">
              {available !== null ? `${available.toFixed(1)}h available` : '0.0h available'}
            </span>
          </div>
        </div>

        {/* Interactive Cycle Slider */}
        <div className="cycle-slider-wrapper">
          <input
            id={cycleId}
            type="range"
            min={0}
            max={70}
            step={0.25}
            disabled={busy}
            value={cycleNum}
            className="cycle-range-input"
            onChange={(e) => set('cycleUsedHr', e.target.value)}
          />
          <div className="cycle-slider-ticks font-sans">
            <span>0h</span>
            <span>25h</span>
            <span>50h</span>
            <span style={{ color: statusColor, fontWeight: 700 }}>70h Cap</span>
          </div>
        </div>

        {errors.cycle_used_hr && (
          <p className="field-message is-error">{errors.cycle_used_hr}</p>
        )}
      </div>

      {/* Compliance Rule Badges */}
      <div className="compliance-badges-grid">
        <div className="compliance-badge-item" title="Mandatory fuel stop at least every 1,000 miles">
          <span className="badge-icon">⛽</span>
          <span className="badge-label">Fuel ≤1,000mi</span>
        </div>
        <div className="compliance-badge-item" title="1.0 hour dedicated loading at pickup">
          <span className="badge-icon">📦</span>
          <span className="badge-label">Pickup 1.0h</span>
        </div>
        <div className="compliance-badge-item" title="1.0 hour dedicated unloading at dropoff">
          <span className="badge-icon">🎯</span>
          <span className="badge-label">Drop 1.0h</span>
        </div>
        <div className="compliance-badge-item" title="Standard 10-hour sleeper berth rest">
          <span className="badge-icon">🌙</span>
          <span className="badge-label">Rest 10.0h</span>
        </div>
        <div className="compliance-badge-item" title="Mandatory 30-minute break after 8h driving">
          <span className="badge-icon">☕</span>
          <span className="badge-label">Break 30m</span>
        </div>
      </div>

      {/* Form Location Fields */}
      <div className="location-fields-group">
        <LocationField
          label="Current Origin Location"
          value={form.current}
          error={errors.current ?? errors['current.label']}
          disabled={busy}
          onChange={(value) => set('current', value)}
        />
        <LocationField
          label="Pickup Terminal Location"
          value={form.pickup}
          error={errors.pickup ?? errors['pickup.label']}
          disabled={busy}
          onChange={(value) => set('pickup', value)}
        />
        <LocationField
          label="Dropoff Destination Location"
          value={form.dropoff}
          error={errors.dropoff ?? errors['dropoff.label']}
          disabled={busy}
          onChange={(value) => set('dropoff', value)}
        />
      </div>

      {/* Collapsible Log Details & Commercial Truck Profile */}
      <details
        className="details-group"
        open={detailsOpen}
        onToggle={(event) => setDetailsOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary className="details-summary font-sans">
          <span>⚙ Commercial Truck Specs &amp; Carrier Info</span>
          <span className="details-chevron">{detailsOpen ? '▲' : '▼'}</span>
        </summary>
        <div className="details-body font-sans">
          <div className="truck-specs-badge-bar">
            <span className="spec-tag">🚛 Class 8 Semi (53ft)</span>
            <span className="spec-tag">⚖ 80,000 lbs Max</span>
            <span className="spec-tag">📏 13&apos;6&quot; Height</span>
          </div>

          <div className="field">
            <label className="field-label" htmlFor={startId}>
              Trip Departure Date &amp; Time
            </label>
            <input
              id={startId}
              className={`field-input font-sans${errors.start_time ? ' has-error' : ''}`}
              type="datetime-local"
              disabled={busy}
              value={form.startTime}
              aria-invalid={errors.start_time ? true : undefined}
              onChange={(event) => set('startTime', event.target.value)}
            />
          </div>

          {/* Route4Me Commercial Avoidance Options */}
          <div className="field">
            <label className="field-label">Route Avoidances &amp; Restrictions</label>
            <div className="avoidances-check-grid">
              <label className="avoid-check-item">
                <input type="checkbox" defaultChecked disabled={busy} />
                <span>Avoid Low Clearance Bridges (&lt;13&apos;6&quot;)</span>
              </label>
              <label className="avoid-check-item">
                <input type="checkbox" defaultChecked disabled={busy} />
                <span>Avoid Weight-Restricted Roads (&gt;80k lbs)</span>
              </label>
              <label className="avoid-check-item">
                <input type="checkbox" disabled={busy} />
                <span>Avoid Toll Roads</span>
              </label>
              <label className="avoid-check-item">
                <input type="checkbox" defaultChecked disabled={busy} />
                <span>Avoid Ferries &amp; Tunnels</span>
              </label>
            </div>
          </div>

          <TextField label="Driver Name" value={form.driver} error={errors.driver} busy={busy} onChange={(v) => set('driver', v)} placeholder="J. Doe" />
          <TextField label="Carrier Name" value={form.carrier} error={errors.carrier} busy={busy} onChange={(v) => set('carrier', v)} placeholder="Schneider / Spotter Freight" />
          <TextField label="Main Office" value={form.mainOffice} error={errors.mainOffice} busy={busy} onChange={(v) => set('mainOffice', v)} placeholder="Green Bay, WI" />
          <TextField label="Home Terminal" value={form.homeTerminal} error={errors.homeTerminal} busy={busy} onChange={(v) => set('homeTerminal', v)} placeholder="Dallas, TX" />
          <TextField label="Vehicle / Trailer" value={form.vehicle} error={errors.vehicle} busy={busy} onChange={(v) => set('vehicle', v)} placeholder="TRK-001 / TRL-001 (53ft Dry Van)" />
          <TextField label="Shipper" value={form.shipper} error={errors.shipper} busy={busy} onChange={(v) => set('shipper', v)} placeholder="Acme Freight Logistics" />
          <TextField label="Commodity" value={form.commodity} error={errors.commodity} busy={busy} onChange={(v) => set('commodity', v)} placeholder="General Freight (Non-Hazmat)" />
        </div>
      </details>

      {/* Primary CTA Submit Button */}
      <button type="submit" className="button-telematics-primary" disabled={blocked}>
        {busy && <span className="button-spinner" aria-hidden="true" />}
        <span>{busy ? 'Calculating HOS Schedule…' : stale ? 'Re-calculate HOS Schedule' : 'Generate ELD Trip Plan'}</span>
      </button>

      {stale && !busy && (
        <p className="form-stale-warning" role="status font-mono">
          ⚠ Inputs changed — click button to re-calculate schedule.
        </p>
      )}

      {/* FR-UI-09: what this tool is, where it sits in the panel the user
          reads before trusting the output. */}
      <p className="planner-disclaimer font-sans">
        Planning tool — projected logs, not an FMCSA-registered ELD. Routing by{' '}
        <a href="https://openrouteservice.org/" target="_blank" rel="noreferrer">
          OpenRouteService
        </a>
        ; map data ©{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
          OpenStreetMap
        </a>{' '}
        contributors.
      </p>
    </form>
  )
}

function TextField({
  label,
  value,
  error,
  busy,
  placeholder,
  onChange,
}: {
  label: string
  value: string
  error?: string
  busy: boolean
  placeholder?: string
  onChange: (value: string) => void
}) {
  const id = useId()
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={`field-input${error ? ' has-error' : ''}`}
        type="text"
        maxLength={80}
        disabled={busy}
        value={value}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error && <p className="field-message is-error">{error}</p>}
    </div>
  )
}

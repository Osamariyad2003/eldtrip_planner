/** The trip input form (section 4.1, WF-1 steps 2-5, WF-2). */

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

  const available = cycleAvailable(form.cycleUsedHr)

  // FR-INP-05: submission is blocked while anything is invalid or in flight.
  const blocked = busy || !isValid(form)

  return (
    <form
      className="trip-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (!blocked) onSubmit()
      }}
      noValidate
    >
      <div className="form-head">
        <h2 className="form-title">Plan a trip</h2>
        <button type="button" className="button-ghost" onClick={onSample} disabled={busy}>
          Try a sample trip
        </button>
      </div>

      <LocationField
        label="Current location"
        value={form.current}
        error={errors.current ?? errors['current.label']}
        disabled={busy}
        onChange={(value) => set('current', value)}
      />
      <LocationField
        label="Pickup location"
        value={form.pickup}
        error={errors.pickup ?? errors['pickup.label']}
        disabled={busy}
        onChange={(value) => set('pickup', value)}
      />
      <LocationField
        label="Dropoff location"
        value={form.dropoff}
        error={errors.dropoff ?? errors['dropoff.label']}
        disabled={busy}
        onChange={(value) => set('dropoff', value)}
      />

      <div className="field">
        <label className="field-label" htmlFor={cycleId}>
          Current cycle used (hours)
        </label>
        <input
          id={cycleId}
          className={`field-input${errors.cycle_used_hr ? ' has-error' : ''}`}
          type="number"
          inputMode="decimal"
          min={0}
          max={70}
          step={0.25}
          disabled={busy}
          value={form.cycleUsedHr}
          aria-describedby={`${cycleId}-message`}
          aria-invalid={errors.cycle_used_hr ? true : undefined}
          onChange={(event) => set('cycleUsedHr', event.target.value)}
        />
        <p
          className={`field-message${errors.cycle_used_hr ? ' is-error' : ''}`}
          id={`${cycleId}-message`}
        >
          {errors.cycle_used_hr ??
            (available !== null
              ? `${available} hrs available on the 70-hour / 8-day cycle`
              : 'Hours already on duty in the current 8-day period')}
        </p>
      </div>

      <details
        className="details-group"
        open={detailsOpen}
        onToggle={(event) => setDetailsOpen((event.target as HTMLDetailsElement).open)}
      >
        <summary>Log details (optional)</summary>
        <div className="details-body">
          <div className="field">
            <label className="field-label" htmlFor={startId}>
              Start date and time
            </label>
            <input
              id={startId}
              className={`field-input${errors.start_time ? ' has-error' : ''}`}
              type="datetime-local"
              disabled={busy}
              value={form.startTime}
              aria-invalid={errors.start_time ? true : undefined}
              onChange={(event) => set('startTime', event.target.value)}
            />
            <p className={`field-message${errors.start_time ? ' is-error' : ''}`}>
              {errors.start_time ?? 'Defaults to the next full hour in the log time zone'}
            </p>
          </div>
          <TextField label="Driver name" value={form.driver} error={errors.driver} busy={busy} onChange={(v) => set('driver', v)} placeholder="Driver" />
          <TextField label="Carrier name" value={form.carrier} error={errors.carrier} busy={busy} onChange={(v) => set('carrier', v)} placeholder="Carrier" />
          <TextField label="Main office" value={form.mainOffice} error={errors.mainOffice} busy={busy} onChange={(v) => set('mainOffice', v)} placeholder="Current location city" />
          <TextField label="Home terminal" value={form.homeTerminal} error={errors.homeTerminal} busy={busy} onChange={(v) => set('homeTerminal', v)} placeholder="Current location city" />
          <TextField label="Vehicle numbers" value={form.vehicle} error={errors.vehicle} busy={busy} onChange={(v) => set('vehicle', v)} placeholder="TRK-001 / TRL-001" />
          <TextField label="Shipper" value={form.shipper} error={errors.shipper} busy={busy} onChange={(v) => set('shipper', v)} placeholder="Shipper at pickup" />
          <TextField label="Commodity" value={form.commodity} error={errors.commodity} busy={busy} onChange={(v) => set('commodity', v)} placeholder="General freight" />
        </div>
      </details>

      <button type="submit" className="button-primary" disabled={blocked}>
        {busy && <span className="button-spinner" aria-hidden="true" />}
        {busy ? 'Planning…' : stale ? 'Update plan' : 'Plan trip'}
      </button>
      {stale && !busy && (
        <p className="form-stale" role="status">
          Inputs changed — press Plan to update.
        </p>
      )}
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

/**
 * A location input with US autocomplete (FR-INP-01, FR-GEO-01).
 *
 * Queries are debounced 300 ms and only run at three characters or more. The
 * combobox follows the ARIA pattern so it is fully keyboard operable
 * (NFR-ACC-01).
 */

import { useEffect, useId, useRef, useState } from 'react'

import { ApiError, geocode } from '../lib/api'
import type { LocationInput, Place } from '../lib/types'

const DEBOUNCE_MS = 300
const MIN_QUERY = 3

interface Props {
  label: string
  hint?: string
  value: LocationInput
  error?: string
  disabled?: boolean
  onChange: (value: LocationInput) => void
}

export function LocationField({ label, hint, value, error, disabled, onChange }: Props) {
  const inputId = useId()
  const listId = `${inputId}-list`
  const [suggestions, setSuggestions] = useState<Place[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [status, setStatus] = useState<'idle' | 'loading' | 'empty' | 'failed'>('idle')
  const justPicked = useRef(false)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (justPicked.current) {
      justPicked.current = false
      return
    }
    const query = value.label.trim()
    if (query.length < MIN_QUERY) {
      setSuggestions((current) => (current.length ? [] : current))
      setStatus((current) => (current === 'idle' ? current : 'idle'))
      setOpen((current) => (current ? false : current))
      return
    }

    const controller = new AbortController()
    // The spinner waits for the debounce to elapse, so fast typing does not
    // flicker it on and off between keystrokes.
    const timer = window.setTimeout(async () => {
      setStatus('loading')
      try {
        const places = await geocode(query, controller.signal)
        setSuggestions(places)
        setStatus(places.length ? 'idle' : 'empty')
        setOpen(true)
        setActive(-1)
      } catch (cause) {
        if (controller.signal.aborted) return
        setSuggestions([])
        setStatus(cause instanceof ApiError ? 'failed' : 'failed')
        setOpen(true)
      }
    }, DEBOUNCE_MS)

    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [value.label])

  // Close the list on an outside click, leaving the typed text alone.
  useEffect(() => {
    if (!open) return
    const onDocumentDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocumentDown)
    return () => document.removeEventListener('mousedown', onDocumentDown)
  }, [open])

  const pick = (place: Place) => {
    justPicked.current = true
    onChange({ label: place.label, lat: place.lat, lng: place.lng })
    setOpen(false)
    setSuggestions([])
    setStatus('idle')
    setActive(-1)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' && suggestions.length) {
      event.preventDefault()
      setOpen(true)
      setActive((index) => (index + 1) % suggestions.length)
    } else if (event.key === 'ArrowUp' && suggestions.length) {
      event.preventDefault()
      setActive((index) => (index <= 0 ? suggestions.length - 1 : index - 1))
    } else if (event.key === 'Enter' && open && active >= 0) {
      event.preventDefault()
      pick(suggestions[active])
    } else if (event.key === 'Escape') {
      setOpen(false)
    }
  }

  const messageId = `${inputId}-message`
  const message =
    error ??
    (status === 'empty' ? 'No US matches.' : null) ??
    (status === 'failed' ? 'Search unavailable, try again.' : null)

  return (
    <div className="field" ref={boxRef}>
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
      <div className="combobox">
        <input
          id={inputId}
          className={`field-input${error ? ' has-error' : ''}`}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          aria-describedby={message || hint ? messageId : undefined}
          aria-invalid={error ? true : undefined}
          disabled={disabled}
          value={value.label}
          placeholder="City, ST"
          onChange={(event) => onChange({ label: event.target.value, lat: null, lng: null })}
          onKeyDown={onKeyDown}
          onFocus={() => suggestions.length && setOpen(true)}
        />
        {status === 'loading' && <span className="field-spinner" aria-hidden="true" />}
        {open && (suggestions.length > 0 || message) && (
          <ul className="suggestions" id={listId} role="listbox" aria-label={`${label} suggestions`}>
            {suggestions.map((place, index) => (
              <li
                key={`${place.label}-${place.lat}-${place.lng}`}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                className={index === active ? 'is-active' : undefined}
                onMouseDown={(event) => {
                  event.preventDefault()
                  pick(place)
                }}
                onMouseEnter={() => setActive(index)}
              >
                {place.label}
              </li>
            ))}
            {suggestions.length === 0 && message && <li className="suggestion-empty">{message}</li>}
          </ul>
        )}
      </div>
      <p className={`field-message${error ? ' is-error' : ''}`} id={messageId}>
        {message ?? hint ?? ' '}
      </p>
    </div>
  )
}

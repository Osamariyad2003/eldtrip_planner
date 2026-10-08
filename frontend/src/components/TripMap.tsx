/**
 * Route map with one marker per stop (FR-MAP-01..03).
 *
 * Markers are divIcons so each kind gets its own shape as well as its own
 * colour, which FR-MAP-02 requires.
 */

import L from 'leaflet'
import { useEffect, useMemo, useRef } from 'react'
import { MapContainer, Marker, Polyline, Popup, TileLayer, useMap } from 'react-leaflet'

import type { Stop, TripPlan } from '../lib/types'
import { clockFromIso, formatMiles, stopStyle } from '../lib/vocab'

/** The contiguous United States, shown before the first plan (FR-MAP-01). */
const US_BOUNDS: L.LatLngBoundsExpression = [
  [24.4, -124.8],
  [49.4, -66.9],
]

const FIT_PADDING: L.FitBoundsOptions = { padding: [40, 40] }

/** A turn the user picked in the Directions tab; the map flies to it. */
export interface MapFocus {
  lat: number
  lng: number
  text: string
  /** Bumped on every pick so re-selecting the same turn still re-focuses. */
  nonce: number
}

interface Props {
  plan: TripPlan | null
  selectedIndex: number | null
  onSelect: (index: number | null) => void
  focus?: MapFocus | null
}

export function TripMap({ plan, selectedIndex, onSelect, focus = null }: Props) {
  return (
    <div className="map-telematics-shell">
      <MapContainer
        bounds={US_BOUNDS}
        boundsOptions={FIT_PADDING}
        scrollWheelZoom
        className="map-canvas-telematics"
        aria-label="Spotter Route Map"
      >
        <TileLayer
          url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
        />
        {plan && <RouteLayer plan={plan} selectedIndex={selectedIndex} onSelect={onSelect} />}
        <StepFocus focus={focus} />
        <ResizeWatcher />
      </MapContainer>
      {!plan && (
        <div className="map-telematics-empty" role="status">
          <div className="empty-icon-ring">🗺️</div>
          <p className="empty-title font-mono">No Route Calculated</p>
          <p className="empty-sub">
            Enter Current Origin, Pickup Terminal, and Dropoff Destination in the control panel to
            generate HOS schedule &amp; route.
          </p>
        </div>
      )}
      {plan && <MapLegend stops={plan.stops} />}
    </div>
  )
}

/**
 * Leaflet caches the container size and only recomputes it on a window resize.
 * The map here is in a flex column with the milestones drawer, so expanding or
 * collapsing the drawer changes its height with no window event at all, and
 * the tiles stay at the old size - letterboxed inside their own container
 * until the next window resize. A ResizeObserver is the event Leaflet is
 * missing.
 */
function ResizeWatcher() {
  const map = useMap()

  useEffect(() => {
    const container = map.getContainer()
    const observer = new ResizeObserver(() => map.invalidateSize({ animate: false }))
    observer.observe(container)
    return () => observer.disconnect()
  }, [map])

  return null
}

/** Flies the map to a turn picked in the Directions tab and marks it. */
function StepFocus({ focus }: { focus: MapFocus | null }) {
  const map = useMap()
  const marker = useRef<L.Marker | null>(null)

  useEffect(() => {
    if (!focus) return
    map.flyTo([focus.lat, focus.lng], 14, { duration: 0.8 })
    marker.current?.openPopup()
  }, [map, focus])

  if (!focus) return null
  return (
    <Marker
      position={[focus.lat, focus.lng]}
      icon={stepIcon()}
      ref={(instance) => {
        marker.current = instance
      }}
    >
      <Popup>
        <div className="stop-popup">
          <p className="stop-popup-kind" style={{ color: '#0EA5E9' }}>
            Manoeuvre
          </p>
          <p className="stop-popup-place">{focus.text}</p>
        </div>
      </Popup>
    </Marker>
  )
}

let stepIconCache: L.DivIcon | null = null

function stepIcon(): L.DivIcon {
  if (!stepIconCache) {
    stepIconCache = L.divIcon({
      className: 'step-focus-marker',
      html: '<span class="step-focus-ring"></span>',
      iconSize: [20, 20],
      iconAnchor: [10, 10],
      popupAnchor: [0, -12],
    })
  }
  return stepIconCache
}

function RouteLayer({ plan, selectedIndex, onSelect }: Props & { plan: TripPlan }) {
  const map = useMap()
  const markers = useRef<Record<number, L.Marker | null>>({})
  const geometry = plan.route.geometry

  // FR-MAP-01: fit the route bounds with 40 px of padding on each new plan.
  //
  // A plan arriving also brings the notice strip and the milestones drawer with
  // it, so the map is a different size a moment after this runs. Leaflet would
  // keep the zoom it computed against the old size - the route ends up a
  // cluster of pins in the middle of a continent - so the fit is redone when
  // the container settles, until the user takes the map over themselves.
  useEffect(() => {
    if (geometry.length === 1) {
      map.setView(geometry[0] as L.LatLngTuple, 11)
      return
    }
    if (geometry.length <= 1) return

    const bounds = L.latLngBounds(geometry as L.LatLngTuple[])
    const container = map.getContainer()

    // Watch the pointer, not Leaflet's own move events: fitBounds and
    // invalidateSize both fire zoomstart themselves, so listening to the map
    // would have the first programmatic fit cancel every fit after it.
    let userHasMoved = false
    const release = () => {
      userHasMoved = true
    }
    const INPUT = ['mousedown', 'wheel', 'touchstart', 'keydown']
    for (const event of INPUT) {
      container.addEventListener(event, release, { passive: true })
    }

    const fit = () => {
      map.invalidateSize({ animate: false })
      if (!userHasMoved) map.fitBounds(bounds, FIT_PADDING)
    }

    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(container)

    return () => {
      observer.disconnect()
      for (const event of INPUT) container.removeEventListener(event, release)
    }
  }, [map, geometry])

  // FR-MAP-04: selecting a timeline row pans to the marker and opens its popup.
  useEffect(() => {
    if (selectedIndex === null) return
    const stop = plan.stops[selectedIndex]
    const marker = markers.current[selectedIndex]
    if (!stop || stop.lat === null || stop.lng === null || !marker) return
    map.panTo([stop.lat, stop.lng], { animate: true })
    marker.openPopup()
  }, [map, plan.stops, selectedIndex])

  return (
    <>
      {geometry.length > 1 && (
        <>
          <Polyline positions={geometry as L.LatLngTuple[]} className="route-line-casing" />
          <Polyline positions={geometry as L.LatLngTuple[]} className="route-line-core" />
        </>
      )}
      {plan.stops.map((stop, index) =>
        stop.lat === null || stop.lng === null ? null : (
          <Marker
            key={`${stop.kind}-${stop.start}`}
              position={[stop.lat, stop.lng]}
              icon={stopIcon(stop, index === selectedIndex)}
              ref={(instance) => {
                markers.current[index] = instance
              }}
              eventHandlers={{
                click: () => onSelect(index),
                popupclose: () => onSelect(null),
              }}
            >
              <Popup>
                <StopPopup stop={stop} />
              </Popup>
            </Marker>
          ),
        )}
    </>
  )
}

function StopPopup({ stop }: { stop: Stop }) {
  const style = stopStyle(stop.kind)
  return (
    <div className="stop-popup">
      <p className="stop-popup-kind" style={{ color: style.color }}>
        {style.label}
      </p>
      <p className="stop-popup-place">{stop.location}</p>
      <dl>
        <div>
          <dt>Time</dt>
          <dd>
            {clockFromIso(stop.start)} – {clockFromIso(stop.end)}
          </dd>
        </div>
        <div>
          <dt>Duration</dt>
          <dd>{stop.duration_hr} h</dd>
        </div>
        <div>
          <dt>From start</dt>
          <dd>{formatMiles(stop.miles_from_start)} mi</dd>
        </div>
      </dl>
    </div>
  )
}

/** Build a shaped, coloured marker. Cached so panning does not rebuild icons. */
const iconCache = new Map<string, L.DivIcon>()

function stopIcon(stop: Stop, selected: boolean): L.DivIcon {
  const key = `${stop.kind}:${selected}`
  const cached = iconCache.get(key)
  if (cached) return cached

  const style = stopStyle(stop.kind)
  const icon = L.divIcon({
    className: `telematics-marker${selected ? ' is-selected' : ''}`,
    html: `<span class="marker-pin-wrapper" style="--pin-color:${style.color}"><span class="marker-pin-badge">${style.glyph}</span></span>`,
    iconSize: [32, 32],
    iconAnchor: [16, 30],
    popupAnchor: [0, -28],
  })
  iconCache.set(key, icon)
  return icon
}

/** FR-MAP-02: a legend listing every stop kind present on the map. */
function MapLegend({ stops }: { stops: Stop[] }) {
  const kinds = useMemo(() => {
    const seen: string[] = []
    for (const stop of stops) if (!seen.includes(stop.kind)) seen.push(stop.kind)
    return seen
  }, [stops])

  return (
    <div className="map-legend-telematics">
      <p className="legend-head font-mono">Route Waypoints</p>
      <ul className="legend-list">
        {kinds.map((kind) => {
          const style = stopStyle(kind)
          return (
            <li key={kind} className="legend-item">
              <span className="legend-chip" style={{ backgroundColor: style.color }}>
                {style.glyph}
              </span>
              {style.label}
            </li>
          )
        })}
      </ul>
    </div>
  )
}
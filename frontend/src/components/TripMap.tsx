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

interface Props {
  plan: TripPlan | null
  selectedIndex: number | null
  onSelect: (index: number | null) => void
}

export function TripMap({ plan, selectedIndex, onSelect }: Props) {
  return (
    <div className="map-shell">
      <MapContainer
        bounds={US_BOUNDS}
        boundsOptions={FIT_PADDING}
        scrollWheelZoom
        className="map-canvas"
        aria-label="Route map"
      >
        <TileLayer
          url="https://basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, &copy; <a href="https://carto.com/attributions">CARTO</a>'
          maxZoom={19}
        />
        {plan && <RouteLayer plan={plan} selectedIndex={selectedIndex} onSelect={onSelect} />}
      </MapContainer>
      {!plan && (
        <div className="map-empty" role="status">
          <p className="map-empty-title">No trip planned yet</p>
          <p className="map-empty-body">
            Enter a current location, pickup and dropoff, then press <strong>Plan trip</strong>.
          </p>
        </div>
      )}
      {plan && <MapLegend stops={plan.stops} />}
    </div>
  )
}

function RouteLayer({ plan, selectedIndex, onSelect }: Props & { plan: TripPlan }) {
  const map = useMap()
  const markers = useRef<Record<number, L.Marker | null>>({})
  const geometry = plan.route.geometry

  // FR-MAP-01: fit the route bounds with 40 px of padding on each new plan.
  useEffect(() => {
    if (geometry.length > 1) {
      map.fitBounds(L.latLngBounds(geometry as L.LatLngTuple[]), FIT_PADDING)
    } else if (geometry.length === 1) {
      map.setView(geometry[0] as L.LatLngTuple, 11)
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
        <Polyline positions={geometry as L.LatLngTuple[]} className="route-line" />
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
    className: `stop-marker${selected ? ' is-selected' : ''}`,
    html: `<span class="stop-marker-shape shape-${style.shape}" style="--stop-color:${style.color}"><span class="stop-marker-glyph">${style.glyph}</span></span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -14],
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
    <div className="map-legend">
      <p className="map-legend-title">Stops</p>
      <ul>
        {kinds.map((kind) => {
          const style = stopStyle(kind)
          return (
            <li key={kind}>
              <span className={`legend-shape shape-${style.shape}`} style={{ '--stop-color': style.color } as React.CSSProperties}>
                <span className="stop-marker-glyph">{style.glyph}</span>
              </span>
              {style.label}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

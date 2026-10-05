/**
 * One daily log sheet, drawn as an SVG reproduction of the FMCSA form
 * (FR-UI-01..05).
 *
 * The viewBox is US-Letter landscape at 96 dpi (1056 x 816), so the same
 * markup prints and exports to PDF at the right proportions with no rescaling
 * (FR-EXP-01, FR-EXP-02).
 */

import type { Bracket, DailyLog, DutyStatus, Remark } from '../lib/types'
import {
  STATUS_LABEL,
  STATUS_ROWS,
  formatDateLong,
  formatHours,
  formatMiles,
  minuteToClock,
} from '../lib/vocab'

const W = 1056
const H = 816
const M = 20

const GRID_LEFT = 150
const TOTALS_W = 66
const GRID_RIGHT = W - M - TOTALS_W
const GRID_W = GRID_RIGHT - GRID_LEFT
const GRID_TOP = 212
const ROW_H = 30
const GRID_BOTTOM = GRID_TOP + ROW_H * STATUS_ROWS.length

const BRACKET_Y = GRID_BOTTOM + 10
const REMARKS_TOP = GRID_BOTTOM + 26
const RECAP_TOP = 520

/** Hour labels across the top of the grid: Midnight, 1-11, Noon, 1-11, Midnight. */
const HOUR_LABELS = Array.from({ length: 25 }, (_, h) => {
  if (h === 0 || h === 24) return 'Midnight'
  if (h === 12) return 'Noon'
  return String(h % 12)
})

const x = (minute: number) => GRID_LEFT + (minute / 1440) * GRID_W
const rowTop = (status: DutyStatus) => GRID_TOP + STATUS_ROWS.indexOf(status) * ROW_H
const rowMid = (status: DutyStatus) => rowTop(status) + ROW_H / 2

interface Props {
  log: DailyLog
  timezone: string
  /** Set on the element so the PDF exporter can find each sheet in order. */
  dayIndex: number
}

export function LogSheet({ log, timezone, dayIndex }: Props) {
  const titleId = `log-title-${dayIndex}`
  const descId = `log-desc-${dayIndex}`

  return (
    <svg
      className="log-sheet"
      data-day-index={dayIndex}
      viewBox={`0 0 ${W} ${H}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
      preserveAspectRatio="xMidYMid meet"
    >
      {/* NFR-ACC-02: a text alternative listing the day's segments and totals. */}
      <title id={titleId}>{`Driver's daily log for ${formatDateLong(log.date)}`}</title>
      <desc id={descId}>{describe(log, timezone)}</desc>

      <rect x={0} y={0} width={W} height={H} fill="#ffffff" />

      <Header log={log} timezone={timezone} />
      <HourLabels />
      <GridRows />
      <TickMarks />
      <StatusLine log={log} />
      <TotalsColumn log={log} />
      <Brackets brackets={log.brackets} />
      <Remarks remarks={log.remarks} />
      <RecapBlock log={log} />

      <text x={M} y={H - 16} className="log-fineprint">
        Projected log produced by a planning tool — not an FMCSA-registered ELD record.
      </text>
    </svg>
  )
}

/* -- header (FR-LOG-09) --------------------------------------------------- */

function Header({ log, timezone }: { log: DailyLog; timezone: string }) {
  const h = log.header
  return (
    <g>
      <text x={W / 2} y={44} textAnchor="middle" className="log-title">
        Driver&apos;s Daily Log
      </text>
      <text x={W / 2} y={64} textAnchor="middle" className="log-subtitle">
        {formatDateLong(log.date)} · {timezone}
      </text>

      <Field x={M} y={88} w={300} label="From" value={h.from_label} />
      <Field x={M + 310} y={88} w={300} label="To" value={h.to_label} />
      <Field x={M + 620} y={88} w={170} label="Total miles driving today" value={formatMiles(log.miles_today)} />
      <Field x={M + 800} y={88} w={196} label="Truck / trailer numbers" value={h.vehicle} />

      <Field x={M} y={132} w={300} label="Carrier" value={h.carrier} />
      <Field x={M + 310} y={132} w={300} label="Main office address" value={h.main_office} />
      <Field x={M + 620} y={132} w={376} label="Home terminal address" value={h.home_terminal} />

      <Field x={M} y={176} w={200} label="Driver (signature in full)" value={h.driver} />
      <Field x={M + 210} y={176} w={150} label="Co-driver" value={h.co_driver} />
      <Field x={M + 370} y={176} w={200} label="Shipping document no." value={h.shipping_document} />
      <Field x={M + 580} y={176} w={200} label="Shipper" value={h.shipper} />
      <Field x={M + 790} y={176} w={206} label="Commodity" value={h.commodity} />
    </g>
  )
}

function Field({
  x: fx,
  y: fy,
  w,
  label,
  value,
}: {
  x: number
  y: number
  w: number
  label: string
  value: string | number
}) {
  return (
    <g>
      <text x={fx} y={fy - 16} className="log-field-label">
        {label}
      </text>
      <line x1={fx} y1={fy} x2={fx + w} y2={fy} className="log-rule" />
      <text x={fx + 2} y={fy - 3} className="log-field-value">
        {truncate(String(value), w)}
      </text>
    </g>
  )
}

/** Keep a value inside its ruled line; the full text stays in the SVG desc. */
function truncate(value: string, width: number): string {
  const max = Math.floor(width / 5.6)
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}…` : value
}

/* -- grid (FR-UI-02) ------------------------------------------------------ */

function HourLabels() {
  return (
    <g>
      {HOUR_LABELS.map((label, hour) => (
        <text
          key={hour}
          x={x(hour * 60)}
          y={GRID_TOP - 8}
          textAnchor="middle"
          className={label === 'Midnight' || label === 'Noon' ? 'log-hour-major' : 'log-hour'}
        >
          {label}
        </text>
      ))}
    </g>
  )
}

function GridRows() {
  return (
    <g>
      <rect
        x={GRID_LEFT}
        y={GRID_TOP}
        width={GRID_W}
        height={ROW_H * STATUS_ROWS.length}
        fill="#ffffff"
        className="log-grid-frame"
      />
      {STATUS_ROWS.map((status, index) => (
        <g key={status}>
          {index > 0 && (
            <line
              x1={GRID_LEFT}
              y1={GRID_TOP + index * ROW_H}
              x2={GRID_RIGHT}
              y2={GRID_TOP + index * ROW_H}
              className="log-grid-line"
            />
          )}
          <text x={GRID_LEFT - 8} y={rowMid(status) + 1} textAnchor="end" className="log-row-label">
            {rowLabelLines(status)[0]}
          </text>
          {rowLabelLines(status)[1] && (
            <text x={GRID_LEFT - 8} y={rowMid(status) + 11} textAnchor="end" className="log-row-label">
              {rowLabelLines(status)[1]}
            </text>
          )}
          <text x={GRID_LEFT - 8} y={rowTop(status) + 11} textAnchor="end" className="log-row-number">
            {index + 1}
          </text>
        </g>
      ))}
      {/* Hour divisions spanning every row. */}
      {Array.from({ length: 25 }, (_, hour) => (
        <line
          key={hour}
          x1={x(hour * 60)}
          y1={GRID_TOP}
          x2={x(hour * 60)}
          y2={GRID_BOTTOM}
          className={hour % 12 === 0 ? 'log-grid-hour-major' : 'log-grid-hour'}
        />
      ))}
    </g>
  )
}

function rowLabelLines(status: DutyStatus): [string, string?] {
  if (status === 'on_duty') return ['On Duty', '(not driving)']
  if (status === 'sleeper_berth') return ['Sleeper Berth']
  return [STATUS_LABEL[status]]
}

/** Quarter-hour ticks inside each row: :15 short, :30 medium, :45 short. */
function TickMarks() {
  const ticks: Array<{ minute: number; height: number }> = []
  for (let minute = 15; minute < 1440; minute += 15) {
    if (minute % 60 === 0) continue
    const height = minute % 60 === 30 ? ROW_H * 0.5 : ROW_H * 0.25
    ticks.push({ minute, height })
  }
  return (
    <g className="log-ticks">
      {STATUS_ROWS.map((status) =>
        ticks.map(({ minute, height }) => (
          <line
            key={`${status}-${minute}`}
            x1={x(minute)}
            y1={rowTop(status) + ROW_H}
            x2={x(minute)}
            y2={rowTop(status) + ROW_H - height}
          />
        )),
      )}
    </g>
  )
}

/* -- the duty status line (FR-UI-03) -------------------------------------- */

function StatusLine({ log }: { log: DailyLog }) {
  const segments = log.segments
  if (segments.length === 0) return null

  let d = `M ${x(segments[0].start_min).toFixed(2)} ${rowMid(segments[0].status)}`
  segments.forEach((segment, index) => {
    d += ` L ${x(segment.end_min).toFixed(2)} ${rowMid(segment.status)}`
    const next = segments[index + 1]
    if (next) d += ` L ${x(segment.end_min).toFixed(2)} ${rowMid(next.status)}`
  })
  return <path d={d} className="log-status-line" />
}

/* -- totals column (FR-UI-04) --------------------------------------------- */

function TotalsColumn({ log }: { log: DailyLog }) {
  const circled = log.recap.on_duty_today
  const sum = STATUS_ROWS.reduce((total, status) => total + (log.totals[status] ?? 0), 0)
  return (
    <g>
      <text x={GRID_RIGHT + TOTALS_W / 2} y={GRID_TOP - 8} textAnchor="middle" className="log-hour">
        Total hours
      </text>
      <rect
        x={GRID_RIGHT}
        y={GRID_TOP}
        width={TOTALS_W}
        height={ROW_H * STATUS_ROWS.length}
        fill="#ffffff"
        className="log-grid-frame"
      />
      {STATUS_ROWS.map((status, index) => (
        <g key={status}>
          {index > 0 && (
            <line
              x1={GRID_RIGHT}
              y1={GRID_TOP + index * ROW_H}
              x2={GRID_RIGHT + TOTALS_W}
              y2={GRID_TOP + index * ROW_H}
              className="log-grid-line"
            />
          )}
          <text
            x={GRID_RIGHT + TOTALS_W / 2}
            y={rowMid(status) + 5}
            textAnchor="middle"
            className="log-total"
          >
            {formatHours(log.totals[status] ?? 0)}
          </text>
        </g>
      ))}
      <text
        x={GRID_RIGHT + TOTALS_W / 2}
        y={GRID_BOTTOM + 18}
        textAnchor="middle"
        className="log-total-sum"
      >
        {`= ${formatHours(sum)}`}
      </text>

      {/* The circled figure: driving plus on-duty hours. */}
      <ellipse
        cx={GRID_RIGHT + TOTALS_W / 2}
        cy={rowMid('driving') + ROW_H / 2}
        rx={TOTALS_W / 2 - 4}
        ry={ROW_H - 4}
        className="log-circle"
      />
      <text
        x={GRID_RIGHT + TOTALS_W + 8}
        y={rowMid('driving') + ROW_H / 2 + 4}
        className="log-field-label"
      >
        {`${formatHours(circled)} h on duty`}
      </text>
    </g>
  )
}

/* -- stationary brackets (FR-LOG-07, FR-UI-05) ---------------------------- */

function Brackets({ brackets }: { brackets: Bracket[] }) {
  return (
    <g className="log-brackets">
      {brackets.map((bracket) => {
        const x1 = x(bracket.start_min)
        const x2 = x(bracket.end_min)
        const top = BRACKET_Y
        const depth = 6
        return (
          <path
            key={`${bracket.start_min}-${bracket.end_min}`}
            d={`M ${x1.toFixed(2)} ${top} L ${x1.toFixed(2)} ${top + depth} L ${x2.toFixed(
              2,
            )} ${top + depth} L ${x2.toFixed(2)} ${top}`}
          />
        )
      })}
    </g>
  )
}

/* -- remarks as 45-degree flags (FR-UI-05) -------------------------------- */

const STAGGER_STEPS = [0, 22, 44]
const STAGGER_GAP_MIN = 45

/**
 * Give each remark a leader length (FR-UI-05).
 *
 * Flags less than 45 minutes apart sit at different depths so their two-line
 * labels cannot overlap; a wider gap resets to the shallowest depth.
 */
function stagger(remarks: Remark[]): Array<{ remark: Remark; leader: number }> {
  const placed: Array<{ remark: Remark; leader: number }> = []
  let slot = 0
  for (const [index, remark] of remarks.entries()) {
    const previous = remarks[index - 1]
    const crowded = previous !== undefined && remark.minute - previous.minute < STAGGER_GAP_MIN
    slot = crowded ? (slot + 1) % STAGGER_STEPS.length : 0
    placed.push({ remark, leader: 14 + STAGGER_STEPS[slot] })
  }
  return placed
}

function Remarks({ remarks }: { remarks: Remark[] }) {
  const placed = stagger(remarks)

  return (
    <g>
      <text x={M} y={REMARKS_TOP + 12} className="log-section-label">
        Remarks
      </text>
      {placed.map(({ remark, leader }) => (
        <g
          key={`${remark.minute}-${remark.note}`}
          transform={`translate(${x(remark.minute).toFixed(2)} ${REMARKS_TOP}) rotate(45)`}
        >
          <line x1={0} y1={0} x2={leader} y2={0} className="log-flag-leader" />
          <text x={leader + 4} y={-2} className="log-flag-place">
            {remark.location}
          </text>
          <text x={leader + 4} y={9} className="log-flag-note">
            {remark.note}
          </text>
        </g>
      ))}
    </g>
  )
}

/* -- recap (BR-LOG-03) ---------------------------------------------------- */

function RecapBlock({ log }: { log: DailyLog }) {
  const recap = log.recap
  const boxW = 250
  return (
    <g>
      <text x={M} y={RECAP_TOP} className="log-section-label">
        Recap
      </text>
      <RecapBox
        x={M}
        label="70 hour / 8 day drivers"
        rows={[
          ['On duty hours today (lines 3 & 4)', formatHours(recap.on_duty_today)],
          ['A. Total hours on duty last 8 days', formatHours(recap.total_last_8_days)],
          ['B. Total hours available tomorrow', formatHours(recap.available_tomorrow)],
          ['34-hour restart completed today', recap.restart_taken ? 'Yes' : 'No'],
        ]}
        width={boxW + 90}
      />
      <RecapBox
        x={M + boxW + 110}
        label="60 hour / 7 day drivers"
        rows={[
          ['On duty hours today', 'N/A'],
          ['A. Total hours on duty last 7 days', 'N/A'],
          ['B. Total hours available tomorrow', 'N/A'],
        ]}
        width={boxW + 60}
        muted
      />
      <g>
        <text x={M + 2 * boxW + 200} y={RECAP_TOP + 20} className="log-field-label">
          Total miles driving today
        </text>
        <text x={M + 2 * boxW + 200} y={RECAP_TOP + 46} className="log-recap-figure">
          {formatMiles(log.miles_today)}
        </text>
      </g>
    </g>
  )
}

function RecapBox({
  x: bx,
  label,
  rows,
  width,
  muted = false,
}: {
  x: number
  label: string
  rows: [string, string][]
  width: number
  muted?: boolean
}) {
  const top = RECAP_TOP + 10
  const rowH = 20
  return (
    <g className={muted ? 'log-recap muted' : 'log-recap'}>
      <rect x={bx} y={top} width={width} height={rowH * (rows.length + 1)} className="log-recap-box" />
      <text x={bx + 8} y={top + 14} className="log-recap-head">
        {label}
      </text>
      {rows.map(([name, value], index) => (
        <g key={name}>
          <text x={bx + 8} y={top + rowH * (index + 1) + 14} className="log-recap-label">
            {name}
          </text>
          <text x={bx + width - 8} y={top + rowH * (index + 1) + 14} textAnchor="end" className="log-recap-value">
            {value}
          </text>
        </g>
      ))}
    </g>
  )
}

/* -- accessible description ------------------------------------------------ */

function describe(log: DailyLog, timezone: string): string {
  const segments = log.segments
    .map(
      (segment) =>
        `${STATUS_LABEL[segment.status]} from ${minuteToClock(segment.start_min)} to ${minuteToClock(
          segment.end_min,
        )}`,
    )
    .join('; ')
  const totals = STATUS_ROWS.map(
    (status) => `${STATUS_LABEL[status]} ${formatHours(log.totals[status] ?? 0)} hours`,
  ).join(', ')
  return (
    `Times in ${timezone}. ${formatMiles(log.miles_today)} miles driven. ` +
    `Duty status: ${segments}. Totals: ${totals}. ` +
    `On duty today ${formatHours(log.recap.on_duty_today)} hours; ` +
    `${formatHours(log.recap.total_last_8_days)} hours used of 70; ` +
    `${formatHours(log.recap.available_tomorrow)} hours available tomorrow.`
  )
}

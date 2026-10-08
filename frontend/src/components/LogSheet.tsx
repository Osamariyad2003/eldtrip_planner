/**
 * One daily log sheet, drawn as a facsimile of the standard pre-printed
 * "Driver's Daily Log (24 hours)" paper form: title block with month/day/year
 * blanks, From/To line, mileage and carrier boxes, the black-banded 24-hour
 * grid with quarter-hour ticks and a Total Hours column, the remarks area with
 * shipping documents, and the 70-hour/8-day & 60-hour/7-day recap table.
 *
 * Everything an inspector expects sits where it sits on paper; the plan's data
 * is written into the blanks. The viewBox is letter-landscape proportioned
 * (1056 x 816 at 96 dpi) so the PDF exporter keeps crisp vector output and
 * predictable print sizing.
 */

import type { Bracket, DailyLog, DutyStatus, Remark } from '../lib/types'
import {
  STATUS_COLOR,
  STATUS_LABEL,
  STATUS_ROWS,
  formatHours,
  formatMiles,
  minuteToClock,
} from '../lib/vocab'

const W = 1056
const H = 816
const M = 36

/* The form is a printed document: black rules on white, no colour except the
 * duty-status trace, which stays colour-coded to match the app's status chips. */
const INK = '#111111'
const RULE = '#111111'
const FAINT = '#9AA3AE'
const BAND = '#111111'

/* -- Grid geometry -------------------------------------------------------- */

const GRID_LEFT = 150
const TOTAL_W = 74
const GRID_RIGHT = W - M - TOTAL_W
const GRID_W = GRID_RIGHT - GRID_LEFT
const BAND_TOP = 252
const BAND_H = 24
const GRID_TOP = BAND_TOP + BAND_H
const ROW_H = 33
const GRID_BOTTOM = GRID_TOP + ROW_H * STATUS_ROWS.length

/* -- Section geometry ----------------------------------------------------- */

const TICKS_H = 38
const REMARKS_TOP = GRID_BOTTOM + TICKS_H + 20
const REMARKS_H = 96
const SHIP_GAP = 10
const SHIP_H = 60
const INSTR_GAP = 14
const RECAP_H = 112

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

  // The remarks area carries every duty status change: this is a compliance
  // record, so the sheet grows to fit them rather than hiding the tail. The
  // sections below it shift down by the same amount.
  const remarksH = remarksHeight(log.remarks.length)
  const shift = remarksH - REMARKS_H
  const sheetH = H + shift

  const shipTop = REMARKS_TOP + remarksH + SHIP_GAP
  const instrTop = shipTop + SHIP_H + INSTR_GAP
  const recapTop = instrTop + 28

  return (
    <svg
      className="log-sheet"
      data-day-index={dayIndex}
      viewBox={`0 0 ${W} ${sheetH}`}
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-labelledby={`${titleId} ${descId}`}
      preserveAspectRatio="xMidYMid meet"
    >
      <title id={titleId}>{`Driver's daily log for ${log.date}`}</title>
      <desc id={descId}>{describe(log, timezone)}</desc>

      <rect x={0} y={0} width={W} height={sheetH} fill="#ffffff" />

      <Masthead log={log} />
      <HeaderBoxes log={log} />
      <HourBand />
      <Grid log={log} />
      <RowLabels />
      <TotalsColumn log={log} />
      <Brackets brackets={log.brackets} />
      <RemarkTicks remarks={log.remarks} />
      <RemarksArea remarks={log.remarks} height={remarksH} />
      <ShippingBlock log={log} top={shipTop} />
      <Instructions top={instrTop} timezone={timezone} />
      <Recap log={log} top={recapTop} />
      <Disclaimer top={recapTop + RECAP_H + 13} />
    </svg>
  )
}

/* -- Shared primitives ---------------------------------------------------- */

/** A ruled blank with the plan's value written on it, as it would be in pen. */
function Blank({
  x: px,
  width,
  y: py,
  value,
  caption,
  valueSize = 11,
  captionSize = 7.5,
  max = 40,
}: {
  x: number
  width: number
  y: number
  value?: string
  caption?: string
  valueSize?: number
  captionSize?: number
  max?: number
}) {
  return (
    <g>
      {value !== undefined && (
        <text x={px + width / 2} y={py - 5} textAnchor="middle" fill={INK} fontSize={valueSize} fontWeight="600">
          {truncate(value, max)}
        </text>
      )}
      <line x1={px} y1={py} x2={px + width} y2={py} stroke={RULE} strokeWidth={1} />
      {caption && (
        <text x={px + width / 2} y={py + 11} textAnchor="middle" fill={INK} fontSize={captionSize}>
          {caption}
        </text>
      )}
    </g>
  )
}

/** A ruled box with its printed caption underneath, as on the paper form. */
function CaptionBox({
  x: px,
  y: py,
  width,
  height,
  value,
  caption,
  valueSize = 13,
  max = 28,
}: {
  x: number
  y: number
  width: number
  height: number
  value: string
  caption: string[]
  valueSize?: number
  max?: number
}) {
  return (
    <g>
      <rect x={px} y={py} width={width} height={height} fill="none" stroke={RULE} strokeWidth={1} />
      <text
        className="log-num"
        x={px + width / 2}
        y={py + height / 2 + 5}
        textAnchor="middle"
        fill={INK}
        fontSize={valueSize}
        fontWeight="700"
      >
        {truncate(value, max)}
      </text>
      {caption.map((line, i) => (
        <text
          key={line}
          x={px + width / 2}
          y={py + height + 11 + i * 9}
          textAnchor="middle"
          fill={INK}
          fontSize="7.5"
        >
          {line}
        </text>
      ))}
    </g>
  )
}

function truncate(value: string, max: number): string {
  const text = (value ?? '').trim()
  if (!text) return ''
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** Greedy word wrap for the tiny printed instructions in the recap table. */
function wrap(text: string, maxChars: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/)) {
    const candidate = line ? `${line} ${word}` : word
    if (candidate.length > maxChars && line) {
      lines.push(line)
      line = word
    } else {
      line = candidate
    }
  }
  if (line) lines.push(line)
  return lines
}

/* -- Masthead: title, date blanks, filing note, From / To ----------------- */

function Masthead({ log }: { log: DailyLog }) {
  const [year, month, day] = log.date.split('-')

  return (
    <g>
      <text x={M} y={34} fill={INK} fontSize="22" fontWeight="800" letterSpacing="-0.3">
        Drivers Daily Log
      </text>
      <text x={M + 10} y={50} fill={INK} fontSize="9">
        (24 hours)
      </text>

      {/* ____ / ____ / ____  (month) (day) (year) */}
      <Blank x={318} width={92} y={34} value={month} caption="(month)" valueSize={12} />
      <text x={416} y={34} fill={INK} fontSize="12">
        /
      </text>
      <Blank x={426} width={78} y={34} value={day} caption="(day)" valueSize={12} />
      <text x={510} y={34} fill={INK} fontSize="12">
        /
      </text>
      <Blank x={520} width={92} y={34} value={year} caption="(year)" valueSize={12} />

      <text x={672} y={24} fill={INK} fontSize="8.5">
        Original - File at home terminal.
      </text>
      <text x={672} y={38} fill={INK} fontSize="8.5">
        Duplicate - Driver retains in his/her possession for 8 days.
      </text>

      <text x={M} y={84} fill={INK} fontSize="11" fontWeight="700">
        From:
      </text>
      <Blank x={M + 42} width={430} y={86} value={log.header.from_label} max={52} />

      <text x={530} y={84} fill={INK} fontSize="11" fontWeight="700">
        To:
      </text>
      <Blank x={562} width={W - M - 562} y={86} value={log.header.to_label} max={52} />
    </g>
  )
}

/* -- Mileage boxes, carrier, office and terminal addresses ---------------- */

function HeaderBoxes({ log }: { log: DailyLog }) {
  const h = log.header
  const miles = `${formatMiles(log.miles_today)}`

  return (
    <g>
      <CaptionBox
        x={M + 14}
        y={112}
        width={158}
        height={34}
        value={miles}
        caption={['Total Miles Driving Today']}
      />
      <CaptionBox
        x={M + 190}
        y={112}
        width={152}
        height={34}
        value={miles}
        caption={['Total Mileage Today']}
      />
      <CaptionBox
        x={M + 14}
        y={176}
        width={328}
        height={34}
        value={h.vehicle}
        caption={['Truck/Tractor and Trailer Numbers or', 'License Plate(s)/State (show each unit)']}
        valueSize={11}
        max={44}
      />

      <Blank x={448} width={W - M - 448} y={132} value={h.carrier} caption="Name of Carrier or Carriers" max={60} />
      <Blank x={448} width={W - M - 448} y={174} value={h.main_office} caption="Main Office Address" max={60} />
      <Blank x={448} width={W - M - 448} y={216} value={h.home_terminal} caption="Home Terminal Address" max={60} />
    </g>
  )
}

/* -- Hour band ------------------------------------------------------------ */

const HOUR_LABELS = Array.from({ length: 25 }, (_, hour) => {
  if (hour === 0 || hour === 24) return 'Mid-\nnight'
  if (hour === 12) return 'Noon'
  return String(hour % 12)
})

function HourBand() {
  return (
    <g>
      <rect x={GRID_LEFT} y={BAND_TOP} width={GRID_W + TOTAL_W} height={BAND_H} fill={BAND} />

      {HOUR_LABELS.map((label, hour) => {
        const cx = x(hour * 60)
        const anchor = hour === 0 ? 'start' : hour === 24 ? 'end' : 'middle'
        const dx = hour === 0 ? 1 : hour === 24 ? -1 : 0
        if (label.includes('\n')) {
          return (
            <g key={hour}>
              <text x={cx + dx} y={BAND_TOP + 11} textAnchor={anchor} fill="#FFFFFF" fontSize="7" fontWeight="700">
                Mid-
              </text>
              <text x={cx + dx} y={BAND_TOP + 20} textAnchor={anchor} fill="#FFFFFF" fontSize="7" fontWeight="700">
                night
              </text>
            </g>
          )
        }
        return (
          <text
            key={hour}
            x={cx}
            y={BAND_TOP + 16}
            textAnchor="middle"
            fill="#FFFFFF"
            fontSize={label === 'Noon' ? 7 : 8}
            fontWeight="700"
          >
            {label}
          </text>
        )
      })}

      <text
        x={GRID_RIGHT + TOTAL_W / 2}
        y={BAND_TOP + 11}
        textAnchor="middle"
        fill="#FFFFFF"
        fontSize="7"
        fontWeight="700"
      >
        Total
      </text>
      <text
        x={GRID_RIGHT + TOTAL_W / 2}
        y={BAND_TOP + 20}
        textAnchor="middle"
        fill="#FFFFFF"
        fontSize="7"
        fontWeight="700"
      >
        Hours
      </text>
    </g>
  )
}

/* -- Grid, quarter-hour ticks & duty-status trace ------------------------- */

function Grid({ log }: { log: DailyLog }) {
  return (
    <g>
      {/* Hour rules, full height */}
      {Array.from({ length: 25 }, (_, hour) => (
        <line
          key={hour}
          x1={x(hour * 60)}
          y1={GRID_TOP}
          x2={x(hour * 60)}
          y2={GRID_BOTTOM}
          stroke={RULE}
          strokeWidth={hour % 24 === 0 ? 1.2 : 0.7}
        />
      ))}

      {/* Quarter-hour ticks hanging from the top and bottom of each row */}
      {STATUS_ROWS.map((status) =>
        Array.from({ length: 24 }, (_, hour) =>
          [15, 30, 45].map((minute) => {
            const tx = x(hour * 60 + minute)
            const len = minute === 30 ? 11 : 6
            return (
              <g key={`${status}-${hour}-${minute}`}>
                <line
                  x1={tx}
                  y1={rowTop(status)}
                  x2={tx}
                  y2={rowTop(status) + len}
                  stroke={RULE}
                  strokeWidth={0.6}
                />
                <line
                  x1={tx}
                  y1={rowTop(status) + ROW_H}
                  x2={tx}
                  y2={rowTop(status) + ROW_H - len}
                  stroke={RULE}
                  strokeWidth={0.6}
                />
              </g>
            )
          }),
        ),
      )}

      {/* Row rules */}
      {Array.from({ length: STATUS_ROWS.length + 1 }, (_, index) => (
        <line
          key={index}
          x1={GRID_LEFT}
          y1={GRID_TOP + index * ROW_H}
          x2={GRID_RIGHT + TOTAL_W}
          y2={GRID_TOP + index * ROW_H}
          stroke={RULE}
          strokeWidth={index === 0 || index === STATUS_ROWS.length ? 1.2 : 0.7}
        />
      ))}

      {/* Totals column divider and outer frame */}
      <line x1={GRID_RIGHT} y1={GRID_TOP} x2={GRID_RIGHT} y2={GRID_BOTTOM} stroke={RULE} strokeWidth={1.2} />
      <line x1={W - M} y1={GRID_TOP} x2={W - M} y2={GRID_BOTTOM} stroke={RULE} strokeWidth={1.2} />

      <StatusTrace log={log} />
    </g>
  )
}

/**
 * The duty-status trace: a continuous pen line along the middle of each row,
 * with a vertical riser at every status change. Segments keep their FMCSA
 * status colour so the drawn day reads the same as the app's status chips.
 */
function StatusTrace({ log }: { log: DailyLog }) {
  const segments = log.segments
  if (!segments || segments.length === 0) return null

  return (
    <g className="log-status-trace">
      {segments.map((seg, idx) => {
        const next = segments[idx + 1]
        if (!next) return null
        const rx = x(seg.end_min)
        return (
          <line
            key={`riser-${seg.start_min}-${idx}`}
            x1={rx}
            y1={rowMid(seg.status)}
            x2={rx}
            y2={rowMid(next.status)}
            stroke={INK}
            strokeWidth={2}
          />
        )
      })}

      {segments.map((seg, idx) => {
        const x1 = x(seg.start_min)
        const x2 = Math.max(x(seg.end_min), x1 + 1)
        return (
          <line
            key={`seg-${seg.start_min}-${idx}`}
            x1={x1}
            y1={rowMid(seg.status)}
            x2={x2}
            y2={rowMid(seg.status)}
            stroke={STATUS_COLOR[seg.status]}
            strokeWidth={3}
          />
        )
      })}
    </g>
  )
}

/* -- Numbered row labels -------------------------------------------------- */

const ROW_CAPTION: Record<DutyStatus, string[]> = {
  off_duty: ['1. Off Duty'],
  sleeper_berth: ['2. Sleeper', 'Berth'],
  driving: ['3. Driving'],
  on_duty: ['4. On Duty', '(not driving)'],
}

function RowLabels() {
  return (
    <g>
      {STATUS_ROWS.map((status) => {
        const lines = ROW_CAPTION[status]
        const top = rowMid(status) - (lines.length - 1) * 6 + 3
        return (
          <g key={status}>
            {lines.map((line, i) => (
              <text key={line} x={M} y={top + i * 12} fill={INK} fontSize="10" fontWeight="600">
                {line}
              </text>
            ))}
          </g>
        )
      })}
    </g>
  )
}

/* -- Totals column -------------------------------------------------------- */

function TotalsColumn({ log }: { log: DailyLog }) {
  const sum = STATUS_ROWS.reduce((total, status) => total + (log.totals[status] ?? 0), 0)

  return (
    <g>
      {STATUS_ROWS.map((status) => (
        <text
          key={status}
          className="log-num"
          x={GRID_RIGHT + TOTAL_W / 2}
          y={rowMid(status) + 4}
          textAnchor="middle"
          fill={INK}
          fontSize="11.5"
          fontWeight="700"
        >
          {hoursAndMinutes(log.totals[status] ?? 0)}
        </text>
      ))}

      {/* The day's total sits in its own box under the Total Hours column. */}
      <rect
        x={GRID_RIGHT}
        y={GRID_BOTTOM}
        width={TOTAL_W}
        height={20}
        fill="none"
        stroke={RULE}
        strokeWidth={1.2}
      />
      <text
        className="log-num"
        x={GRID_RIGHT + TOTAL_W / 2}
        y={GRID_BOTTOM + 14}
        textAnchor="middle"
        fill={INK}
        fontSize="11.5"
        fontWeight="800"
      >
        {hoursAndMinutes(sum)}
      </text>
    </g>
  )
}

function hoursAndMinutes(hours: number): string {
  const total = Math.round(hours * 60)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

/* -- Stationary brackets & the city names written under the grid ---------- */

function Brackets({ brackets }: { brackets: Bracket[] }) {
  if (!brackets || brackets.length === 0) return null

  return (
    <g className="log-brackets">
      {brackets.map((bracket) => {
        const x1 = x(bracket.start_min)
        const x2 = Math.max(x(bracket.end_min), x1 + 4)
        return (
          <path
            key={`${bracket.start_min}-${bracket.end_min}`}
            d={`M ${x1} ${GRID_BOTTOM + 2} v 4 H ${x2} v -4`}
            fill="none"
            stroke={FAINT}
            strokeWidth={1}
          />
        )
      })}
    </g>
  )
}

/** On paper the driver writes each place name vertically beneath its tick. */
function RemarkTicks({ remarks }: { remarks: Remark[] }) {
  if (!remarks || remarks.length === 0) return null

  return (
    <g className="log-remark-ticks">
      {remarks.map((remark) => {
        const rx = Number(x(remark.minute).toFixed(2))
        return (
          <g key={`${remark.minute}-${remark.note}`}>
            <line x1={rx} y1={GRID_BOTTOM} x2={rx} y2={GRID_BOTTOM + 13} stroke={INK} strokeWidth={0.7} />
            <text
              transform={`translate(${rx + 3} ${GRID_BOTTOM + 15}) rotate(90)`}
              fill={INK}
              fontSize="6.5"
              fontWeight="600"
            >
              {truncate(shortPlace(remark.location), 9)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/** "Dallas, TX" out of "Dallas, TX, United States". */
function shortPlace(label: string): string {
  const parts = (label ?? '').split(',').map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return ''
  return parts.slice(0, 2).join(', ')
}

/* -- Remarks -------------------------------------------------------------- */

const REMARK_COLS = 2
const REMARK_ROWS = 5
const REMARK_ROW_H = 13
/** Chrome above the first line of entries. */
const REMARK_PAD_TOP = 26

/** The area keeps its printed height for a short day and grows for a long one. */
function remarksHeight(count: number): number {
  const rows = Math.max(REMARK_ROWS, Math.ceil(count / REMARK_COLS))
  return REMARK_PAD_TOP + rows * REMARK_ROW_H + 8
}

function RemarksArea({ remarks, height }: { remarks: Remark[]; height: number }) {
  const colW = (W - 2 * M - 24) / REMARK_COLS

  return (
    <g>
      <text x={M + 6} y={REMARKS_TOP - 6} fill={INK} fontSize="12" fontWeight="700">
        Remarks
      </text>
      <rect x={M} y={REMARKS_TOP} width={W - 2 * M} height={height} fill="none" stroke={RULE} strokeWidth={1} />

      {remarks.length === 0 && (
        <text x={M + 14} y={REMARKS_TOP + REMARK_PAD_TOP} fill={FAINT} fontSize="9">
          No duty status changes recorded for this day.
        </text>
      )}

      {remarks.map((remark, i) => {
        const col = i % REMARK_COLS
        const row = Math.floor(i / REMARK_COLS)
        const px = M + 14 + col * colW
        const py = REMARKS_TOP + REMARK_PAD_TOP + row * REMARK_ROW_H
        return (
          <g key={`${remark.minute}-${remark.note}`}>
            <text className="log-num" x={px} y={py} fill={INK} fontSize="9" fontWeight="700">
              {minuteToClock(remark.minute)}
            </text>
            <text x={px + 42} y={py} fill={INK} fontSize="9" fontWeight="600">
              {truncate(shortPlace(remark.location), 26)}
            </text>
            <text x={px + 212} y={py} fill={INK} fontSize="8.5">
              {truncate(remark.note, 34)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

/* -- Shipping documents --------------------------------------------------- */

function ShippingBlock({ log, top }: { log: DailyLog; top: number }) {
  const h = log.header

  return (
    <g>
      <rect x={M} y={top} width={520} height={SHIP_H} fill="none" stroke={RULE} strokeWidth={1} />
      <text x={M + 10} y={top + 14} fill={INK} fontSize="9.5" fontWeight="700">
        Shipping Documents:
      </text>

      <text x={M + 10} y={top + 32} fill={INK} fontSize="8.5">
        DVL or Manifest No.
      </text>
      <Blank x={M + 128} width={180} y={top + 33} value={h.shipping_document} max={26} valueSize={9.5} />
      <text x={M + 320} y={top + 32} fill={INK} fontSize="8.5">
        or
      </text>

      <text x={M + 10} y={top + 52} fill={INK} fontSize="8.5">
        Shipper &amp; Commodity
      </text>
      <Blank
        x={M + 128}
        width={380}
        y={top + 53}
        value={[h.shipper, h.commodity].filter(Boolean).join(' / ')}
        max={56}
        valueSize={9.5}
      />

      {/* Driver identity, which the paper form carries as a signature line. */}
      <Blank x={580} width={240} y={top + 33} value={h.driver} caption="Driver's signature in full" max={34} />
      <Blank x={836} width={W - M - 836} y={top + 33} value={h.co_driver} caption="Name of co-driver" max={26} />
    </g>
  )
}

function Instructions({ top, timezone }: { top: number; timezone: string }) {
  return (
    <g>
      <text x={W / 2} y={top} textAnchor="middle" fill={INK} fontSize="8.5">
        Enter name of place you reported and where released from work and when and where each change of duty occurred.
      </text>
      <text x={W / 2} y={top + 12} textAnchor="middle" fill={INK} fontSize="8.5">
        {`Use time standard of home terminal. (${timezone})`}
      </text>
    </g>
  )
}

/* -- Recap ---------------------------------------------------------------- */

interface RecapCell {
  x: number
  width: number
  lines: string[]
  value?: string
}

function Recap({ log, top }: { log: DailyLog; top: number }) {
  const left = M
  const right = W - M
  const bottom = top + RECAP_H

  // Column edges, following the printed form left to right.
  const edges = [left, 126, 196, 286, 376, 466, 556, 646, 736, 826, 916, right]

  const col = (index: number) => ({ x: edges[index], width: edges[index + 1] - edges[index] })

  // The planner runs the 70-hour/8-day cycle, so only that half is filled in;
  // the 60-hour/7-day columns stay blank, as they would on paper.
  const cells: RecapCell[] = [
    {
      ...col(2),
      lines: ['On duty', 'hours', 'today,', 'Total lines', '3 & 4'],
      value: formatHours(log.recap.on_duty_today),
    },
    {
      ...col(3),
      lines: wrap('A. Total hours on duty last 7 days including today.', 14),
      value: formatHours(log.recap.total_last_8_days),
    },
    {
      ...col(4),
      lines: wrap('B. Total hours available tomorrow 70 hr. minus A*', 14),
      value: formatHours(log.recap.available_tomorrow),
    },
    { ...col(5), lines: wrap('C. Total hours on duty last 5 days including today.', 14) },
    { ...col(7), lines: wrap('A. Total hours on duty last 8 days including today.', 14) },
    { ...col(8), lines: wrap('B. Total hours available tomorrow 60 hr. minus A*', 14) },
    { ...col(9), lines: wrap('C. Total hours on duty last 7 days including today.', 14) },
  ]

  return (
    <g>
      <rect x={left} y={top} width={right - left} height={RECAP_H} fill="none" stroke={RULE} strokeWidth={1} />

      {/* Column rules */}
      {edges.slice(1, -1).map((edge) => (
        <line key={edge} x1={edge} y1={top} x2={edge} y2={bottom} stroke={RULE} strokeWidth={0.7} />
      ))}

      {/* Recap caption */}
      {['Recap:', 'Complete at', 'end of day'].map((line, i) => (
        <text key={line} x={left + 8} y={top + 16 + i * 11} fill={INK} fontSize="8.5" fontWeight="600">
          {line}
        </text>
      ))}

      {/* Driver-class headings */}
      {['70 Hour/', '8 Day', 'Drivers'].map((line, i) => (
        <text key={line} x={edges[1] + 8} y={top + 16 + i * 11} fill={INK} fontSize="8.5" fontWeight="700">
          {line}
        </text>
      ))}
      {['60 Hour/', '7 Day', 'Drivers'].map((line, i) => (
        <text key={line} x={edges[6] + 8} y={top + 16 + i * 11} fill={INK} fontSize="8.5" fontWeight="700">
          {line}
        </text>
      ))}

      {cells.map((cell) => (
        <g key={`${cell.x}-${cell.lines[0]}`}>
          {cell.lines.map((line, i) => (
            <text key={line + i} x={cell.x + 7} y={top + 32 + i * 10} fill={INK} fontSize="7.5">
              {line}
            </text>
          ))}
          {cell.value !== undefined && (
            <text
              className="log-num"
              x={cell.x + cell.width / 2}
              y={bottom - 10}
              textAnchor="middle"
              fill={INK}
              fontSize="12"
              fontWeight="800"
            >
              {cell.value}
            </text>
          )}
        </g>
      ))}

      {/* The 34-hour restart note in the right-hand column */}
      {wrap('*If you took 34 consecutive hours off duty you have 60/70 hours available', 16).map((line, i) => (
        <text key={line + i} x={edges[10] + 7} y={top + 16 + i * 10} fill={INK} fontSize="7.5">
          {line}
        </text>
      ))}
      {log.recap.restart_taken && (
        <text
          x={edges[10] + 7}
          y={bottom - 8}
          fill={INK}
          fontSize="7.5"
          fontWeight="700"
        >
          34-hr restart taken
        </text>
      )}
    </g>
  )
}

/**
 * FR-UI-09, printed on the sheet rather than only in the app chrome: the PDF
 * and the paper copy are what leave the building, so the disclaimer has to
 * travel with them.
 */
function Disclaimer({ top }: { top: number }) {
  return (
    <text x={W / 2} y={top} textAnchor="middle" fill={FAINT} fontSize="7.5">
      Planning tool — projected logs, not an FMCSA-registered ELD. Routing by
      OpenRouteService; map data © OpenStreetMap contributors.
    </text>
  )
}

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

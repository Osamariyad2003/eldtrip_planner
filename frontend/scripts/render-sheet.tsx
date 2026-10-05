/* Renders each daily log sheet to a standalone SVG file, so the drawn output
 * can be checked without a browser. Run: npm run render:sheets <plan.json>
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'

import { LogSheet } from '../src/components/LogSheet'
import type { TripPlan } from '../src/lib/types'

const planPath = process.argv[2]
const outDir = process.argv[3] ?? 'sheet-output'
if (!planPath) throw new Error('usage: render:sheets <plan.json> [outDir]')

const plan = JSON.parse(readFileSync(planPath, 'utf8')) as TripPlan
mkdirSync(outDir, { recursive: true })

const css = readFileSync('src/index.css', 'utf8')
const logStyles = css.slice(css.indexOf('.log-sheet text'), css.indexOf('/* -- skeletons'))

for (const [index, log] of plan.daily_logs.entries()) {
  const body = renderToStaticMarkup(
    LogSheet({ log, timezone: plan.summary.timezone, dayIndex: index }),
  )
  const withStyle = body.replace('>', `><style>${logStyles}</style>`)
  const file = `${outDir}/day-${index + 1}-${log.date}.svg`
  writeFileSync(file, withStyle)
  console.log(`wrote ${file}`)
}

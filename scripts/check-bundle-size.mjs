#!/usr/bin/env node
/**
 * NFR-PERF-04: the initial JavaScript payload must stay at or under 350 KB
 * gzipped.
 *
 * "Initial" means the scripts index.html actually loads on first paint. The
 * PDF libraries are dynamically imported, so their chunks are reported but
 * not counted. Run from the repository root or from frontend/.
 */

import { gzipSync } from 'node:zlib'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const BUDGET_KB = 350

const root = existsSync('frontend/dist') ? 'frontend/dist' : 'dist'
if (!existsSync(root)) {
  console.error(`No build output found at ${root}. Run the frontend build first.`)
  process.exit(1)
}

const html = readFileSync(join(root, 'index.html'), 'utf8')
const entryNames = new Set(
  [...html.matchAll(/(?:src|href)="\/?([^"]+\.js)"/g)].map((match) =>
    match[1].replace(/^assets\//, ''),
  ),
)

const assets = join(root, 'assets')
const files = existsSync(assets) ? readdirSync(assets).filter((f) => f.endsWith('.js')) : []

let initialBytes = 0
const rows = []
for (const file of files) {
  const gzipped = gzipSync(readFileSync(join(assets, file))).length
  const initial = entryNames.has(file)
  if (initial) initialBytes += gzipped
  rows.push({ file, gzipped, initial })
}

rows.sort((a, b) => b.gzipped - a.gzipped)
for (const row of rows) {
  const kb = (row.gzipped / 1024).toFixed(1).padStart(7)
  console.log(`${kb} KB gz  ${row.initial ? 'initial' : 'lazy   '}  ${row.file}`)
}

const initialKb = initialBytes / 1024
console.log(`\nInitial JS: ${initialKb.toFixed(1)} KB gzipped (budget ${BUDGET_KB} KB)`)

if (initialKb > BUDGET_KB) {
  console.error(`FAILED: initial JS exceeds the ${BUDGET_KB} KB budget.`)
  process.exit(1)
}
console.log('Bundle size OK.')

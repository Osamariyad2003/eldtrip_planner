#!/usr/bin/env node
/**
 * AC-10 / NFR-SEC-02: fail the build if a provider key could have leaked.
 *
 * Checks the built frontend bundle and the tracked repository files for
 * anything that looks like an OpenRouteService key, and for a .env file
 * having been committed. Run from the repository root.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** ORS keys are 64-character lowercase hex strings. */
const KEY_SHAPED = /\b[0-9a-f]{48,}\b/
const ASSIGNMENT = /(ORS_API_KEY|VITE_ORS|api_key)\s*[:=]\s*["'][^"'\s]{16,}["']/i

const failures = []

function walk(dir, onFile) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) walk(path, onFile)
    else onFile(path)
  }
}

// 1. The built frontend bundle must not contain a key (FR-SYS-02).
const dist = join('frontend', 'dist')
if (existsSync(dist)) {
  walk(dist, (path) => {
    if (!/\.(js|css|html|map)$/.test(path)) return
    const text = readFileSync(path, 'utf8')
    if (KEY_SHAPED.test(text) || ASSIGNMENT.test(text)) {
      failures.push(`key-shaped string in built asset: ${path}`)
    }
  })
} else {
  console.log('note: frontend/dist not found — run the frontend build first to scan it')
}

// 2. No tracked file may contain a key, and no .env may be tracked.
let tracked = []
try {
  tracked = execSync('git ls-files', { encoding: 'utf8' }).split('\n').filter(Boolean)
} catch {
  console.log('note: not a git repository — skipping the tracked-file scan')
}

for (const file of tracked) {
  if (/(^|\/)\.env$/.test(file) || /(^|\/)\.env\.(?!example)/.test(file)) {
    failures.push(`environment file is tracked: ${file}`)
    continue
  }
  if (!/\.(py|ts|tsx|js|mjs|json|yaml|yml|md|cfg|ini|toml|txt|html|css)$/.test(file)) continue
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  if (file.endsWith('scan-secrets.mjs')) continue
  if (KEY_SHAPED.test(text) || ASSIGNMENT.test(text)) {
    failures.push(`key-shaped string in tracked file: ${file}`)
  }
}

if (failures.length > 0) {
  console.error('Secret scan FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log('Secret scan passed: no provider key found in the bundle or tracked files.')

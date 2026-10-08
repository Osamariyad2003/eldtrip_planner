#!/usr/bin/env node
/**
 * AC-10 / NFR-SEC-02: fail the build if a credential could have leaked.
 *
 * Checks the built frontend bundle and the tracked repository files for
 * anything that looks like a credential, and for a .env file having been
 * committed. Run from the repository root.
 *
 * The scan deliberately covers more than this project's own provider key: a
 * leak is a leak whatever issued it, and an ORS-only scan reads as broader
 * assurance than it gives.
 */

import { execSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Each pattern is specific enough to name the credential it matches, so a
 * failure tells the reader what to go and revoke.
 */
const PATTERNS = [
  // ORS keys are 64-character lowercase hex strings; other hex secrets of that
  // length look the same.
  { name: 'hex API key (e.g. OpenRouteService)', re: /\b[0-9a-f]{48,}\b/ },
  { name: 'JSON Web Token', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { name: 'Mapbox token', re: /\b(?:pk|sk|tk)\.eyJ[A-Za-z0-9_-]{20,}/ },
  // 35 trailing characters is the documented length; the bound is loose so a
  // near-miss transcription is still caught.
  { name: 'Google API key', re: /\bAIza[0-9A-Za-z_-]{32,}/ },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/ },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { name: 'Slack token', re: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'Stripe secret key', re: /\b(?:sk|rk)_live_[0-9A-Za-z]{16,}\b/ },
  { name: 'OpenAI-style secret key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { name: 'private key block', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  // A credential-shaped literal assigned to a credential-shaped name, which is
  // what a mock token or a pasted key usually looks like.
  // A value that announces itself as a credential, which is how placeholder and
  // mock tokens are usually written (`token: 'acme_jwt_token_88492049182'`).
  {
    name: 'credential-shaped literal',
    re: /\b(?:token|key|secret|password|credential)\s*[:=]\s*["'][^"'\s]*(?:jwt|bearer|api[_-]?key|secret|token)[^"'\s]{6,}["']/i,
  },
  {
    name: 'credential assigned to a literal',
    re: /\b(?:ORS_API_KEY|VITE_[A-Z_]*(?:KEY|TOKEN|SECRET)|api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|jwt[_-]?token|password)\b\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  },
]

/** Returns the names of every credential shape found in `text`. */
function findSecrets(text) {
  return PATTERNS.filter(({ re }) => re.test(text)).map(({ name }) => name)
}

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
    for (const name of findSecrets(text)) {
      failures.push(`${name} in built asset: ${path}`)
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
  // This file necessarily contains the shapes it looks for.
  if (file.endsWith('scan-secrets.mjs')) continue
  for (const name of findSecrets(text)) {
    failures.push(`${name} in tracked file: ${file}`)
  }
}

if (failures.length > 0) {
  console.error('Secret scan FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(
  `Secret scan passed: none of the ${PATTERNS.length} credential shapes found in the bundle or tracked files.`,
)

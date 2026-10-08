#!/usr/bin/env node
/**
 * Screenshots the built app, without a backend, a provider key or a network.
 *
 *   npm run screenshots                     every view, into frontend/screenshots/
 *   npm run screenshots -- --view logs      just one
 *   npm run screenshots -- --width 900      a narrower viewport
 *   npm run screenshots -- --no-build       reuse the current dist/
 *   npm run screenshots -- --url https://…  the landing page of a live deploy
 *
 * How it works: the app is built against a same-origin API, then a tiny server
 * serves dist/ and answers /api/ from a recorded plan (fixtures/plan.json - any
 * real API-01 response will do). index.html is served with a driver script
 * appended that loads the sample trip and submits it, so the screenshot catches
 * a populated workspace rather than the empty state. Chrome or Edge in headless
 * mode does the capture; nothing is installed.
 *
 * The fixture is a recording, so what you see is the UI, not the planner. For
 * the engine's own output use the test suite, or `npm run render:sheets`.
 */

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const FRONTEND = resolve(HERE, '..')

/** Each view is one screenshot: a query the driver script reads, and a name. */
const VIEWS = [
  { name: 'empty', query: 'drive=0', about: 'first load, before any trip' },
  { name: 'map', query: '', about: 'route map with the milestones drawer' },
  { name: 'directions', query: 'open=legs', about: 'turn-by-turn in the drawer' },
  { name: 'logs', query: 'view=log', about: 'the drawn daily log sheet' },
]

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
}

/* -- the page driver ------------------------------------------------------- */

/**
 * Appended to index.html. It drives the UI the way a person would - click the
 * sample, click submit, open a tab - because reaching into React's state from
 * outside would screenshot a state the app cannot actually reach.
 */
const DRIVER = `
<script>
(async () => {
  const params = new URLSearchParams(location.search);
  if (params.get('drive') === '0') return;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const button = (text) => [...document.querySelectorAll('button')]
    .find((b) => b.textContent.toLowerCase().includes(text));
  const until = async (text) => {
    for (let i = 0; i < 80 && !button(text); i++) await wait(50);
    return button(text);
  };

  (await until('load sample'))?.click();
  await wait(150);
  (await until('generate eld'))?.click();
  await wait(500);

  const view = params.get('view');
  if (view) {
    [...document.querySelectorAll('[role=tab]')]
      .find((t) => t.textContent.toLowerCase().includes(view))?.click();
    await wait(300);
  }
  const open = params.get('open');
  if (open) {
    button(open)?.click();
    await wait(300);
  }
  document.documentElement.dataset.ready = '1';
})();
</script>
`

/* -- command line ---------------------------------------------------------- */

function parseArgs(argv) {
  const options = {
    out: join(FRONTEND, 'screenshots'),
    width: 1600,
    height: 1000,
    port: 8787,
    build: true,
    view: null,
    url: null,
    fixture: join(HERE, 'fixtures', 'plan.json'),
    browser: process.env.SCREENSHOT_BROWSER ?? null,
    settle: 9000,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const value = () => argv[++i]
    if (arg === '--help' || arg === '-h') return { help: true }
    else if (arg === '--no-build') options.build = false
    else if (arg === '--out') options.out = resolve(value())
    else if (arg === '--width') options.width = Number(value())
    else if (arg === '--height') options.height = Number(value())
    else if (arg === '--port') options.port = Number(value())
    else if (arg === '--view') options.view = value()
    else if (arg === '--url') options.url = value()
    else if (arg === '--fixture') options.fixture = resolve(value())
    else if (arg === '--browser') options.browser = value()
    else if (arg === '--settle') options.settle = Number(value())
    else throw new Error(`unknown option ${arg} (try --help)`)
  }
  return options
}

const HELP = `
Screenshot the ELD Trip Planner UI.

  --view <name>     one of: ${VIEWS.map((v) => v.name).join(', ')}
  --out <dir>       where the PNGs go (default frontend/screenshots)
  --width <px>      viewport width (default 1600)
  --height <px>     viewport height (default 1000)
  --no-build        reuse the existing dist/ instead of rebuilding
  --fixture <file>  an API-01 plan response to serve (default scripts/fixtures/plan.json)
  --url <origin>    screenshot a live deployment's landing page instead
  --browser <path>  Chrome or Edge binary, if it is not found automatically
  --port <n>        port for the local server (default 8787)
  --settle <ms>     how long the page gets before the shot (default 9000)
`

/* -- browser --------------------------------------------------------------- */

const BROWSER_CANDIDATES = [
  process.env.CHROME_PATH,
  // Windows
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  // macOS
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Linux
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
]

function findBrowser(explicit) {
  if (explicit) {
    if (!existsSync(explicit)) throw new Error(`no browser at ${explicit}`)
    return explicit
  }
  const found = BROWSER_CANDIDATES.find((path) => path && existsSync(path))
  if (!found) {
    throw new Error(
      'No Chrome or Edge found. Pass --browser <path> or set SCREENSHOT_BROWSER.',
    )
  }
  return found
}

/**
 * Runs the browser without blocking the event loop. The server answering these
 * requests is this same process, so a synchronous spawn would deadlock: the
 * page would wait on a response the blocked loop could never send.
 */
function capture(browser, url, file, { width, height, settle, profile }) {
  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--virtual-time-budget=${settle}`,
    `--screenshot=${file}`,
    url,
  ])

  const noise = []
  child.stderr.on('data', (chunk) => noise.push(chunk))

  return new Promise((done, failed) => {
    const killer = setTimeout(() => child.kill(), 120_000)
    child.on('error', failed)
    child.on('close', () => {
      clearTimeout(killer)
      // Chrome prints unrelated profile, sync and updater noise on stderr and
      // can exit non-zero after a perfectly good capture, so the file on disk
      // is the only verdict worth trusting.
      if (!existsSync(file)) {
        const why = Buffer.concat(noise)
          .toString()
          .split('\n')
          .filter((line) => /ERROR|failed|refused/i.test(line))
          .filter((line) => !/gcm|updater|TensorFlow|DEPRECATED|named pipe/i.test(line))
          .slice(0, 3)
          .join('\n')
        failed(new Error(`capture failed for ${url}\n${why}`))
        return
      }
      done(statSync(file).size)
    })
  })
}

/* -- the stand-in backend -------------------------------------------------- */

function serve({ dist, plan, port }) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost')

    if (url.pathname.startsWith('/api/')) {
      response.setHeader('Content-Type', 'application/json')
      if (url.pathname.startsWith('/api/health')) {
        response.end(JSON.stringify({ status: 'ok', providers: { ors: true } }))
      } else if (url.pathname.startsWith('/api/geocode')) {
        // A bare array, the shape api.ts expects.
        response.end(JSON.stringify([
          { label: 'Dallas, TX, United States', lat: 32.7767, lng: -96.797 },
          { label: 'Dalhart, TX, United States', lat: 36.0595, lng: -102.5132 },
        ]))
      } else {
        response.end(JSON.stringify(plan))
      }
      return
    }

    // Any unknown path falls through to the SPA entry point.
    let file = join(dist, url.pathname === '/' ? 'index.html' : url.pathname)
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html')

    const body = readFileSync(file)
    response.setHeader('Content-Type', MIME[extname(file)] ?? 'application/octet-stream')
    response.end(
      file.endsWith('index.html')
        ? body.toString().replace('</body>', `${DRIVER}</body>`)
        : body,
    )
  })

  return new Promise((ready, failed) => {
    server.on('error', failed)
    server.listen(port, () => ready(server))
  })
}

/* -- main ------------------------------------------------------------------ */

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(HELP)
    return
  }

  mkdirSync(options.out, { recursive: true })
  const browser = findBrowser(options.browser)
  // A throwaway profile, kept out of the output directory so that only PNGs
  // land there. Chrome can still hold locks on it for a moment after exit, so
  // removing it is best effort - a stale temp directory is not worth a failure.
  const profile = mkdtempSync(join(tmpdir(), 'eld-screenshot-'))
  const shot = async (url, name) => {
    const file = join(options.out, `${name}.png`)
    const bytes = await capture(browser, url, file, { ...options, profile })
    console.log(`  ${name.padEnd(12)} ${(bytes / 1024).toFixed(0).padStart(5)} KB  ${file}`)
  }

  try {
    if (options.url) {
      // A live deployment cannot be driven - the page is not ours to inject
      // into - so this captures what a visitor sees on arrival. It is enough to
      // tell a working deploy from a blank one.
      console.log(`Capturing ${options.url}`)
      await shot(options.url, 'live')
      return
    }

    if (options.build) {
      console.log('Building (VITE_API_URL="" so the app calls this script)…')
      // One command string, not a command plus arguments: npm is a .cmd shim
      // on Windows and needs a shell, and a shell with separate arguments is
      // the combination Node warns about.
      const build = spawnSync('npm run build', {
        cwd: FRONTEND,
        env: { ...process.env, VITE_API_URL: '' },
        stdio: 'inherit',
        shell: true,
      })
      if (build.status !== 0) throw new Error('build failed')
    }

    const dist = join(FRONTEND, 'dist')
    if (!existsSync(join(dist, 'index.html'))) {
      throw new Error('no dist/index.html — run without --no-build')
    }
    if (!existsSync(options.fixture)) {
      throw new Error(`no plan fixture at ${options.fixture}`)
    }

    const plan = JSON.parse(readFileSync(options.fixture, 'utf8'))
    const server = await serve({ dist, plan, port: options.port })
    const base = `http://localhost:${options.port}`
    console.log(`Serving dist/ and a recorded plan on ${base}`)

    try {
      const views = options.view
        ? VIEWS.filter((view) => view.name === options.view)
        : VIEWS
      if (views.length === 0) {
        throw new Error(`unknown view ${options.view}; try ${VIEWS.map((v) => v.name).join(', ')}`)
      }
      console.log(`Capturing ${views.length} view(s) at ${options.width}x${options.height}:`)
      for (const view of views) {
        await shot(view.query ? `${base}/?${view.query}` : `${base}/`, view.name)
      }
    } finally {
      server.close()
    }
  } finally {
    try {
      rmSync(profile, { recursive: true, force: true })
    } catch {
      /* Chrome still has the profile open; the OS will clear it. */
    }
  }
}

main().catch((error) => {
  console.error(`screenshot-app: ${error.message}`)
  process.exitCode = 1
})

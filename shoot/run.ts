// `review shoot`: an item's before and after screenshots, from its scenario, on a stack whose repos it checks out to the item's net change.
import type { Browser, BrowserContext, Page } from 'playwright-core'
import type { Inbox, Shot } from '../review/types'
import type { State } from './plan'
import type { Preset, Scenario, ScenarioShot, ShotSide } from './types'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { configDir } from '../review/config'
import { git } from '../review/git'
import { findItem, nextShotId } from '../review/inbox'
import { load, scenarioFile, shotName, shotsDir, update } from '../review/store'
import { needsShooting, statesOf } from './plan'
import { checkout, repoDir, restore } from './stack'
import { AppError } from './types'

export interface ShootOptions {
  stack: string
  url?: string
  // labels, or pieces of them, to shoot alone
  only?: string[]
  failed?: boolean
  keep?: boolean
  dryRun?: boolean
  headed?: boolean
}

const VIEWPORT = { width: 1440, height: 900 }
// How many times a capture starts over when the stack, not the scenario, made it fail.
const ATTEMPTS = 3
const STEP_TIMEOUT = 20_000
const LOAD_TIMEOUT = 60_000
const ENV_LINE = /^([A-Z_]\w*)=(.*)$/
const QUOTED = /^(["'])(.*)\1$/
const SIDES: ShotSide[] = ['before', 'after']
const TRAILING_SLASH = /\/$/

type Auth = Awaited<ReturnType<BrowserContext['storageState']>>

// The stack accounts the presets log in with live in the .env beside them, whatever folder the CLI runs from.
function loadEnv() {
  const file = join(configDir(), '.env')

  if (!existsSync(file))
    return

  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const [, key, value] = ENV_LINE.exec(line) ?? []

    if (key && process.env[key] === undefined)
      process.env[key] = value!.trim().replace(QUOTED, '$2')
  }
}

async function shell(command: string, cwd: string) {
  console.log(`    $ ${command}`)

  const child = Bun.spawn(['sh', '-c', command], { cwd, stdout: 'inherit', stderr: 'inherit' })

  if (await child.exited !== 0)
    throw new Error(`${command}: exit ${child.exitCode}`)
}

// Whether the page shows nothing at all: a load that died half way still passes the steps of a scenario that waits on nothing.
function isBlank(page: Page): Promise<boolean> {
  // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- only innerText leaves out the scripts and the payload a Nuxt page carries in its body
  return page.evaluate(() => !document.body || (!document.body.innerText.trim() && !document.querySelector('img, svg, canvas, video')))
}

interface Attempt { error: string | null, transient: boolean }

function firstLine(text: string) {
  const end = text.indexOf('\n')

  return end === -1 ? text : text.slice(0, end)
}

async function captureOnce(browser: Browser, preset: Preset, auth: Auth, url: string, file: string, entry: ScenarioShot, side: ShotSide): Promise<Attempt> {
  const videoDir = entry.video ? mkdtempSync(join(tmpdir(), 'review-shot-')) : null
  // A context of its own per attempt, so a retry never reuses the connections the failed one left behind.
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    ...preset.locale && { locale: preset.locale },
    storageState: auth,
    viewport: entry.viewport ?? VIEWPORT,
    ...videoDir ? { recordVideo: { dir: videoDir, size: entry.viewport ?? VIEWPORT } } : {},
  })
  const page = await context.newPage()
  let error: string | null = null
  // The stack is to blame for a page that does not load, the scenario for a step that fails, unless the network dropped under it.
  let transient = false

  // A checkout the dev server is still rebuilding makes the first load slow.
  page.setDefaultTimeout(LOAD_TIMEOUT)

  try {
    await page.goto(`${url}${entry.route}`)
    await preset.ready(page)
  }
  catch (caught) {
    error = (caught as Error).message
    transient = !(caught instanceof AppError)
  }

  if (!error) {
    // Once the app is up a step waits on the app alone, and one that cannot find its element would otherwise sit out the whole load timeout.
    page.setDefaultTimeout(STEP_TIMEOUT)

    try {
      await entry.steps?.({ page, side, url })

      if (await isBlank(page)) {
        error = 'blank page'
        transient = true
      }
    }
    catch (caught) {
      error = (caught as Error).message
      transient = error.includes('net::ERR_')
    }
  }

  // A failed step still gets its screenshot, which usually shows why.
  try {
    if (!videoDir)
      await page.screenshot({ path: file, fullPage: entry.fullPage ?? false })
  }
  catch (caught) {
    error ??= (caught as Error).message
  }

  const video = page.video()

  await context.close()

  // saveAs copies, where a rename fails whenever the temp folder sits on another filesystem.
  if (video && videoDir) {
    await video.saveAs(file)
    rmSync(videoDir, { recursive: true, force: true })
  }

  return { error: error && `${side}: ${firstLine(error)}`, transient }
}

async function capture(browser: Browser, preset: Preset, auth: Auth, url: string, file: string, entry: ScenarioShot, side: ShotSide): Promise<string | null> {
  for (let attempt = 1; ; attempt++) {
    const { error, transient } = await captureOnce(browser, preset, auth, url, file, entry, side)

    if (!error || !transient || attempt === ATTEMPTS)
      return error

    console.log(`  ${side} retried: ${error}`)
  }
}

export interface Planned {
  entry: ScenarioShot
  id: string
  files: Record<ShotSide, string>
  errors: string[]
}

// Files the shot, replacing its last capture, and drops the scenario's shots of this item whose label it no longer gives.
export function record(project: string, item: string, planned: Planned, labels: Set<string>) {
  const gone = update(project, (inbox: Inbox) => {
    const previous = inbox.shots.find(s => s.id === planned.id)
    const stale = inbox.shots.filter(s => s.item === item && s.source === 'shoot' && s.id !== planned.id && !labels.has(s.label))
    const shot: Shot = { id: planned.id, item, label: planned.entry.label, route: planned.entry.route, before: planned.files.before, after: planned.files.after, source: 'shoot', error: planned.errors.join('\n') || null }

    // in place, so a retaken shot keeps its spot in the header
    inbox.shots = previous ? inbox.shots.filter(s => !stale.includes(s)).map(s => s === previous ? shot : s) : [...inbox.shots.filter(s => !stale.includes(s)), shot]

    return [previous, ...stale].flatMap(s => [s?.before, s?.after]).filter(file => file && file !== shot.before && file !== shot.after)
  })

  for (const file of gone)
    rmSync(join(shotsDir(project), file!), { force: true })
}

const describe = (state: State) => [...state].map(([name, rev]) => `${name}@${rev.slice(0, 8)}`).join(' ')

// Returns how many shots failed.
export async function shoot(project: string, ref: string, options: ShootOptions): Promise<number> {
  const inbox = load(project)

  if (!inbox)
    throw new Error(`no inbox for ${project}`)

  const item = findItem(inbox, ref)
  const file = scenarioFile(project, item.key)

  if (!existsSync(file))
    throw new Error(`no scenario for ${item.key}: write ${file}`)

  const presetFile = join(configDir(), 'presets', `${project}.ts`)

  if (!existsSync(presetFile))
    throw new Error(`no preset for ${project}: write ${presetFile}, modelled on ${join(import.meta.dir, 'example-preset.ts')}`)

  loadEnv()

  const scenario = (await import(pathToFileURL(file).href) as { default: Scenario }).default
  const preset = (await import(pathToFileURL(presetFile).href) as { default: Preset }).default
  const stack = resolve(options.stack)
  const url = (options.url ?? preset.url(basename(stack))).replace(TRAILING_SLASH, '')
  const labels = new Set(scenario.shots.map(entry => entry.label))
  const states = statesOf(item)
  const taken: Shot[] = [...inbox.shots]
  const plan: Planned[] = scenario.shots
    .filter(entry => !options.only?.length || options.only.some(only => entry.label.includes(only)))
    .filter(entry => !options.failed || needsShooting(item.key, entry.label, inbox.shots))
    .map((entry) => {
      // ids are handed out up front, a new shot numbering itself after the ones planned before it
      const id = inbox.shots.find(s => s.item === item.key && s.label === entry.label)?.id ?? nextShotId({ ...inbox, shots: taken })
      const extension = entry.video ? '.webm' : '.png'

      taken.push({ id } as Shot)

      return { entry, id, files: { before: shotName(id, 'before', extension), after: shotName(id, 'after', extension) }, errors: [] }
    })

  const dirs = new Map<string, string>()
  const originals: State = new Map()
  const current: State = new Map()

  for (const repo of states.after.keys()) {
    const dir = repoDir(stack, repo)

    if (!dir)
      throw new Error(`no ${repo} in ${stack}`)

    if (git(dir, ['status', '--porcelain', '--untracked-files=no']).trim())
      throw new Error(`${dir} has uncommitted changes`)

    const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()
    const head = git(dir, ['rev-parse', 'HEAD']).trim()

    dirs.set(repo, dir)
    originals.set(repo, branch === 'HEAD' ? head : branch)
    current.set(repo, head)
  }

  for (const side of SIDES)
    console.log(`${side.padEnd(6)} ${describe(states[side])}`)

  for (const planned of plan)
    console.log(`  ${planned.id} ${planned.entry.label}`)

  console.log(`${plan.length} shots of ${item.key} on ${url}`)

  if (options.dryRun || !plan.length)
    return 0

  mkdirSync(shotsDir(project), { recursive: true })

  // A reused HTTP/2 connection to the stack resets module loads after a few pages, and the page never hydrates: HTTP/1.1 opens a connection per request in flight instead.
  const recorded = new Set<Planned>()
  const browser = await chromium.launch({ headless: !options.headed, args: ['--disable-http2'] })

  try {
    const login = await browser.newContext({ ignoreHTTPSErrors: true, ...preset.locale && { locale: preset.locale }, viewport: VIEWPORT })

    await preset.login({ page: await login.newPage(), url })

    const auth = await login.storageState()

    await login.close()

    for (const side of SIDES) {
      await checkout(stack, preset, dirs, current, states[side], shell)
      await Bun.sleep(preset.settle)

      for (const planned of plan) {
        const error = await capture(browser, preset, auth, url, join(shotsDir(project), planned.files[side]), planned.entry, side)

        if (error)
          planned.errors.push(error)
      }
    }

    for (const planned of plan) {
      record(project, item.key, planned, labels)
      recorded.add(planned)
      console.log(`${planned.id} ${planned.entry.label}: ${planned.errors.length ? `failed: ${planned.errors.join(' | ')}` : 'ok'}`)
    }
  }
  finally {
    await browser.close()

    // a run cut short leaves the captures no shot names
    for (const planned of plan.filter(p => !recorded.has(p))) {
      for (const side of SIDES)
        rmSync(join(shotsDir(project), planned.files[side]), { force: true })
    }

    if (!options.keep)
      await restore(stack, preset, dirs, current, originals, shell)
  }

  const failures = plan.filter(planned => planned.errors.length).length

  console.log(`${plan.length - failures}/${plan.length} shots captured; ${options.keep ? 'the stack stays on the after side' : 'the stack is back where it was, migrations kept'}`)

  return failures
}

#!/usr/bin/env bun
// Installs the mods into Herdr's home, and the commit hook and the review skill into Claude Code; the hooks in githooks/ run it again after every commit, pull or checkout.
// Each main.js is linked, so Herdr reloads a mod when setup relinks it; every other file is copied, since Herdr refuses a module behind a symlink.
import type { Keys, Merged } from './install'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { configDir } from '../review/config'
import { reviewsDir } from '../review/store'
import { addCommitHook, fillSkill, mergeKeys, patchLayout } from './install'

const REPO = join(import.meta.dir, '..')
const HERDR = Bun.env.HERDR_APP_HOME || join(homedir(), '.config', 'herdr-app')
const CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json')
const HOOK = `bun ${join(REPO, 'hooks', 'review-collect.ts')} 2>/dev/null || true`
// Not installed: tests, what Herdr generates in a mod folder it checks, and the keys a mod expects, which go into keys.json instead
const LEFT_OUT = /\.test\.ts$|^keys\.json$|^gpui-kit\.d\.ts$|^jsconfig\.json$/
// A mod's paths.js says where this checkout's review CLI and the inboxes are; the installed copy gets the real ones
const PATHS = `export const BUN = ${JSON.stringify(process.execPath)};\nexport const CLI = ${JSON.stringify(join(REPO, 'review', 'cli.ts'))};\nexport const REVIEWS = ${JSON.stringify(reviewsDir())};\n`

const readJson = <T>(path: string, fallback: T): T => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as T : fallback
const shipped = readJson<Record<string, unknown>>(join(HERDR, 'installed.json'), {})
const report: string[] = []

function write<T>(path: string, merged: Merged<T>, what: string) {
  for (const line of merged.kept)
    report.push(`  kept: ${line}`)

  if (!merged.changed.length)
    return

  writeFileSync(path, `${JSON.stringify(merged.value, null, 2)}\n`)

  for (const line of merged.changed)
    report.push(`  ${what}: ${line}`)
}

const mods = readdirSync(join(REPO, 'mods'), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
let wantedKeys: Keys = {}

for (const mod of mods) {
  if (mod in shipped)
    throw new Error(`Herdr ships a mod named ${mod}: rename this repo's one`)

  const from = join(REPO, 'mods', mod)
  const to = join(HERDR, 'mods', mod)

  mkdirSync(to, { recursive: true })

  for (const file of readdirSync(from).filter(name => !LEFT_OUT.test(name))) {
    const target = join(to, file)

    if (file === 'main.js') {
      if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false }))
        rmSync(target)

      symlinkSync(join(from, file), target)
    }
    else {
      const content = file === 'paths.js' ? Buffer.from(PATHS) : readFileSync(join(from, file))

      if (!existsSync(target) || !readFileSync(target).equals(content))
        writeFileSync(target, content)
    }
  }

  const keys = readJson<Keys>(join(from, 'keys.json'), {})

  wantedKeys = mergeKeys(wantedKeys, keys).value
  report.push(`${mod}: installed in ${to}`)
}

// Git runs this setup again after every commit, pull or checkout, unless the checkout already sends its hooks elsewhere
const hooksPath = Bun.spawnSync(['git', '-C', REPO, 'config', '--get', 'core.hooksPath']).stdout.toString().trim()

if (!hooksPath) {
  Bun.spawnSync(['git', '-C', REPO, 'config', 'core.hooksPath', 'githooks'])
  report.push('git hooks: setup runs again after every commit, pull or checkout')
}
else if (hooksPath !== 'githooks') {
  report.push(`git hooks: core.hooksPath is ${hooksPath}, so run setup again after every pull`)
}

const keysFile = join(HERDR, 'keys.json')

write(keysFile, mergeKeys(readJson<Keys>(keysFile, {}), wantedKeys), 'keys.json')

// The shoot presets in the config folder import `herdr-mods/shoot/types` through this link, wherever this checkout sits
const PACKAGE_LINK = join(configDir(), 'node_modules', 'herdr-mods')

mkdirSync(dirname(PACKAGE_LINK), { recursive: true })

rmSync(PACKAGE_LINK, { recursive: true, force: true })
symlinkSync(REPO, PACKAGE_LINK)
report.push(`presets: ${join(configDir(), 'presets')} imports herdr-mods from this checkout`)

const layout = readJson<{ layout?: string }>(join(HERDR, 'shared.json'), {}).layout ?? 'main'

if (`layout:${layout}` in shipped) {
  report.push(`layout ${layout} is Herdr's own and is replaced on every start: clone it, then run setup again`)
  report.push(`  herdr-app do layout.clone '{"name":"${layout}","as":"${layout}-mods"}'`)
}
else {
  const layoutFile = join(HERDR, 'layouts', `${layout}.json`)

  write(layoutFile, patchLayout(readJson(layoutFile, {})), `layout ${layout}`)
}

if (existsSync(join(homedir(), '.claude'))) {
  write(CLAUDE_SETTINGS, addCommitHook(readJson(CLAUDE_SETTINGS, {}), HOOK), 'Claude Code')

  const values = { CLI: `${process.execPath} ${join(REPO, 'review', 'cli.ts')}`, REVIEWS: reviewsDir(), CONFIG: configDir(), REPO }

  for (const skill of readdirSync(join(REPO, 'skills'))) {
    const to = join(homedir(), '.claude', 'skills', skill)
    const content = fillSkill(readFileSync(join(REPO, 'skills', skill, 'SKILL.md'), 'utf8'), values)

    mkdirSync(to, { recursive: true })

    if (!existsSync(join(to, 'SKILL.md')) || readFileSync(join(to, 'SKILL.md'), 'utf8') !== content)
      writeFileSync(join(to, 'SKILL.md'), content)

    report.push(`skill ${skill}: installed in ${to}`)
  }
}

// `review shoot` drives the Chromium build this playwright-core expects; Playwright skips the download when it is already there.
const browser = Bun.spawnSync([process.execPath, join(REPO, 'node_modules', 'playwright-core', 'cli.js'), 'install', '--no-progress', 'chromium'], { stdout: 'pipe', stderr: 'pipe' })

report.push(browser.success ? 'chromium: ready for review shoot' : `chromium: download failed, review shoot will not run until it succeeds\n  ${browser.stderr.toString().trim()}`)
console.log(report.join('\n'))

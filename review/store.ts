// Where the inboxes live (one folder per project under ~/.local/share/herdr-mods/reviews) and how they are read and written by several agents at once.
import type { Inbox } from './types'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { loadConfig } from './config'
import { mainCheckout } from './git'
import { emptyInbox } from './inbox'

const LOCK_WAIT_MS = 10_000
const LOCK_STALE_MS = 30_000
const LOCK_POLL_MS = 25
const SLUG = /[^a-z0-9]+/g
const EDGES = /^-|-$/g
const BARE = /\.git$/
// a project split into `api` and `client` checkouts is named by the folder holding them
const PART = /^(?:api|client|front|back)$/i

export const reviewsDir = () => process.env.HERDR_REVIEWS || join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'herdr-mods', 'reviews')
export const projectDir = (project: string) => join(reviewsDir(), project)
export const shotsDir = (project: string) => join(projectDir(project), 'shots')
// An item's scenario for `review shoot`, named after the ticket number or the loose commit's sha.
export const scenarioFile = (project: string, item: string) => join(projectDir(project), 'scenarios', `${item.replace('#', '')}.ts`)
// A new name on every capture, since the Review tab copies each shot file once and would keep showing the old one.
export const shotName = (id: string, side: 'before' | 'after', extension: string) => `${id}-${side}-${Date.now().toString(36)}${extension}`
const inboxFile = (project: string) => join(projectDir(project), 'inbox.json')

export const slug = (text: string) => text.toLowerCase().replace(SLUG, '-').replace(EDGES, '')

// `.tilidrc`'s key=value lines, the instance falling back on the config's: a project on no known instance has no Tilid to link to.
export function parseTilidrc(text: string, defaultInstance = loadConfig().tilid?.defaultInstance): { instance: string, code: string } | null {
  const values = Object.fromEntries(text.split('\n').map(line => line.split('=').map(part => part.trim())).filter(pair => pair.length >= 2))
  const instance = values.instance || defaultInstance

  return values.project && instance ? { instance, code: values.project } : null
}

function findTilidrc(from: string): string | null {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.tilidrc')))
      return readFileSync(join(dir, '.tilidrc'), 'utf8')

    if (dir === dirname(dir))
      return null
  }
}

export interface Located {
  project: string
  tilid: Inbox['tilid']
  repo: string
  path: string
}

// The inbox a folder's commits go to: its Tilid project when a `.tilidrc` names one above it or above the main checkout, else the checkout's folder name.
export function locate(dir: string): Located {
  const path = mainCheckout(dir)
  const rc = findTilidrc(dir) ?? findTilidrc(path)
  const tilid = rc ? parseTilidrc(rc) : null
  const repo = basename(path).replace(BARE, '')

  return { project: slug(tilid?.code ?? (PART.test(repo) ? basename(dirname(path)) : repo)), tilid, repo, path }
}

export function projects(): string[] {
  const dir = reviewsDir()

  return existsSync(dir) ? readdirSync(dir).filter(name => existsSync(inboxFile(name))) : []
}

export function load(project: string): Inbox | null {
  const file = inboxFile(project)

  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as Inbox : null
}

function lock(project: string): () => void {
  const dir = join(projectDir(project), '.lock')
  const until = Date.now() + LOCK_WAIT_MS

  mkdirSync(projectDir(project), { recursive: true })

  for (;;) {
    try {
      mkdirSync(dir)

      return () => rmSync(dir, { recursive: true, force: true })
    }
    catch {
      if (Date.now() - (statSync(dir, { throwIfNoEntry: false })?.mtimeMs ?? Date.now()) > LOCK_STALE_MS)
        rmSync(dir, { recursive: true, force: true })
      else if (Date.now() > until)
        throw new Error(`the ${project} inbox stays locked: remove ${dir} if nothing is writing it`)

      Bun.sleepSync(LOCK_POLL_MS)
    }
  }
}

// Reads, changes and writes an inbox under its lock, so an agent's note and a click in the Review tab never overwrite each other.
export function update<T>(project: string, change: (inbox: Inbox) => T, create?: () => Inbox): T {
  const unlock = lock(project)

  try {
    const inbox = load(project) ?? create?.()

    if (!inbox)
      throw new Error(`no inbox for ${project}: ${projects().join(', ') || 'none yet'}`)

    const result = change(inbox)
    const tmp = `${inboxFile(project)}.${process.pid}.tmp`

    writeFileSync(tmp, `${JSON.stringify(inbox, null, 1)}\n`)
    renameSync(tmp, inboxFile(project))

    return result
  }
  finally {
    unlock()
  }
}

export const createFor = (located: Located) => () => emptyInbox(located.project, located.tilid)

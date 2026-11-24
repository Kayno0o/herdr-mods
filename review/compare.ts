// An item's before and after pairs as one page for the browser, written by `art` (artifact-kit): a split line to drag, or the two side by side.
import type { Inbox } from './types'
import { rmSync } from 'node:fs'
import { extname, join } from 'node:path'
import { shotsDir, slug } from './store'

const PICTURE = new Set(['.png', '.jpg', '.jpeg', '.webp'])

export const comparePage = (project: string, item: string) => join(shotsDir(project), `${slug(item)}.html`)

// Rewrites the page from the item's pairs that have both sides, a picture each; without any, or without `art`, there is no page.
export function writeCompare(inbox: Inbox, item: string, title: string): string | null {
  const out = comparePage(inbox.project, item)
  const pairs = inbox.shots.filter(s => s.item === item && s.before && s.after && !s.error && PICTURE.has(extname(s.after).toLowerCase()))
  const art = Bun.which('art')

  if (!pairs.length || !art) {
    rmSync(out, { force: true })

    return null
  }

  const dir = shotsDir(inbox.project)
  const run = Bun.spawnSync([art, 'compare', ...pairs.flatMap(s => [join(dir, s.before!), join(dir, s.after!)]), ...pairs.map(s => `--label=${s.label}`), `--title=${title}`, `--out=${out}`], { stdout: 'pipe', stderr: 'pipe' })

  if (run.exitCode !== 0)
    throw new Error(`art compare failed: ${run.stderr.toString().trim()}`)

  return out
}

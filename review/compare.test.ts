import type { Inbox, Shot } from './types'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { comparePage, writeCompare } from './compare'
import { emptyInbox } from './inbox'
import { shotsDir } from './store'
import './testing'

process.env.HERDR_REVIEWS = mkdtempSync(join(tmpdir(), 'review-compare-'))

const shot = (id: string, extra: Partial<Shot> = {}): Shot => ({ id, item: '#7', label: `screen ${id}`, route: null, before: `${id}-before.png`, after: `${id}-after.png`, ...extra })

function inboxWith(shots: Shot[]): Inbox {
  const inbox = { ...emptyInbox('APP'), shots }

  mkdirSync(shotsDir('APP'), { recursive: true })

  for (const s of shots) {
    for (const file of [s.before, s.after].filter(Boolean))
      writeFileSync(join(shotsDir('APP'), file!), `pixels of ${file}`)
  }

  return inbox
}

describe.skipIf(!Bun.which('art'))('writeCompare', () => {
  test('puts the item\'s complete pairs on one page, leaving out a failed, a new and a video shot', () => {
    const inbox = inboxWith([shot('s001'), shot('s002', { error: 'after: timeout' }), shot('s003', { before: null }), shot('s004', { before: 's004-before.webm', after: 's004-after.webm' }), shot('s005', { item: '#8' })])
    const out = writeCompare(inbox, '#7', '#7 Week view')!
    const html = readFileSync(out, 'utf8')

    expect(out).toBe(comparePage('APP', '#7'))
    expect(html).toContain('"label":"screen s001"')
    expect(html).toContain(btoa('pixels of s001-after.png'))
    expect(html).not.toContain('screen s002')
    expect(html).not.toContain('screen s003')
    expect(html).not.toContain('screen s004')
    expect(html).not.toContain('screen s005')
  })

  test('drops the page once the item has no pair left to compare', () => {
    expect(writeCompare(inboxWith([shot('s001')]), '#7', '#7')).not.toBeNull()
    expect(writeCompare(inboxWith([shot('s001', { error: 'before: blank page' })]), '#7', '#7')).toBeNull()
    expect(existsSync(comparePage('APP', '#7'))).toBe(false)
  })

  test('lists its page in a throwaway gallery, never the person\'s own', () => {
    const out = writeCompare(inboxWith([shot('s001')]), '#7', '#7')!
    const registry = join(process.env.ART_DATA ?? '/missing', 'pages.json')

    expect(process.env.ART_DATA!.startsWith(tmpdir())).toBe(true)
    expect(readFileSync(registry, 'utf8')).toContain(JSON.stringify(out))
  })
})

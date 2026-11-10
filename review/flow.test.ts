import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { addCommit, syncRepo } from './add'
import { lineOf, renderView, textAt } from './format'
import { git } from './git'
import { load } from './store'
import { makeRepo } from './testing'
import { summary, view } from './view'

const reviews = mkdtempSync(join(tmpdir(), 'review-store-'))
const config = mkdtempSync(join(tmpdir(), 'review-flow-config-'))
const repo = makeRepo('tilid')

process.env.HERDR_REVIEWS = reviews
process.env.HERDR_MODS_CONFIG = config
writeFileSync(join(repo.dir, '.tilidrc'), 'project=Tilid\n')
writeFileSync(join(config, 'config.json'), JSON.stringify({ tilid: { defaultInstance: 'acme' } }))

afterAll(() => {
  repo.cleanup()
  rmSync(reviews, { recursive: true, force: true })
  rmSync(config, { recursive: true, force: true })
})

describe('the inbox of a repo', () => {
  repo.commit('chore: base', { 'list.vue': 'one\ntwo\nthree\n', 'other.ts': 'x\n' })
  const feat = repo.commit('feat(list): link\n\n#1525 - [GLOBAL] Acces admin', { 'list.vue': 'one\nTWO\nthree\n' })
  const loose = repo.commit('refactor: other', { 'other.ts': 'y\n' })
  const fixup = repo.commit('fixup! feat(list): link', { 'list.vue': 'one\nTWO\nthree\nfour\n' })

  test('files each commit under the Tilid project on the config\'s instance, a fixup under its target\'s ticket', () => {
    expect(addCommit(repo.dir, feat)).toMatchObject({ project: 'tilid', items: ['#1525'], result: 'added' })
    expect(addCommit(repo.dir, loose).items).toEqual([loose])
    expect(addCommit(repo.dir, fixup).items).toEqual(['#1525'])
    expect(addCommit(repo.dir, fixup).result).toBe('held')
    expect(load('tilid')).toMatchObject({ tilid: { instance: 'acme', code: 'Tilid' }, repos: { tilid: repo.dir } })
  })

  test('shows a ticket as one net diff, and one of its commits alone', () => {
    const inbox = load('tilid')!
    const net = view(inbox, '1525')

    expect(net.files.map(f => [f.path, f.added, f.removed])).toEqual([['list.vue', 2, 1]])
    expect(net.ticket).toMatchObject({ number: 1525, screen: 'GLOBAL' })
    expect(view(inbox, '1525', fixup).files[0]!.added).toBe(1)
    expect(summary(inbox).items.map(i => [i.key, i.files, i.read])).toEqual([['#1525', 1, 0], [loose, 1, 0]])
  })

  test('offers the Tilid move on a ticket only once the config names both statuses', () => {
    const inbox = load('tilid')!

    expect(view(inbox, '1525').advance).toBeNull()

    try {
      writeFileSync(join(config, 'config.json'), JSON.stringify({ tilid: { defaultInstance: 'acme', reviewStatus: 'In review', afterReviewStatus: 'Ready' } }))
      expect(view(inbox, '1525').advance).toEqual({ from: 'In review', to: 'Ready' })
      expect(view(inbox, loose).advance).toBeNull()
    }
    finally { writeFileSync(join(config, 'config.json'), JSON.stringify({ tilid: { defaultInstance: 'acme' } })) }
  })

  test('anchors a note by its line\'s text and draws it under that line for an agent', () => {
    const file = view(load('tilid')!, '1525').files[0]!

    expect(lineOf(file.patch, 'four')).toEqual({ side: 'new', line: 4 })
    expect(lineOf(file.patch, 'two')).toEqual({ side: 'old', line: 2 })
    expect(textAt(file.patch, 'new', 2)).toBe('TWO')
    const r = Bun.spawnSync(['bun', join(import.meta.dir, 'cli.ts'), 'note', 'tilid', '1525', 'list.vue', 'say', 'why', '--at', 'four', '--json'], { stdout: 'pipe', stderr: 'pipe', env: process.env })

    expect(r.stderr.toString()).toBe('')
    const note = JSON.parse(r.stdout.toString())

    expect(note).toMatchObject({ line: 4, side: 'new', text: 'four' })
    expect(renderView(view(load('tilid')!, '1525'))).toContain(`    4 │+four\n${' '.repeat(11)}│ ↳ ${note.id} open by claude: say why`)
  })

  test('folds a rebased copy into the commit it replaces', () => {
    git(repo.dir, ['reset', '-q', '--hard', loose])
    git(repo.dir, ['commit', '-q', '--allow-empty', '-m', 'chore: between'])
    git(repo.dir, ['cherry-pick', fixup])
    const copy = git(repo.dir, ['rev-parse', 'HEAD']).trim()

    expect(addCommit(repo.dir, copy).result).toBe('replaced')
    expect(load('tilid')!.commits.find(c => c.sha === copy)!.copies).toEqual([fixup])
  })
})

test('sync files the branch\'s unpushed commits the inbox lacks, once', () => {
  const other = makeRepo('synced')

  try {
    const pushed = other.commit('chore: pushed', { a: '1\n' })

    git(other.dir, ['update-ref', 'refs/remotes/origin/main', pushed])
    const first = other.commit('feat: one', { a: '2\n' })

    addCommit(other.dir, first)
    const second = other.commit('feat: two', { a: '3\n' })
    const third = other.commit('fix: three', { a: '4\n' })

    expect(syncRepo(other.dir).map(a => a.sha)).toEqual([second, third])
    expect(load('synced')!.commits.map(c => c.sha)).toEqual([first, second, third])
    expect(syncRepo(other.dir)).toEqual([])
  }
  finally { other.cleanup() }
})

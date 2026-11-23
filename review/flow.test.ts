import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { addCommit, syncRepo } from './add'
import { lineOf, renderView, textAt } from './format'
import { git } from './git'
import { markRead } from './inbox'
import { load, update } from './store'
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

  test('shows a file read in the net diff as read in each of its commits, the Read box of a commit view marking the net file', () => {
    const inbox = load('tilid')!
    const net = view(inbox, '1525')

    markRead(inbox, net.key, net.files)
    expect(view(inbox, '1525', feat).files.map(f => f.read)).toEqual([true])
    expect(view(inbox, '1525', fixup).files.map(f => f.read)).toEqual([true])
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

test('sync gives older commits their branch, a feature one only to commits no other branch holds', () => {
  const other = makeRepo('backfilled')

  try {
    const pushed = other.commit('chore: pushed', { a: '1\n' })

    git(other.dir, ['update-ref', 'refs/remotes/origin/main', pushed])
    const before = other.commit('fix: before the branch', { a: '2\n' })

    git(other.dir, ['checkout', '-q', '-b', 'feature/groups'])
    const on = other.commit('feat: on the branch', { a: '3\n' })

    syncRepo(other.dir)
    update('backfilled', (inbox) => {
      for (const c of inbox.commits) delete c.branch
    })
    syncRepo(other.dir)

    expect(load('backfilled')!.commits.map(c => [c.sha, c.branch])).toEqual([[before, 'main'], [on, 'feature/groups']])
  }
  finally { other.cleanup() }
})

test('the order command puts an item\'s files in the order given, in its net diff and in one commit\'s view', () => {
  const other = makeRepo('ordered')

  try {
    other.commit('chore: base', { 'a.ts': '1\n', 'b.ts': '1\n', 'c.json': '1\n' })
    const first = other.commit('feat: one\n\n#7 - [SCREEN] Seven', { 'a.ts': '2\n', 'b.ts': '2\n', 'c.json': '2\n' })
    const second = other.commit('feat: two\n\n#7 - [SCREEN] Seven', { 'a.ts': '3\n', 'c.json': '3\n' })

    addCommit(other.dir, first)
    addCommit(other.dir, second)
    const r = Bun.spawnSync(['bun', join(import.meta.dir, 'cli.ts'), 'order', 'ordered', '7'], { stdin: Buffer.from('c.json mechanical\nb.ts the handler first\n'), stdout: 'pipe', stderr: 'pipe', env: process.env })

    expect(r.stderr.toString()).toBe('')
    const inbox = load('ordered')!

    expect(view(inbox, '7').files.map(f => [f.path, f.why, f.mechanical])).toEqual([['b.ts', 'the handler first', false], ['a.ts', null, false], ['c.json', null, true]])
    expect(view(inbox, '7', second).files.map(f => f.path)).toEqual(['a.ts', 'c.json'])
    expect(renderView(view(inbox, '7'))).toContain('=== b.ts (modified, +1 -1): the handler first')
  }
  finally { other.cleanup() }
})

test('the trace command keeps an item\'s requirements with the lines doing them, listed above its diff', () => {
  const other = makeRepo('traced')

  try {
    other.commit('chore: base', { 'a.ts': 'const label = \'one\'\n' })
    addCommit(other.dir, other.commit('feat: french\n\n#8 - [SCREEN] Eight', { 'a.ts': 'const label = \'un\'\n' }))
    const run = (stdin: string) => Bun.spawnSync(['bun', join(import.meta.dir, 'cli.ts'), 'trace', 'traced', '8'], { stdin: Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe', env: process.env })

    expect(run('- Le libellé est en français\n  a.ts label = \'un\'\n- Le libellé est en gras\n').stderr.toString()).toBe('')
    expect(run('- Faux\n  a.ts nowhere\n').stderr.toString()).toContain('no line of a.ts holds "nowhere"')
    const shown = view(load('traced')!, '8')

    expect(shown.trace.map(r => [r.text, r.anchors.map(a => [a.path, a.side, a.line])])).toEqual([['Le libellé est en français', [['a.ts', 'new', 1]]], ['Le libellé est en gras', []]])
    expect(renderView(shown)).toContain('Requirements\n  covered  Le libellé est en français  a.ts:1\n  missing  Le libellé est en gras\n')
  }
  finally { other.cleanup() }
})

test('a feature branch\'s tickets review as one item: read files count in each ticket, a note goes to the ticket that wrote its line', () => {
  const other = makeRepo('featured')
  const cli = (...args: string[]) => Bun.spawnSync(['bun', join(import.meta.dir, 'cli.ts'), ...args], { stdout: 'pipe', stderr: 'pipe', env: process.env })

  try {
    other.commit('chore: base', { 'shared.ts': 'a\nb\n', 'one.ts': '1\n', 'two.ts': '2\n' })
    git(other.dir, ['checkout', '-q', '-b', 'feature/groups'])
    addCommit(other.dir, other.commit('feat: one\n\n#21 - [ONE] One', { 'shared.ts': 'A\nb\n', 'one.ts': 'un\n' }))
    addCommit(other.dir, other.commit('feat: two\n\n#22 - [TWO] Two', { 'shared.ts': 'A\nB\n', 'two.ts': 'deux\n' }))
    const key = 'feature:feature/groups'
    const s = summary(load('featured')!)

    expect(s.items.map(i => [i.key, i.feature])).toEqual([['#21', key], ['#22', key], [key, null]])
    expect(view(load('featured')!, key).files.map(f => f.path).toSorted()).toEqual(['one.ts', 'shared.ts', 'two.ts'])

    expect(cli('read', 'featured', key, 'one.ts', 'shared.ts').stderr.toString()).toBe('')
    const read = (item: string) => view(load('featured')!, item).files.filter(f => f.read).map(f => f.path)

    expect([read(key), read('21'), read('22')]).toEqual([['one.ts', 'shared.ts'], ['one.ts', 'shared.ts'], ['shared.ts']])

    expect(cli('note', 'featured', key, 'shared.ts', 'pourquoi B', '--at', 'B').stderr.toString()).toBe('')
    expect(cli('note', 'featured', key, 'one.ts', 'et ici', '--at', 'un').stderr.toString()).toBe('')
    expect(load('featured')!.notes.map(n => [n.body, n.item])).toEqual([['pourquoi B', '#22'], ['et ici', '#21']])
    expect(view(load('featured')!, key).notes).toHaveLength(2)
    expect(cli('brief', 'featured', key).stdout.toString()).toContain('pourquoi B')

    expect(cli('approve', 'featured', key).stderr.toString()).toBe('')
    expect(summary(load('featured')!).items.map(i => [i.key, i.approved])).toEqual([['#21', true], ['#22', true]])
  }
  finally { other.cleanup() }
})

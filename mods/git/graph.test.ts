import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { CURRENT, FIND_TILIDRC, labelsOf, lanesOf, lineCounts, LOG_FORMAT, logArgs, parseLog, shortAge, ticketLink, tilidUrl, trackerOf } from './graph.js'

// Run from the pre-commit hook, git's own GIT_DIR, GIT_INDEX_FILE and author would point the test repo's commands at this one.
const gitEnv = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith('GIT_')))

const commit = (hash: string, parents: string[] = [], extra = {}) => ({ hash, parents, subject: hash, author: '', email: '', ts: 0, refs: '', ...extra })
const segsOf = (row: { segs: number[][] }) => row.segs.map(([x1, y1, x2, y2]) => `${x1},${y1}>${x2},${y2}`).sort()

describe('lanesOf', () => {
  test('a straight history keeps one lane', () => {
    const { rows, width } = lanesOf([commit('c', ['b']), commit('b', ['a']), commit('a')])

    expect(width).toBe(1)
    expect(rows.map((r: { col: number }) => r.col)).toEqual([0, 0, 0])
    expect(segsOf(rows[0])).toEqual(['0,0.5>0,1'])
    expect(segsOf(rows[1])).toEqual(['0,0.5>0,1', '0,0>0,0.5'])
    expect(segsOf(rows[2])).toEqual(['0,0>0,0.5'])
  })

  test('a merge forks a second lane that joins back as a curve', () => {
    const { rows, width } = lanesOf([commit('m', ['a', 'f']), commit('f', ['a']), commit('a')])

    expect(width).toBe(2)
    expect(rows.map((r: { col: number }) => r.col)).toEqual([0, 1, 0])
    expect(rows[0].merge).toBe(true)
    expect(segsOf(rows[0])).toEqual(['0,0.5>0,1', '0,0.5>1,1'])
    expect(segsOf(rows[1])).toEqual(['0,0>0,1', '1,0.5>1,1', '1,0>1,0.5'])
    expect(segsOf(rows[2])).toEqual(['0,0>0,0.5', '1,0>0,0.5'])
  })

  test('two branch tips open lanes side by side', () => {
    const { rows } = lanesOf([commit('x', ['a']), commit('y', ['a']), commit('a')])

    expect(rows.map((r: { col: number }) => r.col)).toEqual([0, 1, 0])
    expect(segsOf(rows[2])).toEqual(['0,0>0,0.5', '1,0>0,0.5'])
  })

  test('the current row runs a dashed lane down to HEAD', () => {
    const { rows } = lanesOf([{ ...commit(CURRENT, ['h']), current: true }, commit('x', ['h']), commit('h')])

    expect(rows[0].col).toBe(0)
    expect(rows[0].segs.every((s: number[]) => s[5] === 1)).toBe(true)
    expect(rows[1].col).toBe(1)
    const through = rows[1].segs.find((s: number[]) => s[0] === 0 && s[2] === 0)

    expect(through?.[5]).toBe(1)
    const into = rows[2].segs.filter((s: number[]) => s[0] === 0)

    expect(into.every((s: number[]) => s[5] === 1)).toBe(true)
  })
})

describe('labelsOf', () => {
  const remotes = ['origin', 'up/stream']

  test('the checked-out branch comes first, with its remote riding on it', () => {
    const labels = labelsOf('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0, refs/heads/dev', remotes)

    expect(labels).toEqual([
      { kind: 'branch', name: 'main', head: true, remotes: ['origin'] },
      { kind: 'branch', name: 'dev', head: false, remotes: [] },
      { kind: 'tag', name: 'v1.0' },
    ])
  })

  test('a remote-only branch keeps its remote, even one with a slash', () => {
    expect(labelsOf('refs/remotes/up/stream/feat/x', remotes)).toEqual([{ kind: 'remote', name: 'up/stream/feat/x', remote: 'up/stream', branch: 'feat/x' }])
  })

  test('a detached HEAD and stash refs', () => {
    expect(labelsOf('HEAD, refs/stash', remotes)).toEqual([{ kind: 'head' }])
  })

  test('no decoration', () => {
    expect(labelsOf('', remotes)).toEqual([])
  })
})

describe('shortAge', () => {
  const now = Date.UTC(2026, 10, 6, 12) / 1000

  test.each([
    [now - 20, 'now'],
    [now - 600, '10m'],
    [now - 3 * 3600, '3h'],
    [now - 6 * 86400, '6d'],
    [Date.UTC(2026, 9, 3) / 1000, 'Oct 3'],
    [Date.UTC(2025, 2, 9) / 1000, 'Mar 2025'],
  ])('%p reads %p', (ts, text) => expect(shortAge(ts, now)).toBe(text))
})

describe('logArgs', () => {
  test('all branches reads the refs it shows, never --all', () => {
    expect(logArgs({ scope: 'all', remotes: false, limit: 300 })).toEqual(['log', '--date-order', '--decorate=full', '-n', '301', `--format=${LOG_FORMAT}`, '--branches', '--tags', 'HEAD', '--'])
    expect(logArgs({ scope: 'all', remotes: true, limit: 600 })).toContain('--remotes')
    expect(logArgs({ scope: 'current', remotes: true, limit: 300 })).toEqual(['log', '--date-order', '--decorate=full', '-n', '301', `--format=${LOG_FORMAT}`, 'HEAD', '--'])
  })
})

describe('parseLog against git', () => {
  test('reads hashes, parents, refs and dates', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-graph-'))

    try {
      const git = (...args: string[]) => {
        const r = Bun.spawnSync(['git', '-c', 'user.name=T', '-c', 'user.email=t@x', ...args], { cwd: dir, env: gitEnv })

        if (r.exitCode !== 0)
          throw new Error(r.stderr.toString())

        return r.stdout.toString()
      }

      git('init', '-q', '-b', 'main')
      writeFileSync(join(dir, 'a'), '1')
      git('add', 'a')
      git('commit', '-q', '-m', 'first')
      git('switch', '-q', '-c', 'feat')
      writeFileSync(join(dir, 'b'), '2')
      git('add', 'b')
      git('commit', '-q', '-m', 'second\n\nbody')
      git('switch', '-q', 'main')
      git('merge', '-q', '--no-ff', '-m', 'merge feat', 'feat')
      git('tag', 'v1')
      const { commits, more } = parseLog(git(...logArgs({ scope: 'all', remotes: false, limit: 300 })), 300)

      expect(more).toBe(false)
      expect(commits.map((c: { subject: string }) => c.subject)).toEqual(['merge feat', 'second', 'first'])
      expect(commits[0].parents).toHaveLength(2)
      expect(labelsOf(commits[0].refs, [])).toEqual([{ kind: 'branch', name: 'main', head: true, remotes: [] }, { kind: 'tag', name: 'v1' }])
      expect(commits[0].email).toBe('t@x')
      expect(commits[0].ts).toBeGreaterThan(0)
      expect(parseLog(git(...logArgs({ scope: 'all', remotes: false, limit: 2 })), 2)).toMatchObject({ more: true })
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

test('lineCounts reads git grep\'s counts of untracked files, binaries left out', () => {
  const dir = mkdtempSync(join(tmpdir(), 'git-counts-'))

  try {
    Bun.spawnSync(['git', 'init', '-q'], { cwd: dir, env: gitEnv })
    writeFileSync(join(dir, 'a b.txt'), '1\n2\n3\n')
    writeFileSync(join(dir, '*.md'), 'x')
    writeFileSync(join(dir, 'bin'), '\0\x01\x02')
    const paths = ['a b.txt', '*.md', 'bin'].map(p => `:(literal)${p}`)
    const r = Bun.spawnSync(['git', 'grep', '--untracked', '-c', '-I', '-z', '', '--', ...paths], { cwd: dir, env: gitEnv })

    expect(lineCounts(r.stdout.toString())).toEqual({ 'a b.txt': { add: 3, del: 0, binary: false }, '*.md': { add: 1, del: 0, binary: false } })
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test('ticket lines open their Tilid ticket, or their issue on a known forge in a repo without a Tilid project', () => {
  const forges = { 'git.home.lan': 'https://git.example.org', 'forge.example.com': 'https://forge.example.com' }
  const tilid = trackerOf('https://acme.tilid.io/project/Shop', 'git@gitlab.com:acme/shop.git', forges)

  expect(ticketLink('#1525 - [GLOBAL] Access by URL', tilid)).toEqual({ url: 'https://acme.tilid.io/project/Shop?ticket=1525', where: 'Tilid' })
  expect(ticketLink('fixes #1525 later', tilid)).toBeNull()
  const forge = trackerOf(null, 'git@git.home.lan:owner/dots.git\n', forges)

  expect(forge).toEqual({ tilid: null, forge: { web: 'https://git.example.org', repo: 'owner/dots', name: 'git.example.org' } })
  expect(ticketLink('#137 - changes panel', forge)).toEqual({ url: 'https://git.example.org/owner/dots/issues/137', where: 'git.example.org' })
  expect(ticketLink('owner/lib#823 - a bug', forge)?.url).toBe('https://git.example.org/owner/lib/issues/823')
  expect(trackerOf(null, 'ssh://git@forge.example.com:2222/owner/app.git', forges).forge?.repo).toBe('owner/app')
  expect(trackerOf(null, 'https://forge.example.com/owner/app', forges).forge?.repo).toBe('owner/app')
  expect(ticketLink('#1 - x', trackerOf(null, 'git@github.com:a/b.git', forges))).toBeNull()
})

test('a .tilidrc above the repo or its main checkout names the Tilid project ticket lines open', () => {
  expect(tilidUrl('instance=acme\nproject=shop\n')).toBe('https://acme.tilid.io/project/shop')
  expect(tilidUrl('project = Shop', 'acme')).toBe('https://acme.tilid.io/project/Shop')
  expect(tilidUrl('project = Shop')).toBeNull()
  expect(tilidUrl('instance=acme\n')).toBeNull()
  expect(tilidUrl('')).toBeNull()

  const dir = mkdtempSync(join(tmpdir(), 'git-tilidrc-'))

  try {
    const sh = (cwd: string, script: string) => Bun.spawnSync(['sh', '-c', script], { cwd, env: { ...gitEnv, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@x' } }).stdout.toString()
    const main = join(dir, 'project', 'api')

    sh(dir, 'mkdir -p project/api && printf "project=shop\\n" > project/.tilidrc')
    sh(main, 'git init -q -b main && git commit -q --allow-empty -m first && git worktree add -q ../../wt')
    expect(sh(main, FIND_TILIDRC)).toBe('project=shop\n')
    expect(sh(join(dir, 'wt'), FIND_TILIDRC)).toBe('project=shop\n')
    sh(dir, 'rm project/.tilidrc')
    expect(sh(join(dir, 'wt'), FIND_TILIDRC)).toBe('')
  }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

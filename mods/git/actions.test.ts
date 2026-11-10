import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { dialogFor, initialValues, invalid, lastLines, menuFor, plan } from './actions.js'

// Run from the pre-commit hook, git's own GIT_DIR, GIT_INDEX_FILE and author would point the test repo's commands at this one.
const gitEnv = Object.fromEntries(Object.entries(Bun.env).filter(([key]) => !key.startsWith('GIT_')))

const ctx = { branch: 'main', remotes: ['origin'] }
const ids = (items: { id?: string }[]) => items.filter(i => i.id).map(i => i.id)

describe('menuFor', () => {
  test('the checked-out branch can\'t be checked out, deleted, merged or rebased on', () => {
    expect(ids(menuFor({ type: 'branch', name: 'main', head: true, remotes: [] }, ctx))).toEqual(['rename', 'push', 'copy-name'])
    expect(ids(menuFor({ type: 'branch', name: 'dev', head: false, remotes: [] }, ctx))).toEqual(['checkout', 'rename', 'delete-branch', 'merge', 'rebase', 'push', 'copy-name'])
  })

  test('HEAD\'s commit leaves out what makes no sense on itself', () => {
    expect(ids(menuFor({ type: 'commit', hash: 'a', subject: 's', head: true }, ctx))).toEqual(['tag', 'branch', 'revert', 'reset', 'copy-hash', 'copy-subject'])
  })

  test('push needs a remote', () => {
    expect(ids(menuFor({ type: 'tag', name: 'v1' }, { branch: 'main', remotes: [] }))).toEqual(['delete-tag', 'copy-name'])
  })

  test('every destructive action is marked and asks first', () => {
    const targets = [
      { type: 'branch', name: 'dev', head: false, remotes: [] },
      { type: 'remote', name: 'origin/x', remote: 'origin', branch: 'x', local: false },
      { type: 'tag', name: 'v1' },
      { type: 'commit', hash: 'abc', subject: 's', head: false },
      { type: 'current', staged: false },
    ]

    for (const target of targets) {
      for (const item of menuFor(target, ctx).filter((i: { danger?: boolean }) => i.danger)) {
        expect(dialogFor(item.id, target, ctx)?.danger || item.id === 'reset' || item.id === 'reset-current').toBeTruthy()
      }
    }
    expect(dialogFor('reset', { type: 'commit', hash: 'abc', subject: 's' }, ctx)?.modes?.find((m: { name: string }) => m.name === 'hard')?.danger).toBe(true)
  })
})

describe('invalid', () => {
  const spec = dialogFor('tag', { type: 'commit', hash: 'abc', subject: 's' }, ctx)

  test.each([
    [{ name: '' }, 'Name is empty'],
    [{ name: 'a b' }, 'Name can\'t hold spaces or start with -'],
    [{ name: '-x' }, 'Name can\'t hold spaces or start with -'],
    [{ name: 'v1', message: 'free text here' }, null],
  ])('%p', (values, error) => expect(invalid(spec, values)).toBe(error))
})

describe('plan', () => {
  test('a merge commit is cherry picked and reverted against its first parent', () => {
    expect(plan('revert', { type: 'commit', hash: 'abc', merge: true }, {}, ctx).steps).toEqual([['revert', '--no-edit', '-m', '1', 'abc']])
  })

  test('no step ever force-pushes', () => {
    const all = ['push', 'push-tag', 'delete-remote', 'delete-tag'].flatMap(id => plan(id, { type: 'branch', name: 'x', remote: 'origin', branch: 'x' }, { mode: 'origin', upstream: true, remote: true }, ctx).steps ?? [])

    expect(all.flat().some((arg: string) => arg.startsWith('-f') || arg.startsWith('--force') || arg.startsWith('+'))).toBe(false)
  })

  test('a commit stages everything first only when asked', () => {
    expect(plan('commit', { type: 'current' }, { all: true, message: ' fix it ' }, ctx)).toEqual({ unmerged: true, steps: [['add', '--all'], ['commit', '-m', 'fix it']], done: 'Committed' })
    expect(plan('commit', { type: 'current' }, { all: false, message: 'x' }, ctx).steps).toEqual([['commit', '-m', 'x']])
  })

  test('the plans run against git', () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-actions-'))

    try {
      const git = (...args: string[]) => Bun.spawnSync(['git', '-c', 'user.name=T', '-c', 'user.email=t@x', ...args], { cwd: dir, env: gitEnv })
      const run = (p: { steps?: string[][] }) => {
        for (const step of p.steps ?? []) {
          const r = git(...step)

          if (r.exitCode !== 0)
            throw new Error(r.stderr.toString())
        }
      }
      const head = () => git('rev-parse', 'HEAD').stdout.toString().trim()

      git('init', '-q', '-b', 'main')
      writeFileSync(join(dir, 'a'), '1')
      run(plan('commit', { type: 'current' }, { all: true, message: 'first' }, ctx))
      const first = head()

      run(plan('branch', { type: 'commit', hash: first }, { name: 'dev', checkout: true }, ctx))
      writeFileSync(join(dir, 'b'), '2')
      run(plan('commit', { type: 'current' }, { all: true, message: 'second' }, ctx))
      run(plan('checkout', { type: 'branch', name: 'main' }, {}, ctx))
      run(plan('merge', { type: 'branch', name: 'dev' }, { noff: true }, ctx))
      run(plan('tag', { type: 'commit', hash: head() }, { name: 'v1', message: 'release' }, ctx))
      expect(git('cat-file', '-t', 'v1').stdout.toString().trim()).toBe('tag')
      run(plan('reset', { type: 'commit', hash: first }, { mode: 'hard' }, ctx))
      expect(head()).toBe(first)
      run(plan('delete-branch', { type: 'branch', name: 'dev' }, { force: true }, ctx))
      run(plan('delete-tag', { type: 'tag', name: 'v1' }, { remote: false }, ctx))
      expect(git('branch', '--list', 'dev').stdout.toString()).toBe('')
    }
    finally { rmSync(dir, { recursive: true, force: true }) }
  })
})

test('initialValues and lastLines', () => {
  expect(initialValues(dialogFor('reset', { type: 'commit', hash: 'a', subject: 's' }, ctx))).toEqual({ mode: 'mixed' })
  expect(lastLines('error: one\nhint: do this\nfatal: two\n')).toBe('error: one\nfatal: two')
})

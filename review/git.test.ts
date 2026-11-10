import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { commitInfo, git, mainCheckout, netDiff, orphaned, patchId } from './git'
import { makeRepo } from './testing'

const repo = makeRepo()

afterAll(() => repo.cleanup())

describe('netDiff', () => {
  repo.commit('base', { 'f.txt': 'a\nb\nc\nd\ne\n', 'g.txt': 'x\n' })
  const first = repo.commit('feat: one\n\n#1 - [UC] Thing', { 'f.txt': 'a\nB1\nc\nd\ne\n' })
  const other = repo.commit('feat: other', { 'g.txt': 'X\n' })
  const fixup = repo.commit('fix: one', { 'f.txt': 'a\nB2\nc\nD\ne\n' })

  test('folds a fixup into what it fixes and leaves out the commits between', () => {
    const { patch, exact } = netDiff(repo.dir, [first, fixup])

    expect(exact).toBe(true)
    expect(patch).toContain('-b\n+B2\n')
    expect(patch).toContain('-d\n+D\n')
    expect(patch).not.toContain('B1')
    expect(patch).not.toContain('g.txt')
  })

  test('is the commit\'s own diff for one commit', () => {
    expect(netDiff(repo.dir, [other]).patch).toContain('-x\n+X\n')
  })

  test('writes nothing into the repo', () => {
    const before = git(repo.dir, ['count-objects']).trim()

    netDiff(repo.dir, [first, fixup])
    expect(git(repo.dir, ['count-objects']).trim()).toBe(before)
  })

  test('falls back to the range of the touched files on a conflict', () => {
    const lone = repo.commit('feat: lone', { 'f.txt': 'a\nB3\nc\nD\ne\n' })
    const { patch, exact } = netDiff(repo.dir, [first, lone])

    expect(exact).toBe(false)
    expect(patch).toContain('+B3')
    expect(patch).not.toContain('g.txt')
  })
})

describe('commits', () => {
  test('reads a commit\'s message, parents and author', () => {
    const sha = repo.commit('feat: read me\n\nbody line', { 'h.txt': 'h\n' })
    const info = commitInfo(repo.dir, sha)

    expect(info).toMatchObject({ sha, subject: 'feat: read me', body: 'body line', author: 'Test' })
    expect(info.parents).toHaveLength(1)
  })

  test('gives a rebased copy the same patch id, and calls the old one orphaned', () => {
    const sha = repo.commit('feat: moved', { 'm.txt': 'm\n' })

    git(repo.dir, ['reset', '-q', '--hard', 'HEAD~1'])
    repo.commit('feat: unrelated', { 'u.txt': 'u\n' })
    git(repo.dir, ['cherry-pick', sha])
    const copy = git(repo.dir, ['rev-parse', 'HEAD']).trim()

    expect(patchId(repo.dir, copy)).toBe(patchId(repo.dir, sha))
    expect(orphaned(repo.dir, sha)).toBe(true)
    expect(orphaned(repo.dir, copy)).toBe(false)
  })

  test('files a worktree\'s commits under the main checkout', () => {
    const tree = join(repo.dir, '..', `${repo.name}-wt`)

    git(repo.dir, ['worktree', 'add', '-q', tree])
    expect(mainCheckout(tree)).toBe(repo.dir)
    rmSync(tree, { recursive: true, force: true })
  })
})

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { load } from '../review/store'
import { makeRepo } from '../review/testing'
import { commitsIn, dirsOf, mayCommit } from './review-collect'

describe('review-collect', () => {
  test('reads git\'s and gc\'s commit lines, gc\'s only when the command ran gc', () => {
    expect(commitsIn('git commit -m x', '[main 1a2b3c4] fix: x\n 1 file changed')).toEqual(['1a2b3c4'])
    expect(commitsIn('git commit -m x', '[detached HEAD 1a2b3c4] fix: x\n[main (root-commit) 9f8e7d6] first')).toEqual(['1a2b3c4', '9f8e7d6'])
    expect(commitsIn('cd x && gc \'fix: x\' -- a', '1a2b3c4 fix: x\n  M a')).toEqual(['1a2b3c4'])
    expect(commitsIn('git log --oneline', '1a2b3c4 fix: x')).toEqual([])
  })

  test('collects after a command that printed commits or may have made some', () => {
    expect(mayCommit('git rebase -i --autosquash main', [])).toBe(true)
    expect(mayCommit('cd x && git -C y commit -q --fixup HEAD', [])).toBe(true)
    expect(mayCommit('git log --oneline; echo commit', [])).toBe(false)
    expect(mayCommit('bun test', ['1a2b3c4'])).toBe(true)
  })

  test('looks for the commit where the command moved, then in the session\'s folder', () => {
    expect(dirsOf('cd ~/a && git -C \'../b c\' commit; cd /abs', '/w')).toEqual([join(Bun.env.HOME ?? '', 'a'), '/abs', '/b c', '/w'])
    expect(dirsOf('gc x -- a', '/w')).toEqual(['/w'])
  })

  test('files each fresh commit into its inbox with the terminal that made it, and the branch\'s other unpushed ones', () => {
    const repo = makeRepo('proj')
    const reviews = mkdtempSync(join(tmpdir(), 'review-collect-'))

    try {
      const quiet = repo.commit('chore: made in a terminal', { b: '1' })
      const sha = repo.commit('feat: first\n\n#3 - Three', { a: '1' })
      const job = { shas: [sha.slice(0, 7)], dirs: dirsOf('git commit', repo.dir), terminal: 't5j' }
      const r = Bun.spawnSync(['bun', join(import.meta.dir, 'review-collect.ts'), '--collect', JSON.stringify(job)], { env: { ...process.env, HERDR_REVIEWS: reviews } })

      expect(r.exitCode).toBe(0)
      process.env.HERDR_REVIEWS = reviews
      expect(load('proj')!.commits).toMatchObject([{ sha, terminal: 't5j', tickets: [{ number: 3 }] }, { sha: quiet, terminal: null }])
    }
    finally {
      delete process.env.HERDR_REVIEWS
      repo.cleanup()
      rmSync(reviews, { recursive: true, force: true })
    }
  })
})

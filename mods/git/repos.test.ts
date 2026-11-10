import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { makeRepo } from '../../review/testing'
import { choose, familyOf, repoName } from './repos.js'

function run(cmd: string, args: string[], cwd: string) {
  const r = Bun.spawnSync([cmd, ...args], { cwd, env: process.env })

  return { code: r.exitCode, stdout: r.stdout.toString() }
}

describe('a repo family', () => {
  test('is the outer repo and the gitignored repos inside it, whichever one the focus is in', async () => {
    const outer = makeRepo('shop-docker')

    try {
      outer.commit('compose', { '.gitignore': 'shop/\n', 'compose.yaml': 'services: {}\n' })
      run('git', ['init', '-q', 'shop'], outer.dir)
      run('git', ['init', '-q', 'node_modules/pkg'], outer.dir)
      run('git', ['init', '-q', '.claude/worktrees/x'], outer.dir)
      const inner = join(outer.dir, 'shop')

      const family = await familyOf(outer.dir, run)

      expect(family).toEqual({ outer: outer.dir, repos: [outer.dir, inner] })
      expect(await familyOf(inner, run)).toEqual(family)
      expect(family.repos.map(r => repoName(family, r))).toEqual(['shop-docker', 'shop'])
    }
    finally { outer.cleanup() }
  })

  test('shows the last pick, else the nested repo in focus, else the busiest', () => {
    const family = { outer: '/w/d', repos: ['/w/d', '/w/d/app', '/w/d/api'] }

    expect(choose(family, '/w/d', '/w/d/api', {})).toBe('/w/d/api')
    expect(choose(family, '/w/d/app', null, { '/w/d/api': 3 })).toBe('/w/d/app')
    expect(choose(family, '/w/d', null, { '/w/d/api': 3, '/w/d/app': 1 })).toBe('/w/d/api')
    expect(choose(family, '/w/d', '/gone', {})).toBe('/w/d')
  })

  test('the review mod carries the same copy', () => {
    expect(readFileSync(join(import.meta.dir, '../review/repos.js'), 'utf8')).toBe(readFileSync(join(import.meta.dir, 'repos.js'), 'utf8'))
  })
})

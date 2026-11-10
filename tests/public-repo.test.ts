import { join } from 'node:path'
import { $ } from 'bun'
import { expect, it } from 'bun:test'

// Spelled in parts so this file does not match itself: the owner's private forge domain, employer, surname and the projects of its presets, which live in the user's config folder.
const PRIVATE = [['kevyn', 'fr'].join('.'), ['ath', 'ome'].join(''), ['fyley', 'ssant'].join(''), ['boo', 'ki'].join(''), ['dor', 'ad'].join(''), ['intem', 'peche'].join('')]
const checkout = join(import.meta.dir, '..')

it('names no private domain, employer, person or project, a lockfile\'s tarball URLs included', async () => {
  const grep = await $`git -C ${checkout} grep -lIiF ${PRIVATE.flatMap(word => ['-e', word])}`.nothrow().quiet()

  // git grep exits 1 when nothing matches; anything above means it could not search at all.
  expect(grep.exitCode).toBeLessThanOrEqual(1)
  expect(grep.text().split('\n').filter(Boolean)).toEqual([])
})

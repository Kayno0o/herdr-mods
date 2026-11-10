// Moving a stack's repos between revisions, with the hooks (install, migrate, rebuild) each move calls for.
import type { State } from './plan'
import type { Preset } from './types'
import { existsSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { git } from '../review/git'

// Runs one hook command from the stack directory, failing when it does.
export type Run = (command: string, cwd: string) => Promise<void>

// Where a repo sits in the stack: a worktree named like it, or the stack itself when the stack is a worktree of that repo, as with a monorepo.
export function repoDir(stack: string, name: string): string | null {
  const nested = join(stack, name)

  if (existsSync(nested))
    return nested

  try {
    return basename(dirname(git(stack, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim())) === name ? stack : null
  }
  catch {
    return null
  }
}

function hooksFor(preset: Preset, repo: string, changed: string[], into: Set<string>) {
  for (const hook of preset.hooks.filter(entry => entry.repo === repo)) {
    if (changed.some(path => hook.paths.some(prefix => path.startsWith(prefix))))
      into.add(hook.run)
  }
}

// Hooks run in the preset's order, once each, after every repo has moved.
async function runHooks(stack: string, preset: Preset, hooks: Set<string>, run: Run) {
  for (const hook of preset.hooks.filter(entry => hooks.has(entry.run))) {
    hooks.delete(hook.run)
    await run(hook.run, stack)
  }
}

const changedFiles = (dir: string, from: string, to: string) => git(dir, ['diff', '--name-only', from, to]).split('\n')

// Moves each repo of `state` to its revision; `current` holds what each repo runs now and follows the moves.
export async function checkout(stack: string, preset: Preset, dirs: Map<string, string>, current: State, state: State, run: Run) {
  const hooks = new Set<string>()

  for (const [name, rev] of state) {
    const dir = dirs.get(name)!
    const from = current.get(name)!

    if (from === rev)
      continue

    git(dir, ['checkout', '--quiet', '--detach', rev])
    current.set(name, rev)
    hooksFor(preset, name, changedFiles(dir, from, rev), hooks)
  }

  await runHooks(stack, preset, hooks, run)
}

// Putting the checkouts back is only half of it: the hooks the last revision triggered have to run again for the one the stack is parked on.
export async function restore(stack: string, preset: Preset, dirs: Map<string, string>, current: State, originals: State, run: Run) {
  const hooks = new Set<string>()

  for (const [name, ref] of originals) {
    const dir = dirs.get(name)!

    git(dir, ['checkout', '--quiet', ref])

    const from = current.get(name)!
    const head = git(dir, ['rev-parse', 'HEAD']).trim()

    if (from !== head)
      hooksFor(preset, name, changedFiles(dir, from, head), hooks)
  }

  await runHooks(stack, preset, hooks, run)
}

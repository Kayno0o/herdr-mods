// Which revision each stack repo is on for an item's before and after captures.
import type { Item } from '../review/inbox'
import type { Shot } from '../review/types'
import type { ShotSide } from './types'

export type State = Map<string, string>

/**
 * An item is shot as its net change, like its diff: each repo it touches sits on the parent of its oldest commit there before, on its newest one after. A repo it does not touch stays where the stack has it, sparing its checkout and hooks.
 */
export function statesOf(item: Item): Record<ShotSide, State> {
  const before: State = new Map()
  const after: State = new Map()

  for (const commit of item.commits) {
    if (!before.has(commit.repo)) {
      const parent = commit.parents[0]

      if (!parent)
        throw new Error(`${commit.sha.slice(0, 8)} has no parent to shoot ${item.key}'s before side on`)

      before.set(commit.repo, parent)
    }

    after.set(commit.repo, commit.sha)
  }

  return { before, after }
}

// A shot is worth taking again when its last capture failed or never happened.
export function needsShooting(item: string, label: string, shots: Shot[]): boolean {
  const known = shots.find(shot => shot.item === item && shot.label === label)

  return !known || Boolean(known.error) || !known.before || !known.after
}

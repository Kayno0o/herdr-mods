// What setup changes in a person's Herdr and Claude Code files, apart from the writing: each step answers the new content and what it did, so it can be shown and tested.

export type Keys = Record<string, Record<string, unknown>>

export interface Merged<T> {
  value: T
  // one line per change, for the setup's report
  changed: string[]
  // what was left alone because the person already uses it differently
  kept: string[]
}

// Adds the mods' keys to the person's, never replacing a key they bound to something else.
export function mergeKeys(current: Keys, wanted: Keys): Merged<Keys> {
  const value: Keys = structuredClone(current)
  const changed: string[] = []
  const kept: string[] = []

  for (const [section, keys] of Object.entries(wanted)) {
    const into = (value[section] ??= {})

    for (const [key, action] of Object.entries(keys)) {
      if (!(key in into)) {
        into[key] = action
        changed.push(`${section} ${key}: ${JSON.stringify(action)}`)
      }
      else if (JSON.stringify(into[key]) !== JSON.stringify(action)) {
        kept.push(`${section} ${key} stays ${JSON.stringify(into[key])}, the mods wanted ${JSON.stringify(action)}`)
      }
    }
  }

  return { value, changed, kept }
}

interface Node {
  mod?: string
  floating?: { id: string, content: { mod: string } }[]
  [key: string]: unknown
}

// The listening copy of the review mod: it answers review.open and the Changes panel's requests, and draws nothing.
export const REVIEW_LISTENER = { id: 'review', content: { mod: 'review' }, edge: 'bottom', align: 'start' }

// Shows the git mod where the layout had Herdr's Changes panel, and floats the review mod's listening copy at the root.
export function patchLayout(layout: Node): Merged<Node> {
  const value: Node = structuredClone(layout)
  const changed: string[] = []

  const visit = (node: unknown) => {
    if (!node || typeof node !== 'object')
      return

    const entry = node as Node

    if (entry.mod === 'changes') {
      entry.mod = 'git'
      changed.push('the Changes panel shows the git mod')
    }

    for (const child of Object.values(entry))
      visit(child)
  }

  visit(value)

  if (!(value.floating ?? []).some(block => block.content?.mod === 'review')) {
    value.floating = [...(value.floating ?? []), REVIEW_LISTENER]
    changed.push('the review mod listens for its keys from the layout\'s floating blocks')
  }

  return { value, changed, kept: [] }
}

interface Settings {
  hooks?: Record<string, { matcher?: string, hooks: { type: string, command: string }[] }[]>
  [key: string]: unknown
}

// Runs the commit hook after every Bash call, unless a review-collect hook is already there (a checkout elsewhere, or set by hand).
export function addCommitHook(settings: Settings, command: string): Merged<Settings> {
  const value: Settings = structuredClone(settings)
  const present = Object.values(value.hooks ?? {}).flat().flatMap(group => group.hooks).find(hook => hook.command.includes('review-collect.ts'))

  if (present)
    return { value, changed: [], kept: present.command === command ? [] : [`the commit hook stays ${present.command}`] }

  value.hooks ??= {}
  value.hooks.PostToolUse = [...(value.hooks.PostToolUse ?? []), { matcher: 'Bash', hooks: [{ type: 'command', command }] }]

  return { value, changed: ['Claude Code files every commit it makes into a review'], kept: [] }
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g

// A skill names this checkout's CLI and folders through `{{NAME}}` placeholders, filled at install so a coworker's copy points at their own clone.
export function fillSkill(text: string, values: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    if (!(name in values))
      throw new Error(`no value for ${whole} in a skill`)

    return values[name]!
  })
}

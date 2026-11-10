// An item as text for an agent: each diff line numbered on both sides, each note under its line, so `note --line` can be written from it.
import type { Note } from './types'
import type { ItemView } from './view'

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/
const PAD = 5

const num = (n: number | null) => (n === null ? '' : String(n)).padStart(PAD)

function noteLine(note: Note) {
  return `${' '.repeat(PAD * 2 + 1)}│ ↳ ${note.id} ${note.state} by ${note.author}: ${note.body.replaceAll('\n', ' ')}`
}

export function renderView(view: ItemView): string {
  const out = [view.title]

  for (const c of view.commits)
    out.push(`  ${c.sha.slice(0, 8)} ${c.subject}${view.commit === c.sha ? '  (shown alone)' : ''}`)

  if (view.prose)
    out.push('', view.prose)

  if (!view.exact)
    out.push('', 'A commit did not apply on the others: these files also show what other commits changed in them.')

  const many = Object.keys(view.repos).length > 1

  for (const file of view.files) {
    const notes = view.notes.filter(n => n.repo === file.repo && n.path === file.path)
    const placed = new Set<Note>()
    let old = 0
    let next = 0
    let inHunk = false

    out.push('', `=== ${many ? `${file.repo}:` : ''}${file.path} (${file.status}${file.oldPath ? ` from ${file.oldPath}` : ''}, +${file.added} -${file.removed})${file.read ? ' read' : ''}`)

    for (const note of notes.filter(n => n.line === null)) {
      out.push(noteLine(note))
      placed.add(note)
    }

    if (file.binary) {
      out.push('  binary file')

      continue
    }

    for (const line of file.patch.split('\n')) {
      const hunk = HUNK.exec(line)

      if (hunk) {
        [old, next, inHunk] = [Number(hunk[1]), Number(hunk[2]), true]
        out.push(line)

        continue
      }

      if (!inHunk || line === '' || line[0] === '\\')
        continue

      const kind = line[0]
      const left = kind === '+' ? null : old++
      const right = kind === '-' ? null : next++

      out.push(`${num(left)} ${num(right)} │${kind === ' ' ? ' ' : kind}${line.slice(1)}`)

      for (const note of notes) {
        if (!placed.has(note) && ((note.side === 'old' && note.line === left) || (note.side === 'new' && note.line === right))) {
          out.push(noteLine(note))
          placed.add(note)
        }
      }
    }

    for (const note of notes.filter(n => !placed.has(n)))
      out.push(noteLine(note))
  }

  return out.join('\n')
}

// The line a note's `--at` text points at in a file's diff: the new side first, then a removed line.
export function lineOf(patch: string, text: string): { side: 'old' | 'new', line: number } | null {
  let old = 0
  let next = 0
  let removed: number | null = null
  const wanted = text.trim()

  for (const line of patch.split('\n')) {
    const hunk = HUNK.exec(line)

    if (hunk) {
      [old, next] = [Number(hunk[1]), Number(hunk[2])]

      continue
    }

    if (!old && !next)
      continue

    const kind = line[0]
    const body = line.slice(1).trim()

    if (kind === '-') {
      if (body.includes(wanted))
        removed ??= old

      old++

      continue
    }

    if (kind === '+' || kind === ' ') {
      if (body.includes(wanted))
        return { side: 'new', line: next }

      next++
      old += kind === ' ' ? 1 : 0
    }
  }

  return removed === null ? null : { side: 'old', line: removed }
}

// The text of a diff line, for a note to find it again once later commits moved it.
export function textAt(patch: string, side: 'old' | 'new', at: number): string | null {
  let old = 0
  let next = 0

  for (const line of patch.split('\n')) {
    const hunk = HUNK.exec(line)

    if (hunk) {
      [old, next] = [Number(hunk[1]), Number(hunk[2])]

      continue
    }

    if (!old && !next)
      continue

    const kind = line[0]

    if (kind !== '-' && kind !== '+' && kind !== ' ')
      continue

    if ((side === 'old' && kind !== '+' && old === at) || (side === 'new' && kind !== '-' && next === at))
      return line.slice(1)

    old += kind === '+' ? 0 : 1
    next += kind === '-' ? 0 : 1
  }

  return null
}

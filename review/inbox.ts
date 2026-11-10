// What the CLI does to an inbox, apart from git and the disk, so each step can be tested on plain objects.
import type { Author, Commit, Inbox, Note, NoteState, Side, Ticket } from './types'
import { createHash, randomBytes } from 'node:crypto'
import { autosquashTarget, ticketKey, ticketLine } from './tickets'

export const NOTE_STATES: NoteState[] = ['open', 'resolved', 'rejected']
const NUMBER = /^\d+$/

export function emptyInbox(project: string, tilid: Inbox['tilid'] = null): Inbox {
  return { version: 1, project, tilid, repos: {}, commits: [], prose: {}, notes: [], read: {}, approved: {}, shots: [] }
}

export interface Item {
  // `#1525`, or a loose commit's sha
  key: string
  ticket: Ticket | null
  // oldest first
  commits: Commit[]
  approved: boolean
}

// Every ticket with its commits, then each commit naming no ticket on its own with its fixups, oldest first.
export function itemsOf(inbox: Inbox): Item[] {
  const tickets = new Map<string, Item>()
  const loose: Item[] = []
  // a loose item by the repo and subject of each of its commits, for the fixups landing on it
  const bySubject = new Map<string, Item>()
  const commits = inbox.commits.toSorted((a, b) => a.ts - b.ts)

  for (const commit of commits) {
    if (!commit.tickets.length) {
      const target = autosquashTarget(commit.subject)
      const fixed = target === null ? undefined : bySubject.get(`${commit.repo}\0${target}`)
      const item = fixed ?? { key: commit.sha, ticket: null, commits: [], approved: false }

      if (!fixed)
        loose.push(item)

      item.commits.push(commit)
      bySubject.set(`${commit.repo}\0${commit.subject}`, item)
    }

    for (const ticket of commit.tickets) {
      const key = ticketKey(ticket)
      const item = tickets.get(key) ?? { key, ticket, commits: [], approved: false }

      item.commits.push(commit)
      tickets.set(key, item)
    }
  }

  const items = [...tickets.values()].toSorted((a, b) => a.commits[0]!.ts - b.commits[0]!.ts).concat(loose)

  for (const item of items) {
    const covered = new Set(inbox.approved[item.key] ?? [])

    item.approved = item.commits.every(c => covered.has(c.sha) || c.copies.some(copy => covered.has(copy)))
  }

  return items
}

// Finds an item by `#12`, `12`, a sha or the start of one.
export function findItem(inbox: Inbox, ref: string): Item {
  const items = itemsOf(inbox)
  const key = NUMBER.test(ref) ? `#${ref}` : ref
  const found = items.find(item => item.key === key) ?? items.filter(item => !item.ticket && item.key.startsWith(ref))

  if (!Array.isArray(found))
    return found

  if (found.length !== 1)
    throw new Error(found.length ? `${ref} names several commits` : `no ticket or loose commit ${ref} in ${inbox.project}`)

  return found[0]!
}

export function findCommit(inbox: Inbox, ref: string): Commit {
  const found = inbox.commits.filter(c => c.sha.startsWith(ref) || c.copies.some(copy => copy.startsWith(ref)))

  if (found.length !== 1)
    throw new Error(found.length ? `${ref} names several commits` : `no commit ${ref} in ${inbox.project}`)

  return found[0]!
}

// Files a commit; a copy of one already there (same patch, or same subject while the older one left every branch) takes its place and keeps its notes and approvals.
export function fileCommit(inbox: Inbox, commit: Commit, isCopy: (held: Commit) => boolean): 'added' | 'held' | 'replaced' {
  if (inbox.commits.some(c => c.sha === commit.sha || c.copies.includes(commit.sha)))
    return 'held'

  const held = inbox.commits.find(c => c.repo === commit.repo && isCopy(c))

  if (held) {
    const index = inbox.commits.indexOf(held)

    inbox.commits[index] = { ...commit, tickets: held.filed ? held.tickets : commit.tickets, filed: held.filed, copies: [...held.copies, held.sha], terminal: commit.terminal ?? held.terminal }

    return 'replaced'
  }

  inbox.commits.push(commit)

  return 'added'
}

// Files a commit under tickets an agent read from Tilid, or under none.
export function fileUnder(inbox: Inbox, sha: string, tickets: Ticket[]) {
  const commit = findCommit(inbox, sha)

  commit.tickets = tickets
  commit.filed = true

  return commit
}

export interface NoteInput {
  item: string
  repo: string
  path: string
  side?: Side
  line?: number | null
  text?: string | null

  author?: Author
  body: string
}

export function addNote(inbox: Inbox, input: NoteInput, now = new Date()): Note {
  const body = input.body.trim()

  if (!body)
    throw new Error('a note needs a body')

  const same = inbox.notes.find(n => n.item === input.item && n.repo === input.repo && n.path === input.path && n.line === (input.line ?? null) && n.body === body)

  if (same)
    return same

  let id: string

  do id = randomBytes(4).toString('hex')
  while (inbox.notes.some(n => n.id === id))

  const note: Note = { id, item: input.item, repo: input.repo, path: input.path, side: input.side ?? 'new', line: input.line ?? null, text: input.text ?? null, author: input.author ?? 'claude', state: 'open', body, at: now.toISOString() }

  inbox.notes.push(note)

  return note
}

function notesById(inbox: Inbox, ids: string[]): Note[] {
  return ids.map((id) => {
    const note = inbox.notes.find(n => n.id === id)

    if (!note)
      throw new Error(`no note ${id} in ${inbox.project}`)

    return note
  })
}

// Sets the notes' state; `onlyOpen` is the agent's resolve, which leaves the ones the person already settled alone.
export function setNoteState(inbox: Inbox, ids: string[], state: NoteState, onlyOpen = false): Note[] {
  if (!NOTE_STATES.includes(state))
    throw new Error(`a note's state is one of ${NOTE_STATES.join(', ')}`)

  const changed = notesById(inbox, ids).filter(n => n.state !== state && (!onlyOpen || n.state === 'open'))

  for (const note of changed)
    note.state = state

  return changed
}

export function dropNotes(inbox: Inbox, ids: string[]) {
  const dropped = new Set(notesById(inbox, ids))

  inbox.notes = inbox.notes.filter(n => !dropped.has(n))
}

// A digest of a file's changed lines: reading it again is only asked once they change.
export function digest(filePatch: string): string {
  const changed = filePatch.split('\n').filter(line => (line[0] === '+' || line[0] === '-') && !line.startsWith('+++ ') && !line.startsWith('--- '))

  return createHash('sha1').update(changed.join('\n')).digest('hex').slice(0, 16)
}

export const fileKey = (repo: string, path: string) => `${repo}:${path}`

export function markRead(inbox: Inbox, item: string, files: { repo: string, path: string, digest: string }[], undo = false) {
  const read = (inbox.read[item] ??= {})

  for (const file of files) {
    if (undo)
      delete read[fileKey(file.repo, file.path)]
    else
      read[fileKey(file.repo, file.path)] = file.digest
  }

  if (!Object.keys(read).length)
    delete inbox.read[item]
}

export function approve(inbox: Inbox, item: Item, undo = false) {
  if (undo)
    delete inbox.approved[item.key]
  else
    inbox.approved[item.key] = item.commits.map(c => c.sha)
}

// Past the highest id rather than the count, so a deleted shot's id is never handed out again.
export const nextShotId = (inbox: Inbox) => `s${String(Math.max(0, ...inbox.shots.map(s => Number(s.id.slice(1)) || 0)) + 1).padStart(3, '0')}`

export const itemTitle = (item: Item) => item.ticket ? ticketLine(item.ticket) : `${item.key.slice(0, 8)} ${item.commits[0]!.subject}`

const where = (note: Note) => `${note.path}${note.line ? `:${note.line}${note.side === 'old' ? ' (old side)' : ''}` : ''}`

// The prompt a Claude gets for the open notes: each with its file and line, then how to mark what it handled.
export function brief(inbox: Inbox, items: Item[], cli: string): string {
  const lines: string[] = []
  const handled: string[] = []
  const many = Object.keys(inbox.repos).length > 1

  for (const item of items) {
    const notes = inbox.notes.filter(n => n.item === item.key && n.state === 'open')

    if (!notes.length)
      continue

    lines.push('', `## ${itemTitle(item)}`)

    for (const note of notes) {
      lines.push(`- ${many ? `${note.repo} ` : ''}\`${where(note)}\` (${note.author === 'me' ? 'from me' : 'yours'}, ${note.id}): ${note.body.replaceAll('\n', '\n  ')}`)
      handled.push(note.id)
    }
  }

  if (!handled.length)
    return `Nothing left to fix in the ${inbox.project} review.`

  const repos = Object.entries(inbox.repos).map(([name, path]) => `${name} in ${path}`).join(', ')

  return [
    `Review notes on ${inbox.project} (${repos}) to handle. Line numbers are those of the reviewed diff: check them before editing.`,
    ...lines,
    '',
    `Once handled, mark them resolved, leaving out the ones you set aside (say why): \`${cli} resolve ${inbox.project} ${handled.join(' ')}\``,
  ].join('\n')
}

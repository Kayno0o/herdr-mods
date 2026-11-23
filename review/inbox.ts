// What the CLI does to an inbox, apart from git and the disk, so each step can be tested on plain objects.
import type { Author, Commit, Inbox, Note, NoteState, OrderEntry, Side, Ticket } from './types'
import { createHash, randomBytes } from 'node:crypto'
import { autosquashTarget, ticketKey, ticketLine } from './tickets'

export const NOTE_STATES: NoteState[] = ['open', 'resolved', 'rejected']
const NUMBER = /^\d+$/

// `<path> <rest>`, as the order and trace commands read their lines
export const PATH_LINE = /^(\S+)\s+(\S.*)$/

export function emptyInbox(project: string, tilid: Inbox['tilid'] = null): Inbox {
  return { version: 1, project, tilid, repos: {}, commits: [], prose: {}, order: {}, trace: {}, notes: [], read: {}, approved: {}, shots: [] }
}

export interface Item {
  // `#1525`, a loose commit's sha, or `feature:<branch>`
  key: string
  ticket: Ticket | null
  // oldest first
  commits: Commit[]
  approved: boolean
  // a feature's branch and the keys of its tickets
  feature?: { branch: string, tickets: string[] }
}

export const FEATURE_KEY = 'feature:'
// the branches whose tickets gather into a feature
export const FEATURE_BRANCH = /^(?:feature|feat)\//

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

// The tickets left to review whose last commit was made on one feature branch, two at least, as one item over all their commits; approving it approves them.
export function featuresOf(items: Item[]): Item[] {
  const byBranch = new Map<string, Item[]>()

  for (const item of items) {
    const branch = item.ticket && !item.approved ? item.commits.at(-1)!.branch : null

    if (branch && FEATURE_BRANCH.test(branch))
      byBranch.set(branch, [...byBranch.get(branch) ?? [], item])
  }

  return [...byBranch].filter(([, tickets]) => tickets.length > 1).map(([branch, tickets]) => ({
    key: `${FEATURE_KEY}${branch}`,
    ticket: null,
    commits: [...new Map(tickets.flatMap(t => t.commits).map(c => [c.sha, c])).values()].toSorted((a, b) => a.ts - b.ts),
    approved: false,
    feature: { branch, tickets: tickets.map(t => t.key) },
  }))
}

// The tickets an item stands for: a feature's, else itself.
export function membersOf(inbox: Inbox, item: Item): Item[] {
  return item.feature ? itemsOf(inbox).filter(i => item.feature!.tickets.includes(i.key)) : [item]
}

// Finds an item by `#12`, `12`, a sha or the start of one, or a feature by its key.
export function findItem(inbox: Inbox, ref: string): Item {
  const items = itemsOf(inbox)
  const key = NUMBER.test(ref) ? `#${ref}` : ref
  const found = items.find(item => item.key === key) ?? (ref.startsWith(FEATURE_KEY) ? featuresOf(items).find(f => f.key === ref) : undefined) ?? items.filter(item => !item.ticket && item.key.startsWith(ref))

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

export interface FileRef { repo: string, path: string }

// The file of an item a line names, by its path or by `repo:path` where the path alone is ambiguous.
export function fileNamed<T extends FileRef>(files: T[], path: string): T {
  const found = files.filter(f => f.path === path || fileKey(f.repo, f.path) === path)

  if (!found.length)
    throw new Error(`${path} is not in this item`)

  if (found.length > 1)
    throw new Error(`${path} names several files: ${found.map(f => fileKey(f.repo, f.path)).join(', ')}`)

  return found[0]!
}

// An item's reading order from one line per file, `<path> <why it changed>` or `<path> mechanical`, a path being `repo:path` where it alone is ambiguous.
export function readOrder(text: string, files: FileRef[]): OrderEntry[] {
  const order: OrderEntry[] = []

  for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
    const [, path, why] = PATH_LINE.exec(line) ?? [null, line, '']
    const { repo, path: at } = fileNamed(files, path!)

    if (!order.some(o => o.repo === repo && o.path === at))
      order.push({ repo, path: at, why: why === 'mechanical' ? null : why!.trim() || null, mechanical: why === 'mechanical' })
  }

  return order
}

// The files in their reading order: the ones it lists, then those it leaves out as they came, then the mechanical ones.
export function orderFiles<T extends FileRef>(files: T[], order: OrderEntry[]): (T & { why: string | null, mechanical: boolean })[] {
  const at = new Map(order.map((o, i) => [fileKey(o.repo, o.path), { ...o, rank: i }]))
  // group: listed, left out, mechanical; then the order's place or the file's own
  const groupOf = (o: { mechanical: boolean } | undefined) => {
    if (!o)
      return 1

    return o.mechanical ? 2 : 0
  }
  const ranked = files.map((f, i) => {
    const o = at.get(fileKey(f.repo, f.path))

    return { f, o, group: groupOf(o), place: o?.rank ?? i }
  })

  return ranked.toSorted((a, b) => a.group - b.group || a.place - b.place).map(({ f, o }) => ({ ...f, why: o?.why ?? null, mechanical: o?.mechanical ?? false }))
}

export function approve(inbox: Inbox, item: Item, undo = false) {
  if (item.feature) {
    for (const ticket of membersOf(inbox, item))
      approve(inbox, ticket, undo)

    return
  }

  if (undo)
    delete inbox.approved[item.key]
  else
    inbox.approved[item.key] = item.commits.map(c => c.sha)
}

// Past the highest id rather than the count, so a deleted shot's id is never handed out again.
export const nextShotId = (inbox: Inbox) => `s${String(Math.max(0, ...inbox.shots.map(s => Number(s.id.slice(1)) || 0)) + 1).padStart(3, '0')}`

export function itemTitle(item: Item) {
  if (item.feature)
    return `${item.feature.branch}: ${item.feature.tickets.length} tickets`

  return item.ticket ? ticketLine(item.ticket) : `${item.key.slice(0, 8)} ${item.commits[0]!.subject}`
}

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

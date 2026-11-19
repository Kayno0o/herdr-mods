import type { Advance } from './config'
import type { Item } from './inbox'
// The read side: what the Review tab and an agent are shown of an inbox, with each item's diff computed from git.
import type { Commit, Inbox, Note, Requirement, Shot, Ticket } from './types'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tilidAdvance } from './config'
import { commitPatch, netDiff } from './git'
import { digest, featuresOf, fileKey, findCommit, findItem, itemsOf, itemTitle, membersOf, orderFiles } from './inbox'
import { shotsDir } from './store'

const DIFF_GIT = /^diff --git a\/.* b\/(.*)$/
const TRAILING_NEWLINES = /\n+$/

export interface FileDiff {
  repo: string
  path: string
  oldPath: string | null
  status: 'added' | 'deleted' | 'renamed' | 'modified'
  added: number
  removed: number
  binary: boolean
  patch: string
}

// A multi-file patch as one entry per file, each holding its own `diff --git` section.
export function splitPatch(repo: string, patch: string): FileDiff[] {
  const files: FileDiff[] = []
  let file: FileDiff | null = null
  let lines: string[] = []

  const close = () => {
    if (file)
      files.push({ ...file, patch: `${lines.join('\n')}\n` })
  }

  for (const line of patch.split('\n')) {
    const header = DIFF_GIT.exec(line)

    if (header) {
      close()
      file = { repo, path: header[1]!, oldPath: null, status: 'modified', added: 0, removed: 0, binary: false, patch: '' }
      lines = [line]

      continue
    }

    if (!file)
      continue

    lines.push(line)

    if (line.startsWith('new file mode'))
      file.status = 'added'
    else if (line.startsWith('deleted file mode'))
      file.status = 'deleted'
    else if (line.startsWith('rename from '))
      [file.status, file.oldPath] = ['renamed', line.slice(12)]
    else if (line.startsWith('Binary files '))
      file.binary = true
    else if (line[0] === '+' && !line.startsWith('+++ '))
      file.added++
    else if (line[0] === '-' && !line.startsWith('--- '))
      file.removed++
  }

  close()

  return files.map(f => ({ ...f, patch: f.patch.replace(TRAILING_NEWLINES, '\n') }))
}

// Net diffs are of commits, which never change: computed once per set of shas.
function cachedNetDiff(path: string, shas: string[]) {
  const dir = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'herdr-mods', 'diffs')
  const file = join(dir, `${createHash('sha1').update(`${path}\n${shas.join(' ')}`).digest('hex')}.json`)

  if (existsSync(file))
    return JSON.parse(readFileSync(file, 'utf8')) as ReturnType<typeof netDiff>

  const diff = netDiff(path, shas)

  mkdirSync(dir, { recursive: true })
  writeFileSync(file, JSON.stringify(diff))

  return diff
}

// An item's files: the net diff of its commits per repo, or one commit's own diff.
export function itemFiles(inbox: Inbox, item: Item, only?: Commit): { files: FileDiff[], exact: boolean } {
  if (only)
    return { files: splitPatch(only.repo, commitPatch(inbox.repos[only.repo]!, only.sha)), exact: true }

  let exact = true
  const files: FileDiff[] = []

  for (const repo of new Set(item.commits.map(c => c.repo))) {
    const diff = cachedNetDiff(inbox.repos[repo]!, item.commits.filter(c => c.repo === repo).map(c => c.sha))

    exact &&= diff.exact
    files.push(...splitPatch(repo, diff.patch))
  }

  return { files, exact }
}

// A feature shows the notes of its tickets, where they are kept.
const noteKeys = (item: Item) => [item.key, ...item.feature?.tickets ?? []]
const openNotes = (inbox: Inbox, item: Item) => inbox.notes.filter(n => noteKeys(item).includes(n.item) && n.state === 'open').length

export interface ItemSummary {
  key: string
  ticket: Ticket | null
  title: string
  subject: string
  ts: number[]
  commits: { sha: string, subject: string }[]
  files: number
  read: number
  open: number
  approved: boolean
  // the key of the feature holding this ticket
  feature: string | null
  // a feature's tickets
  tickets: string[]
}

// The rail: every item with its read progress and open notes, then the features gathering tickets; an approved one keeps its counts out, it only lists in History.
export function summary(inbox: Inbox) {
  const tickets = itemsOf(inbox)
  const features = featuresOf(tickets)
  const holder = new Map(features.flatMap(f => f.feature!.tickets.map(t => [t, f.key])))
  const items: ItemSummary[] = [...tickets, ...features].map((item) => {
    const files = item.approved ? [] : itemFiles(inbox, item).files
    const read = inbox.read[item.key] ?? {}

    return {
      key: item.key,
      ticket: item.ticket,
      title: itemTitle(item),
      subject: item.commits[0]!.subject,
      ts: item.commits.map(c => c.ts),
      commits: item.commits.map(c => ({ sha: c.sha, subject: c.subject })),
      files: files.length,
      read: files.filter(f => read[fileKey(f.repo, f.path)] === digest(f.patch)).length,
      open: openNotes(inbox, item),
      approved: item.approved,
      feature: holder.get(item.key) ?? null,
      tickets: item.feature?.tickets ?? [],
    }
  })

  return { project: inbox.project, tilid: inbox.tilid, repos: inbox.repos, items }
}

export interface FileView extends FileDiff {
  digest: string
  read: boolean
  // from the item's reading order
  why: string | null
  mechanical: boolean
}

export interface ItemView {
  project: string
  tilid: Inbox['tilid']
  // the Tilid move approving this ticket makes, null when it is no Tilid ticket or the config names no statuses
  advance: Advance | null
  repos: Record<string, string>
  key: string
  ticket: Ticket | null
  title: string
  prose: string
  approved: boolean
  exact: boolean
  // the commit shown alone, null for the item's net diff
  commit: string | null
  commits: (Pick<Commit, 'sha' | 'repo' | 'ts' | 'subject' | 'author' | 'copies' | 'terminal'>)[]
  files: FileView[]
  notes: Note[]
  trace: Requirement[]
  // a feature's branch and tickets, each a filter
  feature: { branch: string, tickets: { key: string, title: string, screen: string | null }[] } | null
  // the feature holding this ticket
  partOf: string | null
  // with absolute paths
  shots: Shot[]
}

export function view(inbox: Inbox, ref: string, commitRef?: string): ItemView {
  const item = findItem(inbox, ref)
  const tickets = item.feature ? membersOf(inbox, item) : []
  const only = commitRef ? findCommit(inbox, commitRef) : undefined
  const { files, exact } = itemFiles(inbox, item, only)
  const read = inbox.read[item.key] ?? {}
  // reading is of the item's net change, so a commit's file is read when the net file is, as it was when marked
  const net = new Map((only ? itemFiles(inbox, item).files : files).map(f => [fileKey(f.repo, f.path), digest(f.patch)]))

  return {
    project: inbox.project,
    tilid: inbox.tilid,
    advance: inbox.tilid && (item.ticket || item.feature) ? tilidAdvance() : null,
    repos: inbox.repos,
    key: item.key,
    ticket: item.ticket,
    title: itemTitle(item),
    prose: inbox.prose[item.key] ?? '',
    approved: item.approved,
    exact,
    commit: only?.sha ?? null,
    commits: item.commits.map(({ sha, repo, ts, subject, author, copies, terminal }) => ({ sha, repo, ts, subject, author, copies, terminal })),
    files: orderFiles(files, inbox.order?.[item.key] ?? []).map((f) => {
      const key = fileKey(f.repo, f.path)

      return { ...f, digest: digest(f.patch), read: net.has(key) && read[key] === net.get(key) }
    }),
    notes: inbox.notes.filter(n => noteKeys(item).includes(n.item)),
    trace: inbox.trace?.[item.key] ?? [],
    feature: item.feature ? { branch: item.feature.branch, tickets: tickets.map(t => ({ key: t.key, title: itemTitle(t), screen: t.ticket?.screen ?? null })) } : null,
    partOf: item.ticket ? featuresOf(itemsOf(inbox)).find(f => f.feature!.tickets.includes(item.key))?.key ?? null : null,
    shots: inbox.shots.filter(s => s.item === item.key).map(s => ({ ...s, before: s.before && join(shotsDir(inbox.project), s.before), after: s.after && join(shotsDir(inbox.project), s.after) })),
  }
}

interface FileRef { repo: string, path: string }

// What reading files of an item marks: the files themselves, and in a feature each ticket's own diff of them, its final state read covering theirs.
export function readsOf(inbox: Inbox, ref: string, files: FileRef[]): { item: string, files: (FileRef & { digest: string })[] }[] {
  const item = findItem(inbox, ref)
  const wanted = new Set(files.map(f => fileKey(f.repo, f.path)))
  const own = (of: Item) => itemFiles(inbox, of).files.filter(f => wanted.has(fileKey(f.repo, f.path))).map(f => ({ repo: f.repo, path: f.path, digest: digest(f.patch) }))

  return [item, ...item.feature ? membersOf(inbox, item) : []].map(of => ({ item: of.key, files: own(of) }))
}

// The ticket a note written on a feature goes to: the latest one whose commits wrote its line, else the latest touching its file.
export function noteOwner(inbox: Inbox, item: Item, file: FileRef, side: 'old' | 'new', text: string | null): string {
  if (!item.feature)
    return item.key

  const members = membersOf(inbox, item).toSorted((a, b) => b.commits.at(-1)!.ts - a.commits.at(-1)!.ts)
  const patches = members.map(m => ({ key: m.key, patch: itemFiles(inbox, m).files.find(f => f.repo === file.repo && f.path === file.path)?.patch ?? null }))
  const line = text === null ? null : `${side === 'new' ? '+' : '-'}${text}`
  const wrote = line === null ? undefined : patches.find(p => p.patch?.split('\n').includes(line))

  return (wrote ?? patches.find(p => p.patch !== null) ?? patches[0]!).key
}

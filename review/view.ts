import type { Advance } from './config'
import type { Item } from './inbox'
// The read side: what the Review tab and an agent are shown of an inbox, with each item's diff computed from git.
import type { Commit, Inbox, Note, Shot, Ticket } from './types'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tilidAdvance } from './config'
import { commitPatch, netDiff } from './git'
import { digest, fileKey, findCommit, findItem, itemsOf, itemTitle } from './inbox'
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

const openNotes = (inbox: Inbox, key: string) => inbox.notes.filter(n => n.item === key && n.state === 'open').length

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
}

// The rail: every item with its read progress and open notes; an approved one keeps its counts out, it only lists in History.
export function summary(inbox: Inbox) {
  const items: ItemSummary[] = itemsOf(inbox).map((item) => {
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
      open: openNotes(inbox, item.key),
      approved: item.approved,
    }
  })

  return { project: inbox.project, tilid: inbox.tilid, repos: inbox.repos, items }
}

export interface FileView extends FileDiff {
  digest: string
  read: boolean
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
  // with absolute paths
  shots: Shot[]
}

export function view(inbox: Inbox, ref: string, commitRef?: string): ItemView {
  const item = findItem(inbox, ref)
  const only = commitRef ? findCommit(inbox, commitRef) : undefined
  const { files, exact } = itemFiles(inbox, item, only)
  const read = inbox.read[item.key] ?? {}
  // reading is of the item's net change, so a commit's file is read when the net file is, as it was when marked
  const net = new Map((only ? itemFiles(inbox, item).files : files).map(f => [fileKey(f.repo, f.path), digest(f.patch)]))

  return {
    project: inbox.project,
    tilid: inbox.tilid,
    advance: inbox.tilid && item.ticket ? tilidAdvance() : null,
    repos: inbox.repos,
    key: item.key,
    ticket: item.ticket,
    title: itemTitle(item),
    prose: inbox.prose[item.key] ?? '',
    approved: item.approved,
    exact,
    commit: only?.sha ?? null,
    commits: item.commits.map(({ sha, repo, ts, subject, author, copies, terminal }) => ({ sha, repo, ts, subject, author, copies, terminal })),
    files: files.map((f) => {
      const key = fileKey(f.repo, f.path)

      return { ...f, digest: digest(f.patch), read: net.has(key) && read[key] === net.get(key) }
    }),
    notes: inbox.notes.filter(n => n.item === item.key),
    shots: inbox.shots.filter(s => s.item === item.key).map(s => ({ ...s, before: s.before && join(shotsDir(inbox.project), s.before), after: s.after && join(shotsDir(inbox.project), s.after) })),
  }
}

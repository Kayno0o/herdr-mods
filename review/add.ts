import type { Commit, Ticket } from './types'
import { commitInfo, git, orphaned, patchId } from './git'
import { fileCommit } from './inbox'
import { createFor, load, locate, update } from './store'
import { autosquashTarget, ticketsIn } from './tickets'

const AUTOSQUASH_DEPTH = 500
const SYNC_DAYS = 14
const SYNC_MAX = 200
const FIELD = '\x1F'
const RECORD = '\x1E'

// A `fixup!` commit names no ticket itself: it takes the tickets of the commit it fixes, looked up in the inbox, else in the history before it.
function autosquashTickets(path: string, sha: string, target: string, held: Commit[]): Ticket[] {
  const known = held.findLast(c => c.subject === target)

  if (known)
    return known.tickets

  const log = git(path, ['log', '-n', String(AUTOSQUASH_DEPTH), `--format=%s${FIELD}%b${RECORD}`, `${sha}^`], { ok: [0, 128] })
  const found = log.split(RECORD).map(entry => entry.trim().split(FIELD)).find(([subject]) => subject === target)

  return found ? ticketsIn(found[1] ?? '') : []
}

export interface Added {
  project: string
  sha: string
  // the ticket it went under, or the sha for a loose commit
  items: string[]
  result: 'added' | 'held' | 'replaced'
}

// Files a commit of the repo holding `dir` into its project's inbox, created on the first one.
export function addCommit(dir: string, rev = 'HEAD', terminal: string | null = null): Added {
  const at = locate(dir)
  const info = commitInfo(at.path, rev)

  if (info.parents.length > 1)
    throw new Error(`${info.sha.slice(0, 8)} is a merge: it has no diff of its own to review`)

  const id = patchId(at.path, info.sha)

  return update(at.project, (inbox) => {
    const target = autosquashTarget(info.subject)
    const tickets = ticketsIn(info.body)
    const commit: Commit = {
      ...info,
      repo: at.repo,
      tickets: tickets.length || !target ? tickets : autosquashTickets(at.path, info.sha, target, inbox.commits),
      filed: false,
      patchId: id,
      copies: [],
      terminal,
    }

    inbox.repos[at.repo] = at.path
    inbox.tilid = at.tilid ?? inbox.tilid

    const result = fileCommit(inbox, commit, held => (Boolean(id) && held.patchId === id) || (held.subject === info.subject && orphaned(at.path, held.sha)))
    const filed = inbox.commits.find(c => c.sha === info.sha || c.copies.includes(info.sha))!

    return { project: at.project, sha: info.sha, items: filed.tickets.length ? filed.tickets.map(t => `#${t.number}`) : [filed.sha], result }
  }, createFor(at))
}

// Files the commits of the branch checked out in `dir` that no remote holds yet, made in the last two weeks and not in the inbox: commits made in a terminal, rebased copies and any the hook could not read from an output get in this way.
export function syncRepo(dir: string): Added[] {
  const at = locate(dir)
  const held = new Set(load(at.project)?.commits.flatMap(c => [c.sha, ...c.copies]) ?? [])
  // 128: a branch with no commit yet
  const listed = git(dir, ['rev-list', '--reverse', '--no-merges', `--max-count=${SYNC_MAX}`, `--since=${SYNC_DAYS}.days`, 'HEAD', '--not', '--remotes'], { ok: [0, 128] })

  return listed.split('\n').filter(sha => sha && !held.has(sha)).map(sha => addCommit(dir, sha))
}

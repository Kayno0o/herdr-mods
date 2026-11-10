// One inbox per project: every commit filed by the hook, grouped by the tickets their messages name, with the notes, read files and approvals of each ticket or loose commit.

export type Side = 'old' | 'new'
export type NoteState = 'open' | 'resolved' | 'rejected'
export type Author = 'claude' | 'me'

export interface Ticket {
  number: number
  // the use case between brackets, `TICKET_EDIT` in `#12 - [TICKET_EDIT] title`
  screen: string | null
  title: string
}

export interface Commit {
  sha: string
  // the name the inbox gives the repo, a key of Inbox.repos
  repo: string
  ts: number
  parents: string[]
  author: string
  subject: string
  body: string
  // the tickets the message names, or the ones an agent filed it under (`file`)
  tickets: Ticket[]
  filed: boolean
  patchId: string | null
  // shas this commit replaced: rebased or cherry-picked copies of the same change
  copies: string[]
  // the Claude terminal that made it, for handing its notes back
  terminal: string | null
}

export interface Note {
  id: string
  // `#1525` or a loose commit's sha
  item: string
  repo: string
  path: string
  side: Side
  line: number | null
  // the anchored line's text, to find it again once a later commit moved it
  text: string | null
  author: Author
  state: NoteState
  body: string
  at: string
}

export interface Shot {
  id: string
  item: string
  label: string
  route: string | null
  // file names in the project's shots folder
  before: string | null
  after: string | null
  // `shoot` for one `review shoot` takes from the item's scenario, which drops it once its label leaves the scenario
  source?: 'shoot'
  // why the last capture failed, its screenshot kept since it usually shows why
  error?: string | null
}

export interface Inbox {
  version: 1
  project: string
  tilid: { instance: string, code: string } | null
  // repo name to the main checkout's path
  repos: Record<string, string>
  commits: Commit[]
  // the prose an agent wrote, per item
  prose: Record<string, string>
  notes: Note[]
  // item to path to the digest of the file's diff when it was read: a later change to the file unreads it
  read: Record<string, Record<string, string>>
  // item to the shas it held when approved: a new commit brings it back
  approved: Record<string, string[]>
  shots: Shot[]
}

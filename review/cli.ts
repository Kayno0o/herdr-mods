#!/usr/bin/env bun
// The review inboxes' CLI, shared by the Review tab, the commit hook and the agents: `bun review/cli.ts help`.
import type { NoteState, Side, Ticket } from './types'
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { extname, join } from 'node:path'
import { parseArgs } from 'node:util'
import { addCommit, syncRepo } from './add'
import { configFile, loadConfig, tilidAdvance } from './config'
import { knownForges } from './forge'
import { lineOf, renderView, textAt } from './format'
import { addNote, approve, brief, dropNotes, fileUnder, findItem, itemsOf, markRead, nextShotId, setNoteState } from './inbox'
import { load, locate, projects, scenarioFile, shotName, shotsDir, update } from './store'
import { parseTicket } from './tickets'
import { advanceTicket } from './tilid'
import { summary, view } from './view'

export const CLI = `bun ${import.meta.path}`

const HELP = `review <command>: the per-project review inboxes (~/.local/share/herdr-mods/reviews)

  add [--repo <dir>] [<rev>=HEAD] [--terminal <t>]   file a commit into its project's inbox
  sync [--repo <dir>]                                 file the branch's unpushed commits of the last two weeks the inbox lacks
  projects                                            the inboxes
  trackers                                            the forge hosts ticket lines link to, and the Tilid instance a .tilidrc naming none is on
  inbox <project> | --repo <dir>                      the tickets and loose commits, read progress, open notes
  show <project> <item> [--commit <sha>]              an item's diff (net across its commits) with its notes
  note <project> <item> <path> <body...> [--line <n> [--side old|new] | --at <text>] [--author claude|me]
  resolve <project> <note...>                         open notes you handled become resolved
  state <project> <open|resolved|rejected> <note...>  the person's call on notes
  drop <project> <note...>                            delete notes
  read <project> <item> [<path>...] [--all] [--undo]  mark files read
  approve <project> <item> [--undo]
  advance <project> <ticket>                          move it from tilid.reviewStatus to tilid.afterReviewStatus in Tilid, as ${configFile()} names them
  prose <project> <item> <text...>                    what the item does, in a few sentences
  file <project> <sha> <"#n - [SCREEN] title">... | none   file a commit under tickets
  brief <project> [<item>...]                         the open notes as a prompt for a Claude
  shot <project> <item> --label <l> [--route <r>] [--before <png>] [--after <png>]   file screenshots taken by hand
  shoot <project> <item> --stack <dir> [--url <u>] [--only <label>]... [--failed] [--keep] [--dry-run] [--headed]
                                                      take the item's before and after screenshots from its scenario, ${scenarioFile('<project>', '<item>')}

An item is a ticket (#1525 or 1525) or a loose commit (its sha or the start of it). --json prints JSON.`

const OPTIONS = {
  'json': { type: 'boolean' },
  'repo': { type: 'string' },
  'terminal': { type: 'string' },
  'commit': { type: 'string' },
  'line': { type: 'string' },
  'side': { type: 'string' },
  'at': { type: 'string' },

  'author': { type: 'string' },
  'all': { type: 'boolean' },
  'undo': { type: 'boolean' },
  'label': { type: 'string' },
  'route': { type: 'string' },
  'before': { type: 'string' },
  'after': { type: 'string' },
  'stack': { type: 'string' },
  'url': { type: 'string' },
  'only': { type: 'string', multiple: true },
  'failed': { type: 'boolean' },
  'keep': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'headed': { type: 'boolean' },
} as const

let flags: ReturnType<typeof parseArgs<{ options: typeof OPTIONS, allowPositionals: true }>>['values'] = {}
let command: string | undefined
let args: string[] = []

function print(value: unknown, text?: string) {
  console.log(flags.json || text === undefined ? JSON.stringify(value, null, flags.json ? undefined : 2) : text)
}

function need(count: number, usage: string): string[] {
  if (args.length < count)
    throw new Error(`usage: review ${command} ${usage}`)

  return args
}

function inboxOf(project: string) {
  const inbox = load(project)

  if (!inbox)
    throw new Error(`no inbox ${project}: ${projects().join(', ') || 'none yet'}`)

  return inbox
}

// A path as given to `note`: `repo:path` when the inbox holds several repos.
function fileOf(project: string, item: string, path: string) {
  const shown = view(inboxOf(project), item)
  const file = shown.files.find(f => f.path === path || `${f.repo}:${f.path}` === path)

  if (!file)
    throw new Error(`${path} is not in ${shown.title}: ${shown.files.map(f => f.path).join(', ')}`)

  return file
}

const commands: Record<string, () => void | Promise<void>> = {
  add() {
    const added = addCommit(flags.repo ?? process.cwd(), args[0], flags.terminal ?? null)

    print(added, `${added.result} ${added.sha.slice(0, 8)} in ${added.project} under ${added.items.join(', ')}`)
  },
  sync() {
    const added = syncRepo(flags.repo ?? process.cwd())

    print(added, added.map(a => `${a.result} ${a.sha.slice(0, 8)} in ${a.project} under ${a.items.join(', ')}`).join('\n') || 'nothing new')
  },
  projects() {
    print(projects(), projects().join('\n'))
  },
  trackers() {
    const config = loadConfig()
    const forges = knownForges(config)
    const tilid = config.tilid?.defaultInstance ?? null

    print({ forges, tilid }, [...Object.entries(forges).map(([host, web]) => `${host}  ${web}`), `tilid  ${tilid ?? 'no default instance'}`].join('\n'))
  },
  inbox() {
    const project = args[0] ?? locate(flags.repo ?? process.cwd()).project
    const s = summary(inboxOf(project))
    const line = (i: typeof s.items[number]) => `${i.approved ? '✓' : ' '} ${i.title}  ${i.read}/${i.files} read${i.open ? `, ${i.open} open` : ''}`

    print(s, [s.project, ...s.items.map(line)].join('\n'))
  },
  show() {
    const [project, item] = need(2, '<project> <item> [--commit <sha>]')
    const shown = view(inboxOf(project!), item!, flags.commit)

    print(shown, renderView(shown))
  },
  note() {
    const [project, item, path, ...body] = need(4, '<project> <item> <path> <body...>')
    const file = fileOf(project!, item!, path!)
    const at = flags.at ? lineOf(file.patch, flags.at) : null

    if (flags.at && !at)
      throw new Error(`no line of ${file.path} holds ${JSON.stringify(flags.at)}`)

    const side = (at?.side ?? flags.side ?? 'new') as Side
    const line = at?.line ?? (flags.line ? Number(flags.line) : null)
    const note = update(project!, inbox => addNote(inbox, {
      item: findItem(inbox, item!).key,
      repo: file.repo,
      path: file.path,
      side,
      line,
      text: line === null ? null : textAt(file.patch, side, line),

      author: (flags.author ?? 'claude') as 'claude' | 'me',
      body: body.join(' '),
    }))

    print(note, `note ${note.id} on ${note.path}${note.line ? `:${note.line}` : ''}`)
  },
  resolve() {
    const [project, ...ids] = need(2, '<project> <note...>')
    const changed = update(project!, inbox => setNoteState(inbox, ids, 'resolved', true))

    print(changed.map(n => n.id), `resolved ${changed.length} of ${ids.length}`)
  },
  state() {
    const [project, state, ...ids] = need(3, '<project> <open|resolved|rejected> <note...>')
    const changed = update(project!, inbox => setNoteState(inbox, ids, state as NoteState))

    print(changed.map(n => n.id), `${state}: ${changed.length}`)
  },
  drop() {
    const [project, ...ids] = need(2, '<project> <note...>')

    update(project!, inbox => dropNotes(inbox, ids))
    print(ids, `dropped ${ids.length}`)
  },
  read() {
    const [project, item, ...paths] = need(2, '<project> <item> [<path>...] [--all]')
    const shown = view(inboxOf(project!), item!)
    const files = flags.all ? shown.files : paths.map(path => fileOf(project!, item!, path))

    update(project!, inbox => markRead(inbox, shown.key, files, flags.undo))
    print(files.map(f => f.path), `${flags.undo ? 'unread' : 'read'}: ${files.length}`)
  },
  approve() {
    const [project, item] = need(2, '<project> <item> [--undo]')
    const key = update(project!, (inbox) => {
      const found = findItem(inbox, item!)

      approve(inbox, found, flags.undo)

      return found.key
    })

    print({ key, approved: !flags.undo }, `${flags.undo ? 'unapproved' : 'approved'} ${key}`)
  },
  async advance() {
    const [project, item] = need(2, '<project> <ticket>')
    const inbox = inboxOf(project!)
    const found = findItem(inbox, item!)

    if (!found.ticket || !inbox.tilid)
      throw new Error(`${found.key} is no ticket of a Tilid project`)

    const advance = tilidAdvance()

    if (!advance)
      throw new Error(`set tilid.reviewStatus and tilid.afterReviewStatus in ${configFile()} to move tickets`)

    const moved = await advanceTicket(inbox.tilid, found.ticket, advance)

    print(moved, moved.moved ? `#${moved.number} is now "${moved.status}"` : `#${moved.number} stays: ${moved.skipped}`)
  },
  prose() {
    const [project, item, ...text] = need(3, '<project> <item> <text...>')
    const key = update(project!, (inbox) => {
      const found = findItem(inbox, item!)

      inbox.prose[found.key] = text.join(' ').trim()

      return found.key
    })

    print({ key }, `prose of ${key} written`)
  },
  file() {
    const [project, sha, ...lines] = need(3, '<project> <sha> <"#n - [SCREEN] title">... | none')
    const tickets = lines.join('\n') === 'none'
      ? []
      : lines.map((line) => {
        const ticket = parseTicket(line)

        if (!ticket)
          throw new Error(`${JSON.stringify(line)} is no "#n - [SCREEN] title" line`)

        return ticket
      })
    const commit = update(project!, inbox => fileUnder(inbox, sha!, tickets as Ticket[]))

    print({ sha: commit.sha, tickets }, `${commit.sha.slice(0, 8)} filed under ${tickets.map(t => `#${t.number}`).join(', ') || 'no ticket'}`)
  },
  brief() {
    const [project, ...refs] = need(1, '<project> [<item>...]')
    const inbox = inboxOf(project!)
    const items = refs.length ? refs.map(ref => findItem(inbox, ref)) : itemsOf(inbox)

    print(brief(inbox, items, CLI), brief(inbox, items, CLI))
  },
  shot() {
    const [project, item] = need(2, '<project> <item> --label <l> [--before <png>] [--after <png>]')

    if (!flags.label)
      throw new Error('a shot needs --label')

    const shot = update(project!, (inbox) => {
      const key = findItem(inbox, item!).key
      const held = inbox.shots.find(s => s.item === key && s.label === flags.label)
      const id = held?.id ?? nextShotId(inbox)
      const keep = (from: string | undefined, side: 'before' | 'after') => {
        if (!from)
          return null

        const name = shotName(id, side, extname(from) || '.png')

        mkdirSync(shotsDir(project!), { recursive: true })
        copyFileSync(from, join(shotsDir(project!), name))

        if (held?.[side])
          rmSync(join(shotsDir(project!), held[side]), { force: true })

        return name
      }
      const next = { id, item: key, label: flags.label!, route: flags.route ?? held?.route ?? null, before: keep(flags.before, 'before') ?? held?.before ?? null, after: keep(flags.after, 'after') ?? held?.after ?? null }

      inbox.shots = [...inbox.shots.filter(s => s !== held), next]

      return next
    })

    print(shot, `shot ${shot.id} on ${shot.item}`)
  },
  async shoot() {
    const [project, item] = need(2, '<project> <item> --stack <dir>')

    if (!flags.stack)
      throw new Error('a shoot needs --stack, a disposable stack holding a worktree of each repo the item touches')

    // playwright is loaded only here, the other commands run on every commit
    const { shoot } = await import('../shoot/run')
    const failures = await shoot(project!, item!, { stack: flags.stack, url: flags.url, only: flags.only, failed: flags.failed, keep: flags.keep, dryRun: flags['dry-run'], headed: flags.headed })

    process.exitCode = failures ? 1 : 0
  },
  help() {
    console.log(HELP)
  },
}

if (import.meta.main) {
  try {
    const parsed = parseArgs({ options: OPTIONS, allowPositionals: true })

    flags = parsed.values;
    [command, ...args] = parsed.positionals
    const run = commands[command ?? 'help']

    if (!run)
      throw new Error(`no command ${command}\n\n${HELP}`)

    await run()
  }
  catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}

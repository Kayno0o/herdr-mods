#!/usr/bin/env bun
// Files every commit a Claude makes into its project's review inbox, with the terminal that made it, so the Review tab fills as agents work and hands notes back to the right Claude.
// PostToolUse on Bash finds the commits in the command's output and hands them to a detached copy of itself, which files each.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { addCommit, syncRepo } from '../review/add'

interface Job { shas: string[], dirs: string[], terminal: string | null }

const GIT_COMMIT_LINE = /^\[[^\]\n]*? ([0-9a-f]{7,40})\] /gm
const GC_LINE = /^([0-9a-f]{7,40}) \S/gm
const RUNS_GC = /(?:^|[;&|(]\s*)gc\s/m
// a command that may make or rewrite commits without printing them the way commitsIn reads: a rebase, a quiet or scripted commit
const MAKES_COMMITS = /\bgit\b[^;&|\n]*\s(?:commit|rebase|cherry-pick|revert|am|absorb)\b/
const CD = /(?:^|[;&|(]\s*)cd\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/gm
const GIT_C = /\bgit\s+-C\s+("[^"]+"|'[^']+'|\S+)/g
const QUOTED = /^(["'])(.*)\1$/
const TILDE = /^~(?=\/|$)/
// A sha older than this was printed, not made, by the command (a `git log` beside a `gc`).
const FRESH_S = 600

/** The commits a command's output reports: git's `[branch sha] title`, and gc's `sha title` when the command ran gc. */
export function commitsIn(command: string, output: string): string[] {
  const shas = [...output.matchAll(GIT_COMMIT_LINE)].map(m => m[1] ?? '')

  if (RUNS_GC.test(command))
    shas.push(...[...output.matchAll(GC_LINE)].map(m => m[1] ?? ''))

  return [...new Set(shas)]
}

/** Whether the command is worth a collect: it printed commits, or it may have made some. */
export const mayCommit = (command: string, shas: string[]) => shas.length > 0 || MAKES_COMMITS.test(command) || RUNS_GC.test(command)

/** Where the commits may live: each folder the command moved into or pointed git at, then the session's cwd. */
export function dirsOf(command: string, cwd: string): string[] {
  const unquote = (path: string) => path.replace(QUOTED, '$2').replace(TILDE, homedir())
  const dirs = [...command.matchAll(CD), ...command.matchAll(GIT_C)].map(m => resolve(cwd, unquote(m[1] ?? '')))

  return [...new Set([...dirs, cwd])]
}

function git(dir: string, ...args: string[]) {
  const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'ignore' })

  return r.exitCode === 0 ? r.stdout.toString().trim() : null
}

/** A sha's full hash and repo root, from the first folder holding it as a commit made in the last minutes. */
function locate(sha: string, dirs: string[], now: number): { sha: string, repo: string } | null {
  for (const dir of dirs) {
    if (!existsSync(dir))
      continue

    const found = git(dir, 'show', '-s', '--format=%H %ct', `${sha}^{commit}`)
    const root = found && git(dir, 'rev-parse', '--show-toplevel')

    if (!found || !root)
      continue

    const [hash, ct] = found.split(' ')

    return hash && now - Number(ct) <= FRESH_S ? { sha: hash, repo: root } : null
  }

  return null
}

/** The detached half: files each printed commit, oldest first, with the terminal that made it, then whatever else each folder's branch has unpushed; a merge or a commit that can't be read is skipped. */
export function collect(job: Job) {
  const now = Date.now() / 1000

  for (const sha of job.shas.toReversed()) {
    const at = locate(sha, job.dirs, now)

    try {
      if (at)
        addCommit(at.repo, at.sha, job.terminal)
    }
    catch {
      // a merge commit, or an inbox another writer holds too long
    }
  }

  for (const dir of job.dirs) {
    try {
      syncRepo(dir)
    }
    catch {
      // not a repo, or an inbox another writer holds too long
    }
  }
}

async function main() {
  if (process.argv[2] === '--collect')
    return collect(JSON.parse(process.argv[3] ?? '{}') as Job)

  const payload = JSON.parse(await Bun.stdin.text()) as { tool_input?: { command?: string }, tool_response?: { stdout?: string } | string, cwd?: string, session_id?: string }
  const command = payload.tool_input?.command ?? ''
  const output = typeof payload.tool_response === 'string' ? payload.tool_response : payload.tool_response?.stdout ?? ''
  const shas = commitsIn(command, output)

  if (!mayCommit(command, shas) || !payload.cwd)
    return

  const job: Job = { shas, dirs: dirsOf(command, payload.cwd), terminal: process.env.HC_TERMINAL_ID ?? null }

  Bun.spawn(['setsid', '-f', process.execPath, import.meta.path, '--collect', JSON.stringify(job)], { stdio: ['ignore', 'ignore', 'ignore'] })
}

if (import.meta.main) {
  try {
    await main()
  }
  catch {
    // a review that can't be filed never gets in the way of the commit
  }
  process.exit(0)
}

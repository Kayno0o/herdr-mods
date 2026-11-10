import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const FIELD = '\x1F'
const DIFF_ARGS = ['--no-color', '--no-ext-diff', '--no-textconv', '-M']
// a synthetic commit only ties a tree to merge-tree; who made it never shows
const SYNTHETIC = { GIT_AUTHOR_NAME: 'review', GIT_AUTHOR_EMAIL: 'review@localhost', GIT_COMMITTER_NAME: 'review', GIT_COMMITTER_EMAIL: 'review@localhost', GIT_AUTHOR_DATE: '@0 +0000', GIT_COMMITTER_DATE: '@0 +0000' }

export class GitError extends Error {}

export function git(repo: string, args: string[], options: { env?: Record<string, string>, stdin?: string, ok?: number[] } = {}): string {
  const r = Bun.spawnSync(['git', '-C', repo, ...args], { stdin: options.stdin === undefined ? 'ignore' : Buffer.from(options.stdin), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...options.env } })

  if (!(options.ok ?? [0]).includes(r.exitCode))
    throw new GitError(`git ${args[0]}: ${r.stderr.toString().trim() || `exit ${r.exitCode}`}`)

  return r.stdout.toString()
}

export interface CommitInfo {
  sha: string
  ts: number
  parents: string[]
  author: string
  subject: string
  body: string
}

export function commitInfo(repo: string, rev: string): CommitInfo {
  const out = git(repo, ['show', '-s', `--format=%H${FIELD}%ct${FIELD}%P${FIELD}%an${FIELD}%s${FIELD}%b`, `${rev}^{commit}`])
  const [sha = '', ts = '0', parents = '', author = '', subject = '', ...body] = out.split(FIELD)

  return { sha, ts: Number(ts), parents: parents.split(' ').filter(Boolean), author, subject, body: body.join(FIELD).trim() }
}

// The checkout every worktree of a repo shares, so a commit made in a worktree lands in the same inbox.
export function mainCheckout(dir: string): string {
  const common = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()

  if (common.endsWith('/.git'))
    return common.slice(0, -5)

  // a bare repo, whose worktrees live elsewhere, or a checkout with its git dir moved out
  return git(dir, ['rev-parse', '--is-bare-repository']).trim() === 'true' ? common : git(dir, ['rev-parse', '--show-toplevel']).trim()
}

export function commitPatch(repo: string, sha: string): string {
  return git(repo, ['show', ...DIFF_ARGS, '--format=', '--patch', sha])
}

// The same change under another sha (a rebase, a cherry-pick) has the same stable patch id.
export function patchId(repo: string, sha: string): string | null {
  const out = git(repo, ['patch-id', '--stable'], { stdin: git(repo, ['show', '--format=', '--patch', sha]) })

  return out.slice(0, out.indexOf(' ')) || null
}

// A commit no branch or tag holds anymore, as a rebase leaves the old copies.
export function orphaned(repo: string, sha: string): boolean {
  return !git(repo, ['for-each-ref', '--contains', sha, '--count=1', 'refs/heads', 'refs/tags', 'refs/remotes']).trim()
}

// The objects a net diff writes (merge results, synthetic commits) go to a cache of their own; the repo's are only read.
function scratchEnv(repo: string): Record<string, string> {
  const objects = git(repo, ['rev-parse', '--path-format=absolute', '--git-path', 'objects']).trim()
  const cache = process.env.XDG_CACHE_HOME || join(homedir(), '.cache')
  const dir = join(cache, 'herdr-mods', 'objects', createHash('sha1').update(objects).digest('hex').slice(0, 16))

  mkdirSync(dir, { recursive: true })

  return { ...SYNTHETIC, GIT_OBJECT_DIRECTORY: dir, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects }
}

export interface NetDiff {
  patch: string
  // false when a commit did not apply on the others and the diff also holds what other commits changed in the same files
  exact: boolean
}

// What a set of commits changes together, oldest first: each is replayed on the last's result with merge-tree, so commits of other tickets in between stay out and a fixup folds into what it fixes.
export function netDiff(repo: string, shas: string[]): NetDiff {
  if (!shas.length)
    return { patch: '', exact: true }

  const env = scratchEnv(repo)
  const run = (args: string[]) => git(repo, args, { env })
  const tree = (rev: string) => run(['rev-parse', `${rev}^{tree}`]).trim()
  const parentOf = (sha: string) => commitInfo(repo, sha).parents[0] ?? null
  const first = parentOf(shas[0]!)
  const base = first ? tree(first) : EMPTY_TREE
  let tip = tree(shas[0]!)
  let tipCommit = shas[0]!
  let exact = true

  for (const sha of shas.slice(1)) {
    const parent = parentOf(sha)

    if (parent && tree(parent) === tip) {
      tip = tree(sha)
      tipCommit = sha

      continue
    }

    try {
      tip = run(['merge-tree', '--write-tree', '--no-messages', `--merge-base=${parent ?? EMPTY_TREE}`, tipCommit, sha]).trim()
    }
    catch {
      // a conflict: this commit was written on top of changes the others don't hold
      exact = false

      break
    }

    tipCommit = run(['commit-tree', tip, '-p', tipCommit, '-m', 'net diff']).trim()
  }

  if (!exact) {
    const paths = new Set(shas.flatMap(sha => git(repo, ['show', '--format=', '--name-only', sha]).split('\n').filter(Boolean)))

    return { patch: run(['diff', ...DIFF_ARGS, base, tree(shas.at(-1)!), '--', ...paths]), exact }
  }

  return { patch: run(['diff', ...DIFF_ARGS, base, tip]), exact }
}

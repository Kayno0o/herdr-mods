// Throwaway git repos for the tests, isolated from the person's git config, their herdr-mods config and a GIT_DIR a hook may have exported.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'

const GIT_ENV = /^GIT_/

for (const key of Object.keys(process.env)) {
  if (GIT_ENV.test(key))
    delete process.env[key]
}

process.env.GIT_CONFIG_GLOBAL = '/dev/null'
process.env.GIT_CONFIG_NOSYSTEM = '1'
process.env.XDG_CACHE_HOME = mkdtempSync(join(tmpdir(), 'review-cache-'))
process.env.HERDR_MODS_CONFIG = mkdtempSync(join(tmpdir(), 'review-config-'))

export function makeRepo(name = 'repo') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-')))
  const dir = join(root, name)
  let tick = 1_800_000_000

  const run = (...args: string[]) => {
    const r = Bun.spawnSync(['git', '-C', dir, ...args], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, GIT_AUTHOR_DATE: `@${tick} +0000`, GIT_COMMITTER_DATE: `@${tick} +0000` } })

    if (r.exitCode !== 0)
      throw new Error(r.stderr.toString())

    return r.stdout.toString().trim()
  }

  mkdirSync(dir)
  run('init', '-q', '-b', 'main')
  run('config', 'user.name', 'Test')
  run('config', 'user.email', 'test@localhost')

  return {
    dir,
    name: basename(dir),
    // Writes the files, commits them with the message and answers the new sha.
    commit(message: string, files: Record<string, string>) {
      for (const [path, text] of Object.entries(files)) {
        mkdirSync(dirname(join(dir, path)), { recursive: true })
        writeFileSync(join(dir, path), text)
      }

      tick += 60
      run('add', '--', ...Object.keys(files))
      run('commit', '-q', '-m', message)

      return run('rev-parse', 'HEAD')
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

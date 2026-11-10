// The user's own settings, kept out of the repo: `config.json`, the shoot presets and their `.env`, in $HERDR_MODS_CONFIG else $XDG_CONFIG_HOME/herdr-mods.
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface Config {
  tilid?: {
    // the instance a `.tilidrc` naming none is on, `<instance>.tilid.io`
    defaultInstance?: string
    // the status a ticket under review sits in, and the one approving moves it to: with either unset, approving moves nothing
    reviewStatus?: string
    afterReviewStatus?: string
  }
  forge?: {
    // Forgejo or Gitea hosts beside the logins of tea and gt, whose issues a ticket line links to
    hosts?: string[]
    // the web address to link instead of a host's own, for a host reached under a private name: { "git.home.lan": "https://git.example.org" }
    links?: Record<string, string>
  }
}

export const configDir = () => process.env.HERDR_MODS_CONFIG || join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'herdr-mods')
export const configFile = () => join(configDir(), 'config.json')

const STRINGS = ['tilid.defaultInstance', 'tilid.reviewStatus', 'tilid.afterReviewStatus']

// Names the first setting of the wrong type, the way a reader of the file would look it up.
function wrongSetting(config: unknown): string | null {
  if (typeof config !== 'object' || config === null || Array.isArray(config))
    return 'the file: an object'

  const at = (path: string) => path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown> | undefined)?.[key], config)
  const isStringMap = (value: unknown) => typeof value === 'object' && value !== null && Object.values(value).every(entry => typeof entry === 'string')

  for (const path of STRINGS) {
    if (at(path) !== undefined && typeof at(path) !== 'string')
      return `${path}: a string`
  }

  const hosts = at('forge.hosts')

  if (hosts !== undefined && !(Array.isArray(hosts) && hosts.every(host => typeof host === 'string')))
    return 'forge.hosts: an array of strings'

  return at('forge.links') !== undefined && !isStringMap(at('forge.links')) ? 'forge.links: an object of strings' : null
}

let cached: { file: string, stamp: string, config: Config } | null = null

// Read again only once the file changed, since every view and commit asks for it.
export function loadConfig(): Config {
  const file = configFile()
  const stat = statSync(file, { throwIfNoEntry: false })

  if (!stat)
    return {}

  const stamp = `${stat.mtimeMs}:${stat.size}`

  if (cached?.file === file && cached.stamp === stamp)
    return cached.config

  let config: unknown

  try {
    config = JSON.parse(readFileSync(file, 'utf8'))
  }
  catch (error) {
    throw new Error(`${file} is no valid JSON: ${(error as Error).message}`)
  }

  const wrong = wrongSetting(config)

  if (wrong)
    throw new Error(`${file}: expected ${wrong}`)

  cached = { file, stamp, config: config as Config }

  return cached.config
}

export interface Advance { from: string, to: string }

// The Tilid move approving a ticket makes, null when the config names no statuses.
export function tilidAdvance(config = loadConfig()): Advance | null {
  const { reviewStatus, afterReviewStatus } = config.tilid ?? {}

  return reviewStatus && afterReviewStatus ? { from: reviewStatus, to: afterReviewStatus } : null
}

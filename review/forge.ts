// The Forgejo and Gitea hosts a commit's ticket lines can link to: the logins of tea and gt, the config's own, and the public kaynooo forge.
import type { Config } from './config'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const KNOWN = ['https://git.kaynooo.fr']
// gt's hosts.yml has no published schema, so any value under a key naming a host counts, and so does a key that is a host itself
const HOST_VALUE = /^\s*(?:-\s*)?(?:url|host|ssh_host|instance|instance_url|base_url):\s*["']?([^\s"'#]+)/gm
const HOST_KEY = /^\s*["']?((?:https?:\/\/)?[\w-]+(?:\.[\w-]+)+(?::\d+)?\/?)["']?:\s*$/gm
const SCHEME = /^https?:\/\//
const TRAILING_SLASHES = /\/+$/
const HOSTNAME = /^(?:[a-z][\w+.-]*:\/\/)?(?:[^@/]+@)?([\w-]+(?:\.[\w-]+)*)/i

const xdgConfig = () => process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
const read = (file: string) => existsSync(file) ? readFileSync(file, 'utf8') : ''

// The hosts a YAML config names, as written: `https://git.example.org`, `git.example.org:22`.
export function hostsIn(yaml: string): string[] {
  return [...yaml.matchAll(HOST_VALUE), ...yaml.matchAll(HOST_KEY)].map(match => match[1]!)
}

// Each host's name and the web address its pages are under, a login's own URL winning over a bare ssh host.
export function forgeLinks(written: string[], links: Record<string, string> = {}): Record<string, string> {
  const forges: Record<string, string> = {}

  for (const host of written) {
    const name = HOSTNAME.exec(host)?.[1]?.toLowerCase()

    if (name && (!forges[name] || SCHEME.test(host)))
      forges[name] = SCHEME.test(host) ? new URL(host).origin : `https://${name}`
  }

  for (const [name, web] of Object.entries(links))
    forges[name.toLowerCase()] = web.replace(TRAILING_SLASHES, '')

  return forges
}

export function knownForges(config: Config): Record<string, string> {
  const env = [process.env.GITEA_INSTANCE_URL, process.env.GITEA_CLI_HOST].filter((host): host is string => Boolean(host))
  const tea = hostsIn(read(join(xdgConfig(), 'tea', 'config.yml')))
  const gt = hostsIn(read(join(xdgConfig(), 'gitea-cli', 'hosts.yml')))

  return forgeLinks([...KNOWN, ...tea, ...gt, ...env, ...config.forge?.hosts ?? []], config.forge?.links)
}

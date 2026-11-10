import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, test } from 'bun:test'
import { configDir, loadConfig, tilidAdvance } from './config'
import { forgeLinks, hostsIn, knownForges } from './forge'
import { parseTilidrc } from './store'
import './testing'

const home = mkdtempSync(join(tmpdir(), 'review-xdg-'))
const config = mkdtempSync(join(tmpdir(), 'review-config-'))
const configJson = join(config, 'config.json')

// a folder of its own, whatever another test file wrote into the one testing.ts set up
process.env.HERDR_MODS_CONFIG = config

afterAll(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(config, { recursive: true, force: true })
})

describe('the config', () => {
  test('lives in $HERDR_MODS_CONFIG, else under $XDG_CONFIG_HOME, else under ~/.config', () => {
    const was = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }

    try {
      expect(configDir()).toBe(config)
      delete process.env.HERDR_MODS_CONFIG
      process.env.XDG_CONFIG_HOME = '/xdg'
      expect(configDir()).toBe('/xdg/herdr-mods')
      delete process.env.XDG_CONFIG_HOME
      expect(configDir()).toBe(join(homedir(), '.config', 'herdr-mods'))
    }
    finally {
      process.env.HERDR_MODS_CONFIG = config

      if (was.XDG_CONFIG_HOME !== undefined)
        process.env.XDG_CONFIG_HOME = was.XDG_CONFIG_HOME
    }
  })

  test('is empty without a config.json, and moves no Tilid ticket until it names both statuses', () => {
    expect(loadConfig()).toEqual({})
    expect(tilidAdvance()).toBeNull()
    expect(tilidAdvance({ tilid: { reviewStatus: 'In review' } })).toBeNull()
    expect(tilidAdvance({ tilid: { reviewStatus: 'In review', afterReviewStatus: 'Ready' } })).toEqual({ from: 'In review', to: 'Ready' })
  })

  test('puts a .tilidrc naming no instance on the config\'s default one, and on none without it', () => {
    expect(parseTilidrc('project=Shop\n', 'acme')).toEqual({ instance: 'acme', code: 'Shop' })
    expect(parseTilidrc('instance=other\nproject=Shop\n', 'acme')).toEqual({ instance: 'other', code: 'Shop' })
    expect(parseTilidrc('project=Shop\n', undefined)).toBeNull()
  })

  test('names its file when it holds no JSON, and the setting of the wrong type', () => {
    try {
      writeFileSync(configJson, '{ nope')
      expect(() => loadConfig()).toThrow('config.json is no valid JSON')
      writeFileSync(configJson, JSON.stringify({ tilid: { reviewStatus: 3 } }))
      expect(() => loadConfig()).toThrow('config.json: expected tilid.reviewStatus: a string')
      writeFileSync(configJson, JSON.stringify({ forge: { hosts: 'git.example.org' } }))
      expect(() => loadConfig()).toThrow('expected forge.hosts: an array of strings')
      writeFileSync(configJson, JSON.stringify({ forge: { links: { a: 1 } } }))
      expect(() => loadConfig()).toThrow('expected forge.links: an object of strings')
      writeFileSync(configJson, JSON.stringify({ tilid: { defaultInstance: 'acme' } }))
      expect(loadConfig()).toEqual({ tilid: { defaultInstance: 'acme' } })
    }
    finally { rmSync(configJson) }
  })
})

describe('the known forges', () => {
  test('reads the hosts of tea\'s logins and of a gt hosts file, whatever its layout', () => {
    const tea = 'logins:\n    - name: home\n      url: https://git.example.org\n      token: x\n      ssh_host: git.example.org\n'
    const gt = 'hosts:\n  forge.example.com:\n    user: me\n  "https://code.example.net":\n    ssh_host: code.example.net:22\n'

    expect(hostsIn(tea)).toEqual(['https://git.example.org', 'git.example.org'])
    expect(hostsIn(gt).sort()).toEqual(['code.example.net:22', 'forge.example.com', 'https://code.example.net'])
  })

  test('links each host to its login\'s web address, a configured link winning', () => {
    expect(forgeLinks(['git.example.org:22', 'http://git.example.org:3000/', 'Forge.Example.com'], { 'git.home.lan': 'https://git.example.org/' })).toEqual({
      'git.example.org': 'http://git.example.org:3000',
      'forge.example.com': 'https://forge.example.com',
      'git.home.lan': 'https://git.example.org',
    })
  })

  test('gathers tea, gt, the environment and the config, beside the public kaynooo forge', () => {
    const was = { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, GITEA_INSTANCE_URL: process.env.GITEA_INSTANCE_URL, GITEA_CLI_HOST: process.env.GITEA_CLI_HOST }

    mkdirSync(join(home, 'tea'), { recursive: true })
    mkdirSync(join(home, 'gitea-cli'), { recursive: true })
    writeFileSync(join(home, 'tea', 'config.yml'), 'logins:\n  - url: https://tea.example.org\n')
    writeFileSync(join(home, 'gitea-cli', 'hosts.yml'), 'gt.example.org:\n  token: x\n')
    process.env.XDG_CONFIG_HOME = home
    process.env.GITEA_INSTANCE_URL = 'https://env.example.org'
    delete process.env.GITEA_CLI_HOST

    try {
      expect(Object.keys(knownForges({ forge: { hosts: ['own.example.org'] } })).sort()).toEqual(['env.example.org', 'git.kaynooo.fr', 'gt.example.org', 'own.example.org', 'tea.example.org'])

      // what the git mod asks for, from the CLI
      writeFileSync(configJson, JSON.stringify({ tilid: { defaultInstance: 'acme' }, forge: { links: { 'git.home.lan': 'https://git.example.org' } } }))
      const r = Bun.spawnSync(['bun', join(import.meta.dir, 'cli.ts'), 'trackers', '--json'], { stdout: 'pipe', stderr: 'pipe', env: process.env })

      expect(r.stderr.toString()).toBe('')
      expect(JSON.parse(r.stdout.toString())).toEqual({
        forges: { 'git.kaynooo.fr': 'https://git.kaynooo.fr', 'tea.example.org': 'https://tea.example.org', 'gt.example.org': 'https://gt.example.org', 'env.example.org': 'https://env.example.org', 'git.home.lan': 'https://git.example.org' },
        tilid: 'acme',
      })
    }
    finally {
      rmSync(configJson, { force: true })

      for (const [key, value] of Object.entries(was)) {
        if (value === undefined)
          delete process.env[key]
        else
          process.env[key] = value
      }
    }
  })
})

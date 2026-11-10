import type { Item } from '../review/inbox'
import type { Commit } from '../review/types'
import type { Preset } from './types'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { addCommit } from '../review/add'
import { git } from '../review/git'
import { emptyInbox } from '../review/inbox'
import { load, projectDir, scenarioFile, shotsDir } from '../review/store'
import { makeRepo } from '../review/testing'
import { needsShooting, statesOf } from './plan'
import { record, shoot } from './run'
import { checkout, repoDir, restore } from './stack'

const commit = (sha: string, repo: string, parent: string): Commit => ({ sha, repo, ts: 0, parents: [parent], author: 'a', subject: sha, body: '', tickets: [], filed: false, patchId: null, copies: [], terminal: null })

describe('statesOf', () => {
  test('shoots an item\'s net change: each repo from the parent of its oldest commit to its newest', () => {
    const item: Item = { key: '#1', ticket: null, approved: false, commits: [commit('a1', 'api', 'a0'), commit('c1', 'client', 'c0'), commit('a2', 'api', 'a1')] }
    const states = statesOf(item)

    expect([...states.before]).toEqual([['api', 'a0'], ['client', 'c0']])
    expect([...states.after]).toEqual([['api', 'a2'], ['client', 'c1']])
  })
})

test('a shot is taken again when it failed, lacks a side or was never taken', () => {
  const shots = [{ id: 's001', item: '#1', label: 'ok', route: null, before: 'b', after: 'a' }, { id: 's002', item: '#1', label: 'broken', route: null, before: 'b', after: 'a', error: 'after: timeout' }]

  expect(needsShooting('#1', 'ok', shots)).toBe(false)
  expect(needsShooting('#1', 'broken', shots)).toBe(true)
  expect(needsShooting('#1', 'new', shots)).toBe(true)
  expect(needsShooting('#2', 'ok', shots)).toBe(true)
})

test('moves the stack\'s repos with the hooks their changed paths call for, then puts them back', async () => {
  const repo = makeRepo('app')

  try {
    const first = repo.commit('first', { 'lock': '1\n', 'src/a': '1\n' })
    const second = repo.commit('second', { lock: '2\n' })
    const third = repo.commit('third', { 'src/a': '2\n' })
    const stack = dirname(repo.dir)
    const preset: Preset = { url: () => '', login: () => Promise.resolve(), ready: () => Promise.resolve(), settle: 0, hooks: [{ repo: 'app', paths: ['lock'], run: 'install' }, { repo: 'app', paths: ['src/'], run: 'build' }] }
    const ran: string[] = []
    const run = async (command: string) => {
      ran.push(command)
    }
    const dirs = new Map([['app', repoDir(stack, 'app')!]])
    const current = new Map([['app', third]])

    await checkout(stack, preset, dirs, current, new Map([['app', first]]), run)
    expect(git(repo.dir, ['rev-parse', 'HEAD']).trim()).toBe(first)
    expect(ran).toEqual(['install', 'build'])

    await checkout(stack, preset, dirs, current, new Map([['app', second]]), run)
    expect(ran).toEqual(['install', 'build', 'install'])

    await restore(stack, preset, dirs, current, new Map([['app', 'main']]), run)
    expect(git(repo.dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim()).toBe('main')
    expect(ran).toEqual(['install', 'build', 'install', 'build'])
  }
  finally { repo.cleanup() }
})

test('a retaken shot keeps its place, and the scenario\'s shots it no longer names go with their files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'review-shots-'))
  const was = process.env.HERDR_REVIEWS

  process.env.HERDR_REVIEWS = dir

  try {
    const shot = (id: string, label: string, source?: 'shoot') => ({ id, item: '#1', label, route: null, before: `${id}-b.png`, after: `${id}-a.png`, source })
    const inbox = { ...emptyInbox('p'), shots: [shot('s001', 'one', 'shoot'), shot('s002', 'gone', 'shoot'), shot('s003', 'by hand'), shot('s004', 'two', 'shoot')] }

    mkdirSync(shotsDir('p'), { recursive: true })
    writeFileSync(join(projectDir('p'), 'inbox.json'), JSON.stringify(inbox))

    for (const file of ['s001-b.png', 's002-b.png', 's003-b.png'])
      writeFileSync(join(shotsDir('p'), file), '')

    record('p', '#1', { entry: { label: 'one', route: '/' }, id: 's001', files: { before: 's001-b2.png', after: 's001-a2.png' }, errors: [] }, new Set(['one', 'two']))

    expect(load('p')!.shots.map(s => `${s.id} ${s.before}`)).toEqual(['s001 s001-b2.png', 's003 s003-b.png', 's004 s004-b.png'])
    expect(readdirSync(shotsDir('p')).toSorted()).toEqual(['s003-b.png'])
  }
  finally {
    process.env.HERDR_REVIEWS = was
    rmSync(dir, { recursive: true, force: true })
  }
})

test('takes the project\'s preset and its .env from the config folder', async () => {
  const reviews = mkdtempSync(join(tmpdir(), 'review-shoot-'))
  const config = mkdtempSync(join(tmpdir(), 'review-shoot-config-'))
  const repo = makeRepo('app')
  const was = { HERDR_REVIEWS: process.env.HERDR_REVIEWS, HERDR_MODS_CONFIG: process.env.HERDR_MODS_CONFIG }

  process.env.HERDR_REVIEWS = reviews
  process.env.HERDR_MODS_CONFIG = config

  try {
    repo.commit('chore: base', { 'a.ts': '1\n' })
    addCommit(repo.dir, repo.commit('feat: a\n\n#7 - [UC] Seven', { 'a.ts': '2\n' }))
    mkdirSync(dirname(scenarioFile('app', '#7')), { recursive: true })
    writeFileSync(scenarioFile('app', '#7'), 'export default { shots: [{ label: "one", route: "/" }] }\n')

    await expect(shoot('app', '7', { stack: dirname(repo.dir), dryRun: true })).rejects.toThrow(`no preset for app: write ${join(config, 'presets', 'app.ts')}`)

    mkdirSync(join(config, 'presets'))
    writeFileSync(join(config, 'presets', 'app.ts'), 'export default { url: task => "https://" + task + "." + process.env.SHOOT_TEST_HOST, hooks: [], settle: 0 }\n')
    writeFileSync(join(config, '.env'), 'SHOOT_TEST_HOST="app.test"\n')

    expect(await shoot('app', '7', { stack: dirname(repo.dir), dryRun: true })).toBe(0)
    expect(process.env.SHOOT_TEST_HOST).toBe('app.test')
  }
  finally {
    for (const [key, value] of Object.entries(was)) {
      if (value === undefined)
        delete process.env[key]
      else
        process.env[key] = value
    }

    delete process.env.SHOOT_TEST_HOST
    repo.cleanup()
    rmSync(reviews, { recursive: true, force: true })
    rmSync(config, { recursive: true, force: true })
  }
})

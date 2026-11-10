import { describe, expect, test } from 'bun:test'
import { addCommitHook, fillSkill, mergeKeys, patchLayout, REVIEW_LISTENER } from './install'

describe('mergeKeys', () => {
  test('adds a missing key and keeps one the person bound to something else', () => {
    const merged = mergeKeys({ global: { 'ctrl-shift-r': 'layout.reset' } }, { global: { 'ctrl-shift-r': 'review.open', 'ctrl-shift-g': 'git.open' }, terminal: { 'alt-r': 'review.open' } })

    expect(merged.value).toEqual({ global: { 'ctrl-shift-r': 'layout.reset', 'ctrl-shift-g': 'git.open' }, terminal: { 'alt-r': 'review.open' } })
    expect(merged.changed).toHaveLength(2)
    expect(merged.kept).toEqual(['global ctrl-shift-r stays "layout.reset", the mods wanted "review.open"'])
  })

  test('changes nothing on a second run', () => {
    const wanted = { global: { 'ctrl-shift-r': 'review.open' } }

    expect(mergeKeys(mergeKeys({}, wanted).value, wanted)).toEqual({ value: wanted, changed: [], kept: [] })
  })
})

describe('patchLayout', () => {
  const layout = { id: 'root', children: [{ id: 'side', children: [{ content: { mod: 'changes' } }, { content: { mod: 'files' } }] }] }

  test('swaps Herdr\'s Changes panel for the git mod and floats the review listener', () => {
    const { value, changed } = patchLayout(layout)

    expect(JSON.stringify(value)).not.toContain('"changes"')
    expect(value.floating).toEqual([REVIEW_LISTENER])
    expect(changed).toHaveLength(2)
    expect(layout.children[0]!.children[0]!.content.mod).toBe('changes')
  })

  test('changes nothing on a second run', () => {
    const once = patchLayout(layout).value

    expect(patchLayout(once)).toEqual({ value: once, changed: [], kept: [] })
  })
})

describe('addCommitHook', () => {
  const command = 'bun /repo/hooks/review-collect.ts 2>/dev/null || true'

  test('adds the hook after the person\'s own PostToolUse hooks', () => {
    const { value, changed } = addCommitHook({ hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt' }] }] } }, command)

    expect(value.hooks?.PostToolUse).toEqual([{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt' }] }, { matcher: 'Bash', hooks: [{ type: 'command', command }] }])
    expect(changed).toHaveLength(1)
  })

  test('leaves a review-collect hook already there, naming it when it is not this checkout\'s', () => {
    const elsewhere = { hooks: { PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'bun ~/old/review-collect.ts' }] }] } }

    expect(addCommitHook(elsewhere, command)).toEqual({ value: elsewhere, changed: [], kept: ['the commit hook stays bun ~/old/review-collect.ts'] })
    expect(addCommitHook(addCommitHook({}, command).value, command).changed).toEqual([])
  })
})

test('a skill gets this checkout\'s paths, and an unknown placeholder fails the install', () => {
  expect(fillSkill('run `{{CLI}} help` in {{REVIEWS}}', { CLI: 'bun /r/cli.ts', REVIEWS: '/data' })).toBe('run `bun /r/cli.ts help` in /data')
  expect(() => fillSkill('{{NOPE}}', {})).toThrow('no value for {{NOPE}}')
})

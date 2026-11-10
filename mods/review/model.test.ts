import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { makeRepo } from '../../review/testing'
import { buildList, claudeFor, columnsOf, commentText, daysLabel, heightOf, marks, nextOpenNote, nextUnread, noteLines, placeNotes, ROW_H, sideRows, SNAPSHOT, splitFiles, tildePath, WRAP_H, wrapLine } from './model.js'

const PATCH = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,4 +1,4 @@ function a() {
 keep
-old one
-old two
+new one
 end
\\ No newline at end of file
`

interface Side { line: number, text: string, kind: string }
interface Row { kind: string, left?: Side | null, right?: Side | null, marks?: unknown, text?: string }
interface Entry { kind: string, fi: number, note?: { id: string }, moved?: boolean, left?: Side | null, right?: Side | null }

const cell = (side: Side | null | undefined) => side ? `${side.kind}${side.line}` : '·'

describe('sideRows', () => {
  test('pairs each removal run with the additions replacing it, the rest of a run against nothing', () => {
    const rows: Row[] = sideRows(PATCH)

    expect(rows.map(r => r.kind === 'hunk' ? `@ ${r.text}` : `${cell(r.left)}|${cell(r.right)}`)).toEqual(['@ function a() {', ' 1| 1', '-2|+2', '-3|·', ' 4| 3'])
    expect(rows[2]!.marks).toEqual({ left: [0, 3], right: [0, 3] })
  })

  test('marks only the changed middle of a replaced line', () => {
    expect(marks('can(\'project.edit\', p)', 'can(\'admin.access\', p)')).toEqual({ left: [5, 17], right: [5, 17] })
    expect(marks('abc', 'xyz')).toBeNull()
  })
})

describe('placeNotes', () => {
  const rows: Row[] = sideRows(PATCH)

  test('puts a note under its line on its side, a whole-file note under the header', () => {
    const placed = placeNotes(rows, [{ id: 'n', line: 2, side: 'new', text: 'new one' }, { id: 'o', line: 3, side: 'old', text: null }, { id: 'f', line: null, side: 'new' }])

    expect([...placed].map(([at, notes]) => [at, notes.map((n: { note: { id: string } }) => n.note.id)])).toEqual([[2, ['n']], [3, ['o']], [-1, ['f']]])
  })

  test('follows a line a later commit moved by its text, and says it moved', () => {
    const placed = placeNotes(rows, [{ id: 'm', line: 9, side: 'new', text: 'end' }, { id: 'gone', line: 9, side: 'new', text: 'nowhere' }])

    expect(placed.get(4)).toEqual([{ note: expect.objectContaining({ id: 'm' }), moved: true }])
    expect(placed.get(-1)).toEqual([{ note: expect.objectContaining({ id: 'gone' }), moved: true }])
  })
})

describe('buildList', () => {
  const files = [{ path: 'src/a.ts', repo: 'r', patch: PATCH, read: false, binary: false }, { path: 'b.ts', repo: 'r', patch: PATCH, read: true, binary: false }]
  const notes = [{ id: 'n', repo: 'r', path: 'src/a.ts', line: 2, side: 'new', text: 'new one', state: 'open', body: 'why' }]

  test('folds a read file to its header, unless opened again', () => {
    const list: Entry[] = buildList(files, notes)

    expect(list.map(e => e.kind === 'note' ? e.note!.id : e.kind)).toEqual(['file', 'hunk', 'pair', 'pair', 'n', 'pair', 'pair', 'file'])
    expect(buildList(files, notes, new Set([1])).filter((e: Entry) => e.fi === 1)).toHaveLength(6)
  })

  test('finds the next unread file and the next open note, wrapping around', () => {
    const list: Entry[] = buildList(files, notes)

    expect(nextUnread(files, 0)).toBe(0)
    expect(nextUnread(files.map(f => ({ ...f, read: true })), 0)).toBe(-1)
    expect(nextOpenNote(list, 6)).toBe(4)
  })
})

describe('long lines', () => {
  test('wrap into the pieces their column holds, each keeping its share of the marks', () => {
    expect(wrapLine('abcdefghij', [3, 8], 4)).toEqual([{ text: 'abcd', marks: [3, 4] }, { text: 'efgh', marks: [0, 4] }, { text: 'ij', marks: null }])
    expect(wrapLine('', null, 4)).toEqual([{ text: '', marks: null }])
    expect(wrapLine('abc', null, Infinity)).toEqual([{ text: 'abc', marks: null }])
  })

  test('make their row taller, a one-column file wrapping at the whole width', () => {
    const cols = columnsOf(1000)
    const long = { line: 1, text: 'x'.repeat(cols.half + 1), kind: '+' }
    const pair = { kind: 'pair', fi: 0, left: null, right: long }

    expect(cols.whole).toBeGreaterThan(2 * cols.half)
    expect(heightOf(pair, cols, [{ status: 'modified' }])).toBe(ROW_H + WRAP_H)
    expect(heightOf(pair, cols, [{ status: 'added' }])).toBe(ROW_H)
    expect(heightOf(pair, columnsOf(0), [{ status: 'modified' }])).toBe(ROW_H)
  })
})

test('a long note shows four lines at most', () => {
  expect(noteLines('a\nb\nc\nd\ne')).toEqual(['a', 'b', 'c', 'd…'])
  expect(noteLines('x'.repeat(230))).toHaveLength(3)
})

test('splits a working diff into files with their counts', () => {
  expect(splitFiles(`${PATCH}diff --git a/n.ts b/n.ts\nnew file mode 100644\n--- /dev/null\n+++ b/n.ts\n@@ -0,0 +1 @@\n+x\n`).map((f: { path?: string, added: number, removed: number, status: string }) => [f.path, f.added, f.removed, f.status])).toEqual([['src/a.ts', 1, 2, 'modified'], ['n.ts', 1, 0, 'added']])
})

test('labels the days of an item\'s commits', () => {
  const now = new Date(2026, 10, 6, 15).getTime()
  const at = (day: number) => new Date(2026, 10, day, 10).getTime() / 1000

  expect(daysLabel([at(6)], now)).toBe('today')
  expect(daysLabel([at(5), at(5)], now)).toBe('yesterday')
  expect(daysLabel([at(2), at(3)], now)).toBe('2–3 nov')
  expect(daysLabel([at(4), at(6)], now)).toBe('4 nov – today')
})

test('comments and the Claude an item goes back to', () => {
  expect(commentText('a.ts', { line: 4, side: 'old' }, ' rename it \n')).toBe('a.ts:4 (old side): rename it')
  expect(commentText('a.ts', null, 'whole')).toBe('a.ts: whole')
  const commits = [{ terminal: 't1' }, { terminal: 't2' }, { terminal: null }]

  expect(claudeFor(commits, ['t1', 't3'], 't3')).toBe('t1')
  expect(claudeFor(commits, [], 't3')).toBe('t3')
})

test('a snapshot takes untracked files in and leaves the index alone', () => {
  const repo = makeRepo()

  try {
    repo.commit('first', { a: '1\n' })
    const sh = (script: string) => Bun.spawnSync(['sh', '-c', script], { cwd: repo.dir, env: process.env }).stdout.toString().trim()
    const index = readFileSync(join(repo.dir, '.git/index'))

    writeFileSync(join(repo.dir, 'new.txt'), 'fresh\n')
    const tree = sh(SNAPSHOT)

    expect(sh(`git ls-tree --name-only ${tree}`).split('\n')).toEqual(['a', 'new.txt'])
    expect(readFileSync(join(repo.dir, '.git/index')).equals(index)).toBe(true)
    expect(sh('git status --porcelain')).toBe('?? new.txt')
  }
  finally { repo.cleanup() }
})

test('a path under the home folder starts from ~, another is left whole', () => {
  expect(tildePath('/home/ana/code/app', '/home/ana')).toBe('~/code/app')
  expect(tildePath('/home/ana', '/home/ana')).toBe('~')
  expect(tildePath('/home/anabel/app', '/home/ana')).toBe('/home/anabel/app')
  expect(tildePath('/srv/app', '')).toBe('/srv/app')
})

test('a long note is cut between words, a word wider than the card mid-word', () => {
  const words = `${'word '.repeat(40)}end`
  const lines = noteLines(words)

  expect(lines.every((line: string) => !line.startsWith(' ') && !line.endsWith(' '))).toBe(true)
  expect(lines.join(' ')).toBe(words)
  expect(noteLines('x'.repeat(230))).toHaveLength(3)
})

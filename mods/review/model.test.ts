import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { makeRepo } from '../../review/testing'
import { buildList, claudeFor, columnsOf, commentText, daysLabel, fileJump, heightOf, marks, nextOpenNote, nextUnread, noteLines, placeNotes, railOrder, ROW_H, sideRows, SNAPSHOT, splitFiles, tildePath, traceMap, WRAP_H, wrapLine } from './model.js'

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

  test('folds every file not opened when asked to, for an item too long to list whole', () => {
    expect(buildList(files, notes, new Set([1]), false, true).map((e: Entry) => e.kind === 'file' ? `file ${e.fi}` : e.kind)).toEqual(['file 0', 'file 1', 'hunk', 'pair', 'pair', 'pair', 'pair'])
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

describe('the mechanical group', () => {
  const file = (path: string, mechanical = false, read = false) => ({ path, repo: 'r', patch: PATCH, read, binary: false, mechanical })
  const files = [file('a.ts'), file('lock.json', true, true), file('fr.json', true)]

  test('folds the mechanical files under one row counting them and those read, until it is opened', () => {
    expect(buildList(files, []).map((e: Entry) => e.kind === 'file' ? `file ${e.fi}` : e.kind).filter((k: string) => k !== 'pair' && k !== 'hunk')).toEqual(['file 0', 'group'])
    expect(buildList(files, []).at(-1)).toEqual({ kind: 'group', fi: 1, from: 1, to: 3, count: 2, read: 1, open: 0 })
    expect(buildList(files, [], new Set(), true).filter((e: Entry) => e.kind === 'file').map((e: Entry) => e.fi)).toEqual([0, 1, 2])
  })

  test('J from the group goes into it when it is open, nowhere when it is folded', () => {
    const folded = buildList(files, [])
    const open = buildList(files, [], new Set(), true)

    expect(fileJump(folded, folded.length - 1, 1, 3)).toBe(-1)
    expect(fileJump(open, open.findIndex((e: Entry) => e.kind === 'group'), 1, 3)).toBe(1)
    expect(fileJump(folded, folded.length - 1, -1, 3)).toBe(0)
  })
})

describe('the trace', () => {
  const TWO = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
-const label = 'one'
+const label = 'un'
 keep
@@ -10,2 +10,2 @@
-const size = 1
+const size = 2
 keep
`
  const file = (path: string, mechanical = false) => ({ path, repo: 'r', patch: TWO, read: false, binary: false, mechanical })
  const anchor = (path: string, line: number, text: string, side = 'new') => ({ repo: 'r', path, side, line, text })
  const trace = [
    { text: 'Labels in French', ticket: null, partly: null, anchors: [anchor('a.ts', 1, 'const label = \'un\''), anchor('b.ts', 1, 'const label = \'un\'')] },
    { text: 'Sizes grow', ticket: null, partly: 'the max is not set', anchors: [anchor('a.ts', 10, 'const size = 2')] },
    { text: 'Errors are logged', ticket: null, partly: null, anchors: [] },
    { text: 'Old one', ticket: null, partly: null, anchors: [anchor('a.ts', 4, 'gone since')] },
  ]

  test('gives each requirement its status and the hunks doing it, found by their line or their text as a note is', () => {
    const { reqs } = traceMap([file('a.ts'), file('b.ts')], trace)

    expect(reqs.map((r: { status: string, hunks: unknown }) => [r.status, r.hunks])).toEqual([
      ['covered', [{ fi: 0, ri: 0 }, { fi: 1, ri: 0 }]],
      ['partly', [{ fi: 0, ri: 3 }]],
      ['missing', []],
      ['gone', []],
    ])
  })

  test('tags each hunk with the requirements it does, and lists the hunks doing none outside the mechanical files', () => {
    const { tags, outside } = traceMap([file('a.ts'), file('b.ts'), file('lock.json', true)], trace)

    expect([...tags]).toEqual([['0:0', [0]], ['0:3', [1]], ['1:0', [0]]])
    expect(outside).toEqual([{ fi: 1, ri: 3 }])
  })

  test('says nothing is outside an item with no trace', () => {
    expect(traceMap([file('a.ts')], []).outside).toEqual([])
  })

  test('each row of a file knows its place among the file\'s rows', () => {
    expect(buildList([file('a.ts')], []).filter((e: Entry) => e.kind !== 'file').map((e: Entry & { ri?: number }) => e.ri)).toEqual([0, 1, 2, 3, 4, 5])
  })
})

describe('fileJump', () => {
  const list = [{ kind: 'file', fi: 0 }, { kind: 'pair', fi: 0 }, { kind: 'file', fi: 1 }, { kind: 'pair', fi: 1 }, { kind: 'file', fi: 2 }]

  test('J goes to the next file, -1 past the last', () => {
    expect(fileJump(list, 1, 1, 3)).toBe(1)
    expect(fileJump(list, 4, 1, 3)).toBe(-1)
  })

  test('K from inside a file goes back to its own header first, then to the file before', () => {
    expect(fileJump(list, 3, -1, 3)).toBe(1)
    expect(fileJump(list, 2, -1, 3)).toBe(0)
    expect(fileJump(list, 0, -1, 3)).toBe(-1)
  })
})

describe('railOrder', () => {
  const items = [{ key: 'old', approved: true }, { key: 'loose' }, { key: 't1', ticket: {} }, { key: 'new', approved: true }, { key: 't2', ticket: {} }]

  test('tickets, then loose commits, the approved ones only while the history shows, newest first', () => {
    expect(railOrder(items, false).map(i => i.key)).toEqual(['t1', 't2', 'loose'])
    expect(railOrder(items, true).map(i => i.key)).toEqual(['t1', 't2', 'loose', 'new', 'old'])
  })

  test('a feature comes where its first ticket was, its tickets right under it', () => {
    const featured = [{ key: 't0', ticket: {} }, { key: 't1', ticket: {}, feature: 'f' }, { key: 'loose' }, { key: 't2', ticket: {}, feature: 'f' }, { key: 't3', ticket: {} }, { key: 'f', tickets: ['t1', 't2'] }]

    expect(railOrder(featured, false).map(i => i.key)).toEqual(['t0', 'f', 't1', 't2', 't3', 'loose'])
  })
})

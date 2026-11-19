import type { Commit, Inbox } from './types'
import { describe, expect, test } from 'bun:test'
import { addNote, approve, brief, digest, emptyInbox, featuresOf, fileCommit, findItem, itemsOf, markRead, orderFiles, readOrder, setNoteState } from './inbox'
import { parseTicket, ticketsIn } from './tickets'

const ticket = (line: string) => parseTicket(line)!

function commit(sha: string, ts: number, body = '', extra: Partial<Commit> = {}): Commit {
  return { sha, repo: 'app', ts, parents: [], author: 'Test', subject: `feat: ${sha}`, body, tickets: ticketsIn(body), filed: false, patchId: `p-${sha}`, copies: [], terminal: null, ...extra }
}

function inbox(...commits: Commit[]): Inbox {
  return { ...emptyInbox('app'), repos: { app: '/app' }, commits }
}

describe('tickets', () => {
  test('reads the use case, nested brackets included, and every ticket of a body once', () => {
    expect(ticket('#1527 - [TICKET_COMMENT_EDIT[ADD]] Pas de client si privé')).toEqual({ number: 1527, screen: 'TICKET_COMMENT_EDIT[ADD]', title: 'Pas de client si privé' })
    expect(ticketsIn('Why.\n\n#12 - Plain\n#12 - Plain\n#13 - [X] Other').map(t => t.number)).toEqual([12, 13])
  })
})

describe('items', () => {
  test('groups commits under their tickets, a commit naming two in both, loose commits last', () => {
    const items = itemsOf(inbox(commit('c', 3), commit('a', 1, '#1 - One'), commit('b', 2, '#2 - Two\n#1 - One')))

    expect(items.map(i => [i.key, i.commits.map(c => c.sha)])).toEqual([['#1', ['a', 'b']], ['#2', ['b']], ['c', ['c']]])
  })

  test('a fixup of a loose commit joins its item, a fixup of that fixup too', () => {
    const items = itemsOf(inbox(commit('a', 1), commit('b', 2, '', { subject: 'fixup! feat: a' }), commit('c', 3, '', { subject: 'fixup! fixup! feat: a' }), commit('d', 4, '', { subject: 'fixup! feat: gone' })))

    expect(items.map(i => [i.key, i.commits.map(c => c.sha)])).toEqual([['a', ['a', 'b', 'c']], ['d', ['d']]])
  })

  test('finds an item by number, by key or by the start of a loose commit\'s sha', () => {
    const box = inbox(commit('abc123', 1), commit('d', 2, '#7 - Seven'))

    expect(findItem(box, '7').key).toBe('#7')
    expect(findItem(box, 'abc').key).toBe('abc123')
    expect(() => findItem(box, 'zz')).toThrow('no ticket or loose commit')
  })

  test('an approved ticket comes back once a new commit lands on it', () => {
    const box = inbox(commit('a', 1, '#1 - One'))

    approve(box, findItem(box, '1'))
    expect(findItem(box, '1').approved).toBe(true)
    fileCommit(box, commit('b', 2, '#1 - One'), () => false)
    expect(findItem(box, '1').approved).toBe(false)
  })
})

describe('fileCommit', () => {
  test('a copy takes the place of what it copies and stays approved', () => {
    const box = inbox(commit('a', 1, '#1 - One'))

    approve(box, findItem(box, '1'))
    expect(fileCommit(box, commit('a2', 5, '#1 - One', { patchId: 'p-a' }), held => held.patchId === 'p-a')).toBe('replaced')
    expect(box.commits.map(c => [c.sha, c.copies])).toEqual([['a2', ['a']]])
    expect(findItem(box, '1').approved).toBe(true)
    expect(fileCommit(box, commit('a', 1, '#1 - One'), () => false)).toBe('held')
  })

  test('keeps the tickets an agent filed the old copy under', () => {
    const box = inbox(commit('a', 1, '', { tickets: [ticket('#4 - Four')], filed: true }))

    fileCommit(box, commit('a2', 2), () => true)
    expect(box.commits[0]!.tickets.map(t => t.number)).toEqual([4])
  })
})

describe('notes', () => {
  test('adds a note once, settles it, and lets an agent resolve only the open ones', () => {
    const box = inbox(commit('a', 1, '#1 - One'))
    const note = addNote(box, { item: '#1', repo: 'app', path: 'f.ts', line: 3, body: 'why?' })

    expect(addNote(box, { item: '#1', repo: 'app', path: 'f.ts', line: 3, body: 'why?' })).toBe(note)
    const rejected = addNote(box, { item: '#1', repo: 'app', path: 'f.ts', body: 'whole file', author: 'me' })

    setNoteState(box, [rejected.id], 'rejected')
    expect(setNoteState(box, [note.id, rejected.id], 'resolved', true).map(n => n.id)).toEqual([note.id])
    expect(() => setNoteState(box, ['nope'], 'open')).toThrow('no note nope')
  })

  test('the brief lists the open notes with their place and how to resolve them', () => {
    const box = inbox(commit('a', 1, '#1 - [UC] One'))
    const note = addNote(box, { item: '#1', repo: 'app', path: 'f.ts', line: 3, side: 'old', author: 'me', body: 'gone?' })
    const text = brief(box, itemsOf(box), 'review')

    expect(text).toContain('## #1 - [UC] One')
    expect(text).toContain(`\`f.ts:3 (old side)\` (from me, ${note.id}): gone?`)
    expect(text).toContain(`review resolve app ${note.id}`)
    setNoteState(box, [note.id], 'resolved')
    expect(brief(box, itemsOf(box), 'review')).toContain('Nothing left to fix')
  })
})

describe('read', () => {
  test('a file read stays read until its changed lines change', () => {
    const box = inbox(commit('a', 1, '#1 - One'))
    const before = digest('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n')

    markRead(box, '#1', [{ repo: 'app', path: 'f', digest: before }])
    expect(box.read['#1']).toEqual({ 'app:f': before })
    expect(digest('--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+c\n')).not.toBe(before)
    markRead(box, '#1', [{ repo: 'app', path: 'f', digest: before }], true)
    expect(box.read['#1']).toBeUndefined()
  })
})

describe('reading order', () => {
  const files = [{ repo: 'api', path: 'a.ts' }, { repo: 'api', path: 'b.ts' }, { repo: 'web', path: 'a.ts' }, { repo: 'web', path: 'lock.json' }]

  test('reads one file a line, its path then why it changed, `mechanical` marking a mechanical one', () => {
    expect(readOrder('web:a.ts  shows the new field\n\nb.ts the handler checks it first\nweb:lock.json mechanical\n', files)).toEqual([
      { repo: 'web', path: 'a.ts', why: 'shows the new field', mechanical: false },
      { repo: 'api', path: 'b.ts', why: 'the handler checks it first', mechanical: false },
      { repo: 'web', path: 'lock.json', why: null, mechanical: true },
    ])
  })

  test('refuses a path the item lacks or names twice, a file listed twice keeping one place', () => {
    expect(() => readOrder('c.ts why', files)).toThrow('c.ts is not in this item')
    expect(() => readOrder('a.ts why', files)).toThrow('a.ts names several files: api:a.ts, web:a.ts')
    expect(readOrder('b.ts first\nb.ts again', files)).toHaveLength(1)
  })

  test('puts the files in its order, those it leaves out after them as they came, the mechanical ones last', () => {
    const order = readOrder('web:lock.json mechanical\nweb:a.ts shows it\nb.ts checks it', files)

    expect(orderFiles(files, order).map(f => [`${f.repo}:${f.path}`, f.why, f.mechanical])).toEqual([
      ['web:a.ts', 'shows it', false],
      ['api:b.ts', 'checks it', false],
      ['api:a.ts', null, false],
      ['web:lock.json', null, true],
    ])
    expect(orderFiles(files, []).map(f => f.path)).toEqual(['a.ts', 'b.ts', 'a.ts', 'lock.json'])
  })
})

describe('features', () => {
  const on = (branch: string) => ({ branch })
  const box = () => inbox(
    commit('a', 1, '#1 - [ONE] One', on('feature/groups')),
    commit('b', 2, '#2 - [TWO] Two', on('feature/groups')),
    commit('c', 3, '#3 - [THREE] Three', on('feature/groups')),
    commit('d', 4, '#4 - [ALONE] Alone', on('feature/alone')),
    commit('e', 5, '#5 - [MAIN] Main', on('main')),
    commit('f', 6, '#6 - [OLD] Old'),
  )

  test('gathers the tickets left to review on one feature branch, two at least, over all their commits', () => {
    const inb = box()

    approve(inb, findItem(inb, '3'))
    expect(featuresOf(itemsOf(inb)).map(f => [f.key, f.feature!.tickets, f.commits.map(c => c.sha)])).toEqual([['feature:feature/groups', ['#1', '#2'], ['a', 'b']]])
  })

  test('approving a feature approves each of its tickets, and it is found by its key', () => {
    const inb = box()

    approve(inb, findItem(inb, 'feature:feature/groups'))
    expect(itemsOf(inb).filter(i => i.approved).map(i => i.key)).toEqual(['#1', '#2', '#3'])
    expect(() => findItem(inb, 'feature:feature/groups')).toThrow('no ticket or loose commit')
  })
})

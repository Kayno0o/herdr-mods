import { describe, expect, test } from 'bun:test'
import { readTrace } from './trace'

const PATCH = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,4 @@
 const one = 1
-const two = 2
+const two = 'deux'
+const three = 3
 const end = 0
`
const files = [{ repo: 'api', path: 'a.ts', patch: PATCH }, { repo: 'web', path: 'b.vue', patch: PATCH.replaceAll('a.ts', 'b.vue') }]

describe('readTrace', () => {
  test('reads requirements, each with the lines doing it found by their text, and what a partly one leaves out', () => {
    expect(readTrace('- Le libellé passe en français\n  a.ts const two = \'deux\'\n  web:b.vue const three\n  partly: le cas vide manque\n- Rien ne change à la fin\n', files)).toEqual([
      { text: 'Le libellé passe en français', ticket: null, partly: 'le cas vide manque', anchors: [
        { repo: 'api', path: 'a.ts', side: 'new', line: 2, text: 'const two = \'deux\'' },
        { repo: 'web', path: 'b.vue', side: 'new', line: 3, text: 'const three = 3' },
      ] },
      { text: 'Rien ne change à la fin', ticket: null, partly: null, anchors: [] },
    ])
  })

  test('a `## #n` line gives the requirements under it to that ticket', () => {
    expect(readTrace('## #836\n- Un\n## 837\n- Deux', files).map(r => r.ticket)).toEqual([836, 837])
  })

  test('a removed line anchors on the old side', () => {
    expect(readTrace('- Plus de deux\n  a.ts const two = 2', files)[0]!.anchors[0]).toMatchObject({ side: 'old', line: 2 })
  })

  test('refuses an anchor outside any requirement, a line the diff lacks and a file the item lacks', () => {
    expect(() => readTrace('  a.ts const one', files)).toThrow('a.ts const one comes before any "- requirement" line')
    expect(() => readTrace('- Un\n  a.ts nowhere', files)).toThrow('no line of a.ts holds "nowhere"')
    expect(() => readTrace('- Un\n  c.ts x', files)).toThrow('c.ts is not in this item')
  })
})

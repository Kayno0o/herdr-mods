// An item's requirements traced to the lines doing them, as an agent writes them on stdin.
import type { Requirement } from './types'
import { lineOf, textAt } from './format'
import { fileNamed, PATH_LINE } from './inbox'

const TICKET_LINE = /^##\s*#?(\d+)\s*$/
const PARTLY_LINE = /^partly:\s*(\S.*)$/

interface PatchRef { repo: string, path: string, patch: string }

// `## #n` gives the requirements under it to ticket n, `- <requirement>` starts one, and its indented lines are `<path> <text of a line>` anchors or `partly: <what is left>`.
export function readTrace(text: string, files: PatchRef[]): Requirement[] {
  const trace: Requirement[] = []
  let ticket: number | null = null

  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const heading = TICKET_LINE.exec(line)

    if (!line)
      continue

    if (heading) {
      ticket = Number(heading[1])

      continue
    }

    if (line.startsWith('- ')) {
      trace.push({ text: line.slice(2).trim(), ticket, anchors: [], partly: null })

      continue
    }

    const requirement = trace.at(-1)

    if (!requirement)
      throw new Error(`${line} comes before any "- requirement" line`)

    const partly = PARTLY_LINE.exec(line)

    if (partly) {
      requirement.partly = partly[1]!.trim()

      continue
    }

    const [, path, wanted] = PATH_LINE.exec(line) ?? [null, line, '']
    const file = fileNamed(files, path!)
    const at = wanted ? lineOf(file.patch, wanted) : null

    if (!at)
      throw new Error(`no line of ${path} holds "${wanted}"`)

    requirement.anchors.push({ repo: file.repo, path: file.path, ...at, text: textAt(file.patch, at.side, at.line)! })
  }

  return trace
}

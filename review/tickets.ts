import type { Ticket } from './types'

// `#1525 - [GLOBAL] Acces par URL Admin projet`, the line the commit rules put in a commit's body for each ticket
const TICKET_LINE = /^#(\d+)\s*-\s*(\S.*)$/
// a use case may nest one bracket level: `[TICKET_COMMENT_EDIT[ADD]]`
const SCREEN = /^\[((?:[^[\]]|\[[^[\]]*\])*)\]\s*/
const AUTOSQUASH = /^(?:fixup|squash|amend)! /

export function parseTicket(line: string): Ticket | null {
  const m = TICKET_LINE.exec(line.trim())

  if (!m?.[1] || !m[2])
    return null

  const screen = SCREEN.exec(m[2])

  return { number: Number(m[1]), screen: screen?.[1] ?? null, title: screen ? m[2].slice(screen[0].length) : m[2] }
}

// Every ticket a message's body names, once each.
export function ticketsIn(body: string): Ticket[] {
  const seen = new Map<number, Ticket>()

  for (const line of body.split('\n')) {
    const ticket = parseTicket(line)

    if (ticket && !seen.has(ticket.number))
      seen.set(ticket.number, ticket)
  }

  return [...seen.values()]
}

// The subject a `fixup!` commit points at, whose tickets it shares.
export function autosquashTarget(subject: string): string | null {
  return AUTOSQUASH.test(subject) ? subject.replace(AUTOSQUASH, '') : null
}

export const ticketKey = (ticket: Pick<Ticket, 'number'>) => `#${ticket.number}`

export const ticketLine = (ticket: Ticket) => `#${ticket.number} - ${ticket.screen ? `[${ticket.screen}] ` : ''}${ticket.title}`

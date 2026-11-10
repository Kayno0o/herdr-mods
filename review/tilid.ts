// Moves an approved ticket on in Tilid, signed in with the session the Tilid MCP and its TUI share in ~/.tilid_tokens.json.
import type { Advance } from './config'
import type { Inbox, Ticket } from './types'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const SESSION_COOKIE = 'nuxt-session'
const TIMEOUT_MS = 10_000
const PRIVATE_FILE_MODE = 0o600
const LD_JSON = 'application/ld+json'
const DIACRITICS = /\p{Diacritic}/gu

const tokenFile = () => process.env.TILID_TOKEN_FILE || join(homedir(), '.tilid_tokens.json')

function readCookie(): string {
  const stored = existsSync(tokenFile()) ? (JSON.parse(readFileSync(tokenFile(), 'utf8')) as { cookie?: unknown }).cookie : null

  if (typeof stored !== 'string' || !stored)
    throw new Error(`no Tilid session in ${tokenFile()}: sign in with the Tilid MCP first`)

  // stored as the whole `nuxt-session=value` pair or as the bare value, depending on the tool that wrote it
  return stored.startsWith(`${SESSION_COOKIE}=`) ? stored.slice(SESSION_COOKIE.length + 1) : stored
}

// Tilid renews the session on its own and hands the new cookie back, which the next reader of the file needs.
async function call<T>(base: string, path: string, session: { cookie: string }, body?: unknown): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'Accept': body === undefined ? LD_JSON : 'application/json', 'Accept-Language': 'fr', 'Cookie': `${SESSION_COOKIE}=${session.cookie}`, ...body === undefined ? {} : { 'Content-Type': 'application/json' } },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  })
  const pair = response.headers.getSetCookie().find(cookie => cookie.startsWith(`${SESSION_COOKIE}=`))
  const renewed = pair?.slice(SESSION_COOKIE.length + 1, pair.includes(';') ? pair.indexOf(';') : undefined)

  if (renewed && renewed !== session.cookie) {
    session.cookie = renewed
    writeFileSync(tokenFile(), JSON.stringify({ cookie: `${SESSION_COOKIE}=${renewed}` }), { mode: PRIVATE_FILE_MODE })
    chmodSync(tokenFile(), PRIVATE_FILE_MODE)
  }

  if (response.status === 401)
    throw new Error('the Tilid session has expired: sign in with the Tilid MCP again')

  if (!response.ok)
    throw new Error(`Tilid answered ${response.status} on ${path}`)

  const text = await response.text()

  return (text ? JSON.parse(text) : null) as T
}

const members = <T>(data: T[] | { 'hydra:member'?: T[] }): T[] => Array.isArray(data) ? data : data['hydra:member'] ?? []

// accents and case apart, the way Tilid lists its statuses as plain names
const plain = (value: string) => value.normalize('NFD').replace(DIACRITICS, '').trim().toLowerCase()

export interface Moved { number: number, status: string, moved: boolean, skipped: string }

// Moves a ticket from the config's review status to the next one, and only that ticket: one whose use case differs from the commits' likely belongs to another project and stays put.
export async function advanceTicket(tilid: NonNullable<Inbox['tilid']>, ticket: Ticket, { from, to }: Advance): Promise<Moved> {
  const base = `https://${tilid.instance}.tilid.io`
  const session = { cookie: readCookie() }
  const raw = await call<{ status?: { value?: string }, useCase?: { code?: string, value?: string } }>(base, `/api/projects/${encodeURIComponent(tilid.code)}/tickets/${ticket.number}`, session)
  const status = raw.status?.value ?? ''
  const useCase = raw.useCase?.code ?? raw.useCase?.value ?? ''

  if (plain(status) !== plain(from))
    return { number: ticket.number, status, moved: false, skipped: `it is "${status}", not "${from}"` }

  if (ticket.screen && useCase && ticket.screen !== useCase)
    return { number: ticket.number, status, moved: false, skipped: `the Tilid ticket is about ${useCase}, the commits about ${ticket.screen}` }

  const project = members(await call<{ uuid: string, code: string }[]>(base, '/api/projects?groups[]=isManager', session)).find(p => p.code.toLowerCase() === tilid.code.toLowerCase())

  if (!project)
    throw new Error(`no Tilid project ${tilid.code} this account manages`)

  const statuses = await call<{ projectTicketStatuses?: { '@id'?: string, 'value': string }[] }>(base, `/api/projects/code/${encodeURIComponent(project.code)}/enumerations`, session)
  const next = (statuses.projectTicketStatuses ?? []).find(s => plain(s.value) === plain(to))

  if (!next?.['@id'])
    throw new Error(`the Tilid project ${project.code} has no "${to}" status`)

  // the mass action is the route the Tilid board itself moves tickets through, and it sends no notification
  await call(base, `/api/projects/${project.uuid}/tickets_mass_action`, session, { '@id': null, 'disableNotification': true, 'status': next['@id'], 'tickets': [ticket.number] })

  return { number: ticket.number, status: next.value, moved: true, skipped: '' }
}

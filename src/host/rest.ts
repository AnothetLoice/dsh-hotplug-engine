/**
 * REST surface (contract §5): 10 endpoints under /api/dsh-hotplug.
 *
 * - ALL endpoints pass the same-origin gate (loopback peer + Host + Origin),
 *   mirroring the official webServer loopback guard; GET read-only endpoints
 *   need no further permission (same-origin is sufficient);
 * - business errors → HTTP 200 + ok:false (MutationResult), invalid bodies →
 *   4xx (v1 no token, ADR-0006);
 * - GET /events is the SSE stream: connect-time snapshot frame + forwarded
 *   operation/entry frames (contract §7, wired via events.ts).
 *
 * @module dsh-hotplug-engine/host/rest
 */

import type {
  AuditRecord, EngineEvent, EngineSnapshot, MutationResult, OperationInfo, RuntimeEntry,
} from '../contract/types.ts'
import { EngineError, ErrorCodes } from '../contract/types.ts'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { EventStream, type SseResponse } from './events.ts'

/** REST path constants (contract §5 table). */
export const API_PREFIX = '/api/dsh-hotplug'
export const REST_PATHS = {
  snapshot: `${API_PREFIX}/snapshot`,
  status: `${API_PREFIX}/status`,
  install: `${API_PREFIX}/install`,
  uninstall: `${API_PREFIX}/uninstall`,
  enable: `${API_PREFIX}/enable`,
  disable: `${API_PREFIX}/disable`,
  rollback: `${API_PREFIX}/rollback`,
  audit: `${API_PREFIX}/audit`,
  operations: `${API_PREFIX}/operations`,
  events: `${API_PREFIX}/events`,
} as const

/** Transport-level error codes (contract §8, single source = ErrorCodes). */
export const RestCodes = {
  FORBIDDEN: ErrorCodes.REST_FORBIDDEN,
  INVALID_BODY: ErrorCodes.REST_INVALID_BODY,
  METHOD_NOT_ALLOWED: ErrorCodes.REST_METHOD_NOT_ALLOWED,
  INTERNAL: ErrorCodes.REST_INTERNAL,
} as const

/** Incoming request subset the handlers need (testable with fakes). */
export interface HttpRequest {
  method?: string
  url?: string
  socket?: { remoteAddress?: string | undefined }
  headers?: Record<string, string | string[] | undefined>
  [Symbol.asyncIterator](): AsyncIterator<Buffer | string>
}

/** The host service subset consumed by REST (contract §4). `caller` marks
 * audit provenance (rest.ts always passes 'rest'). */
export interface RestService {
  snapshot(profile?: string): EngineSnapshot
  status(entryId?: string, profile?: string): RuntimeEntry | undefined
  install(spec: string, opts?: { profile?: string; dryRun?: boolean; caller?: 'rest' }): Promise<MutationResult>
  uninstall(name: string, opts?: { profile?: string; caller?: 'rest' }): Promise<MutationResult>
  enable(entryId: string, opts?: { profile?: string; caller?: 'rest' }): Promise<MutationResult>
  disable(entryId: string, opts?: { profile?: string; caller?: 'rest' }): Promise<MutationResult>
  rollback(handle: string, opts?: { profile?: string; caller?: 'rest' }): Promise<MutationResult>
  audit(query?: { op?: string; from?: string; limit?: number }): AuditRecord[]
  listOperations(): OperationInfo[]
  onEvent(listener: (event: EngineEvent) => void): () => void
}

/** One registered route (official webServer shape, dsh-host-webserver). */
export type Route = WebRoute

/** Max accepted JSON request body (defensive). */
const MAX_BODY_BYTES = 1024 * 1024

/** Hooks for route-registration lifecycle (SSE stream tracking). */
export interface RouteHooks {
  /** Called for every EventStream the SSE endpoint opens (plugin-lifetime
   * tracking; the caller disposes them on teardown). */
  onStream?: (stream: EventStream) => void
}

/** Build all 10 REST routes against one service (contract §5). */
export function makeRoutes(service: RestService, hooks: RouteHooks = {}): Route[] {
  return [
    // GET snapshot?profile= → EngineSnapshot
    {
      kind: 'exact',
      path: REST_PATHS.snapshot,
      handler: async (req, res) => {
        if (!expectSameOrigin(req, res)) return
        if (!expectMethod(req, res, 'GET')) return
        const url = parseUrl(req)
        try {
          writeJson(res, 200, service.snapshot(queryParam(url, 'profile')))
        } catch (error) {
          writeEngineError(res, 400, error)
        }
      },
    },
    // GET status?entryId=&profile= → RuntimeEntry | null
    {
      kind: 'exact',
      path: REST_PATHS.status,
      handler: async (req, res) => {
        if (!expectSameOrigin(req, res)) return
        if (!expectMethod(req, res, 'GET')) return
        const url = parseUrl(req)
        try {
          const entry = service.status(queryParam(url, 'entryId'), queryParam(url, 'profile'))
          writeJson(res, 200, entry ?? null)
        } catch (error) {
          writeEngineError(res, 400, error)
        }
      },
    },
    // POST install { spec, profile?, dryRun? } → MutationResult
    {
      kind: 'exact',
      path: REST_PATHS.install,
      handler: async (req, res) => {
        if (!expectSameOrigin(req, res)) return
        if (!expectMethod(req, res, 'POST')) return
        const body = await expectJsonBody(req, res)
        if (body === undefined) return
        const spec = stringField(body, 'spec')
        if (spec === undefined || spec === '') {
          writeError(res, 400, RestCodes.INVALID_BODY, 'install requires a non-empty "spec" string')
          return
        }
        const profile = stringField(body, 'profile')
        const dryRun = booleanField(body, 'dryRun')
        await respondMutation(res, () => service.install(spec, { profile, dryRun, caller: 'rest' }))
      },
    },
    // POST uninstall { name, profile? } → MutationResult
    {
      kind: 'exact',
      path: REST_PATHS.uninstall,
      handler: async (req, res) => {
        if (!expectSameOrigin(req, res)) return
        if (!expectMethod(req, res, 'POST')) return
        const body = await expectJsonBody(req, res)
        if (body === undefined) return
        const name = stringField(body, 'name')
        if (name === undefined || name === '') {
          writeError(res, 400, RestCodes.INVALID_BODY, 'uninstall requires a non-empty "name" string')
          return
        }
        const profile = stringField(body, 'profile')
        await respondMutation(res, () => service.uninstall(name, { profile, caller: 'rest' }))
      },
    },
    // POST enable { entryId, profile? } → MutationResult
    {
      kind: 'exact',
      path: REST_PATHS.enable,
      handler: async (req, res) => {
        if (!expectSameOrigin(req, res)) return
        if (!expectMethod(req, res, 'POST')) return
        const body = await expectJsonBody(req, res)
        if (body === undefined) return
        const entryId = stringField(body, 'entryId')
        if (entryId === undefined || entryId === '') {
          writeError(res, 400, RestCodes.INVALID_BODY, 'enable requires a non-empty "entryId" string')
          return
        }
        const profile = stringField(body, 'profile')
        await respondMutation(res, () => service.enable(entryId, { profile, caller: 'rest' }))
      },
    },
    // POST disable { entryId, profile? } → MutationResult
    {
      kind: 'exact',
      path: REST_PATHS.disable,
      handler: async (req, res) => {
        if (!expectSameOrigin(req, res)) return
        if (!expectMethod(req, res, 'POST')) return
        const body = await expectJsonBody(req, res)
        if (body === undefined) return
        const entryId = stringField(body, 'entryId')
        if (entryId === undefined || entryId === '') {
          writeError(res, 400, RestCodes.INVALID_BODY, 'disable requires a non-empty "entryId" string')
          return
        }
        const profile = stringField(body, 'profile')
        await respondMutation(res, () => service.disable(entryId, { profile, caller: 'rest' }))
      },
    },
    // POST rollback { handle, profile? } → MutationResult
    {
      kind: 'exact',
      path: REST_PATHS.rollback,
      handler: async (req, res) => {
        if (!expectSameOrigin(req, res)) return
        if (!expectMethod(req, res, 'POST')) return
        const body = await expectJsonBody(req, res)
        if (body === undefined) return
        const handle = stringField(body, 'handle')
        if (handle === undefined || handle === '') {
          writeError(res, 400, RestCodes.INVALID_BODY, 'rollback requires a non-empty "handle" string')
          return
        }
        const profile = stringField(body, 'profile')
        await respondMutation(res, () => service.rollback(handle, { profile, caller: 'rest' }))
      },
    },
    // GET audit?op=&from=&limit= → AuditRecord[]
    {
      kind: 'exact',
      path: REST_PATHS.audit,
      handler: async (req, res) => {
        if (!expectSameOrigin(req, res)) return
        if (!expectMethod(req, res, 'GET')) return
        const url = parseUrl(req)
        const limitRaw = queryParam(url, 'limit')
        let limit: number | undefined
        if (limitRaw !== undefined) {
          limit = Number(limitRaw)
          if (!Number.isInteger(limit) || limit < 0) {
            writeError(res, 400, RestCodes.INVALID_BODY, `audit "limit" must be a non-negative integer, got "${limitRaw}"`)
            return
          }
        }
        const records = service.audit({
          op: queryParam(url, 'op'),
          from: queryParam(url, 'from'),
          limit,
        })
        writeJson(res, 200, records)
      },
    },
    // GET operations → OperationInfo[]
    {
      kind: 'exact',
      path: REST_PATHS.operations,
      handler: async (req, res) => {
        if (!expectSameOrigin(req, res)) return
        if (!expectMethod(req, res, 'GET')) return
        writeJson(res, 200, service.listOperations())
      },
    },
    // GET events → SSE (contract §7)
    {
      kind: 'exact',
      path: REST_PATHS.events,
      handler: async (req, res) => {
        if (!expectSameOrigin(req, res)) return
        if (!expectMethod(req, res, 'GET')) return
        const stream = new EventStream(res, service)
        hooks.onStream?.(stream)
        stream.start()
      },
    },
  ]
}

// ── handlers helpers ────────────────────────────────────────────────────────

/** Method guard: 405 on mismatch (returns false when it wrote the error). */
function expectMethod(req: HttpRequest, res: SseResponse, method: string): boolean {
  if ((req.method ?? 'GET') === method) return true
  writeError(res, 405, RestCodes.METHOD_NOT_ALLOWED, `method not allowed: ${req.method ?? ''} (expected ${method})`)
  return false
}

/** Same-origin gate for ALL endpoints (contract §5: loopback + Host + Origin;
 * 403 on mismatch). Read-only GETs carry it too, mirroring the official
 * webServer loopback guard (dsh-ssh) — the fence is the network boundary. */
function expectSameOrigin(req: HttpRequest, res: SseResponse): boolean {
  if (isSameOriginRequest(req)) return true
  writeError(res, 403, RestCodes.FORBIDDEN, 'forbidden: same-origin request required')
  return false
}

/** JSON body reader with validation: 400 on unparseable/oversized bodies. */
async function expectJsonBody(req: HttpRequest, res: SseResponse): Promise<Record<string, unknown> | undefined> {
  const body = await readJsonBody(req)
  if (body !== undefined) return body
  writeError(res, 400, RestCodes.INVALID_BODY, 'invalid JSON request body')
  return undefined
}

/** Run a mutation and write its MutationResult; defensive 500 on throw
 * (the service normally returns ok:false instead of throwing). */
async function respondMutation(res: SseResponse, run: () => Promise<MutationResult>): Promise<void> {
  try {
    writeJson(res, 200, await run())
  } catch (error) {
    writeError(res, 500, RestCodes.INTERNAL, error instanceof Error ? error.message : String(error))
  }
}

/** Same-origin check: loopback peer + loopback Host + origin matches (if any).
 * Mirrors the official webServer loopback guard used by dsh-ssh. */
function isSameOriginRequest(req: HttpRequest): boolean {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const host = header(req, 'host')
  if (host === undefined) return false
  let hostUrl: URL
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false
  if (req.headers?.['sec-fetch-site'] === 'cross-site') return false
  const origin = header(req, 'origin')
  if (origin === undefined) return true
  try {
    return new URL(origin).host === hostUrl.host
  } catch {
    return false
  }
}

/** Single header value (string only; arrays/undefined → undefined). */
function header(req: HttpRequest, name: string): string | undefined {
  const value = req.headers?.[name]
  return typeof value === 'string' ? value : undefined
}

/** URL query helper (first value, decoded). */
function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name)
  return value === null ? undefined : value
}

function parseUrl(req: HttpRequest): URL {
  return new URL(req.url ?? '/', 'http://localhost')
}

function stringField(body: Record<string, unknown>, name: string): string | undefined {
  const value = body[name]
  return typeof value === 'string' ? value : undefined
}

function booleanField(body: Record<string, unknown>, name: string): boolean | undefined {
  const value = body[name]
  return typeof value === 'boolean' ? value : undefined
}

/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req: HttpRequest): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > MAX_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/** One JSON response. M5 L5: a half-closed connection can throw from
 * writeHead/end — swallow and log so read-only handlers never reject
 * unhandled (respondMutation already has its own catch; this closes the
 * read-only GET + error branches in one place). */
function writeJson(res: SseResponse, status: number, body: unknown): void {
  try {
    const payload = JSON.stringify(body)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'referrer-policy': 'no-referrer',
    })
    res.end(payload)
  } catch (error) {
    console.warn('[hotplug-engine] rest response write failed:', error)
  }
}

/** 4xx/5xx error body: { error: { code, message } }. */
function writeError(res: SseResponse, status: number, code: string, message: string): void {
  writeJson(res, status, { error: { code, message } })
}

/** Business error → its contract code (EngineError) or INTERNAL fallback. */
function writeEngineError(res: SseResponse, status: number, error: unknown): void {
  if (error instanceof EngineError) {
    writeError(res, status, error.code, error.message)
    return
  }
  writeError(res, status, RestCodes.INTERNAL, error instanceof Error ? error.message : String(error))
}

import { describe, expect, it, vi } from 'vitest'
import { createServer, get as httpGet, type IncomingMessage, type Server } from 'node:http'
import { REST_PATHS, RestCodes, makeRoutes, type HttpRequest, type RestService, type Route } from '../src/host/rest.ts'
import { EngineError, ErrorCodes, type AuditRecord, type EngineSnapshot, type MutationResult, type RuntimeEntry } from '../src/contract/types.ts'

// ── fakes ───────────────────────────────────────────────────────────────────

interface ReqInit {
  method?: string
  url?: string
  remote?: string
  host?: string
  origin?: string
  secFetchSite?: string
  body?: string
}

function makeReq(init: ReqInit = {}): HttpRequest {
  const chunks: Buffer[] = init.body === undefined ? [] : [Buffer.from(init.body, 'utf8')]
  const headers: Record<string, string> = { host: init.host ?? '127.0.0.1:3080' }
  if (init.origin !== undefined) headers['origin'] = init.origin
  if (init.secFetchSite !== undefined) headers['sec-fetch-site'] = init.secFetchSite
  const req: HttpRequest = {
    method: init.method ?? 'GET',
    url: init.url ?? REST_PATHS.snapshot,
    socket: { remoteAddress: init.remote ?? '127.0.0.1' },
    headers,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
  return req
}

interface ResState {
  status: number
  headers: Record<string, string>
  body: unknown
  written: string[]
  closeHandlers: Array<() => void>
  writeHead(status: number, headers: Record<string, string>): void
  write(chunk: string): void
  end(chunk?: string): void
  on(event: string, listener: () => void): void
}

/** A fake ServerResponse that also records status/headers/body. */
function makeRes(): ResState {
  const state = { status: 0, headers: {}, body: undefined, written: [], closeHandlers: [] } as ResState
  state.writeHead = (status, headers) => {
    state.status = status
    Object.assign(state.headers, headers)
  }
  state.write = (chunk) => { state.written.push(chunk) }
  state.end = (chunk) => {
    if (chunk !== undefined) state.written.push(chunk)
    const text = state.written.join('')
    try {
      state.body = JSON.parse(text)
    } catch {
      state.body = text
    }
  }
  state.on = (event, listener) => {
    if (event === 'close') state.closeHandlers.push(listener)
  }
  return state
}

const ENTRY: RuntimeEntry = {
  entryId: 'row-a', moduleName: 'pkg-x', source: 'insert', enabled: true,
  patchTargetable: true, fiberPhase: 'active', managed: true,
}

const SNAP: EngineSnapshot = {
  profile: 'web', mode: 'hot', entries: [ENTRY], packages: [{ name: 'pkg-x', isBundle: false, version: '1.0.0' }],
  insertRows: [{ id: 'row-a', name: 'pkg-x', managed: true }],
}

function makeService(overrides: Partial<RestService> = {}): RestService {
  const calls: Record<string, unknown[]> = {}
  const service: RestService = {
    snapshot: (profile) => {
      calls['snapshot'] = [...(calls['snapshot'] ?? []), profile]
      if (profile !== undefined && profile !== 'web') {
        throw new EngineError(ErrorCodes.PROFILE_PROTECTED, `profile ${profile} is not manageable in M1`)
      }
      return SNAP
    },
    status: (entryId) => (entryId === 'row-a' ? ENTRY : undefined),
    install: async (spec, opts) => {
      calls['install'] = [...(calls['install'] ?? []), { spec, opts }]
      return { ok: true, message: `install ${spec}`, operationId: 'op-1', rollbackHandle: 'op-1' }
    },
    uninstall: async (name) => {
      calls['uninstall'] = [...(calls['uninstall'] ?? []), name]
      return { ok: false, message: `no such ${name}`, errors: [{ code: ErrorCodes.INSTALL_FAILED, detail: 'not installed' }] }
    },
    enable: async (entryId) => {
      calls['enable'] = [...(calls['enable'] ?? []), entryId]
      return { ok: true, message: `enable ${entryId}`, operationId: 'op-2' }
    },
    disable: async (entryId) => {
      calls['disable'] = [...(calls['disable'] ?? []), entryId]
      return { ok: true, message: `disable ${entryId}`, operationId: 'op-3' }
    },
    rollback: async (handle) => {
      calls['rollback'] = [...(calls['rollback'] ?? []), handle]
      return { ok: true, message: `rollback ${handle}`, operationId: 'op-4' }
    },
    audit: (query) => {
      calls['audit'] = [...(calls['audit'] ?? []), query]
      return [{ ts: '2026-08-14T00:00:00Z', operationId: 'op-1', op: 'install', mode: 'hot', result: 'succeeded', caller: 'service' } as AuditRecord]
    },
    listOperations: () => [],
    onEvent: () => () => {},
    ...overrides,
  }
  return Object.assign(service, { calls })
}

function callsOf(service: RestService): Record<string, unknown[]> {
  return (service as unknown as { calls: Record<string, unknown[]> }).calls
}

// ── route registration ──────────────────────────────────────────────────────

describe('rest: route registration', () => {
  it('registers exactly the 10 contract endpoints as exact routes', () => {
    const routes = makeRoutes(makeService())
    expect(routes.length).toBe(10)
    const paths = routes.map(r => r.path).sort()
    const expected = Object.values(REST_PATHS).sort()
    expect(paths).toEqual(expected)
    for (const route of routes) expect(route.kind).toBe('exact')
  })
})

// ── GET endpoints ───────────────────────────────────────────────────────────

describe('rest: GET read-only endpoints', () => {
  it('serves the snapshot (with optional profile)', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.snapshot)!.handler(makeReq(), res)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(SNAP)
  })

  it('serves one entry or null from /status', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.status)!.handler(makeReq({ url: '/api/dsh-hotplug/status?entryId=row-a' }), res)
    expect(res.body).toEqual(ENTRY)
    const missing = makeRes()
    await routes.find(r => r.path === REST_PATHS.status)!.handler(makeReq({ url: '/api/dsh-hotplug/status?entryId=nope' }), missing)
    expect(missing.body).toBeNull()
  })

  it('passes audit filters and returns records', async () => {
    const service = makeService()
    const routes = makeRoutes(service)
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.audit)!.handler(makeReq({ url: '/api/dsh-hotplug/audit?op=install&from=2026-08-01T00:00:00Z&limit=5' }), res)
    expect(callsOf(service)['audit']).toEqual([{ op: 'install', from: '2026-08-01T00:00:00Z', limit: 5 }])
    expect(res.status).toBe(200)
    expect((res.body as AuditRecord[]).length).toBe(1)
  })

  it('rejects a non-integer audit limit with 400', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.audit)!.handler(makeReq({ url: '/api/dsh-hotplug/audit?limit=abc' }), res)
    expect(res.status).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe(RestCodes.INVALID_BODY)
  })

  it('returns the business error code for an invalid profile on GET snapshot', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.snapshot)!.handler(makeReq({ url: '/api/dsh-hotplug/snapshot?profile=other' }), res)
    expect(res.status).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe(ErrorCodes.PROFILE_PROTECTED)
  })

  it('serves the operations list', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.operations)!.handler(makeReq(), res)
    expect(res.status).toBe(200)
    expect(res.body).toEqual([])
  })

  it('rejects a wrong method with 405', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.snapshot)!.handler(makeReq({ method: 'POST' }), res)
    expect(res.status).toBe(405)
    expect((res.body as { error: { code: string } }).error.code).toBe(RestCodes.METHOD_NOT_ALLOWED)
  })
})

// ── POST endpoints ──────────────────────────────────────────────────────────

describe('rest: POST mutations (same-origin gated)', () => {
  it('runs install and returns 200 + MutationResult (caller marked rest)', async () => {
    const service = makeService()
    const routes = makeRoutes(service)
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.install)!.handler(
      makeReq({ method: 'POST', body: JSON.stringify({ spec: 'pkg-x', dryRun: true }) }), res)
    expect(res.status).toBe(200)
    expect((res.body as MutationResult).ok).toBe(true)
    expect(callsOf(service)['install']).toEqual([{ spec: 'pkg-x', opts: { profile: undefined, dryRun: true, caller: 'rest' } }])
  })

  it('keeps business errors at HTTP 200 with ok:false', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.uninstall)!.handler(
      makeReq({ method: 'POST', body: JSON.stringify({ name: 'ghost' }) }), res)
    expect(res.status).toBe(200)
    const body = res.body as MutationResult
    expect(body.ok).toBe(false)
    expect(body.errors?.[0]?.code).toBe(ErrorCodes.INSTALL_FAILED)
  })

  it('rejects a missing required field with 400', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.install)!.handler(
      makeReq({ method: 'POST', body: JSON.stringify({}) }), res)
    expect(res.status).toBe(400)
    expect((res.body as { error: { code: string } }).error.code).toBe(RestCodes.INVALID_BODY)
  })

  it('rejects a non-loopback peer with 403', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.enable)!.handler(
      makeReq({ method: 'POST', remote: '10.0.0.1', body: JSON.stringify({ entryId: 'row-a' }) }), res)
    expect(res.status).toBe(403)
    expect((res.body as { error: { code: string } }).error.code).toBe(RestCodes.FORBIDDEN)
  })

  it('fences read-only GET endpoints too (loopback required)', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.snapshot)!.handler(makeReq({ remote: '10.0.0.1' }), res)
    expect(res.status).toBe(403)
    expect((res.body as { error: { code: string } }).error.code).toBe(RestCodes.FORBIDDEN)
  })

  it('rejects a cross-site origin on POST', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.rollback)!.handler(
      makeReq({ method: 'POST', origin: 'http://evil.example', body: JSON.stringify({ handle: 'op-1' }) }), res)
    expect(res.status).toBe(403)
  })

  it('allows a same-origin POST with an explicit matching origin', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.disable)!.handler(
      makeReq({ method: 'POST', origin: 'http://127.0.0.1:3080', body: JSON.stringify({ entryId: 'row-a' }) }), res)
    expect(res.status).toBe(200)
  })

  it('rejects a malformed JSON body with 400', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.enable)!.handler(
      makeReq({ method: 'POST', body: 'not json' }), res)
    expect(res.status).toBe(400)
  })

  it('rejects an oversized body with 400', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.rollback)!.handler(
      makeReq({ method: 'POST', body: JSON.stringify({ handle: 'x'.repeat(1024 * 1024 + 16) }) }), res)
    expect(res.status).toBe(400)
  })

  it('serializes an already-escaped GATE detail through the boundary unchanged (plan §5 转义)', async () => {
    const service = makeService({
      install: async () => ({
        ok: false,
        message: 'quality gate rejected',
        errors: [{ code: ErrorCodes.GATE_REJECTED, detail: '&lt;script&gt;alert(1)&lt;/script&gt;' }],
      }),
    })
    const routes = makeRoutes(service)
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.install)!.handler(
      makeReq({ method: 'POST', body: JSON.stringify({ spec: 'pkg-x' }) }), res)
    expect(res.status).toBe(200)
    const body = res.body as MutationResult
    expect(body.errors?.[0]?.code).toBe(ErrorCodes.GATE_REJECTED)
    expect(body.errors?.[0]?.detail).toContain('&lt;script&gt;')
  })
})

// ── error-code single source ────────────────────────────────────────────────

describe('rest: REST codes live in the single ErrorCodes source (contract §8)', () => {
  it('exposes the four transport codes from ErrorCodes', () => {
    expect(ErrorCodes.REST_FORBIDDEN).toBe('HOTPLUG.REST.FORBIDDEN')
    expect(ErrorCodes.REST_INVALID_BODY).toBe('HOTPLUG.REST.INVALID_BODY')
    expect(ErrorCodes.REST_METHOD_NOT_ALLOWED).toBe('HOTPLUG.REST.METHOD_NOT_ALLOWED')
    expect(ErrorCodes.REST_INTERNAL).toBe('HOTPLUG.REST.INTERNAL')
    expect(RestCodes.FORBIDDEN).toBe(ErrorCodes.REST_FORBIDDEN)
  })
})

// ── real HTTP e2e (plan §5 e2e 层,真实 IncomingMessage/ServerResponse) ─────

function startTestServer(routes: Route[]): Promise<{ server: Server; port: number; base: string }> {
  return new Promise(resolve => {
    const server = createServer((req, res) => {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname
      const route = routes.find(r => r.path === path)
      if (route === undefined) {
        res.writeHead(404)
        res.end()
        return
      }
      void route.handler(req as never, res as never)
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve({ server, port, base: `http://127.0.0.1:${port}` })
    })
  })
}

describe('rest: real HTTP e2e', () => {
  it('serves GET snapshot and an SSE stream over a real node:http server', async () => {
    const service = makeService()
    const { server, port, base } = await startTestServer(makeRoutes(service))
    try {
      expect(port).toBeGreaterThan(0)
      // 1. real GET snapshot (same-origin fence passes on loopback)
      const snapRes = await fetch(`${base}${REST_PATHS.snapshot}`)
      expect(snapRes.status).toBe(200)
      const snap = await snapRes.json() as EngineSnapshot
      expect(snap.profile).toBe('web')
      // 2. real SSE: retry hint + snapshot frame on connect, then close
      const chunks: string[] = []
      await new Promise<IncomingMessage>((resolve, reject) => {
        const req = httpGet(`${base}${REST_PATHS.events}`, { headers: { accept: 'text/event-stream' } }, res => {
          res.on('data', (chunk: Buffer) => {
            chunks.push(String(chunk))
            if (chunks.join('').includes('"type":"snapshot"')) {
              req.destroy() // simulate the browser dropping the connection
              resolve(res)
            }
          })
          res.on('error', reject)
        })
        req.on('error', reject)
      })
      expect(chunks.join('')).toContain('retry: 3000')
      expect(chunks.join('')).toContain('"type":"snapshot"')
      // 3. the server stays healthy after the SSE connection closed
      const after = await fetch(`${base}${REST_PATHS.operations}`)
      expect(after.status).toBe(200)
      expect(await after.json()).toEqual([])
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})

describe('rest: SSE events endpoint', () => {
  it('opens a text/event-stream and writes the snapshot frame', async () => {
    const routes = makeRoutes(makeService())
    const res = makeRes()
    await routes.find(r => r.path === REST_PATHS.events)!.handler(makeReq(), res)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/event-stream')
    expect(res.written[0]).toBe('retry: 3000\n\n')
    expect(res.written[1]).toContain('"type":"snapshot"')
  })
})

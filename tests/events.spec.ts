import { describe, expect, it, vi } from 'vitest'
import { EventStream, sseFrame, snapshotFrame, type EventSource, type SseResponse } from '../src/host/events.ts'
import type { EngineEvent, EngineSnapshot } from '../src/contract/types.ts'

function makeSnapshot(): EngineSnapshot {
  return { profile: 'web', mode: 'hot', entries: [], packages: [], insertRows: [] }
}

interface FakeResState {
  status: number
  headers: Record<string, string>
  written: string[]
  closeHandlers: Array<() => void>
  errorHandlers: Array<() => void>
  res: SseResponse
}

function makeRes(): FakeResState {
  const state: FakeResState = { status: 0, headers: {}, written: [], closeHandlers: [], errorHandlers: [] }
  state.res = {
    writeHead(status, headers) {
      state.status = status
      Object.assign(state.headers, headers)
    },
    write(chunk) { state.written.push(chunk) },
    end() {},
    on(event, listener) {
      if (event === 'close') state.closeHandlers.push(listener)
      if (event === 'error') state.errorHandlers.push(listener)
    },
  }
  return state
}

/** Parse the first JSON `data:` frame written. */
function firstFrame(written: string[]): EngineEvent {
  const line = written.find(w => w.startsWith('data: '))
  expect(line).toBeDefined()
  return JSON.parse(line!.slice('data: '.length)) as EngineEvent
}

describe('events: frame serialization', () => {
  it('serializes an EngineEvent as an SSE data frame', () => {
    const event: EngineEvent = { type: 'operation', operationId: 'op-1', op: 'install', status: 'running', ts: '2026-08-14T00:00:00Z' }
    expect(sseFrame(event)).toBe('data: {"type":"operation","operationId":"op-1","op":"install","status":"running","ts":"2026-08-14T00:00:00Z"}\n\n')
  })

  it('builds a connect-time snapshot frame with a 12-hex rev', () => {
    const frame = snapshotFrame(makeSnapshot())
    expect(frame.type).toBe('snapshot')
    if (frame.type !== 'snapshot') throw new Error('unreachable')
    expect(frame.rev).toMatch(/^[0-9a-f]{12}$/)
    expect(new Date(frame.ts).getTime()).not.toBeNaN()
  })
})

describe('events: EventStream connection', () => {
  it('writes SSE headers, retry hint, and the snapshot frame on connect', () => {
    const state = makeRes()
    const listeners = new Set<(e: EngineEvent) => void>()
    const source: EventSource = {
      snapshot: () => makeSnapshot(),
      onEvent: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const stream = new EventStream(state.res, source, 1000)
    stream.start()
    expect(state.status).toBe(200)
    expect(state.headers['content-type']).toContain('text/event-stream')
    expect(state.written[0]).toBe('retry: 3000\n\n')
    const frame = firstFrame(state.written)
    expect(frame.type).toBe('snapshot')
    stream.dispose()
  })

  it('forwards operation/entry frames emitted after connect', () => {
    const state = makeRes()
    const listeners = new Set<(e: EngineEvent) => void>()
    const source: EventSource = {
      snapshot: () => makeSnapshot(),
      onEvent: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const stream = new EventStream(state.res, source, 1000)
    stream.start()
    const op: EngineEvent = { type: 'operation', operationId: 'op-1', op: 'disable', status: 'succeeded', ts: '2026-08-14T00:00:01Z' }
    for (const listener of listeners) listener(op)
    expect(state.written.some(w => w.includes('"op":"disable"'))).toBe(true)
    stream.dispose()
  })

  it('stops forwarding after dispose', () => {
    const state = makeRes()
    const listeners = new Set<(e: EngineEvent) => void>()
    const source: EventSource = {
      snapshot: () => makeSnapshot(),
      onEvent: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const stream = new EventStream(state.res, source, 1000)
    stream.start()
    const before = state.written.length
    stream.dispose()
    for (const listener of listeners) {
      listener({ type: 'operation', operationId: 'op-2', op: 'install', status: 'succeeded', ts: '2026-08-14T00:00:02Z' })
    }
    expect(state.written.length).toBe(before)
  })

  it('disposes when the client closes the connection', () => {
    const state = makeRes()
    const listeners = new Set<(e: EngineEvent) => void>()
    const source: EventSource = {
      snapshot: () => makeSnapshot(),
      onEvent: (listener) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    }
    const stream = new EventStream(state.res, source, 1000)
    stream.start()
    expect(listeners.size).toBe(1)
    for (const handler of state.closeHandlers) handler()
    expect(listeners.size).toBe(0)
    stream.dispose()
  })

  it('emits keep-alive ping comments on the heartbeat interval', () => {
    vi.useFakeTimers()
    try {
      const state = makeRes()
      const source: EventSource = {
        snapshot: () => makeSnapshot(),
        onEvent: () => () => {},
      }
      const stream = new EventStream(state.res, source, 50)
      stream.start()
      const before = state.written.length
      vi.advanceTimersByTime(120)
      expect(state.written.slice(before).some(w => w === ': ping\n\n')).toBe(true)
      stream.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('disposes (stops forwarding + heartbeat) when a write throws on a half-dead connection', () => {
    vi.useFakeTimers()
    try {
      const state = makeRes()
      let writes = 0
      const source: EventSource = {
        snapshot: () => makeSnapshot(),
        onEvent: (listener) => {
          // a live listener we can trigger after the write starts failing
          active = listener
          return () => { active = undefined }
        },
      }
      let active: ((e: EngineEvent) => void) | undefined
      const failing = { ...state.res, write: () => { writes += 1; throw new Error('ERR_STREAM_DESTROYED') } }
      const stream = new EventStream(failing, source, 50)
      stream.start() // writeHead ok (state.res), retry/snapshot writes throw → dispose
      expect(writes).toBeGreaterThan(0)
      // after dispose: no listener remains, heartbeat stopped
      expect(active).toBeUndefined()
      const before = state.written.length
      vi.advanceTimersByTime(200)
      expect(state.written.length).toBe(before) // no further writes attempted
      stream.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

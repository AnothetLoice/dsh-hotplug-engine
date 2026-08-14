/**
 * Engine event stream (contract §7): SSE frame serialization + one client
 * connection adapter. A connection is wired to the service's `onEvent`
 * subscription table: on connect it receives a `snapshot` frame (rev =
 * short hash of the projected snapshot — the consumer refetches
 * GET /api/dsh-hotplug/snapshot for content, contract §7 "以 snapshot 为
 * 最终一致源"), then operation/entry frames are forwarded verbatim.
 *
 * @module dsh-hotplug-engine/host/events
 */

import type { EngineEvent, EngineSnapshot } from '../contract/types.ts'
import { hash12 } from './backup.ts'

/** Node `http.ServerResponse` subset the SSE adapter needs (testable with a
 * fake object). */
export interface SseResponse {
  writeHead(status: number, headers: Record<string, string>): void
  write(chunk: string): void
  end(chunk?: string): void
  on(event: 'close' | 'error', listener: () => void): unknown
}

/** Serialize one EngineEvent as an SSE data frame (contract §7). */
export function sseFrame(event: EngineEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/** Build the connect-time snapshot frame. `rev` is a short hash of the
 * projected snapshot, so any change to the official tree bumps it. */
export function snapshotFrame(snapshot: EngineSnapshot): EngineEvent {
  return { type: 'snapshot', rev: hash12(JSON.stringify(snapshot)), ts: new Date().toISOString() }
}

/** Event-source dependency: the service's subscription surface. */
export interface EventSource {
  onEvent(listener: (event: EngineEvent) => void): () => void
  snapshot(): EngineSnapshot
}

/** One SSE client connection (attach → frames → dispose). */
export class EventStream {
  private readonly res: SseResponse
  private readonly source: EventSource
  private readonly keepAliveMs: number
  private unsubscribe: (() => void) | undefined
  private heartbeat: ReturnType<typeof setInterval> | undefined
  private disposed = false

  constructor(res: SseResponse, source: EventSource, keepAliveMs = 15000) {
    this.res = res
    this.source = source
    this.keepAliveMs = keepAliveMs
  }

  /** Open the stream: SSE headers + retry hint + snapshot frame + subscribe.
   * Idempotent. */
  start(): void {
    if (this.disposed) return
    try {
      this.res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
      })
    } catch {
      this.dispose()
      return
    }
    this.write('retry: 3000\n\n')
    if (this.disposed) return
    // Connect-time snapshot frame (contract §7: 连接即发 snapshot 帧).
    // A failed projection must not leave the connection half-open: emit a
    // comment and keep the stream alive — consumers refetch on events anyway.
    let snapshot: string
    try {
      snapshot = sseFrame(snapshotFrame(this.source.snapshot()))
    } catch {
      snapshot = ': error: snapshot unavailable\n\n'
    }
    this.write(snapshot)
    if (this.disposed) return
    this.unsubscribe = this.source.onEvent(event => {
      this.write(sseFrame(event))
    })
    // Keep the connection alive through quiet periods (browser/proxy idle
    // timeouts; SSE comment frames carry no data). Unref'd so an open stream
    // never keeps the process alive on shutdown.
    this.heartbeat = setInterval(() => {
      this.write(': ping\n\n')
    }, this.keepAliveMs)
    this.heartbeat.unref?.()
    this.res.on('close', () => this.dispose())
    this.res.on('error', () => this.dispose())
  }

  /** Guarded write: a half-dead connection (close event not yet delivered)
   * can throw synchronously — dispose instead of letting it escape into a
   * setInterval callback / event listener. */
  private write(frame: string): void {
    if (this.disposed) return
    try {
      this.res.write(frame)
    } catch {
      this.dispose()
    }
  }

  /** Tear the connection down (unsubscribe + stop heartbeat). Idempotent. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    if (this.heartbeat !== undefined) {
      clearInterval(this.heartbeat)
      this.heartbeat = undefined
    }
  }
}

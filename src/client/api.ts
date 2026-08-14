/**
 * Client API — same-origin REST + SSE client for the hotplug engine
 * (contract §5/§7). Plain fetch/EventSource; no client service deps.
 *
 * @module dsh-hotplug-engine/client/api
 */

import type {
  AuditRecord, EngineEvent, EngineSnapshot, MutationResult, OperationInfo,
} from '../contract/types.ts'

/** REST prefix (contract §5). */
export const API_BASE = '/api/dsh-hotplug'

/** The engine's browser-visible surface (REST + SSE). */
export class HotplugApi {
  /** Full state projection (the final-consistency source, contract §7). */
  async snapshot(): Promise<EngineSnapshot> {
    return this.request<EngineSnapshot>('/snapshot')
  }

  /** Operation history (most recent last). */
  async operations(): Promise<OperationInfo[]> {
    return this.request<OperationInfo[]>('/operations')
  }

  /** Audit trail (newest limit records). */
  async audit(limit = 50): Promise<AuditRecord[]> {
    return this.request<AuditRecord[]>(`/audit?limit=${limit}`)
  }

  async enable(entryId: string): Promise<MutationResult> {
    return this.request<MutationResult>('/enable', { entryId })
  }

  async disable(entryId: string): Promise<MutationResult> {
    return this.request<MutationResult>('/disable', { entryId })
  }

  /** Roll back a mutating operation by its handle (operation id). */
  async rollback(handle: string): Promise<MutationResult> {
    return this.request<MutationResult>('/rollback', { handle })
  }

  /** Subscribe to the engine event stream. The server sends a snapshot frame
   * on connect and operation/entry frames afterwards; the stream
   * auto-reconnects (retry: 3000). Returns the unsubscribe disposer. */
  onEvent(listener: (event: EngineEvent) => void): () => void {
    const source = new EventSource(`${API_BASE}/events`)
    const onMessage = (e: MessageEvent<string>): void => {
      try {
        listener(JSON.parse(e.data) as EngineEvent)
      } catch {
        // skip malformed frames
      }
    }
    source.addEventListener('message', onMessage)
    return () => {
      source.removeEventListener('message', onMessage)
      source.close()
    }
  }

  private async request<T>(path: string, body?: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`, body === undefined
      ? undefined
      : {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
    let payload: unknown
    try {
      payload = await res.json()
    } catch {
      payload = undefined
    }
    if (!res.ok) {
      const message = (payload as { error?: { message?: string } } | undefined)?.error?.message
      throw new Error(message ?? `HTTP ${res.status}`)
    }
    return payload as T
  }
}

/**
 * Plugin entry (host half): mounts the hotplugEngine service and, when the
 * host provides the services, the M3 external surfaces — REST routes
 * (contract §5), agent tools + approval gate (contract §6) and the SSE event
 * stream (contract §7). The core service stays available in headless
 * profiles (webServer/tools are probed, not injected).
 *
 * @module dsh-hotplug-engine
 */

import type { Context } from '@deepseek-ai/cordis'
import { HotplugEngineService } from './host/service.ts'
import { makeRoutes } from './host/rest.ts'
import type { EventStream } from './host/events.ts'
import { makePreExecuteGate, makeTools } from './host/tools.ts'

/** Cordis plugin name (also the bundle row id). */
export const name = 'hotplug-engine'

/** Required services (the loader is the only hard dependency; the REST and
 * tool surfaces mount opportunistically). */
export const inject = ['loader']

/**
 * Mount the engine service + M3 external surfaces.
 * @param ctx - plugin context with `loader` injected.
 */
export function apply(ctx: Context): void {
  const service = new HotplugEngineService(ctx)

  // REST + SSE (contract §5/§7): registered only when a webServer exists.
  // NOTE: cordis service properties THROW when not declared in inject, so
  // optional surfaces must be probed via ctx.get (verified 2026-08-14 A3.6).
  const webServer = ctx.get('webServer')
  if (webServer !== undefined) {
    ctx.effect(() => {
      const streams = new Set<EventStream>()
      const disposers = makeRoutes(service, { onStream: stream => { streams.add(stream) } })
        .map(route => webServer.register(route))
      return () => {
        // Close in-flight SSE connections (they hold service listeners).
        for (const stream of streams) stream.dispose()
        streams.clear()
        for (const dispose of disposers) dispose()
      }
    }, 'hotplug-engine: routes')
  }

  // Agent tools + approval gate (contract §6): registered only when the
  // tool runtime exists. The pre-execute listener routes write tools through
  // the deployment's approval policy (fail-closed when absent).
  const tools = ctx.get('tools')
  if (tools !== undefined) {
    ctx.effect(() => {
      const disposers = makeTools(service).map(tool => tools.register(tool))
      ctx.on('tools/pre-execute', makePreExecuteGate())
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'hotplug-engine: tools')
  }
}

// ── consumer-facing contract surface ───────────────────────────────────────

export { HotplugEngineService } from './host/service.ts'
export { ErrorCodes, EngineError } from './contract/types.ts'
export type * from './contract/types.ts'
export { makeRoutes, REST_PATHS, RestCodes } from './host/rest.ts'
export type { Route, RestService } from './host/rest.ts'
export { makeTools, makePreExecuteGate, HOTPLUG_WRITE_TOOLS } from './host/tools.ts'
export type { ToolService } from './host/tools.ts'
export { EventStream, sseFrame, snapshotFrame } from './host/events.ts'
export type { EventSource, SseResponse } from './host/events.ts'

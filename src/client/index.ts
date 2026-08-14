/**
 * Client half — minimal hotplug management UI (plan T3.4): a sidebar entry
 * toggling a conversation-column panel with entries / packages / insert rows
 * / operations(+rollback) / audit, driven by REST + SSE. NO marketplace, NO
 * install/spec input (Non-Goal guard).
 *
 * @module dsh-hotplug-engine/client
 */

import { HotplugApi } from './api.ts'
import { PanelController } from './controller.ts'
import { injectPanelCss, mountPanel, mountSidebarEntry } from './mount.tsx'

export const name = 'hotplug-engine-client'
export const inject: string[] = []

/** Minimal cordis-context surface the client half uses (effect for HMR-safe
 * cleanup). */
interface ClientLike {
  effect(fn: () => void | (() => void), label?: string): void
}

export function apply(ctx: ClientLike): void {
  const controller = new PanelController()
  const api = new HotplugApi()
  const disposers: Array<() => void> = []
  try {
    injectPanelCss()
    disposers.push(mountSidebarEntry(controller))
    disposers.push(mountPanel(controller, api))
  } catch (error) {
    console.warn('[hotplug-engine] client mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'hotplug-engine: ui mounts')
}

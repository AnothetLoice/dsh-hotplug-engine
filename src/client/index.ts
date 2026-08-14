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
import { makeI18n, type LocaleLike } from './i18n.ts'
import { injectPanelCss, mountPanel, mountSidebarEntry } from './mount.tsx'

export const name = 'hotplug-engine-client'
export const inject: string[] = []

/** Minimal cordis-context surface the client half uses (effect for HMR-safe
 * cleanup). */
interface ClientLike {
  effect(fn: () => void | (() => void), label?: string): void
  get(name: string): unknown
}

export function apply(ctx: ClientLike): void {
  const controller = new PanelController()
  const api = new HotplugApi()
  // Probe the DSH locale service (dsh-client-locale provides 'locale'); absent
  // → fall back to Simplified Chinese.
  const locale = ctx.get('locale') as LocaleLike | undefined
  const i18n = makeI18n(locale)
  const disposers: Array<() => void> = []
  try {
    injectPanelCss()
    disposers.push(mountSidebarEntry(controller, i18n))
    disposers.push(mountPanel(controller, api, i18n))
  } catch (error) {
    console.warn('[hotplug-engine] client mount failed:', error)
  }
  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) dispose()
  }, 'hotplug-engine: ui mounts')
}

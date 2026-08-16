/**
 * Client mounting — DOM-level panel + sidebar entry, mirroring the proven
 * community pattern (dsh-ssh / task board): external plugins cannot declare
 * layout slots, so the panel takes over the conversation column at the DOM
 * level (an extra trailing child React never manages) with a stylesheet rule
 * hiding the conversation while active. Visibility rides a data attribute on
 * <html>; cross-plugin activation cooperates via `dsh-panel-activate`.
 *
 * @module dsh-hotplug-engine/client/mount
 */

import { createRoot } from 'react-dom/client'
import type { HotplugApi } from './api.ts'
import type { PanelController } from './controller.ts'
import { HotplugPanel } from './panels.tsx'
import type { I18n } from './i18n.ts'

const CONVERSATION_COLUMN_SELECTOR = '[data-pane="conversation"]'
const ACTIVE_ATTR = 'data-dsh-hotplug-active'
/** Sibling panels' activation attributes, removed when this panel opens. */
const OTHER_ACTIVE_ATTRS = ['data-dsh-ssh-active', 'data-dsh-taskboard-active']
/** Cross-plugin activation event; detail is the activating panel name. */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const PANEL_NAME = 'hotplug'

// ── stylesheet ──────────────────────────────────────────────────────────────

const CSS_ID = 'dsh-hotplug-engine/panel.css'

const CSS = `
[data-pane=conversation]{position:relative}
[data-dsh-hotplug-view]{z-index:5;display:none;position:absolute;inset:0}
html[data-dsh-hotplug-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [data-dsh-hotplug-view]{display:block}
html[data-dsh-hotplug-active]:not([data-dsh-ssh-active]):not([data-dsh-taskboard-active]) [data-pane=conversation]>:not([data-dsh-hotplug-view]){display:none}
.hpe-entry{width:100%;height:32px;color:var(--dsw-alias-label-secondary);cursor:pointer;white-space:nowrap;background:0 0;border:none;border-radius:8px;align-items:center;gap:8px;padding:0 12px;font-size:13px;display:flex}
.hpe-entry:hover{background:var(--dsw-specific-sidebar-nav-item-hover);color:var(--dsw-alias-label-primary)}
.hpe-entry[data-active]{background:var(--dsw-specific-sidebar-nav-item-active);color:var(--dsw-alias-label-primary);font-weight:600}
.hpe-entryIcon{flex:none;justify-content:center;align-items:center;display:inline-flex}
.hpe-entryLabel{text-overflow:ellipsis;overflow:hidden}
[data-dsh-frame][data-sidebar-collapsed] .hpe-entry{justify-content:center;width:100%;padding:0}
[data-dsh-frame][data-sidebar-collapsed] .hpe-entryLabel{display:none}
.hpe-panel{height:100%;min-height:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);flex-direction:column;gap:10px;padding:14px 16px 12px;display:flex;overflow:hidden}
.hpe-header{flex:none;align-items:center;gap:10px;display:flex}
.hpe-title{color:var(--dsw-alias-label-primary);white-space:nowrap;margin:0;font-size:15px;font-weight:700}
.hpe-mode{color:var(--dsw-alias-label-tertiary);white-space:nowrap;background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;padding:1px 8px;font-size:12px}
.hpe-profile{color:var(--dsw-alias-label-tertiary);white-space:nowrap;font-size:12px}
.hpe-close{width:26px;height:26px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;margin-left:auto;padding:0;font-size:15px;line-height:1}
.hpe-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.hpe-tabs{flex:none;gap:4px;border-bottom:1px solid var(--dsw-alias-separator-primary);padding-bottom:6px;display:flex}
.hpe-tab{color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;border-radius:6px;padding:4px 10px;font-size:13px}
.hpe-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hpe-tab[data-active]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-accent);font-weight:600}
.hpe-body{flex:1;min-height:0;overflow-y:auto}
.hpe-table{width:100%;border-collapse:collapse;font-size:12.5px}
.hpe-table th{text-align:left;color:var(--dsw-alias-label-tertiary);font-weight:600;border-bottom:1px solid var(--dsw-alias-border-l2);padding:4px 8px;position:sticky;top:0;background:var(--dsw-alias-bg-base)}
.hpe-table td{border-bottom:1px solid var(--dsw-alias-border-l1);padding:4px 8px;vertical-align:middle}
.hpe-mono{font-family:var(--dsw-font-markdown-code-block-small);font-size:11.5px}
.hpe-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.hpe-badge{border-radius:999px;padding:1px 8px;font-size:11px;white-space:nowrap}
.hpe-badge[data-source=bundle]{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-state-business-secondary)}
.hpe-badge[data-source=insert]{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-secondary)}
.hpe-badge[data-source=user]{color:var(--dsw-alias-label-tertiary);background:var(--dsw-alias-interactive-bg-hover)}
.hpe-badge[data-status=succeeded],.hpe-badge[data-result=succeeded]{color:var(--dsw-alias-state-success-primary);background:var(--dsw-alias-state-success-secondary)}
.hpe-badge[data-status=failed],.hpe-badge[data-result=failed],.hpe-badge[data-result=rolled-back]{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-state-error-secondary)}
.hpe-badge[data-status=running],.hpe-badge[data-status=queued]{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-state-warn-secondary)}
.hpe-btn{color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);cursor:pointer;background:0 0;border-radius:6px;padding:3px 10px;font-size:12px}
.hpe-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.hpe-btn[data-kind=danger]{color:var(--dsw-alias-state-error-primary)}
.hpe-btn:disabled{opacity:.45;cursor:default}
.hpe-error{flex:none;color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-secondary);background:var(--dsw-alias-state-error-secondary);border-radius:8px;padding:6px 10px;font-size:12px;overflow-wrap:anywhere}
.hpe-warn{flex:none;color:var(--dsw-alias-state-warn-primary);border:1px solid var(--dsw-alias-state-warn-secondary);background:var(--dsw-alias-state-warn-secondary);border-radius:8px;padding:6px 10px;font-size:12px}
.hpe-busy{flex:none;color:var(--dsw-alias-state-warn-primary);font-size:12px}
.hpe-footer{flex:none;color:var(--dsw-alias-label-tertiary);border-top:1px solid var(--dsw-alias-separator-primary);padding-top:6px;font-size:11px}
.hpe-entry:focus-visible,.hpe-close:focus-visible,.hpe-tab:focus-visible,.hpe-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}
/* v0.1.4 direction E: search + source filter */
.hpe-search{flex:none;display:flex;gap:8px}
.hpe-searchInput{flex:1;min-width:0;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 10px;font-size:12.5px}
.hpe-searchSelect{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;padding:5px 8px;font-size:12.5px}
/* v0.1.4 direction F: sortable header */
.hpe-sortable{cursor:pointer;user-select:none}
.hpe-sortable:hover{color:var(--dsw-alias-label-primary)}
/* v0.1.4 direction G: row state color (mounted green / disabled red / failed warn) */
.hpe-table tbody tr[data-state=mounted]{background:var(--dsw-alias-state-success-secondary)}
.hpe-table tbody tr[data-state=disabled]{background:var(--dsw-alias-state-error-secondary)}
.hpe-table tbody tr[data-state=failed]{background:var(--dsw-alias-state-warn-secondary)}
/* v0.1.4 direction H: stronger edge for critical+disabled rows */
.hpe-table tbody tr[data-critical=true][data-state=disabled]{box-shadow:inset 3px 0 0 var(--dsw-alias-state-error-primary)}
`

/** Inject the panel stylesheet once (idempotent). */
export function injectPanelCss(): void {
  if (typeof document === 'undefined') return
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`) !== null) return
  const tag = document.createElement('style')
  tag.dataset.plugin = 'dsh-hotplug-engine'
  tag.dataset.pluginCss = CSS_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

// ── panel mount ─────────────────────────────────────────────────────────────

function conversationColumn(): HTMLElement | undefined {
  const column = document.querySelector(CONVERSATION_COLUMN_SELECTOR)
  return column instanceof HTMLElement ? column : undefined
}

/** Mount the React panel into the conversation column and bind visibility to
 * the controller. Returns the disposer. */
export function mountPanel(controller: PanelController, api: HotplugApi, i18n: I18n): () => void {
  let root: ReturnType<typeof createRoot> | undefined
  let container: HTMLDivElement | undefined
  const ensure = (): void => {
    if (container !== undefined) {
      if (container.isConnected) return
      root?.unmount()
      root = undefined
      container.remove()
      container = undefined
    }
    const column = conversationColumn()
    if (column === undefined) return
    container = document.createElement('div')
    container.dataset.dshHotplugView = ''
    column.appendChild(container)
    root = createRoot(container)
    root.render(<HotplugPanel api={api} onClose={() => controller.close()} i18n={i18n} />)
  }
  const waitObserver = new MutationObserver(() => { ensure() })
  waitObserver.observe(document.body, { childList: true, subtree: true })

  const applyActive = (): void => {
    if (controller.getSnapshot().open) {
      for (const attr of OTHER_ACTIVE_ATTRS) document.documentElement.removeAttribute(attr)
      document.documentElement.setAttribute(ACTIVE_ATTR, '')
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    } else {
      document.documentElement.removeAttribute(ACTIVE_ATTR)
    }
  }
  const onOtherActivate = (event: Event): void => {
    const detail = (event as CustomEvent<string>).detail
    if ((detail === 'ssh' || detail === 'taskboard') && controller.getSnapshot().open) controller.close()
  }
  const SIDEBAR_ROW_SELECTOR = '[class*="sessionRow"], [class*="projectRow"], [class*="searchResultRow"], [class*="searchResultWorkspace"], [class*="newSession"]'
  const onClickSidebarRow = (event: MouseEvent): void => {
    if (!controller.getSnapshot().open) return
    const target = event.target
    if (target instanceof Element && target.closest(SIDEBAR_ROW_SELECTOR) !== null) controller.close()
  }
  document.addEventListener('click', onClickSidebarRow, true)
  document.addEventListener(ACTIVATE_EVENT, onOtherActivate)
  const unsubscribe = controller.subscribe(applyActive)
  applyActive()
  ensure()
  return () => {
    document.removeEventListener('click', onClickSidebarRow, true)
    document.removeEventListener(ACTIVATE_EVENT, onOtherActivate)
    waitObserver.disconnect()
    unsubscribe()
    document.documentElement.removeAttribute(ACTIVE_ATTR)
    root?.unmount()
    root = undefined
    container?.remove()
    container = undefined
  }
}

// ── sidebar entry ───────────────────────────────────────────────────────────

/** Inline icon (matches the shell's 16px nav-icon look). */
const ICON = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 2.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z"/><path d="M2 6h12M6.5 6v8"/></svg>'

function sidebarRoot(): HTMLElement | undefined {
  const column = document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')
  if (column === null) return undefined
  return column.querySelector('[class*="logoRow"]')?.parentElement ?? column.firstElementChild as HTMLElement | undefined
}

function newSessionButton(root: HTMLElement): HTMLButtonElement | undefined {
  const nested = root.querySelector('button[class*="newSession"]')
  if (nested !== null) return nested as HTMLButtonElement
  for (const child of root.children) {
    if (child.tagName === 'BUTTON') return child as HTMLButtonElement
  }
  return undefined
}

/** Build the sidebar entry button (detached; inserted once the shell is up). */
function createEntry(controller: PanelController, i18n: I18n): HTMLButtonElement {
  const entry = document.createElement('button')
  entry.type = 'button'
  entry.dataset.dshHotplugEntry = ''
  entry.className = 'hpe-entry'
  entry.setAttribute('aria-label', i18n.t('panel.title'))
  entry.innerHTML = '<span class="hpe-entryIcon">' + ICON + '</span><span class="hpe-entryLabel"></span>'
  entry.querySelector('.hpe-entryLabel')!.textContent = i18n.t('panel.title')
  entry.addEventListener('click', () => { controller.toggle() })
  return entry
}

/** Insert the entry after the New Session row (before the browser region). */
function placeEntry(root: HTMLElement, entry: HTMLButtonElement): boolean {
  const button = newSessionButton(root)
  if (button === undefined) return false
  if (entry.parentElement !== root) {
    const row = button.closest('[class*="logoRow"]')
    const base = row !== null && row.parentElement === root ? row : button
    const family = Array.from(root.children).filter(el =>
      el instanceof HTMLElement && el.matches('[data-dsh-hotplug-entry], [data-dsh-ssh-entry], [data-dsh-taskboard-entry]'))
    const anchor = family.length > 0 ? family[0] : base.nextElementSibling
    root.insertBefore(entry, anchor)
  }
  return true
}

/** Mount the sidebar entry, waiting for the shell and self-healing on later
 * React re-renders. Returns the disposer. */
export function mountSidebarEntry(controller: PanelController, i18n: I18n): () => void {
  const entry = createEntry(controller, i18n)
  const unsubLocale = i18n.subscribe(() => {
    entry.setAttribute('aria-label', i18n.t('panel.title'))
    const label = entry.querySelector('.hpe-entryLabel')
    if (label !== null) label.textContent = i18n.t('panel.title')
  })
  let root: HTMLElement | undefined
  let placed = false
  let rootObserver: MutationObserver | undefined
  const tryPlace = (): void => {
    if (root !== undefined && !root.isConnected) {
      rootObserver?.disconnect()
      root = undefined
      placed = false
    }
    if (placed) {
      if (document.body.contains(entry)) return
      rootObserver?.disconnect()
      root = undefined
      placed = false
    }
    root ??= sidebarRoot()
    if (root === undefined) return
    placed = placeEntry(root, entry)
    if (placed) {
      rootObserver ??= new MutationObserver(() => {
        if (root === undefined || !root.isConnected) {
          placed = false
          tryPlace()
          return
        }
        if (!root.contains(entry)) placed = placeEntry(root, entry)
      })
      rootObserver.observe(root, { childList: true, subtree: true })
    }
  }
  const waitObserver = new MutationObserver(() => { tryPlace() })
  waitObserver.observe(document.body, { childList: true, subtree: true })
  const unsubscribe = controller.subscribe(() => {
    entry.dataset.active = controller.getSnapshot().open ? 'true' : undefined
  })
  entry.dataset.active = controller.getSnapshot().open ? 'true' : undefined
  tryPlace()
  return () => {
    waitObserver.disconnect()
    rootObserver?.disconnect()
    unsubscribe()
    unsubLocale()
    entry.remove()
  }
}

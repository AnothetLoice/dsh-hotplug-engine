// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { HotplugPanel } from '../src/client/panels.tsx'
import type { HotplugApi } from '../src/client/api.ts'
import type { AuditRecord, EngineEvent, EngineSnapshot, OperationInfo } from '../src/contract/types.ts'

beforeAll(() => {
  // React 18 act() requires the act-environment flag in jsdom.
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

/** Structural fake of the REST/SSE client (the panel only depends on the
 * api surface; fetch/EventSource live behind it). */
class FakeApi {
  calls: Record<string, unknown[]> = {}
  listener: ((event: EngineEvent) => void) | null = null
  readonly snap: EngineSnapshot
  readonly ops: OperationInfo[]
  readonly auditRecords: AuditRecord[]

  constructor() {
    this.snap = {
      profile: 'web',
      mode: 'hot',
      entries: [
        { entryId: 'row-a', moduleName: 'pkg-a', source: 'insert', enabled: true, patchTargetable: true, fiberPhase: 'active', managed: true },
        { entryId: 'row-b', moduleName: 'pkg-b', source: 'user', enabled: true, patchTargetable: false, fiberPhase: null, managed: false },
      ],
      packages: [
        { name: 'pkg-a', isBundle: false, version: '1.0.0' },
        { name: 'pkg-b', isBundle: true, version: '2.0.0' },
      ],
      insertRows: [{ id: 'row-a', name: 'pkg-a', managed: true }],
    }
    this.ops = [{ operationId: 'op-1', op: 'install', status: 'succeeded', target: 'pkg-a', result: { ok: true, message: 'ok', rollbackHandle: 'op-1' } }]
    this.auditRecords = [{ ts: '2026-08-14T00:00:00Z', operationId: 'op-1', op: 'install', mode: 'hot', result: 'succeeded', caller: 'tool' }]
  }

  async snapshot(): Promise<EngineSnapshot> {
    this.record('snapshot')
    return this.snap
  }

  async operations(): Promise<OperationInfo[]> {
    this.record('operations')
    return this.ops
  }

  async audit(): Promise<AuditRecord[]> {
    this.record('audit')
    return this.auditRecords
  }

  async enable(entryId: string): Promise<{ ok: boolean; message: string }> {
    this.record('enable', entryId)
    return { ok: true, message: `enable ${entryId}` }
  }

  async disable(entryId: string): Promise<{ ok: boolean; message: string }> {
    this.record('disable', entryId)
    return { ok: true, message: `disable ${entryId}` }
  }

  async rollback(handle: string): Promise<{ ok: boolean; message: string }> {
    this.record('rollback', handle)
    return { ok: true, message: `rollback ${handle}` }
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    this.listener = listener
    return () => { this.listener = null }
  }

  private record(name: string, value?: unknown): void {
    const list = this.calls[name] ?? []
    list.push(value)
    this.calls[name] = list
  }
}

let root: Root | undefined
let container: HTMLDivElement | undefined

async function renderPanel(api: HotplugApi): Promise<void> {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root!.render(<HotplugPanel api={api} onClose={() => {}} />)
  })
  await act(async () => {}) // flush the effect chain (initial refresh)
}

afterEach(() => {
  if (root !== undefined) {
    act(() => { root!.unmount() })
    root = undefined
  }
  container?.remove()
  container = undefined
  document.body.innerHTML = ''
})

describe('client: HotplugPanel minimal management UI', () => {
  it('renders the three list views from the snapshot and never offers spec input', async () => {
    const api = new FakeApi() as unknown as HotplugApi
    await renderPanel(api)
    const text = container!.textContent ?? ''
    expect(text).toContain('热插拔引擎')
    expect(text).toContain('模式:hot')
    // entries view: two rows, only the patch-targetable one gets a button
    const rows = container!.querySelectorAll('tbody tr')
    expect(rows.length).toBe(2)
    const buttons = container!.querySelectorAll('.hpe-btn')
    expect(buttons.length).toBe(1)
    expect(text).toContain('随机id不可定位')
    // Non-Goal guard: NO spec input, NO install UI, no text field at all
    // (the footer's 安装/卸载 wording is the mechanism hint, not an input).
    expect(container!.querySelector('input')).toBeNull()
    expect(container!.querySelector('textarea')).toBeNull()
    expect(container!.querySelector('button.hpe-install')).toBeNull()
  })

  it('toggles an entry through the REST surface', async () => {
    const api = new FakeApi() as unknown as HotplugApi
    await renderPanel(api)
    const button = container!.querySelector('.hpe-btn') as HTMLButtonElement
    expect(button.textContent).toBe('停用')
    await act(async () => { button.click() })
    expect((api as unknown as FakeApi).calls['disable']).toEqual(['row-a'])
  })

  it('lists operations and rolls back by handle', async () => {
    const api = new FakeApi() as unknown as HotplugApi
    await renderPanel(api)
    const tab = [...container!.querySelectorAll('.hpe-tab')].find(t => t.textContent === '操作') as HTMLButtonElement
    await act(async () => { tab.click() })
    expect(container!.textContent).toContain('op-1')
    const rollbackButton = [...container!.querySelectorAll('.hpe-btn')].find(b => b.textContent === '回滚') as HTMLButtonElement
    expect(rollbackButton).toBeDefined()
    await act(async () => { rollbackButton.click() })
    expect((api as unknown as FakeApi).calls['rollback']).toEqual(['op-1'])
  })

  it('shows the audit trail', async () => {
    const api = new FakeApi() as unknown as HotplugApi
    await renderPanel(api)
    const tab = [...container!.querySelectorAll('.hpe-tab')].find(t => t.textContent === '审计') as HTMLButtonElement
    await act(async () => { tab.click() })
    const text = container!.textContent ?? ''
    expect(text).toContain('2026-08-14T00:00:00Z'.slice(0, 19))
    expect(text).toContain('install')
    expect(text).toContain('succeeded')
  })

  it('refreshes from the SSE stream (snapshot frame triggers a refetch)', async () => {
    const fake = new FakeApi()
    const api = fake as unknown as HotplugApi
    await renderPanel(api)
    const before = fake.calls['snapshot']?.length ?? 0
    expect(fake.listener).not.toBeNull()
    await act(async () => {
      fake.listener!({ type: 'operation', operationId: 'op-2', op: 'enable', status: 'succeeded', ts: '2026-08-14T00:00:03Z' })
    })
    await act(async () => {})
    expect((fake.calls['snapshot']?.length ?? 0)).toBeGreaterThan(before)
  })

  it('decodes the service-side HTML-escaped error text in the UI (no double-escape)', async () => {
    const fake = new FakeApi()
    fake.disable = async () => ({ ok: false, message: '拒绝:&lt;script&gt;x&lt;/script&gt;' })
    const api = fake as unknown as HotplugApi
    await renderPanel(api)
    const button = container!.querySelector('.hpe-btn') as HTMLButtonElement
    await act(async () => { button.click() })
    const error = container!.querySelector('.hpe-error')
    expect(error).not.toBeNull()
    expect(error!.textContent).toContain('<script>x</script>')
    expect(error!.textContent).not.toContain('&lt;')
  })
})

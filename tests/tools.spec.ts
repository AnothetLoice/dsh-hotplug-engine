import { describe, expect, it, vi } from 'vitest'
import { HOTPLUG_WRITE_TOOLS, MECHANISM_NOTE, makePreExecuteGate, makeTools, type ToolService } from '../src/host/tools.ts'
import type { PreToolDecision } from '@deepseek-ai/dsh-tools'
import type { AuditRecord, EngineSnapshot, MutationResult, RuntimeEntry } from '../src/contract/types.ts'

/** Minimal run-context for direct execute() calls. */
const fakeExec = undefined as never

const SNAP: EngineSnapshot = {
  profile: 'web', mode: 'hot',
  entries: [{ entryId: 'row-a', moduleName: 'pkg-x', source: 'insert', enabled: true, patchTargetable: true, fiberPhase: 'active', managed: true, critical: true }],
  packages: [{ name: 'pkg-x', isBundle: false, version: '1.0.0', installedAt: '2026-08-16T00:00:00.000Z' }],
  insertRows: [{ id: 'row-a', name: 'pkg-x', managed: true }],
}

function makeService(overrides: Partial<ToolService> = {}): ToolService {
  const calls: Record<string, unknown[]> = {}
  const service: ToolService = {
    snapshot: () => SNAP,
    status: (entryId) => (entryId === 'row-a' ? SNAP.entries[0] : undefined),
    install: async (spec, opts) => {
      calls['install'] = [...(calls['install'] ?? []), { spec, opts }]
      return { ok: true, message: `install ${spec}`, operationId: 'op-1', rollbackHandle: 'op-1' }
    },
    uninstall: async (name, opts) => {
      calls['uninstall'] = [...(calls['uninstall'] ?? []), { name, opts }]
      return { ok: true, message: `uninstall ${name}`, operationId: 'op-2' }
    },
    enable: async (entryId, opts) => {
      calls['enable'] = [...(calls['enable'] ?? []), { entryId, opts }]
      return { ok: true, message: `enable ${entryId}`, operationId: 'op-3' }
    },
    disable: async (entryId, opts) => {
      calls['disable'] = [...(calls['disable'] ?? []), { entryId, opts }]
      return { ok: true, message: `disable ${entryId}`, operationId: 'op-4' }
    },
    rollback: async (handle, opts) => {
      calls['rollback'] = [...(calls['rollback'] ?? []), { handle, opts }]
      return { ok: true, message: `rollback ${handle}`, operationId: 'op-5' }
    },
    audit: (query) => {
      calls['audit'] = [...(calls['audit'] ?? []), query]
      return [{ ts: '2026-08-14T00:00:00Z', operationId: 'op-1', op: 'install', mode: 'hot', result: 'succeeded', caller: 'tool' } as AuditRecord]
    },
    ...overrides,
  }
  return Object.assign(service, { calls })
}

function callsOf(service: ToolService): Record<string, unknown[]> {
  return (service as unknown as { calls: Record<string, unknown[]> }).calls
}

const TOOL_NAMES = ['hotplug_status', 'hotplug_install', 'hotplug_uninstall', 'hotplug_toggle', 'hotplug_rollback', 'hotplug_audit'] as const

describe('tools: registration shape', () => {
  it('exposes exactly the six hotplug_* tools', () => {
    const tools = makeTools(makeService())
    expect(tools.map(t => t.name).sort()).toEqual([...TOOL_NAMES].sort())
  })

  it('classifies the four write tools and two read tools', () => {
    expect(HOTPLUG_WRITE_TOOLS).toEqual(new Set(['hotplug_install', 'hotplug_uninstall', 'hotplug_toggle', 'hotplug_rollback']))
    for (const name of HOTPLUG_WRITE_TOOLS) expect(TOOL_NAMES).toContain(name)
    expect(HOTPLUG_WRITE_TOOLS.has('hotplug_status')).toBe(false)
    expect(HOTPLUG_WRITE_TOOLS.has('hotplug_audit')).toBe(false)
  })

  it('declares required parameters for write tools', () => {
    const tools = makeTools(makeService())
    const requiredOf = (name: string): string[] => {
      const tool = tools.find(t => t.name === name)!
      return (tool.parameters as { required?: string[] }).required ?? []
    }
    expect(requiredOf('hotplug_install')).toContain('spec')
    expect(requiredOf('hotplug_toggle')).toContain('entryId')
    expect(requiredOf('hotplug_rollback')).toContain('handle')
    expect(requiredOf('hotplug_uninstall')).toContain('name')
  })

  it('descriptions carry the refresh/restart mechanism hints', () => {
    const tools = makeTools(makeService())
    for (const tool of tools) {
      expect(tool.description, tool.name).toContain('刷新页面')
      expect(tool.description, tool.name).toContain('重启')
      expect(tool.description, tool.name).toContain(MECHANISM_NOTE)
    }
  })
})

describe('tools: approval gate', () => {
  it('asks for write tools and passes read tools through', async () => {
    const gate = makePreExecuteGate('需要审批')
    const next = vi.fn(async (): Promise<PreToolDecision> => ({ kind: 'allow' }))
    for (const name of HOTPLUG_WRITE_TOOLS) {
      const decision = await gate({ name } as never, next)
      expect(decision.kind, name).toBe('ask')
      expect(next).not.toHaveBeenCalled()
    }
    const readDecision = await gate({ name: 'hotplug_status' } as never, next)
    expect(readDecision.kind).toBe('allow')
    expect(next).toHaveBeenCalledTimes(1)
  })
})

describe('tools: execute paths share the service', () => {
  it('hotplug_status returns the entry for one entryId', async () => {
    const service = makeService()
    const tool = makeTools(service).find(t => t.name === 'hotplug_status')!
    const result = await tool.execute({ entryId: 'row-a' }, fakeExec) as { entry: RuntimeEntry | null; snapshot: EngineSnapshot | null }
    expect(result.entry?.entryId).toBe('row-a')
    expect(result.snapshot).toBeNull()
  })

  it('hotplug_status returns the full snapshot without entryId', async () => {
    const tool = makeTools(makeService()).find(t => t.name === 'hotplug_status')!
    const result = await tool.execute({}, fakeExec) as { entry: RuntimeEntry | null; snapshot: EngineSnapshot | null }
    expect(result.entry).toBeNull()
    expect(result.snapshot?.entries.length).toBe(1)
  })

  it('hotplug_install passes spec/profile/dryRun/caller through', async () => {
    const service = makeService()
    const tool = makeTools(service).find(t => t.name === 'hotplug_install')!
    await tool.execute({ spec: 'pkg-x', dryRun: true }, fakeExec)
    expect(callsOf(service)['install']).toEqual([{ spec: 'pkg-x', opts: { profile: undefined, dryRun: true, caller: 'tool' } }])
  })

  it('hotplug_toggle disables when enabled=false is requested', async () => {
    const service = makeService()
    const tool = makeTools(service).find(t => t.name === 'hotplug_toggle')!
    await tool.execute({ entryId: 'row-a', enabled: false }, fakeExec)
    expect(callsOf(service)['disable']).toEqual([{ entryId: 'row-a', opts: { profile: undefined, caller: 'tool' } }])
  })

  it('hotplug_toggle inverts the current state when enabled is omitted', async () => {
    const service = makeService() // current state: enabled=true → toggle → disable
    const tool = makeTools(service).find(t => t.name === 'hotplug_toggle')!
    await tool.execute({ entryId: 'row-a' }, fakeExec)
    expect(callsOf(service)['disable']).toEqual([{ entryId: 'row-a', opts: { profile: undefined, caller: 'tool' } }])
  })

  it('hotplug_toggle enables when enabled=true (or current is disabled)', async () => {
    const service = makeService({ snapshot: () => ({ ...SNAP, entries: [{ ...SNAP.entries[0], enabled: false }] }) })
    const tool = makeTools(service).find(t => t.name === 'hotplug_toggle')!
    await tool.execute({ entryId: 'row-a' }, fakeExec) // current disabled → enable
    expect(callsOf(service)['enable']).toEqual([{ entryId: 'row-a', opts: { profile: undefined, caller: 'tool' } }])
  })

  it('hotplug_rollback and hotplug_uninstall forward their arguments with caller tool', async () => {
    const service = makeService()
    const tools = makeTools(service)
    await tools.find(t => t.name === 'hotplug_rollback')!.execute({ handle: 'op-1' }, fakeExec)
    await tools.find(t => t.name === 'hotplug_uninstall')!.execute({ name: 'pkg-x' }, fakeExec)
    expect(callsOf(service)['rollback']).toEqual([{ handle: 'op-1', opts: { profile: undefined, caller: 'tool' } }])
    expect(callsOf(service)['uninstall']).toEqual([{ name: 'pkg-x', opts: { profile: undefined, caller: 'tool' } }])
  })

  it('hotplug_audit passes filters and reports count', async () => {
    const service = makeService()
    const tool = makeTools(service).find(t => t.name === 'hotplug_audit')!
    const result = await tool.execute({ op: 'install', limit: 10 }, fakeExec) as { count: number; records: AuditRecord[] }
    expect(callsOf(service)['audit']).toEqual([{ op: 'install', from: undefined, limit: 10 }])
    expect(result.count).toBe(1)
    expect(result.records[0].caller).toBe('tool')
  })

  it('mutation tools return MutationResult envelopes', async () => {
    const tool = makeTools(makeService()).find(t => t.name === 'hotplug_install')!
    const result = await tool.execute({ spec: 'pkg-x' }, fakeExec) as MutationResult
    expect(result.ok).toBe(true)
    expect(result.operationId).toBe('op-1')
  })
})

describe('tools: v0.1.4 schema + render regression', () => {
  it('renderMutation outputs operationId/rollbackHandle/errors[].stage (P1-1/P0-2)', () => {
    const tool = makeTools(makeService()).find(t => t.name === 'hotplug_install')!
    const render = tool.output.render as (args: unknown, value: MutationResult) => { type: 'text'; text: string }[]
    const blocks = render({}, { ok: false, message: 'fail', operationId: 'op-1', rollbackHandle: 'op-1', errors: [{ code: 'HOTPLUG.PNPM_ADD_FAILED', detail: 'd', stage: 'install' }] })
    const text = blocks.map(b => b.text).join('\n')
    expect(text).toContain('operationId: op-1')
    expect(text).toContain('rollbackHandle: op-1')
    expect(text).toContain('error[HOTPLUG.PNPM_ADD_FAILED](install): d')
  })

  it('hotplug_status render shows critical marker (P0-1)', () => {
    const tool = makeTools(makeService()).find(t => t.name === 'hotplug_status')!
    const render = tool.output.render as (args: unknown, value: { profile: string; mode: string; entry: RuntimeEntry | null; snapshot: EngineSnapshot | null }) => { type: 'text'; text: string }[]
    const blocks = render({}, { profile: 'web', mode: 'hot', entry: SNAP.entries[0], snapshot: null })
    expect(blocks[0].text).toContain('critical')
  })

  it('hotplug_status snapshot schema carries critical/installedAt (P0-1)', async () => {
    const tool = makeTools(makeService()).find(t => t.name === 'hotplug_status')!
    const result = await tool.execute({}, fakeExec) as { snapshot: EngineSnapshot | null }
    expect(result.snapshot?.entries[0].critical).toBe(true)
    expect(result.snapshot?.packages[0].installedAt).toBe('2026-08-16T00:00:00.000Z')
  })

  it('hotplug_status snapshot render lists package details incl. installedAt', () => {
    const tool = makeTools(makeService()).find(t => t.name === 'hotplug_status')!
    const render = tool.output.render as (args: unknown, value: { profile: string; mode: string; entry: RuntimeEntry | null; snapshot: EngineSnapshot | null }) => { type: 'text'; text: string }[]
    const blocks = render({}, { profile: 'web', mode: 'hot', entry: null, snapshot: SNAP })
    const text = blocks.map(b => b.text).join('\n')
    expect(text).toContain('pkg-x v1.0.0')
    expect(text).toContain('installedAt=2026-08-16T00:00:00.000Z')
  })

  it('hotplug_audit render includes the note column (v0.1.5)', () => {
    const tool = makeTools(makeService()).find(t => t.name === 'hotplug_audit')!
    const render = tool.output.render as (args: unknown, value: { count: number; records: AuditRecord[] }) => { type: 'text'; text: string }[]
    const rec: AuditRecord = { ts: '2026-08-16T00:00:00Z', operationId: 'op-1', op: 'install', mode: 'restart', result: 'succeeded', caller: 'tool', note: '未在 loader 生效' }
    const blocks = render({}, { count: 1, records: [rec] })
    const text = blocks.map(b => b.text).join('\n')
    expect(text).toContain('note')
    expect(text).toContain('未在 loader 生效')
  })
})

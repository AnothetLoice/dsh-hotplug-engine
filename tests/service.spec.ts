import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { HotplugEngineService } from '../src/host/service.ts'
import { readInsertRows } from '../src/host/patch.ts'
import { ErrorCodes } from '../src/contract/types.ts'
import type { FiberPhase, LoaderLike } from '../src/host/health.ts'

const PATCH_INIT = [
  '# test profile patch',
  '# dsh-hotplug-engine:managed:start',
  '- insert:',
  "    - id: hotplug-drill",
  "      name: '@dsh-drill/hotplug-drill'",
  '# dsh-hotplug-engine:managed:end',
  '- id: row-a',
  '  config:',
  '    x: 1',
  '',
].join('\n')

function nameOf(id: string): string {
  switch (id) {
    case 'row-a': return 'pkg-row-a'
    case 'ui-task-board': return '@linxin666/dsh-client-ui-task-board'
    case 'hotplug-drill': return '@dsh-drill/hotplug-drill'
    default: return `pkg-${id}`
  }
}

function stateOf(phase: FiberPhase): number | undefined {
  switch (phase) {
    case 'pending': return 0
    case 'loading': return 1
    case 'active': return 2
    case 'failed': return 3
    default: return undefined
  }
}

interface RowState { disabled: boolean; phase: FiberPhase }

function makeLoader(states: Map<string, RowState>): LoaderLike {
  return {
    entries: () => [{
      id: 'include',
      subtree: {
        entries: () => [...states.entries()].map(([id, s]) => ({
          options: { id, name: nameOf(id), group: false },
          get disabled() { return states.get(id)!.disabled },
          get fiber() {
            const phase = states.get(id)!.phase
            return phase === null || phase === undefined ? undefined : { state: stateOf(phase) }
          },
        })),
      },
    }],
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function setup(): { svc: HotplugEngineService; states: Map<string, RowState>; patchPath: string; dshHome: string } {
  const dshHome = mkdtempSync(join(tmpdir(), 'hpe-svc-'))
  const profileDir = join(dshHome, 'profiles', 'web')
  mkdirSync(profileDir, { recursive: true })
  const patchPath = join(profileDir, 'cordis.patch.yml')
  writeFileSync(patchPath, PATCH_INIT, 'utf8')
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-web',
    private: true,
    dependencies: {
      '@dsh-drill/hotplug-drill': 'link:../hotplug-drill',
      '@linxin666/dsh-web-ui-all': '^0.1.7',
    },
    dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app',
      '@linxin666/dsh-web-ui-all', '@linxin666/dsh-client-ui-task-board',
    ] } },
  }, undefined, 2) + '\n', 'utf8')
  const states = new Map<string, RowState>([
    ['row-a', { disabled: false, phase: 'active' }],
    ['ui-task-board', { disabled: false, phase: 'active' }],
    ['hotplug-drill', { disabled: false, phase: 'active' }],
    ['hotplug-engine', { disabled: false, phase: 'active' }],
  ])
  const ctx = new Context()
  ctx.provide('loader', makeLoader(states))
  const svc = new HotplugEngineService(ctx, {
    dshHomePath: dshHome,
    hostProfile: 'web',
    observationWindowMs: 1500,
    pollIntervalMs: 40,
    phasePollMs: 40,
  })
  return { svc, states, patchPath, dshHome }
}

describe('service: mode and snapshot', () => {
  it('runs in restart mode without an hmr service (contract §9.1)', () => {
    const { svc } = setup()
    expect(svc.mode).toBe('restart')
  })

  it('reports restartRequired in restart mode (contract §9.2 two-axis)', async () => {
    const { svc, states } = setup()
    const p = svc.disable('row-a')
    await sleep(150)
    states.set('row-a', { disabled: true, phase: null })
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('restart')
    expect(r.restartRequired).toBe(true)
  })

  it('snapshot projects the official tree with source classification', () => {
    const { svc } = setup()
    const snap = svc.snapshot()
    expect(snap.profile).toBe('web')
    expect(snap.mode).toBe('restart')
    const byId = new Map(snap.entries.map(e => [e.entryId, e]))
    expect(byId.get('row-a')?.source).toBe('user')
    expect(byId.get('row-a')?.enabled).toBe(true)
    expect(byId.get('row-a')?.patchTargetable).toBe(true)
    expect(byId.get('ui-task-board')?.source).toBe('bundle')
    expect(byId.get('hotplug-drill')?.patchTargetable).toBe(true)
  })

  it('status returns a single row', () => {
    const { svc } = setup()
    expect(svc.status('row-a')?.moduleName).toBe('pkg-row-a')
    expect(svc.status('nope')).toBeUndefined()
  })

  it('rejects a missing profile with NOT_FOUND (M4 multi-profile semantics)', async () => {
    const { svc } = setup()
    const r = await svc.disable('row-a', { profile: 'nope' })
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.PROFILE_NOT_FOUND)
  })

  it('rejects official profiles other than the host with PROTECTED (ADR-0007)', async () => {
    const { svc } = setup()
    const r = await svc.disable('row-a', { profile: 'headless' })
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.PROFILE_PROTECTED)
  })

  it('manages a non-host, non-official profile (M4 multi-profile, file/restart semantics)', async () => {
    const { svc, dshHome } = setup()
    // create a second profile whose patch HAS row-a as a managed insert row
    const tuiDir = join(dshHome, 'profiles', 'tui')
    mkdirSync(tuiDir, { recursive: true })
    writeFileSync(join(tuiDir, 'cordis.patch.yml'), [
      '# tui profile patch',
      '# dsh-hotplug-engine:managed:start',
      '- insert:',
      '    - id: row-a',
      "      name: 'pkg-row-a'",
      '# dsh-hotplug-engine:managed:end',
      '',
    ].join('\n'), 'utf8')
    writeFileSync(join(tuiDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-tui', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
    }), 'utf8')
    // snapshot projects the tui profile from its files (no loader/fiber);
    // non-host mode is 'restart' (M4 freeze arch review M3)
    const snap = svc.snapshot('tui')
    expect(snap.profile).toBe('tui')
    expect(snap.mode).toBe('restart')
    expect(snap.entries.some(e => e.entryId === 'row-a' && e.source === 'insert')).toBe(true)
    expect(snap.entries.find(e => e.entryId === 'row-a')?.fiberPhase).toBeNull()
    // disable on a row present in the tui patch: file-only, restart-required
    const r = await svc.disable('row-a', { profile: 'tui' })
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('restart')
    expect(r.restartRequired).toBe(true)
    expect(readFileSync(join(tuiDir, 'cordis.patch.yml'), 'utf8')).toContain('disabled: true')
    // enable it back (idempotent file write)
    const e = await svc.enable('row-a', { profile: 'tui' })
    expect(e.ok).toBe(true)
    expect(e.mode).toBe('restart')
    // a row NOT in the tui patch is rejected
    const missing = await svc.disable('row-zz', { profile: 'tui' })
    expect(missing.ok).toBe(false)
    expect(missing.errors?.[0]?.code).toBe(ErrorCodes.PATCH_UNSAFE_TARGET)
  })

  it('self-protects: cannot uninstall the engine from its host profile (ADR-0007)', async () => {
    const { svc } = setup()
    const r = await svc.uninstall('dsh-hotplug-engine')
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.PROFILE_PROTECTED)
  })

  it('self-protects: cannot enable/disable the engine\'s own row on the host profile (M4 freeze M1)', async () => {
    const { svc } = setup()
    const d = await svc.disable('hotplug-engine')
    expect(d.ok).toBe(false)
    expect(d.errors?.[0]?.code).toBe(ErrorCodes.PROFILE_PROTECTED)
    const e = await svc.enable('hotplug-engine')
    expect(e.ok).toBe(false)
    expect(e.errors?.[0]?.code).toBe(ErrorCodes.PROFILE_PROTECTED)
  })
})

describe('service: enable/disable user rows', () => {
  it('disable writes disabled:true into the user row (applied, not queued)', async () => {
    const { svc, states, patchPath } = setup()
    const p = svc.disable('row-a')
    await sleep(150)
    states.set('row-a', { disabled: true, phase: null }) // HMR replay simulated
    const r = await p
    expect(r.ok).toBe(true)
    expect(r.operationId).toBeTruthy()
    expect(r.rollbackHandle).toBe(r.operationId)
    expect(r.mode).toBe('restart')
    const patch = readFileSync(patchPath, 'utf8')
    expect(patch).toContain('- id: row-a')
    expect(patch).toContain('disabled: true')
  })

  it('enable removes the disabled flag', async () => {
    const { svc, states, patchPath } = setup()
    const d = svc.disable('row-a')
    await sleep(150)
    states.set('row-a', { disabled: true, phase: null })
    await d
    const e = svc.enable('row-a')
    await sleep(150)
    states.set('row-a', { disabled: false, phase: 'active' })
    const r = await e
    expect(r.ok).toBe(true)
    expect(readFileSync(patchPath, 'utf8')).not.toContain('disabled:')
  })

  it('disable of an insert row adds a managed disable block', async () => {
    const { svc, states, patchPath } = setup()
    const p = svc.disable('hotplug-drill')
    await sleep(150)
    states.set('hotplug-drill', { disabled: true, phase: null })
    const r = await p
    expect(r.ok).toBe(true)
    const patch = readFileSync(patchPath, 'utf8')
    expect(patch).toContain('# dsh-hotplug-engine:managed:start')
    expect(patch).toContain('- id: hotplug-drill')
    expect(patch).toContain('disabled: true')
    // the insert row itself is untouched
    expect(readInsertRows(patch).find(row => row.id === 'hotplug-drill')?.name).toBe('@dsh-drill/hotplug-drill')
  })

  it('enable removes the managed disable block', async () => {
    const { svc, states, patchPath } = setup()
    const d = svc.disable('hotplug-drill')
    await sleep(150)
    states.set('hotplug-drill', { disabled: true, phase: null })
    await d
    const e = svc.enable('hotplug-drill')
    await sleep(150)
    states.set('hotplug-drill', { disabled: false, phase: 'active' })
    const r = await e
    expect(r.ok).toBe(true)
    // the disable block is gone; the (still-managed) insert block remains
    expect(readFileSync(patchPath, 'utf8')).not.toContain('disabled:')
  })

  it('is idempotent: disabling an already-disabled row is a no-op success', async () => {
    const { svc, states } = setup()
    const d = svc.disable('row-a')
    await sleep(150)
    states.set('row-a', { disabled: true, phase: null })
    await d
    // second disable: no file change, still ok
    const r2 = await svc.disable('row-a')
    expect(r2.ok).toBe(true)
  })
})

describe('service: target validation', () => {
  it('rejects loader-random (non-patch-targetable) ids', async () => {
    const { svc } = setup()
    const r = await svc.disable('a1b2c3d4')
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.PATCH_UNSAFE_TARGET)
  })

  it('rejects unknown entries', async () => {
    const { svc } = setup()
    const r = await svc.disable('nope')
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.PATCH_UNSAFE_TARGET)
  })
})

describe('service: serial queue conflict', () => {
  it('returns OP_CONFLICT for the same row while queued', async () => {
    const { svc, states } = setup()
    const p1 = svc.disable('row-a')
    const r2 = await svc.disable('row-a')
    expect(r2.ok).toBe(false)
    expect(r2.errors?.[0]?.code).toBe(ErrorCodes.OP_CONFLICT)
    await sleep(150)
    states.set('row-a', { disabled: true, phase: null })
    await p1
  })
})

describe('service: rollback', () => {
  it('rollback restores the patch to its pre-operation state', async () => {
    const { svc, states, patchPath } = setup()
    const before = readFileSync(patchPath, 'utf8')
    const d = svc.disable('row-a')
    await sleep(150)
    states.set('row-a', { disabled: true, phase: null })
    const dr = await d
    expect(dr.ok).toBe(true)
    expect(readFileSync(patchPath, 'utf8')).not.toBe(before)
    const rb = svc.rollback(dr.rollbackHandle!)
    await sleep(150)
    const rr = await rb
    expect(rr.ok).toBe(true)
    expect(readFileSync(patchPath, 'utf8')).toBe(before)
  })

  it('rollback with an unknown (but format-valid) handle fails with ROLLBACK_NOT_FOUND', async () => {
    const { svc } = setup()
    const r = await svc.rollback('op-999999-1')
    expect(r.ok).toBe(false)
    expect(r.errors?.[0]?.code).toBe(ErrorCodes.ROLLBACK_NOT_FOUND)
  })

  // M5 H2: external handles must match op-<ts>-<seq> before touching the fs.
  it('rejects a path-traversal handle with ROLLBACK_INVALID', async () => {
    const { svc } = setup()
    for (const bad of ['../x', 'op-1/../../x', 'op-1/..', 'C:/evil', 'a/b', 'op-x']) {
      const r = await svc.rollback(bad)
      expect(r.ok, JSON.stringify(bad)).toBe(false)
      expect(r.errors?.[0]?.code, JSON.stringify(bad)).toBe(ErrorCodes.ROLLBACK_INVALID)
    }
  })

  it('still rolls back a valid-format handle (format gate does not break legit ids)', async () => {
    const { svc, states, patchPath } = setup()
    const before = readFileSync(patchPath, 'utf8')
    const d = svc.disable('row-a')
    await sleep(150)
    states.set('row-a', { disabled: true, phase: null })
    const dr = await d
    expect(dr.ok).toBe(true)
    const rb = svc.rollback(dr.rollbackHandle!)
    await sleep(150)
    const rr = await rb
    expect(rr.ok).toBe(true)
    expect(readFileSync(patchPath, 'utf8')).toBe(before)
  })
})

describe('service: operation tracking', () => {
  it('listOperations records finished operations with status', async () => {
    const { svc, states } = setup()
    const p = svc.disable('row-a')
    await sleep(150)
    states.set('row-a', { disabled: true, phase: null })
    const r = await p
    expect(r.ok).toBe(true)
    const ops = svc.listOperations()
    const op = ops.find(o => o.operationId === r.operationId)
    expect(op?.status).toBe('succeeded')
    expect(op?.target).toBe('row-a')
    expect(op?.finishedAt).toBeTruthy()
    expect(op?.result?.ok).toBe(true)
  })
})

describe('service: audit trail', () => {
  it('writes audit records for succeeded operations', async () => {
    const { svc, states, dshHome } = setup()
    const p = svc.disable('row-a')
    await sleep(150)
    states.set('row-a', { disabled: true, phase: null })
    await p
    const records = svc.audit({ op: 'disable' })
    expect(records.length).toBeGreaterThan(0)
    expect(records[0]!.result).toBe('succeeded')
    expect(records[0]!.caller).toBe('service')
    expect(records[0]!.patchBeforeHash).toBeTruthy()
    const logDir = join(dshHome, 'logs', 'hotplug-engine')
    const { existsSync, readdirSync } = await import('node:fs')
    expect(existsSync(logDir)).toBe(true)
    expect(readdirSync(logDir).some(name => name.endsWith('.jsonl'))).toBe(true)
  })

  it('records the transport caller (rest/tool) in audit (contract §3 caller 三值可达)', async () => {
    const { svc, states } = setup()
    // enable row-a twice: once via a tool caller, once via the default
    const first = svc.enable('row-a', { caller: 'tool' })
    await sleep(150)
    states.set('row-a', { disabled: false, phase: 'active' })
    await first
    const second = svc.enable('row-a') // no-op? no — applyEnable is idempotent but still audits
    await sleep(150)
    await second
    const records = svc.audit({ op: 'enable' })
    expect(records.some(r => r.caller === 'tool')).toBe(true)
    expect(records.some(r => r.caller === 'service')).toBe(true)
    expect(records.some(r => r.caller === 'rest')).toBe(false)
  })
})

describe('service: entry-phase events (contract §7)', () => {
  it('does not emit entry events for unchanged phases (seed scan is silent)', async () => {
    const { svc } = setup()
    const events: unknown[] = []
    svc.onEvent(e => events.push(e))
    await sleep(150)
    expect(events.filter(e => (e as { type: string }).type === 'entry')).toEqual([])
  })

  it('emits an entry event when a managed row phase changes', async () => {
    const { svc, states } = setup()
    const events: unknown[] = []
    svc.onEvent(e => events.push(e))
    states.set('hotplug-drill', { disabled: false, phase: 'loading' })
    await sleep(150)
    const entry = events.find(e =>
      (e as { type: string }).type === 'entry'
      && (e as { entryId: string }).entryId === 'hotplug-drill'
      && (e as { phase: string }).phase === 'loading')
    expect(entry).toBeDefined()
  })

  it('emits a null-phase entry event when a managed row unmounts', async () => {
    const { svc, states } = setup()
    const events: unknown[] = []
    svc.onEvent(e => events.push(e))
    states.delete('hotplug-drill')
    await sleep(150)
    const entry = events.find(e =>
      (e as { type: string }).type === 'entry'
      && (e as { entryId: string }).entryId === 'hotplug-drill'
      && (e as { phase: unknown }).phase === null)
    expect(entry).toBeDefined()
  })

  it('does NOT emit entry events for user (non-managed) rows (contract §7 被管理条目)', async () => {
    const { svc, states } = setup()
    const events: unknown[] = []
    svc.onEvent(e => events.push(e))
    states.set('row-a', { disabled: false, phase: 'loading' })
    await sleep(150)
    const entry = events.find(e =>
      (e as { type: string }).type === 'entry'
      && (e as { entryId: string }).entryId === 'row-a')
    expect(entry).toBeUndefined()
  })
})

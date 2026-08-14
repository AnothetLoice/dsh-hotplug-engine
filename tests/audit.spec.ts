import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuditLog } from '../src/host/audit.ts'
import type { AuditRecord } from '../src/contract/types.ts'

function makeRecord(overrides: Partial<AuditRecord> = {}): AuditRecord {
  return {
    ts: '2026-08-14T00:00:00.000Z',
    operationId: 'op-1',
    op: 'install',
    target: 'pkg-x',
    mode: 'hot',
    result: 'succeeded',
    caller: 'service',
    patchBeforeHash: 'abc123',
    ...overrides,
  }
}

describe('audit: JSONL structure', () => {
  it('appends one JSONL line per record and round-trips the fields', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-audit-'))
    const log = new AuditLog(dir)
    const record = makeRecord({ op: 'disable', result: 'failed', errorCode: 'HOTPLUG.HEALTH.FAILED', spec: 'pkg-y' })
    log.append(record)
    const file = join(dir, '2026-08-14.jsonl')
    expect(existsSync(file)).toBe(true)
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    expect(lines.length).toBe(1)
    const parsed = JSON.parse(lines[0]!) as AuditRecord
    expect(parsed).toEqual(record)
  })

  it('keeps query filters working across multiple records', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-audit-'))
    const log = new AuditLog(dir)
    log.append(makeRecord({ ts: '2026-08-14T00:00:00Z', op: 'install', target: 'a' }))
    log.append(makeRecord({ ts: '2026-08-14T00:01:00Z', op: 'disable', target: 'b' }))
    log.append(makeRecord({ ts: '2026-08-15T00:00:00Z', op: 'enable', target: 'c' }))
    expect(log.query({ op: 'disable' })).toHaveLength(1)
    expect(log.query({ from: '2026-08-15T00:00:00Z' })).toHaveLength(1)
    expect(log.query({ limit: 2 })).toHaveLength(2)
    expect(log.query()).toHaveLength(3)
  })

  it('skips malformed (non-JSON) lines without failing the query', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-audit-'))
    // "not-json" is unparseable → skipped; the record parses → counted
    writeFileSync(join(dir, '2026-08-14.jsonl'), 'not-json\n' + JSON.stringify(makeRecord()) + '\n', 'utf8')
    const log = new AuditLog(dir)
    expect(log.query()).toHaveLength(1)
  })
})

describe('audit: lag indicator (M4 T4.1)', () => {
  /** Make `dir` itself a FILE so mkdirSync/appendFileSync fail. */
  function blockedDir(): string {
    const parent = mkdtempSync(join(tmpdir(), 'hpe-audit-'))
    const dir = join(parent, 'blocked')
    writeFileSync(dir, 'x', 'utf8')
    return dir
  }

  it('stays clean on successful writes and sticky after a write failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hpe-audit-'))
    const log = new AuditLog(dir)
    expect(log.lag).toBe(false)
    log.append(makeRecord())
    expect(log.lag).toBe(false)
    const bad = new AuditLog(blockedDir())
    bad.append(makeRecord({ operationId: 'op-2' }))
    expect(bad.lag).toBe(true)
  })

  it('query still returns an array when the trail is lagging (lag is the durable signal)', () => {
    const bad = new AuditLog(blockedDir())
    bad.append(makeRecord({ operationId: 'op-2' }))
    expect(bad.lag).toBe(true)
    expect(Array.isArray(bad.query())).toBe(true)
  })
})

describe('audit: service exposes lag via snapshot.auditLag and auditLag()', () => {
  it('snapshot.auditLag and auditLag() reflect a failed audit write', async () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'hpe-svclag-'))
    const profileDir = join(dshHome, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n', 'utf8')
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web', private: true, dependencies: {}, dsh: { profile: { bundles: [] } },
    }), 'utf8')
    // Block the audit log dir BEFORE the operation: make it a FILE so the
    // op's audit append fails (mkdirSync → EEXIST).
    const logDir = join(dshHome, 'logs', 'hotplug-engine')
    mkdirSync(join(dshHome, 'logs'), { recursive: true })
    writeFileSync(logDir, 'x', 'utf8')
    // row that exists in the loader
    const states = new Map<string, { disabled: boolean; phase: string | null }>([
      ['row-a', { disabled: false, phase: 'active' }],
    ])
    const loader = {
      entries: () => [{
        id: 'include',
        subtree: {
          entries: () => [...states.entries()].map(([id, s]) => ({
            options: { id, name: `pkg-${id}` },
            get disabled() { return states.get(id)!.disabled },
            get fiber() {
              const phase = states.get(id)!.phase
              return phase === null ? undefined : { state: phase === 'active' ? 2 : 1 }
            },
          })),
        },
      }],
    }
    const { Context } = await import('@deepseek-ai/cordis')
    const { HotplugEngineService } = await import('../src/host/service.ts')
    const ctx = new Context()
    ctx.provide('loader', loader)
    const svc = new HotplugEngineService(ctx, {
      dshHomePath: dshHome, hostProfile: 'web',
      observationWindowMs: 300, pollIntervalMs: 30, phasePollMs: 0,
    })
    expect(svc.snapshot().auditLag).toBe(false)
    expect(svc.auditLag()).toBe(false)
    // disable row-a: patch write succeeds (profile dir writable), audit
    // append fails (log dir is blocked) → lag becomes sticky.
    const p = svc.disable('row-a')
    await new Promise(r => setTimeout(r, 120))
    states.set('row-a', { disabled: true, phase: null })
    const result = await p
    expect(result.ok).toBe(true)
    expect(svc.auditLag()).toBe(true)
    expect(svc.snapshot().auditLag).toBe(true)
  })
})

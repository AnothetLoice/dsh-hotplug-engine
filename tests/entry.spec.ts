import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'
import { REST_PATHS } from '../src/host/rest.ts'

/** Isolate the engine from the real $DSH_HOME for every test. */
function isolateDshHome(): void {
  process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'hpe-entry-'))
}

afterEach(() => {
  delete process.env.DSH_HOME
})

function makeCtx(): Context {
  const ctx = new Context()
  ctx.provide('loader', { entries: () => [] })
  return ctx
}

describe('entry: apply() surface registration', () => {
  it('registers the 10 REST routes and 6 tools when webServer/tools exist (ctx.get probe)', () => {
    isolateDshHome()
    const ctx = makeCtx()
    const registered: string[] = []
    ctx.provide('webServer', {
      register: (route: { path: string }) => {
        registered.push(route.path)
        return () => {}
      },
    })
    ctx.provide('tools', {
      register: (tool: { name: string }) => {
        registered.push(tool.name)
        return () => {}
      },
    })
    apply(ctx)
    for (const path of Object.values(REST_PATHS)) expect(registered).toContain(path)
    expect(registered.filter(p => p.startsWith('hotplug_'))).toHaveLength(6)
  })

  it('stays headless-safe: no throw and no route/tool registration without webServer/tools', () => {
    isolateDshHome()
    const ctx = makeCtx()
    expect(() => apply(ctx)).not.toThrow()
  })

  it('passes config.pnpmPath into the service (v0.1.4 Config schema)', () => {
    isolateDshHome()
    const ctx = makeCtx()
    expect(() => apply(ctx, { pnpmPath: 'C:/fake/pnpm.cmd' })).not.toThrow()
    const svc = (ctx as unknown as { get: (name: string) => unknown }).get('hotplugEngine')
    expect(svc).toBeTruthy()
    expect(() => (svc as { snapshot: () => unknown }).snapshot()).not.toThrow()
  })
})

describe('entry: cordis service probing semantics (A3.6 root cause regression)', () => {
  it('ctx.get is the correct optional probe (returns undefined for absent services)', () => {
    const ctx = makeCtx()
    // The A3.6 boot failure showed fiber-level property access throws
    // "cannot get property X without inject"; ctx.get is the documented
    // optional probe that returns undefined instead.
    expect((ctx as unknown as { get: (name: string) => unknown }).get('webServer')).toBeUndefined()
    expect((ctx as unknown as { get: (name: string) => unknown }).get('tools')).toBeUndefined()
  })
})
